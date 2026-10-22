import assert from 'node:assert/strict';
import test from 'node:test';
import {classifyAuditResult, conciseAuditFailure} from './dependency-audit.mjs';

test('accepts a successful dependency audit', () => {
  assert.equal(classifyAuditResult({status: 0, stdout: '{"metadata":{"vulnerabilities":{}}}'}), 'passed');
});

test('never treats a vulnerability report as a transient network failure', () => {
  const stdout = JSON.stringify({
    metadata: {vulnerabilities: {moderate: 1, high: 0, critical: 0}},
    advisories: {one: {severity: 'moderate', title: 'timeout handling issue'}},
  });
  assert.equal(classifyAuditResult({status: 1, stdout}), 'vulnerabilities');
});

test('recognizes the pnpm registry timeout seen during local deployment', () => {
  const stderr = '[23] The operation was aborted due to timeout\nTimeoutError: The operation was aborted due to timeout';
  assert.equal(classifyAuditResult({status: 1, stderr}), 'transient-network');
  assert.match(conciseAuditFailure({stderr}), /timeout/i);
});

test('recognizes retryable registry transport and HTTP failures', () => {
  for (const stderr of ['request failed: EAI_AGAIN', 'fetch failed: ECONNRESET', 'HTTP 503']) {
    assert.equal(classifyAuditResult({status: 1, stderr}), 'transient-network');
  }
});

test('fails closed for an unknown audit error', () => {
  assert.equal(classifyAuditResult({status: 1, stderr: 'unexpected audit response'}), 'failure');
});
