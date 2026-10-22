import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
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
  const result = validate({PATH: '', LONGOS_PNPM_ENTRYPOINT: ''});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /校验通过/);
  assert.match(result.stdout, /未联网、未安装依赖、未修改 Cloudflare/);
  assert.doesNotMatch(result.stdout, /未检测到 pnpm|正在临时安装/);
});

test('rejects unknown or conflicting CLI arguments before doing any work', () => {
  const unknown = spawnSync(process.execPath, [deployer, '--validate_only'], {
    cwd: root,
    env: {PATH: ''},
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /未知或重复的部署参数/);
  assert.doesNotMatch(unknown.stdout, /正在临时安装/);

  const conflict = spawnSync(process.execPath, [deployer, 'deploy.env', '--from-env'], {
    cwd: root,
    env: {PATH: ''},
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /不能与配置文件路径同时使用/);
});

test('rejects unknown and duplicate configuration-file keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'longos-deploy-config-test-'));
  const base = [
    'CLOUDFLARE_API_TOKEN=validation-only-token',
    'DOMAIN=example.com',
    'ADMIN=admin@example.com',
    'ADMIN_PASSWORD=correct horse battery',
    'NAME=cloud-mail',
    'CORS_ORIGINS=[]',
  ];

  try {
    const unknownPath = join(directory, 'unknown.env');
    writeFileSync(unknownPath, [...base, 'AUTO_CONFIGURE_EMAIL_ROUTNG=false'].join('\n'));
    const unknown = spawnSync(process.execPath, [deployer, unknownPath, '--validate-only'], {
      cwd: root,
      env: sanitizedVerificationEnvironment(process.env),
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /未知字段.*AUTO_CONFIGURE_EMAIL_ROUTNG/);

    const duplicatePath = join(directory, 'duplicate.env');
    writeFileSync(duplicatePath, [...base, 'DOMAIN=other.example.com'].join('\n'));
    const duplicate = spawnSync(process.execPath, [deployer, duplicatePath, '--validate-only'], {
      cwd: root,
      env: sanitizedVerificationEnvironment(process.env),
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /重复定义了 DOMAIN/);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
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
