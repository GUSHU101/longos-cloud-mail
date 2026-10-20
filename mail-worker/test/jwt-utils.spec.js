import { describe, expect, it } from 'vitest';
import jwtUtils from '../src/utils/jwt-utils';

const secureSecret = '0123456789abcdef0123456789abcdef';

describe('JWT utilities', () => {
	it('generates and verifies a valid HS256 token', async () => {
		const c = { env: { jwt_secret: secureSecret } };
		const token = await jwtUtils.generateToken(c, { userId: 42, token: 'session-id' });
		const payload = await jwtUtils.verifyToken(c, token);

		expect(payload.userId).toBe(42);
		expect(payload.token).toBe('session-id');
	});

	it('rejects extra segments and modified signatures', async () => {
		const c = { env: { jwt_secret: secureSecret } };
		const token = await jwtUtils.generateToken(c, { userId: 1, token: 'session-id' });

		expect(await jwtUtils.verifyToken(c, `${token}.unexpected`)).toBeNull();
		expect(await jwtUtils.verifyToken(c, `${token.slice(0, -1)}x`)).toBeNull();
		expect(await jwtUtils.verifyToken(c, 'x'.repeat(4097))).toBeNull();
	});

	it('supports expiring purpose-scoped tokens without treating them as sessions', async () => {
		const c = { env: { jwt_secret: secureSecret } };
		const token = await jwtUtils.generateScopedToken(c, 'telegram_email', { emailId: 77 }, 300);
		const payload = await jwtUtils.verifyScopedToken(c, token, 'telegram_email');

		expect(payload.emailId).toBe(77);
		expect(payload.exp).toBeGreaterThan(payload.iat);
		expect(await jwtUtils.verifyScopedToken(c, token, 'another_scope')).toBeNull();
		expect(await jwtUtils.verifyToken(c, token)).toBeNull();
	});

	it('fails closed when the signing secret is weak', async () => {
		await expect(jwtUtils.generateToken({ env: { jwt_secret: 'short' } }, {
			userId: 1,
			token: 'session-id',
		})).rejects.toThrow('not configured securely');
		expect(await jwtUtils.verifyToken({ env: { jwt_secret: 'short' } }, 'a.b.c')).toBeNull();
	});
});
