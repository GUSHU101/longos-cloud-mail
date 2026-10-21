import assert from 'node:assert/strict';
import test from 'node:test';
import {preflightCloudflareZones} from './cloudflare-preflight.mjs';

const accountId = 'a'.repeat(32);
const json = (result, status = 200, errors = []) => new Response(JSON.stringify({
  success: status >= 200 && status < 300,
  result,
  errors,
}), {status, headers: {'content-type': 'application/json'}});

test('preflights the custom-domain parent zone and each inbound routing zone', async () => {
  const calls = [];
  const result = await preflightCloudflareZones({
    token: 'token',
    accountId,
    customDomain: 'mail.example.com',
    mailDomains: ['example.com'],
    fetchImpl: async url => {
      calls.push(url);
      if (url.includes('/email/routing')) return json({enabled: false, status: 'unconfigured'});
      const name = new URL(url).searchParams.get('name');
      if (name === 'mail.example.com') return json([]);
      return json([{id: 'zone-id', name: 'example.com', account: {id: accountId}}]);
    },
  });

  assert.equal(result.customZone.name, 'example.com');
  assert.deepEqual(result.routing.map(item => [item.domain, item.enabled]), [['example.com', false]]);
  assert.ok(calls.some(url => url.includes('/email/routing')));
});

test('stops before mutation when an inbound zone is outside the token scope', async () => {
  await assert.rejects(
    preflightCloudflareZones({
      token: 'token',
      accountId,
      mailDomains: ['example.com'],
      fetchImpl: async () => json([], 200),
    }),
    /无法读取活动 Zone example\.com/,
  );
});

test('reports missing Email Routing permission before deployment', async () => {
  await assert.rejects(
    preflightCloudflareZones({
      token: 'token',
      accountId,
      mailDomains: ['example.com'],
      fetchImpl: async url => url.includes('/email/routing')
        ? json(null, 403, [{message: 'permission denied'}])
        : json([{id: 'zone-id', name: 'example.com', account: {id: accountId}}]),
    }),
    /permission denied/,
  );
});
