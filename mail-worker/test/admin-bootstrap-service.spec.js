import { describe, expect, it, vi } from 'vitest';
import {
	bootstrapAdmin,
	validateAdminPassword,
} from '../src/service/admin-bootstrap-service';

function statement(sql, firstValue) {
	return {
		sql,
		values: [],
		bind(...values) {
			this.values = values;
			return this;
		},
		first: vi.fn(async () => firstValue),
		run: vi.fn(async () => ({ success: true })),
	};
}

describe('administrator bootstrap', () => {
	it('requires a deployment-grade password for a new administrator', () => {
		expect(() => validateAdminPassword('too-short')).toThrow(/至少需要 12/);
		expect(() => validateAdminPassword('x'.repeat(31))).toThrow(/不能超过 30/);
		expect(() => validateAdminPassword('valid passphrase 1')).not.toThrow();
	});

	it('keeps the password of an existing administrator unchanged', async () => {
		const prepared = [];
		const values = [
			{ user_id: 7, is_del: 0 },
			{ account_id: 8, user_id: 7, is_del: 0 },
		];
		const c = {
			env: {
				admin: 'Admin@Example.com',
				domain: '["example.com"]',
				db: {
					prepare: vi.fn(sql => {
						const item = statement(sql, values.shift());
						prepared.push(item);
						return item;
					}),
					batch: vi.fn(),
				},
			},
		};

		await expect(bootstrapAdmin(c, '')).resolves.toEqual({
			status: 'existing',
			email: 'admin@example.com',
		});
		expect(c.env.db.batch).not.toHaveBeenCalled();
		expect(prepared).toHaveLength(2);
	});

	it('hashes and creates a missing administrator and primary account atomically', async () => {
		const prepared = [];
		let selectIndex = 0;
		const selectValues = [null, { role_id: 1 }];
		const c = {
			env: {
				admin: 'admin@example.com',
				domain: 'example.com',
				db: {
					prepare: vi.fn(sql => {
						const isSelect = /^\s*SELECT/i.test(sql);
						const item = statement(sql, isSelect ? selectValues[selectIndex++] : undefined);
						prepared.push(item);
						return item;
					}),
					batch: vi.fn(async () => [{ success: true }, { success: true }]),
				},
			},
		};

		await expect(bootstrapAdmin(c, 'correct horse battery')).resolves.toEqual({
			status: 'created',
			email: 'admin@example.com',
		});
		expect(c.env.db.batch).toHaveBeenCalledTimes(1);
		const [userInsert, accountInsert] = c.env.db.batch.mock.calls[0][0];
		expect(userInsert.sql).toMatch(/INSERT INTO user/);
		expect(userInsert.values[1]).toMatch(/^pbkdf2-sha256\$/);
		expect(userInsert.values).not.toContain('correct horse battery');
		expect(accountInsert.sql).toMatch(/INSERT INTO account/);
	});
});
