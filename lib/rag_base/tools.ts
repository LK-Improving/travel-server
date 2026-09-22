// RAG base 的 LangChain 工具。业务服务全部藏在强类型工具背后。
// 对齐 Python app/rag_base/tools.py。
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { ragService } from '../services/rag';
import { listKnowledgeBases } from '../repositories/knowledge';
import { amapProvider } from '../services/amapProvider';
import { skillRegistry } from '../skills/registry';

export interface CreateRagToolsOptions {
  retriever?: typeof ragService;
  metadataRepository?: { listKnowledgeBases: typeof listKnowledgeBases };
  amap?: typeof amapProvider;
  skills?: typeof skillRegistry;
}

export function createRagTools(options: CreateRagToolsOptions = {}): DynamicStructuredTool[] {
  const retriever = options.retriever ?? ragService;
  const repo = options.metadataRepository ?? { listKnowledgeBases };
  const amap = options.amap ?? amapProvider;
  const skills = options.skills ?? skillRegistry;

  const listKnowledgeBasesTool = new DynamicStructuredTool({
    name: 'list_knowledge_bases',
    description: '列出已激活知识库及其文档数量与描述。',
    schema: z.object({}),
    func: async () => {
      const rows = await repo.listKnowledgeBases(100, 0);
      return rows
        .filter((row) => row.status === 'active')
        .map((row) => ({
          name: String(row.name ?? ''),
          description: String(row.description ?? ''),
          status: String(row.status ?? ''),
          documentCount: Number(row.documentCount ?? 0),
        }));
    },
  });

  const searchKnowledgeBaseTool = new DynamicStructuredTool({
    name: 'search_knowledge_base',
    description: '在回答事实性问题前，检索可信知识库切片。',
    schema: z.object({
      query: z.string().min(1).describe('用于检索知识库切片的问题。'),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    func: async ({ query, limit }) => retriever.retrieve(query, { limit }),
  });

  const getWeatherTool = new DynamicStructuredTool({
    name: 'get_weather',
    description: '获取城市当前天气与未来三天预报。',
    schema: z.object({ city: z.string().min(1).max(50).default('杭州') }),
    func: async ({ city }) => amap.weather(city.trim()),
  });

  const searchPoiTool = new DynamicStructuredTool({
    name: 'search_poi',
    description: '搜索景点、餐厅、酒店等 POI。',
    schema: z.object({
      keywords: z.string().min(1).max(100),
      city: z.string().min(1).max(50).default('杭州'),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    func: async ({ keywords, city, limit }) => amap.searchPoi(keywords.trim(), city.trim(), limit),
  });

  const planRouteTool = new DynamicStructuredTool({
    name: 'plan_route',
    description: '规划两地之间的公交、驾车或步行路线。',
    schema: z.object({
      origin: z.string().min(1).max(100),
      destination: z.string().min(1).max(100),
      mode: z.enum(['driving', 'walking', 'transit']).default('transit'),
      city: z.string().min(1).max(50).default('杭州'),
    }),
    func: async ({ origin, destination, mode, city }) => amap.planRoute(origin.trim(), destination.trim(), mode, city.trim()),
  });

  const planItineraryTool = new DynamicStructuredTool({
    name: 'plan_itinerary',
    description: '组合天气、POI、路线工具，生成结构化行程草案。',
    schema: z.object({
      city: z.string().min(1).max(50).default('杭州'),
      days: z.number().int().min(1).max(14).default(1),
      partySize: z.number().int().min(1).max(20).default(1),
      origin: z.string().max(100).nullable().optional(),
      mustVisit: z.array(z.string().min(1).max(100)).max(30).default([]),
      poiKeywords: z.array(z.string().min(1).max(100)).max(10).default([]),
      transport: z.enum(['driving', 'walking', 'transit']).default('transit'),
      budgetCny: z.string().max(30).nullable().optional(),
    }),
    func: async (args) =>
      skills.execute('travel_planning', {
        city: args.city,
        days: args.days,
        partySize: args.partySize,
        origin: args.origin ?? null,
        mustVisit: args.mustVisit,
        poiKeywords: args.poiKeywords,
        transport: args.transport,
        budgetCny: args.budgetCny ?? null,
      }),
  });

  const adjustBudgetTool = new DynamicStructuredTool({
    name: 'adjust_budget',
    description: '使用提供的备选方案，以精确十进制运算在预算内调整明确费用项。',
    schema: z.object({
      budgetCny: z.union([z.number(), z.string()]).describe('人民币预算上限，正数。'),
      items: z
        .array(
          z.object({
            name: z.string().min(1).max(120),
            unitPriceCny: z.union([z.number(), z.string()]),
            quantity: z.number().int().min(1).max(1000).default(1),
            mandatory: z.boolean().default(false),
            alternatives: z
              .array(z.object({ name: z.string().min(1).max(120), unitPriceCny: z.union([z.number(), z.string()]), reason: z.string().max(300).default('') }))
              .max(20)
              .default([]),
          }),
        )
        .min(1)
        .max(100),
    }),
    func: async ({ budgetCny, items }) =>
      skills.execute('budget_adjustment', { budgetCny: new Decimal(String(budgetCny)), items }),
  });

  return [
    listKnowledgeBasesTool,
    searchKnowledgeBaseTool,
    getWeatherTool,
    searchPoiTool,
    planRouteTool,
    planItineraryTool,
    adjustBudgetTool,
  ];
}
