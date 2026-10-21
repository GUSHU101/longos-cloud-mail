import {readFileSync} from 'node:fs';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	get: vi.fn(),
	roleById: vi.fn(),
}));

vi.mock('../src/entity/orm', () => ({
	default: vi.fn(() => ({
		select: () => ({
			from: () => ({
				where: () => ({get: mocks.get}),
			}),
		}),
		insert: () => ({values: () => ({run: mocks.run})}),
		update: () => ({set: () => ({where: () => ({run: mocks.run})})}),
	})),
}));
vi.mock('../src/service/role-service', () => ({
	default: {selectById: mocks.roleById},
}));
vi.mock('../src/i18n/i18n', () => ({t: key => key}));

import regKeyService, {
	MAX_REG_KEY_USES,
	normalizeRegKeyCode,
} from '../src/service/reg-key-service';

describe('invite code integrity', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.get.mockResolvedValue(null);
		mocks.roleById.mockResolvedValue({roleId: 2});
		mocks.run.mockResolvedValue({meta: {changes: 1}});
	});

	it('normalizes codes and validates administrative input', async () => {
		expect(normalizeRegKeyCode('  Safe_Code-2026  ')).toBe('Safe_Code-2026');
		await expect(regKeyService.add({}, {
			code: ' Safe_Code-2026 ',
			roleId: 2,
			count: MAX_REG_KEY_USES,
			expireTime: '2030-01-01 00:00:00',
		}, 1)).resolves.toBeUndefined();
		expect(mocks.roleById).toHaveBeenCalledWith({}, 2);

		await expect(regKeyService.add({}, {
			code: 'short', roleId: 2, count: 1, expireTime: '2030-01-01',
		}, 1)).rejects.toMatchObject({message: 'invalidRegKeyFormat'});
		await expect(regKeyService.add({}, {
			code: 'ValidCode2026', roleId: 2, count: MAX_REG_KEY_USES + 1, expireTime: '2030-01-01',
		}, 1)).rejects.toMatchObject({message: 'invalidRegKeyCount'});
	});

	it('awaits role validation before inserting a code', async () => {
		mocks.roleById.mockResolvedValue(null);
		await expect(regKeyService.add({}, {
			code: 'ValidCode2026', roleId: 999, count: 1, expireTime: '2030-01-01',
		}, 1)).rejects.toMatchObject({message: 'roleNotExist'});
		expect(mocks.run).not.toHaveBeenCalled();
	});

	it('fails closed when a concurrent request spends the final use first', async () => {
		mocks.run.mockResolvedValue({meta: {changes: 0}});
		await expect(regKeyService.consume({}, 'ValidCode2026', 1))
			.rejects.toMatchObject({message: 'noRegKeyTotal'});
	});

	it('reserves a code before account creation', () => {
		const source = readFileSync(new URL('../src/service/login-service.js', import.meta.url), 'utf8');
		expect(source.indexOf('regKeyService.consume(c, code, 1)'))
			.toBeLessThan(source.indexOf('userService.insert(c'));
		expect(source).not.toMatch(/reduceCount/);
	});
});
