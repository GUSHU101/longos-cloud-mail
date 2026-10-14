import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';

app.use('*', cors());

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

export default app;


