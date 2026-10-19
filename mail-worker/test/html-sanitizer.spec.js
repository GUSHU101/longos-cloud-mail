import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml } from '../src/utils/html-sanitizer';
import { applyTelegramContentHeaders } from '../src/api/telegram-api';

describe('email HTML sanitizer', () => {
	it('removes active content while preserving ordinary email markup', () => {
		const sanitized = sanitizeEmailHtml(`
			<html><head><style>.ok { color: red }</style></head><body>
				<script>alert(1)</script><iframe src="https://evil.example"></iframe>
				<svg onload="alert(2)"></svg>
				<img src="https://images.example/p.png" onerror="alert(3)">
				<a href="java\nscript:alert(4)" target="_blank">bad</a>
				<a href="https://safe.example" target="_blank">safe</a>
				<p class="ok">message</p>
			</body></html>
		`);

		expect(sanitized).not.toMatch(/script|iframe|svg|onerror|onload|javascript:/i);
		expect(sanitized).toContain('https://images.example/p.png');
		expect(sanitized).toContain('https://safe.example');
		expect(sanitized).toContain('rel="noopener noreferrer"');
		expect(sanitized).toContain('message');
	});

	it('drops dangerous CSS and non-image data URLs', () => {
		const sanitized = sanitizeEmailHtml(`
			<body style="color:red"><p style="background:url(javascript:alert(1))">x</p>
			<style>:host { position: fixed; inset: 0 }</style>
			<img src="data:text/html;base64,PHNjcmlwdD4="></body>
		`);

		expect(sanitized).toContain('style="color:red"');
		expect(sanitized).not.toContain('javascript:');
		expect(sanitized).not.toContain(':host');
		expect(sanitized).not.toContain('position: fixed');
		expect(sanitized).not.toContain('data:text/html');
	});
});

describe('Telegram email preview headers', () => {
	it('prevents shared caching and constrains active content', () => {
		const headers = new Map();
		applyTelegramContentHeaders({ header: (name, value) => headers.set(name.toLowerCase(), value) });

		expect(headers.get('cache-control')).toBe('private, no-store');
		expect(headers.get('content-security-policy')).toContain("default-src 'none'");
		expect(headers.get('content-security-policy')).toContain("frame-src 'none'");
		expect(headers.get('content-security-policy')).toContain("form-action 'none'");
	});
});
