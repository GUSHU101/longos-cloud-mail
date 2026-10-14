const encoder = new TextEncoder();
const PASSWORD_HASH_PREFIX = 'pbkdf2-sha256';
const PASSWORD_HASH_ITERATIONS = 100_000;
const PASSWORD_HASH_BYTES = 32;

function toBase64(bytes) {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

function fromBase64(value) {
	try {
		return Uint8Array.from(atob(value), character => character.charCodeAt(0));
	} catch {
		return null;
	}
}

function constantTimeEqual(left, right) {
	const length = Math.max(left?.length || 0, right?.length || 0);
	let difference = (left?.length || 0) ^ (right?.length || 0);
	for (let index = 0; index < length; index += 1) {
		difference |= (left?.[index] ?? 0) ^ (right?.[index] ?? 0);
	}
	return difference === 0;
}

const saltHashUtils = {

	generateSalt(length = 16) {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return toBase64(array);
	},


	async hashPassword(password) {
		const salt = this.generateSalt();
		const hash = await this.genHashPassword(password, salt);
		return { salt, hash };
	},

	async genHashPassword(password, salt) {
		const key = await crypto.subtle.importKey(
			'raw',
			encoder.encode(String(password)),
			{ name: 'PBKDF2' },
			false,
			['deriveBits']
		);
		const hashBuffer = await crypto.subtle.deriveBits({
			name: 'PBKDF2',
			hash: 'SHA-256',
			salt: encoder.encode(String(salt)),
			iterations: PASSWORD_HASH_ITERATIONS,
		}, key, PASSWORD_HASH_BYTES * 8);
		return `${PASSWORD_HASH_PREFIX}$${PASSWORD_HASH_ITERATIONS}$${toBase64(new Uint8Array(hashBuffer))}`;
	},

	async verifyPassword(inputPassword, salt, storedHash) {
		if (typeof storedHash !== 'string' || typeof inputPassword !== 'string') return false;

		if (storedHash.startsWith(`${PASSWORD_HASH_PREFIX}$`)) {
			const [algorithm, iterationValue, encodedHash, extra] = storedHash.split('$');
			const iterations = Number(iterationValue);
			const expected = fromBase64(encodedHash || '');
			if (
				algorithm !== PASSWORD_HASH_PREFIX
				|| extra !== undefined
				|| !Number.isSafeInteger(iterations)
				|| iterations < 10_000
				|| iterations > 2_000_000
				|| expected?.length !== PASSWORD_HASH_BYTES
			) return false;

			const key = await crypto.subtle.importKey(
				'raw',
				encoder.encode(inputPassword),
				{ name: 'PBKDF2' },
				false,
				['deriveBits']
			);
			const actual = new Uint8Array(await crypto.subtle.deriveBits({
				name: 'PBKDF2',
				hash: 'SHA-256',
				salt: encoder.encode(String(salt)),
				iterations,
			}, key, expected.length * 8));
			return constantTimeEqual(actual, expected);
		}

		// Legacy Cloud Mail hashes used one fast SHA-256 pass. They remain
		// readable only so a successful login can transparently upgrade them.
		const legacyHash = new Uint8Array(await crypto.subtle.digest(
			'SHA-256',
			encoder.encode(String(salt) + inputPassword)
		));
		const expectedLegacy = fromBase64(storedHash);
		return expectedLegacy?.length === PASSWORD_HASH_BYTES && constantTimeEqual(legacyHash, expectedLegacy);
	},

	needsRehash(storedHash) {
		if (typeof storedHash !== 'string') return true;
		const [algorithm, iterationValue, encodedHash, extra] = storedHash.split('$');
		const iterations = Number(iterationValue);
		return algorithm !== PASSWORD_HASH_PREFIX
			|| extra !== undefined
			|| !Number.isSafeInteger(iterations)
			|| iterations < PASSWORD_HASH_ITERATIONS
			|| fromBase64(encodedHash || '')?.length !== PASSWORD_HASH_BYTES;
	},

	genRandomPwd(length = 20) {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		if (!Number.isSafeInteger(length) || length < 1 || length > 256) {
			throw new TypeError('Password length must be between 1 and 256');
		}
		let result = '';
		const unbiasedLimit = 256 - (256 % chars.length);
		while (result.length < length) {
			const bytes = new Uint8Array(Math.max(16, (length - result.length) * 2));
			crypto.getRandomValues(bytes);
			for (const value of bytes) {
				if (value >= unbiasedLimit) continue;
				result += chars[value % chars.length];
				if (result.length === length) break;
			}
		}
		return result;
	}
};

export { PASSWORD_HASH_ITERATIONS, PASSWORD_HASH_PREFIX, constantTimeEqual };
export default saltHashUtils;
