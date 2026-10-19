import BizError from '../error/biz-error';
import orm from '../entity/orm';
import { v4 as uuidv4 } from 'uuid';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import saltHashUtils from '../utils/crypto-utils';
import cryptoUtils from '../utils/crypto-utils';
import emailUtils from '../utils/email-utils';
import roleService from './role-service';
import verifyUtils from '../utils/verify-utils';
import { t } from '../i18n/i18n';
import reqUtils from '../utils/req-utils';
import dayjs from 'dayjs';
import { isDel, roleConst } from '../const/entity-const';
import email from '../entity/email';
import userService from './user-service';
import KvConst from '../const/kv-const';
import authRateLimitService from './auth-rate-limit-service';

const MAX_PUBLIC_PAGE_SIZE = 100;
const MAX_PUBLIC_BATCH_USERS = 20;

function boundedInteger(value, fallback, minimum, maximum) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) return fallback;
	return Math.min(maximum, Math.max(minimum, parsed));
}

function optionalSearchValue(value, maximumLength = 500) {
	if (value === undefined || value === null || value === '') return '';
	if (typeof value !== 'string' || value.length > maximumLength) {
		throw new BizError('Invalid search value');
	}
	return value;
}

function normalizePublicBatch(list) {
	if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PUBLIC_BATCH_USERS) {
		throw new BizError(`User list must contain between 1 and ${MAX_PUBLIC_BATCH_USERS} entries`);
	}

	const seen = new Set();
	return list.map((item, index) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new BizError(`Invalid user at index ${index}`);
		}
		const email = emailUtils.normalizeAddress(item.email);
		if (!verifyUtils.isEmail(email)) throw new BizError(t('notEmail'));
		if (seen.has(email)) throw new BizError(t('emailExistDatabase'));
		seen.add(email);

		let password = item.password;
		if (password === undefined || password === null || password === '') {
			password = cryptoUtils.genRandomPwd();
		}
		if (typeof password !== 'string' || password.length < 6 || password.length > 30) {
			throw new BizError(password?.length > 30 ? t('pwdLengthLimit') : t('pwdMinLength'));
		}

		const roleName = item.roleName === undefined || item.roleName === null
			? ''
			: String(item.roleName).trim();
		if (roleName.length > 100) throw new BizError('Role name is too long');
		return { email, password, roleName };
	});
}

function buildPublicUserStatements(c, row, metadata) {
	const userStatement = c.env.db.prepare(`
		INSERT INTO user (email, password, salt, type, os, browser, active_ip, create_ip, device, active_time, create_time)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).bind(
		row.email,
		row.hash,
		row.salt,
		row.type,
		metadata.os,
		metadata.browser,
		metadata.activeIp,
		metadata.activeIp,
		metadata.device,
		metadata.activeTime,
		metadata.activeTime
	);
	const accountStatement = c.env.db.prepare(`
		INSERT INTO account (email, name, user_id)
		SELECT ?, ?, user_id FROM user
		WHERE email COLLATE NOCASE = ?
		ORDER BY user_id DESC LIMIT 1
	`).bind(row.email, emailUtils.getName(row.email), row.email);
	return [userStatement, accountStatement];
}

const publicService = {

	async emailList(c, params = {}) {

		let { toEmail, content, subject, sendName, sendEmail, timeSort, num, size, type , isDel } = params
		toEmail = optionalSearchValue(toEmail, 320);
		sendEmail = optionalSearchValue(sendEmail, 320);
		sendName = optionalSearchValue(sendName, 200);
		subject = optionalSearchValue(subject, 998);
		content = optionalSearchValue(content, 2_000);

		const query = orm(c).select({
				emailId: email.emailId,
				sendEmail: email.sendEmail,
				sendName: email.name,
				subject: email.subject,
				toEmail: email.toEmail,
				toName: email.toName,
				type: email.type,
				createTime: email.createTime,
				content: email.content,
				text: email.text,
				isDel: email.isDel,
		}).from(email)

		size = boundedInteger(size, 20, 1, MAX_PUBLIC_PAGE_SIZE);
		num = boundedInteger(num, 1, 1, 1_000_000);
		const offset = (num - 1) * size;

		let conditions = []

		if (toEmail) {
			conditions.push(sql`${email.toEmail} COLLATE NOCASE LIKE ${toEmail}`)
		}

		if (sendEmail) {
			conditions.push(sql`${email.sendEmail} COLLATE NOCASE LIKE ${sendEmail}`)
		}

		if (sendName) {
			conditions.push(sql`${email.name} COLLATE NOCASE LIKE ${sendName}`)
		}

		if (subject) {
			conditions.push(sql`${email.subject} COLLATE NOCASE LIKE ${subject}`)
		}

		if (content) {
			conditions.push(sql`${email.content} COLLATE NOCASE LIKE ${content}`)
		}

		if (type !== undefined && type !== null && type !== '') {
			type = Number(type);
			if (![0, 1].includes(type)) throw new BizError('Invalid email type');
			conditions.push(eq(email.type, type))
		}

		if (isDel !== undefined && isDel !== null && isDel !== '') {
			isDel = Number(isDel);
			if (![0, 1].includes(isDel)) throw new BizError('Invalid deletion status');
			conditions.push(eq(email.isDel, isDel))
		}

		if (conditions.length === 1) {
			query.where(...conditions)
		} else if (conditions.length > 1) {
			query.where(and(...conditions))
		}

		if (timeSort === 'asc') {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		return query.limit(size).offset(offset);

	},

	async addUser(c, params) {
		const list = normalizePublicBatch(params?.list);
		for (const row of list) {
			if (!emailUtils.isAllowedDomain(row.email, c.env.domain)) {
				throw new BizError(t('notEmailDomain'));
			}
		}


		const activeIp = reqUtils.getIp(c);
		const { os, browser, device } = reqUtils.getUserAgent(c);
		const activeTime = dayjs().format('YYYY-MM-DD HH:mm:ss');

		const roleList = await roleService.roleSelectUse(c);
		const defRole = roleList.find(roleRow => roleRow.isDefault === roleConst.isDefault.OPEN);
		if (!defRole) throw new BizError(t('roleNotExist'));

		const userList = [];
		const hashedRows = await Promise.all(list.map(async row => {
			const roleRow = row.roleName ? roleList.find(role => role.name === row.roleName) : defRole;
			if (!roleRow) throw new BizError(t('roleNotExist'));
			const { salt, hash } = await saltHashUtils.hashPassword(row.password);
			return { ...row, salt, hash, type: roleRow.roleId };
		}));

		for (const row of hashedRows) {
			userList.push(...buildPublicUserStatements(c, row, { activeIp, os, browser, device, activeTime }));
		}

		try {
			await c.env.db.batch(userList);
		} catch (e) {
			if(String(e?.message || '').includes('SQLITE_CONSTRAINT')) {
				throw new BizError(t('emailExistDatabase'))
			} else {
				throw e
			}
		}

	},

	async genToken(c, params) {

		await this.verifyUser(c, params)

		const uuid = uuidv4();

		await c.env.kv.put(KvConst.PUBLIC_KEY, uuid);

		return {token: uuid}
	},

	async verifyUser(c, params) {

		const email = emailUtils.normalizeAddress(params?.email);
		const password = params?.password;
		const admin = emailUtils.normalizeAddress(c.env.admin);
		await authRateLimitService.assertAllowed(c, `public:${email}`);

		const userRow = await userService.selectByEmailIncludeDel(c, email);

		if (email !== admin) {
			await authRateLimitService.recordFailure(c, `public:${email}`);
			throw new BizError(t('notAdmin'));
		}

		if (!userRow || userRow.isDel === isDel.DELETE) {
			await authRateLimitService.recordFailure(c, `public:${email}`);
			throw new BizError(t('notExistUser'));
		}

		if (typeof password !== 'string' || !await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
			await authRateLimitService.recordFailure(c, `public:${email}`);
			throw new BizError(t('IncorrectPwd'));
		}
		await authRateLimitService.clear(c, `public:${email}`);

		if (cryptoUtils.needsRehash(userRow.password)) {
			const { salt, hash } = await cryptoUtils.hashPassword(password);
			await userService.updatePasswordHash(c, userRow.userId, hash, salt);
		}
	}

}

export {
	MAX_PUBLIC_BATCH_USERS,
	MAX_PUBLIC_PAGE_SIZE,
	boundedInteger,
	buildPublicUserStatements,
	normalizePublicBatch,
	optionalSearchValue,
};
export default publicService
