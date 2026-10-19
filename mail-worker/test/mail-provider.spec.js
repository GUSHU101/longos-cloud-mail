import { describe, expect, it } from 'vitest';
import { selectExternalMailProvider } from '../src/service/mail-provider';

describe('mail provider selection', () => {
	it('prefers the LONGOS relay in automatic mode', () => {
		expect(selectExternalMailProvider({
			mailEngine: 'auto',
			relayUrl: 'https://shop.example.com/_longos/mail-relay',
			hasRelayCredential: true,
			useCloudflareEmail: true,
			hasResendToken: true,
		})).toBe('self_hosted');
	});

	it('retains compatibility fallbacks when the relay is incomplete', () => {
		expect(selectExternalMailProvider({
			mailEngine: 'auto',
			relayUrl: '',
			hasRelayCredential: false,
			useCloudflareEmail: true,
			hasResendToken: true,
		})).toBe('cloudflare');
	});

	it('honors an explicitly selected engine', () => {
		expect(selectExternalMailProvider({mailEngine: 'resend'})).toBe('resend');
	});
});
