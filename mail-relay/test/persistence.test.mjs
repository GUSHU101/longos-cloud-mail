import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('persists pending, accepted, and released delivery journal states', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-mail-relay-'));
  const store = join(directory, 'receipts.jsonl');
  process.env.RELAY_SHARED_SECRET = '0123456789abcdef0123456789abcdef';
  process.env.ALLOWED_SENDER_DOMAINS = 'mail.example.com';
  process.env.RELAY_NO_LISTEN = 'true';
  process.env.NODE_ENV = 'test';
  process.env.RELAY_TEST_TRANSPORT = 'stream';
  process.env.IDEMPOTENCY_STORE_PATH = store;
  process.env.MAX_IDEMPOTENCY_RECORDS = '1';

  try {
    const {
      rememberCompletedRequest,
      rememberPendingRequest,
      receiptCapacityAvailable,
      receiptRecordCount,
      releasePendingRequest,
      uncertainRequests,
    } = await import(`../src/server.mjs?persistence=${Date.now()}`);
    const requestHash = 'a'.repeat(64);
    rememberPendingRequest('cloud-mail:request-1', requestHash);
    assert.equal(uncertainRequests.has('cloud-mail:request-1'), true);
    rememberCompletedRequest('cloud-mail:request-1', {
      accepted: true,
      queueId: 'request-1',
      messageId: '<request-1@mail.example.com>',
    }, requestHash);
    assert.equal(uncertainRequests.has('cloud-mail:request-1'), false);
    assert.equal(receiptRecordCount(), 1);
    assert.equal(receiptCapacityAvailable(), false);

    rememberPendingRequest('cloud-mail:request-2', 'b'.repeat(64));
    releasePendingRequest('cloud-mail:request-2', 'b'.repeat(64));
    assert.equal(uncertainRequests.has('cloud-mail:request-2'), false);

    const rows = readFileSync(store, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.some(row => row.key === 'cloud-mail:request-1' && row.state === 'pending'), true);
    assert.equal(rows.some(row => row.key === 'cloud-mail:request-1' && row.state === 'accepted' && row.body.accepted), true);
    assert.equal(rows.at(-1).key, 'cloud-mail:request-2');
    assert.equal(rows.at(-1).state, 'released');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    delete process.env.IDEMPOTENCY_STORE_PATH;
    delete process.env.MAX_IDEMPOTENCY_RECORDS;
  }
});
