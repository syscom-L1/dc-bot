import { z } from 'zod';

const schema = z.object({
  CUBI_LLM_BASE_URL: z.string().url().optional().or(z.literal('')),
  CUBI_LLM_API_KEY: z.string().default(''),
  CUBI_LLM_MODEL: z.string().default(''),
  CUBI_LLM_FALLBACK_MODEL: z.string().default(''),
  CUBI_LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
});

export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModel: string;
  timeoutMs: number;
}

export function loadLlmConfig(source: NodeJS.ProcessEnv = process.env): LlmConfig {
  const env = schema.parse(source);
  const enabled = Boolean(env.CUBI_LLM_BASE_URL && env.CUBI_LLM_MODEL);
  if (enabled && !env.CUBI_LLM_API_KEY) {
    throw new Error('CUBI_LLM_API_KEY is required when the LLM integration is enabled');
  }
  return {
    enabled,
    baseUrl: env.CUBI_LLM_BASE_URL || '',
    apiKey: env.CUBI_LLM_API_KEY,
    model: env.CUBI_LLM_MODEL,
    fallbackModel: env.CUBI_LLM_FALLBACK_MODEL,
    timeoutMs: env.CUBI_LLM_TIMEOUT_MS,
  };
}
