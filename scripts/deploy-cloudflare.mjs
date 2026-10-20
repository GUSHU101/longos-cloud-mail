import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerRoot = join(repositoryRoot, 'mail-worker');
const cliArgs = process.argv.slice(2);
const validateOnly = cliArgs.includes('--validate-only');
const fromEnvironment = cliArgs.includes('--from-env');
const configArgument = cliArgs.find(argument => !argument.startsWith('--')) || '.cloud-mail.deploy.env';
const configPath = resolve(repositoryRoot, configArgument);
const generatedConfig = join(workerRoot, 'wrangler.generated.toml');
const directPnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const corepackCommand = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
const hasDirectPnpm = spawnSync(directPnpmCommand, ['--version'], { windowsHide: true }).status === 0;
const pnpmCommand = hasDirectPnpm ? directPnpmCommand : corepackCommand;
const pnpmPrefix = hasDirectPnpm ? [] : ['pnpm'];

function fail(message) {
  console.error(`\n[失败] ${message}`);
  process.exit(1);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
  fail(`需要 Node.js 22 或更高版本，当前为 ${process.versions.node}。`);
}

function parseEnvFile(path) {
  if (!existsSync(path)) {
    fail(`找不到 ${path}。请先复制 .cloud-mail.deploy.env.example。`);
  }
  const values = {};
  const source = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) fail(`配置文件第 ${index + 1} 行不是 KEY=VALUE 格式。`);
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repositoryRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    input: options.input,
    stdio: options.capture ? ['pipe', 'pipe', 'pipe'] : options.input !== undefined
      ? ['pipe', 'inherit', 'inherit']
      : 'inherit',
    windowsHide: true,
  });
  if (result.error) fail(`${command} 无法启动：${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) {
    if (options.capture) {
      if (result.stdout) console.error(result.stdout.trim());
      if (result.stderr) console.error(result.stderr.trim());
    }
    fail(`${command} ${args.join(' ')} 执行失败（退出码 ${result.status}）。`);
  }
  return result;
}

function pnpm(args, options = {}) {
  return run(pnpmCommand, [...pnpmPrefix, ...args], options);
}

function wrangler(args, options = {}) {
  return pnpm(['exec', 'wrangler', ...args], { cwd: workerRoot, ...options });
}

function jsonOutput(output, label) {
  const text = String(output || '').trim();
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first < 0 || last < first) fail(`${label} 没有返回可解析的 JSON。`);
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch (error) {
    fail(`${label} 返回了无效 JSON：${error.message}`);
  }
}

function normalizeDomain(value, field) {
  const domain = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain)
    || !domain.includes('.')
    || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    fail(`${field} 不是有效域名：${value}`);
  }
  return domain;
}

function parseJsonArray(value, field, required = false) {
  let result;
  try { result = JSON.parse(value || '[]'); } catch { fail(`${field} 必须是 JSON 数组，例如 ["example.com"]。`); }
  if (!Array.isArray(result) || result.some(item => typeof item !== 'string') || (required && result.length === 0)) {
    fail(`${field} 必须是${required ? '非空' : ''}字符串 JSON 数组。`);
  }
  return result;
}

function removeTomlBlock(source, header) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.trim() === header);
  if (start < 0) return source;
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '') end += 1;
  if (end < lines.length) end += 1;
  lines.splice(start, end - start);
  return lines.join('\n');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  return { response, text, body };
}

async function workerSecretNames(config, deploymentEnv) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(config.NAME)}/secrets`;
  const { response, body, text } = await fetchJson(endpoint, {
    headers: { authorization: `Bearer ${deploymentEnv.CLOUDFLARE_API_TOKEN}` },
  });
  if (response.status === 404) return new Set();
  if (!response.ok || body.success !== true || !Array.isArray(body.result)) {
    fail(`无法读取 Worker Secret 列表（HTTP ${response.status}）：${body.errors?.[0]?.message || text}`);
  }
  return new Set(body.result.map(item => item?.name).filter(Boolean));
}

async function resolveCloudflareAccountId(config) {
  if (config.CLOUDFLARE_ACCOUNT_ID) return config.CLOUDFLARE_ACCOUNT_ID;

  const { response, body, text } = await fetchJson('https://api.cloudflare.com/client/v4/accounts?per_page=50', {
    headers: { authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}` },
  });
  if (!response.ok || body.success !== true || !Array.isArray(body.result)) {
    fail(`无法自动识别 Cloudflare Account ID（HTTP ${response.status}）：${body.errors?.[0]?.message || text}。可在部署变量中显式填写 CLOUDFLARE_ACCOUNT_ID。`);
  }
  if (body.result.length !== 1) {
    const accounts = body.result.map(item => `${item.name || '未命名账户'} (${item.id})`).join('、');
    fail(`API Token 可访问 ${body.result.length} 个 Cloudflare 账户，无法安全自动选择。请填写 CLOUDFLARE_ACCOUNT_ID${accounts ? `：${accounts}` : '。'}`);
  }
  return body.result[0].id;
}

const deploymentKeys = [
  'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'NAME', 'D1_DATABASE_NAME',
  'D1_DATABASE_ID', 'KV_NAMESPACE_ID', 'R2_BUCKET_NAME', 'CUSTOM_DOMAIN', 'DOMAIN',
  'ADMIN', 'CORS_ORIGINS', 'JWT_SECRET', 'LONGOS_RELAY_URL', 'LONGOS_INTEGRATION_TOKEN',
  'RELAY_SHARED_SECRET', 'CLOUDFLARE_EMAIL', 'ANALYSIS_CACHE', 'AI_MODEL', 'PROJECT_LINK',
  'RESEND_WEBHOOK_SECRET',
];
const config = fromEnvironment
  ? Object.fromEntries(deploymentKeys.map(key => [key, process.env[key] || '']))
  : parseEnvFile(configPath);
config.NAME ||= 'cloud-mail';
config.D1_DATABASE_NAME ||= config.NAME;
const required = ['CLOUDFLARE_API_TOKEN', 'DOMAIN', 'ADMIN'];
for (const key of required) if (!config[key]) fail(`${key} 不能为空。`);
if (config.CLOUDFLARE_ACCOUNT_ID && !/^[a-f0-9]{32}$/i.test(config.CLOUDFLARE_ACCOUNT_ID)) fail('CLOUDFLARE_ACCOUNT_ID 必须是 32 位十六进制 ID。');
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(config.NAME)) fail('NAME 只能使用小写字母、数字、下划线和连字符。');
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(config.D1_DATABASE_NAME)) fail('D1_DATABASE_NAME 格式不正确。');
if (config.JWT_SECRET && !/^[A-Za-z0-9_-]{32,}$/.test(config.JWT_SECRET)) fail('JWT_SECRET 必须至少包含 32 个 URL-safe 字符。留空时首次部署会自动生成，升级会保留线上密钥。');

const rawDomains = String(config.DOMAIN || '').trim();
const parsedDomains = rawDomains.startsWith('[')
  ? parseJsonArray(rawDomains, 'DOMAIN', true)
  : rawDomains.split(/[\s,;]+/).filter(Boolean);
const domains = [...new Set(parsedDomains.map(domain => normalizeDomain(domain, 'DOMAIN')))];
const corsOrigins = parseJsonArray(config.CORS_ORIGINS || '[]', 'CORS_ORIGINS').map(origin => {
  let url;
  try { url = new URL(origin); } catch { fail(`CORS_ORIGINS 含无效 URL：${origin}`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail(`CORS_ORIGINS 只允许不含凭据、路径、查询或片段的 HTTPS Origin：${origin}`);
  }
  return url.origin;
});
if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)+$/.test(config.ADMIN)
  || !domains.includes(config.ADMIN.split('@').at(-1).toLowerCase())) {
  fail('ADMIN 必须是有效邮箱，并使用 DOMAIN 中的域名。');
}
if (config.CUSTOM_DOMAIN) config.CUSTOM_DOMAIN = normalizeDomain(config.CUSTOM_DOMAIN, 'CUSTOM_DOMAIN');
if (config.R2_BUCKET_NAME && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.R2_BUCKET_NAME)) fail('R2_BUCKET_NAME 格式不正确。');
if (config.PROJECT_LINK && !/^https:\/\/[A-Za-z0-9./?_=:%#-]+$/.test(config.PROJECT_LINK)) fail('PROJECT_LINK 必须是安全的 HTTPS URL。');
if (config.AI_MODEL && !/^[@A-Za-z0-9._/-]+$/.test(config.AI_MODEL)) fail('AI_MODEL 含有不允许的字符。');
for (const field of ['CLOUDFLARE_EMAIL', 'ANALYSIS_CACHE']) {
  if (config[field] && !/^(true|false)$/i.test(config[field])) fail(`${field} 只能填写 true 或 false。`);
}
if (config.RESEND_WEBHOOK_SECRET && !/^whsec_[A-Za-z0-9_+/=-]{16,}$/.test(config.RESEND_WEBHOOK_SECRET)) {
  fail('RESEND_WEBHOOK_SECRET 必须是 Resend 签发的 whsec_... 签名密钥。');
}
if (config.LONGOS_RELAY_URL || config.LONGOS_INTEGRATION_TOKEN) {
  if (!config.LONGOS_RELAY_URL || !config.LONGOS_INTEGRATION_TOKEN) fail('LONGOS_RELAY_URL 与 LONGOS_INTEGRATION_TOKEN 必须同时填写。');
  let relay;
  try { relay = new URL(config.LONGOS_RELAY_URL); } catch { fail('LONGOS_RELAY_URL 不是有效 URL。'); }
  if (relay.protocol !== 'https:' || relay.username || relay.password
    || relay.pathname.replace(/\/$/, '') !== '/_longos/mail-relay' || relay.search || relay.hash) {
    fail('LONGOS_RELAY_URL 必须是主站 HTTPS /_longos/mail-relay 地址。');
  }
  if (!/^longos_it_[A-Za-z0-9]{64}$/.test(config.LONGOS_INTEGRATION_TOKEN)) fail('LONGOS_INTEGRATION_TOKEN 格式不正确。');
}
if (!config.LONGOS_INTEGRATION_TOKEN && config.RELAY_SHARED_SECRET && config.RELAY_SHARED_SECRET.length < 32) fail('RELAY_SHARED_SECRET 至少需要 32 个字符。');

if (validateOnly) {
  const sourceLabel = fromEnvironment ? '当前环境变量' : `配置文件 ${configPath}`;
  console.log(`[通过] ${sourceLabel}中的格式、域名、密钥和 LONGOS 网关参数校验通过。`);
  process.exit(0);
}

config.CLOUDFLARE_ACCOUNT_ID = await resolveCloudflareAccountId(config);
if (!/^[a-f0-9]{32}$/i.test(config.CLOUDFLARE_ACCOUNT_ID)) fail('自动识别到的 CLOUDFLARE_ACCOUNT_ID 格式不正确。');
console.log(`[配置] Cloudflare Account ID：${config.CLOUDFLARE_ACCOUNT_ID}`);

const deploymentEnv = {
  ...process.env,
  CI: 'true',
  CLOUDFLARE_ACCOUNT_ID: config.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: config.CLOUDFLARE_API_TOKEN,
};

console.log('\n[1/8] 安装锁定依赖并执行 Worker 发布前测试');
pnpm(['--dir', 'mail-worker', 'install', '--frozen-lockfile'], { env: deploymentEnv });
pnpm(['--dir', 'mail-vue', 'install', '--frozen-lockfile'], { env: deploymentEnv });
pnpm(['--dir', 'mail-worker', 'audit', '--prod', '--audit-level', 'moderate'], { env: deploymentEnv });
pnpm(['--dir', 'mail-vue', 'audit', '--prod', '--audit-level', 'moderate'], { env: deploymentEnv });
pnpm(['--dir', 'mail-worker', 'run', 'test:unit'], { env: deploymentEnv });
pnpm(['--dir', 'mail-vue', 'run', 'build'], { env: deploymentEnv });

console.log('\n[2/8] 创建或复用 Cloudflare D1');
let d1Id = config.D1_DATABASE_ID;
let d1Rows = jsonOutput(wrangler(['d1', 'list', '--json'], { env: deploymentEnv, capture: true }).stdout, 'D1 列表');
if (d1Id) {
  const pinnedDatabase = d1Rows.find(item => item.uuid === d1Id);
  if (!pinnedDatabase) fail('D1_DATABASE_ID 不属于当前 Cloudflare 账户。');
  if (pinnedDatabase.name !== config.D1_DATABASE_NAME) fail('D1_DATABASE_ID 与 D1_DATABASE_NAME 指向的数据库不一致。');
} else {
  const matchingDatabases = d1Rows.filter(item => item.name === config.D1_DATABASE_NAME);
  if (matchingDatabases.length > 1) fail('发现多个同名 D1；请显式填写 D1_DATABASE_ID。');
  let row = matchingDatabases[0];
  if (!row) {
    wrangler(['d1', 'create', config.D1_DATABASE_NAME], { env: deploymentEnv });
    d1Rows = jsonOutput(wrangler(['d1', 'list', '--json'], { env: deploymentEnv, capture: true }).stdout, 'D1 列表');
    row = d1Rows.find(item => item.name === config.D1_DATABASE_NAME);
  }
  d1Id = row?.uuid;
}
if (!/^[a-f0-9-]{32,36}$/i.test(d1Id || '')) fail('无法确定 D1_DATABASE_ID。');

console.log('\n[3/8] 创建或复用 Cloudflare KV');
let kvId = config.KV_NAMESPACE_ID;
let kvRows = jsonOutput(wrangler(['kv', 'namespace', 'list'], { env: deploymentEnv, capture: true }).stdout, 'KV 列表');
if (kvId) {
  if (!kvRows.some(item => item.id === kvId)) fail('KV_NAMESPACE_ID 不属于当前 Cloudflare 账户。');
} else {
  const matchingNamespaces = kvRows.filter(item => item.title === config.NAME);
  if (matchingNamespaces.length > 1) fail('发现多个同名 KV Namespace；请显式填写 KV_NAMESPACE_ID。');
  let row = matchingNamespaces[0];
  if (!row) {
    wrangler(['kv', 'namespace', 'create', config.NAME], { env: deploymentEnv });
    kvRows = jsonOutput(wrangler(['kv', 'namespace', 'list'], { env: deploymentEnv, capture: true }).stdout, 'KV 列表');
    row = kvRows.find(item => item.title === config.NAME);
  }
  kvId = row?.id;
}
if (!/^[a-f0-9]{32}$/i.test(kvId || '')) fail('无法确定 KV_NAMESPACE_ID。');

console.log('\n[4/8] 创建或复用 Cloudflare R2');
if (config.R2_BUCKET_NAME) {
  const info = wrangler(['r2', 'bucket', 'info', config.R2_BUCKET_NAME], { env: deploymentEnv, capture: true, allowFailure: true });
  if (info.status !== 0) wrangler(['r2', 'bucket', 'create', config.R2_BUCKET_NAME], { env: deploymentEnv });
} else {
  console.log('未配置 R2_BUCKET_NAME，附件对象存储绑定将被关闭。');
}

console.log('\n[5/8] 验证 LONGOS 主站邮件网关');
if (config.LONGOS_RELAY_URL) {
  const health = await fetchJson(`${config.LONGOS_RELAY_URL.replace(/\/$/, '')}/health`, {
    headers: { accept: 'application/json', authorization: `Bearer ${config.LONGOS_INTEGRATION_TOKEN}` },
  });
  if (!health.response.ok || health.body.status !== 'ok') fail(`LONGOS 邮件网关不可用（HTTP ${health.response.status}）：${health.body.message || health.text}`);
  console.log(`LONGOS 邮件网关正常，Postfix 队列：${health.body.queueDepth ?? '未报告'}。`);
} else {
  console.log('未配置 LONGOS 邮件网关；Cloud Mail 默认仅收信。只有管理员明确配置兼容引擎后才会站外发信。');
}

console.log('\n[6/8] 生成生产配置，原子写入 Secret 并部署 Worker');
let wranglerConfig = readFileSync(join(workerRoot, 'wrangler-action.toml'), 'utf8');
if (!config.CUSTOM_DOMAIN) wranglerConfig = removeTomlBlock(wranglerConfig, '[[routes]]');
if (!config.R2_BUCKET_NAME) wranglerConfig = removeTomlBlock(wranglerConfig, '[[r2_buckets]]');
if (!config.PROJECT_LINK) wranglerConfig = wranglerConfig.replace(/^project_link = .*\r?\n/m, '');
const replacements = {
  NAME: config.NAME,
  CUSTOM_DOMAIN: config.CUSTOM_DOMAIN || '',
  D1_DATABASE_NAME: config.D1_DATABASE_NAME,
  D1_DATABASE_ID: d1Id,
  KV_NAMESPACE_ID: kvId,
  R2_BUCKET_NAME: config.R2_BUCKET_NAME || '',
  DOMAIN: JSON.stringify(domains),
  ADMIN: config.ADMIN,
  PROJECT_LINK: config.PROJECT_LINK || '',
  AI_MODEL: config.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast',
  ANALYSIS_CACHE: /^(true|1)$/i.test(config.ANALYSIS_CACHE || '') ? 'true' : 'false',
  LONGOS_RELAY_URL: config.LONGOS_RELAY_URL || '',
  CORS_ORIGINS: JSON.stringify(corsOrigins),
};
for (const [key, value] of Object.entries(replacements)) {
  wranglerConfig = wranglerConfig.replaceAll(`\${${key}}`, value);
}
if (/^(true|1)$/i.test(config.CLOUDFLARE_EMAIL || '') && !config.LONGOS_INTEGRATION_TOKEN) {
  wranglerConfig += '\n[[send_email]]\nname = "email"\n';
} else if (/^(true|1)$/i.test(config.CLOUDFLARE_EMAIL || '') && config.LONGOS_INTEGRATION_TOKEN) {
  console.log('已启用 LONGOS 一体化自建发信：忽略并移除第三方 Cloudflare Email 出站绑定。');
}
if (/\$\{[A-Z0-9_]+\}/.test(wranglerConfig)) fail('生成的 Wrangler 配置仍有未替换变量。');
writeFileSync(generatedConfig, wranglerConfig, { encoding: 'utf8', mode: 0o600 });
const initSecret = randomBytes(32).toString('hex');
const existingSecretNames = await workerSecretNames(config, deploymentEnv);
const deploymentSecrets = { INIT_SECRET: initSecret };
if (config.JWT_SECRET) {
  deploymentSecrets.jwt_secret = config.JWT_SECRET;
} else if (!existingSecretNames.has('jwt_secret')) {
  deploymentSecrets.jwt_secret = randomBytes(48).toString('base64url');
  console.log('首次部署：已自动生成 Worker JWT 签名密钥。');
} else {
  console.log('升级部署：保留线上已有 Worker JWT 签名密钥。');
}
if (config.LONGOS_INTEGRATION_TOKEN) deploymentSecrets.LONGOS_INTEGRATION_TOKEN = config.LONGOS_INTEGRATION_TOKEN;
if (!config.LONGOS_INTEGRATION_TOKEN && config.RELAY_SHARED_SECRET) deploymentSecrets.RELAY_SHARED_SECRET = config.RELAY_SHARED_SECRET;
if (!config.LONGOS_INTEGRATION_TOKEN && config.RESEND_WEBHOOK_SECRET) deploymentSecrets.RESEND_WEBHOOK_SECRET = config.RESEND_WEBHOOK_SECRET;

const secretTempDirectory = mkdtempSync(join(tmpdir(), 'longos-cloud-mail-'));
const secretFile = join(secretTempDirectory, 'worker-secrets.json');
writeFileSync(secretFile, JSON.stringify(deploymentSecrets), { encoding: 'utf8', mode: 0o600 });
let deployment;
try {
  deployment = wrangler(['deploy', '-c', generatedConfig, '--secrets-file', secretFile], {
    env: deploymentEnv,
    capture: true,
    allowFailure: true,
  });
} finally {
  rmSync(secretTempDirectory, { recursive: true, force: true });
}
if (deployment.status !== 0) {
  if (deployment.stdout) console.error(deployment.stdout.trim());
  if (deployment.stderr) console.error(deployment.stderr.trim());
  fail(`Worker 部署失败（退出码 ${deployment.status}）。`);
}
process.stdout.write(deployment.stdout);
const workersDevUrl = deployment.stdout.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0] || '';
const workerUrl = config.CUSTOM_DOMAIN ? `https://${config.CUSTOM_DOMAIN}` : workersDevUrl;
if (!workerUrl) fail('无法从 Wrangler 输出确定 Worker URL；请配置 CUSTOM_DOMAIN。');

console.log('\n[7/8] 撤销配置中已停用的旧 Worker Secret');
const configuredOptionalSecrets = {
  LONGOS_INTEGRATION_TOKEN: config.LONGOS_INTEGRATION_TOKEN,
  RELAY_SHARED_SECRET: config.LONGOS_INTEGRATION_TOKEN ? '' : config.RELAY_SHARED_SECRET,
  RESEND_WEBHOOK_SECRET: config.LONGOS_INTEGRATION_TOKEN ? '' : config.RESEND_WEBHOOK_SECRET,
};
for (const [name, value] of Object.entries(configuredOptionalSecrets)) {
  if (value || !existingSecretNames.has(name)) continue;
  wrangler(['secret', 'delete', name, '-c', generatedConfig], { env: deploymentEnv, input: 'y\n' });
}

console.log('\n[8/8] 初始化/升级数据库并验收');
let initialized = false;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const result = await fetchJson(`${workerUrl}/api/init`, {
      method: 'POST',
      headers: { authorization: `Bearer ${initSecret}`, 'content-type': 'application/json' },
      body: '{}',
    });
    if (result.response.ok && result.text === 'success') {
      initialized = true;
      break;
    }
    console.log(`初始化等待 ${attempt}/12：HTTP ${result.response.status}`);
  } catch (error) {
    console.log(`初始化等待 ${attempt}/12：${error.message}`);
  }
  await new Promise(resolveDelay => setTimeout(resolveDelay, 10_000));
}
if (!initialized) fail('Worker 已发布，但自定义域或数据库初始化在两分钟内未就绪。可直接重跑同一命令。');
let publicCheck = await fetch(`${workerUrl}/api/setting/websiteConfig`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
if (!publicCheck.ok) fail(`Worker 初始化完成，但公开配置验收失败（HTTP ${publicCheck.status}）。`);

// INIT_SECRET is single-use deployment authority. Remove it after the schema
// has passed final verification so a leaked historical value is useless.
wrangler(['secret', 'delete', 'INIT_SECRET', '-c', generatedConfig], { env: deploymentEnv, input: 'y\n' });
const retiredInitCheck = await fetch(`${workerUrl}/api/init`, {
  method: 'POST',
  headers: { authorization: `Bearer ${initSecret}`, 'content-type': 'application/json' },
  body: '{}',
  redirect: 'manual',
  signal: AbortSignal.timeout(20_000),
});
if (retiredInitCheck.status !== 401) fail(`INIT_SECRET 撤销验收失败（HTTP ${retiredInitCheck.status}）。`);
publicCheck = await fetch(`${workerUrl}/api/setting/websiteConfig`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
if (!publicCheck.ok) fail(`撤销一次性密钥后公开配置验收失败（HTTP ${publicCheck.status}）。`);

console.log(`\n[完成] Cloud Mail 已部署：${workerUrl}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `worker_url=${workerUrl}\n`, 'utf8');
console.log('下一步只需在 Cloudflare Email Routing 中，把每个收件域的 Catch-all 指向这个 Worker。');
console.log('然后登录 Cloud Mail 创建发件账户，并在 LONGOS 后台分别发送“测试邮件、下单邮件、弃单召回邮件”完成业务验收。');
