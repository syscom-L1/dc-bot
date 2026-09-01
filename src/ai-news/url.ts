import { createHash } from 'node:crypto';

const trackingParameters = new Set([
	'fbclid',
	'gclid',
	'mc_cid',
	'mc_eid',
	'ref',
	'source',
]);

export function canonicalizeNewsUrl(value: string, httpsOnly = false): string {
	const url = new URL(value.trim().replace(/^<|>$/gu, ''));
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('只支援 HTTP 或 HTTPS 網址');
	}
	if (httpsOnly && url.protocol !== 'https:') throw new Error('成員分享只接受 HTTPS 網址');
	if (url.username || url.password) throw new Error('網址不可包含登入資訊');
	url.hash = '';
	url.hostname = url.hostname.toLowerCase();
	if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
		url.port = '';
	}
	for (const key of [...url.searchParams.keys()]) {
		if (key.toLowerCase().startsWith('utm_') || trackingParameters.has(key.toLowerCase())) {
			url.searchParams.delete(key);
		}
	}
	url.searchParams.sort();
	if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, '');
	return url.toString();
}

export function newsUrlHash(canonicalUrl: string): string {
	return createHash('sha256').update(canonicalUrl).digest('hex');
}

export function candidateId(provider: string, canonicalUrl: string): string {
	return createHash('sha256').update(`${provider}:${canonicalUrl}`).digest('hex').slice(0, 20);
}

export function extractHttpsUrls(content: string, limit: number): string[] {
	const matches = content.match(/https:\/\/[^\s<>]+/giu) ?? [];
	const unique = new Set<string>();
	for (const match of matches) {
		const cleaned = match.replace(/[),.;!?，。；！？]+$/gu, '');
		try {
			unique.add(canonicalizeNewsUrl(cleaned, true));
		} catch {
			continue;
		}
		if (unique.size >= limit) break;
	}
	return [...unique];
}
