/**
 * 运行时端点联调（MIGRATION.md「冒烟验证清单」最后一项）。
 * 覆盖：鉴权 / 知识库 / 文档摄取 / 混合检索 / RAG-Agent 流式(SSE) / 会话记忆 / 审计。
 *
 * 前提：先启动服务（另开终端）npm run dev，默认 http://127.0.0.1:8000。
 * 用法：
 *   npm run smoke:runtime
 *   SMOKE_BASE_URL=http://127.0.0.1:8000 SMOKE_RETRIEVAL_KB_ID=<有数据的知识库> npm run smoke:runtime
 * 输出：eval/runtime-smoke.json
 *
 * 注意：本脚本主要用 fetch 打真实 HTTP；仅在启动时经 scripts/seedAdmin.ts 受信任通道
 * 预置管理员（确保运营台步骤可用），因此会连一次数据库。沙箱出网代理不影响 127.0.0.1（undici 不读 HTTP_PROXY）。
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureAdmin } from './seedAdmin';

const BASE = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
const ACCOUNT = process.env.SMOKE_ADMIN_ACCOUNT ?? 'smoke_admin';
const PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? 'Smoke@12345';
// 检索需要"已有切片"的知识库；默认用评测集自带地市库（含 103 切片），可用环境变量覆盖。
const RETRIEVAL_KB_ID = process.env.SMOKE_RETRIEVAL_KB_ID ?? '26929070-a2a2-43ec-818a-ff1f6d53a996';

interface StepResult {
  name: string;
  method: string;
  path: string;
  status: number | null;
  ok: boolean;
  /** 非关键步骤（如"账号已存在"的注册）失败不计入总体通过率。 */
  optional?: boolean;
  note: string;
  snippet: string;
}

const results: StepResult[] = [];

function clip(value: string, max = 400): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 脱敏：登录响应里的 JWT 不应落盘（runtime-smoke.json 会随产物提交）。
 * 先整段抹掉 token 字段，再兜底抹掉形似 JWT 的三段式串。
 */
function redact(value: string): string {
  return value
    .replace(/"token"\s*:\s*"[^"]*"/g, '"token":"<redacted>"')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<jwt-redacted>');
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

async function call(options: {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  token?: string | null;
  clientId?: string | null;
  expect?: number[];
  timeoutMs?: number;
  optional?: boolean;
}): Promise<{ status: number; text: string; data: unknown }> {
  const expect = options.expect ?? [200];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 90_000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.clientId) headers['X-Client-Id'] = options.clientId;
    const response = await fetch(`${BASE}${options.path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* 非 JSON（SSE 等） */
    }
    const envelope = asObject(parsed);
    const data = envelope && 'data' in envelope ? envelope.data : parsed;
    const ok = expect.includes(response.status) && (envelope ? envelope.success !== false : true);
    results.push({
      name: options.name,
      method: options.method,
      path: options.path,
      status: response.status,
      ok,
      optional: options.optional,
      note: ok ? 'ok' : `期望状态 ${expect.join('/')}`,
      snippet: clip(redact(text)),
    });
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${options.name} ${options.method} ${options.path} -> ${response.status}`);
    return { status: response.status, text, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({
      name: options.name,
      method: options.method,
      path: options.path,
      status: null,
      ok: false,
      note: message,
      snippet: '',
    });
    console.log(`[smoke] FAIL ${options.name} ${options.method} ${options.path} -> ${message}`);
    return { status: 0, text: '', data: null };
  } finally {
    clearTimeout(timer);
  }
}

/** 读一段 SSE 流，直到收集到足够事件或超时。 */
async function sseProbe(options: {
  name: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  maxMs?: number;
  minEvents?: number;
}): Promise<{ eventCount: number; buffer: string }> {
  const maxMs = options.maxMs ?? 60_000;
  const minEvents = options.minEvents ?? 3;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), maxMs);
  const started = Date.now();
  let buffer = '';
  try {
    const response = await fetch(`${BASE}${options.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });
    if (!response.body) {
      results.push({
        name: options.name,
        method: 'POST',
        path: options.path,
        status: response.status,
        ok: false,
        note: '响应无 body（非流式）',
        snippet: '',
      });
      return { eventCount: 0, buffer: '' };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (Date.now() - started < maxMs) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = (buffer.match(/\n\n/g) ?? []).length;
      if (events >= minEvents) break;
    }
    const eventCount = (buffer.match(/\n\n/g) ?? []).length;
    const ok = response.status === 200 && eventCount > 0;
    results.push({
      name: options.name,
      method: 'POST(SSE)',
      path: options.path,
      status: response.status,
      ok,
      note: ok ? `收到 ${eventCount} 个 SSE 事件` : '未收到 SSE 事件',
      snippet: clip(redact(buffer), 600),
    });
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} ${options.name} -> ${response.status}, events=${eventCount}`);
    return { eventCount, buffer };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({
      name: options.name,
      method: 'POST(SSE)',
      path: options.path,
      status: null,
      ok: false,
      note: message,
      snippet: clip(redact(buffer), 600),
    });
    console.log(`[smoke] FAIL ${options.name} -> ${message}`);
    return { eventCount: 0, buffer };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  console.log(`[smoke] base=${BASE} account=${ACCOUNT}`);

  // 1) 心跳（无需鉴权）
  await call({ name: 'heartbeat', method: 'GET', path: '/api/heartbeat' });

  // 2) 受信任预置管理员：公开注册接口已不再接受客户端 role（#3-A），
  //    管理员只能经 seedAdmin 的服务端通道创建。smoke 直接调用 ensureAdmin 保证管理员就绪。
  try {
    const seeded = await ensureAdmin(ACCOUNT, PASSWORD);
    console.log(`[smoke] ensureAdmin(${ACCOUNT}) -> ${seeded}`);
  } catch (error) {
    console.log(`[smoke] ensureAdmin 失败（将影响后续需鉴权步骤）：${String((error as Error)?.message ?? error)}`);
  }

  // 2b) 回归验证 #3-A：公开注册忽略客户端 role——注册一个无 role 的探测账号，其角色应为 user（非 admin）
  const probeAccount = `smoke_probe_${Date.now()}`;
  await call({
    name: 'auth.register(no-role)',
    method: 'POST',
    path: '/api/auth/register',
    body: { account: probeAccount, password: PASSWORD },
    expect: [200, 201],
    optional: true,
  });
  const probeLogin = await call({
    name: 'auth.login(probe)',
    method: 'POST',
    path: '/api/auth/login',
    body: { account: probeAccount, password: PASSWORD },
    optional: true,
  });
  const probeData = asObject(probeLogin.data);
  const probeToken = typeof probeData?.['token'] === 'string' ? String(probeData['token']) : '';
  let probeRole = '';
  if (probeToken) {
    const probeMe = await call({ name: 'auth.me(probe)', method: 'GET', path: '/api/auth/me', token: probeToken, optional: true });
    const probeMeData = asObject(probeMe.data);
    probeRole = typeof probeMeData?.['role'] === 'string' ? String(probeMeData['role']) : '';
  }
  const probeResult = results[results.length - 1];
  if (probeResult) {
    probeResult.note =
      probeRole === 'user'
        ? '公开注册忽略 role，角色=user（#3-A 验证通过）'
        : `探测账号角色=${probeRole || '未知'}（异常：应=user）`;
  }

  // 3) 登录取 JWT
  const login = await call({
    name: 'auth.login',
    method: 'POST',
    path: '/api/auth/login',
    body: { account: ACCOUNT, password: PASSWORD },
  });
  const loginData = asObject(login.data);
  const token = typeof loginData?.['token'] === 'string' ? String(loginData['token']) : '';
  if (!token) {
    console.log('[smoke] 登录未取得 token，后续需鉴权步骤会失败');
  }

  // 4) 当前用户（断言为管理员，验证 ensureAdmin 预置生效）
  const me = await call({ name: 'auth.me', method: 'GET', path: '/api/auth/me', token });
  const meData = asObject(me.data);
  const meRole = typeof meData?.['role'] === 'string' ? String(meData['role']) : '';
  if (meRole !== 'admin') {
    // 注：call() 的返回值不含 note，报告行在 results 数组里（与上方 probeResult 同理）。
    // 反向找到最近的 auth.me 步骤结果再写 note，避免误改同名探针步骤。
    let meStep: StepResult | undefined;
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i].name === 'auth.me') {
        meStep = results[i];
        break;
      }
    }
    if (meStep) meStep.note = `当前用户角色=${meRole || '未知'}（期望 admin，ensureAdmin 可能未生效）`;
  }

  // 5) 知识库列表
  const kbList = await call({ name: 'kb.list', method: 'GET', path: '/api/admin/knowledge-bases', token });
  const kbRows = Array.isArray(kbList.data) ? (kbList.data as unknown[]) : [];

  // 6) 新建知识库
  const kbCreate = await call({
    name: 'kb.create',
    method: 'POST',
    path: '/api/admin/knowledge-bases',
    body: { name: `smoke-kb-${Date.now()}`, description: 'runtime smoke' },
    token,
    expect: [200, 201],
  });
  const kbData = asObject(kbCreate.data);
  const kbId = typeof kbData?.['id'] === 'string' ? String(kbData['id']) : '';

  // 7) 文档摄取（base64 内容）
  const markdown = [
    '# 冒烟测试文档',
    '',
    '本文档由 scripts/smokeRuntime.ts 自动生成，用于验证摄取链路。',
    '杭州西湖一日游建议：清晨断桥残雪，上午乘船游湖，中午楼外楼用餐，下午苏堤春晓。',
  ].join('\n');
  const upload = await call({
    name: 'ingest.upload',
    method: 'POST',
    path: '/api/admin/documents',
    body: {
      knowledgeBaseId: kbId || RETRIEVAL_KB_ID,
      fileName: `smoke-${Date.now()}.md`,
      contentType: 'text/markdown',
      content: Buffer.from(markdown, 'utf8').toString('base64'),
      title: '运行时冒烟文档',
    },
    token,
    expect: [200, 201],
  });
  const uploadData = asObject(upload.data);
  const docId = typeof uploadData?.['id'] === 'string' ? String(uploadData['id']) : '';

  // 8) 文档列表
  await call({
    name: 'ingest.list',
    method: 'GET',
    path: `/api/admin/documents?knowledgeBaseId=${encodeURIComponent(kbId || RETRIEVAL_KB_ID)}`,
    token,
  });

  // 9) 切片：摄取是异步的（上传 → 队列 → worker 解析+向量化），需轮询等待完成
  if (docId) {
    let chunkRows: unknown[] = [];
    let attempts = 0;
    for (attempts = 1; attempts <= 10; attempts++) {
      const chunks = await call({
        name: 'ingest.chunks',
        method: 'GET',
        path: `/api/admin/documents/${docId}/chunks`,
        token,
      });
      chunkRows = Array.isArray(chunks.data) ? (chunks.data as unknown[]) : [];
      if (chunkRows.length > 0) break;
      // 未出切片时先等 worker，最后一次不再 sleep
      if (attempts < 10) await new Promise((resolveTimer) => setTimeout(resolveTimer, 5_000));
    }
    const last = results[results.length - 1]!;
    last.note =
      chunkRows.length > 0
        ? `切片=${chunkRows.length}（轮询 ${attempts} 次后就绪，摄取全链路通过）`
        : `切片=${chunkRows.length}（轮询 ${attempts} 次仍未就绪：worker 未运行或摄取失败，见 worker 日志）`;
    last.ok = chunkRows.length > 0;
  }

  // 10) 混合检索：ab / elasticsearch / pg_trgm 三路
  const query = '杭州西湖一日游怎么安排比较好';
  for (const variant of ['ab', 'elasticsearch', 'pg_trgm'] as const) {
    const retrieval = await call({
      name: `hybrid.${variant}`,
      method: 'POST',
      path: '/api/admin/retrieval-debug',
      body: { knowledgeBaseId: RETRIEVAL_KB_ID, query, limit: 5, sparseVariant: variant },
      token,
      timeoutMs: 120_000,
    });
    const payload = asObject(retrieval.data);
    const hits = Array.isArray(payload?.['hits']) ? (payload['hits'] as unknown[]) : [];
    const first = asObject(hits[0]);
    results[results.length - 1]!.note = `hits=${hits.length} backend=${String(first?.['sparseBackend'] ?? '-')}`;
  }

  // 11) SSE 流式：RAG Agent（用 X-Client-Id 走 public 主体）
  await sseProbe({
    name: 'sse.rag.chat',
    path: '/api/rag/chat',
    body: { message: '帮我简单介绍一下杭州西湖' },
    headers: { 'X-Client-Id': crypto.randomUUID() },
    maxMs: 90_000,
    minEvents: 3,
  });

  // 12) 会话记忆
  await call({ name: 'memory.list', method: 'GET', path: '/api/memories', token });
  await call({ name: 'memory.summary', method: 'GET', path: '/api/memories/summary', token });

  // 13) 审计日志
  const audit = await call({
    name: 'audit.list',
    method: 'GET',
    path: '/api/admin/audit-logs?limit=5',
    token,
  });
  const auditRows = Array.isArray(audit.data) ? (audit.data as unknown[]) : [];
  results[results.length - 1]!.note = `audit=${auditRows.length} 条`;

  const critical = results.filter((item) => !item.optional);
  const passed = critical.filter((item) => item.ok).length;
  const output = {
    base: BASE,
    account: ACCOUNT,
    role: String(meData?.['role'] ?? '-'),
    knowledgeBaseCount: kbRows.length,
    retrievalKnowledgeBaseId: RETRIEVAL_KB_ID,
    passed,
    criticalTotal: critical.length,
    total: results.length,
    results,
  };
  const outPath = resolve(process.cwd(), 'eval/runtime-smoke.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`[smoke] 完成 ${passed}/${critical.length}（关键步骤），结果已写入 ${outPath}`);
  for (const item of results) {
    console.log(`  ${item.ok ? '[ok]  ' : '[FAIL]'} ${item.name} ${item.method} ${item.path} -> ${item.status ?? '-'} ${item.note}`);
  }
  if (passed < critical.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('[smoke] 异常终止：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
