import { describe, expect, it, vi } from 'vitest';
import {
	constantTimeEqual,
	isAuthorizedInitRequest,
	runIdempotentSchemaStatements,
} from '../src/init/init';

function context(secret, authorization) {
	return {
		env: { jwt_secret: secret },
		req: { header: name => name === 'authorization' ? authorization : '' },
	};
}

describe('database initialization authorization', () => {
	it('accepts only an exact URL-safe bearer secret', () => {
		const secret = '0123456789abcdef0123456789abcdef';
		expect(isAuthorizedInitRequest(context(secret, `Bearer ${secret}`))).toBe(true);
		expect(isAuthorizedInitRequest(context(secret, secret))).toBe(false);
		expect(isAuthorizedInitRequest(context(secret, `Bearer ${secret}x`))).toBe(false);
	});

	it('fails closed when the configured secret is missing or too short', () => {
		expect(isAuthorizedInitRequest(context('', 'Bearer 0123456789abcdef0123456789abcdef'))).toBe(false);
		expect(isAuthorizedInitRequest(context('short', 'Bearer short'))).toBe(false);
	});

	it('compares values without accepting unequal lengths', () => {
		expect(constantTimeEqual('same-value', 'same-value')).toBe(true);
		expect(constantTimeEqual('same-value', 'same-value-longer')).toBe(false);
	});

	it('skips only expected duplicate schema errors', async () => {
		const runs = [];
		const c = {
			env: {
				db: {
					prepare: statement => ({
						run: async () => {
							runs.push(statement);
							if (statement === 'duplicate') throw new Error('duplicate column name: example');
						},
					}),
				},
			},
		};
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});

		await runIdempotentSchemaStatements(c, ['duplicate', 'next']);

		expect(runs).toEqual(['duplicate', 'next']);
		info.mockRestore();
	});

	it('fails closed on operational migration errors', async () => {
		const c = {
			env: {
				db: {
					prepare: () => ({ run: async () => { throw new Error('database unavailable'); } }),
				},
			},
		};

		await expect(runIdempotentSchemaStatements(c, ['statement'])).rejects.toThrow('database unavailable');
	});
});
