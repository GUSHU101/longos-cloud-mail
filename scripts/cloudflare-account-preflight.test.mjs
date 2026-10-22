import assert from 'node:assert/strict';
import test from 'node:test';
import {preflightCloudflareAccountResources} from './cloudflare-account-preflight.mjs';

const accountId = 'a'.repeat(32);
const json = (result, status = 200, errors = []) => new Response(JSON.stringify({
  success: status >= 200 && status < 300,
  result,
  errors,
}), {status, headers: {'content-type': 'application/json'}});

test('preflights Worker, D1, KV and optional R2 account APIs', async () => {
  const calls = [];
  const results = await preflightCloudflareAccountResources({
    token: 'token',
    accountId,
    includeR2: true,
    fetchImpl: async url => {
      calls.push(url);
      return json([]);
    },
  });

  assert.deepEqual(results.map(result => result.key), ['workers', 'd1', 'kv', 'r2']);
  assert.ok(calls.some(url => url.includes('/workers/scripts')));
  assert.ok(calls.some(url => url.includes('/d1/database')));
  assert.ok(calls.some(url => url.includes('/storage/kv/namespaces')));
  assert.ok(calls.some(url => url.includes('/r2/buckets')));
});

test('aggregates all missing account-level permissions without exposing the token', async () => {
  await assert.rejects(
    preflightCloudflareAccountResources({
      token: 'do-not-print-this-token',
      accountId,
      includeR2: true,
      fetchImpl: async url => {
        if (url.includes('/d1/database') || url.includes('/r2/buckets')) {
          return json(null, 403, [{code: 10000, message: 'Authentication error'}]);
        }
        return json([]);
      },
    }),
    error => {
      assert.match(error.message, /D1.*code 10000: Authentication error/);
      assert.match(error.message, /R2.*code 10000: Authentication error/);
      assert.match(error.message, /Account \/ D1 \/ Write/);
      assert.doesNotMatch(error.message, /do-not-print-this-token/);
      return true;
    },
  );
});

test('does not require R2 access when attachment storage is disabled', async () => {
  const calls = [];
  await preflightCloudflareAccountResources({
    token: 'token',
    accountId,
    includeR2: false,
    fetchImpl: async url => {
      calls.push(url);
      return json([]);
    },
  });
  assert.equal(calls.some(url => url.includes('/r2/buckets')), false);
});
