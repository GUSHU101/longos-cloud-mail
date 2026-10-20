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

function withObjectSecurityHeaders(response) {
	return withSecurityHeaders(response || new Response('Not Found', {
		status: 404,
		headers: {
			'cache-control': 'private, no-store',
			'content-type': 'text/plain; charset=utf-8',
		},
	}));
}

async function runScheduledTasks(tasks, logger = console) {
	const errors = [];
	for (const [name, task] of tasks) {
		try {
			await task();
		} catch (error) {
			errors.push(error);
			logger.error(`Scheduled task failed: ${name}`, error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, `${errors.length} scheduled task(s) failed`);
	}
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
			 return withObjectSecurityHeaders(await kvObjService.toObjResp( { env }, url.pathname.substring(1)));
		 }

		return withSecurityHeaders(await env.assets.fetch(req));
	},
	email: email,
	async scheduled(c, env, ctx) {
		if (c.cron === '30 * * * *') {
			await runScheduledTasks([
				['refresh analytics cache', () => analysisService.refreshEchartsCache({ env })],
			]);
			return;
		}

		await runScheduledTasks([
			['clear verification records', () => verifyRecordService.clearRecord({ env })],
			['reset daily send counts', () => userService.resetDaySendCount({ env })],
			['complete pending inbound mail', () => emailService.completeReceiveAll({ env })],
			['clean expired mail', () => emailService.autoClean({ env })],
			['refresh analytics cache', () => analysisService.refreshEchartsCache({ env })],
			['clear unbound OAuth users', () => oauthService.clearNoBindOathUser({ env })],
		]);
	},
};

export { runScheduledTasks, withObjectSecurityHeaders, withSecurityHeaders };
