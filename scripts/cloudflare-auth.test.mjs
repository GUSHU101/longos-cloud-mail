import assert from 'node:assert/strict';
import test from 'node:test';
import {verifyCloudflareApiToken} from './cloudflare-auth.mjs';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('accepts only an active Cloudflare API token', async () => {
  let request;
  const result = await verifyCloudflareApiToken({
    token: 'scoped_api_token',
    fetchImpl: async (url, options) => {
      request = {url, options};
      return response(200, {
        success: true,
        result: {id: 'token-id', status: 'active', expires_on: '2027-01-01T00:00:00Z'},
      });
    },
  });

  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/user/tokens/verify');
  assert.equal(request.options.headers.authorization, 'Bearer scoped_api_token');
  assert.equal(result.status, 'active');
});

test('rejects a Global API Key or inactive token with actionable guidance', async () => {
  await assert.rejects(
    verifyCloudflareApiToken({
      token: 'legacy_global_key',
      fetchImpl: async () => response(403, {success: false, errors: [{message: 'Invalid request headers'}]}),
    }),
    /Global API Key 不受支持/,
  );
});

test('rejects whitespace and newline injection before making a request', async () => {
  let called = false;
  await assert.rejects(
    verifyCloudflareApiToken({
      token: 'token\nvalue',
      fetchImpl: async () => {
        called = true;
        return response(200, {});
      },
    }),
    /格式不正确/,
  );
  assert.equal(called, false);
});
