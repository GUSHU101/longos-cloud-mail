import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectCloudflareR2Bucket,
  waitForCloudflareR2Bucket,
} from './cloudflare-r2-state.mjs';

const accountId = 'a'.repeat(32);
const json = (result, status = 200, errors = []) => new Response(JSON.stringify({
  success: status >= 200 && status < 300,
  result,
  errors,
}), {status, headers: {'content-type': 'application/json'}});

test('distinguishes an absent R2 bucket from an existing bucket', async () => {
  const missing = await inspectCloudflareR2Bucket({
    token: 'token', accountId, bucketName: 'attachments', fetchImpl: async () => json(null, 404),
  });
  assert.deepEqual(missing, {exists: false, bucket: null});

  const existing = await inspectCloudflareR2Bucket({
    token: 'token', accountId, bucketName: 'attachments',
    fetchImpl: async () => json({name: 'attachments', location: 'apac'}),
  });
  assert.equal(existing.exists, true);
  assert.equal(existing.bucket.name, 'attachments');
});

test('does not mistake permission or server failures for a missing R2 bucket', async () => {
  await assert.rejects(
    inspectCloudflareR2Bucket({
      token: 'token', accountId, bucketName: 'attachments',
      fetchImpl: async () => json(null, 403, [{code: 10000, message: 'authentication error'}]),
    }),
    /HTTP 403.*authentication error/,
  );
  await assert.rejects(
    inspectCloudflareR2Bucket({
      token: 'token', accountId, bucketName: 'attachments',
      fetchImpl: async () => json(null, 503, [{message: 'temporarily unavailable'}]),
    }),
    /HTTP 503.*temporarily unavailable/,
  );
});

test('reports R2 network failures without exposing the token', async () => {
  await assert.rejects(
    inspectCloudflareR2Bucket({
      token: 'secret-token', accountId, bucketName: 'attachments',
      fetchImpl: async () => { throw new Error('connection reset'); },
    }),
    error => {
      assert.match(error.message, /连接失败.*connection reset/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );
});

test('waits only while a newly created R2 bucket is absent', async () => {
  let calls = 0;
  const delays = [];
  const bucket = await waitForCloudflareR2Bucket({
    bucketName: 'attachments',
    inspect: async () => (++calls < 3
      ? {exists: false, bucket: null}
      : {exists: true, bucket: {name: 'attachments'}}),
    attempts: 4,
    delayMs: 10,
    delay: async milliseconds => delays.push(milliseconds),
  });
  assert.equal(bucket.name, 'attachments');
  assert.deepEqual(delays, [10, 10]);
});

test('fails with a resumable message when a created R2 bucket stays invisible', async () => {
  await assert.rejects(
    waitForCloudflareR2Bucket({
      bucketName: 'attachments',
      inspect: async () => ({exists: false, bucket: null}),
      attempts: 2,
      delay: async () => {},
    }),
    /直接重跑部署/,
  );
});
