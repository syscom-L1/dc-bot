import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/config.js';

const requiredEnvironment = {
	DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
	REDIS_URL: 'redis://localhost:6379',
};

describe('application config', () => {
	it('keeps commit history disabled by default', () => {
		expect(loadConfig(requiredEnvironment).github.commitHistoryEnabled).toBe(false);
	});

	it('enables commit history only when explicitly configured', () => {
		const config = loadConfig({
			...requiredEnvironment,
			GITHUB_COMMIT_HISTORY_ENABLED: 'true',
		});

		expect(config.github.commitHistoryEnabled).toBe(true);
	});
});
