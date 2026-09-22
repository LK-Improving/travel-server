/**
 * 统一错误信封与领域错误。
 * 成功：{ success: true, data }
 * 失败：{ success: false, error: { code, message, details? } }
 * 与 Python 版 main.py 的异常处理器逐项对齐。
 */
export const HTTP_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'FILE_TOO_LARGE',
  415: 'UNSUPPORTED_FILE_TYPE',
  422: 'VALIDATION_ERROR',
  503: 'DEPENDENCY_UNAVAILABLE',
};

/** 业务稳定错误码。客户端应优先读取 error.code。 */
export const BUSINESS_ERROR_CODES = {
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  CONVERSATION_NOT_OWNED: 'CONVERSATION_NOT_OWNED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  TOOL_DENIED: 'TOOL_DENIED',
} as const;

export interface ErrorDetail {
  code: string;
  message: string;
  details?: unknown;
}

export interface ErrorEnvelope {
  success: false;
  error: ErrorDetail;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code?: string, message?: string, details?: unknown) {
    super(message ?? code ?? '请求失败');
    this.name = 'HttpError';
    this.status = status;
    this.code = code ?? HTTP_ERROR_CODES[status] ?? 'HTTP_ERROR';
    this.details = details;
  }

  toEnvelope(): ErrorEnvelope {
    const error: ErrorDetail = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { success: false, error };
  }
}

/** 领域校验失败，调用方通常映射为 422。 */
export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

/** 领域状态冲突，调用方通常映射为 409。 */
export class DomainConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainConflictError';
  }
}

/** 资源/记录不存在，映射为 404 NOT_FOUND。 */
export class LookupError extends Error {
  constructor(message = '资源不存在') {
    super(message);
    this.name = 'LookupError';
  }
}

/** 越权，映射为 403 FORBIDDEN。 */
export class PermissionError extends Error {
  constructor(message = '没有访问权限') {
    super(message);
    this.name = 'PermissionError';
  }
}

/** 通用值校验失败，映射为 422 VALIDATION_ERROR。 */
export class ValueError extends Error {
  constructor(message = '请求值非法') {
    super(message);
    this.name = 'ValueError';
  }
}

/** 需要登录态，映射为 401 AUTH_REQUIRED。 */
export class AuthRequiredError extends Error {
  constructor(message = '该功能需要登录后使用') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

/** 会话不属于当前主体，映射为 404 CONVERSATION_NOT_OWNED。 */
export class ConversationNotOwnedError extends Error {
  constructor(message = '会话不存在或不属于当前项目') {
    super(message);
    this.name = 'ConversationNotOwnedError';
  }
}

/** 功能开关关闭，映射为 403 FEATURE_DISABLED。 */
export class FeatureDisabledError extends Error {
  constructor(message = '该功能已被项目配置关闭') {
    super(message);
    this.name = 'FeatureDisabledError';
  }
}

/** 高风险工具需要人工审批，SSE 发出 approval_required 事件。 */
export class ApprovalRequiredError extends Error {
  readonly approvalId: string;
  readonly toolName: string;

  constructor(approvalId: string, toolName: string, message = '该工具需要审批后执行') {
    super(message);
    this.name = 'ApprovalRequiredError';
    this.approvalId = approvalId;
    this.toolName = toolName;
  }
}

export class ToolDeniedError extends Error {
  readonly toolName: string;

  constructor(toolName: string, message = '当前策略不允许调用该工具') {
    super(message);
    this.name = 'ToolDeniedError';
    this.toolName = toolName;
  }
}

export const badRequest = (message = '请求参数错误', details?: unknown) =>
  new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = '未认证或登录已失效') => new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = '没有访问权限') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = '资源不存在', code = 'NOT_FOUND') => new HttpError(404, code, message);
export const conflict = (message = '资源状态冲突') => new HttpError(409, 'CONFLICT', message);
export const fileTooLarge = (message = '文件超过大小限制') => new HttpError(413, 'FILE_TOO_LARGE', message);
export const unsupportedFileType = (message = '不支持的文件类型') =>
  new HttpError(415, 'UNSUPPORTED_FILE_TYPE', message);
export const validationError = (message = '请求字段校验失败', details?: unknown) =>
  new HttpError(422, 'VALIDATION_ERROR', message, details);
export const dependencyUnavailable = (message = '外部依赖暂时不可用') =>
  new HttpError(503, 'DEPENDENCY_UNAVAILABLE', message);

const DEPENDENCY_HINTS = [
  'milvus',
  'elasticsearch',
  'redis',
  'minio',
  'pg',
  'openai',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'socket hang up',
];

/** 判断异常是否来自外部依赖，用于区分 503 与 500。 */
export function isDependencyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof HttpError) return error.status === 503;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const message = `${error.message} ${error.stack ?? ''}`.toLowerCase();
  return DEPENDENCY_HINTS.some((hint) => message.includes(hint.toLowerCase()));
}

/** 把任意异常收敛为统一错误信封。 */
export function toErrorEnvelope(error: unknown): { status: number; body: ErrorEnvelope } {
  if (error instanceof HttpError) {
    return { status: error.status, body: error.toEnvelope() };
  }
  if (error instanceof DomainValidationError) {
    return { status: 422, body: { success: false, error: { code: 'VALIDATION_ERROR', message: error.message } } };
  }
  if (error instanceof DomainConflictError) {
    return { status: 409, body: { success: false, error: { code: 'CONFLICT', message: error.message } } };
  }
  if (error instanceof FeatureDisabledError) {
    return { status: 403, body: { success: false, error: { code: 'FEATURE_DISABLED', message: error.message } } };
  }
  if (error instanceof LookupError) {
    return { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: error.message } } };
  }
  if (error instanceof PermissionError) {
    return { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: error.message } } };
  }
  if (error instanceof ValueError) {
    return { status: 422, body: { success: false, error: { code: 'VALIDATION_ERROR', message: error.message } } };
  }
  if (error instanceof AuthRequiredError) {
    return { status: 401, body: { success: false, error: { code: 'AUTH_REQUIRED', message: error.message } } };
  }
  if (error instanceof ConversationNotOwnedError) {
    return { status: 404, body: { success: false, error: { code: 'CONVERSATION_NOT_OWNED', message: error.message } } };
  }
  if (error instanceof ToolDeniedError) {
    return { status: 403, body: { success: false, error: { code: 'TOOL_DENIED', message: error.message } } };
  }
  if (isDependencyError(error)) {
    return {
      status: 503,
      body: { success: false, error: { code: 'DEPENDENCY_UNAVAILABLE', message: '外部依赖暂时不可用' } },
    };
  }
  return {
    status: 500,
    body: { success: false, error: { code: 'INTERNAL_ERROR', message: '服务内部错误' } },
  };
}
