import assert from 'node:assert/strict';
import test from 'node:test';
import {mergeSpfPolicies, syncLongosOutboundDns} from './longos-dns-sync.mjs';

const cloudflareToken = 'cloudflare-token-value-1234567890';
const integrationToken = 'longos-token';

function cloudflareResponse(result, status = 200, errors = []) {
  return new Response(JSON.stringify({success: status >= 200 && status < 300, result, errors}), {status});
}

test('fetches a public manifest and keeps the Cloudflare token inside the deployment runner', async () => {
  const calls = [];
  const manifest = [{
    type: 'TXT', name: 'mail2026._domainkey.example.com', value: 'v=DKIM1; h=sha256; k=rsa; p=UFVCTElD', mode: 'managed', available: true,
  }, {
    type: 'TXT', name: 'example.com', value: 'v=spf1 a:mailout.example.com -all', mode: 'merged', available: true,
  }, {
    type: 'TXT', name: '_dmarc.example.com', value: 'v=DMARC1; p=none', mode: 'if_missing', available: true,
  }, {
    type: 'A', name: 'mailout.example.com', value: '203.0.113.10', mode: 'managed', available: true,
  }];

  const result = await syncLongosOutboundDns({
    relayUrl: 'https://admin.example.com/_longos/mail-relay/',
    integrationToken,
    cloudflareToken,
    accountId: 'a'.repeat(32),
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      if (url.startsWith('https://admin.example.com/')) {
        return new Response(JSON.stringify({status: 'ok', records: manifest}), {status: 200});
      }
      if (url.includes('/zones?')) return cloudflareResponse([{id: 'zone-1', name: 'example.com', account: {id: 'a'.repeat(32)}}]);
      if (url.includes('/dns_records?')) {
        const parsed = new URL(url);
        const name = parsed.searchParams.get('name');
        const type = parsed.searchParams.get('type');
        if (name === 'mail2026._domainkey.example.com') {
          return cloudflareResponse([{id: 'dkim', content: manifest[0].value, proxied: false}]);
        }
        if (name === 'example.com') {
          return cloudflareResponse([
            {id: 'spf-1', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all'},
            {id: 'spf-2', content: 'v=spf1 mx -all'},
          ]);
        }
        if (name === '_dmarc.example.com') return cloudflareResponse([{id: 'dmarc', content: 'v=DMARC1; p=reject'}]);
        if (name === 'mailout.example.com' && type === 'A') {
          return cloudflareResponse([{id: 'address', content: '203.0.113.10', proxied: true}]);
        }
      }
      return cloudflareResponse({id: 'changed'});
    },
  });

  const manifestCall = calls.find(call => call.url.startsWith('https://admin.example.com/'));
  assert.equal(manifestCall.url, 'https://admin.example.com/_longos/mail-relay/dns/manifest');
  assert.equal(manifestCall.options.method, 'GET');
  assert.equal(manifestCall.options.headers.authorization, `Bearer ${integrationToken}`);
  assert.doesNotMatch(JSON.stringify(manifestCall), new RegExp(cloudflareToken));
  assert.ok(calls.filter(call => call.url.startsWith('https://api.cloudflare.com/'))
    .every(call => call.options.headers.authorization === `Bearer ${cloudflareToken}`));
  assert.equal(result.configured, true, JSON.stringify(result));
  assert.deepEqual(result.sync.updated.sort(), ['A mailout.example.com', 'TXT example.com']);
  assert.deepEqual(result.sync.removed, ['TXT example.com']);
  assert.ok(result.sync.preserved.includes('TXT mail2026._domainkey.example.com'));
  assert.ok(result.sync.preserved.includes('TXT _dmarc.example.com'));
});

test('merges SPF without losing existing senders and refuses unsafe policies', () => {
  assert.equal(
    mergeSpfPolicies(['v=spf1 include:_spf.mx.cloudflare.net ~all', 'v=spf1 mx -all'], 'a:mailout.example.com', 'example.com'),
    'v=spf1 include:_spf.mx.cloudflare.net mx a:mailout.example.com ~all',
  );
  assert.throws(() => mergeSpfPolicies(['v=spf1 +all'], 'a:mailout.example.com', 'example.com'), /\+all/);
  assert.throws(() => mergeSpfPolicies(['v=spf1 redirect=_spf.example.com'], 'a:mailout.example.com', 'example.com'), /redirect=/);
});

test('rejects malformed manifest data before any Cloudflare request', async () => {
  let cloudflareCalled = false;
  const result = await syncLongosOutboundDns({
    relayUrl: 'https://admin.example.com/_longos/mail-relay',
    integrationToken,
    cloudflareToken,
    fetchImpl: async url => {
      if (url.startsWith('https://api.cloudflare.com/')) cloudflareCalled = true;
      return new Response(JSON.stringify({status: 'ok', records: [{
        type: 'TXT', name: 'example.com', value: 'v=spf1 +all', mode: 'merged', available: true,
      }]}), {status: 200});
    },
  });

  assert.equal(result.configured, false);
  assert.match(result.reason, /SPF 清单值无效/);
  assert.equal(cloudflareCalled, false);
});

test('treats an older LONGOS without the manifest endpoint as a non-fatal skip', async () => {
  const result = await syncLongosOutboundDns({
    relayUrl: 'https://admin.example.com/_longos/mail-relay',
    integrationToken,
    cloudflareToken,
    fetchImpl: async () => new Response('not found', {status: 404}),
  });

  assert.deepEqual(result, {configured: false, skipped: true, reason: 'HTTP 404'});
});

test('waits for a newly started relay to publish its DKIM public key', async () => {
  let requests = 0;
  let delays = 0;
  const records = [{
    type: 'TXT', name: 'mail2026._domainkey.example.com', value: 'v=DKIM1; p=UFVCTElD', mode: 'managed', available: true,
  }, {
    type: 'TXT', name: 'example.com', value: 'v=spf1 a:mailout.example.com -all', mode: 'merged', available: true,
  }, {
    type: 'TXT', name: '_dmarc.example.com', value: 'v=DMARC1; p=none', mode: 'if_missing', available: true,
  }];
  const result = await syncLongosOutboundDns({
    relayUrl: 'https://admin.example.com/_longos/mail-relay',
    integrationToken,
    cloudflareToken,
    delay: async milliseconds => {
      assert.equal(milliseconds, 5_000);
      delays += 1;
    },
    fetchImpl: async url => {
      if (url.startsWith('https://admin.example.com/')) {
        requests += 1;
        if (requests === 1) return new Response(JSON.stringify({status: 'pending', message: 'DKIM pending'}), {status: 503});
        return new Response(JSON.stringify({status: 'ok', records}), {status: 200});
      }
      if (url.includes('/zones?')) return cloudflareResponse([{id: 'zone-1', name: 'example.com'}]);
      if (url.includes('/dns_records?')) return cloudflareResponse([]);
      return cloudflareResponse({id: 'created'});
    },
  });

  assert.equal(requests, 2);
  assert.equal(delays, 1);
  assert.equal(result.configured, true);
});

test('skips when Cloud Mail is intentionally receive-only', async () => {
  const result = await syncLongosOutboundDns({relayUrl: '', integrationToken: '', cloudflareToken});
  assert.equal(result.skipped, true);
});
