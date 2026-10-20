import { describe, expect, it } from 'vitest';
import { withObjectSecurityHeaders, withSecurityHeaders } from '../src/index';

describe('asset response hardening', () => {
	it('preserves the response while adding browser security headers', async () => {
		const response = withSecurityHeaders(new Response('asset', {
			status: 206,
			headers: { 'content-type': 'text/plain', 'accept-ranges': 'bytes' },
		}));

		expect(response.status).toBe(206);
		expect(response.headers.get('accept-ranges')).toBe('bytes');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('x-frame-options')).toBe('DENY');
		expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
		expect(response.headers.get('content-security-policy')).toContain('https://challenges.cloudflare.com');
		expect(await response.text()).toBe('asset');
	});

	it('returns a hardened 404 when an object is missing', async () => {
		const response = withObjectSecurityHeaders(null);

		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await response.text()).toBe('Not Found');
	});
});
