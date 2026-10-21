#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {buildWorkflowInputs, validateWizardConfiguration} from './trigger-github-deployment.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

export function deploymentEnvironment(inputs, secrets, parentEnvironment = process.env) {
  return {
    ...parentEnvironment,
    NAME: inputs.worker_name,
    CUSTOM_DOMAIN: inputs.custom_domain,
    DOMAIN: inputs.mail_domains,
    ADMIN: inputs.admin_email,
    ADMIN_PASSWORD: secrets.adminPassword,
    LONGOS_RELAY_URL: inputs.longos_relay_url,
    CLOUDFLARE_ACCOUNT_ID: inputs.cloudflare_account_id,
    D1_DATABASE_NAME: inputs.d1_database_name || inputs.worker_name,
    D1_DATABASE_ID: inputs.d1_database_id,
    KV_NAMESPACE_ID: inputs.kv_namespace_id,
    R2_BUCKET_NAME: inputs.r2_bucket_name,
    PROJECT_LINK: inputs.project_link,
    AI_MODEL: inputs.ai_model,
    CORS_ORIGINS: inputs.cors_origins,
    AUTO_CONFIGURE_EMAIL_ROUTING: inputs.auto_configure_email_routing ? 'true' : 'false',
    CLOUDFLARE_EMAIL: inputs.cloudflare_email ? 'true' : 'false',
    ANALYSIS_CACHE: inputs.analysis_cache ? 'true' : 'false',
    CLOUDFLARE_API_TOKEN: secrets.cloudflareApiToken,
    LONGOS_INTEGRATION_TOKEN: inputs.longos_relay_url ? secrets.longosIntegrationToken : '',
    JWT_SECRET: '',
    RELAY_SHARED_SECRET: '',
    RESEND_WEBHOOK_SECRET: '',
  };
}

function runDeployment(environment) {
  const result = spawnSync(process.execPath, ['scripts/deploy-cloudflare.mjs', '--from-env'], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw new Error(`无法启动部署器：${result.error.message}`);
  if (result.status !== 0) throw new Error(`部署器退出码 ${result.status}。请按上方第一条明确错误修复后重跑；已创建的同名资源会安全复用。`);
}

async function main() {
  console.log('LONGOS Cloud Mail 一次性安全部署向导');
  console.log('Token 与管理员密码会在本终端回显，便于核对；不会写入仓库或 GitHub，只传给本次部署子进程。\n');

  const workerName = await question('Worker 名称', 'cloud-mail', true);
  const customDomain = await question('Cloud Mail 访问域名（建议填写；不含 https://）');
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
  let projectLink = 'https://github.com/GUSHU101/longos-cloud-mail';
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

  console.log('\n请输入仅用于本次进程的密钥（输入内容可见）：');
  const adminPassword = await question('管理员初始密码（12–30 个字符）', '', true);
  const adminPasswordConfirmation = await question('再次输入管理员初始密码', '', true);
  if (adminPassword !== adminPasswordConfirmation) throw new Error('两次输入的管理员密码不一致。');
  const cloudflareApiToken = await question('Cloudflare API Token', '', true);
  const longosIntegrationToken = longosRelayUrl
    ? await question('LONGOS 系统集成令牌', '', true)
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
  const secrets = {adminPassword, cloudflareApiToken, longosIntegrationToken};
  validateWizardConfiguration(inputs, secrets);

  console.log('\n部署计划（不显示密钥）：');
  console.log(`- Worker：${inputs.worker_name}`);
  console.log(`- 资源：Worker、D1、KV ${configureAdvanced ? '按填写值创建或复用' : '按名称自动创建或复用'}`);
  console.log(`- 页面：${inputs.custom_domain || 'workers.dev 自动地址'}`);
  console.log(`- 收件域：${inputs.mail_domains}`);
  console.log(`- 发信：${inputs.longos_relay_url ? 'LONGOS Postfix/OpenDKIM' : inputs.cloudflare_email ? 'Cloudflare Email 兼容模式' : '仅收信'}`);
  console.log(`- R2：${inputs.r2_bucket_name || '关闭'}`);
  console.log(`- Email Routing 自动配置：${inputs.auto_configure_email_routing ? '开启' : '关闭'}`);
  if (!await confirm('确认开始验证并部署', true)) throw new Error('已取消部署。');

  runDeployment(deploymentEnvironment(inputs, secrets));
  console.log('\n✓ 部署与验收完成。密钥未持久化；关闭本终端后当前进程环境即消失。');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(error => {
    console.error(`\n[失败] ${error.message}`);
    process.exitCode = 1;
  });
}
