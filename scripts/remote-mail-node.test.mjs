import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compose = readFileSync(resolve(root, 'mail-relay/docker-compose.coolify.yml'), 'utf8');
const envExample = readFileSync(resolve(root, 'mail-relay/coolify.env.example'), 'utf8');
const dockerignore = readFileSync(resolve(root, 'mail-relay/.dockerignore'), 'utf8');
const guide = readFileSync(resolve(root, 'doc/REMOTE_MAIL_NODE.md'), 'utf8');

test('Coolify mail node keeps the relay private and leaves 80/443 to the existing proxy', () => {
  assert.match(compose, /127\.0\.0\.1:\$\{RELAY_HTTP_PORT:-8788\}:3000/);
  assert.doesNotMatch(compose, /(?:^|["'\s-])(?:80|443):/m);
  assert.match(compose, /network_mode:\s*host/);
  assert.match(compose, /TUNNEL_TOKEN:\s*\$\{TUNNEL_TOKEN:\?/);
});

test('Coolify mail node makes identity and isolated HMAC credentials mandatory', () => {
  for (const variable of [
    'MAIL_HOSTNAME',
    'MAIL_PUBLIC_IPS',
    'MAIL_DOMAINS',
    'ALLOWED_SENDER_DOMAINS',
    'LONGOS_RELAY_SHARED_SECRET',
    'CLOUD_MAIL_RELAY_SHARED_SECRET',
  ]) {
    assert.match(compose, new RegExp(`${variable}: \\$\\{${variable}:\\?`));
  }
  assert.match(compose, /cloudflare\/cloudflared:2026\.10\.5/);
});

test('Coolify mail node uses stable persistent volume names and bounded logs', () => {
  for (const suffix of ['postfix-spool', 'dkim-keys', 'relay-dns', 'relay-state']) {
    assert.match(compose, new RegExp(`MAIL_NODE_VOLUME_PREFIX:-longos-remote-mail}[-]${suffix}`));
  }
  assert.match(compose, /max-size:\s*"10m"/);
  assert.match(compose, /max-file:\s*"5"/);
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
