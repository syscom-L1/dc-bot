import type { z } from 'zod';

export interface StructuredLlmRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  schemaName: string;
  traceId: string;
  maxOutputTokens?: number;
}

export interface StructuredLlmResponse<T> {
  data: T;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  traceId: string;
}

export interface TextLlmRequest {
  system: string;
  user: string;
  traceId: string;
  maxOutputTokens?: number;
}

export interface TextLlmResponse {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  traceId: string;
}

export interface LlmAdapter {
  generateStructured<T>(request: StructuredLlmRequest<T>): Promise<StructuredLlmResponse<T>>;
  generateText(request: TextLlmRequest): Promise<TextLlmResponse>;
  checkConnection(): Promise<void>;
}
