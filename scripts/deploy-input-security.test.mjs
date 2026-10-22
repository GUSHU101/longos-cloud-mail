import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {sanitizedVerificationEnvironment} from './deployment-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deployer = resolve(root, 'scripts/deploy-cloudflare.mjs');
const validEnv = {
  ...sanitizedVerificationEnvironment(process.env),
  CLOUDFLARE_API_TOKEN: 'validation-only-token',
  DOMAIN: 'example.com',
  ADMIN: 'admin@example.com',
  ADMIN_PASSWORD: 'correct horse battery',
  NAME: 'cloud-mail',
  CORS_ORIGINS: '[]',
};

function validate(extra) {
  return spawnSync(process.execPath, [deployer, '--from-env', '--validate-only'], {
    cwd: root,
    env: {...validEnv, ...extra},
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('accepts a valid environment without contacting Cloudflare', () => {
  const result = validate({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /校验通过/);
});

test('rejects shell-like worker names and project URLs as data', () => {
  const name = validate({NAME: 'cloud-mail;echo-owned'});
  assert.equal(name.status, 1);
  assert.match(name.stderr, /NAME/);

  const project = validate({PROJECT_LINK: 'https://example.com/$(whoami)'});
  assert.equal(project.status, 1);
  assert.match(project.stderr, /PROJECT_LINK/);
});

test('rejects local, literal-IP and non-standard-port LONGOS relay targets', () => {
  const token = `longos_it_${'A'.repeat(64)}`;
  for (const relayUrl of [
    'https://localhost/_longos/mail-relay',
    'https://127.0.0.1/_longos/mail-relay',
    'https://longos.internal/_longos/mail-relay',
    'https://shop.example.com:8443/_longos/mail-relay',
  ]) {
    const result = validate({LONGOS_RELAY_URL: relayUrl, LONGOS_INTEGRATION_TOKEN: token});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /LONGOS_RELAY_URL/);
  }
});

test('cannot bypass verification outside GitHub Actions', () => {
  const result = spawnSync(process.execPath, [deployer, '--from-env', '--validate-only', '--skip-verification'], {
    cwd: root,
    env: {...validEnv, CI: 'true', GITHUB_ACTIONS: 'false'},
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skip-verification/);
});

test('rejects R2 names that the Cloudflare API cannot create', () => {
  const result = validate({R2_BUCKET_NAME: 'attachments.example.com'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /R2_BUCKET_NAME/);
});

test('accepts managed automatic R2 provisioning', () => {
  const result = validate({R2_BUCKET_NAME: 'auto'});
  assert.equal(result.status, 0, result.stderr);
});

test('validates the deployment-only administrator password boundary', () => {
  const tooShort = validate({ADMIN_PASSWORD: 'short'});
  assert.equal(tooShort.status, 1);
  assert.match(tooShort.stderr, /ADMIN_PASSWORD/);

  const tooLong = validate({ADMIN_PASSWORD: 'x'.repeat(31)});
  assert.equal(tooLong.status, 1);
  assert.match(tooLong.stderr, /ADMIN_PASSWORD/);
});
