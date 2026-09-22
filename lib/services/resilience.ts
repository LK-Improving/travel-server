/**
 * 进程内韧性原语：固定窗口限流、熔断器、TTL 缓存。
 * 对齐 Python 版 app/services/resilience.py。
 *
 * 注意：这些状态是单进程的。多副本部署时应改用 Redis 实现
 * （限流用 rate-limiter-flexible、熔断用共享计数器），语义保持相同。
 */
import { createHash } from 'node:crypto';

export class RateLimitExceeded extends Error {
  constructor(message = '请求过于频繁，请稍后重试') {
    super(message);
    this.name = 'RateLimitExceeded';
  }
}

export class CircuitOpen extends Error {
  constructor(message = '模型依赖暂时熔断') {
    super(message);
    this.name = 'CircuitOpen';
  }
}

function now(): number {
  return Date.now();
}

export class InMemoryRateLimiter {
  private readonly windows = new Map<string, { started: number; count: number }>();
  readonly limit: number;
  readonly windowMs: number;

  constructor(options: { limit?: number; windowSeconds?: number } = {}) {
    this.limit = Math.max(Math.trunc(options.limit ?? 60), 1);
    this.windowMs = Math.max(Number(options.windowSeconds ?? 60), 1) * 1000;
  }

  acquire(key: string): void {
    const current = now();
    const existing = this.windows.get(key) ?? { started: current, count: 0 };
    let { started, count } = existing;
    if (current - started >= this.windowMs) {
      started = current;
      count = 0;
    }
    if (count >= this.limit) throw new RateLimitExceeded();
    this.windows.set(key, { started, count: count + 1 });
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  readonly failureThreshold: number;
  readonly resetMs: number;

  constructor(options: { failureThreshold?: number; resetSeconds?: number } = {}) {
    this.failureThreshold = Math.max(Math.trunc(options.failureThreshold ?? 3), 1);
    this.resetMs = Math.max(Number(options.resetSeconds ?? 30), 1) * 1000;
  }

  beforeCall(): void {
    if (this.openedAt === null) return;
    if (now() - this.openedAt >= this.resetMs) {
      this.openedAt = null;
      this.failures = 0;
      return;
    }
    throw new CircuitOpen();
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.openedAt = now();
  }

  get state(): 'closed' | 'open' {
    return this.openedAt === null ? 'closed' : 'open';
  }
}

export class TTLCache {
  private readonly values = new Map<string, { expiresAt: number; value: unknown }>();
  readonly ttlMs: number;
  readonly maxEntries: number;

  constructor(options: { ttlSeconds?: number; maxEntries?: number } = {}) {
    this.ttlMs = Math.max(Number(options.ttlSeconds ?? 0), 0) * 1000;
    this.maxEntries = Math.max(Math.trunc(options.maxEntries ?? 512), 1);
  }

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get<T>(key: string): T | null {
    if (!this.enabled) return null;
    const item = this.values.get(key);
    if (!item) return null;
    if (item.expiresAt <= now()) {
      this.values.delete(key);
      return null;
    }
    // 重新插入以维持 LRU 顺序。
    this.values.delete(key);
    this.values.set(key, item);
    return item.value as T;
  }

  set(key: string, value: unknown): void {
    if (!this.enabled) return;
    this.values.delete(key);
    this.values.set(key, { expiresAt: now() + this.ttlMs, value });
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next();
      if (oldest.done) break;
      this.values.delete(oldest.value);
    }
  }
}

export class ResilienceRegistry {
  readonly rateLimiter: InMemoryRateLimiter;
  readonly cache: TTLCache;
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(options: {
    rateLimit?: number;
    cacheTtl?: number;
    cacheMaxEntries?: number;
    failureThreshold?: number;
    resetSeconds?: number;
  }) {
    this.rateLimiter = new InMemoryRateLimiter({ limit: options.rateLimit ?? 60 });
    this.cache = new TTLCache({
      ttlSeconds: options.cacheTtl ?? 0,
      maxEntries: options.cacheMaxEntries ?? 512,
    });
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetSeconds = options.resetSeconds ?? 30;
  }

  private readonly failureThreshold: number;
  private readonly resetSeconds: number;

  breaker(name: string): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({
        failureThreshold: this.failureThreshold,
        resetSeconds: this.resetSeconds,
      });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }
}

export function requestCacheKey(modelName: string, payload: unknown): string {
  const serialized = JSON.stringify(payload ?? null, replacer);
  return createHash('sha256').update(`${modelName}:${serialized}`, 'utf8').digest('hex');
}

/** 稳定序列化：对象键排序，保证等价请求命中同一缓存键。 */
function replacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = (value as Record<string, unknown>)[key];
        return accumulator;
      }, {});
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * 包装一次模型调用：限流 → 缓存 → 熔断 → 调用。
 * 缓存只在调用成功后写入，失败不污染缓存。
 */
export async function callWithResilience<T>(
  options: {
    name: string;
    payload: unknown;
    rateLimiter?: InMemoryRateLimiter;
    breaker?: CircuitBreaker;
    cache?: TTLCache;
  },
  invoke: () => Promise<T>,
): Promise<T> {
  const { rateLimiter, breaker, cache, name, payload } = options;
  rateLimiter?.acquire(name);

  const key = cache?.enabled ? requestCacheKey(name, payload) : '';
  if (cache?.enabled) {
    const cached = cache.get<T>(key);
    if (cached !== null) return cached;
  }

  breaker?.beforeCall();
  const result = await invoke();
  breaker?.recordSuccess();
  if (cache?.enabled) cache.set(key, result);
  return result;
}

/** 在韧性包装内执行只读工具调用；失败时记录熔断并原样抛出。 */
export async function callToolWithResilience<T>(
  method: string,
  args: unknown[],
  guards: { rateLimiter?: InMemoryRateLimiter; breaker?: CircuitBreaker; cache?: TTLCache },
  invoke: () => Promise<T>,
): Promise<T> {
  const key = guards.cache?.enabled ? requestCacheKey(`amap:${method}`, args) : '';
  if (guards.cache?.enabled) {
    const cached = guards.cache.get<T>(key);
    if (cached !== null) return cached;
  }
  guards.rateLimiter?.acquire(`amap:${method}`);
  try {
    guards.breaker?.beforeCall();
    const result = await invoke();
    guards.breaker?.recordSuccess();
    if (guards.cache?.enabled) guards.cache.set(key, result);
    return result;
  } catch (error) {
    guards.breaker?.recordFailure();
    throw error;
  }
}

/** 带超时的调用，超时抛错；用于受策略保护的工具执行。 */
export async function callWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('工具调用超时')), Math.max(timeoutMs, 1));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
