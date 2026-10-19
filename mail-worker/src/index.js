import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import kvObjService from './service/kv-obj-service';
import oauthService from './service/oauth-service';
import analysisService from './service/analysis-service';
import { APP_CONTENT_SECURITY_POLICY } from './hono/hono';

function withSecurityHeaders(response) {
	const headers = new Headers(response.headers);
	headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('X-Frame-Options', 'DENY');
	headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
	if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', APP_CONTENT_SECURITY_POLICY);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.slice(4)
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 return withSecurityHeaders(await kvObjService.toObjResp( { env }, url.pathname.substring(1)));
		 }

		return withSecurityHeaders(await env.assets.fetch(req));
	},
	email: email,
	async scheduled(c, env, ctx) {
		if (c.cron === '30 * * * *') {
			await analysisService.refreshEchartsCache({ env })
			return;
		}

		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await emailService.autoClean({ env })
		await analysisService.refreshEchartsCache({ env })
		await oauthService.clearNoBindOathUser({ env })
	},
};

export { withSecurityHeaders };
