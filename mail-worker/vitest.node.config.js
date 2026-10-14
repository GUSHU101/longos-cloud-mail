import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: [
			'test/crypto-utils.spec.js',
			'test/email-service.spec.js',
			'test/init-authorization.spec.js',
			'test/jwt-utils.spec.js',
			'test/self-hosted-mail-service.spec.js',
			'test/mail-provider.spec.js',
			'test/public-service.spec.js',
			'test/resend-service.spec.js',
			'test/session-service.spec.js',
			'test/setting-service.spec.js',
		],
	},
});
