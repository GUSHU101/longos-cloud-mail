import { describe, expect, it } from 'vitest';
import { statusUpdateForWebhook, verifyWebhook } from '../src/service/resend-service';
import { emailConst } from '../src/const/entity-const';

function webhookContext(secret, headers = {}) {
	return {
		env: { RESEND_WEBHOOK_SECRET: secret },
		req: { header: name => headers[name] || '' },
	};
}

function toBase64(bytes) {
	return btoa(String.fromCharCode(...bytes));
}

async function signedWebhook(body) {
	const payload = JSON.stringify(body);
	const id = 'msg_test';
	const timestamp = String(Math.floor(Date.now() / 1000));
	const secretBytes = new TextEncoder().encode('resend-webhook-test-secret');
	const key = await crypto.subtle.importKey(
		'raw',
		secretBytes,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = new Uint8Array(await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`${id}.${timestamp}.${payload}`)
	));
	return {
		payload,
		secret: `whsec_${toBase64(secretBytes)}`,
		headers: {
			'svix-id': id,
			'svix-timestamp': timestamp,
			'svix-signature': `v1,${toBase64(signature)}`,
		},
	};
}

describe('Resend webhook validation', () => {
	it('maps supported events and ignores unrelated events', () => {
		expect(statusUpdateForWebhook({
			type: 'email.delivered',
			data: { email_id: 'email-id' },
		})).toEqual({ resendEmailId: 'email-id', status: emailConst.status.DELIVERED, message: null });
		expect(statusUpdateForWebhook({
			type: 'domain.updated',
			data: {},
		})).toBeNull();
	});

	it('fails closed when verification is not configured or the signature is invalid', () => {
		expect(() => verifyWebhook(webhookContext(''), '{}')).toThrow('not configured');
		expect(() => verifyWebhook(webhookContext('whsec_valid-length-secret'), '{}')).toThrow('Invalid Resend webhook signature');
	});

	it('accepts an authentic raw payload and Svix signature', async () => {
		const body = { type: 'email.delivered', data: { email_id: 'email-id' } };
		const signed = await signedWebhook(body);

		expect(verifyWebhook(
			webhookContext(signed.secret, signed.headers),
			signed.payload
		)).toEqual(body);
	});

	it('rejects malformed payloads before changing status', () => {
		expect(() => statusUpdateForWebhook(null)).toThrow('Invalid Resend webhook payload');
		expect(() => statusUpdateForWebhook({ type: 'email.sent', data: {} })).toThrow('Invalid Resend email ID');
	});
});
