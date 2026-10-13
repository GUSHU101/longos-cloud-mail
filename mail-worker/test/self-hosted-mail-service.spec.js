import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import emailService from '../src/service/email-service';
import selfHostedMailService, { endpointFor, sign } from '../src/service/self-hosted-mail-service';

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
