import { describe, expect, it } from 'vitest';
import settingService, { buildPublicSetting, normalizeRelayUrl } from '../src/service/setting-service';

describe('LONGOS relay runtime defaults', () => {
	it('uses the deployment URL when the database value is blank', () => {
		const result = settingService.applyRuntimeMailDefaults({
			env: {longos_relay_url: 'https://shop.example.com/_longos/mail-relay/'},
		}, {relayUrl: '', mailEngine: 'auto'});

		expect(result.relayUrl).toBe('https://shop.example.com/_longos/mail-relay');
	});

	it('does not overwrite an administrator URL', () => {
		const result = settingService.applyRuntimeMailDefaults({
			env: {longos_relay_url: 'https://shop.example.com/_longos/mail-relay'},
		}, {relayUrl: 'https://relay.example.net', mailEngine: 'self_hosted'});

		expect(result.relayUrl).toBe('https://relay.example.net');
	});

	it('normalizes relay URLs and rejects unsafe URL components', () => {
		expect(normalizeRelayUrl(' https://relay.example.net/base/// ')).toBe('https://relay.example.net/base');
		expect(() => normalizeRelayUrl('https://user:password@relay.example.net')).toThrow('must not contain credentials');
		expect(() => normalizeRelayUrl('https://relay.example.net?target=other')).toThrow('must not contain a query');
	});

	it('builds an isolated response without mutating cached secrets', () => {
		const cached = {
			siteKey: 'site-secret',
			resendTokens: { 'example.com': 'provider-secret' },
		};
		const response = buildPublicSetting(cached);

		response.siteKey = 'masked';
		response.resendTokens['example.com'] = 'masked';

		expect(cached.siteKey).toBe('site-secret');
		expect(cached.resendTokens['example.com']).toBe('provider-secret');
	});
});
