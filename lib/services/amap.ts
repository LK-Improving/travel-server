/**
 * 高德开放平台 Web 服务客户端：天气、POI 搜索、路径规划。
 * 对齐 Python 版 app/services/amap.py。所有只读调用，不写任何业务数据。
 */
import { config } from '../config';

export const AMAP_BASE_URL = 'https://restapi.amap.com';
export const DEFAULT_CITY = '杭州';
export const HANGZHOU_ADCODE = '330100';

export class AmapDependencyError extends Error {
  constructor(message = '高德接口不可用') {
    super(message);
    this.name = 'AmapDependencyError';
  }
}

export interface AmapPoi {
  name: string;
  type: string | null;
  address: string | null;
  location: string | null;
  rating: string | null;
  tel: string | null;
}

export interface AmapWeather {
  city: string;
  reportTime: string | null;
  now: {
    weather: string | null;
    temperature: string | null;
    windDirection: string | null;
    windPower: string | null;
    humidity: string | null;
  };
  forecast: Array<{
    date: string | null;
    dayWeather: string | null;
    nightWeather: string | null;
    dayTemp: string | null;
    nightTemp: string | null;
  }>;
}

export class AmapClient {
  constructor(private readonly apiKey: string = config.amapApiKey) {}

  private async get(path: string, params: Record<string, string | number>): Promise<Record<string, any>> {
    if (!this.apiKey) throw new AmapDependencyError('AMAP_API_KEY 未配置');
    const url = new URL(`${AMAP_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    url.searchParams.set('key', this.apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.toolTimeoutMs);
    let payload: Record<string, any>;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new AmapDependencyError(`高德接口 HTTP ${response.status}`);
      payload = (await response.json()) as Record<string, any>;
    } catch (error) {
      if (error instanceof AmapDependencyError) throw error;
      throw new AmapDependencyError('高德接口请求失败');
    } finally {
      clearTimeout(timer);
    }
    if (String(payload.status) !== '1') {
      throw new AmapDependencyError(`高德接口错误：${payload.info ?? 'unknown'}`);
    }
    return payload;
  }

  /** 城市/区县名 → adcode；解析失败回退杭州市。 */
  private async adcode(city: string): Promise<string> {
    try {
      const payload = await this.get('/v3/geocode/geo', { address: city });
      const geocodes = (payload.geocodes ?? []) as Array<{ adcode?: string }>;
      if (geocodes[0]?.adcode) return String(geocodes[0].adcode);
    } catch {
      /* 回退默认城市 */
    }
    return HANGZHOU_ADCODE;
  }

  async weather(city: string): Promise<AmapWeather> {
    const target = city || DEFAULT_CITY;
    const adcode = await this.adcode(target);
    const live = await this.get('/v3/weather/weatherInfo', { city: adcode, extensions: 'base' });
    const forecast = await this.get('/v3/weather/weatherInfo', { city: adcode, extensions: 'all' });
    const lives = ((live.lives ?? []) as Array<Record<string, any>>)[0] ?? {};
    const casts = (
      ((forecast.forecasts ?? []) as Array<Record<string, any>>)[0]?.casts ?? []
    ).slice(0, 3) as Array<Record<string, any>>;

    return {
      city: String(lives.city ?? target),
      reportTime: lives.reporttime ?? null,
      now: {
        weather: lives.weather ?? null,
        temperature: lives.temperature ?? null,
        windDirection: lives.winddirection ?? null,
        windPower: lives.windpower ?? null,
        humidity: lives.humidity ?? null,
      },
      forecast: casts.map((cast) => ({
        date: cast.date ?? null,
        dayWeather: cast.dayweather ?? null,
        nightWeather: cast.nightweather ?? null,
        dayTemp: cast.daytemp ?? null,
        nightTemp: cast.nighttemp ?? null,
      })),
    };
  }

  async searchPoi(keywords: string, city: string, limit: number): Promise<AmapPoi[]> {
    const payload = await this.get('/v3/place/text', {
      keywords,
      city: city || DEFAULT_CITY,
      citylimit: 'true',
      offset: Math.min(Math.max(Math.trunc(limit), 1), 10),
      page: 1,
      extensions: 'all',
    });
    const pois = (payload.pois ?? []) as Array<Record<string, any>>;
    return pois.slice(0, Math.max(Math.trunc(limit), 1)).map((poi) => {
      const rating = (poi.biz_ext ?? {})?.rating;
      const tel = poi.tel;
      return {
        name: String(poi.name ?? ''),
        type: poi.type ?? null,
        address: poi.address || null,
        location: poi.location ?? null,
        rating: typeof rating === 'string' && rating ? rating : null,
        tel: typeof tel === 'string' && tel ? tel : null,
      };
    });
  }

  /** 地点名 → 坐标（优先 POI，兜底地理编码）。 */
  private async resolve(place: string, city: string): Promise<{ name: string; location: string }> {
    const pois = await this.searchPoi(place, city, 1);
    if (pois[0]?.location) return { name: pois[0].name, location: pois[0].location };
    const payload = await this.get('/v3/geocode/geo', { address: place, city: city || DEFAULT_CITY });
    const geocodes = (payload.geocodes ?? []) as Array<{ location?: string }>;
    if (geocodes[0]?.location) return { name: place, location: geocodes[0].location! };
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
    const base = { mode, origin: start, destination: end };

    if (mode === 'transit') {
      const payload = await this.get('/v3/direction/transit/integrated', {
        origin: start.location,
        destination: end.location,
        city: city || DEFAULT_CITY,
      });
      const transits = ((payload.route ?? {}) as Record<string, any>).transits ?? [];
      if (!transits.length) return { ...base, notice: '未查询到公共交通方案' };
      const best = transits[0] as Record<string, any>;
      const lines = ((best.segments ?? []) as Array<Record<string, any>>)
        .flatMap((segment) => ((segment.bus ?? {}) as Record<string, any>).buslines ?? [])
        .map((bus: Record<string, any>) => String(bus.name ?? '').split('(')[0])
        .filter(Boolean);
      return {
        ...base,
        durationSeconds: Number(best.duration ?? 0),
        walkingMeters: Number(best.walking_distance ?? 0),
        cost: best.cost ?? null,
        lines,
      };
    }

    const pathKey = mode === 'walking' ? '/v3/direction/walking' : '/v3/direction/driving';
    const payload = await this.get(pathKey, { origin: start.location, destination: end.location });
    const paths = ((payload.route ?? {}) as Record<string, any>).paths ?? [];
    if (!paths.length) return { ...base, notice: '未查询到路线方案' };
    const best = paths[0] as Record<string, any>;
    const steps = ((best.steps ?? []) as Array<Record<string, any>>)
      .slice(0, 8)
      .map((step) => step.instruction)
      .filter(Boolean);
    return {
      ...base,
      distanceMeters: Number(best.distance ?? 0),
      durationSeconds: Number(best.duration ?? 0),
      steps,
    };
  }
}

export const amapClient = new AmapClient();
