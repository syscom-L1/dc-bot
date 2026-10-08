import { connect, createServer, type AddressInfo } from 'node:net';
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

	it('pinned lookup returns an address array when options.all is true', () => {
		const lookup = safeUrlInternals.createPinnedLookup({ address: '1.1.1.1', family: 4 });
		let result: unknown;
		lookup('example.com', { all: true }, (_error, address) => { result = address; });
		expect(result).toEqual([{ address: '1.1.1.1', family: 4 }]);
	});

	it('pinned lookup returns a single address when options.all is not set', () => {
		const lookup = safeUrlInternals.createPinnedLookup({ address: '2606:4700:4700::1111', family: 6 });
		let result: unknown[] = [];
		(lookup as (h: string, o: object, cb: (...args: unknown[]) => void) => void)('example.com', {}, (_error, ...rest) => { result = rest; });
		expect(result).toEqual(['2606:4700:4700::1111', 6]);
	});

	it('pinned lookup works with a real connection using autoSelectFamily', async () => {
		const server = createServer((socket) => socket.end('ok'));
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		const lookup = safeUrlInternals.createPinnedLookup({ address: '127.0.0.1', family: 4 });
		try {
			const data = await new Promise<string>((resolve, reject) => {
				const socket = connect({ host: 'pinned.test', port, lookup, autoSelectFamily: true });
				let body = '';
				socket.on('data', (chunk: Buffer) => { body += chunk.toString(); });
				socket.on('end', () => resolve(body));
				socket.on('error', reject);
			});
			expect(data).toBe('ok');
		} finally {
			server.close();
		}
	});
});
