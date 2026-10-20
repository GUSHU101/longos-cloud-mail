import app from '../hono/hono';

async function readiness(c) {
	const [settingRow] = await Promise.all([
		c.env.db.prepare('SELECT COUNT(*) AS count FROM setting').first(),
		c.env.kv.get('__longos_health_probe__'),
	]);
	if (Number(settingRow?.count) !== 1) {
		throw new Error('Required setting row is missing');
	}
	return {
		status: 'ok',
		checks: { database: 'ok', kv: 'ok' },
		checkedAt: new Date().toISOString(),
	};
}

app.get('/health', async (c) => {
	try {
		return c.json(await readiness(c), 200, { 'cache-control': 'no-store' });
	} catch (error) {
		const requestId = c.req.header('cf-ray') || crypto.randomUUID();
		console.error('Worker readiness check failed', { requestId, error });
		return c.json({
			status: 'unavailable',
			requestId,
			checks: { database: 'unavailable', kv: 'unavailable' },
		}, 503, { 'cache-control': 'no-store' });
	}
});

export { readiness };
