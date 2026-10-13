import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: [
			'test/email-service.spec.js',
			'test/init-authorization.spec.js',
			'test/self-hosted-mail-service.spec.js',
			'test/mail-provider.spec.js',
			'test/setting-service.spec.js',
		],
	},
});
