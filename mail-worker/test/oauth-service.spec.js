import { describe, expect, it } from 'vitest';
import { oauthCallbackParams, oauthRecord } from '../src/service/oauth-service';

function context(url = 'https://mail.example.com/oauth/github/login') {
	return { req: { url } };
}

describe('OAuth callback validation', () => {
	it('accepts only the current origin login callback', () => {
		expect(oauthCallbackParams(context(), {
			code: 'authorization-code',
			redirectUri: 'https://mail.example.com/login',
		})).toEqual({
			code: 'authorization-code',
			redirectUri: 'https://mail.example.com/login',
		});

		expect(() => oauthCallbackParams(context(), {
			code: 'authorization-code',
			redirectUri: 'https://attacker.example/login',
		})).toThrow('current site login page');
		expect(() => oauthCallbackParams(context(), {
			code: 'authorization-code',
			redirectUri: 'https://mail.example.com/login?next=attacker',
		})).toThrow('current site login page');
	});

	it('normalizes only supported, platform-scoped identities', () => {
		expect(oauthRecord({ oauthUserId: 123, platform: 'GitHub', username: 'demo' })).toMatchObject({
			oauthUserId: '123',
			platform: 'github',
			username: 'demo',
		});
		expect(() => oauthRecord({ oauthUserId: '123', platform: 'unknown' })).toThrow('Invalid OAuth identity');
	});
});
