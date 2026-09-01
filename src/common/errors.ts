export class AppError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 500,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export function discordErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AppError) return '❌ ' + error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (/LLM HTTP (401|403)|authentication|api.?key/iu.test(message)) {
    return '❌ Azure AI 驗證失敗。請管理員檢查 Endpoint、API Key 與模型部署名稱。';
  }
  if (/LLM HTTP 429|rate.?limit/iu.test(message)) {
    return '⏳ Azure AI 目前請求過多，Bot 會自動重試；若持續發生請稍後再試。';
  }
  if (/aborted|timeout/iu.test(message)) {
    return '⏳ 外部服務回應逾時，請稍後再試。';
  }
  if (/Invalid GitHub App installation ID/iu.test(message)) {
    return '❌ GitHub Installation ID 格式不正確，請填安裝網址最後面的數字。';
  }
  if (/Resource not accessible|GitHub HTTP 403|status 403/iu.test(message)) {
    return '❌ GitHub App 沒有這個 Repository 的權限，請重新安裝或在安裝設定中勾選該 Repo。';
  }
  if (/Not Found|GitHub HTTP 404|status 404/iu.test(message)) {
    return '❌ 找不到 GitHub 資源。請確認 owner、Repository 名稱與 App 安裝範圍。';
  }
  return '❌ ' + fallback;
}

export class ValidationError extends AppError {
  public constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

export class ForbiddenError extends AppError {
  public constructor(message = 'You are not allowed to perform this action') {
    super(message, 'FORBIDDEN', 403);
  }
}

export class NotFoundError extends AppError {
  public constructor(message = 'Resource not found') {
    super(message, 'NOT_FOUND', 404);
  }
}

export class ConflictError extends AppError {
  public constructor(message: string) {
    super(message, 'CONFLICT', 409);
  }
}
