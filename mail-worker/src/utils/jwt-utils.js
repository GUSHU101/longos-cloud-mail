const encoder = new TextEncoder();
const decoder = new TextDecoder();

function signingSecret(c) {
	const secret = String(c?.env?.jwt_secret || '');
	if (!/^[A-Za-z0-9_-]{32,}$/.test(secret)) {
		throw new Error('JWT signing secret is not configured securely');
	}
	return secret;
}

const base64url = (input) => {
	const str = btoa(String.fromCharCode(...new Uint8Array(input)));
	return str.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};

const base64urlDecode = (str) => {
	str = str.replace(/-/g, '+').replace(/_/g, '/');
	while (str.length % 4) str += '=';
	return Uint8Array.from(atob(str), c => c.charCodeAt(0));
};

const isCanonicalBase64url = (value) => {
	try {
		return base64url(base64urlDecode(value)) === value;
	} catch {
		return false;
	}
};

async function verifySignedPayload(c, token) {
	try {
		if (typeof token !== 'string' || token.length > 4096) return null;
		const segments = token.split('.');
		if (segments.length !== 3 || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) return null;
		if (segments.some(segment => !isCanonicalBase64url(segment))) return null;
		const [headerB64, payloadB64, signatureB64] = segments;

		if (!headerB64 || !payloadB64 || !signatureB64) return null;
		const header = JSON.parse(decoder.decode(base64urlDecode(headerB64)));
		if (header?.alg !== 'HS256' || header?.typ !== 'JWT') return null;

		const data = `${headerB64}.${payloadB64}`;
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(signingSecret(c)),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify']
		);

		const valid = await crypto.subtle.verify(
			'HMAC',
			key,
			base64urlDecode(signatureB64),
			encoder.encode(data)
		);

		if (!valid) return null;

		const payload = JSON.parse(decoder.decode(base64urlDecode(payloadB64)));
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

		const now = Math.floor(Date.now() / 1000);
		if (payload.exp !== undefined && (!Number.isSafeInteger(payload.exp) || payload.exp <= now)) return null;
		if (payload.iat !== undefined && (!Number.isSafeInteger(payload.iat) || payload.iat > now + 60)) return null;

		return payload;
	} catch {
		return null;
	}
}

const jwtUtils = {
	async generateToken(c, payload, expiresInSeconds) {
		const header = {
			alg: 'HS256',
			typ: 'JWT'
		};

		const now = Math.floor(Date.now() / 1000);
		const exp = expiresInSeconds ? now + expiresInSeconds : undefined;

		const fullPayload = {
			...payload,
			iat: now,
			...(exp ? { exp } : {})
		};

		const headerStr = base64url(encoder.encode(JSON.stringify(header)));
		const payloadStr = base64url(encoder.encode(JSON.stringify(fullPayload)));
		const data = `${headerStr}.${payloadStr}`;

		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(signingSecret(c)),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);

		const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
		const signatureStr = base64url(signature);

		return `${data}.${signatureStr}`;
	},

	async generateScopedToken(c, scope, payload, expiresInSeconds) {
		if (!/^[a-z][a-z0-9:_-]{2,63}$/.test(String(scope || ''))) {
			throw new Error('JWT scope is invalid');
		}
		if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1) {
			throw new Error('Scoped JWT expiration is required');
		}
		return this.generateToken(c, { ...payload, scope }, expiresInSeconds);
	},

	async verifyToken(c, token) {
		const payload = await verifySignedPayload(c, token);
		if (!payload || !Number.isSafeInteger(payload.userId) || typeof payload.token !== 'string' || !payload.token) return null;
		return payload;
	},

	async verifyScopedToken(c, token, scope) {
		const payload = await verifySignedPayload(c, token);
		if (!payload || payload.scope !== scope || !Number.isSafeInteger(payload.exp)) return null;
		return payload;
	}
};

export { base64url, base64urlDecode, isCanonicalBase64url, signingSecret, verifySignedPayload };
export default jwtUtils;
