import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import emailService from '../src/service/email-service';
import selfHostedMailService, { endpointFor, integrationToken, sign } from '../src/service/self-hosted-mail-service';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('self-hosted relay signing', () => {
	it('matches the relay HMAC format', async () => {
		const secret = '0123456789abcdef0123456789abcdef';
		const timestamp = '1700000000';
		const nonce = 'test-nonce';
		const payload = JSON.stringify({ subject: 'hello' });
		const expected = createHmac('sha256', secret)
			.update(`${timestamp}.${nonce}.${payload}`)
			.digest('hex');

		expect(await sign(secret, timestamp, nonce, payload)).toBe(expected);
	});

	it('normalizes a relay base URL', () => {
		expect(endpointFor('https://relay.example.com/')).toBe('https://relay.example.com/v1/send');
		expect(endpointFor('https://relay.example.com/base')).toBe('https://relay.example.com/base/v1/send');
	});

	it('rejects unencrypted remote relay URLs', () => {
		expect(() => endpointFor('http://relay.example.com')).toThrow('must use HTTPS');
	});

	it('rejects relay URLs containing credentials', () => {
		expect(() => endpointFor('https://user:password@relay.example.com')).toThrow('must not contain credentials');
	});

	it('rejects relay secrets that are too short', async () => {
		await expect(selfHostedMailService.send(
			{ env: { RELAY_SHARED_SECRET: 'short' } },
			'https://relay.example.com',
			{ subject: 'hello' },
		)).rejects.toThrow('at least 32 characters');
	});

	it('prefers a scoped LONGOS integration token without exposing HMAC headers', async () => {
		const token = `longos_it_${'a'.repeat(64)}`;
		const fetchMock = vi.fn(async (_url, options) => {
			expect(options.headers.authorization).toBe(`Bearer ${token}`);
			expect(options.headers['x-relay-signature']).toBeUndefined();
			expect(options.redirect).toBe('manual');
			return new Response(JSON.stringify({ accepted: true, queueId: 'integration-1' }), { status: 202 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await selfHostedMailService.send(
			{ env: { LONGOS_INTEGRATION_TOKEN: token, RELAY_SHARED_SECRET: 'legacy-secret-that-is-long-enough-1234' } },
			'https://relay.example.com',
			{ subject: 'hello' },
		);

		expect(result).toEqual({ data: { id: 'integration-1' } });
	});

	it('rejects malformed integration tokens before making a request', () => {
		expect(() => integrationToken({ env: { LONGOS_INTEGRATION_TOKEN: 'token with spaces' } }))
			.toThrow('LONGOS_INTEGRATION_TOKEN is invalid');
	});

	it('checks LONGOS relay health with the scoped bearer token', async () => {
		const token = `longos_it_${'b'.repeat(64)}`;
		const fetchMock = vi.fn(async (url, options) => {
			expect(url).toBe('https://relay.example.com/base/health');
			expect(options.method).toBe('GET');
			expect(options.headers.authorization).toBe(`Bearer ${token}`);
			expect(options.redirect).toBe('manual');
			return new Response(JSON.stringify({
				status: 'ok',
				queueDepth: 3,
				uncertainRequests: 1,
				receiptRecords: 25,
				receiptCapacity: 100000,
			}), {status: 200});
		});
		vi.stubGlobal('fetch', fetchMock);

		await expect(selfHostedMailService.health(
			{env: {LONGOS_INTEGRATION_TOKEN: token}},
			'https://relay.example.com/base',
		)).resolves.toEqual({
			status: 'ok',
			authMode: 'integration_token',
			queueDepth: 3,
			uncertainRequests: 1,
			receiptRecords: 25,
			receiptCapacity: 100000,
		});
	});

	it('submits a signed JSON request and returns the relay queue id', async () => {
		const secret = '0123456789abcdef0123456789abcdef';
		const payload = { subject: 'hello' };
		const fetchMock = vi.fn(async (_url, options) => {
			const timestamp = options.headers['x-relay-timestamp'];
			const nonce = options.headers['x-relay-nonce'];
			expect(options.headers['x-relay-client']).toBe('cloud-mail');
			const expected = createHmac('sha256', secret)
				.update(`${timestamp}.${nonce}.${options.body}`)
				.digest('hex');
			expect(options.headers['x-relay-signature']).toBe(expected);
			expect(JSON.parse(options.body)).toEqual(payload);
			return new Response(JSON.stringify({ accepted: true, queueId: 'queue-123' }), {
				status: 202,
				headers: { 'content-type': 'application/json' },
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await selfHostedMailService.send(
			{ env: { RELAY_SHARED_SECRET: secret } },
			'https://relay.example.com',
			payload,
		);

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0][0]).toBe('https://relay.example.com/v1/send');
		expect(result).toEqual({ data: { id: 'queue-123' } });
	});

	it('retries transient failures with the same idempotency payload and a fresh signature', async () => {
		const secret = '0123456789abcdef0123456789abcdef';
		const payload = { requestId: 'stable-request-id', subject: 'hello' };
		const attempts = [];
		const fetchMock = vi.fn(async (_url, options) => {
			attempts.push({ body: options.body, nonce: options.headers['x-relay-nonce'] });
			if (attempts.length === 1) throw new Error('connection reset');
			return new Response(JSON.stringify({ accepted: true, queueId: 'stable-request-id' }), { status: 202 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await selfHostedMailService.send(
			{ env: { RELAY_SHARED_SECRET: secret } },
			'https://relay.example.com',
			payload,
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(attempts[0].body).toBe(attempts[1].body);
		expect(attempts[0].nonce).not.toBe(attempts[1].nonce);
		expect(result).toEqual({ data: { id: 'stable-request-id' } });
	});

	it('binds the selected account and user to the signed relay context', async () => {
		const secret = '0123456789abcdef0123456789abcdef';
		const fetchMock = vi.fn(async (_url, options) => {
			const body = JSON.parse(options.body);
			expect(body.from.address).toBe('sales@example.com');
			expect(body.senderContext).toEqual({
				source: 'cloud-mail',
				tenantId: 'user-7',
				accountId: 'account-9',
				category: 'compose',
			});
			return new Response(JSON.stringify({ accepted: true, queueId: 'queue-context' }), { status: 202 });
		});
		vi.stubGlobal('fetch', fetchMock);

		await emailService.sendBySelfHosted(
			{ env: { RELAY_SHARED_SECRET: secret } },
			'https://relay.example.com',
			{
				userId: 'user-7',
				accountId: 'account-9',
				accountEmail: 'sales@example.com',
				name: 'Sales',
				receiveEmail: ['buyer@example.net'],
				subject: 'Hello',
				text: 'Body',
				html: '',
				attachments: [],
				sendType: 'new',
				messageId: null,
			},
		);

		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
