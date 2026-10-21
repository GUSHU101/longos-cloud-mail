import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveManagedR2BucketName,
  selectCloudflareResource,
  waitForCloudflareResource,
} from './cloudflare-resource-state.mjs';

test('selects a named or explicitly pinned resource without guessing', () => {
  const rows = [{uuid: 'one', name: 'mail'}, {uuid: 'two', name: 'other'}];
  assert.equal(selectCloudflareResource(rows, {
    expectedName: 'mail', idField: 'uuid', nameField: 'name', label: 'D1',
  }).uuid, 'one');
  assert.equal(selectCloudflareResource(rows, {
    pinnedId: 'two', expectedName: 'other', idField: 'uuid', nameField: 'name', label: 'D1',
  }).uuid, 'two');
  assert.throws(() => selectCloudflareResource(rows, {
    pinnedId: 'one', expectedName: 'other', idField: 'uuid', nameField: 'name', label: 'D1',
  }), /指向的资源不一致/);
});

test('refuses ambiguous same-name resources', () => {
  assert.throws(() => selectCloudflareResource([
    {id: 'one', title: 'mail'},
    {id: 'two', title: 'mail'},
  ], {
    expectedName: 'mail', idField: 'id', nameField: 'title', label: 'KV',
  }), /多个名为 mail 的 KV/);
});

test('waits for newly created resources to become visible', async () => {
  let calls = 0;
  const delays = [];
  const resource = await waitForCloudflareResource({
    list: async () => (++calls < 3 ? [] : [{uuid: 'created', name: 'mail'}]),
    selection: {expectedName: 'mail', idField: 'uuid', nameField: 'name', label: 'D1'},
    attempts: 4,
    delayMs: 10,
    delay: async milliseconds => delays.push(milliseconds),
  });
  assert.equal(resource.uuid, 'created');
  assert.deepEqual(delays, [10, 10]);
});

test('fails with a resumable message when a created resource remains invisible', async () => {
  await assert.rejects(() => waitForCloudflareResource({
    list: async () => [],
    selection: {expectedName: 'mail', idField: 'id', nameField: 'title', label: 'KV'},
    attempts: 2,
    delay: async () => {},
  }), /直接重跑部署/);
});

test('derives a valid deterministic R2 bucket name in auto mode', () => {
  assert.equal(resolveManagedR2BucketName('auto', 'cloud_mail'), 'cloud-mail-attachments');
  assert.equal(resolveManagedR2BucketName('existing-bucket', 'ignored'), 'existing-bucket');
  assert.equal(resolveManagedR2BucketName('', 'ignored'), '');
  assert.ok(resolveManagedR2BucketName('auto', `a${'b'.repeat(62)}`).length <= 63);
});
