import assert from 'node:assert/strict';
import test from 'node:test';

process.env.RELAY_SHARED_SECRET = '0123456789abcdef0123456789abcdef';
process.env.ALLOWED_SENDER_DOMAINS = 'mail.example.com';
process.env.RELAY_NO_LISTEN = 'true';
process.env.NODE_ENV = 'test';
process.env.RELAY_TEST_TRANSPORT = 'stream';

const { normalizeMessage } = await import(`../src/server.mjs?transactional=${Date.now()}`);

test('accepts LONGOS order notifications with tenant sender context', () => {
  const result = normalizeMessage({
    requestId: 'order:1001:customer:8f83b76b',
    from: { address: 'orders+shop-a@mail.example.com', name: 'Shop A' },
    to: ['buyer@example.net'],
    subject: 'Order 1001 confirmed',
    text: 'Thank you for your order.',
    html: '<p>Thank you for your order.</p>',
    headers: { 'reply-to': 'support@example.net' },
    senderContext: {
      source: 'longos',
      tenantId: '7',
      tenantCode: 'shop-a',
      category: 'orders',
    },
  });

  assert.equal(result.requestId, 'order:1001:customer:8f83b76b');
  assert.equal(result.senderContext.source, 'longos');
  assert.equal(result.senderContext.category, 'orders');
  assert.equal(result.rateKey, 'longos:orders+shop-a@mail.example.com');
  assert.deepEqual(result.mail.envelope.to, ['buyer@example.net']);
});

test('accepts discounted abandoned-order recovery as marketing mail', () => {
  const result = normalizeMessage({
    requestId: 'recovery:1002:550e8400-e29b-41d4-a716-446655440000',
    from: { address: 'marketing+shop-a@mail.example.com', name: 'Shop A' },
    to: ['buyer@example.net'],
    subject: 'Complete your order',
    html: '<p>Use SAVE10 to complete your order.</p>',
    senderContext: {
      source: 'longos',
      tenantId: '7',
      tenantCode: 'shop-a',
      category: 'marketing',
    },
  });

  assert.equal(result.senderContext.category, 'marketing');
  assert.equal(result.mail.from.address, 'marketing+shop-a@mail.example.com');
  assert.match(result.mail.messageId, /^<recovery:1002:/);
});
