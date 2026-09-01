import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGitHubSignature } from '../../src/github/signature.js';

describe('verifyGitHubSignature', () => {
  it('accepts an exact SHA-256 signature', () => {
    const payload = Buffer.from('{"zen":"keep it logically awesome"}');
    const signature = `sha256=${createHmac('sha256', 'secret').update(payload).digest('hex')}`;
    expect(verifyGitHubSignature(payload, signature, 'secret')).toBe(true);
  });

  it('rejects missing, malformed and incorrect signatures', () => {
    const payload = Buffer.from('{}');
    expect(verifyGitHubSignature(payload, undefined, 'secret')).toBe(false);
    expect(verifyGitHubSignature(payload, 'sha1=abc', 'secret')).toBe(false);
    expect(verifyGitHubSignature(payload, `sha256=${'0'.repeat(64)}`, 'secret')).toBe(false);
  });
});
