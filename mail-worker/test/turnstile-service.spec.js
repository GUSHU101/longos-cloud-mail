import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/service/setting-service', () => ({
	default: {
		query: vi.fn(),
	},
}));
vi.mock('../src/i18n/i18n', () => ({ t: key => key }));

import settingService from '../src/service/setting-service';
import turnstileService, { TURNSTILE_TIMEOUT_MS } from '../src/service/turnstile-service';

function context() {
	return {
		req: {
			header: name => name === 'cf-connecting-ip' ? '203.0.113.10' : '',
		},
	};
}

describe('Turnstile verification reliability', () => {
	beforeEach(() => {
		settingService.query.mockResolvedValue({ secretKey: 'turnstile-secret' });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it('uses a bounded provider request and accepts a successful response', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockResolvedValue({ success: true }),
		});
		vi.stubGlobal('fetch', fetchMock);

		await expect(turnstileService.verify(context(), 'browser-token')).resolves.toBeUndefined();
		const options = fetchMock.mock.calls[0][1];
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(TURNSTILE_TIMEOUT_MS).toBe(10_000);
		expect(options.body.get('remoteip')).toBe('203.0.113.10');
	});

	it('fails closed when the provider is unavailable', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
		await expect(turnstileService.verify(context(), 'browser-token')).rejects.toMatchObject({
			name: 'BizError',
			code: 503,
		});
	});

	it('rejects malformed provider responses without leaking parser errors', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
			ok: true,
			json: vi.fn().mockRejectedValue(new SyntaxError('unexpected token')),
		}));
		await expect(turnstileService.verify(context(), 'browser-token')).rejects.toMatchObject({
			name: 'BizError',
			code: 503,
		});
	});
});
