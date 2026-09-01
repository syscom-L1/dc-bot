import pino from 'pino';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatibleLlmAdapter } from '../../src/ai/openai-compatible-adapter.js';

describe('OpenAI-compatible LLM adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses Azure v1 structured outputs with current token parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'syscom-bot-mini',
      choices: [{ message: { content: JSON.stringify({ answer: 'OK' }) } }],
      usage: { prompt_tokens: 4, completion_tokens: 1 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OpenAiCompatibleLlmAdapter({
      enabled: true,
      baseUrl: 'https://resource.cognitiveservices.azure.com/openai/v1',
      apiKey: 'test-key',
      model: 'syscom-bot-mini',
      fallbackModel: '',
      timeoutMs: 1_000,
    }, pino({ level: 'silent' }));

    const result = await adapter.generateStructured({
      system: 'Return JSON.',
      user: 'health check',
      traceId: 'azure-test',
      maxOutputTokens: 32,
      schemaName: 'health_response',
      schema: z.object({ answer: z.string().min(1).max(20) }),
    });

    expect(result.data).toEqual({ answer: 'OK' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, options] = call as unknown as [string, RequestInit];
    expect(url).toBe('https://resource.cognitiveservices.azure.com/openai/v1/chat/completions');
    expect(options.headers).toMatchObject({ authorization: 'Bearer test-key' });
    if (typeof options.body !== 'string') throw new Error('Expected string request body');
    const body = JSON.parse(options.body) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(32);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'health_response',
        strict: true,
        schema: { type: 'object', additionalProperties: false },
      },
    });
    expect(JSON.stringify(body.response_format)).not.toContain('maxLength');
  });
});
