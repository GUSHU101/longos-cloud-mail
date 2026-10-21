import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {buildWorkflowInputs, validateWizardConfiguration} from './trigger-github-deployment.mjs';

const source = readFileSync(new URL('./trigger-github-deployment.mjs', import.meta.url), 'utf8');

const validInputs = buildWorkflowInputs({
  workerName: 'cloud-mail',
  customDomain: 'mail.example.com',
  mailDomains: 'example.com',
  adminEmail: 'admin@example.com',
  longosRelayUrl: 'https://shop.example.com/_longos/mail-relay',
});
const validSecrets = {
  adminPassword: 'correct horse battery',
  cloudflareApiToken: 'cloudflare-api-token-without-whitespace',
  longosIntegrationToken: `longos_it_${'a'.repeat(64)}`,
};

test('builds only the documented non-secret workflow inputs', () => {
  assert.deepEqual(Object.keys(validInputs), [
    'worker_name',
    'custom_domain',
    'mail_domains',
    'admin_email',
    'longos_relay_url',
    'cloudflare_account_id',
    'd1_database_name',
    'd1_database_id',
    'kv_namespace_id',
    'r2_bucket_name',
    'project_link',
    'ai_model',
    'cors_origins',
    'auto_configure_email_routing',
    'cloudflare_email',
    'analysis_cache',
  ]);
  assert.ok(Object.keys(validInputs).every(name => !/(?:token|secret|password|api_key)/i.test(name)));
  assert.equal(validInputs.auto_configure_email_routing, true);
  assert.equal(validInputs.cloudflare_email, false);
  assert.equal(validInputs.cors_origins, '[]');
});
test('validates required credentials without adding them to workflow dispatch data', () => {
  assert.equal(validateWizardConfiguration(validInputs, validSecrets), true);
  assert.throws(
    () => validateWizardConfiguration(validInputs, {...validSecrets, cloudflareApiToken: ''}),
    /Cloudflare API Token/,
  );
  assert.throws(
    () => validateWizardConfiguration(validInputs, {...validSecrets, longosIntegrationToken: 'invalid'}),
    /LONGOS/,
  );
  assert.throws(
    () => validateWizardConfiguration(validInputs, {...validSecrets, adminPassword: 'short'}),
    /管理员初始密码/,
  );
  assert.equal(JSON.stringify(validInputs).includes(validSecrets.cloudflareApiToken), false);
  assert.equal(JSON.stringify(validInputs).includes(validSecrets.longosIntegrationToken), false);
  assert.equal(JSON.stringify(validInputs).includes(validSecrets.adminPassword), false);
});

test('rejects R2 bucket names that Cloudflare cannot create', () => {
  const invalidInputs = {...validInputs, r2_bucket_name: 'cloud.mail.attachments'};
  assert.throws(
    () => validateWizardConfiguration(invalidInputs, validSecrets),
    /R2 桶名/,
  );
});
test('accepts automatic R2 provisioning without exposing a resource ID', () => {
  assert.equal(validateWizardConfiguration({...validInputs, r2_bucket_name: 'auto'}, validSecrets), true);
});
test('sends environment secrets over stdin and dispatches variables as JSON', () => {
  assert.match(source, /'secret', 'set', name,[\s\S]*'--env', PRODUCTION_ENVIRONMENT/);
  assert.match(source, /\], \{input: value, capture: true\}\);/);
  assert.doesNotMatch(source, /'--body'/);
  assert.match(source, /'workflow', 'run', WORKFLOW_FILE,[\s\S]*'--json'/);
  assert.match(source, /input: `\$\{JSON\.stringify\(inputs\)\}\\n`/);
  assert.match(source, /setEnvironmentSecret\(repository, 'ADMIN_PASSWORD', adminPassword\)/);
});
