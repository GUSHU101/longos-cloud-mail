import { describe, expect, it } from 'vitest';
import cryptoUtils, { PASSWORD_HASH_PREFIX } from '../src/utils/crypto-utils';

function toBase64(bytes) {
	return btoa(String.fromCharCode(...bytes));
}

describe('password hashing', () => {
	it('creates and verifies versioned PBKDF2 password hashes', async () => {
		const password = 'correct horse battery staple';
		const result = await cryptoUtils.hashPassword(password);

		expect(result.salt).not.toBe('');
		expect(result.hash.startsWith(`${PASSWORD_HASH_PREFIX}$`)).toBe(true);
		expect(await cryptoUtils.verifyPassword(password, result.salt, result.hash)).toBe(true);
		expect(await cryptoUtils.verifyPassword('wrong password', result.salt, result.hash)).toBe(false);
		expect(cryptoUtils.needsRehash(result.hash)).toBe(false);
		expect(await cryptoUtils.verifyPassword(password, result.salt, 'pbkdf2-sha256$100000$')).toBe(false);
		expect(cryptoUtils.needsRehash('pbkdf2-sha256$invalid$bad')).toBe(true);
	});

	it('keeps legacy hashes readable so they can be upgraded after login', async () => {
		const password = 'legacy-password';
		const salt = 'legacy-salt';
		const digest = new Uint8Array(await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(salt + password)
		));
		const legacyHash = toBase64(digest);

		expect(await cryptoUtils.verifyPassword(password, salt, legacyHash)).toBe(true);
		expect(await cryptoUtils.verifyPassword('wrong', salt, legacyHash)).toBe(false);
		expect(cryptoUtils.needsRehash(legacyHash)).toBe(true);
	});

	it('uses the cryptographic random source for generated passwords', () => {
		const passwords = new Set(Array.from({ length: 20 }, () => cryptoUtils.genRandomPwd()));
		expect(passwords.size).toBe(20);
		for (const password of passwords) {
			expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
		}
		expect(() => cryptoUtils.genRandomPwd(0)).toThrow(TypeError);
	});
});
