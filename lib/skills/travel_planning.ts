// 确定性行程编排 Skill（对齐 Python app/skills/travel_planning.py）。
import { z } from 'zod';
import type { AmapProvider } from '../services/amapProvider';
import { defineSkill } from './define';
import type { SkillExecutionContext } from './base';

const TravelPlanningRequest = z.object({
  city: z.string().min(1).max(50).default('杭州'),
  days: z.number().int().min(1).max(14).default(1),
  partySize: z.number().int().min(1).max(20).default(1),
  origin: z.string().max(100).nullable().optional(),
  mustVisit: z.array(z.string().min(1).max(100)).max(30).default([]),
  poiKeywords: z.array(z.string().min(1).max(100)).max(10).default([]),
  transport: z.enum(['driving', 'walking', 'transit']).default('transit'),
  budgetCny: z.string().max(30).nullable().optional(),
});
export type TravelPlanningRequestType = z.infer<typeof TravelPlanningRequest>;

const TravelPlanItem = z.object({
  name: z.string(),
  address: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  rating: z.string().nullable().optional(),
  source: z.enum(['amap', 'user_input']),
});

const TravelDay = z.object({
  day: z.number().int().min(1),
  items: z.array(TravelPlanItem).default([]),
  routes: z.array(z.record(z.unknown())).default([]),
});

const TravelPlanningResult = z.object({
  status: z.enum(['planned', 'partial', 'unavailable']),
  city: z.string(),
  partySize: z.number().int().min(1),
  days: z.array(TravelDay),
  weather: z.record(z.unknown()).nullable().optional(),
  budgetStatus: z.enum(['not_evaluated', 'provided_without_prices']),
  warnings: z.array(z.string()).default([]),
  toolTrace: z.array(z.record(z.unknown())).default([]),
});

export const travelPlanningSkill = (amap: AmapProvider) =>
  defineSkill<TravelPlanningRequestType, z.infer<typeof TravelPlanningResult>>({
    name: 'travel_planning',
    version: '1.0.0',
    description: '根据城市、天数和偏好调用天气、POI、路线工具，生成结构化行程草案。',
    inputModel: TravelPlanningRequest,
    outputModel: TravelPlanningResult,
    inputJsonSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', default: '杭州' },
        days: { type: 'integer', minimum: 1, maximum: 14 },
        partySize: { type: 'integer', minimum: 1, maximum: 20 },
        origin: { type: 'string', nullable: true },
        mustVisit: { type: 'array', items: { type: 'string' } },
        poiKeywords: { type: 'array', items: { type: 'string' } },
        transport: { type: 'string', enum: ['driving', 'walking', 'transit'] },
        budgetCny: { type: 'string', nullable: true },
      },
    },
    outputJsonSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['planned', 'partial', 'unavailable'] },
        days: { type: 'array' },
        weather: { type: 'object', nullable: true },
        budgetStatus: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
        toolTrace: { type: 'array', items: { type: 'object' } },
      },
    },
    run: async (request: TravelPlanningRequestType, _context?: SkillExecutionContext) => {
      void _context;
      const warnings: string[] = [];
      const toolTrace: Record<string, unknown>[] = [];
      let weather: Record<string, unknown> | null = null;
      try {
        weather = (await amap.weather(request.city)) as unknown as Record<string, unknown>;
        toolTrace.push({ tool: 'get_weather', status: 'succeeded' });
      } catch {
        warnings.push('天气查询暂时不可用，行程未使用天气条件优化。');
        toolTrace.push({ tool: 'get_weather', status: 'failed' });
      }

      const candidates: z.infer<typeof TravelPlanItem>[] = [];
      const seen = new Set<string>();
      for (const keyword of [...(request.mustVisit ?? []), ...(request.poiKeywords ?? [])]) {
        if (seen.has(keyword)) continue;
        seen.add(keyword);
        try {
          const pois = await amap.searchPoi(keyword, request.city, 5);
          toolTrace.push({ tool: 'search_poi', keyword, status: 'succeeded' });
          if (!pois.length) {
            warnings.push(`未找到地点：${keyword}。`);
            continue;
          }
          const poi = pois[0] as unknown as Record<string, unknown>;
          candidates.push({
            name: String(poi.name ?? keyword).trim(),
            address: (poi.address as string) ?? null,
            location: (poi.location as string) ?? null,
            type: (poi.type as string) ?? null,
            rating: (poi.rating as string) ?? null,
            source: 'amap',
          });
        } catch {
          warnings.push(`未能查询地点：${keyword}。`);
          toolTrace.push({ tool: 'search_poi', keyword, status: 'failed' });
        }
      }

      if (!candidates.length) warnings.push('当前没有足够的 POI 结果生成可执行行程。');

      const dayPlans = Array.from({ length: request.days }, (_, i) => ({ day: i + 1, items: [] as z.infer<typeof TravelPlanItem>[], routes: [] as Record<string, unknown>[] }));
      candidates.forEach((item, index) => {
        dayPlans[index % request.days].items.push(item);
      });

      for (const day of dayPlans) {
        let previous: string | null = day.day === 1 ? (request.origin ?? null) : null;
        for (const item of day.items) {
          if (previous) {
            try {
              const route = await amap.planRoute(previous, item.name, request.transport, request.city);
              day.routes.push(route);
              toolTrace.push({ tool: 'plan_route', status: 'succeeded', mode: request.transport });
            } catch {
              warnings.push(`未能规划 ${previous} 到 ${item.name} 的路线。`);
              toolTrace.push({ tool: 'plan_route', status: 'failed', mode: request.transport });
            }
          }
          previous = item.name;
        }
      }

      const status: 'planned' | 'partial' | 'unavailable' = candidates.length && !warnings.length ? 'planned' : candidates.length ? 'partial' : 'unavailable';
      return {
        status,
        city: request.city,
        partySize: request.partySize,
        days: dayPlans,
        weather,
        budgetStatus: request.budgetCny != null ? 'provided_without_prices' : 'not_evaluated',
        warnings,
        toolTrace,
      };
    },
  });
