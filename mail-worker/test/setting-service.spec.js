import { describe, expect, it } from 'vitest';
import settingService, { buildPublicSetting, isMaskedSecret, maskSecret, normalizeRelayUrl, parseResendTokens } from '../src/service/setting-service';

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

	it('pins integration-token traffic to the deployment relay URL', () => {
		const result = settingService.applyRuntimeMailDefaults({
			env: {
				longos_relay_url: 'https://trusted.example.com/_longos/mail-relay',
				LONGOS_INTEGRATION_TOKEN: `longos_it_${'a'.repeat(64)}`,
			},
		}, {relayUrl: 'https://attacker.example.net', mailEngine: 'self_hosted'});

		expect(result.relayUrl).toBe('https://trusted.example.com/_longos/mail-relay');
		expect(result.mailEngine).toBe('self_hosted');
	});

	it('disables third-party fallback for an integrated LONGOS deployment', () => {
		const result = settingService.applyRuntimeMailDefaults({
			env: {
				longos_relay_url: 'https://shop.example.com/_longos/mail-relay',
				LONGOS_INTEGRATION_TOKEN: `longos_it_${'b'.repeat(64)}`,
			},
		}, {relayUrl: '', mailEngine: 'resend'});

		expect(result).toMatchObject({
			relayUrl: 'https://shop.example.com/_longos/mail-relay',
			mailEngine: 'self_hosted',
		});
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

	it('recognizes only the explicit masked-secret representation', () => {
		expect(maskSecret('super-secret-value')).toBe('super-******');
		expect(isMaskedSecret('super-******')).toBe(true);
		expect(isMaskedSecret('super-secret-value')).toBe(false);
	});

	it('keeps empty and masked secret representations distinct', () => {
		expect(maskSecret('')).toBeNull();
		expect(isMaskedSecret(null)).toBe(false);
		expect(isMaskedSecret('******')).toBe(true);
	});

	it('parses stored provider tokens without sharing mutable state', () => {
		const parsed = parseResendTokens('{"example.com":"token"}');
		expect(parsed).toEqual({'example.com': 'token'});
		expect(parseResendTokens(parsed)).not.toBe(parsed);
		expect(() => parseResendTokens('{broken')).toThrow('configuration is invalid');
	});

	it('rejects malformed runtime domain bindings with a controlled error', async () => {
		const context = {
			env: {
				domain: '{"not":"an-array"}',
				kv: {get: async () => ({emailPrefixFilter: '', resendTokens: {}})},
			},
			get: () => null,
			set: () => {},
		};
		await expect(settingService.query(context)).rejects.toThrow();
	});
});
