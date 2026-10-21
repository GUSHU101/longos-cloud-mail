import orm from '../entity/orm';
import regKey from '../entity/reg-key';
import { and, inArray, like, eq, desc, gte, lte, sql, or } from 'drizzle-orm';
import roleService from './role-service';
import BizError from '../error/biz-error';
import { formatDetailDate, toUtc } from '../utils/date-uitil';
import userService from './user-service';
import { t } from '../i18n/i18n.js';

export const REG_KEY_CODE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_REG_KEY_USES = 100_000;

export function normalizeRegKeyCode(code) {
	return typeof code === 'string' ? code.trim() : '';
}

const regKeyService = {

	async add(c, params, userId) {

		let {code, roleId, count, expireTime} = params || {};
		code = normalizeRegKeyCode(code);
		roleId = Number(roleId);
		count = Number(count);

		if (!code) {
			throw new BizError(t('emptyRegKey'));
		}

		if (!REG_KEY_CODE_PATTERN.test(code)) {
			throw new BizError(t('invalidRegKeyFormat'));
		}

		if (!Number.isSafeInteger(count) || count < 1 || count > MAX_REG_KEY_USES) {
			throw new BizError(t('invalidRegKeyCount'));
		}

		if (!expireTime) {
			throw new BizError(t('emptyRegKeyExpire'));
		}
		if (!toUtc(expireTime).isValid()) {
			throw new BizError(t('invalidRegKeyExpire'));
		}
		if (!Number.isSafeInteger(roleId) || roleId < 1) {
			throw new BizError(t('roleNotExist'));
		}

		const regKeyRow = await orm(c).select().from(regKey).where(eq(regKey.code, code)).get();

		if (regKeyRow) {
			throw new BizError(t('isExistRegKye'));
		}

		const roleRow = await roleService.selectById(c, roleId);
		if (!roleRow) {
			throw new BizError(t('roleNotExist'));
		}

		expireTime = formatDetailDate(expireTime)

		await orm(c).insert(regKey).values({code,roleId,count,userId,expireTime}).run();
	},

	async delete(c, params) {
		let {regKeyIds} = params || {};
		regKeyIds = String(regKeyIds || '').split(',')
			.map(id => Number(id))
			.filter(id => Number.isSafeInteger(id) && id > 0);
		if (regKeyIds.length === 0) return;
		await orm(c).delete(regKey).where(inArray(regKey.regKeyId,regKeyIds)).run();
	},

	async clearNotUse(c) {
		let now = formatDetailDate(toUtc().tz('Asia/Shanghai').startOf('day'))
		await orm(c).delete(regKey).where(or(lte(regKey.count, 0),sql`datetime(${regKey.expireTime}, '+8 hours') < datetime(${now})`)).run();
	},

	selectByCode(c, code) {
		return orm(c).select().from(regKey).where(eq(regKey.code, code)).get();
	},

	async list(c, params) {

		const {code} = params
		let query = orm(c).select().from(regKey)

		if (code) {
			query = query.where(like(regKey.code, `${code}%`))
		}

		const regKeyList = await query.orderBy(desc(regKey.regKeyId)).all();
		const roleList = await roleService.roleSelectUse(c);

		const today = toUtc().tz('Asia/Shanghai').startOf('day')

		regKeyList.forEach(regKeyRow => {

			const index = roleList.findIndex(roleRow => roleRow.roleId === regKeyRow.roleId)
			regKeyRow.roleName = index > -1 ? roleList[index].name : ''

			const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

			if (expireTime.isBefore(today)) {
				regKeyRow.expireTime = null
			}
		})

		return regKeyList;
	},

	async consume(c, code, count = 1) {
		code = normalizeRegKeyCode(code);
		if (!Number.isSafeInteger(count) || count < 1) {
			throw new BizError(t('invalidRegKeyCount'));
		}
		const result = await orm(c).update(regKey).set({
			count: sql`${regKey.count}
	  -
	  ${count}`
		}).where(and(eq(regKey.code, code), gte(regKey.count, count))).run();
		const changedRows = Number(result?.meta?.changes ?? result?.meta?.rows_written ?? 0);
		if (changedRows !== 1) {
			throw new BizError(t('noRegKeyTotal'));
		}
	},

	async history(c, params) {
		const { regKeyId } = params;
		return userService.listByRegKeyId(c, regKeyId);
	}
}

export default regKeyService;
