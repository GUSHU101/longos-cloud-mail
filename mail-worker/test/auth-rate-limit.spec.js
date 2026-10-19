import { describe, expect, it } from 'vitest';
import authRateLimitService, { AUTH_FAILURE_LIMIT, failureKey } from '../src/service/auth-rate-limit-service';

function context(ip = '203.0.113.10') {
	const values = new Map();
	return {
		values,
		c: {
			req: { header: name => name.toLowerCase() === 'cf-connecting-ip' ? ip : '' },
			env: {
				kv: {
					get: key => values.get(key) ?? null,
					put: (key, value) => values.set(key, value),
					delete: key => values.delete(key),
				},
			},
		},
	};
}

describe('authentication failure limiter', () => {
	it('scopes failures by IP and identity, then clears on success', async () => {
		const { c, values } = context();
		const key = await failureKey(c, 'Admin@Example.com');
		for (let index = 0; index < AUTH_FAILURE_LIMIT; index += 1) {
			await authRateLimitService.recordFailure(c, 'admin@example.com');
		}
		expect(Number(values.get(key))).toBe(AUTH_FAILURE_LIMIT);
		await expect(authRateLimitService.assertAllowed(c, 'admin@example.com')).rejects.toMatchObject({ code: 429 });

		await authRateLimitService.clear(c, 'admin@example.com');
		await expect(authRateLimitService.assertAllowed(c, 'admin@example.com')).resolves.toBe(key);
	});

	it('does not share a failure bucket across client addresses', async () => {
		const first = context('203.0.113.10').c;
		const second = context('203.0.113.11').c;
		expect(await failureKey(first, 'admin@example.com')).not.toBe(await failureKey(second, 'admin@example.com'));
	});
});
