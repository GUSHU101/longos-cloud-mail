import BizError from '../error/biz-error';

const encoder = new TextEncoder();
const RETRYABLE_STATUS = new Set([429, 503, 504]);
const MAX_ATTEMPTS = 2;

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
	async send(c, relayUrl, params) {
		const secret = c.env.RELAY_SHARED_SECRET;
		if (!relayUrl) {
			throw new BizError('Self-hosted relay URL is not configured');
		}
		if (!secret) {
			throw new BizError('RELAY_SHARED_SECRET is not configured');
		}
		if (secret.length < 32) {
			throw new BizError('RELAY_SHARED_SECRET must contain at least 32 characters');
		}

		const payload = JSON.stringify(params);
		const endpoint = endpointFor(relayUrl);
		let lastError;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			const timestamp = Math.floor(Date.now() / 1000).toString();
			const nonce = crypto.randomUUID();
			const signature = await sign(secret, timestamp, nonce, payload);
			let response;

			try {
				response = await fetch(endpoint, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-relay-client': 'cloud-mail',
						'x-relay-timestamp': timestamp,
						'x-relay-nonce': nonce,
						'x-relay-signature': signature,
					},
					body: payload,
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

export { endpointFor, sign };
export default selfHostedMailService;
