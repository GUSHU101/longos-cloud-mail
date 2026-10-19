import BizError from "../error/biz-error";
import orm from "../entity/orm";
import {oauth} from "../entity/oauth";
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import userService from "./user-service";
import loginService from "./login-service";
import cryptoUtils from "../utils/crypto-utils";
import settingService from "./setting-service";
import {t} from '../i18n/i18n';
import KvConst from '../const/kv-const';

const OAUTH_BIND_TTL_SECONDS = 10 * 60;
const OAUTH_RESERVATION_TTL_SECONDS = 15 * 60;
const OAUTH_FETCH_TIMEOUT_MS = 15_000;
const OAUTH_PLATFORMS = new Set(['linuxdo', 'github', 'google']);

function oauthCallbackParams(c, params = {}) {
	const code = typeof params.code === 'string' ? params.code.trim() : '';
	if (!code || code.length > 4096) {
		throw new BizError('Invalid OAuth authorization code');
	}

	let redirectUrl;
	try {
		redirectUrl = new URL(params.redirectUri);
	} catch {
		throw new BizError('Invalid OAuth redirect URI');
	}

	const requestOrigin = new URL(c.req.url).origin;
	if (redirectUrl.origin !== requestOrigin || redirectUrl.pathname !== '/login' || redirectUrl.search || redirectUrl.hash) {
		throw new BizError('OAuth redirect URI must be the current site login page');
	}

	return { code, redirectUri: redirectUrl.toString() };
}

function oauthFetch(url, options = {}) {
	return fetch(url, {
		...options,
		signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
	});
}

function oauthRecord(userInfo) {
	const platform = String(userInfo?.platform || '').toLowerCase();
	const oauthUserId = String(userInfo?.oauthUserId || '').trim();
	if (!OAUTH_PLATFORMS.has(platform) || !oauthUserId || oauthUserId.length > 255) {
		throw new BizError('Invalid OAuth identity');
	}

	const clean = (value, maximum = 255) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maximum);
	return {
		oauthUserId,
		platform,
		username: clean(userInfo.username),
		name: clean(userInfo.name),
		avatar: clean(userInfo.avatar, 2048),
		active: Number(userInfo.active) || 0,
		trustLevel: Number(userInfo.trustLevel) || 0,
		silenced: Number(userInfo.silenced) || 0,
	};
}

const oauthService = {

	async bindUser(c, params) {

		const { email, code } = params || {};
		const bindToken = typeof params?.bindToken === 'string' ? params.bindToken.trim() : '';
		if (!/^[A-Za-z0-9_-]{32,160}$/.test(bindToken)) {
			throw new BizError('OAuth binding authorization is invalid or expired', 401);
		}

		const ticketKey = KvConst.OAUTH_BIND + bindToken;
		const ticket = await c.env.kv.get(ticketKey, { type: 'json' });
		if (!ticket || !Number.isSafeInteger(ticket.oauthId)) {
			throw new BizError('OAuth binding authorization is invalid or expired', 401);
		}

		const reserved = await orm(c).update(oauth)
			.set({ userId: -1, createTime: sql`CURRENT_TIMESTAMP` })
			.where(and(eq(oauth.oauthId, ticket.oauthId), eq(oauth.userId, 0)))
			.returning().get();
		if (!reserved) {
			await c.env.kv.delete(ticketKey);
			throw new BizError('OAuth identity is already bound or being processed', 409);
		}

		await c.env.kv.delete(ticketKey);
		try {
			await loginService.register(c, { email, password: cryptoUtils.genRandomPwd(), code }, true);
			const userRow = await userService.selectByEmail(c, email);
			if (!userRow) throw new BizError('OAuth mailbox registration failed');

			const oauthRow = await orm(c).update(oauth)
				.set({ userId: userRow.userId })
				.where(and(eq(oauth.oauthId, ticket.oauthId), eq(oauth.userId, -1)))
				.returning().get();
			if (!oauthRow) throw new BizError('OAuth identity binding failed', 409);

			const jwtToken = await loginService.login(c, { email, password: null }, true);
			return { userInfo: oauthRow, token: jwtToken };
		} catch (error) {
			await orm(c).update(oauth).set({ userId: 0, createTime: sql`CURRENT_TIMESTAMP` })
				.where(and(eq(oauth.oauthId, ticket.oauthId), eq(oauth.userId, -1))).run();
			throw error;
		}
	},

	async linuxDoLogin(c, params) {

		const { code, redirectUri } = oauthCallbackParams(c, params);

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'linuxdoSwitch');

		const reqParams = new URLSearchParams()
		reqParams.append('client_id', setting.linuxdoClientId)
		reqParams.append('client_secret', setting.linuxdoClientSecret)
		reqParams.append('code', code)
		reqParams.append('redirect_uri', redirectUri)
		reqParams.append('grant_type', 'authorization_code')

		const tokenRes = await oauthFetch("https://connect.linux.do/oauth2/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: reqParams.toString()
		})

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText)
		}

		const token = await tokenRes.json()

		const userRes = await oauthFetch('https://connect.linux.do/api/user', {
			headers: {
				Authorization: 'Bearer ' + token.access_token
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText)
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.id);
		userInfo.active = userInfo.active ? 0 : 1;
		userInfo.silenced = userInfo.silenced ? 0 : 1;
		userInfo.trustLevel = userInfo.trust_level;
		userInfo.avatar = userInfo.avatar_url;
		userInfo.platform = 'linuxdo';

		return await this.saveAndLogin(c, userInfo)
	},

	async githubLogin(c, params) {

		const { code, redirectUri } = oauthCallbackParams(c, params);

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'githubSwitch');

		const tokenRes = await oauthFetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Accept": "application/json"
			},
			body: JSON.stringify({
				client_id: setting.githubClientId,
				client_secret: setting.githubClientSecret,
				code: code,
				redirect_uri: redirectUri
			})
		});

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText);
		}

		const token = await tokenRes.json();

		if (token.error) {
			throw new BizError(token.error_description || token.error);
		}

		const userRes = await oauthFetch('https://api.github.com/user', {
			headers: {
				Authorization: 'Bearer ' + token.access_token,
				'User-Agent': 'cloud-mail'
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText);
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.id);
		userInfo.username = userInfo.login;
		userInfo.avatar = userInfo.avatar_url;
		userInfo.platform = 'github';

		return await this.saveAndLogin(c, userInfo);
	},

	async googleLogin(c, params) {

		const { code, redirectUri } = oauthCallbackParams(c, params);

		const setting = await settingService.query(c);
		this.assertEnabled(setting, 'googleSwitch');

		const reqParams = new URLSearchParams()
		reqParams.append('client_id', setting.googleClientId)
		reqParams.append('client_secret', setting.googleClientSecret)
		reqParams.append('code', code)
		reqParams.append('redirect_uri', redirectUri)
		reqParams.append('grant_type', 'authorization_code')

		const tokenRes = await oauthFetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: reqParams.toString()
		});

		if (!tokenRes.ok) {
			throw new BizError(tokenRes.statusText);
		}

		const token = await tokenRes.json();

		const userRes = await oauthFetch('https://openidconnect.googleapis.com/v1/userinfo', {
			headers: {
				Authorization: 'Bearer ' + token.access_token
			}
		});

		if (!userRes.ok) {
			throw new BizError(userRes.statusText);
		}

		const userInfo = await userRes.json();

		userInfo.oauthUserId = String(userInfo.sub);
		userInfo.username = userInfo.email;
		userInfo.name = userInfo.name;
		userInfo.avatar = userInfo.picture;
		userInfo.platform = 'google';

		return await this.saveAndLogin(c, userInfo);
	},

	async saveAndLogin(c, userInfo) {

		const oauthRow = await this.saveUser(c, userInfo);
		const userRow = await userService.selectByIdIncludeDel(c, oauthRow.userId);

		if (!userRow) {
			if (oauthRow.userId !== 0) {
				throw new BizError('OAuth identity binding is already in progress', 409);
			}
			const refreshedOauthRow = await orm(c).update(oauth)
				.set({ createTime: sql`CURRENT_TIMESTAMP` })
				.where(and(eq(oauth.oauthId, oauthRow.oauthId), eq(oauth.userId, 0)))
				.returning().get();
			if (!refreshedOauthRow) {
				throw new BizError('OAuth identity binding is already in progress', 409);
			}
			const bindToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
			await c.env.kv.put(
				KvConst.OAUTH_BIND + bindToken,
				JSON.stringify({ oauthId: refreshedOauthRow.oauthId }),
				{ expirationTtl: OAUTH_BIND_TTL_SECONDS },
			);
			return { userInfo: oauthRow, token: null, bindToken };
		}

		const JwtToken = await loginService.login(c, { email: userRow.email, password: null }, true);
		return { userInfo: oauthRow, token: JwtToken };
	},

	async saveUser(c, userInfo) {
		const record = oauthRecord(userInfo);
		const userInfoRow = await this.getById(c, record.oauthUserId, record.platform);

		if (!userInfoRow) {
			try {
				return await orm(c).insert(oauth).values(record).returning().get();
			} catch (error) {
				if (!String(error?.message || '').includes('SQLITE_CONSTRAINT')) throw error;
				return await this.getById(c, record.oauthUserId, record.platform);
			}
		} else {
			return await orm(c).update(oauth).set(record)
				.where(and(eq(oauth.oauthUserId, record.oauthUserId), eq(oauth.platform, record.platform)))
				.returning().get();
		}

	},

	assertEnabled(setting, switchKey) {
		if (setting[switchKey] !== 0) {
			throw new BizError(t('oauthDisabled'));
		}
	},

	async getById(c, oauthUserId, platform) {
		if (!oauthUserId || !OAUTH_PLATFORMS.has(platform)) return null;
		return await orm(c).select().from(oauth).where(and(
			eq(oauth.oauthUserId, oauthUserId),
			eq(oauth.platform, platform),
		)).get();
	},

	async deleteByUserId(c, userId) {
		await this.deleteByUserIds(c, [userId]);
	},

	async deleteByUserIds(c, userIds) {
		await orm(c).delete(oauth).where(inArray(oauth.userId, userIds)).run();
	},

	//定时任务凌晨清除未绑定邮箱的oauth用户
	async clearNoBindOathUser(c) {
		const toSqliteTime = milliseconds => new Date(Date.now() - milliseconds)
			.toISOString().slice(0, 19).replace('T', ' ');
		await orm(c).delete(oauth).where(or(
			and(
				eq(oauth.userId, 0),
				lte(oauth.createTime, toSqliteTime(OAUTH_BIND_TTL_SECONDS * 1000)),
			),
			and(
				eq(oauth.userId, -1),
				lte(oauth.createTime, toSqliteTime(OAUTH_RESERVATION_TTL_SECONDS * 1000)),
			),
		)).run();
	},

}

export {
	OAUTH_BIND_TTL_SECONDS,
	OAUTH_RESERVATION_TTL_SECONDS,
	oauthCallbackParams,
	oauthRecord,
};
export default oauthService
