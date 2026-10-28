import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createSignature } from '../src/security.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'cloud-mail-identity-'));
const domain = 'mail.example.com';
const selector = 'mail2026';
const publicDirectory = join(temporary, domain);
mkdirSync(publicDirectory, { recursive: true });
writeFileSync(join(publicDirectory, `${selector}.txt`), 'v=DKIM1; h=sha256; k=rsa; p=UFVCTElDS0VZ\n');

Object.assign(process.env, {
  ALLOWED_SENDER_DOMAINS: domain,
  CLOUD_MAIL_RELAY_SHARED_SECRET: 'cloud-mail-cloud-mail-cloud-123456',
  DKIM_SELECTOR: selector,
  DNS_RECORDS_PATH: temporary,
  LONGOS_RELAY_SHARED_SECRET: 'longos-longos-longos-longos-123456',
  MAIL_DOMAINS: domain,
  MAIL_HOSTNAME: 'mailout.example.com',
  MAIL_PUBLIC_IPS: '8.8.8.8',
  NODE_ENV: 'test',
  RELAY_NO_LISTEN: 'true',
  RELAY_TEST_TRANSPORT: 'stream',
});

const relay = await import(`../src/server.mjs?identity=${Date.now()}`);
await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));

after(async () => {
  await new Promise(resolve => relay.server.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
});

test('returns only validated public mail-node identity material', () => {
  const identity = relay.identityPayload();

  assert.equal(identity.schema, 1);
  assert.equal(identity.hostname, 'mailout.example.com');
  assert.deepEqual(identity.publicIps, ['8.8.8.8']);
  assert.deepEqual(identity.signingDomains, [domain]);
  assert.deepEqual(identity.records, [{
    type: 'TXT',
    name: `${selector}._domainkey.${domain}`,
    value: 'v=DKIM1; h=sha256; k=rsa; p=UFVCTElDS0VZ',
  }]);
  assert.doesNotMatch(JSON.stringify(identity), /private|LONGOS_RELAY_SHARED_SECRET/);
});

test('requires a fresh HMAC signature for the identity endpoint', async () => {
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const unauthorized = await fetch(`${base}/v1/identity`);
  assert.equal(unauthorized.status, 401);

  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `identity-${Date.now()}`;
  const authorized = await fetch(`${base}/v1/identity`, {
    headers: {
      'x-relay-client': 'longos',
      'x-relay-timestamp': timestamp,
      'x-relay-nonce': nonce,
      'x-relay-signature': createSignature(process.env.LONGOS_RELAY_SHARED_SECRET, timestamp, nonce, ''),
    },
  });
  assert.equal(authorized.status, 200);
  assert.equal((await authorized.json()).status, 'ok');
});

test('rejects private, reserved, loopback and documentation addresses', () => {
  assert.equal(relay.isPublicIp('8.8.4.4'), true);
  for (const address of [
    '127.0.0.1',
    '10.0.0.2',
    '172.16.0.1',
    '192.168.1.1',
    '203.0.113.10',
    '0:0:0:0:0:0:0:1',
    '2001:db8::1',
    'ff02::1',
  ]) {
    assert.equal(relay.isPublicIp(address), false, address);
  }
});
