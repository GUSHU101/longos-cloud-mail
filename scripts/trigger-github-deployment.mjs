#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {emitKeypressEvents} from 'node:readline';
import {createInterface} from 'node:readline/promises';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const WORKFLOW_FILE = 'deploy-cloudflare.yml';
export const PRODUCTION_ENVIRONMENT = 'production';

export function buildWorkflowInputs(values) {
  return {
    worker_name: String(values.workerName || 'cloud-mail').trim(),
    custom_domain: String(values.customDomain || '').trim(),
    mail_domains: String(values.mailDomains || '').trim(),
    admin_email: String(values.adminEmail || '').trim(),
    longos_relay_url: String(values.longosRelayUrl || '').trim(),
    cloudflare_account_id: String(values.cloudflareAccountId || '').trim(),
    d1_database_name: String(values.d1DatabaseName || '').trim(),
    d1_database_id: String(values.d1DatabaseId || '').trim(),
    kv_namespace_id: String(values.kvNamespaceId || '').trim(),
    r2_bucket_name: String(values.r2BucketName || '').trim(),
    project_link: String(values.projectLink || '').trim(),
    ai_model: String(values.aiModel || '@cf/meta/llama-3.1-8b-instruct-fast').trim(),
    cors_origins: String(values.corsOrigins || '[]').trim(),
    auto_configure_email_routing: values.autoConfigureEmailRouting !== false,
    cloudflare_email: values.cloudflareEmail === true,
    analysis_cache: values.analysisCache === true,
  };
}
export function validateWizardConfiguration(inputs, secrets) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(inputs.worker_name)) {
    throw new Error('Worker 名称只能使用小写字母、数字、下划线和连字符。');
  }
  if (inputs.d1_database_name && !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(inputs.d1_database_name)) {
    throw new Error('D1 名称格式不正确。');
  }
  let domains;
  try {
    domains = inputs.mail_domains.trim().startsWith('[')
      ? JSON.parse(inputs.mail_domains)
      : inputs.mail_domains.split(/[\s,;]+/).filter(Boolean);
  } catch {
    throw new Error('收件域格式不正确。');
  }
  const validDomain = domain => typeof domain === 'string'
    && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(domain)
    && domain.includes('.')
    && domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (!Array.isArray(domains) || domains.length === 0 || domains.some(domain => !validDomain(domain))) {
    throw new Error('收件域不能为空，且必须是有效域名。');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inputs.admin_email)) {
    throw new Error('管理员邮箱格式不正确。');
  }
  if (!domains.map(domain => domain.toLowerCase()).includes(inputs.admin_email.split('@').at(-1).toLowerCase())) {
    throw new Error('管理员邮箱必须使用收件域中的域名。');
  }
  if (inputs.custom_domain && !validDomain(inputs.custom_domain)) {
    throw new Error('Cloud Mail 访问域名格式不正确，请不要填写协议或路径。');
  }
  if (inputs.cloudflare_account_id && !/^[a-f0-9]{32}$/i.test(inputs.cloudflare_account_id)) {
    throw new Error('Cloudflare Account ID 必须是 32 位十六进制 ID。');
  }
  if (inputs.d1_database_id && !/^[a-f0-9-]{32,36}$/i.test(inputs.d1_database_id)) {
    throw new Error('D1 ID 格式不正确。');
  }
  if (inputs.kv_namespace_id && !/^[a-f0-9]{32}$/i.test(inputs.kv_namespace_id)) {
    throw new Error('KV Namespace ID 必须是 32 位十六进制 ID。');
  }
  if (inputs.r2_bucket_name && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(inputs.r2_bucket_name)) {
    throw new Error('R2 桶名只能包含小写字母、数字和连字符，长度为 3–63。');
  }
  if (inputs.project_link && !/^https:\/\/[A-Za-z0-9./?_=:%#-]+$/.test(inputs.project_link)) {
    throw new Error('项目链接必须是安全的 HTTPS URL。');
  }
  if (inputs.ai_model && !/^[@A-Za-z0-9._/-]+$/.test(inputs.ai_model)) {
    throw new Error('Workers AI 模型名称含有不允许的字符。');
  }
  let origins;
  try {
    origins = JSON.parse(inputs.cors_origins);
  } catch {
    throw new Error('CORS Origins 必须是 JSON 数组，例如 []。');
  }
  if (!Array.isArray(origins) || origins.some(origin => typeof origin !== 'string')) {
    throw new Error('CORS Origins 必须是字符串 JSON 数组。');
  }
  for (const origin of origins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS Origin 不是有效 URL：${origin}`);
    }
    if (url.protocol !== 'https:' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`CORS Origin 只允许不含路径和凭据的 HTTPS Origin：${origin}`);
    }
  }
  if (!secrets.cloudflareApiToken || secrets.cloudflareApiToken.length < 20 || /\s/.test(secrets.cloudflareApiToken)) {
    throw new Error('Cloudflare API Token 不能为空或包含空白字符。');
  }
  if (inputs.longos_relay_url) {
    let relay;
    try {
      relay = new URL(inputs.longos_relay_url);
    } catch {
      throw new Error('LONGOS 网关不是有效 URL。');
    }
    const hostname = relay.hostname.toLowerCase();
    if (relay.protocol !== 'https:' || relay.username || relay.password || relay.port
      || isIP(hostname) !== 0 || !validDomain(hostname)
      || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost')
      || relay.pathname.replace(/\/$/, '') !== '/_longos/mail-relay' || relay.search || relay.hash) {
      throw new Error('LONGOS 网关必须是公共域名、标准 HTTPS 端口的 /_longos/mail-relay 地址。');
    }
  }
  if (inputs.longos_relay_url && !/^longos_it_[A-Za-z0-9]{64}$/.test(secrets.longosIntegrationToken || '')) {
    throw new Error('启用 LONGOS 网关时，必须填写有效的 longos_it_ 系统集成令牌。');
  }
  return true;
}
function parseArguments(argv) {
  const result = {repo: '', ref: '', help: false};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--repo') result.repo = argv[++index] || '';
    else if (argument === '--ref') result.ref = argv[++index] || '';
    else throw new Error(`未知参数：${argument}`);
  }
  return result;
}

function runGh(args, options = {}) {
  const command = process.platform === 'win32' ? 'gh.exe' : 'gh';
  const capture = options.capture === true;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options.input,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : options.input !== undefined
      ? ['pipe', 'inherit', 'inherit']
      : 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`无法启动 GitHub CLI：${result.error.message}。请先安装并执行 gh auth login。`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = [result.stderr, result.stdout].map(value => String(value || '').trim()).find(Boolean);
    throw new Error(`gh ${args.join(' ')} 执行失败${detail ? `：${detail}` : `（退出码 ${result.status}）`}。`);
  }
  return result;
}

async function question(label, defaultValue = '', required = false) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  while (true) {
    const terminal = createInterface({input: process.stdin, output: process.stdout});
    let answer;
    try {
      answer = (await terminal.question(`${label}${suffix}: `)).trim();
    } finally {
      terminal.close();
    }
    const value = answer || defaultValue;
    if (value || !required) return value;
    console.log('该项不能为空。');
  }
}

async function confirm(label, defaultValue) {
  const answer = (await question(`${label} (${defaultValue ? 'Y/n' : 'y/N'})`)).toLowerCase();
  if (!answer) return defaultValue;
  if (['y', 'yes', '是'].includes(answer)) return true;
  if (['n', 'no', '否'].includes(answer)) return false;
  throw new Error(`${label} 只能回答 y 或 n。`);
}

async function hiddenQuestion(label, required) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('密钥只能在交互式终端中隐藏输入；请在 PowerShell、Terminal 或 bash 中运行本命令。');
  }
  process.stdout.write(`${label}${required ? '' : '（留空跳过）'}: `);
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolveSecret, rejectSecret) => {
    let value = '';
    const finish = (error) => {
      process.stdin.off('keypress', onKeypress);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) rejectSecret(error);
      else if (required && !value) rejectSecret(new Error(`${label}不能为空。`));
      else resolveSecret(value);
    };
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('已取消部署。'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (!key.ctrl && !key.meta && text && !/[\r\n]/.test(text)) value += text;
    };
    process.stdin.on('keypress', onKeypress);
  });
}

function repositoryInformation(explicitRepository) {
  const args = ['repo', 'view'];
  if (explicitRepository) args.push(explicitRepository);
  args.push('--json', 'nameWithOwner,defaultBranchRef');
  const result = runGh(args, {capture: true});
  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw new Error('GitHub CLI 未返回可解析的仓库信息。');
  }
  if (!body.nameWithOwner || !body.defaultBranchRef?.name) {
    throw new Error('无法识别 GitHub 仓库或默认分支。');
  }
  return {repository: body.nameWithOwner, defaultBranch: body.defaultBranchRef.name};
}

function ensureProductionEnvironment(repository) {
  const endpoint = `repos/${repository}/environments/${PRODUCTION_ENVIRONMENT}`;
  const current = runGh(['api', endpoint], {capture: true, allowFailure: true});
  if (current.status === 0) return false;
  const failure = `${current.stderr || ''}\n${current.stdout || ''}`;
  if (!/404|Not Found/i.test(failure)) {
    throw new Error(`无法读取 GitHub production Environment：${failure.trim() || `退出码 ${current.status}`}。`);
  }
  runGh(['api', '--method', 'PUT', endpoint, '--input', '-'], {input: '{}\n'});
  return true;
}

function setEnvironmentSecret(repository, name, value) {
  runGh([
    'secret', 'set', name,
    '--env', PRODUCTION_ENVIRONMENT,
    '--repo', repository,
  ], {input: value, capture: true});
  console.log(`✓ 已安全更新 ${PRODUCTION_ENVIRONMENT} / ${name}`);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node scripts/trigger-github-deployment.mjs [--repo owner/repo] [--ref 默认分支]');
    console.log('普通变量在本次向导中填写；密钥隐藏输入并通过 stdin 写入 GitHub production Environment。');
    return;
  }

  runGh(['auth', 'status']);
  const info = repositoryInformation(args.repo);
  const repository = info.repository;
  const ref = args.ref || info.defaultBranch;
  console.log(`\n目标：${repository} @ ${ref}`);
  console.log('直接回车采用方括号中的安全默认值；密钥不会回显，也不会进入命令行参数。\n');

  const workerName = await question('Worker 名称', 'cloud-mail', true);
  const customDomain = await question('Cloud Mail 访问域名（可留空使用 workers.dev）');
  const mailDomains = await question('收件域（多个用逗号分隔）', '', true);
  const adminEmail = await question('管理员邮箱', '', true);
  const longosRelayUrl = await question('LONGOS 主站邮件网关（仅收信可留空）');
  const useR2 = await confirm('启用 R2 附件存储', true);
  const configureAdvanced = await confirm('配置已有资源 ID、CORS、AI 等高级选项', false);

  let cloudflareAccountId = '';
  let d1DatabaseName = workerName;
  let d1DatabaseId = '';
  let kvNamespaceId = '';
  let r2BucketName = useR2
    ? `${workerName.replaceAll('_', '-').slice(0, 48).replace(/[-.]$/, '') || 'cloud-mail'}-attachments`
    : '';
  let projectLink = `https://github.com/${repository}`;
  let aiModel = '@cf/meta/llama-3.1-8b-instruct-fast';
  let corsOrigins = '[]';
  let autoConfigureEmailRouting = true;
  let cloudflareEmail = false;
  let analysisCache = false;

  if (configureAdvanced) {
    cloudflareAccountId = await question('Cloudflare Account ID（单账户 Token 可留空）');
    d1DatabaseName = await question('D1 名称', workerName);
    d1DatabaseId = await question('已有 D1 ID（首次部署留空）');
    kvNamespaceId = await question('已有 KV ID（首次部署留空）');
    if (useR2) r2BucketName = await question('R2 桶名', r2BucketName);
    projectLink = await question('界面项目链接', projectLink);
    aiModel = await question('Workers AI 模型', aiModel);
    corsOrigins = await question('CORS Origins JSON', corsOrigins);
    autoConfigureEmailRouting = await confirm('自动配置 Email Routing 与 Catch-all', true);
    cloudflareEmail = longosRelayUrl ? false : await confirm('启用 Cloudflare Email 出站兼容绑定', false);
    analysisCache = await confirm('启用邮件分析缓存', false);
  }

  console.log('\n请输入本次部署密钥：');
  const cloudflareApiToken = await hiddenQuestion('Cloudflare API Token', true);
  const longosIntegrationToken = longosRelayUrl
    ? await hiddenQuestion('LONGOS 系统集成令牌', true)
    : '';

  const inputs = buildWorkflowInputs({
    workerName,
    customDomain,
    mailDomains,
    adminEmail,
    longosRelayUrl,
    cloudflareAccountId,
    d1DatabaseName,
    d1DatabaseId,
    kvNamespaceId,
    r2BucketName,
    projectLink,
    aiModel,
    corsOrigins,
    autoConfigureEmailRouting,
    cloudflareEmail,
    analysisCache,
  });
  const secrets = {cloudflareApiToken, longosIntegrationToken};
  validateWizardConfiguration(inputs, secrets);

  const createdEnvironment = ensureProductionEnvironment(repository);
  if (createdEnvironment) {
    console.log(`✓ 已创建 ${PRODUCTION_ENVIRONMENT} Environment；工作流自身仍强制仓库所有者和默认分支。`);
  }
  setEnvironmentSecret(repository, 'CLOUDFLARE_API_TOKEN', cloudflareApiToken);
  if (longosRelayUrl) setEnvironmentSecret(repository, 'LONGOS_INTEGRATION_TOKEN', longosIntegrationToken);

  runGh([
    'workflow', 'run', WORKFLOW_FILE,
    '--repo', repository,
    '--ref', ref,
    '--json',
  ], {input: `${JSON.stringify(inputs)}\n`});

  console.log('\n✓ 部署已触发。');
  console.log(`查看进度：https://github.com/${repository}/actions/workflows/${WORKFLOW_FILE}`);
  console.log('密钥已在本机加密后写入 production Environment；未进入工作流输入、命令参数或仓库文件。');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(error => {
    console.error(`\n[失败] ${error.message}`);
    process.exitCode = 1;
  });
}
