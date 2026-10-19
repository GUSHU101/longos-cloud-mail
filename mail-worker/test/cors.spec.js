import { describe, expect, it } from 'vitest';
import { APP_CONTENT_SECURITY_POLICY, configuredCorsOrigins, corsOrigin } from '../src/hono/hono';

function context(value) {
	return {
		env: { cors_origins: value },
		req: { url: 'https://mail.example.com/email/list' },
	};
}

describe('API CORS policy', () => {
	it('allows same-origin and configured browser origins only', () => {
		const c = context('["https://admin.example.com"]');
		expect(corsOrigin('https://mail.example.com', c)).toBe('https://mail.example.com');
		expect(corsOrigin('https://admin.example.com', c)).toBe('https://admin.example.com');
		expect(corsOrigin('https://attacker.example', c)).toBeUndefined();
	});

	it('supports comma-separated configuration without wildcard fallback', () => {
		const c = context('https://one.example, https://two.example');
		expect(configuredCorsOrigins(c)).toEqual(['https://one.example', 'https://two.example']);
		expect(corsOrigin('', c)).toBeUndefined();
	});

	it('uses a restrictive application content security policy', () => {
		expect(APP_CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
		expect(APP_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
		expect(APP_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
	});
});
