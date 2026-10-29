import assert from 'node:assert/strict';
import test from 'node:test';
import {buildCloudflareSupportReport} from './cloudflare-support-report.mjs';

test('creates an actionable report without copying deployment output or secrets', () => {
  const secret = 'super-sensitive-token-value';
  const report = buildCloudflareSupportReport({
    result: {
      status: 1,
      attempts: 4,
      stdout: '',
      stderr: `POST /accounts/${'a'.repeat(32)}/workers/scripts/cloud-mail/assets-upload-session\nInternal Server Error 500 [code: 10013]\nAuthorization: Bearer ${secret}\nLogs were written to "C:\\logs\\wrangler.log"`,
    },
    workerName: 'cloud-mail',
    accountId: 'a'.repeat(32),
    wranglerVersion: '4.154.0',
    assets: {fileCount: 243, totalBytes: 6_000_000, largestFile: {path: '/app.js', size: 10}, manifestSha256: 'b'.repeat(64)},
  });
  const serialized = JSON.stringify(report);
  assert.equal(report.failure.httpStatus, '500');
  assert.equal(report.failure.errorCode, '10013');
  assert.equal(report.failure.attempts, 4);
  assert.equal(report.failure.existingDeploymentChanged, false);
  assert.equal(report.assets.fileCount, 243);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /Authorization|Bearer/);
});
