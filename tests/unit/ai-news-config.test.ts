import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';

const baseEnvironment = {
	NODE_ENV: 'test',
	DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
	REDIS_URL: 'redis://127.0.0.1:6379',
};

describe('AI news configuration', () => {
	it('defaults to disabled with the weekday 09:00 schedule', () => {
		const config = loadConfig(baseEnvironment);
		expect(config.aiNews.enabled).toBe(false);
		expect(config.schedules.aiNews).toBe('0 9 * * 1-5');
		expect(config.aiNews.initialLookbackHours).toBe(72);
		expect(config.aiNews.maxLookbackHours).toBe(96);
	});

	it('rejects a non-HTTPS primary source', () => {
		expect(() => loadConfig({
			...baseEnvironment,
			AI_NEWS_PRIMARY_SOURCE_URL: 'http://127.0.0.1/feed',
		})).toThrow();
	});

	it('rejects an initial lookback larger than the recovery limit', () => {
		expect(() => loadConfig({
			...baseEnvironment,
			AI_NEWS_INITIAL_LOOKBACK_HOURS: '120',
			AI_NEWS_MAX_LOOKBACK_HOURS: '96',
		})).toThrow();
	});
});
