import BizError from '../error/biz-error';
import emailUtils from '../utils/email-utils';
import cryptoUtils from '../utils/crypto-utils';
import verifyUtils from '../utils/verify-utils';

const MIN_ADMIN_PASSWORD_LENGTH = 12;
const MAX_ADMIN_PASSWORD_LENGTH = 30;

function validateAdminPassword(password) {
	if (typeof password !== 'string' || password.length < MIN_ADMIN_PASSWORD_LENGTH) {
		throw new BizError(`管理员密码至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 个字符`, 400);
	}
	if (password.length > MAX_ADMIN_PASSWORD_LENGTH) {
		throw new BizError(`管理员密码不能超过 ${MAX_ADMIN_PASSWORD_LENGTH} 个字符`, 400);
	}
	if (/\p{Cc}/u.test(password)) {
		throw new BizError('管理员密码不能包含控制字符', 400);
	}
	return password;
}

async function ensureAdminAccount(c, userId, adminEmail) {
	const account = await c.env.db.prepare(`
		SELECT account_id, user_id, is_del
		FROM account
		WHERE email COLLATE NOCASE = ?
		LIMIT 1
	`).bind(adminEmail).first();

	if (account) {
		if (Number(account.user_id) !== Number(userId) || Number(account.is_del) !== 0) {
			throw new BizError('管理员邮箱已被已删除或其他账户占用，请先在 D1 中处理该冲突', 409);
		}
		return false;
	}

	await c.env.db.prepare(`
		INSERT INTO account (email, name, user_id)
		VALUES (?, ?, ?)
	`).bind(adminEmail, emailUtils.getName(adminEmail), userId).run();
	return true;
}

async function bootstrapAdmin(c, password) {
	const adminEmail = emailUtils.normalizeAddress(c.env.admin);
	if (!verifyUtils.isEmail(adminEmail) || !emailUtils.isAllowedDomain(adminEmail, c.env.domain)) {
		throw new BizError('ADMIN 必须是 DOMAIN 收件域中的有效管理员邮箱', 400);
	}

	const existing = await c.env.db.prepare(`
		SELECT user_id, is_del
		FROM user
		WHERE email COLLATE NOCASE = ?
		LIMIT 1
	`).bind(adminEmail).first();

	if (existing) {
		if (Number(existing.is_del) !== 0) {
			throw new BizError('管理员用户已被删除；请先恢复该用户或更换 ADMIN', 409);
		}
		const repairedAccount = await ensureAdminAccount(c, existing.user_id, adminEmail);
		return { status: repairedAccount ? 'existing-account-repaired' : 'existing', email: adminEmail };
	}

	validateAdminPassword(password);
	const defaultRole = await c.env.db.prepare(`
		SELECT role_id
		FROM role
		WHERE is_default = 1
		ORDER BY role_id
		LIMIT 1
	`).first();
	if (!defaultRole?.role_id) {
		throw new BizError('数据库没有默认角色，无法创建管理员', 500);
	}

	const { salt, hash } = await cryptoUtils.hashPassword(password);
	await c.env.db.batch([
		c.env.db.prepare(`
			INSERT INTO user (email, password, salt, type)
			VALUES (?, ?, ?, ?)
		`).bind(adminEmail, hash, salt, defaultRole.role_id),
		c.env.db.prepare(`
			INSERT INTO account (email, name, user_id)
			SELECT ?, ?, user_id
			FROM user
			WHERE email COLLATE NOCASE = ?
			ORDER BY user_id DESC
			LIMIT 1
		`).bind(adminEmail, emailUtils.getName(adminEmail), adminEmail),
	]);

	return { status: 'created', email: adminEmail };
}

export {
	MAX_ADMIN_PASSWORD_LENGTH,
	MIN_ADMIN_PASSWORD_LENGTH,
	bootstrapAdmin,
	ensureAdminAccount,
	validateAdminPassword,
};

export default { bootstrapAdmin };
