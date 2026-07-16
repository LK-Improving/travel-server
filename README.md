# travel-server

智能景点介绍服务端，基于 Express、LangChain 和 OpenAI 兼容接口，为前端提供旅游规划推荐和 AI 流式对话能力。

## 功能

- 旅游规划推荐：根据城市、预算、天数生成结构化 JSON 行程。
- AI 对话：通过 SSE 返回流式聊天内容，适合前端逐字/分段渲染。
- RAG 对话：新增独立路由，将资料写入 Supabase pgvector 后检索增强回答。
- 多模型供应商：支持 DeepSeek、硅基流动、小米大模型等 OpenAI 兼容服务。
- 跨域支持：已启用 `cors()`，方便本地前后端联调。

## 技术栈

- Node.js + Express
- LangChain `@langchain/openai`
- Supabase PostgreSQL + pgvector
- Supabase JS SDK
- Server-Sent Events（SSE）
- dotenv

## 目录结构

```txt
src/
  index.js                  # Express 入口
  routers/
    travel.js               # 旅游推荐与聊天路由
    travelRag.js            # RAG 文档入库、检索与聊天路由
  services/
    travelServer.js         # 大模型初始化与业务调用
    ragServer.js            # RAG 切片、embedding、检索增强生成
    supabaseClient.js       # Supabase JS SDK 客户端
    supabaseRagStore.js     # Supabase pgvector 存储
  utils/
    streamUtils.js          # SSE 响应工具
```

## 安装

```bash
npm install
```

## 环境变量

在项目根目录创建 `.env` 文件：

```env
# 服务配置
PORT=3000

# 可选值：DEEPSEEK / GJLD / XIAOMI
MODEL_PROVIDE=DEEPSEEK

# 模型生成配置
MODEL_MAX_TOKENS=1600
LLM_TIMEOUT_MS=120000
LLM_MAX_RETRIES=1

# DeepSeek
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
DEEPSEEK_MODEL=deepseek-v4-flash

# 硅基流动
GJLD_API_KEY=your_siliconflow_api_key
GJLD_BASE_URL=https://api.siliconflow.cn/v1
GJLD_MODEL=deepseek-ai/DeepSeek-V4-Flash

# 小米
XIAOMI_API_KEY=your_xiaomi_api_key
XIAOMI_BASE_URL=https://api.xiaomimimo.com/v1
XIAOMI_MODEL=mimo-v2-flash

# Supabase / RAG
SUPABASE_PROJECT_REF=your_project_ref
SUPABASE_URL=https://your_project_ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
SUPABASE_DB_HOST=db.your_project_ref.supabase.co
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres
SUPABASE_DB_PASSWORD=your_database_password
SUPABASE_DB_SSL=true

# 如本机或部署环境不支持 IPv6，建议使用 Supabase Dashboard 提供的 pooler 连接串
# SUPABASE_DB_URL=postgresql://postgres.project-ref:password@aws-1-region.pooler.supabase.com:6543/postgres

# Embedding 使用 OpenAI-compatible 接口
EMBEDDING_API_KEY=your_embedding_api_key
EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_BATCH_SIZE=16
EMBEDDING_TIMEOUT_MS=60000

RAG_CHUNK_SIZE=800
RAG_CHUNK_OVERLAP=120
RAG_MATCH_COUNT=5
```

注意：不要把真实 API Key 提交到代码仓库。

## 启动

开发模式：

```bash
npm run dev
```

生产/普通启动：

```bash
npm start
```

默认服务地址：

```txt
http://localhost:3000
```

## API

### 健康检查

```http
POST /api/heartbeat
```

示例响应：

```json
{
  "code": 200,
  "msg": "服务正常启动",
  "timestamp": 1782809715486
}
```

### 旅游规划推荐

```http
POST /api/travel/recommand
Content-Type: application/json
```

请求体：

```json
{
  "city": "杭州",
  "days": 3,
  "budget": 1000
}
```

成功响应：

```json
{
  "success": true,
  "content": {
    "success": true,
    "city": "杭州",
    "days": 3,
    "totalBudget": 1000,
    "dailyItinerary": [],
    "budgetBreakdown": {},
    "tips": [],
    "warnings": []
  },
  "usage": {}
}
```

说明：当前路由名为 `/recommand`，与代码保持一致。

### AI 流式对话

```http
POST /api/travel/chat
Content-Type: application/json
Accept: text/event-stream
```

请求体：

```json
{
  "message": "用一句话介绍杭州西湖"
}
```

响应头：

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
Transfer-Encoding: chunked
```

响应体示例：

```txt
: connected

data: {"type":"chunk","content":"杭州"}

data: {"type":"chunk","content":"西湖"}

data: {"type":"complete","data":{"success":true,"reply":"杭州西湖..."}}

event: end
data: {"type":"end"}
```

使用 `curl` 验证流式输出：

```bash
curl -N -i -X POST http://localhost:3000/api/travel/chat \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  --data "{\"message\":\"用一句话介绍杭州西湖\"}"
```

### RAG 文档入库

新增路由独立挂载在 `/api/travel-rag`，不会影响原有 `/api/travel/chat`。

### RAG 状态检查

```http
GET /api/travel-rag/status
```

该接口会检查 Supabase JS SDK 配置、RAG 表和 Postgres 初始化是否正常。

```http
POST /api/travel-rag/documents
Content-Type: application/json
```

请求体：

```json
{
  "title": "杭州西湖资料",
  "content": "西湖位于浙江省杭州市西湖区，是中国著名湖泊型景区……",
  "metadata": {
    "city": "杭州",
    "source": "manual"
  }
}
```

说明：服务会在第一次调用时自动创建 `vector`、`pgcrypto` 扩展和 `travel_rag_documents` 表，并把长文本按 `RAG_CHUNK_SIZE` 切片后写入 Supabase。

### RAG 检索

```http
POST /api/travel-rag/search
Content-Type: application/json
```

请求体：

```json
{
  "query": "西湖适合安排多久游览？",
  "matchCount": 5
}
```

如果没有命中满足阈值的资料，接口仍返回 200，`data` 为空数组，前端可按空状态展示，不需要进入错误态：

```json
{
  "success": true,
  "data": [],
  "fallback": false,
  "reason": "NO_MATCH",
  "message": "未检索到满足条件的知识库片段"
}
```

如果向量检索服务临时异常，接口也会尽量返回 200 和空数组，并带上 `fallback: true`，避免页面中断。

### RAG 流式对话

```http
POST /api/travel-rag/chat
Content-Type: application/json
Accept: text/event-stream
```

请求体：

```json
{
  "message": "根据资料帮我规划半天西湖游览路线",
  "matchCount": 5
}
```

响应体会先返回检索到的资料来源，再持续返回模型内容：

```txt
: connected

data: {"type":"sources","data":[],"retrieval":{"reason":"NO_MATCH"}}

data: {"type":"chunk","content":"可以"}

data: {"type":"complete","data":{"success":true,"reply":"可以...","sources":[]}}

event: end
data: {"type":"end"}
```

### Agent Function Calling 流式对话

新增 `/api/travel-agent` 用于学习 SSE + Function Calling 的组合方案，不影响原有 `/api/travel/chat` 和 `/api/travel-rag/chat`。

查看可用工具：

```http
GET /api/travel-agent/tools
```

流式对话：

```http
POST /api/travel-agent/chat
Content-Type: application/json
Accept: text/event-stream
```

请求体：

```json
{
  "message": "帮我规划明天杭州西湖半天路线，如果下雨给备选方案",
  "matchCount": 5,
  "city": "杭州"
}
```

SSE 事件统一带有 `type`、`requestId`、`messageId`、`seq` 和 `timestamp`，前端可以用 `seq` 去重和排查问题：

```txt
event: connected
data: {"type":"connected","requestId":"...","messageId":"...","seq":1,"data":{}}

event: plan_result
data: {"type":"plan_result","data":{"toolCalls":[]}}

event: tool_start
data: {"type":"tool_start","data":{"name":"search_knowledge_base"}}

event: tool_result
data: {"type":"tool_result","data":{"success":true}}

event: sources
data: {"type":"sources","data":{"sources":[]}}

event: chunk
data: {"type":"chunk","data":{"content":"可以"}}

event: complete
data: {"type":"complete","data":{"success":true}}
```

当前内置工具：

- `search_knowledge_base`：调用现有 Supabase pgvector RAG 检索。
- `get_weather`：教学用模拟天气工具，可替换成真实天气 API。
- `search_poi`：教学用静态 POI 工具，可替换成地图/文旅 POI 服务。
- `plan_route`：教学用规则路线工具，可替换成地图路线规划 API。

如果部署到 Nginx 或其他网关后变成一次性返回，需要关闭代理缓冲，例如：

```nginx
proxy_buffering off;
proxy_cache off;
```

## 常见问题

### 请求超时

旅游规划推荐会生成较长内容，模型可能响应较慢。可以尝试：

- 降低 `MODEL_MAX_TOKENS`
- 增大 `LLM_TIMEOUT_MS`
- 减少提示词要求的输出长度
- 使用 `/api/travel/chat` 流式接口改善前端等待体验

### 硅基流动返回 400

确认以下配置正确：

- `MODEL_PROVIDE=GJLD`
- `GJLD_BASE_URL=https://api.siliconflow.cn/v1`
- `GJLD_MODEL=deepseek-ai/DeepSeek-V4-Flash`

代码通过 LangChain 的 `ChatOpenAI` 并设置 `configuration.baseURL` 调用 OpenAI 兼容接口。

### SSE 前端一次性渲染

后端已经按 SSE 写入并在每次 `data: {...}\n\n` 后尝试 flush。如果本地 `curl -N` 能看到分段输出，但浏览器仍一次性渲染，优先检查：

- 前端是否使用 `fetch` + `response.body.getReader()`
- 是否调用了 `response.text()` 或 axios 普通请求
- 代理服务器是否开启了 response buffering

## 脚本

```bash
npm run dev      # nodemon 开发启动
npm start        # node 启动
npm test         # 当前未配置测试
```
