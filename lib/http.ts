/**
 * Next.js Route Handler 适配层：统一响应信封、CORS、错误收敛、SSE 流与鉴权解析。
 * Python 版由 FastAPI 中间件 + dependencies.py 承担，这里收敛到少量显式函数。
 */
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { getAllowedOrigins } from './config';
import { HttpError, toErrorEnvelope, validationError, type ErrorEnvelope } from './errors';
import { SSE_HEADERS, plainEnd, plainError } from './sse';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * 统一成功信封。入参用 unknown 而非 JsonValue：
 * 领域接口（DocumentRecord 等）没有索引签名，卡 JsonValue 会导致每个路由都要做无意义的类型体操。
 * 序列化由 NextResponse.json 负责，非法值（BigInt/循环引用）会在运行期暴露，不在类型层伪装安全。
 */
export function successResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json({ success: true, data }, { status });
}

/** 鉴权助手再导出：路由统一从 http 层取用，避免同一符号在两处导入。 */
export { currentUser, adminReader, adminWriter, publicSubject } from './auth/subject';
/** 错误构造器再导出，路由无需分别感知 http/errors/subject 三个模块。 */
export {
  badRequest,
  conflict,
  dependencyUnavailable,
  forbidden,
  notFound,
  unauthorized,
  validationError,
} from './errors';

export function errorResponse(error: unknown): NextResponse {
  const { status, body } = toErrorEnvelope(error);
  return NextResponse.json(body as ErrorEnvelope, { status });
}

/** 为响应附加 CORS 头。Next.js 不自带全局 CORS 中间件，需逐响应处理。 */
export function withCors(response: NextResponse, origin: string | null): NextResponse {
  const allowed = getAllowedOrigins();
  if (origin && allowed.has(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }
  response.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Application-Key,X-Client-Id,X-Approval-Token');
  return response;
}

/** 预检请求。非信任来源也返回 200，避免暴露内部配置（对齐 Python 版 UntrustedPreflightMiddleware）。 */
export function preflight(origin: string | null): NextResponse {
  const allowed = getAllowedOrigins();
  const response = new NextResponse(null, { status: 200 });
  if (origin && allowed.has(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Credentials', 'true');
  }
  response.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Application-Key,X-Client-Id,X-Approval-Token');
  response.headers.set('Access-Control-Max-Age', '86400');
  return response;
}

export type Handler = (request: NextRequest, context: RouteContext) => Promise<NextResponse> | NextResponse;

export interface RouteContext {
  params: Promise<Record<string, string>>;
}

/**
 * 包装 Route Handler：收敛异常 + 附加 CORS。
 * Next.js 15+ 的 params 是 Promise，由包装器统一 await 后传入。
 */
export function route(handler: (request: NextRequest, params: Record<string, string>) => Promise<NextResponse> | NextResponse): Handler {
  return async (request, context) => {
    const origin = request.headers.get('origin');
    if (request.method === 'OPTIONS') return preflight(origin);
    try {
      const params = (await context?.params) ?? {};
      const response = await handler(request, params);
      return withCors(response, origin);
    } catch (error) {
      return withCors(errorResponse(error), origin);
    }
  };
}

/**
 * 解析并校验 JSON 请求体，失败统一抛 422。
 * 第三个泛型位放 unknown：带 .default() 的 schema 输入与输出类型不同，
 * 卡成 ZodType<T> 会让 TS 退回去推断输入类型，导致必填字段被判成可选。
 */
export async function parseJson<T>(request: NextRequest, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw validationError('请求体不是合法 JSON');
  }
  try {
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw validationError('请求字段校验失败', error.issues);
    }
    throw error;
  }
}

/** 解析查询参数为对象。 */
export function parseQuery(request: NextRequest): URLSearchParams {
  return new URL(request.url).searchParams;
}

export function readInt(params: URLSearchParams, key: string, fallback: number, min = 1, max = 200): number {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw validationError(`${key} 必须为整数`);
  return Math.min(Math.max(parsed, min), max);
}

export function readString(params: URLSearchParams, key: string): string | undefined {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return undefined;
  return raw.trim();
}

export function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

export function applicationKey(request: NextRequest): string | null {
  const raw = request.headers.get('x-application-key');
  return raw && raw.trim() ? raw.trim() : null;
}

export function clientId(request: NextRequest): string | null {
  const raw = request.headers.get('x-client-id');
  return raw && raw.trim() ? raw.trim() : null;
}

export function approvalToken(request: NextRequest): string | null {
  const raw = request.headers.get('x-approval-token');
  return raw && raw.trim() ? raw.trim() : null;
}

/**
 * 把异步生成器包装为 SSE 响应。
 * 生成器内部抛出的错误会转成 error 事件，避免连接被直接切断导致前端无提示。
 */
export function sseResponse(
  factory: (emit: (chunk: string) => void, isClosed: () => boolean) => Promise<void>,
  options: { heartbeatMs?: number } = {},
): NextResponse {
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let cleanup: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      // 客户端断开时 cancel() 会置 closed，生成器据此提前结束，避免继续调用模型。
      const isClosed = () => closed;

      if (options.heartbeatMs && options.heartbeatMs > 0) {
        heartbeat = setInterval(() => emit(': heartbeat\n\n'), options.heartbeatMs);
      }

      cleanup = () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
      };

      try {
        await factory(emit, isClosed);
      } catch (error) {
        const message = error instanceof Error ? error.message : '流式响应失败';
        emit(plainError(message));
      } finally {
        emit(plainEnd());
        cleanup();
        try {
          controller.close();
        } catch {
          /* 连接已被客户端关闭 */
        }
      }
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      cleanup?.();
    },
  });

  return new NextResponse(stream, { status: 200, headers: SSE_HEADERS });
}

/** 抛出式鉴权断言，供路由内部使用。 */
export function requireValue<T>(value: T | null | undefined, error: HttpError): T {
  if (value === null || value === undefined) throw error;
  return value;
}
