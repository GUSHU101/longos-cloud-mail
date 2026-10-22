import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {
  DEPLOYMENT_ENVIRONMENT_KEYS,
  sanitizedVerificationEnvironment,
} from './deployment-environment.mjs';

const source = readFileSync(new URL('./deploy-cloudflare.mjs', import.meta.url), 'utf8');
const verifier = readFileSync(new URL('./verify-deployment.mjs', import.meta.url), 'utf8');

test('treats the Cloudflare secret inventory as the authoritative revocation check', () => {
  assert.match(source, /secretsAfterRetirement\.names\.has\('INIT_SECRET'\).*fail/);
  assert.match(source, /if \(!initSecretRetired\) \{[\s\S]*console\.warn/);
  assert.doesNotMatch(source, /if \(!initSecretRetired\) fail/);
});

test('creates or reuses managed resources and waits for control-plane visibility', () => {
  assert.match(source, /waitForCloudflareResource\(\{list: listD1/);
  assert.match(source, /waitForCloudflareResource\(\{list: listKv/);
  assert.match(source, /inspectCloudflareR2Bucket\(\{/);
  assert.match(source, /waitForCloudflareR2Bucket\(\{/);
  assert.doesNotMatch(source, /r2', 'bucket', 'info'/);
  assert.match(source, /workerState = existingWorkerInventory\.exists \? 'updated' : 'created'/);
});
test('uses a side-effect-free runtime probe and accepts only unauthorized as propagated', () => {
  assert.match(source, /authorization_probe=1/);
  assert.match(source, /retiredInitCheck\.status === 401/);
});
test('retires the temporary initialization secret on failures and process termination', () => {
  assert.match(source, /function runFailureCleanup\(\)/);
  assert.match(source, /function fail\(message\) \{\s*runFailureCleanup\(\)/);
  assert.match(source, /process\.once\('SIGINT'/);
  assert.match(source, /process\.once\('SIGTERM'/);
  assert.match(source, /process\.once\('exit',[\s\S]*runFailureCleanup\(\)/);
  const deployed = source.indexOf('if (deployment.status !== 0)');
  const cleanupRegistered = source.indexOf('failureCleanup = () =>', deployed);
  const workerUrlRequired = source.indexOf("if (!workerUrl) fail", deployed);
  assert.ok(deployed > 0 && cleanupRegistered > deployed && cleanupRegistered < workerUrlRequired);
});
test('fails final acceptance for real inbound or outbound DNS errors', () => {
  assert.match(source, /LONGOS 发信 DNS 验收未通过/);
  assert.match(source, /收信域未完成自动配置/);
  assert.match(source, /发信 SPF 合并后仍未就绪/);
});

test('preflights account resources, zones and the LONGOS gateway before preparing dependencies or creating storage', () => {
  const accountPreflight = source.indexOf('preflightCloudflareAccountResources({');
  const zonePreflight = source.indexOf('preflightCloudflareZones({');
  const relayPreflight = source.indexOf("[预检] 验证 LONGOS 主站邮件网关");
  const dependencyPreparation = source.indexOf('resolvePnpmCommand()', accountPreflight);
  const d1Mutation = source.indexOf("wrangler(['d1', 'create'");
  assert.ok(accountPreflight > 0 && zonePreflight > accountPreflight && relayPreflight > zonePreflight);
  assert.ok(dependencyPreparation > relayPreflight);
  assert.ok(d1Mutation > relayPreflight);
});

test('keeps production credentials out of dependency, test, audit and build subprocesses', () => {
  assert.match(source, /const verificationEnv = sanitizedVerificationEnvironment\(process\.env\)/);
  for (const secret of [
    'CLOUDFLARE_API_TOKEN',
    'ADMIN_PASSWORD',
    'JWT_SECRET',
    'LONGOS_INTEGRATION_TOKEN',
    'RELAY_SHARED_SECRET',
    'RESEND_WEBHOOK_SECRET',
  ]) {
    assert.ok(DEPLOYMENT_ENVIRONMENT_KEYS.includes(secret));
  }
  assert.match(source, /const deploymentEnv = \{\s*\.\.\.verificationEnv,/);
  assert.doesNotMatch(source, /const deploymentEnv = \{\s*\.\.\.process\.env,/);
  assert.match(source, /scripts\/verify-deployment\.mjs'[\s\S]*env: verificationEnv/);
  assert.match(source, /--skip-verification 只允许 GitHub Actions/);
  assert.match(source, /GITHUB_EVENT_NAME === 'workflow_dispatch'/);
  assert.match(source, /deploy-cloudflare\\\.yml@/);
  assert.match(verifier, /mail-worker', 'install', '--frozen-lockfile/);
  assert.match(verifier, /mail-vue', 'run', 'build'/);
  assert.match(verifier, /npm\(\['ci', '--no-audit', '--no-fund'\], \{cwd: relayRoot\}/);
  assert.match(verifier, /strictDependencyAudit = process\.env\.GITHUB_ACTIONS === 'true'/);
  assert.match(verifier, /category === 'transient-network' && !strictDependencyAudit/);
  assert.match(verifier, /'mail-worker', 'audit', '--prod', '--audit-level', 'moderate', '--json'/);
  assert.match(verifier, /'mail-vue', 'audit', '--prod', '--audit-level', 'moderate', '--json'/);
  assert.match(verifier, /'audit', '--omit=dev', '--audit-level', 'moderate', '--json'/);
  assert.match(verifier, /npm\(\['test'\], \{cwd: relayRoot\}/);
  assert.match(verifier, /readdirSync\(resolve\(repositoryRoot, 'scripts'\)/);
  assert.match(verifier, /entry\.name\.endsWith\('\.test\.mjs'\)/);
  assert.match(verifier, /\['--test', \.\.\.deploymentTests\]/);
});

test('removes complete deployment configuration and unrelated credentials from verification', () => {
  const clean = sanitizedVerificationEnvironment({
    PATH: 'system-path',
    LONGOS_RELAY_URL: 'https://shop.example.com/_longos/mail-relay',
    LONGOS_INTEGRATION_TOKEN: 'integration-token',
    CLOUDFLARE_API_TOKEN: 'cloudflare-token',
    ADMIN_PASSWORD: 'admin-password',
    NPM_TOKEN: 'registry-token',
    HTTP_AUTHORIZATION: 'Bearer private',
    AWS_ACCESS_KEY_ID: 'access-key',
    SSH_PRIVATE_KEY: 'private-key',
    SIGNING_KEY: 'signing-key',
    longos_relay_url: 'https://lowercase.example.com/_longos/mail-relay',
  });

  assert.equal(clean.PATH, 'system-path');
  assert.equal(clean.CI, 'true');
  assert.equal(clean.LONGOS_RELAY_URL, undefined);
  assert.equal(clean.LONGOS_INTEGRATION_TOKEN, undefined);
  assert.equal(clean.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(clean.ADMIN_PASSWORD, undefined);
  assert.equal(clean.NPM_TOKEN, undefined);
  assert.equal(clean.HTTP_AUTHORIZATION, undefined);
  assert.equal(clean.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(clean.SSH_PRIVATE_KEY, undefined);
  assert.equal(clean.SIGNING_KEY, undefined);
  assert.equal(clean.longos_relay_url, undefined);
});

test('bootstraps the administrator without persisting its password as a Worker secret', () => {
  assert.match(source, /bootstrapAdmin: true/);
  assert.match(source, /adminPassword: config\.ADMIN_PASSWORD \|\| ''/);
  assert.doesNotMatch(source, /deploymentSecrets\.ADMIN_PASSWORD/);
  assert.match(source, /重复部署不会覆盖原密码/);
});
