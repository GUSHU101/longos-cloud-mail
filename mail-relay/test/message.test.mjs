import assert from 'node:assert/strict';
import test from 'node:test';
import { createSignature } from '../src/security.mjs';

process.env.RELAY_SHARED_SECRET = '0123456789abcdef0123456789abcdef';
process.env.LONGOS_RELAY_SHARED_SECRET = 'longos-longos-longos-longos-123456';
process.env.CLOUD_MAIL_RELAY_SHARED_SECRET = 'cloud-mail-cloud-mail-cloud-123456';
process.env.ALLOWED_SENDER_DOMAINS = 'mail.example.com';
process.env.RELAY_NO_LISTEN = 'true';
process.env.NODE_ENV = 'test';
process.env.RELAY_TEST_TRANSPORT = 'stream';

const { normalizeAddress, normalizeMessage, server } = await import('../src/server.mjs');

let nonceSequence = 0;

async function signedSend(body) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `e2e-${Date.now()}-${nonceSequence += 1}`;
  return fetch(`http://127.0.0.1:${server.address().port}/v1/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-client': 'cloud-mail',
      'x-relay-timestamp': timestamp,
      'x-relay-nonce': nonce,
      'x-relay-signature': createSignature(process.env.CLOUD_MAIL_RELAY_SHARED_SECRET, timestamp, nonce, rawBody),
    },
    body: rawBody,
  });
}

test('normalizes safe mailbox syntax and rejects address-list injection', () => {
  assert.equal(normalizeAddress('sales+orders@MAIL.EXAMPLE.COM', 'sender'), 'sales+orders@mail.example.com');
  assert.throws(
    () => normalizeAddress('first@example.com,second@example.com', 'sender'),
    error => error.status === 400,
  );
  assert.throws(
    () => normalizeAddress('sender@-invalid.example', 'sender'),
    error => error.status === 400,
  );
  assert.throws(
    () => normalizeAddress('nul\0byte@mail.example.com', 'sender'),
    error => error.status === 400,
  );
});

test('normalizes all recipient classes and anchors rate limiting to the sender', () => {
  const result = normalizeMessage({
    requestId: 'cloud-mail:42',
    from: { address: 'sales@mail.example.com', name: 'Sales' },
    to: ['to@example.net'],
    cc: ['cc@example.net'],
    bcc: ['bcc@example.net', 'to@example.net'],
    subject: 'Hello',
    text: 'Body',
    senderContext: { source: 'cloud-mail', tenantId: '7', accountId: '9', category: 'compose' },
  });

  assert.deepEqual(result.mail.envelope.to, ['to@example.net', 'cc@example.net', 'bcc@example.net']);
  assert.equal(result.rateKey, 'cloud-mail:sales@mail.example.com');
  assert.equal(result.senderContext.accountId, '9');
});

test('rejects a sender outside the signing allowlist', () => {
  assert.throws(() => normalizeMessage({
    from: { address: 'sales@other.example' },
    to: ['to@example.net'],
    subject: 'Hello',
    text: 'Body',
  }), error => error.status === 403);
});

test('rejects malformed header and body value types as client errors', () => {
  const base = {
    from: { address: 'sales@mail.example.com' },
    to: ['to@example.net'],
    subject: 'Hello',
  };
  assert.throws(
    () => normalizeMessage({ ...base, text: 'Body', headers: null }),
    error => error.status === 400 && error.message === 'Headers must be an object',
  );
  assert.throws(
    () => normalizeMessage({ ...base, text: 42 }),
    error => error.status === 400 && error.message === 'Message text must be a string',
  );
  assert.throws(
    () => normalizeMessage({ ...base, subject: { unexpected: true }, text: 'Body' }),
    error => error.status === 400 && error.message === 'Invalid subject',
  );
  assert.throws(
    () => normalizeMessage({ ...base, text: 'Body', headers: { references: { unexpected: true } } }),
    error => error.status === 400 && error.message === 'Invalid references',
  );
  assert.throws(
    () => normalizeMessage({
      ...base,
      text: 'Body',
      attachments: [{ filename: { unexpected: true }, content: 'YQ==' }],
    }),
    error => error.status === 400 && error.message === 'Invalid filename',
  );
  assert.throws(
    () => normalizeMessage({
      ...base,
      text: 'Body',
      attachments: [{ filename: 'bad.txt', content: 'YQ===' }],
    }),
    error => error.status === 400 && /Invalid base64 attachment/.test(error.message),
  );
  assert.throws(
    () => normalizeMessage({
      ...base,
      text: 'Body',
      attachments: Array.from({ length: 26 }, (_, index) => ({
        filename: `empty-${index}.txt`,
        content: '',
      })),
    }),
    error => error.status === 400 && /Attachment count/.test(error.message),
  );
});

test('rejects a valid client signature with a mismatched sender context', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const body = JSON.stringify({
      requestId: 'mismatch:1',
      from: { address: 'sales@mail.example.com' },
      to: ['to@example.net'],
      subject: 'Hello',
      text: 'Body',
      senderContext: { source: 'longos', tenantId: '42' },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'client-mismatch-nonce';
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/send`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-relay-client': 'cloud-mail',
        'x-relay-timestamp': timestamp,
        'x-relay-nonce': nonce,
        'x-relay-signature': createSignature(process.env.CLOUD_MAIL_RELAY_SHARED_SECRET, timestamp, nonce, body),
      },
      body,
    });
    assert.equal(response.status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('queues a signed message idempotently and rejects request ID reuse', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const message = {
      requestId: 'cloud-mail:e2e:1',
      from: { address: 'sales@mail.example.com', name: 'Sales' },
      to: ['buyer@example.net'],
      subject: 'Order update',
      text: 'Your order has shipped.',
      senderContext: { source: 'cloud-mail', tenantId: '7', accountId: '9', category: 'compose' },
    };

    const firstResponse = await signedSend(message);
    const firstBody = await firstResponse.json();
    assert.equal(firstResponse.status, 202);
    assert.equal(firstBody.accepted, true);
    assert.equal(firstBody.queueId, message.requestId);

    const retryResponse = await signedSend(message);
    assert.equal(retryResponse.status, 202);
    assert.deepEqual(await retryResponse.json(), firstBody);

    const conflictResponse = await signedSend({ ...message, subject: 'Changed content' });
    assert.equal(conflictResponse.status, 409);
    assert.match((await conflictResponse.json()).message, /different content/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
