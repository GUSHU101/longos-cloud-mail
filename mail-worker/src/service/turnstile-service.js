import BizError from '../error/biz-error';
import settingService from './setting-service';
import { t } from '../i18n/i18n'

const TURNSTILE_TIMEOUT_MS = 10_000;

const turnstileService = {

	async verify(c, token) {

		if (!token) {
			throw new BizError(t('emptyBotToken'),400);
		}

		const settingRow = await settingService.query(c)
		if (typeof settingRow.secretKey !== 'string' || !settingRow.secretKey) {
			throw new BizError(t('botVerifyFail'), 503);
		}

		let res;
		try {
			res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: new URLSearchParams({
					secret: settingRow.secretKey,
					response: token,
					remoteip: c.req.header('cf-connecting-ip') || ''
				}),
				signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
			});
		} catch {
			throw new BizError(t('botVerifyFail'), 503);
		}

		let result;
		try {
			result = await res.json();
		} catch {
			throw new BizError(t('botVerifyFail'), 503);
		}

		if (!res.ok) {
			throw new BizError(t('botVerifyFail'), 503);
		}

		if (!result.success) {
			throw new BizError(t('botVerifyFail'),400)
		}
	}
};

export { TURNSTILE_TIMEOUT_MS };
export default turnstileService;
