import { describe, expect, it, vi } from 'vitest';
import {
	MAX_PUBLIC_BATCH_USERS,
	boundedInteger,
	buildPublicUserStatements,
	normalizePublicBatch,
	optionalSearchValue,
} from '../src/service/public-service';
import emailUtils from '../src/utils/email-utils';

describe('public API input boundaries', () => {
	it('clamps pagination and rejects oversized search values', () => {
		expect(boundedInteger('500', 20, 1, 100)).toBe(100);
		expect(boundedInteger('not-a-number', 20, 1, 100)).toBe(20);
		expect(optionalSearchValue('hello', 10)).toBe('hello');
		expect(() => optionalSearchValue('too long', 3)).toThrow();
	});

	it('normalizes addresses and accepts array, JSON, or comma-separated domain settings', () => {
		expect(emailUtils.normalizeAddress(' Owner@Example.COM ')).toBe('owner@example.com');
		expect(emailUtils.isAllowedDomain('owner@example.com', ['EXAMPLE.COM'])).toBe(true);
		expect(emailUtils.isAllowedDomain('owner@example.com', '["example.com"]')).toBe(true);
		expect(emailUtils.isAllowedDomain('owner@example.net', 'example.com, example.net')).toBe(true);
		expect(emailUtils.isAllowedDomain('owner@outside.test', ['example.com'])).toBe(false);
	});

	it('normalizes users and rejects duplicate or excessive batches', () => {
		expect(normalizePublicBatch([{ email: ' Owner@Example.com ', password: 'secret1' }])).toEqual([
			{ email: 'owner@example.com', password: 'secret1', roleName: '' },
		]);
		expect(() => normalizePublicBatch([
			{ email: 'owner@example.com', password: 'secret1' },
			{ email: 'OWNER@example.com', password: 'secret2' },
		])).toThrow();
		expect(() => normalizePublicBatch(Array.from(
			{ length: MAX_PUBLIC_BATCH_USERS + 1 },
			(_, index) => ({ email: `user${index}@example.com`, password: 'secret1' })
		))).toThrow();
	});

	it('binds every user and request value instead of interpolating SQL', () => {
		const statements = [];
		const db = {
			prepare: vi.fn(sql => {
				const statement = {
					sql,
					values: [],
					bind: vi.fn((...values) => {
						statement.values = values;
						return statement;
					}),
				};
				statements.push(statement);
				return statement;
			}),
		};
		const injection = "Browser'); DROP TABLE user; --";

		buildPublicUserStatements({ env: { db } }, {
			email: 'safe@example.com',
			hash: 'hash',
			salt: 'salt',
			type: 1,
		}, {
			os: 'Windows',
			browser: injection,
			activeIp: '127.0.0.1',
			device: 'desktop',
			activeTime: '2026-01-01T00:00:00.000Z',
		});

		expect(statements).toHaveLength(2);
		expect(statements.every(statement => !statement.sql.includes(injection))).toBe(true);
		expect(statements[0].values).toContain(injection);
		expect(statements[0].sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
	});
});
