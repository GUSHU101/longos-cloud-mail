import BizError from '../error/biz-error';

const encoder = new TextEncoder();
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 2;

function integrationToken(c) {
	const token = String(c.env.LONGOS_INTEGRATION_TOKEN || '').trim();
	if (!token) return '';
	if (!/^longos_it_[A-Za-z0-9]{64}$/.test(token)) {
		throw new BizError('LONGOS_INTEGRATION_TOKEN is invalid');
	}
	return token;
}

function toHex(buffer) {
	return [...new Uint8Array(buffer)]
		.map(value => value.toString(16).padStart(2, '0'))
		.join('');
}

async function sign(secret, timestamp, nonce, payload) {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(`${timestamp}.${nonce}.${payload}`)
	);
	return toHex(signature);
}

function endpointFor(relayUrl, path = 'v1/send') {
	let url;
	try {
		url = new URL(relayUrl);
	} catch {
		throw new BizError('Self-hosted relay URL is invalid');
	}

	if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
		throw new BizError('Self-hosted relay URL must use HTTPS');
	}
	if (url.username || url.password) {
		throw new BizError('Self-hosted relay URL must not contain credentials');
	}

	url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
	url.search = '';
	url.hash = '';
	return url.toString();
}

const selfHostedMailService = {
	async health(c, relayUrl) {
		const token = integrationToken(c);
		const secret = String(c.env.RELAY_SHARED_SECRET || '');
		if (!relayUrl) {
			throw new BizError('Self-hosted relay URL is not configured');
		}
		if (!token && secret.length < 32) {
			throw new BizError(secret ? 'RELAY_SHARED_SECRET must contain at least 32 characters' : 'LONGOS_INTEGRATION_TOKEN is not configured');
		}

		const timestamp = Math.floor(Date.now() / 1000).toString();
		const nonce = crypto.randomUUID();
		const headers = token
			? {accept: 'application/json', authorization: `Bearer ${token}`}
			: {
				accept: 'application/json',
				'x-relay-client': 'cloud-mail',
				'x-relay-timestamp': timestamp,
				'x-relay-nonce': nonce,
				'x-relay-signature': await sign(secret, timestamp, nonce, ''),
			};
		let response;
		try {
			response = await fetch(endpointFor(relayUrl, 'health'), {
				method: 'GET',
				headers,
				redirect: 'manual',
				signal: AbortSignal.timeout(10_000),
			});
		} catch (error) {
			throw new BizError(`Self-hosted relay is unavailable: ${error.message}`);
		}

		let body = {};
		try {
			body = await response.json();
		} catch {
			// Status is reported below without returning an untrusted HTML body.
		}
		if (!response.ok) {
			throw new BizError(body.message || `Self-hosted relay health check failed (${response.status})`);
		}

		return {
			status: body.status === 'ok' ? 'ok' : 'reachable',
			authMode: token ? 'integration_token' : 'legacy_hmac',
			queueDepth: Number.isSafeInteger(Number(body.queueDepth)) ? Number(body.queueDepth) : null,
			uncertainRequests: Number.isSafeInteger(Number(body.uncertainRequests)) ? Number(body.uncertainRequests) : null,
			receiptRecords: Number.isSafeInteger(Number(body.receiptRecords)) ? Number(body.receiptRecords) : null,
			receiptCapacity: Number.isSafeInteger(Number(body.receiptCapacity)) ? Number(body.receiptCapacity) : null,
		};
	},

	async send(c, relayUrl, params) {
		const token = integrationToken(c);
		const secret = String(c.env.RELAY_SHARED_SECRET || '');
		if (!relayUrl) {
			throw new BizError('Self-hosted relay URL is not configured');
		}
		if (!token && !secret) {
			throw new BizError('LONGOS_INTEGRATION_TOKEN is not configured');
		}
		if (!token && secret.length < 32) {
			throw new BizError('RELAY_SHARED_SECRET must contain at least 32 characters');
		}

		const payload = JSON.stringify(params);
		const endpoint = endpointFor(relayUrl);
		let lastError;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			const timestamp = Math.floor(Date.now() / 1000).toString();
			const nonce = crypto.randomUUID();
			const signature = token ? '' : await sign(secret, timestamp, nonce, payload);
			let response;
			const headers = {
				'content-type': 'application/json',
				...(token
					? {authorization: `Bearer ${token}`}
					: {
						'x-relay-client': 'cloud-mail',
						'x-relay-timestamp': timestamp,
						'x-relay-nonce': nonce,
						'x-relay-signature': signature,
					}),
			};

			try {
				response = await fetch(endpoint, {
					method: 'POST',
					headers,
					body: payload,
					redirect: 'manual',
					signal: AbortSignal.timeout(20_000),
				});
			} catch (error) {
				lastError = new BizError(`Self-hosted relay is unavailable: ${error.message}`);
				if (attempt < MAX_ATTEMPTS) continue;
				throw lastError;
			}

			let body = {};
			try {
				body = await response.json();
			} catch {
				// Preserve the HTTP status when the relay did not return JSON.
			}

			if (response.ok && body.accepted) {
				return {
					data: {
						id: body.queueId || body.messageId,
					},
				};
			}

			lastError = new BizError(body.message || `Self-hosted relay rejected the message (${response.status})`);
			if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) {
				throw lastError;
			}
		}

		throw lastError;
	},
};

export { endpointFor, integrationToken, sign };
export default selfHostedMailService;
