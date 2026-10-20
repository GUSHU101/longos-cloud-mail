import { describe, expect, it, vi } from 'vitest';
import { readiness } from '../src/api/health-api';

describe('worker readiness', () => {
	it('checks both the required D1 row and KV binding', async () => {
		const first = vi.fn(async () => ({ count: 1 }));
		const get = vi.fn(async () => null);
		const result = await readiness({
			env: {
				db: { prepare: () => ({ first }) },
				kv: { get },
			},
		});

		expect(result.status).toBe('ok');
		expect(result.checks).toEqual({ database: 'ok', kv: 'ok' });
		expect(first).toHaveBeenCalledOnce();
		expect(get).toHaveBeenCalledWith('__longos_health_probe__');
	});

	it('fails closed when required schema state is missing', async () => {
		await expect(readiness({
			env: {
				db: { prepare: () => ({ first: async () => ({ count: 0 }) }) },
				kv: { get: async () => null },
			},
		})).rejects.toThrow('Required setting row is missing');
	});
});
