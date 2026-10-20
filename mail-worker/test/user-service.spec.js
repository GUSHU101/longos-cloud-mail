import { describe, expect, it, vi } from 'vitest';
import userService from '../src/service/user-service';

function quotaDatabase({ reserved = null } = {}) {
	const first = vi.fn(async () => reserved);
	const run = vi.fn(async () => ({ success: true }));
	const bind = vi.fn(() => ({ first, run }));
	const prepare = vi.fn(() => ({ bind }));
	return { context: { env: { db: { prepare } } }, prepare, bind, first, run };
}

describe('atomic outbound quota', () => {
	it('reserves all recipients with one conditional update', async () => {
		const database = quotaDatabase({ reserved: { send_count: 9 } });

		await expect(userService.reserveUserSendCount(database.context, 3, 7, 10)).resolves.toBe(true);
		expect(database.prepare).toHaveBeenCalledOnce();
		expect(database.prepare.mock.calls[0][0]).toContain('CAST(send_count AS INTEGER) + ? <= ?');
		expect(database.bind).toHaveBeenCalledWith(3, 7, 3, 10);
	});

	it('rejects a reservation when the conditional update matches no user', async () => {
		const database = quotaDatabase();

		await expect(userService.reserveUserSendCount(database.context, 2, 7, 10)).resolves.toBe(false);
	});

	it('releases an unused reservation without allowing a negative counter', async () => {
		const database = quotaDatabase();

		await userService.releaseUserSendCount(database.context, 4, 7);
		expect(database.prepare.mock.calls[0][0]).toContain('MAX(0, CAST(send_count AS INTEGER) - ?)');
		expect(database.bind).toHaveBeenCalledWith(4, 7);
		expect(database.run).toHaveBeenCalledOnce();
	});
});
