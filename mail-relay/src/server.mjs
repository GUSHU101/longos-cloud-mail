import http from 'node:http';
import crypto from 'node:crypto';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { domainToASCII } from 'node:url';
import nodemailer from 'nodemailer';
import { verifySignedRequest } from './security.mjs';

const port = toPositiveInt(process.env.PORT, 3000);
const legacySharedSecret = process.env.RELAY_SHARED_SECRET || '';
const clientSecrets = new Map([
  ['longos', process.env.LONGOS_RELAY_SHARED_SECRET || legacySharedSecret],
  ['cloud-mail', process.env.CLOUD_MAIL_RELAY_SHARED_SECRET || legacySharedSecret],
].filter(([, secret]) => secret));
const maxRequestBytes = toPositiveInt(process.env.MAX_REQUEST_BYTES, 25 * 1024 * 1024);
const maxAttachmentBytes = toPositiveInt(process.env.MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024);
const maxRecipients = toPositiveInt(process.env.MAX_RECIPIENTS, 50);
const maxRequestsPerMinute = toPositiveInt(process.env.MAX_REQUESTS_PER_MINUTE, 120);
const maxRequestsPerMinuteGlobal = toPositiveInt(process.env.MAX_REQUESTS_PER_MINUTE_GLOBAL, maxRequestsPerMinute * 10);
const maxConcurrentSends = toPositiveInt(process.env.MAX_CONCURRENT_SENDS, 25);
const healthCacheTtlMs = toPositiveInt(process.env.HEALTH_CACHE_TTL_MS, 5_000);
const signatureWindowSeconds = toPositiveInt(process.env.SIGNATURE_WINDOW_SECONDS, 300);
const allowedSenderDomains = new Set(
  (process.env.ALLOWED_SENDER_DOMAINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(normalizeDomain),
);

if (clientSecrets.size === 0) {
  throw new Error('At least one relay client secret must be configured');
}
for (const [client, secret] of clientSecrets) {
  if (secret.length < 32) {
    throw new Error(`${client} relay secret must contain at least 32 characters`);
  }
}
if (allowedSenderDomains.size === 0) {
  throw new Error('ALLOWED_SENDER_DOMAINS must contain at least one domain');
}

const transporter = process.env.NODE_ENV === 'test' && process.env.RELAY_TEST_TRANSPORT === 'stream'
  ? nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
  : nodemailer.createTransport({
    sendmail: true,
    newline: 'unix',
    path: '/usr/sbin/sendmail',
  });
const execFileAsync = promisify(execFile);

const usedNonces = new Map();
const completedRequests = new Map();
const inFlightRequests = new Set();
const rateBuckets = new Map();
let globalRateBucket = { minute: -1, count: 0 };
let healthResult = { checkedAt: 0, healthy: false };
let healthCheckPromise;

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

async function checkPostfixHealth() {
  const now = Date.now();
  if (now - healthResult.checkedAt < healthCacheTtlMs) return healthResult.healthy;
  if (!healthCheckPromise) {
    healthCheckPromise = execFileAsync('postfix', ['status'], { timeout: 2_000 })
      .then(() => true)
      .catch(() => false)
      .then(healthy => {
        healthResult = { checkedAt: Date.now(), healthy };
        return healthy;
      })
      .finally(() => {
        healthCheckPromise = undefined;
      });
  }
  return healthCheckPromise;
}

function rateLimitExceeded(key) {
  const minute = Math.floor(Date.now() / 60_000);
  if (globalRateBucket.minute !== minute) globalRateBucket = { minute, count: 0 };
  globalRateBucket.count += 1;
  if (globalRateBucket.count > maxRequestsPerMinuteGlobal) return true;
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.minute !== minute) {
    rateBuckets.set(key, { minute, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > maxRequestsPerMinute;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      const error = new Error('Request body is too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function verifySignature(request, rawBody, secret) {
  return verifySignedRequest({
    secret,
    timestamp: request.headers['x-relay-timestamp'],
    nonce: request.headers['x-relay-nonce'],
    signature: request.headers['x-relay-signature'],
    rawBody,
    windowSeconds: signatureWindowSeconds,
    usedNonces,
  });
}

function cleanupReplayState() {
  const oldest = Date.now() - signatureWindowSeconds * 2 * 1000;
  for (const [key, createdAt] of usedNonces) {
    if (createdAt < oldest) usedNonces.delete(key);
  }
  for (const [key, item] of completedRequests) {
    if (item.createdAt < oldest) completedRequests.delete(key);
  }
  const currentMinute = Math.floor(Date.now() / 60_000);
  for (const [key, bucket] of rateBuckets) {
    if (bucket.minute < currentMinute - 1) rateBuckets.delete(key);
  }
}

function cleanHeader(value, field, maxLength = 998) {
  const normalized = String(value ?? '').trim();
  if (normalized.length > maxLength || /[\r\n]/.test(normalized)) {
    const error = new Error(`Invalid ${field}`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

function normalizeDomain(value) {
  const domain = domainToASCII(String(value ?? '').trim().toLowerCase());
  const labels = domain.split('.');
  if (
    !domain
    || domain.length > 253
    || labels.length < 2
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  ) {
    const error = new Error('Invalid email domain');
    error.status = 400;
    throw error;
  }
  return domain;
}

function normalizeAddress(value, field) {
  const address = cleanHeader(value, field, 320);
  const separator = address.lastIndexOf('@');
  const local = address.slice(0, separator);
  if (
    separator <= 0
    || local.length > 64
    || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)
    || local.startsWith('.')
    || local.endsWith('.')
    || local.includes('..')
  ) {
    const error = new Error(`Invalid ${field}`);
    error.status = 400;
    throw error;
  }
  return `${local}@${normalizeDomain(address.slice(separator + 1))}`;
}

function normalizeAddressList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    const error = new Error(`Invalid ${field} list`);
    error.status = 400;
    throw error;
  }
  return [...new Set(value.map(address => normalizeAddress(address, field)))];
}

function normalizeSenderContext(value) {
  if (value === undefined) return { source: 'unknown', tenantId: '', tenantCode: '', accountId: '', category: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('Invalid senderContext');
    error.status = 400;
    throw error;
  }
  const source = cleanHeader(value.source || 'unknown', 'senderContext.source', 32);
  if (!['longos', 'cloud-mail', 'unknown'].includes(source)) {
    const error = new Error('Invalid senderContext.source');
    error.status = 400;
    throw error;
  }
  return {
    source,
    tenantId: cleanHeader(value.tenantId || '', 'senderContext.tenantId', 128),
    tenantCode: cleanHeader(value.tenantCode || '', 'senderContext.tenantCode', 128),
    accountId: cleanHeader(value.accountId || '', 'senderContext.accountId', 128),
    category: cleanHeader(value.category || '', 'senderContext.category', 64),
  };
}

function normalizeMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('JSON object expected');
    error.status = 400;
    throw error;
  }

  const requestId = cleanHeader(body.requestId || crypto.randomUUID(), 'requestId', 128);
  if (!/^[a-zA-Z0-9._:-]+$/.test(requestId)) {
    const error = new Error('Invalid requestId');
    error.status = 400;
    throw error;
  }
  const fromAddress = normalizeAddress(body.from?.address, 'from address');
  const fromDomain = fromAddress.split('@')[1];
  if (!allowedSenderDomains.has(fromDomain)) {
    const error = new Error('Sender domain is not allowed');
    error.status = 403;
    throw error;
  }

  const to = normalizeAddressList(body.to, 'to recipient');
  const cc = normalizeAddressList(body.cc, 'cc recipient');
  const bcc = normalizeAddressList(body.bcc, 'bcc recipient');
  const allRecipients = [...new Set([...to, ...cc, ...bcc])];
  if (allRecipients.length === 0 || allRecipients.length > maxRecipients) {
    const error = new Error(`Recipient count must be between 1 and ${maxRecipients}`);
    error.status = 400;
    throw error;
  }

  const subject = cleanHeader(body.subject, 'subject');
  const fromName = cleanHeader(body.from?.name || '', 'from name', 200);
  if (body.headers !== undefined && (!body.headers || typeof body.headers !== 'object' || Array.isArray(body.headers))) {
    const error = new Error('Headers must be an object');
    error.status = 400;
    throw error;
  }
  const headers = {};
  for (const [name, value] of Object.entries(body.headers || {})) {
    const lowerName = name.toLowerCase();
    if (!['in-reply-to', 'references', 'reply-to'].includes(lowerName)) continue;
    headers[lowerName] = cleanHeader(value, lowerName);
  }

  if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
    const error = new Error('Attachments must be an array');
    error.status = 400;
    throw error;
  }

  let attachmentBytes = 0;
  const attachments = (body.attachments || []).map((attachment, index) => {
    if (!attachment || typeof attachment !== 'object' || typeof attachment.content !== 'string') {
      const error = new Error(`Invalid attachment at index ${index}`);
      error.status = 400;
      throw error;
    }
    const encodedContent = attachment.content.replace(/\s/g, '');
    if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(encodedContent) || encodedContent.length % 4 === 1) {
      const error = new Error(`Invalid base64 attachment at index ${index}`);
      error.status = 400;
      throw error;
    }
    const content = Buffer.from(encodedContent, 'base64');
    attachmentBytes += content.length;
    if (attachmentBytes > maxAttachmentBytes) {
      const error = new Error('Attachments are too large');
      error.status = 413;
      throw error;
    }
    return {
      filename: cleanHeader(basename(attachment.filename || `attachment-${index + 1}`), 'filename', 255),
      content,
      contentType: cleanHeader(attachment.contentType || 'application/octet-stream', 'content type', 200),
      cid: attachment.contentId ? cleanHeader(attachment.contentId, 'content id', 255) : undefined,
      contentDisposition: attachment.disposition === 'inline' ? 'inline' : 'attachment',
    };
  });

  const text = typeof body.text === 'string' ? body.text : undefined;
  const html = typeof body.html === 'string' ? body.html : undefined;
  if (!text && !html) {
    const error = new Error('Message text or HTML is required');
    error.status = 400;
    throw error;
  }

  const senderContext = normalizeSenderContext(body.senderContext);
  return {
    requestId,
    senderContext,
    // Context improves auditability, while the rate key remains anchored to
    // the sender address and cannot be bypassed by rotating a context id.
    rateKey: `${senderContext.source}:${fromAddress}`,
    mail: {
      from: { address: fromAddress, name: fromName },
      envelope: { from: fromAddress, to: allRecipients },
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      headers,
      attachments,
      messageId: `<${requestId}@${fromDomain}>`,
    },
  };
}

async function handleSend(request, response) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) {
    return json(response, 415, { accepted: false, message: 'Content-Type must be application/json' });
  }
  const rawBody = await readBody(request);
  const relayClient = cleanHeader(request.headers['x-relay-client'] || (legacySharedSecret ? 'legacy' : ''), 'relay client', 32);
  const secret = relayClient === 'legacy' ? legacySharedSecret : clientSecrets.get(relayClient);
  if (!secret) {
    return json(response, 401, { accepted: false, message: 'Unknown relay client' });
  }
  if (!verifySignature(request, rawBody, secret)) {
    return json(response, 401, { accepted: false, message: 'Invalid or expired signature' });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json(response, 400, { accepted: false, message: 'Invalid JSON' });
  }

  const { requestId, mail, senderContext, rateKey } = normalizeMessage(parsed);
  if (relayClient !== 'legacy' && senderContext.source !== relayClient) {
    return json(response, 403, { accepted: false, message: 'Relay client does not match sender context' });
  }
  const replayKey = `${relayClient}:${requestId}`;
  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const previous = completedRequests.get(replayKey);
  if (previous) {
    if (previous.payloadHash !== payloadHash) {
      return json(response, 409, { accepted: false, message: 'Request ID was already used for different content' });
    }
    return json(response, 202, previous.body);
  }

  if (inFlightRequests.has(replayKey)) {
    return json(response, 409, { accepted: false, message: 'Request is already being processed' });
  }
  if (inFlightRequests.size >= maxConcurrentSends) {
    return json(
      response,
      503,
      { accepted: false, message: 'Relay is at capacity; retry later' },
      { 'retry-after': '1' },
    );
  }
  if (rateLimitExceeded(rateKey)) {
    return json(response, 429, { accepted: false, message: 'Rate limit exceeded' });
  }

  inFlightRequests.add(replayKey);
  try {
    const info = await transporter.sendMail(mail);
    const result = {
      accepted: true,
      queueId: requestId,
      messageId: info.messageId || mail.messageId,
    };
    completedRequests.set(replayKey, {
      createdAt: Date.now(),
      payloadHash,
      body: result,
    });
    console.info(JSON.stringify({
      event: 'mail_queued',
      queueId: requestId,
      recipients: mail.envelope.to.length,
      source: senderContext.source,
      tenantCode: senderContext.tenantCode || undefined,
      accountId: senderContext.accountId || undefined,
      category: senderContext.category || undefined,
      senderDomain: mail.from.address.split('@')[1],
    }));
    return json(response, 202, result);
  } finally {
    inFlightRequests.delete(replayKey);
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      const healthy = await checkPostfixHealth();
      return json(response, healthy ? 200 : 503, {
        status: healthy ? 'ok' : 'degraded',
      });
    }
    if (request.method === 'POST' && request.url === '/v1/send') {
      return await handleSend(request, response);
    }
    return json(response, 404, { message: 'Not found' });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error(error);
    return json(response, status, {
      accepted: false,
      message: status >= 500 ? 'Relay submission failed' : error.message,
    });
  } finally {
    cleanupReplayState();
  }
});

server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxConnections = toPositiveInt(process.env.MAX_CONNECTIONS, 100);
server.maxRequestsPerSocket = toPositiveInt(process.env.MAX_REQUESTS_PER_SOCKET, 100);

if (process.env.RELAY_NO_LISTEN !== 'true') {
  server.listen(port, '0.0.0.0', () => {
    console.info(JSON.stringify({ event: 'relay_started', port, allowedSenderDomains: [...allowedSenderDomains] }));
  });
}

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { normalizeAddress, normalizeDomain, normalizeMessage, server };
