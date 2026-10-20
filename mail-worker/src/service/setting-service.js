import KvConst from '../const/kv-const';
import setting from '../entity/setting';
import orm from '../entity/orm';
import {verifyRecordType} from '../const/entity-const';
import fileUtils from '../utils/file-utils';
import r2Service from './r2-service';
import constant from '../const/constant';
import BizError from '../error/biz-error';
import {t} from '../i18n/i18n'
import verifyRecordService from './verify-record-service';
import userContext from '../security/user-context';
import { normalizePublicBaseUrl, normalizePublicImageUrl, normalizeWebhookUrl } from '../utils/domain-uitls';

const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024;
const BACKGROUND_IMAGE_TYPES = new Set([
	'image/gif',
	'image/jpeg',
	'image/png',
	'image/webp',
]);
const MUTABLE_SETTING_FIELDS = new Set([
	'register', 'receive', 'title', 'manyEmail', 'addEmail', 'autoRefresh',
	'addEmailVerify', 'registerVerify', 'regVerifyCount', 'addVerifyCount', 'send',
	'r2Domain', 'secretKey', 'siteKey', 'regKey', 'tgBotToken', 'tgChatId',
	'tgBotStatus', 'forwardEmail', 'forwardStatus', 'ruleEmail', 'ruleType',
	'loginOpacity', 'resendTokens', 'mailEngine', 'relayUrl', 'noticeTitle',
	'noticeContent', 'noticeType', 'noticeDuration', 'noticePosition', 'noticeOffset',
	'noticeWidth', 'notice', 'noRecipient', 'loginDomain', 'bucket', 'region',
	'endpoint', 's3AccessKey', 's3SecretKey', 'forcePathStyle', 'customDomain',
	'tgMsgFrom', 'tgMsgTo', 'tgMsgText', 'minEmailPrefix', 'emailPrefixFilter',
	'blackSubject', 'blackContent', 'blackFrom', 'aiCode', 'syncDelete',
	'aiCodeFilter', 'linuxdoClientId', 'linuxdoClientSecret', 'linuxdoSwitch',
	'githubClientId', 'githubClientSecret', 'githubSwitch', 'googleClientId',
	'googleClientSecret', 'googleSwitch', 'autoCleanDays', 'autoCleanExclude',
	'webhookUrl', 'webhookStatus', 'webhookRetry', 'webhookSecret',
]);
const BOOLEAN_SETTING_FIELDS = [
	'register', 'receive', 'manyEmail', 'addEmail', 'addEmailVerify', 'registerVerify',
	'send', 'regKey', 'tgBotStatus', 'forwardStatus', 'notice', 'noRecipient',
	'loginDomain', 'forcePathStyle', 'aiCode', 'syncDelete', 'linuxdoSwitch',
	'githubSwitch', 'googleSwitch', 'webhookStatus',
];

const SENSITIVE_SETTING_FIELDS = [
	'secretKey',
	'tgBotToken',
	's3AccessKey',
	's3SecretKey',
	'linuxdoClientSecret',
	'githubClientSecret',
	'googleClientSecret',
	'webhookSecret',
];

function isMaskedSecret(value) {
	return typeof value === 'string' && value.endsWith('******');
}

function maskSecret(value, visible = 6) {
	return value ? `${String(value).slice(0, visible)}******` : null;
}

function normalizeRelayUrl(value) {
	const normalized = String(value || '').trim().replace(/\/+$/, '');
	if (!normalized) return '';

	let relayUrl;
	try {
		relayUrl = new URL(normalized);
	} catch {
		throw new BizError('Invalid self-hosted relay URL');
	}
	if (relayUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(relayUrl.hostname)) {
		throw new BizError('Self-hosted relay URL must use HTTPS');
	}
	if (relayUrl.username || relayUrl.password) {
		throw new BizError('Self-hosted relay URL must not contain credentials');
	}
	if (relayUrl.search || relayUrl.hash) {
		throw new BizError('Self-hosted relay URL must not contain a query or fragment');
	}
	return normalized;
}

function buildPublicSetting(settingRow) {
	return {
		...settingRow,
		resendTokens: { ...(settingRow.resendTokens || {}) },
	};
}

function parseResendTokens(value) {
	if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value };
	try {
		const parsed = JSON.parse(value || '{}');
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		throw new BizError('Stored Resend token configuration is invalid');
	}
}

const settingService = {
	applyRuntimeMailDefaults(c, settingRow) {
		const runtimeSetting = { ...settingRow };
		const longosRelayUrl = normalizeRelayUrl(c.env.longos_relay_url);
		if (c.env.LONGOS_INTEGRATION_TOKEN) {
			// A bearer credential must never be redirected to an administrator-
			// supplied host. Pin its destination and provider to the deployment
			// variables. An integrated LONGOS installation must fail visibly if
			// its own relay is unhealthy; it must never silently disclose mail to
			// Cloudflare Email or Resend as an implicit fallback.
			runtimeSetting.relayUrl = longosRelayUrl;
			runtimeSetting.mailEngine = 'self_hosted';
		} else if (!runtimeSetting.relayUrl && longosRelayUrl) {
			runtimeSetting.relayUrl = longosRelayUrl;
		}
		return runtimeSetting;
	},

	async refresh(c) {
		const settingRow = await orm(c).select().from(setting).get();
		settingRow.resendTokens = parseResendTokens(settingRow.resendTokens);
		c.set('setting', this.applyRuntimeMailDefaults(c, settingRow));
		await c.env.kv.put(KvConst.SETTING, JSON.stringify(settingRow));
	},

	async query(c) {

		if (c.get?.('setting')) {
			return c.get('setting')
		}

		const storedSetting = await c.env.kv.get(KvConst.SETTING, { type: 'json' });

		if (!storedSetting) {
			throw new BizError('数据库未初始化 Database not initialized.');
		}

		const setting = this.applyRuntimeMailDefaults(c, storedSetting);

		let domainList = c.env.domain;

		if (typeof domainList === 'string') {
			try {
				domainList = JSON.parse(domainList)
			} catch (error) {
				throw new BizError(t('notJsonDomain'));
			}
		}

		if (!c.env.domain) {
			throw new BizError(t('noDomainVariable'));
		}

		if (!Array.isArray(domainList) || !domainList.length || domainList.some(item => typeof item !== 'string' || !/^[A-Za-z0-9.-]+$/.test(item))) {
			throw new BizError(t('notJsonDomain'));
		}
		domainList = [...new Set(domainList.map(item => item.trim().toLowerCase()).filter(Boolean))].map(item => '@' + item);
		setting.domainList = domainList;

		let projectLink = c.env.project_link;
		if (typeof projectLink === 'string' && projectLink === 'false') {
			projectLink = false
		} else if (projectLink === false) {
			projectLink = false
		} else {
			projectLink = true
		}

		setting.projectLink = projectLink;

		setting.emailPrefixFilter = String(setting.emailPrefixFilter || '').split(",").filter(Boolean);
		setting.resendTokens = parseResendTokens(setting.resendTokens);

		c.set?.('setting', setting);
		return setting;
	},

	async get(c, showSiteKey = false) {

		const [cachedSetting, recordList] = await Promise.all([
			this.query(c),
			verifyRecordService.selectListByIP(c)
		]);
		const settingRow = buildPublicSetting(cachedSetting);


		if (!showSiteKey) {
			settingRow.siteKey = settingRow.siteKey ? `${settingRow.siteKey.slice(0, 6)}******` : null;
		}

		settingRow.secretKey = maskSecret(settingRow.secretKey);

		Object.keys(settingRow.resendTokens).forEach(key => {
			settingRow.resendTokens[key] = `${settingRow.resendTokens[key].slice(0, 12)}******`;
		});

		settingRow.s3AccessKey = maskSecret(settingRow.s3AccessKey, 12);
		settingRow.s3SecretKey = maskSecret(settingRow.s3SecretKey, 12);
		settingRow.tgBotToken = maskSecret(settingRow.tgBotToken, 20);
		settingRow.linuxdoClientSecret = maskSecret(settingRow.linuxdoClientSecret);
		settingRow.githubClientSecret = maskSecret(settingRow.githubClientSecret);
		settingRow.googleClientSecret = maskSecret(settingRow.googleClientSecret);
		settingRow.webhookSecret = maskSecret(settingRow.webhookSecret);
		settingRow.hasR2 = !!c.env.r2
		settingRow.hasCfEmail = !!c.env.email
		settingRow.hasRelayCredential = !!(c.env.LONGOS_INTEGRATION_TOKEN || c.env.RELAY_SHARED_SECRET)
		settingRow.relayAuthMode = c.env.LONGOS_INTEGRATION_TOKEN ? 'integration_token' : (c.env.RELAY_SHARED_SECRET ? 'legacy_hmac' : '')
		settingRow.mailEngineManaged = !!c.env.LONGOS_INTEGRATION_TOKEN
		// Retain the old response field for one release so cached frontends do
		// not incorrectly report an incomplete relay during a rolling deploy.
		settingRow.hasRelaySecret = settingRow.hasRelayCredential

		let regVerifyOpen = false
		let addVerifyOpen = false

		recordList.forEach(row => {
			if (row.type === verifyRecordType.REG) {
				regVerifyOpen = row.count >= settingRow.regVerifyCount
			}
			if (row.type === verifyRecordType.ADD) {
				addVerifyOpen = row.count >= settingRow.addVerifyCount
			}
		})

		settingRow.regVerifyOpen = regVerifyOpen
		settingRow.addVerifyOpen = addVerifyOpen

		settingRow.storageType = await r2Service.storageType(c);

		return settingRow;
	},

	async set(c, params) {
		if (!params || typeof params !== 'object' || Array.isArray(params)) {
			throw new BizError('Invalid settings payload');
		}
		params = Object.fromEntries(Object.entries(params).filter(([key]) => MUTABLE_SETTING_FIELDS.has(key)));
		if (!Object.keys(params).length) throw new BizError('No supported settings were provided');
		const settingData = await this.query(c);
		const allowedMailEngines = ['auto', 'cloudflare', 'resend', 'self_hosted'];
		if (params.mailEngine !== undefined && !allowedMailEngines.includes(params.mailEngine)) {
			throw new BizError('Invalid mail engine');
		}
		if (c.env.LONGOS_INTEGRATION_TOKEN && params.mailEngine !== undefined && params.mailEngine !== 'self_hosted') {
			throw new BizError('Mail engine is managed by the LONGOS integration');
		}
		if (params.relayUrl !== undefined) {
			params.relayUrl = normalizeRelayUrl(params.relayUrl);
			if (c.env.LONGOS_INTEGRATION_TOKEN) {
				const trustedRelayUrl = normalizeRelayUrl(c.env.longos_relay_url);
				if (params.relayUrl !== trustedRelayUrl) {
					throw new BizError('LONGOS relay URL is managed by the deployment configuration');
				}
			}
		}
		for (const field of SENSITIVE_SETTING_FIELDS) {
			if (params[field] === undefined) continue;
			if (params[field] === null || isMaskedSecret(params[field])) {
				delete params[field];
				continue;
			}
			if (typeof params[field] !== 'string' || params[field].length > 4096 || /[\u0000\r\n]/.test(params[field])) {
				throw new BizError(`Invalid ${field}`);
			}
		}
		for (const field of BOOLEAN_SETTING_FIELDS) {
			if (params[field] === undefined) continue;
			const value = Number(params[field]);
			if (!Number.isInteger(value) || ![0, 1].includes(value)) throw new BizError(`Invalid ${field}`);
			params[field] = value;
		}
		const boundedIntegers = {
			autoRefresh: [0, 86400],
			regVerifyCount: [1, 1000],
			addVerifyCount: [1, 1000],
			noticeDuration: [0, 3600000],
			noticeOffset: [0, 1000],
			noticeWidth: [240, 1200],
			minEmailPrefix: [0, 64],
			autoCleanDays: [0, 3650],
		};
		for (const [field, [minimum, maximum]] of Object.entries(boundedIntegers)) {
			if (params[field] === undefined) continue;
			const value = Number(params[field]);
			if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
				throw new BizError(`Invalid ${field}`);
			}
			params[field] = value;
		}
		if (params.loginOpacity !== undefined) {
			const opacity = Number(params.loginOpacity);
			if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new BizError('Invalid loginOpacity');
			params.loginOpacity = opacity;
		}
		if (params.noticeTitle !== undefined && (typeof params.noticeTitle !== 'string' || params.noticeTitle.length > 200)) {
			throw new BizError('Invalid noticeTitle');
		}
		if (params.noticeContent !== undefined && (typeof params.noticeContent !== 'string' || params.noticeContent.length > 50000)) {
			throw new BizError('Invalid noticeContent');
		}
		if (params.noticeType !== undefined && !['', 'none', 'success', 'warning', 'info', 'error'].includes(params.noticeType)) {
			throw new BizError('Invalid noticeType');
		}
		if (params.noticePosition !== undefined && !['', 'top-right', 'top-left', 'bottom-right', 'bottom-left'].includes(params.noticePosition)) {
			throw new BizError('Invalid noticePosition');
		}
		if (params.title !== undefined && (typeof params.title !== 'string' || params.title.length > 100)) {
			throw new BizError('Invalid title');
		}
		for (const [field, value] of Object.entries(params)) {
			if (typeof value === 'string' && (value.length > 50000 || /\u0000/.test(value))) {
				throw new BizError(`Invalid ${field}`);
			}
		}
		for (const field of ['r2Domain', 'endpoint', 'customDomain']) {
			if (params[field] === undefined) continue;
			try {
				params[field] = normalizePublicBaseUrl(params[field], field);
			} catch (error) {
				throw new BizError(error.message);
			}
		}

		const incomingTokens = params.resendTokens && typeof params.resendTokens === 'object' && !Array.isArray(params.resendTokens)
			? params.resendTokens
			: {};
		let resendTokens = { ...settingData.resendTokens };
		for (const [domain, token] of Object.entries(incomingTokens)) {
			if (typeof domain !== 'string' || domain.length > 253 || !/^[A-Za-z0-9.-]+$/.test(domain)) {
				throw new BizError('Invalid Resend token domain');
			}
			if (isMaskedSecret(token)) continue;
			if (typeof token !== 'string' || token.length > 512 || /[\u0000\r\n]/.test(token)) {
				throw new BizError('Invalid Resend token');
			}
			const normalizedDomain = domain.toLowerCase();
			if (normalizedDomain !== domain) delete resendTokens[domain];
			resendTokens[normalizedDomain] = token;
		}
		Object.keys(resendTokens).forEach(domain => {
			if (!resendTokens[domain]) delete resendTokens[domain];
		});

		if (Array.isArray(params.emailPrefixFilter)) {
			params.emailPrefixFilter = params.emailPrefixFilter + '';
		}

		if (Array.isArray(params.aiCodeFilter)) {
			params.aiCodeFilter = params.aiCodeFilter + '';
		}

		if (params.webhookUrl !== undefined) {
			try {
				params.webhookUrl = normalizeWebhookUrl(params.webhookUrl);
			} catch (error) {
				throw new BizError(error.message);
			}
		}
		if (params.webhookRetry !== undefined) {
			const retry = Number(params.webhookRetry);
			if (!Number.isSafeInteger(retry) || retry < 0 || retry > 3) {
				throw new BizError('Webhook retry count must be between 0 and 3');
			}
			params.webhookRetry = retry;
		}

		params.resendTokens = JSON.stringify(resendTokens);

		await orm(c).update(setting).set({ ...params }).returning().get();
		await this.refresh(c);
	},

	async deleteBackground(c) {

		const { background } = await this.query(c);
		if (!background) return

		await orm(c).update(setting).set({ background: '' }).run();
		await this.refresh(c)

		if (!/^https?:\/\//i.test(background)) {
			try {
				await r2Service.delete(c, background)
			} catch (error) {
				console.error('Unable to remove the previous background object', error)
			}
		}
	},

	async setBackground(c, params) {
		if (!params || typeof params !== 'object' || Array.isArray(params) || typeof params.background !== 'string') {
			throw new BizError('Invalid background payload');
		}

		const currentBackground = (await this.query(c)).background || '';
		const input = params.background.trim();
		let background = '';
		let uploadedKey = '';

		if (/^https?:\/\//i.test(input)) {
			try {
				background = normalizePublicImageUrl(input);
			} catch (error) {
				throw new BizError(error.message);
			}
		} else if (input) {
			if (input.length > Math.ceil(MAX_BACKGROUND_BYTES * 4 / 3) + 1024) {
				throw new BizError('Background image must not exceed 5 MB');
			}
			let file;
			try {
				file = fileUtils.base64ToFile(input)
			} catch {
				throw new BizError('Invalid background image data');
			}
			if (!BACKGROUND_IMAGE_TYPES.has(file.type)) {
				throw new BizError('Background image must be PNG, JPEG, GIF, or WebP');
			}
			if (file.size <= 0 || file.size > MAX_BACKGROUND_BYTES) {
				throw new BizError('Background image must not exceed 5 MB');
			}

			const arrayBuffer = await file.arrayBuffer();
			background = constant.BACKGROUND_PREFIX + await fileUtils.getBuffHash(arrayBuffer) + fileUtils.getExtFileName(file.name);
			uploadedKey = background;

			await r2Service.putObj(c, background, arrayBuffer, {
				contentType: file.type,
				cacheControl: `public, max-age=31536000, immutable`,
				contentDisposition: `inline; filename="${file.name}"`
			});
		}

		try {
			await orm(c).update(setting).set({ background }).run();
			await this.refresh(c);
		} catch (error) {
			if (uploadedKey) {
				try {
					await r2Service.delete(c, uploadedKey)
				} catch (cleanupError) {
					console.error('Unable to roll back the uploaded background object', cleanupError)
				}
			}
			throw error;
		}

		if (currentBackground && currentBackground !== background && !/^https?:\/\//i.test(currentBackground)) {
			try {
				await r2Service.delete(c, currentBackground)
			} catch (error) {
				console.error('Unable to remove the previous background object', error)
			}
		}
		return background;
	},


	async setBlacklist(c, params) {
		if (!params || typeof params !== 'object' || Array.isArray(params)) {
			throw new BizError('Invalid blacklist payload');
		}
		const { blackSubject = '', blackContent = '', blackFrom = '' } = params
		for (const [field, value] of Object.entries({blackSubject, blackContent, blackFrom})) {
			if (typeof value !== 'string' || value.length > 10000 || /\u0000/.test(value)) {
				throw new BizError(`Invalid ${field}`);
			}
		}
		await orm(c).update(setting).set({ blackSubject, blackContent, blackFrom }).run();
		await this.refresh(c);
		return this.get(c);
	},

	async websiteConfig(c) {

		const settingRow = await this.get(c, true);
		const token = await userContext.getToken(c);

		return {
			register: settingRow.register,
			title: settingRow.title,
			manyEmail: settingRow.manyEmail,
			addEmail: settingRow.addEmail,
			autoRefresh: settingRow.autoRefresh,
			addEmailVerify: settingRow.addEmailVerify,
			registerVerify: settingRow.registerVerify,
			send: settingRow.send,
			r2Domain: settingRow.r2Domain,
			siteKey: settingRow.siteKey,
			background: settingRow.background,
			loginOpacity: settingRow.loginOpacity,
			domainList: settingRow.loginDomain === 1 && !token ? [] : settingRow.domainList,
			regKey: settingRow.regKey,
			regVerifyOpen: settingRow.regVerifyOpen,
			addVerifyOpen: settingRow.addVerifyOpen,
			noticeTitle: settingRow.noticeTitle,
			noticeContent: settingRow.noticeContent,
			noticeType: settingRow.noticeType,
			noticeDuration: settingRow.noticeDuration,
			noticePosition: settingRow.noticePosition,
			noticeWidth: settingRow.noticeWidth,
			noticeOffset: settingRow.noticeOffset,
			notice: settingRow.notice,
			loginDomain: settingRow.loginDomain,
			linuxdoClientId: settingRow.linuxdoClientId,
			linuxdoSwitch: settingRow.linuxdoSwitch,
			githubClientId: settingRow.githubClientId,
			githubSwitch: settingRow.githubSwitch,
			googleClientId: settingRow.googleClientId,
			googleSwitch: settingRow.googleSwitch,
			minEmailPrefix: settingRow.minEmailPrefix,
			projectLink: settingRow.projectLink
		};
	},

};

export { buildPublicSetting, isMaskedSecret, maskSecret, normalizeRelayUrl, parseResendTokens };
export default settingService;
