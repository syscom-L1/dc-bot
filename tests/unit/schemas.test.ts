import { describe, expect, it } from 'vitest';
import { progressUpdateActionSchema, projectBindingConfigSchema } from '../../src/domain/models.js';

describe('domain schemas', () => {
  it('uses configurable GitHub Project field defaults', () => {
    const config = projectBindingConfigSchema.parse({});
    expect(config.githubProjectFields.targetDate).toBe('Target Date');
    expect(config.statusOptions.inProgress).toBe('In Progress');
    expect(config.autoUpdateGithubStatus).toBe(false);
  });

  it('rejects malformed AI/progress actions before external writes', () => {
    expect(() => progressUpdateActionSchema.parse({ status: 'Made Up', progress: '' })).toThrow();
  });
});
