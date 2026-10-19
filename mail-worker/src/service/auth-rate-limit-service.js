import BizError from '../error/biz-error';
import KvConst from '../const/kv-const';
import reqUtils from '../utils/req-utils';

const AUTH_FAILURE_LIMIT = 10;
const AUTH_FAILURE_WINDOW_SECONDS = 5 * 60;
const encoder = new TextEncoder();

async function failureKey(c, identity) {
	const source = `${reqUtils.getIp(c)}\n${String(identity || '').trim().toLowerCase()}`;
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(source));
	const hex = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
	return KvConst.AUTH_FAILURE + hex;
}

const authRateLimitService = {
	async assertAllowed(c, identity) {
		const key = await failureKey(c, identity);
		const attempts = Number(await c.env.kv.get(key)) || 0;
		if (attempts >= AUTH_FAILURE_LIMIT) {
			throw new BizError('Too many authentication attempts. Please try again later.', 429);
		}
		return key;
	},

	async recordFailure(c, identity) {
		const key = await failureKey(c, identity);
		const attempts = Number(await c.env.kv.get(key)) || 0;
		await c.env.kv.put(key, String(Math.min(attempts + 1, AUTH_FAILURE_LIMIT)), {
			expirationTtl: AUTH_FAILURE_WINDOW_SECONDS,
		});
	},

	async clear(c, identity) {
		await c.env.kv.delete(await failureKey(c, identity));
	},
};

export { AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW_SECONDS, failureKey };
export default authRateLimitService;
