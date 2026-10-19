import crypto from 'node:crypto';

export function createSignature(secret, timestamp, nonce, rawBody) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${rawBody}`)
    .digest('hex');
}

export function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left || '') || !/^[a-f0-9]{64}$/i.test(right || '')) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function verifySignedRequest({
  secret,
  timestamp,
  nonce,
  signature,
  rawBody,
  windowSeconds,
  usedNonces,
  nonceScope = '',
  maxNonceRecords = 10_000,
  now = Date.now(),
}) {
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber) || Math.abs(now / 1000 - timestampNumber) > windowSeconds) {
    return false;
  }
  if (!nonce || typeof nonce !== 'string' || nonce.length > 128) {
    return false;
  }

  const nonceKey = `${nonceScope}:${nonce}`;
  const oldestAllowedNonce = now - windowSeconds * 1000;
  for (const [key, createdAt] of usedNonces) {
    if (createdAt < oldestAllowedNonce) usedNonces.delete(key);
  }
  if (usedNonces.has(nonceKey)) return false;

  const expected = createSignature(secret, timestamp, nonce, rawBody);
  if (!safeEqualHex(signature, expected)) {
    return false;
  }

  // Never evict a still-live nonce to make room: doing so would make an
  // already accepted signed request replayable. Authenticated malformed
  // traffic is bounded here before it can exhaust relay memory.
  const limit = Number.isSafeInteger(Number(maxNonceRecords)) && Number(maxNonceRecords) > 0
    ? Number(maxNonceRecords)
    : 10_000;
  if (usedNonces.size >= limit) return false;

  usedNonces.set(nonceKey, now);
  return true;
}
