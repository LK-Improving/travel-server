/**
 * 高德 Provider 边界：MCP（Streamable HTTP）优先，失败自动回退 REST，
 * 外层再套限流、缓存与熔断。对齐 Python 版 app/services/amap_provider.py。
 */
import { config } from '../config';
import { AmapClient, AmapDependencyError, type AmapPoi, type AmapWeather } from './amap';
import { callToolWithResilience, InMemoryRateLimiter, TTLCache, CircuitBreaker } from './resilience';

export interface AmapProvider {
  weather(city: string): Promise<AmapWeather>;
  searchPoi(keywords: string, city: string, limit: number): Promise<AmapPoi[]>;
  planRoute(origin: string, destination: string, mode: string, city: string): Promise<Record<string, unknown>>;
}

const MCP_TOOL_NAMES: Record<string, string> = {
  weather: 'maps_weather',
  search_poi: 'maps_text_search',
  geocode: 'maps_geo',
  walking: 'maps_walking',
  driving: 'maps_driving',
  transit: 'maps_transit',
};

function decodeContent(value: unknown): unknown {
  const record = value as Record<string, any>;
  const structured = record?.structuredContent ?? record?.structured_content;
  if (structured) return structured;
  if (record && typeof record === 'object') {
    const nested = record.structuredContent ?? record.structured_content;
    if (nested) return nested;
  }
  const content = (record?.content ?? []) as Array<{ text?: string }>;
  const raw = content
    .map((item) => item?.text)
    .filter(Boolean)
    .join('\n');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

function unwrapToolResult(value: unknown): unknown {
  const record = value as Record<string, any>;
  if (record?.isError || record?.is_error) throw new AmapDependencyError('高德 MCP 工具调用失败');
  return decodeContent(value);
}

/** 短生命周期 MCP 客户端。SDK 未安装时直接抛依赖错误，由上层回退 REST。 */
class McpAmapProvider implements AmapProvider {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly toolNames: Record<string, string> = MCP_TOOL_NAMES,
  ) {}

  private get endpoint(): string {
    if (!this.apiKey || this.url.includes('key=')) return this.url;
    return `${this.url}${this.url.includes('?') ? '&' : '?'}key=${this.apiKey}`;
  }

  private async call(toolKey: string, args: Record<string, unknown>): Promise<unknown> {
    let clientModule: any;
    let streamableModule: any;
    try {
      clientModule = await import(/* webpackIgnore: true */ '@modelcontextprotocol/sdk/client/index.js');
      streamableModule = await import(/* webpackIgnore: true */ '@modelcontextprotocol/sdk/client/streamableHttp.js');
    } catch {
      throw new AmapDependencyError('未安装 MCP SDK，回退 REST');
    }
    const { ClientSession } = streamableModule;
    const { streamableHttpClient } = streamableModule;
    const transport = await streamableHttpClient(this.endpoint);
    const session = new ClientSession(transport.read, transport.write);
    await session.initialize();
    const result = await session.callTool(this.toolNames[toolKey], args);
    return unwrapToolResult(result);
  }

  async weather(city: string): Promise<AmapWeather> {
    const result = await this.call('weather', { city });
    return McpAmapProvider.normalizeWeather(result, city) as unknown as AmapWeather;
  }

  async searchPoi(keywords: string, city: string, limit: number): Promise<AmapPoi[]> {
    let result = await this.call('search_poi', { keywords, city });
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const record = result as Record<string, any>;
      result = record.pois ?? record.suggestion ?? [];
    }
    const rows = (Array.isArray(result) ? result : []).slice(0, Math.max(Math.trunc(limit), 1));
    return rows
      .filter((poi): poi is Record<string, any> => Boolean(poi) && typeof poi === 'object')
      .map((poi) => ({
        name: String(poi.name ?? ''),
        type: poi.type ?? null,
        address: poi.address ?? null,
        location: poi.location ?? null,
        rating: poi.rating ?? (poi.biz_ext ?? {})?.rating ?? null,
        tel: poi.tel ?? null,
        poiId: poi.id ?? poi.poiId ?? null,
      })) as AmapPoi[];
  }

  private async resolve(place: string, city: string): Promise<{ name: string; location: string }> {
    const result = (await this.call('geocode', { address: place, city })) as Record<string, any>;
    if (result && typeof result === 'object') {
      const location = result.location ?? (result.geocodes ?? [{}])[0]?.location;
      if (location) return { name: place, location: String(location) };
    }
    throw new AmapDependencyError(`无法定位地点：${place}`);
  }

  async planRoute(
    origin: string,
    destination: string,
    mode: string,
    city: string,
  ): Promise<Record<string, unknown>> {
    const start = await this.resolve(origin, city);
    const end = await this.resolve(destination, city);
    const result = await this.call(mode, { origin: start.location, destination: end.location, city });
    const base = { mode, origin: start, destination: end };
    if (result && typeof result === 'object') return { ...base, ...(result as Record<string, unknown>) };
    return { ...base, result };
  }

  private static normalizeWeather(result: unknown, city: string): Record<string, unknown> {
    if (result && typeof result === 'object' && 'now' in (result as Record<string, unknown>)) {
      return result as Record<string, unknown>;
    }
    if (result && typeof result === 'object') {
      const record = result as Record<string, any>;
      const forecasts = record.forecasts ?? record.forecast ?? [];
      return {
        city: record.city ?? city,
        reportTime: record.reportTime ?? null,
        now: record.now ?? {},
        forecast: forecasts,
      };
    }
    return { city, reportTime: null, now: {}, forecast: [] };
  }
}

/** MCP 优先，失败回退 REST。未启用 MCP 时直接走 REST。 */
class FallbackAmapProvider implements AmapProvider {
  constructor(
    private readonly primary: AmapProvider,
    private readonly fallback: AmapProvider,
    private readonly enabled: boolean,
  ) {}

  private async run<T>(method: keyof AmapProvider, args: unknown[]): Promise<T> {
    if (!this.enabled) return (this.fallback[method] as CallableFunction)(...args) as T;
    try {
      return (this.primary[method] as CallableFunction)(...args) as T;
    } catch {
      return (this.fallback[method] as CallableFunction)(...args) as T;
    }
  }

  weather(city: string): Promise<AmapWeather> {
    return this.run<AmapWeather>('weather', [city]);
  }
  searchPoi(keywords: string, city: string, limit: number): Promise<AmapPoi[]> {
    return this.run<AmapPoi[]>('searchPoi', [keywords, city, limit]);
  }
  planRoute(origin: string, destination: string, mode: string, city: string): Promise<Record<string, unknown>> {
    return this.run<Record<string, unknown>>('planRoute', [origin, destination, mode, city]);
  }
}

/** 在只读地图调用外统一套上限流、缓存与熔断。 */
export class ResilientAmapProvider implements AmapProvider {
  private readonly breakers: Record<string, CircuitBreaker>;

  constructor(
    private readonly provider: AmapProvider,
    private readonly rateLimiter = new InMemoryRateLimiter({ limit: config.modelRateLimitPerMinute }),
    private readonly cache = new TTLCache({
      ttlSeconds: config.modelCacheTtlSeconds,
      maxEntries: config.modelCacheMaxEntries,
    }),
  ) {
    this.breakers = {
      weather: new CircuitBreaker({
        failureThreshold: config.modelCircuitFailureThreshold,
        resetSeconds: config.modelCircuitResetSeconds,
      }),
      searchPoi: new CircuitBreaker({
        failureThreshold: config.modelCircuitFailureThreshold,
        resetSeconds: config.modelCircuitResetSeconds,
      }),
      planRoute: new CircuitBreaker({
        failureThreshold: config.modelCircuitFailureThreshold,
        resetSeconds: config.modelCircuitResetSeconds,
      }),
    };
  }

  weather(city: string): Promise<AmapWeather> {
    return callToolWithResilience(
      'weather',
      [city],
      { rateLimiter: this.rateLimiter, breaker: this.breakers.weather, cache: this.cache },
      () => this.provider.weather(city),
    );
  }

  searchPoi(keywords: string, city: string, limit: number): Promise<AmapPoi[]> {
    return callToolWithResilience(
      'search_poi',
      [keywords, city, limit],
      { rateLimiter: this.rateLimiter, breaker: this.breakers.searchPoi, cache: this.cache },
      () => this.provider.searchPoi(keywords, city, limit),
    );
  }

  planRoute(origin: string, destination: string, mode: string, city: string): Promise<Record<string, unknown>> {
    return callToolWithResilience(
      'plan_route',
      [origin, destination, mode, city],
      { rateLimiter: this.rateLimiter, breaker: this.breakers.planRoute, cache: this.cache },
      () => this.provider.planRoute(origin, destination, mode, city),
    );
  }
}

function buildProvider(): AmapProvider {
  const mcp = new McpAmapProvider(config.amapMcpUrl, config.amapMcpApiKey);
  const base = new FallbackAmapProvider(
    mcp,
    new AmapClient(),
    config.amapMcpEnabled && Boolean(config.amapMcpUrl),
  );
  return new ResilientAmapProvider(base);
}

export const amapProvider: AmapProvider = buildProvider();
