import http from 'node:http';
import crypto from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { BlockList, isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { domainToASCII } from 'node:url';
import { promisify } from 'node:util';
import nodemailer from 'nodemailer';
import { verifySignedRequest } from './security.mjs';

const nonPublicIpRanges = new BlockList();
for (const [network, prefix, type] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
]) nonPublicIpRanges.addSubnet(network, prefix, type);

const port = toPositiveInt(process.env.PORT, 3000);
const legacySharedSecret = process.env.RELAY_SHARED_SECRET || '';
const clientSecrets = new Map([
  ['longos', process.env.LONGOS_RELAY_SHARED_SECRET || legacySharedSecret],
  ['cloud-mail', process.env.CLOUD_MAIL_RELAY_SHARED_SECRET || legacySharedSecret],
].filter(([, secret]) => secret));
const maxRequestBytes = toPositiveInt(process.env.MAX_REQUEST_BYTES, 25 * 1024 * 1024);
const maxAttachmentBytes = toPositiveInt(process.env.MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024);
const maxAttachments = toPositiveInt(process.env.MAX_ATTACHMENTS, 25);
const maxRecipients = toPositiveInt(process.env.MAX_RECIPIENTS, 50);
const maxRequestsPerMinute = toPositiveInt(process.env.MAX_REQUESTS_PER_MINUTE, 120);
const maxRequestsPerMinuteGlobal = toPositiveInt(process.env.MAX_REQUESTS_PER_MINUTE_GLOBAL, maxRequestsPerMinute * 10);
const maxIncomingRequestsPerMinute = toPositiveInt(
  process.env.MAX_INCOMING_REQUESTS_PER_MINUTE,
  maxRequestsPerMinuteGlobal * 2,
);
const maxConcurrentSends = toPositiveInt(process.env.MAX_CONCURRENT_SENDS, 25);
const signatureWindowSeconds = toPositiveInt(process.env.SIGNATURE_WINDOW_SECONDS, 300);
const maxNonceRecords = toPositiveInt(process.env.MAX_NONCE_RECORDS, Math.max(10_000, maxRequestsPerMinuteGlobal * 10));
const idempotencyRetentionSeconds = toPositiveInt(
  process.env.IDEMPOTENCY_RETENTION_SECONDS,
  Math.max(86_400, signatureWindowSeconds * 2),
);
const maxIdempotencyRecords = toPositiveInt(process.env.MAX_IDEMPOTENCY_RECORDS, 100_000);
const maxQueueMessages = toPositiveInt(process.env.MAX_QUEUE_MESSAGES, 1000);
const idempotencyStorePath = String(process.env.IDEMPOTENCY_STORE_PATH || '').trim();
const allowedSenderDomains = new Set(
  (process.env.ALLOWED_SENDER_DOMAINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(normalizeDomain),
);
const signingDomains = new Set(
  (process.env.MAIL_DOMAINS || process.env.ALLOWED_SENDER_DOMAINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(normalizeDomain),
);
const mailHostname = normalizeDomain(
  process.env.MAIL_HOSTNAME || `mailout.${[...allowedSenderDomains][0] || 'example.com'}`,
);
const dkimSelector = String(process.env.DKIM_SELECTOR || 'mail2026').trim().toLowerCase();
const dnsRecordsPath = String(process.env.DNS_RECORDS_PATH || '/var/lib/cloud-mail-relay-dns').trim();
const configuredPublicIpValues = String(process.env.MAIL_PUBLIC_IPS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const publicIps = [...new Set(configuredPublicIpValues.filter(isPublicIp))];

if (clientSecrets.size === 0) {
  throw new Error('At least one relay client secret must be configured');
}
for (const [client, secret] of clientSecrets) {
  if (secret.length < 32) {
    throw new Error(`${client} relay secret must contain at least 32 characters`);
  }
}
if (
  process.env.LONGOS_RELAY_SHARED_SECRET
  && process.env.CLOUD_MAIL_RELAY_SHARED_SECRET
  && process.env.LONGOS_RELAY_SHARED_SECRET === process.env.CLOUD_MAIL_RELAY_SHARED_SECRET
) {
  throw new Error('LONGOS and Cloud Mail relay secrets must be different');
}
if (allowedSenderDomains.size === 0) {
  throw new Error('ALLOWED_SENDER_DOMAINS must contain at least one domain');
}
if (signingDomains.size === 0 || [...allowedSenderDomains].some(domain => !signingDomains.has(domain))) {
  throw new Error('MAIL_DOMAINS must contain every allowed sender domain');
}
if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(dkimSelector)) {
  throw new Error('DKIM_SELECTOR must be a valid selector');
}
if (!isAbsolute(dnsRecordsPath)) {
  throw new Error('DNS_RECORDS_PATH must be an absolute path');
}
if (configuredPublicIpValues.length !== publicIps.length) {
  throw new Error('MAIL_PUBLIC_IPS must contain only unique globally routable IP addresses');
}
if (!idempotencyStorePath && process.env.NODE_ENV !== 'test') {
  throw new Error('IDEMPOTENCY_STORE_PATH is required for restart-safe delivery');
}

const transporter = process.env.NODE_ENV === 'test' && process.env.RELAY_TEST_TRANSPORT === 'stream'
  ? nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
  : nodemailer.createTransport({
    sendmail: true,
    newline: 'unix',
    path: '/usr/sbin/sendmail',
  });
const usedNonces = new Map();
const completedRequests = new Map();
const uncertainRequests = new Map();
const inFlightRequests = new Map();
const rateBuckets = new Map();
let globalRateBucket = { minute: -1, count: 0 };
let incomingRateBucket = { minute: -1, count: 0 };
let receiptStoreHealthy = true;
let lastReceiptCompaction = 0;
let lastHealthCheck = 0;
let cachedHealth = { healthy: false, queueDepth: maxQueueMessages + 1 };
let healthCheckPromise = null;
const execFileAsync = promisify(execFile);

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isPublicIp(value) {
  const version = isIP(value);
  if (version === 6 && String(value).toLowerCase().includes('::ffff:')) return false;
  return version !== 0 && !nonPublicIpRanges.check(value, version === 4 ? 'ipv4' : 'ipv6');
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

function receiptRecordCount() {
  return completedRequests.size + uncertainRequests.size;
}

function receiptCapacityAvailable() {
  return receiptRecordCount() < maxIdempotencyRecords;
}

function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch {
    // Some filesystems do not support directory fsync. The journal file is
    // still fsynced before every atomic rename.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function appendReceiptRecord(record) {
  if (!idempotencyStorePath) return;
  mkdirSync(dirname(idempotencyStorePath), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = openSync(idempotencyStorePath, 'a', 0o600);
    writeSync(descriptor, `${JSON.stringify(record)}\n`, null, 'utf8');
    fsyncSync(descriptor);
    receiptStoreHealthy = true;
  } catch (error) {
    receiptStoreHealthy = false;
    throw new Error('Unable to persist the relay idempotency journal', { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function compactReceiptStore(force = false) {
  if (!idempotencyStorePath || (!force && Date.now() - lastReceiptCompaction < 3_600_000)) return;
  const temporaryPath = `${idempotencyStorePath}.${process.pid}.tmp`;
  const records = [
    ...[...completedRequests].map(([key, item]) => ({ key, state: 'accepted', ...item })),
    ...[...uncertainRequests].map(([key, item]) => ({ key, state: 'pending', ...item })),
  ].sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
  const lines = records.map(item => JSON.stringify(item));
  try {
    let descriptor;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeSync(descriptor, lines.length ? `${lines.join('\n')}\n` : '', null, 'utf8');
      fsyncSync(descriptor);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    renameSync(temporaryPath, idempotencyStorePath);
    fsyncDirectory(dirname(idempotencyStorePath));
    lastReceiptCompaction = Date.now();
    receiptStoreHealthy = true;
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch {}
    receiptStoreHealthy = false;
    console.error('Unable to compact the relay idempotency store', error);
  }
}

function rememberPendingRequest(key, requestHash = '') {
  const item = { createdAt: Date.now(), requestHash };
  appendReceiptRecord({ key, state: 'pending', ...item });
  completedRequests.delete(key);
  uncertainRequests.delete(key);
  uncertainRequests.set(key, item);
}

function rememberCompletedRequest(key, body, requestHash = '') {
  const item = { createdAt: Date.now(), body, requestHash };
  appendReceiptRecord({ key, state: 'accepted', ...item });
  completedRequests.delete(key);
  completedRequests.set(key, item);
  uncertainRequests.delete(key);
}

function releasePendingRequest(key, requestHash = '') {
  appendReceiptRecord({ key, state: 'released', createdAt: Date.now(), requestHash });
  uncertainRequests.delete(key);
}

function initializeReceiptStore() {
  if (!idempotencyStorePath) return;
  try {
    mkdirSync(dirname(idempotencyStorePath), { recursive: true, mode: 0o700 });
    if (existsSync(idempotencyStorePath)) {
      const oldest = Date.now() - idempotencyRetentionSeconds * 1000;
      for (const line of readFileSync(idempotencyStorePath, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const item = JSON.parse(line);
          if (typeof item.key !== 'string' || Number(item.createdAt) < oldest) continue;
          const requestHash = /^[a-f0-9]{64}$/.test(item.requestHash || item.payloadHash || '')
            ? (item.requestHash || item.payloadHash)
            : '';
          const state = item.state || (item.body?.accepted === true ? 'accepted' : '');
          completedRequests.delete(item.key);
          uncertainRequests.delete(item.key);
          if (state === 'accepted' && item.body?.accepted === true) {
            completedRequests.set(item.key, {
              createdAt: Number(item.createdAt),
              body: item.body,
              requestHash,
            });
          } else if (state === 'pending') {
            uncertainRequests.set(item.key, {
              createdAt: Number(item.createdAt),
              requestHash,
            });
          }
        } catch {
          // A hard stop can leave a partial final line. Earlier durable
          // records remain valid and the next compaction removes the fragment.
        }
      }
    }
    if (receiptRecordCount() > maxIdempotencyRecords) {
      throw new Error(
        `Relay idempotency journal contains ${receiptRecordCount()} live records, exceeding MAX_IDEMPOTENCY_RECORDS=${maxIdempotencyRecords}`,
      );
    }
    compactReceiptStore(true);
  } catch (error) {
    throw new Error('Unable to initialize the relay idempotency store', { cause: error });
  }
}

initializeReceiptStore();

function globalRateLimitExceeded() {
  const minute = Math.floor(Date.now() / 60_000);
  if (globalRateBucket.minute !== minute) globalRateBucket = { minute, count: 0 };
  globalRateBucket.count += 1;
  return globalRateBucket.count > maxRequestsPerMinuteGlobal;
}

function incomingRateLimitExceeded() {
  const minute = Math.floor(Date.now() / 60_000);
  if (incomingRateBucket.minute !== minute) incomingRateBucket = { minute, count: 0 };
  incomingRateBucket.count += 1;
  return incomingRateBucket.count > maxIncomingRequestsPerMinute;
}

function senderRateLimitExceeded(key) {
  const minute = Math.floor(Date.now() / 60_000);
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

function verifySignature(request, rawBody, secret, relayClient) {
  return verifySignedRequest({
    secret,
    timestamp: request.headers['x-relay-timestamp'],
    nonce: request.headers['x-relay-nonce'],
    signature: request.headers['x-relay-signature'],
    rawBody,
    windowSeconds: signatureWindowSeconds,
    usedNonces,
    nonceScope: relayClient,
    maxNonceRecords,
  });
}

function cleanupReplayState() {
  const nonceOldest = Date.now() - signatureWindowSeconds * 2 * 1000;
  const receiptOldest = Date.now() - idempotencyRetentionSeconds * 1000;
  for (const [key, createdAt] of usedNonces) {
    if (createdAt < nonceOldest) usedNonces.delete(key);
  }
  for (const [key, item] of completedRequests) {
    if (item.createdAt < receiptOldest) completedRequests.delete(key);
  }
  for (const [key, item] of uncertainRequests) {
    if (item.createdAt < receiptOldest) uncertainRequests.delete(key);
  }
  const currentMinute = Math.floor(Date.now() / 60_000);
  for (const [key, bucket] of rateBuckets) {
    if (bucket.minute < currentMinute - 1) rateBuckets.delete(key);
  }
  compactReceiptStore();
}

function cleanHeader(value, field, maxLength = 998) {
  if (typeof value !== 'string') {
    const error = new Error(`Invalid ${field}`);
    error.status = 400;
    throw error;
  }
  const normalized = value.trim();
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
  const source = cleanHeader(value.source ?? 'unknown', 'senderContext.source', 32);
  if (!['longos', 'cloud-mail', 'unknown'].includes(source)) {
    const error = new Error('Invalid senderContext.source');
    error.status = 400;
    throw error;
  }
  return {
    source,
    tenantId: cleanHeader(value.tenantId ?? '', 'senderContext.tenantId', 128),
    tenantCode: cleanHeader(value.tenantCode ?? '', 'senderContext.tenantCode', 128),
    accountId: cleanHeader(value.accountId ?? '', 'senderContext.accountId', 128),
    category: cleanHeader(value.category ?? '', 'senderContext.category', 64),
  };
}

function normalizeMessage(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('JSON object expected');
    error.status = 400;
    throw error;
  }

  const requestId = cleanHeader(body.requestId === undefined ? crypto.randomUUID() : body.requestId, 'requestId', 128);
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
  const fromName = cleanHeader(body.from?.name ?? '', 'from name', 200);
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
  if ((body.attachments || []).length > maxAttachments) {
    const error = new Error(`Attachment count must not exceed ${maxAttachments}`);
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
    if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(encodedContent) || encodedContent.length % 4 !== 0) {
      const error = new Error(`Invalid base64 attachment at index ${index}`);
      error.status = 400;
      throw error;
    }
    const padding = encodedContent.endsWith('==') ? 2 : encodedContent.endsWith('=') ? 1 : 0;
    const decodedBytes = encodedContent.length / 4 * 3 - padding;
    if (attachmentBytes + decodedBytes > maxAttachmentBytes) {
      const error = new Error('Attachments are too large');
      error.status = 413;
      throw error;
    }
    const content = Buffer.from(encodedContent, 'base64');
    if (content.toString('base64') !== encodedContent) {
      const error = new Error(`Invalid base64 attachment at index ${index}`);
      error.status = 400;
      throw error;
    }
    attachmentBytes += content.length;
    if (attachmentBytes > maxAttachmentBytes) {
      const error = new Error('Attachments are too large');
      error.status = 413;
      throw error;
    }
    return {
      filename: basename(cleanHeader(attachment.filename ?? `attachment-${index + 1}`, 'filename', 255)),
      content,
      contentType: cleanHeader(attachment.contentType ?? 'application/octet-stream', 'content type', 200),
      cid: attachment.contentId ? cleanHeader(attachment.contentId, 'content id', 255) : undefined,
      contentDisposition: attachment.disposition === 'inline' ? 'inline' : 'attachment',
    };
  });

  if (body.text !== undefined && typeof body.text !== 'string') {
    const error = new Error('Message text must be a string');
    error.status = 400;
    throw error;
  }
  if (body.html !== undefined && typeof body.html !== 'string') {
    const error = new Error('Message HTML must be a string');
    error.status = 400;
    throw error;
  }
  const text = body.text || undefined;
  const html = body.html || undefined;
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

function authenticateSignedRequest(request, rawBody = '') {
  const relayClient = cleanHeader(
    request.headers['x-relay-client'] || (legacySharedSecret ? 'legacy' : ''),
    'relay client',
    32,
  );
  const secret = relayClient === 'legacy' ? legacySharedSecret : clientSecrets.get(relayClient);
  if (!secret || !verifySignature(request, rawBody, secret, relayClient)) return null;
  return relayClient;
}

function identityPayload() {
  const root = resolve(dnsRecordsPath);
  const records = [];
  for (const domain of signingDomains) {
    const path = resolve(join(root, domain, `${dkimSelector}.txt`));
    const relativePath = relative(root, path);
    if (relativePath.startsWith('..') || relativePath === '' || !existsSync(path)) {
      throw Object.assign(new Error(`DKIM public key is not ready for ${domain}`), { status: 503 });
    }
    const value = readFileSync(path, 'utf8').trim();
    if (value.length > 4096 || /[\r\n]/.test(value)
      || !/^v=DKIM1;.*(?:^|;\s*)p=[A-Za-z0-9+/=]+/i.test(value)) {
      throw Object.assign(new Error(`Invalid DKIM public key for ${domain}`), { status: 503 });
    }
    records.push({ type: 'TXT', name: `${dkimSelector}._domainkey.${domain}`, value });
  }

  return {
    schema: 1,
    status: 'ok',
    hostname: mailHostname,
    publicIps,
    dkimSelector,
    signingDomains: [...signingDomains],
    records,
  };
}

function handleIdentity(request, response) {
  if (incomingRateLimitExceeded()) {
    return json(response, 429, { status: 'error', message: 'Incoming request limit exceeded' }, { 'retry-after': '60' });
  }
  if (!authenticateSignedRequest(request, '')) {
    return json(response, 401, { status: 'error', message: 'Invalid or expired signature' });
  }
  return json(response, 200, identityPayload());
}

async function handleSend(request, response) {
  if (incomingRateLimitExceeded()) {
    return json(response, 429, { accepted: false, message: 'Incoming request limit exceeded' }, { 'retry-after': '60' });
  }
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) {
    return json(response, 415, { accepted: false, message: 'Content-Type must be application/json' });
  }
  const contentLength = request.headers['content-length'];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) {
      return json(response, 400, { accepted: false, message: 'Invalid Content-Length' });
    }
    if (Number(contentLength) > maxRequestBytes) {
      return json(response, 413, { accepted: false, message: 'Request body is too large' });
    }
  }
  const rawBody = await readBody(request);
  const relayClient = authenticateSignedRequest(request, rawBody);
  if (!relayClient) {
    return json(response, 401, { accepted: false, message: 'Invalid or expired signature' });
  }
  // Count every authenticated request before JSON parsing or attachment
  // decoding so signed malformed traffic cannot bypass global backpressure.
  if (globalRateLimitExceeded()) {
    return json(response, 429, { accepted: false, message: 'Global rate limit exceeded' }, { 'retry-after': '60' });
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
  const requestHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const previous = completedRequests.get(replayKey);
  if (previous) {
    if (previous.requestHash && previous.requestHash !== requestHash) {
      return json(response, 409, { accepted: false, message: 'Request ID was already used for different content' });
    }
    return json(response, 202, previous.body);
  }

  const uncertain = uncertainRequests.get(replayKey);
  if (uncertain) {
    const message = uncertain.requestHash && uncertain.requestHash !== requestHash
      ? 'Request ID was already used for different content'
      : 'Previous delivery status is uncertain; the relay refused an automatic duplicate';
    return json(response, 409, { accepted: false, retryable: false, message });
  }
  if (inFlightRequests.has(replayKey)) {
    const message = inFlightRequests.get(replayKey) === requestHash
      ? 'Request is already being processed'
      : 'Request ID is already processing different content';
    return json(response, 409, { accepted: false, message });
  }
  if (inFlightRequests.size >= maxConcurrentSends) {
    return json(
      response,
      503,
      { accepted: false, message: 'Relay is at capacity; retry later' },
      { 'retry-after': '1' },
    );
  }
  if (senderRateLimitExceeded(rateKey)) {
    return json(response, 429, { accepted: false, message: 'Sender rate limit exceeded' }, { 'retry-after': '60' });
  }
  if (!receiptCapacityAvailable()) {
    return json(
      response,
      503,
      { accepted: false, retryable: true, message: 'Relay delivery journal is at capacity; retry later' },
      { 'retry-after': '60' },
    );
  }
  const operational = await relayHealth();
  if (!operational.healthy) {
    return json(
      response,
      503,
      { accepted: false, retryable: true, message: 'Mail relay is not ready' },
      { 'retry-after': '5' },
    );
  }

  // Persist intent before invoking sendmail. If the process dies after
  // Postfix accepts the message but before the final receipt is written, the
  // restart fails closed instead of sending the same order/recovery twice.
  rememberPendingRequest(replayKey, requestHash);
  inFlightRequests.set(replayKey, requestHash);
  let acceptedByPostfix = false;
  try {
    const info = await transporter.sendMail(mail);
    acceptedByPostfix = true;
    const result = {
      accepted: true,
      queueId: requestId,
      messageId: info.messageId || mail.messageId,
    };
    rememberCompletedRequest(replayKey, result, requestHash);
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
  } catch (error) {
    if (!acceptedByPostfix) {
      // Local sendmail did not report acceptance, so a retry is safe after a
      // durable release tombstone. An accepted-but-unconfirmed submission is
      // deliberately left uncertain for manual inspection.
      releasePendingRequest(replayKey, requestHash);
    }
    throw error;
  } finally {
    inFlightRequests.delete(replayKey);
  }
}

async function relayHealth(force = false) {
  if (process.env.NODE_ENV === 'test' && process.env.RELAY_TEST_TRANSPORT === 'stream') {
    return { healthy: receiptStoreHealthy, queueDepth: 0 };
  }
  if (!force && Date.now() - lastHealthCheck < 5_000) return cachedHealth;
  if (healthCheckPromise) return healthCheckPromise;

  healthCheckPromise = (async () => {
    let storeWritable = true;
    try {
      if (idempotencyStorePath) accessSync(dirname(idempotencyStorePath), fsConstants.W_OK);
    } catch {
      storeWritable = false;
    }
    const runHealthCommand = async (command, args, options = {}) => {
      try {
        const result = await execFileAsync(command, args, options);
        return { ok: true, stdout: result.stdout || '' };
      } catch {
        return { ok: false, stdout: '' };
      }
    };
    const [postfix, opendkim, queue] = await Promise.all([
      runHealthCommand('postfix', ['status'], { timeout: 3_000, windowsHide: true }),
      runHealthCommand('pgrep', ['-x', 'opendkim'], { timeout: 3_000, windowsHide: true }),
      runHealthCommand('postqueue', ['-j'], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }),
    ]);
    const queueDepth = queue.ok
      ? String(queue.stdout).split('\n').filter(line => line.trim() !== '').length
      : maxQueueMessages + 1;
    const components = {
      postfix: postfix.ok,
      opendkim: opendkim.ok,
      queue: queue.ok && queueDepth <= maxQueueMessages,
      receiptStore: receiptStoreHealthy && storeWritable && receiptCapacityAvailable(),
    };
    const healthy = Object.values(components).every(Boolean);
    lastHealthCheck = Date.now();
    cachedHealth = { healthy, queueDepth, components };
    return cachedHealth;
  })().finally(() => {
    healthCheckPromise = null;
  });
  return healthCheckPromise;
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      const health = await relayHealth();
      return json(response, health.healthy ? 200 : 503, {
        status: health.healthy ? 'ok' : 'degraded',
        queueDepth: health.queueDepth,
        queueLimit: maxQueueMessages,
        uncertainRequests: uncertainRequests.size,
        receiptRecords: receiptRecordCount(),
        receiptCapacity: maxIdempotencyRecords,
        idempotencyRecords: receiptRecordCount(),
        idempotencyCapacity: maxIdempotencyRecords,
        components: Object.fromEntries(
          Object.entries(health.components || {}).map(([name, ready]) => [name, ready ? 'ok' : 'degraded']),
        ),
      });
    }
    if (request.method === 'GET' && request.url === '/v1/identity') {
      return handleIdentity(request, response);
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
server.requestTimeout = toPositiveInt(process.env.REQUEST_TIMEOUT_MS, 60_000);
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = toPositiveInt(process.env.MAX_HEADERS_COUNT, 48);
server.maxConnections = toPositiveInt(process.env.MAX_CONNECTIONS, 100);
server.maxRequestsPerSocket = toPositiveInt(process.env.MAX_REQUESTS_PER_SOCKET, 100);

if (process.env.RELAY_NO_LISTEN !== 'true') {
  server.listen(port, '0.0.0.0', () => {
    console.info(JSON.stringify({ event: 'relay_started', port, allowedSenderDomains: [...allowedSenderDomains] }));
  });
}

function shutdown() {
  compactReceiptStore(true);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export {
  identityPayload,
  isPublicIp,
  normalizeAddress,
  normalizeDomain,
  normalizeMessage,
  rememberCompletedRequest,
  rememberPendingRequest,
  releasePendingRequest,
  receiptCapacityAvailable,
  receiptRecordCount,
  relayHealth,
  server,
  uncertainRequests,
};
