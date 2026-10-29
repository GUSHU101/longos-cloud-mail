import assert from 'node:assert/strict';
import test from 'node:test';
import {assertWorkerCustomDomainOwnership} from './cloudflare-worker-domain-state.mjs';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

test('accepts an unused custom domain and queries by exact hostname', async () => {
  let request;
  const result = await assertWorkerCustomDomainOwnership({
    token: 'secret-token',
    accountId: 'a'.repeat(32),
    hostname: 'mail.example.com',
    workerName: 'cloud-mail',
    fetchImpl: async (url, options) => {
      request = {url: String(url), options};
      return response({success: true, result: []});
    },
  });
  assert.equal(result.exists, false);
  assert.equal(new URL(request.url).searchParams.get('hostname'), 'mail.example.com');
  assert.equal(request.options.headers.authorization, 'Bearer secret-token');
});

test('accepts an existing domain only when it belongs to the requested worker', async () => {
  const result = await assertWorkerCustomDomainOwnership({
    token: 'secret-token',
    accountId: 'a'.repeat(32),
    hostname: 'mail.example.com',
    workerName: 'cloud-mail',
    fetchImpl: async () => response({
      success: true,
      result: [{hostname: 'mail.example.com', service: 'cloud-mail', enabled: true}],
    }),
  });
  assert.deepEqual(result, {exists: true, service: 'cloud-mail', enabled: true});
});

test('blocks a renamed worker before a second data plane can be created', async () => {
  await assert.rejects(
    assertWorkerCustomDomainOwnership({
      token: 'secret-token',
      accountId: 'a'.repeat(32),
      hostname: 'mail.example.com',
      workerName: 'longos-cloud-mail',
      fetchImpl: async () => response({
        success: true,
        result: [{hostname: 'mail.example.com', service: 'cloud-mail', enabled: true}],
      }),
    }),
    /升级保护.*cloud-mail.*longos-cloud-mail.*不要创建新 Worker、D1 或 KV/,
  );
});

test('fails closed when the domain inventory cannot be inspected', async () => {
  await assert.rejects(
    assertWorkerCustomDomainOwnership({
      token: 'secret-token',
      accountId: 'a'.repeat(32),
      hostname: 'mail.example.com',
      workerName: 'cloud-mail',
      fetchImpl: async () => response({success: false, errors: [{message: 'forbidden'}]}, 403),
    }),
    /预检失败.*forbidden/,
  );
});

