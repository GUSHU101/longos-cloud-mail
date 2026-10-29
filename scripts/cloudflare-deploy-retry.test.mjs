import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deployWithCloudflareRetry,
  isRetryableCloudflareAssetsFailure,
} from './cloudflare-deploy-retry.mjs';

const assetsFailure = {
  status: 1,
  stdout: '',
  stderr: 'POST /workers/scripts/cloud-mail/assets-upload-session failed: Internal Server Error 500 [code: 10013]',
};

test('recognizes Cloudflare Workers Assets 5xx and 10013 as retryable', () => {
  assert.equal(isRetryableCloudflareAssetsFailure(assetsFailure), true);
  assert.equal(isRetryableCloudflareAssetsFailure({
    status: 1,
    stderr: '/assets-upload-session: TypeError: fetch failed ECONNRESET',
  }), true);
});

test('does not retry authentication, validation, or unrelated deployment failures', () => {
  assert.equal(isRetryableCloudflareAssetsFailure({status: 1, stderr: 'Authentication error 10000'}), false);
  assert.equal(isRetryableCloudflareAssetsFailure({status: 1, stderr: 'Worker validation error 10021'}), false);
  assert.equal(isRetryableCloudflareAssetsFailure({status: 1, stderr: 'Internal Server Error 500'}), false);
  assert.equal(isRetryableCloudflareAssetsFailure({status: 0, stderr: assetsFailure.stderr}), false);
});

test('retries transient asset failures with bounded backoff and preserves success result', async () => {
  const delays = [];
  const notices = [];
  let attempts = 0;
  const result = await deployWithCloudflareRetry(async () => {
    attempts += 1;
    return attempts < 3 ? assetsFailure : {status: 0, stdout: 'deployed', stderr: ''};
  }, {
    delaysMs: [5, 15, 30],
    sleep: async delayMs => delays.push(delayMs),
    onRetry: notice => notices.push(notice),
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5, 15]);
  assert.equal(notices.length, 2);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'deployed');
  assert.equal(result.attempts, 3);
});

test('stops immediately for permanent failures and caps repeated transient failures', async () => {
  let permanentAttempts = 0;
  const permanent = await deployWithCloudflareRetry(async () => {
    permanentAttempts += 1;
    return {status: 1, stderr: 'Authentication error'};
  }, {delaysMs: [0, 0], sleep: async () => {}});
  assert.equal(permanentAttempts, 1);
  assert.equal(permanent.attempts, 1);

  let transientAttempts = 0;
  const transient = await deployWithCloudflareRetry(async () => {
    transientAttempts += 1;
    return assetsFailure;
  }, {delaysMs: [0, 0], sleep: async () => {}});
  assert.equal(transientAttempts, 3);
  assert.equal(transient.attempts, 3);
  assert.equal(transient.status, 1);
});
