import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';

const APP_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' https: data:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function configuredCorsOrigins(c) {
	const value = c.env?.cors_origins;
	if (!value) return [];
	if (Array.isArray(value)) return value;
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return String(value).split(',').map(item => item.trim()).filter(Boolean);
	}
}

function corsOrigin(origin, c) {
	if (!origin) return undefined;
	const ownOrigin = new URL(c.req.url).origin;
	if (origin === ownOrigin || configuredCorsOrigins(c).includes(origin)) return origin;
	return undefined;
}

app.use('*', cors({
	origin: corsOrigin,
	allowHeaders: ['Authorization', 'Content-Type'],
	allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	maxAge: 86400,
}));

app.use('*', async (c, next) => {
	await next();
	c.header('Cache-Control', 'no-store');
	c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
	c.header('X-Content-Type-Options', 'nosniff');
	c.header('X-Frame-Options', 'DENY');
	c.header('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
	if (!c.res.headers.has('Content-Security-Policy')) {
		c.header('Content-Security-Policy', APP_CONTENT_SECURITY_POLICY);
	}
});

app.onError((err, c) => {
	if (err.name === 'BizError') {
		console.log(err.message);
		return c.json(result.fail(err.message, err.code));
	}

	const requestId = c.req.header('cf-ray') || crypto.randomUUID();
	console.error('Unhandled request error', { requestId, error: err });

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定<br/>KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定<br/>KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定<br/>D1 database not bound',502));
	}

	if (err.message?.includes('D1_ERROR: no such column')) {
		return c.json(result.fail('请按照文档更新数据库<br/>Please update the database as documented',502));
	}

	return c.json({
		...result.fail('系统暂时无法处理该请求 / The system could not process this request', 500),
		requestId,
	});
});

export { APP_CONTENT_SECURITY_POLICY, configuredCorsOrigins, corsOrigin };
export default app;


