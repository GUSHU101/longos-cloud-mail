import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  remoteMailNodeManifest,
  validateRemoteMailNodePublicProfile,
} from './remote-mail-node-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compose = readFileSync(resolve(root, 'mail-relay/docker-compose.coolify.yml'), 'utf8');
const envExample = readFileSync(resolve(root, 'mail-relay/coolify.env.example'), 'utf8');
const dockerignore = readFileSync(resolve(root, 'mail-relay/.dockerignore'), 'utf8');
const guide = readFileSync(resolve(root, 'doc/REMOTE_MAIL_NODE.md'), 'utf8');

test('Coolify mail node keeps the relay private and leaves 80/443 to the existing proxy', () => {
  assert.match(compose, /127\.0\.0\.1:\$\{RELAY_HTTP_PORT:-8788\}:3000/);
  assert.doesNotMatch(compose, /(?:^|["'\s-])(?:80|443):/m);
  assert.match(compose, /network_mode:\s*host/);
  assert.match(compose, /TUNNEL_TOKEN_FILE:\s*\/run\/secrets\/cloudflare-tunnel-token/);
});

test('Coolify mail node makes identity and isolated HMAC credentials mandatory', () => {
  assert.match(compose, /MAIL_NODE_PROFILE_VERSION:\s*\$\{MAIL_NODE_PROFILE_VERSION:-1}/);
  for (const variable of ['MAIL_HOSTNAME', 'MAIL_PUBLIC_IPS', 'MAIL_DOMAINS', 'ALLOWED_SENDER_DOMAINS']) {
    assert.match(compose, new RegExp(`${variable}: \\$\\{${variable}:\\?`));
  }
  for (const variable of ['LONGOS_RELAY_SHARED_SECRET', 'CLOUD_MAIL_RELAY_SHARED_SECRET', 'TUNNEL_TOKEN']) {
    assert.match(compose, new RegExp(`environment: ${variable}`));
  }
  assert.match(compose, /LONGOS_RELAY_SHARED_SECRET_FILE:\s*\/run\/secrets\/longos-relay-shared-secret/);
  assert.match(compose, /CLOUD_MAIL_RELAY_SHARED_SECRET_FILE:\s*\/run\/secrets\/cloud-mail-relay-shared-secret/);
  assert.match(compose, /cloudflare\/cloudflared:2026\.10\.5/);
});

test('LONGOS control-panel profile contract stays aligned with Coolify defaults', () => {
  const profile = validateRemoteMailNodePublicProfile(envExample);
  assert.equal(profile.MAIL_NODE_PROFILE_VERSION, '1');
  assert.equal(remoteMailNodeManifest.version, '1');
  for (const [name, value] of Object.entries(remoteMailNodeManifest.publicDefaults)) {
    assert.equal(profile[name], value, `${name} drifted from the versioned profile manifest`);
  }
  for (const name of remoteMailNodeManifest.secretVariables) assert.equal(profile[name], undefined);
  assert.match(guide, /LONGOS 后台.*直接复制或下载/s);
});

test('public profile validator rejects secrets and unsafe deployment overrides', () => {
  const base = envExample.replace('203.0.113.10', '1.1.1.1');
  assert.throws(
    () => validateRemoteMailNodePublicProfile(base.replace('TUNNEL_TOKEN=', 'TUNNEL_TOKEN=must-not-be-here')),
    /must stay out of the public profile/,
  );
  assert.throws(
    () => validateRemoteMailNodePublicProfile(base.replace('RELAY_HTTP_PORT=8788', 'RELAY_HTTP_PORT=443')),
    /RELAY_HTTP_PORT must be between/,
  );
  assert.throws(
    () => validateRemoteMailNodePublicProfile(base.replace(
      'CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.10.5',
      'CLOUDFLARED_IMAGE=cloudflare/cloudflared:latest',
    )),
    /explicit version/,
  );
});

test('Coolify mail node uses stable persistent volume names and bounded logs', () => {
  for (const suffix of ['postfix-spool', 'dkim-keys', 'relay-dns', 'relay-state']) {
    assert.match(compose, new RegExp(`MAIL_NODE_VOLUME_PREFIX:-longos-remote-mail}[-]${suffix}`));
  }
  assert.match(compose, /max-size:\s*"10m"/);
  assert.match(compose, /max-file:\s*"5"/);
  assert.match(compose, /mem_limit:\s*\$\{RELAY_MEMORY_LIMIT:-768m}/);
  assert.match(compose, /pids_limit:\s*\$\{TUNNEL_PIDS_LIMIT:-128}/);
});

test('Tunnel credentials use a secret file and readiness checks real connector state', () => {
  assert.doesNotMatch(compose, /^\s+TUNNEL_TOKEN:/m);
  assert.match(compose, /--metrics\s*\n\s*- \$\{TUNNEL_METRICS_ADDRESS:-127\.0\.0\.1:20246}/);
  assert.match(compose, /"cloudflared", "tunnel", "--metrics"/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
});

test('build context and operator template do not package production secrets', () => {
  assert.match(dockerignore, /^\*\*$/m);
  assert.doesNotMatch(dockerignore, /!\.env/m);
  for (const secret of [
    'LONGOS_RELAY_SHARED_SECRET',
    'CLOUD_MAIL_RELAY_SHARED_SECRET',
    'TUNNEL_TOKEN',
  ]) {
    assert.match(envExample, new RegExp(`${secret}=$`, 'm'));
  }
});

test('operator guide documents the no-proxy, no-public-port deployment path', () => {
  assert.match(guide, /Custom \(None\)/);
  assert.match(guide, /docker-compose\.coolify\.yml/);
  assert.match(guide, /http:\/\/127\.0\.0\.1:8788/);
  assert.match(guide, /不要.*Start Proxy/);
});
