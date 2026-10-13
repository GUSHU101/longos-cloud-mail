import { describe, expect, it } from 'vitest';
import { validateSendAttachments, validateSendInput } from '../src/service/email-service';

describe('outbound message input validation', () => {
	it('requires at least one valid recipient', () => {
		expect(() => validateSendInput([], [])).toThrow();
		expect(() => validateSendInput(['not-an-email'], [])).toThrow();
		expect(() => validateSendInput(['buyer@example.com'], [])).not.toThrow();
	});

	it('rejects malformed attachment input', () => {
		expect(() => validateSendInput(['buyer@example.com'], null)).toThrow();
	});
});

describe('outbound attachment validation', () => {
	it('accepts attachments at the supported limits', () => {
		expect(() => validateSendAttachments(new Array(10).fill({}), new Array(10).fill({}))).not.toThrow();
	});

	it('rejects excessive inline images before delivery', () => {
		expect(() => validateSendAttachments(new Array(11).fill({}), [])).toThrow();
	});

	it('rejects excessive file attachments before delivery', () => {
		expect(() => validateSendAttachments([], new Array(11).fill({}))).toThrow();
	});
});
