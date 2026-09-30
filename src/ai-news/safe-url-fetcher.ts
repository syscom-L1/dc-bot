import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { canonicalizeNewsUrl } from './url.js';
import type { FetchedArticle } from './types.js';

const maxResponseBytes = 1_500_000;
const maxArticleCharacters = 18_000;
const requestTimeoutMs = 10_000;
const maxRedirects = 3;

function isUnsafeIpv4(address: string): boolean {
	const parts = address.split('.').map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [first = 0, second = 0, third = 0] = parts;
	return first === 0
		|| first === 10
		|| first === 127
		|| (first === 100 && second >= 64 && second <= 127)
		|| (first === 169 && second === 254)
		|| (first === 172 && second >= 16 && second <= 31)
		|| (first === 192 && second === 0 && third === 0)
		|| (first === 192 && second === 0 && third === 2)
		|| (first === 192 && second === 168)
		|| (first === 198 && (second === 18 || second === 19))
		|| (first === 198 && second === 51 && third === 100)
		|| (first === 203 && second === 0 && third === 113)
		|| first >= 224;
}

function isUnsafeIp(address: string): boolean {
	if (isIP(address) === 4) return isUnsafeIpv4(address);
	if (isIP(address) !== 6) return true;
	const normalized = address.toLowerCase();
	if (normalized.startsWith('::ffff:')) return isUnsafeIpv4(normalized.slice(7));
	const firstHextet = Number.parseInt(normalized.split(':')[0] ?? '', 16);
	return !Number.isFinite(firstHextet)
		|| firstHextet < 0x2000
		|| firstHextet > 0x3fff
		|| normalized.startsWith('2001:0:')
		|| normalized.startsWith('2001:0000:')
		|| normalized.startsWith('2001:db8:')
		|| normalized.startsWith('2002:')
		|| normalized.startsWith('3fff:');
}

async function validateAndResolve(url: URL): Promise<{ address: string; family: 4 | 6 }> {
	if (url.protocol !== 'https:') throw new Error('成員分享只接受 HTTPS 網址');
	if (url.port && url.port !== '443') throw new Error('不接受非標準連接埠');
	if (url.username || url.password) throw new Error('網址不可包含登入資訊');
	const hostname = url.hostname.toLowerCase();
	if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
		throw new Error('不接受本機或內部網址');
	}
	if (isIP(hostname)) {
		if (isUnsafeIp(hostname)) throw new Error('不接受私有、保留或本機 IP');
		return { address: hostname, family: isIP(hostname) as 4 | 6 };
	}
	const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
	if (addresses.length === 0 || addresses.some((item) => isUnsafeIp(item.address))) {
		throw new Error('網址解析到不允許的網路位址');
	}
	const first = addresses[0];
	if (!first || (first.family !== 4 && first.family !== 6)) throw new Error('無法安全解析網址');
	return { address: first.address, family: first.family };
}

function decodeEntities(value: string): string {
	return value
		.replace(/&nbsp;/giu, ' ')
		.replace(/&amp;/giu, '&')
		.replace(/&quot;/giu, '"')
		.replace(/&#39;|&apos;/giu, "'")
		.replace(/&lt;/giu, '<')
		.replace(/&gt;/giu, '>')
		.replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function attribute(html: string, names: string[]): string {
	for (const name of names) {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
		const patternA = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'iu');
		const patternB = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`, 'iu');
		const match = patternA.exec(html) ?? patternB.exec(html);
		if (match?.[1]) return decodeEntities(match[1].trim());
	}
	return '';
}

function extractArticle(html: string, canonicalUrl: string, contentType: string): FetchedArticle {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
	const title = attribute(html, ['og:title', 'twitter:title'])
		|| decodeEntities((titleMatch?.[1] ?? new URL(canonicalUrl).hostname).replace(/\s+/gu, ' ').trim());
	const description = attribute(html, ['description', 'og:description', 'twitter:description']);
	const publishedValue = attribute(html, ['article:published_time', 'date', 'datePublished']);
	const publishedDate = publishedValue ? new Date(publishedValue) : undefined;
	const text = decodeEntities(html
		.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/giu, ' ')
		.replace(/<!--[\s\S]*?-->/gu, ' ')
		.replace(/<[^>]+>/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim())
		.slice(0, maxArticleCharacters);
	return {
		canonicalUrl,
		title: title.slice(0, 500),
		description: description.slice(0, 1_500),
		text,
		...(publishedDate && !Number.isNaN(publishedDate.getTime()) ? { publishedAt: publishedDate } : {}),
		contentType,
	};
}

async function download(url: URL, redirectCount: number): Promise<FetchedArticle> {
	const resolved = await validateAndResolve(url);
	const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
		callback(null, resolved.address, resolved.family);
	};
	return new Promise((resolve, reject) => {
		const request = httpsRequest(url, {
			method: 'GET',
			headers: {
				accept: 'text/html,application/xhtml+xml,application/pdf;q=0.5',
				'user-agent': 'dc-bot-ai-news/1.0',
			},
			lookup: pinnedLookup,
		}, (response) => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && response.headers.location) {
				response.resume();
				if (redirectCount >= maxRedirects) {
					reject(new Error('網址重新導向次數過多'));
					return;
				}
				let redirectUrl: URL;
				try {
					redirectUrl = new URL(response.headers.location, url);
				} catch {
					reject(new Error('網址重新導向位置無效'));
					return;
				}
				void download(redirectUrl, redirectCount + 1).then(resolve, reject);
				return;
			}
			if (status < 200 || status >= 300) {
				response.resume();
				reject(new Error(`來源網站回傳 HTTP ${status}`));
				return;
			}
			const contentType = (response.headers['content-type'] ?? '').toLowerCase();
			if (contentType.includes('application/pdf')) {
				response.resume();
				resolve({
					canonicalUrl: canonicalizeNewsUrl(url.toString(), true),
					title: decodeURIComponent(url.pathname.split('/').pop() ?? url.hostname).slice(0, 500),
					description: '此連結是 PDF；第一版只提供檔名與來源，無法可靠摘要全文。',
					text: '',
					contentType,
				});
				return;
			}
			if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
				response.resume();
				reject(new Error('來源不是可摘要的 HTML 頁面'));
				return;
			}
			const chunks: Buffer[] = [];
			let total = 0;
			response.on('data', (chunk: Buffer) => {
				total += chunk.length;
				if (total > maxResponseBytes) {
					request.destroy(new Error('來源頁面超過大小限制'));
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => {
				const canonicalUrl = canonicalizeNewsUrl(url.toString(), true);
				resolve(extractArticle(Buffer.concat(chunks).toString('utf8'), canonicalUrl, contentType));
			});
		});
		request.setTimeout(requestTimeoutMs, () => request.destroy(new Error('來源網站回應逾時')));
		request.on('error', reject);
		request.end();
	});
}

export class SafeUrlFetcher {
	public async fetchArticle(value: string): Promise<FetchedArticle> {
		if (value.length > 2_048) throw new Error('網址過長');
		const canonicalUrl = canonicalizeNewsUrl(value, true);
		return download(new URL(canonicalUrl), 0);
	}
}

export const safeUrlInternals = { isUnsafeIp };
