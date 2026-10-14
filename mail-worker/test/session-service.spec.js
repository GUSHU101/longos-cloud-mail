import { describe, expect, it, vi } from 'vitest';
import loginService from '../src/service/login-service';
import jwtUtils from '../src/utils/jwt-utils';
import KvConst from '../src/const/kv-const';
import constant from '../src/const/constant';
import { matchesRoute } from '../src/security/security';

const secureSecret = '0123456789abcdef0123456789abcdef';

async function context(tokens, activeToken) {
	const authInfo = { tokens: [...tokens], user: { userId: 7, email: 'owner@example.com' } };
	const jwt = await jwtUtils.generateToken(
		{ env: { jwt_secret: secureSecret } },
		{ userId: 7, token: activeToken }
	);
	return {
		env: {
			jwt_secret: secureSecret,
			kv: {
				get: vi.fn(async () => structuredClone(authInfo)),
				put: vi.fn(),
				delete: vi.fn(),
			},
		},
		req: { header: name => name === constant.TOKEN_HEADER ? jwt : '' },
	};
}

describe('session logout', () => {
	it('matches route boundaries without allowing prefix lookalikes', () => {
		expect(matchesRoute('/login', '/login')).toBe(true);
		expect(matchesRoute('/oauth/callback', '/oauth')).toBe(true);
		expect(matchesRoute('/login-admin', '/login')).toBe(false);
		expect(matchesRoute('/publicity', '/public')).toBe(false);
	});

	it('removes only the active token and preserves the KV expiration', async () => {
		const c = await context(['first', 'second', 'third'], 'second');

		await loginService.logout(c, 7);

		expect(c.env.kv.put).toHaveBeenCalledWith(
			KvConst.AUTH_INFO + 7,
			expect.stringContaining('"tokens":["first","third"]'),
			{ expirationTtl: constant.TOKEN_EXPIRE }
		);
		expect(c.env.kv.delete).not.toHaveBeenCalled();
	});

	it('deletes the KV session record after the final token is removed', async () => {
		const c = await context(['only-token'], 'only-token');

		await loginService.logout(c, 7);

		expect(c.env.kv.delete).toHaveBeenCalledWith(KvConst.AUTH_INFO + 7);
		expect(c.env.kv.put).not.toHaveBeenCalled();
	});
});
