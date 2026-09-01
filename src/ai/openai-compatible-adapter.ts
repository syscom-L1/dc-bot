import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Logger } from 'pino';
import type { LlmConfig } from '../config/llm-config.js';
import type {
  LlmAdapter,
  StructuredLlmRequest,
  StructuredLlmResponse,
  TextLlmRequest,
  TextLlmResponse,
} from './contracts.js';

const chatResponseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
  }).optional(),
});

function endpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/v1')
    ? `${normalized}/chat/completions`
    : `${normalized}/v1/chat/completions`;
}

const unsupportedAzureSchemaKeywords = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'patternProperties',
  'unevaluatedProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
  'unevaluatedItems',
  'contains',
  'minContains',
  'maxContains',
  'minItems',
  'maxItems',
  'uniqueItems',
]);

function stripUnsupportedAzureSchemaKeywords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnsupportedAzureSchemaKeywords);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !unsupportedAzureSchemaKeywords.has(key))
      .map(([key, child]) => [key, stripUnsupportedAzureSchemaKeywords(child)]),
  );
}

function azureJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const converted = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'openAi' });
  return z.record(z.unknown()).parse(stripUnsupportedAzureSchemaKeywords(converted));
}

export class OpenAiCompatibleLlmAdapter implements LlmAdapter {
  public constructor(
    private readonly config: LlmConfig,
    private readonly logger: Logger,
  ) {
    if (!config.enabled) throw new Error('LLM adapter cannot start while disabled');
  }

  private async complete(input: {
    system: string;
    user: string;
    traceId: string;
    maxOutputTokens?: number;
    structuredSchema?: { name: string; schema: Record<string, unknown> };
  }): Promise<{ text: string; model: string; inputTokens?: number; outputTokens?: number }> {
    const models = [this.config.model, this.config.fallbackModel].filter(Boolean);
    let lastError: unknown;
    for (const model of [...new Set(models)]) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
          const response = await fetch(endpoint(this.config.baseUrl), {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.config.apiKey}`,
              'content-type': 'application/json',
              'x-request-id': input.traceId,
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: 'system', content: input.system },
                { role: 'user', content: input.user },
              ],
              temperature: 0.1,
              max_completion_tokens: input.maxOutputTokens ?? 2_000,
              ...(input.structuredSchema ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: input.structuredSchema.name,
                    strict: true,
                    schema: input.structuredSchema.schema,
                  },
                },
              } : {}),
            }),
            signal: controller.signal,
          });
          if (!response.ok) {
            const body = (await response.text()).slice(0, 500);
            throw new Error(`LLM HTTP ${response.status}: ${body}`);
          }
          const parsed = chatResponseSchema.parse(await response.json());
          const text = parsed.choices[0]?.message.content;
          if (!text) throw new Error('LLM returned an empty response');
          const result = {
            text,
            model: parsed.model ?? model,
            ...(parsed.usage?.prompt_tokens === undefined ? {} : { inputTokens: parsed.usage.prompt_tokens }),
            ...(parsed.usage?.completion_tokens === undefined ? {} : { outputTokens: parsed.usage.completion_tokens }),
          };
          this.logger.info({
            traceId: input.traceId,
            model: result.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          }, 'LLM request completed');
          return result;
        } catch (error) {
          lastError = error;
          this.logger.warn({ err: error, traceId: input.traceId, model, attempt }, 'LLM request failed');
        } finally {
          clearTimeout(timer);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('LLM request failed');
  }

  public async generateStructured<T>(
    request: StructuredLlmRequest<T>,
  ): Promise<StructuredLlmResponse<T>> {
    const response = await this.complete({
      ...request,
      structuredSchema: {
        name: request.schemaName,
        schema: azureJsonSchema(request.schema),
      },
    });
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(response.text);
    } catch (error) {
      throw new Error('LLM structured response is not valid JSON', { cause: error });
    }
    const data = request.schema.parse(parsedJson);
    return {
      data,
      model: response.model,
      traceId: request.traceId,
      ...(response.inputTokens === undefined ? {} : { inputTokens: response.inputTokens }),
      ...(response.outputTokens === undefined ? {} : { outputTokens: response.outputTokens }),
    };
  }

  public async generateText(request: TextLlmRequest): Promise<TextLlmResponse> {
    const response = await this.complete(request);
    return {
      text: response.text,
      model: response.model,
      traceId: request.traceId,
      ...(response.inputTokens === undefined ? {} : { inputTokens: response.inputTokens }),
      ...(response.outputTokens === undefined ? {} : { outputTokens: response.outputTokens }),
    };
  }

  public async checkConnection(): Promise<void> {
    await this.generateText({
      system: 'Reply with exactly OK.',
      user: 'health check',
      traceId: `health-${Date.now()}`,
      maxOutputTokens: 4,
    });
  }
}
