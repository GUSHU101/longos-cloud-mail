import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyCloudflareApiToken } from './cloudflare-auth.mjs';
import { preflightCloudflareZones } from './cloudflare-preflight.mjs';
import { configureEmailRouting } from './email-routing.mjs';
import { syncLongosOutboundDns } from './longos-dns-sync.mjs';
import { resolvePnpmCommand } from './pnpm-command.mjs';
import {
  resolveManagedR2BucketName,
  selectCloudflareResource,
  waitForCloudflareResource,
} from './cloudflare-resource-state.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerRoot = join(repositoryRoot, 'mail-worker');
const cliArgs = process.argv.slice(2);
const validateOnly = cliArgs.includes('--validate-only');
const fromEnvironment = cliArgs.includes('--from-env');
const skipVerification = cliArgs.includes('--skip-verification');
const configArgument = cliArgs.find(argument => !argument.startsWith('--')) || '.cloud-mail.deploy.env';
const configPath = resolve(repositoryRoot, configArgument);
const generatedConfig = join(workerRoot, 'wrangler.generated.toml');
let pnpmCommand;
let pnpmPrefix;
let pnpmEntrypoint = '';
let pnpmCleanup = () => {};
try {
  ({
    command: pnpmCommand,
    prefix: pnpmPrefix,
    entrypoint: pnpmEntrypoint = '',
    cleanup: pnpmCleanup = () => {},
  } = resolvePnpmCommand());
} catch (error) {
  console.error(`[失败] ${error.message}`);
  process.exit(1);
}
let failureCleanup = null;

function runFailureCleanup() {
	if (!failureCleanup) return;
	const cleanup = failureCleanup;
	failureCleanup = null;
	try {
		cleanup();
	} catch (error) {
		console.error(`[清理失败] ${error.message}`);
	}
}

function fail(message) {
	runFailureCleanup();
  console.error(`\n[失败] ${message}`);
  process.exit(1);
}

function handleTermination(signal, exitCode) {
	console.error(`\n[中断] 收到 ${signal}，正在撤销临时部署凭据。`);
	runFailureCleanup();
	process.exit(exitCode);
}

process.once('SIGINT', () => handleTermination('SIGINT', 130));
process.once('SIGTERM', () => handleTermination('SIGTERM', 143));
process.once('exit', exitCode => {
	if (exitCode !== 0) runFailureCleanup();
	pnpmCleanup();
});

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

function validPublicHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  return isIP(hostname) === 0
    && !['localhost', 'localhost.localdomain'].includes(hostname)
    && !hostname.endsWith('.localhost')
    && !hostname.endsWith('.local')
    && !hostname.endsWith('.internal')
    && !hostname.endsWith('.home.arpa')
    && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(hostname)
    && hostname.includes('.')
    && hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
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

async function workerSecretInventory(config, deploymentEnv) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(config.NAME)}/secrets`;
  const { response, body, text } = await fetchJson(endpoint, {
    headers: { authorization: `Bearer ${deploymentEnv.CLOUDFLARE_API_TOKEN}` },
  });
  if (response.status === 404) return {exists: false, names: new Set()};
  if (!response.ok || body.success !== true || !Array.isArray(body.result)) {
    fail(`无法读取 Worker Secret 列表（HTTP ${response.status}）：${body.errors?.[0]?.message || text}`);
  }
  return {exists: true, names: new Set(body.result.map(item => item?.name).filter(Boolean))};
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
  'ADMIN', 'ADMIN_PASSWORD', 'CORS_ORIGINS', 'JWT_SECRET', 'LONGOS_RELAY_URL', 'LONGOS_INTEGRATION_TOKEN',
  'RELAY_SHARED_SECRET', 'CLOUDFLARE_EMAIL', 'ANALYSIS_CACHE', 'AI_MODEL', 'PROJECT_LINK',
  'RESEND_WEBHOOK_SECRET',
  'AUTO_CONFIGURE_EMAIL_ROUTING',
];
const config = fromEnvironment
  ? Object.fromEntries(deploymentKeys.map(key => [key, process.env[key] || '']))
  : parseEnvFile(configPath);
config.NAME ||= 'cloud-mail';
config.D1_DATABASE_NAME ||= config.NAME;
config.AUTO_CONFIGURE_EMAIL_ROUTING ||= 'true';
config.R2_BUCKET_NAME = resolveManagedR2BucketName(config.R2_BUCKET_NAME, config.NAME);
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
config.ADMIN = config.ADMIN.toLowerCase();
if (config.ADMIN_PASSWORD && (config.ADMIN_PASSWORD.length < 12 || config.ADMIN_PASSWORD.length > 30)) {
  fail('ADMIN_PASSWORD 必须为 12–30 个字符；它只用于首次创建管理员，不会覆盖已有密码。');
}
if (config.ADMIN_PASSWORD && /\p{Cc}/u.test(config.ADMIN_PASSWORD)) {
  fail('ADMIN_PASSWORD 不能包含控制字符。');
}
if (config.CUSTOM_DOMAIN) config.CUSTOM_DOMAIN = normalizeDomain(config.CUSTOM_DOMAIN, 'CUSTOM_DOMAIN');
if (config.R2_BUCKET_NAME && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.R2_BUCKET_NAME)) {
  fail('R2_BUCKET_NAME 只能包含小写字母、数字和连字符，长度为 3–63，且不能以连字符开头或结尾。');
}
if (config.PROJECT_LINK && !/^https:\/\/[A-Za-z0-9./?_=:%#-]+$/.test(config.PROJECT_LINK)) fail('PROJECT_LINK 必须是安全的 HTTPS URL。');
if (config.AI_MODEL && !/^[@A-Za-z0-9._/-]+$/.test(config.AI_MODEL)) fail('AI_MODEL 含有不允许的字符。');
for (const field of ['CLOUDFLARE_EMAIL', 'ANALYSIS_CACHE', 'AUTO_CONFIGURE_EMAIL_ROUTING']) {
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
    || relay.port || !validPublicHostname(relay.hostname)
    || relay.pathname.replace(/\/$/, '') !== '/_longos/mail-relay' || relay.search || relay.hash) {
    fail('LONGOS_RELAY_URL 必须是使用公共域名和标准 HTTPS 端口的主站 /_longos/mail-relay 地址。');
  }
  if (!/^longos_it_[A-Za-z0-9]{64}$/.test(config.LONGOS_INTEGRATION_TOKEN)) fail('LONGOS_INTEGRATION_TOKEN 格式不正确。');
}
if (!config.LONGOS_INTEGRATION_TOKEN && config.RELAY_SHARED_SECRET && config.RELAY_SHARED_SECRET.length < 32) fail('RELAY_SHARED_SECRET 至少需要 32 个字符。');

const trustedGitHubDeployment = process.env.CI === 'true'
  && process.env.GITHUB_ACTIONS === 'true'
  && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  && /\/\.github\/workflows\/deploy-cloudflare\.yml@/.test(process.env.GITHUB_WORKFLOW_REF || '');
if (skipVerification && !trustedGitHubDeployment) {
  fail('--skip-verification 只允许 GitHub Actions 在独立无密钥验证步骤通过后使用。');
}

if (validateOnly) {
  const sourceLabel = fromEnvironment ? '当前环境变量' : `配置文件 ${configPath}`;
  console.log(`[通过] ${sourceLabel}中的格式、域名、密钥和 LONGOS 网关参数校验通过。`);
  process.exit(0);
}

let verifiedCloudflareToken;
try {
  verifiedCloudflareToken = await verifyCloudflareApiToken({token: config.CLOUDFLARE_API_TOKEN});
} catch (error) {
  fail(error.message);
}
console.log(`[配置] Cloudflare API Token：${verifiedCloudflareToken.status}（已确认不是 Global API Key）`);

config.CLOUDFLARE_ACCOUNT_ID = await resolveCloudflareAccountId(config);
if (!/^[a-f0-9]{32}$/i.test(config.CLOUDFLARE_ACCOUNT_ID)) fail('自动识别到的 CLOUDFLARE_ACCOUNT_ID 格式不正确。');
console.log(`[配置] Cloudflare Account ID：${config.CLOUDFLARE_ACCOUNT_ID}`);

console.log('\n[预检] 验证 Cloudflare Zone、自定义域和 Email Routing 访问范围');
let zonePreflight;
try {
  zonePreflight = await preflightCloudflareZones({
    token: config.CLOUDFLARE_API_TOKEN,
    accountId: config.CLOUDFLARE_ACCOUNT_ID,
    customDomain: config.CUSTOM_DOMAIN,
    mailDomains: domains,
    autoConfigureEmailRouting: config.AUTO_CONFIGURE_EMAIL_ROUTING.toLowerCase() === 'true',
  });
} catch (error) {
  fail(`Cloudflare 预检失败：${error.message}`);
}
if (zonePreflight.customZone) console.log(`✓ 自定义域 ${config.CUSTOM_DOMAIN} 位于活动 Zone ${zonePreflight.customZone.name}`);
for (const item of zonePreflight.routing) {
  console.log(`✓ 收件 Zone ${item.domain} 可访问${item.enabled ? '，Email Routing 已启用' : '；尚未启用 Email Routing，将在部署后自动启用'}`);
}

console.log('\n[预检] 验证 LONGOS 主站邮件网关');
if (config.LONGOS_RELAY_URL) {
  const health = await fetchJson(`${config.LONGOS_RELAY_URL.replace(/\/$/, '')}/health`, {
    headers: { accept: 'application/json', authorization: `Bearer ${config.LONGOS_INTEGRATION_TOKEN}` },
  });
  if (!health.response.ok || health.body.status !== 'ok') fail(`LONGOS 邮件网关不可用（HTTP ${health.response.status}）：${health.body.message || health.text}`);
  console.log(`✓ LONGOS 邮件网关正常，Postfix 队列：${health.body.queueDepth ?? '未报告'}。`);
} else {
  console.log('未配置 LONGOS 邮件网关；Cloud Mail 默认仅收信。只有管理员明确配置兼容引擎后才会站外发信。');
}

const verificationEnv = {...process.env, CI: 'true'};
for (const secretName of [
  'CLOUDFLARE_API_TOKEN',
  'ADMIN_PASSWORD',
  'JWT_SECRET',
  'LONGOS_INTEGRATION_TOKEN',
  'RELAY_SHARED_SECRET',
  'RESEND_WEBHOOK_SECRET',
]) {
  delete verificationEnv[secretName];
}
if (pnpmEntrypoint) verificationEnv.LONGOS_PNPM_ENTRYPOINT = pnpmEntrypoint;
const deploymentEnv = {
  ...verificationEnv,
  CLOUDFLARE_ACCOUNT_ID: config.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: config.CLOUDFLARE_API_TOKEN,
};

console.log('\n[1/8] 验证锁定依赖、测试与生产构建');
if (skipVerification) {
  console.log('GitHub Actions 独立无密钥验证步骤已通过，继续执行生产发布。');
} else {
  run(process.execPath, ['scripts/verify-deployment.mjs'], {env: verificationEnv});
}

console.log('\n[2/8] 创建或复用 Cloudflare D1');
const listD1 = () => jsonOutput(wrangler(['d1', 'list', '--json'], {
  env: deploymentEnv, capture: true,
}).stdout, 'D1 列表');
const d1Selection = {
  pinnedId: config.D1_DATABASE_ID,
  expectedName: config.D1_DATABASE_NAME,
  idField: 'uuid',
  nameField: 'name',
  label: 'D1',
};
let d1Row;
try {
  d1Row = selectCloudflareResource(listD1(), d1Selection);
} catch (error) {
  fail(error.message);
}
let d1State = 'reused';
if (!d1Row) {
  wrangler(['d1', 'create', config.D1_DATABASE_NAME], { env: deploymentEnv });
  d1State = 'created';
  try {
    d1Row = await waitForCloudflareResource({list: listD1, selection: d1Selection});
  } catch (error) {
    fail(error.message);
  }
}
const d1Id = d1Row?.uuid;
if (!/^[a-f0-9-]{32,36}$/i.test(d1Id || '')) fail('无法确定 D1_DATABASE_ID。');
console.log(`✓ D1 ${d1State === 'created' ? '已创建' : '已复用'}：${config.D1_DATABASE_NAME} (${d1Id})`);

console.log('\n[3/8] 创建或复用 Cloudflare KV');
const listKv = () => jsonOutput(wrangler(['kv', 'namespace', 'list'], {
  env: deploymentEnv, capture: true,
}).stdout, 'KV 列表');
const kvSelection = {
  pinnedId: config.KV_NAMESPACE_ID,
  expectedName: config.NAME,
  idField: 'id',
  nameField: 'title',
  label: 'KV',
};
let kvRow;
try {
  kvRow = selectCloudflareResource(listKv(), kvSelection);
} catch (error) {
  fail(error.message);
}
let kvState = 'reused';
if (!kvRow) {
  wrangler(['kv', 'namespace', 'create', config.NAME], { env: deploymentEnv });
  kvState = 'created';
  try {
    kvRow = await waitForCloudflareResource({list: listKv, selection: kvSelection});
  } catch (error) {
    fail(error.message);
  }
}
const kvId = kvRow?.id;
if (!/^[a-f0-9]{32}$/i.test(kvId || '')) fail('无法确定 KV_NAMESPACE_ID。');
console.log(`✓ KV ${kvState === 'created' ? '已创建' : '已复用'}：${config.NAME} (${kvId})`);

console.log('\n[4/8] 创建或复用 Cloudflare R2');
let r2State = 'disabled';
if (config.R2_BUCKET_NAME) {
  const info = wrangler(['r2', 'bucket', 'info', config.R2_BUCKET_NAME], { env: deploymentEnv, capture: true, allowFailure: true });
  if (info.status !== 0) {
    wrangler(['r2', 'bucket', 'create', config.R2_BUCKET_NAME], { env: deploymentEnv });
    r2State = 'created';
    let visible = false;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const check = wrangler(['r2', 'bucket', 'info', config.R2_BUCKET_NAME], {
        env: deploymentEnv, capture: true, allowFailure: true,
      });
      if (check.status === 0) {
        visible = true;
        break;
      }
      if (attempt < 8) await new Promise(resolveDelay => setTimeout(resolveDelay, 2_500));
    }
    if (!visible) fail(`R2 ${config.R2_BUCKET_NAME} 创建后未能通过读取验收；请确认 R2 已开通后重跑。`);
  } else {
    r2State = 'reused';
  }
  console.log(`✓ R2 ${r2State === 'created' ? '已创建' : '已复用'}：${config.R2_BUCKET_NAME}`);
} else {
  console.log('未配置 R2_BUCKET_NAME，附件对象存储绑定将被关闭。');
}

console.log('\n[5/8] 生成生产配置，原子写入 Secret 并部署 Worker');
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
const existingWorkerInventory = await workerSecretInventory(config, deploymentEnv);
const existingSecretNames = existingWorkerInventory.names;
const workerState = existingWorkerInventory.exists ? 'updated' : 'created';
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

// From this point onward the deployed Worker contains a temporary, privileged
// initialization secret. Any later failure must retire it before the process
// exits so a failed acceptance check never leaves deployment authority online.
failureCleanup = () => {
	console.error('\n[清理] 部署未完成，正在撤销一次性 INIT_SECRET。');
	const cleanup = wrangler(['secret', 'delete', 'INIT_SECRET', '-c', generatedConfig], {
		env: deploymentEnv,
		input: 'y\n',
		allowFailure: true,
	});
	if (cleanup.status !== 0) {
		console.error(`[清理失败] INIT_SECRET 撤销命令退出码 ${cleanup.status}；请立即重跑工作流或在 Cloudflare 删除该 Secret。`);
	}
};

console.log('\n[6/8] 撤销配置中已停用的旧 Worker Secret');
const configuredOptionalSecrets = {
  LONGOS_INTEGRATION_TOKEN: config.LONGOS_INTEGRATION_TOKEN,
  RELAY_SHARED_SECRET: config.LONGOS_INTEGRATION_TOKEN ? '' : config.RELAY_SHARED_SECRET,
  RESEND_WEBHOOK_SECRET: config.LONGOS_INTEGRATION_TOKEN ? '' : config.RESEND_WEBHOOK_SECRET,
};
for (const [name, value] of Object.entries(configuredOptionalSecrets)) {
  if (value || !existingSecretNames.has(name)) continue;
  wrangler(['secret', 'delete', name, '-c', generatedConfig], { env: deploymentEnv, input: 'y\n' });
}

console.log('\n[7/8] 初始化/升级数据库并验收');
let initialized = false;
let adminBootstrapStatus = '';
for (let attempt = 1; attempt <= 12; attempt += 1) {
  try {
    const result = await fetchJson(`${workerUrl}/api/init`, {
      method: 'POST',
      headers: { authorization: `Bearer ${initSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        bootstrapAdmin: true,
        adminPassword: config.ADMIN_PASSWORD || '',
      }),
    });
    if (result.response.ok && result.text === 'success') {
      adminBootstrapStatus = result.response.headers.get('x-longos-admin-bootstrap') || 'verified';
      initialized = true;
      break;
    }
    if ([400, 409].includes(result.response.status)) {
      fail(`管理员初始化失败（HTTP ${result.response.status}）：${result.text || '请检查 ADMIN 与 ADMIN_PASSWORD。'}`);
    }
    console.log(`初始化等待 ${attempt}/12：HTTP ${result.response.status}`);
  } catch (error) {
    console.log(`初始化等待 ${attempt}/12：${error.message}`);
  }
  await new Promise(resolveDelay => setTimeout(resolveDelay, 10_000));
}
if (!initialized) fail('Worker 已发布，但自定义域或数据库初始化在两分钟内未就绪。可直接重跑同一命令。');
if (adminBootstrapStatus === 'created') {
  console.log(`✓ 已创建管理员 ${config.ADMIN}；可直接使用部署时输入的密码登录。`);
} else if (adminBootstrapStatus === 'existing-account-repaired') {
  console.log(`✓ 管理员 ${config.ADMIN} 已存在，并已修复缺失的主邮箱账户；原密码保持不变。`);
} else {
  console.log(`✓ 管理员 ${config.ADMIN} 已存在；为避免意外锁号，重复部署不会覆盖原密码。`);
}
let readinessCheck = await fetchJson(`${workerUrl}/api/health`);
if (!readinessCheck.response.ok || readinessCheck.body.status !== 'ok') {
  fail(`Worker 初始化完成，但 D1/KV 就绪验收失败（HTTP ${readinessCheck.response.status}）。`);
}
let publicCheck = await fetch(`${workerUrl}/api/setting/websiteConfig`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
if (!publicCheck.ok) fail(`Worker 初始化完成，但公开配置验收失败（HTTP ${publicCheck.status}）。`);

// INIT_SECRET is single-use deployment authority. Remove it after the schema
// has passed final verification so a leaked historical value is useless.
wrangler(['secret', 'delete', 'INIT_SECRET', '-c', generatedConfig], { env: deploymentEnv, input: 'y\n' });
const secretsAfterRetirement = await workerSecretInventory(config, deploymentEnv);
if (secretsAfterRetirement.names.has('INIT_SECRET')) fail('Cloudflare Secret 列表中仍存在 INIT_SECRET，撤销没有完成。');
failureCleanup = null;

// `wrangler secret delete` creates and deploys a new Worker version, but edge
// isolates do not all switch versions at the exact instant the command exits.
// Poll a no-side-effect authorization probe instead of treating the first
// response from a still-warm old isolate as a failed deployment.
let initSecretRetired = false;
const retirementAttempts = 6;
for (let attempt = 1; attempt <= retirementAttempts; attempt += 1) {
  try {
    const retiredInitCheck = await fetch(
      `${workerUrl}/api/init?authorization_probe=1&nonce=${randomBytes(8).toString('hex')}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${initSecret}`,
          'cache-control': 'no-store',
          'content-type': 'application/json',
        },
        body: '{}',
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (retiredInitCheck.status === 401) {
      initSecretRetired = true;
      break;
    }
    console.log(`等待 INIT_SECRET 撤销传播 ${attempt}/${retirementAttempts}：HTTP ${retiredInitCheck.status}`);
  } catch (error) {
    console.log(`等待 INIT_SECRET 撤销传播 ${attempt}/${retirementAttempts}：${error.message}`);
  }
  if (attempt < retirementAttempts) await new Promise(resolveDelay => setTimeout(resolveDelay, 5_000));
}
if (!initSecretRetired) {
  // The control-plane secret inventory above is authoritative. A warm edge
  // isolate can briefly keep the previous Worker version and return 200/204
  // after Wrangler has already removed the binding. Do not turn a successful
  // deployment into a false failure; the removed secret cannot enter any new
  // isolate and the probe is deliberately side-effect free.
  console.warn('⚠ Cloudflare Secret 列表已确认 INIT_SECRET 删除，但部分边缘实例的旧版本传播超过 30 秒；部署继续，旧实例淘汰后会自动返回 401。');
}
readinessCheck = await fetchJson(`${workerUrl}/api/health`);
if (!readinessCheck.response.ok || readinessCheck.body.status !== 'ok') {
  fail(`撤销一次性密钥后 D1/KV 就绪验收失败（HTTP ${readinessCheck.response.status}）。`);
}
publicCheck = await fetch(`${workerUrl}/api/setting/websiteConfig`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
if (!publicCheck.ok) fail(`撤销一次性密钥后公开配置验收失败（HTTP ${publicCheck.status}）。`);

const autoConfigureInbound = config.AUTO_CONFIGURE_EMAIL_ROUTING.toLowerCase() === 'true';
console.log(autoConfigureInbound
  ? '\n[8/8 收信自动配置] 启用 Email Routing 并将 Catch-all 指向当前 Worker'
  : '\n[8/8 收信自动配置] 已通过 AUTO_CONFIGURE_EMAIL_ROUTING=false 主动跳过');
let inboundRouting = autoConfigureInbound
  ? await configureEmailRouting({
    token: config.CLOUDFLARE_API_TOKEN,
    accountId: config.CLOUDFLARE_ACCOUNT_ID,
    workerName: config.NAME,
    domains,
  })
  : {configured: [], manual: domains.map(domain => ({domain, reason: 'AUTO_CONFIGURE_EMAIL_ROUTING=false'})), warnings: []};
for (const domain of inboundRouting.configured) console.log(`✓ ${domain} → ${config.NAME}`);
if (autoConfigureInbound) {
  for (const item of inboundRouting.manual) {
    console.warn(`⚠ ${item.domain} 未能自动配置：${item.reason}`);
  }
  for (const item of inboundRouting.warnings) {
    console.warn(`⚠ ${item.domain} 配置已写入但尚未健康：${item.reason}`);
  }
}

let outboundDns = {configured: false, skipped: true, reason: 'LONGOS gateway is not configured'};
if (config.LONGOS_RELAY_URL) {
  console.log('\n[发信自动配置] 合并 SPF、发布 DKIM/DMARC，并校准 DNS-only 邮件主机');
  outboundDns = await syncLongosOutboundDns({
    relayUrl: config.LONGOS_RELAY_URL,
    integrationToken: config.LONGOS_INTEGRATION_TOKEN,
    cloudflareToken: config.CLOUDFLARE_API_TOKEN,
    accountId: config.CLOUDFLARE_ACCOUNT_ID,
  });
  if (outboundDns.configured) {
    const sync = outboundDns.sync;
    console.log(`✓ LONGOS 发信 DNS 已同步：新增 ${(sync.created || []).length}、更新 ${(sync.updated || []).length}、清理 ${(sync.removed || []).length}`);
    for (const warning of sync.warnings || []) console.warn(`⚠ ${warning}`);
  } else if (outboundDns.skipped) {
    console.warn('⚠ 当前 LONGOS 版本尚不支持部署期 DNS 同步；请先升级 LONGOS，或在邮件设置中运行“一键配置邮件 DNS”。');
  } else {
    console.warn(`⚠ LONGOS 发信 DNS 自动同步未完成：${outboundDns.reason}`);
  }
}

if (autoConfigureInbound && inboundRouting.warnings.length > 0 && outboundDns.configured) {
  console.log('正在等待发信 SPF 合并后的 Email Routing 状态收敛…');
  for (let attempt = 1; attempt <= 4 && inboundRouting.warnings.length > 0; attempt += 1) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5_000));
    inboundRouting = await configureEmailRouting({
      token: config.CLOUDFLARE_API_TOKEN,
      accountId: config.CLOUDFLARE_ACCOUNT_ID,
      workerName: config.NAME,
      domains,
    });
    if (inboundRouting.warnings.length > 0) {
      console.log(`Email Routing 状态复核 ${attempt}/4：${inboundRouting.warnings.map(item => `${item.domain}=${item.reason}`).join('；')}`);
    }
  }
}

if (config.LONGOS_RELAY_URL && !outboundDns.configured) {
  fail(`Worker 已部署，但 LONGOS 发信 DNS 验收未通过：${outboundDns.reason || '当前 LONGOS 不支持部署期 DNS 同步'}`);
}
if (autoConfigureInbound && inboundRouting.manual.length > 0) {
  fail(`Worker 已部署，但以下收信域未完成自动配置：${inboundRouting.manual.map(item => `${item.domain}（${item.reason}）`).join('；')}`);
}
if (autoConfigureInbound && inboundRouting.warnings.length > 0) {
  fail(`Worker 已部署，但以下收信域在发信 SPF 合并后仍未就绪：${inboundRouting.warnings.map(item => `${item.domain}（${item.reason}）`).join('；')}`);
}

console.log(`\n[完成] Cloud Mail 已部署：${workerUrl}`);
console.log(`资源结果：Worker ${workerState === 'created' ? '已创建' : '已更新'}；D1 ${d1State === 'created' ? '已创建' : '已复用'}；KV ${kvState === 'created' ? '已创建' : '已复用'}；R2 ${r2State === 'disabled' ? '未启用' : r2State === 'created' ? '已创建' : '已复用'}。`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, [
    `worker_url=${workerUrl}`,
    `worker_state=${workerState}`,
    `d1_database_id=${d1Id}`,
    `d1_state=${d1State}`,
    `kv_namespace_id=${kvId}`,
    `kv_state=${kvState}`,
    `r2_bucket_name=${config.R2_BUCKET_NAME}`,
    `r2_state=${r2State}`,
    '',
  ].join('\n'), 'utf8');
}
if (!autoConfigureInbound) {
  console.log('Email Routing 自动配置已主动关闭；现有 MX 与 Catch-all 未被修改。');
} else if (inboundRouting.manual.length === 0 && inboundRouting.warnings.length === 0) {
  console.log('Email Routing 与 Catch-all 已自动配置，无需再到 Cloudflare 手工设置收件规则。');
} else {
  if (inboundRouting.manual.length > 0) {
    console.log(`仅以下域需要在 Cloudflare Email Routing 手工补充 Catch-all：${inboundRouting.manual.map(item => item.domain).join('、')}`);
    console.log('给 API Token 增加 Zone:Read、Zone Settings:Write 和 Email Routing Rules:Write（旧界面名称为 Edit）后重跑，可自动完成。');
  }
  if (inboundRouting.warnings.length > 0) {
    console.log(`以下域的收信规则已就绪，但 Email Routing DNS 状态仍异常：${inboundRouting.warnings.map(item => item.domain).join('、')}。请先修复 MX/SPF 冲突。`);
  }
}
console.log('然后登录 Cloud Mail 创建发件账户，并在 LONGOS 后台分别发送“测试邮件、下单邮件、弃单召回邮件”完成业务验收。');
