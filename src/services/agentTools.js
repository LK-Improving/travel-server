import RagServer from "./ragServer.js";

const cityPois = {
  杭州: [
    { name: "西湖", tags: ["湖景", "经典"], duration: "3-4小时" },
    { name: "灵隐寺", tags: ["祈福", "人文"], duration: "2-3小时" },
    { name: "河坊街", tags: ["美食", "街区"], duration: "1-2小时" },
  ],
  长沙: [
    { name: "橘子洲", tags: ["地标", "江景"], duration: "2-3小时" },
    { name: "岳麓山", tags: ["自然", "历史"], duration: "3-4小时" },
    { name: "太平老街", tags: ["美食", "街区"], duration: "1-2小时" },
  ],
};

function assertString(args, key, fallback = "") {
  const value = args?.[key];
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim();
}

function normalizeLimit(value, fallback = 5) {
  const number = Number(value || fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), 1), 10);
}

function withTimeout(promise, timeoutMs, toolName) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${toolName} 调用超时`));
      }, timeoutMs);
    }),
  ]);
}

const toolDefinitions = [
  {
    name: "search_knowledge_base",
    description: "从 Supabase pgvector 旅游知识库检索与用户问题相关的资料片段。",
    parameters: {
      query: "string，用户问题或检索关键词",
      matchCount: "number，可选，返回条数，默认 5",
      threshold: "number，可选，相似度阈值",
    },
    timeoutMs: 20000,
    async run(args) {
      const query = assertString(args, "query");
      if (!query) throw new Error("query 不能为空");

      const result = await RagServer.searchWithFallback(query, {
        matchCount: normalizeLimit(args.matchCount, 5),
        threshold: args.threshold,
      });

      return {
        ...result,
        summary: result.data.length
          ? `知识库命中 ${result.data.length} 条资料`
          : "知识库未命中可用资料",
      };
    },
  },
  {
    name: "get_weather",
    description: "查询城市天气。当前为教学用模拟工具，真实项目可替换为天气 API。",
    parameters: {
      city: "string，城市名",
      date: "string，可选，日期，如 明天/周末/2026-07-03",
    },
    timeoutMs: 3000,
    async run(args) {
      const city = assertString(args, "city", "目的地");
      const date = assertString(args, "date", "出行当天");
      return {
        city,
        date,
        weather: "多云，局部有阵雨",
        temperature: "25-32℃",
        tips: ["建议带伞", "户外路线预留室内备选点"],
        mock: true,
      };
    },
  },
  {
    name: "search_poi",
    description: "查询城市推荐景点。当前为教学用静态 POI 工具，真实项目可接地图或文旅 POI 服务。",
    parameters: {
      city: "string，城市名",
      keyword: "string，可选，兴趣关键词",
      limit: "number，可选，返回条数",
    },
    timeoutMs: 3000,
    async run(args) {
      const city = assertString(args, "city", "杭州");
      const keyword = assertString(args, "keyword");
      const limit = normalizeLimit(args.limit, 5);
      const list = cityPois[city] || cityPois.杭州;
      const filtered = keyword
        ? list.filter((poi) => `${poi.name}${poi.tags.join("")}`.includes(keyword))
        : list;

      return {
        city,
        keyword,
        pois: filtered.slice(0, limit),
        mock: true,
      };
    },
  },
  {
    name: "plan_route",
    description: "根据景点列表生成简单路线顺序。当前为教学用规则工具，真实项目可接地图路线规划 API。",
    parameters: {
      city: "string，城市名",
      spots: "array，景点名称数组",
      hours: "number，可选，可用游玩时长",
    },
    timeoutMs: 3000,
    async run(args) {
      const city = assertString(args, "city", "目的地");
      const spots = Array.isArray(args?.spots) ? args.spots.filter(Boolean) : [];
      const hours = Number(args?.hours || 4);
      const route = spots.length ? spots : (cityPois[city] || cityPois.杭州).map((poi) => poi.name);

      return {
        city,
        hours: Number.isFinite(hours) ? hours : 4,
        route,
        transport: "同城短途优先地铁/步行，跨区用打车衔接",
        note: "这是教学用路线规划，真实项目可替换为地图 API 返回的距离和耗时。",
        mock: true,
      };
    },
  },
];

const toolsByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));

export function listAgentTools() {
  return toolDefinitions.map(({ run, ...tool }) => tool);
}

export async function executeAgentTool(toolCall) {
  const tool = toolsByName.get(toolCall.name);
  if (!tool) {
    throw new Error(`不支持的工具：${toolCall.name}`);
  }

  const args = toolCall.arguments || {};
  const data = await withTimeout(tool.run(args), tool.timeoutMs, tool.name);

  return {
    name: tool.name,
    arguments: args,
    success: true,
    data,
  };
}
