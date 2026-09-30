import { describe, expect, it } from 'vitest';
import { safeUrlInternals } from '../../src/ai-news/safe-url-fetcher.js';
import { canonicalizeNewsUrl, extractHttpsUrls } from '../../src/ai-news/url.js';

describe('AI news URL handling', () => {
	it('normalizes tracking parameters before deduplication', () => {
		expect(canonicalizeNewsUrl('https://Example.com/story/?utm_source=x&b=2&a=1#section'))
			.toBe('https://example.com/story?a=1&b=2');
	});

	it('extracts at most three unique HTTPS links', () => {
		const content = [
			'https://example.com/a?utm_source=discord',
			'https://example.com/a',
			'https://example.com/b。',
			'http://example.com/c',
			'https://example.com/d',
		].join(' ');
		expect(extractHttpsUrls(content, 3)).toEqual([
			'https://example.com/a',
			'https://example.com/b',
			'https://example.com/d',
		]);
	});

	it('rejects private, local, reserved and documentation IP ranges', () => {
		for (const address of [
			'127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
			'192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', 'fc00::1', 'fe80::1', 'fec0::1',
			'64:ff9b::c0a8:101', '2001:db8::1', '2002:c0a8:101::1', '3fff::1',
		]) {
			expect(safeUrlInternals.isUnsafeIp(address), address).toBe(true);
		}
		expect(safeUrlInternals.isUnsafeIp('1.1.1.1')).toBe(false);
		expect(safeUrlInternals.isUnsafeIp('2606:4700:4700::1111')).toBe(false);
	});
});
