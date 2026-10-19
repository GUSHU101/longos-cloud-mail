import { describe, expect, it } from 'vitest';
import { isPrivateHostname, normalizePublicBaseUrl, normalizePublicImageUrl, normalizeWebhookUrl } from '../src/utils/domain-uitls';

describe('outbound webhook URL validation', () => {
	it('normalizes public HTTPS endpoints', () => {
		expect(normalizeWebhookUrl(' https://hooks.example.com/email?source=cloud-mail '))
			.toBe('https://hooks.example.com/email?source=cloud-mail');
	});

	it('blocks insecure, credentialed, and private destinations', () => {
		expect(() => normalizeWebhookUrl('http://hooks.example.com/email')).toThrow('HTTPS');
		expect(() => normalizeWebhookUrl('https://user:pass@hooks.example.com/email')).toThrow('credentials');
		expect(() => normalizeWebhookUrl('https://127.0.0.1/email')).toThrow('public host');
		expect(() => normalizeWebhookUrl('https://169.254.169.254/latest/meta-data')).toThrow('public host');
		expect(() => normalizeWebhookUrl('https://[::1]/email')).toThrow('public host');
		expect(() => normalizeWebhookUrl('https://[fd00::1]/email')).toThrow('public host');
		expect(() => normalizeWebhookUrl('https://metadata.google.internal/email')).toThrow('public host');
		expect(isPrivateHostname('192.168.1.1')).toBe(true);
		expect(isPrivateHostname('100.64.0.1')).toBe(true);
		expect(isPrivateHostname('203.0.113.1')).toBe(true);
		expect(isPrivateHostname('hooks.example.com')).toBe(false);
		expect(isPrivateHostname('2606:4700:4700::1111')).toBe(false);
	});
});

describe('public background image URL validation', () => {
	it('accepts only public HTTPS image locations', () => {
		expect(normalizePublicImageUrl(' https://cdn.example.com/background.webp?version=2 '))
			.toBe('https://cdn.example.com/background.webp?version=2');
		expect(() => normalizePublicImageUrl('http://cdn.example.com/background.png')).toThrow('HTTPS');
		expect(() => normalizePublicImageUrl('https://user:pass@cdn.example.com/background.png')).toThrow('credentials');
		expect(() => normalizePublicImageUrl('https://127.0.0.1/background.png')).toThrow('public host');
		expect(() => normalizePublicImageUrl('javascript:alert(1)')).toThrow('HTTPS');
	});
});

describe('public base URL validation', () => {
	it('normalizes host-only configuration and blocks unsafe endpoints', () => {
		expect(normalizePublicBaseUrl('assets.example.com/', 'r2Domain')).toBe('https://assets.example.com');
		expect(() => normalizePublicBaseUrl('http://assets.example.com', 'r2Domain')).toThrow('HTTPS');
		expect(() => normalizePublicBaseUrl('https://assets.example.com/?redirect=evil', 'r2Domain')).toThrow('query');
		expect(() => normalizePublicBaseUrl('https://10.0.0.2', 'endpoint')).toThrow('public host');
	});
});
