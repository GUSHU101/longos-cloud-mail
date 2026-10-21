import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {buildWorkflowInputs} from './trigger-github-deployment.mjs';
import {deploymentEnvironment} from './deploy-wizard.mjs';

const source = readFileSync(new URL('./deploy-wizard.mjs', import.meta.url), 'utf8');

test('passes one-time credentials only through the deployment child environment', () => {
  const inputs = buildWorkflowInputs({
    workerName: 'cloud-mail',
    customDomain: 'mail.example.com',
    mailDomains: 'example.com',
    adminEmail: 'admin@example.com',
    longosRelayUrl: 'https://shop.example.com/_longos/mail-relay',
  });
  const environment = deploymentEnvironment(inputs, {
    cloudflareApiToken: 'cf-token',
    longosIntegrationToken: `longos_it_${'a'.repeat(64)}`,
  }, {
    PATH: 'test-path',
    JWT_SECRET: 'stale-jwt-secret',
    RELAY_SHARED_SECRET: 'stale-relay-secret',
    RESEND_WEBHOOK_SECRET: 'stale-webhook-secret',
  });

  assert.equal(environment.CLOUDFLARE_API_TOKEN, 'cf-token');
  assert.equal(environment.LONGOS_INTEGRATION_TOKEN, `longos_it_${'a'.repeat(64)}`);
  assert.equal(environment.PATH, 'test-path');
  assert.equal(environment.NAME, 'cloud-mail');
  assert.equal(environment.AUTO_CONFIGURE_EMAIL_ROUTING, 'true');
  assert.equal(environment.JWT_SECRET, '');
  assert.equal(environment.RELAY_SHARED_SECRET, '');
  assert.equal(environment.RESEND_WEBHOOK_SECRET, '');
});

test('does not persist or place credentials in command arguments', () => {
  assert.match(source, /spawnSync\(process\.execPath, \['scripts\/deploy-cloudflare\.mjs', '--from-env'\]/);
  assert.doesNotMatch(source, /writeFile|appendFile|\.cloud-mail\.deploy\.env/);
  assert.doesNotMatch(source, /--(?:token|secret|api-key)/i);
});
