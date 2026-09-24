/**
 * 混合检索端到端响应时间实测脚本（可复用）。
 *
 * 复用 smokeTestHybrid.ts 的「代表查询集 + A/B 开关就地改写」范式，但只做一件事：
 * 在指定检索模式下，对每条固定查询做多次 retrieve 并计时，汇总
 *   - 冷启动首响（cold，含 embedding 模型/JIT/连接首次开销）
 *   - 稳态平均 / P50(中位) / P95 / 最小 / 最大
 * 并对照预验收判据「端到端平均响应时间 ≤ 3s」给出 PASS / FAIL。
 *
 * 设计要点：
 *   - 每条查询先 1 次 cold（不计入均值，单独报），再 N 次 warm（计入统计），降低抖动；
 *   - 计时用 performance.now()（高分辨率毫秒），环绕 await ragService.retrieve 前后取差值；
 *   - 单次 retrieve 异常不影响其它查询，仅标记该查询失败并在汇总时计入硬失败；
 *   - 支持 --mode hybrid|baseline、--repeats N、--limit N、--warmup N、--threshold MS 参数。
 *
 * 用法（需 Milvus / Elasticsearch 已就绪且已 reindex）：
 *   npm run measure:response-time                       # 默认 hybrid，每条 warmup1 + 重复5次，阈值 3000ms
 *   npm run measure:response-time -- --mode baseline     # 纯稠密对照
 *   npm run measure:response-time -- --repeats 8 --limit 10 --threshold 2000
 *
 * 退出码：存在检索异常或未达判据 => 1；否则 0。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { config } from '@/lib/config';
import { ragService, type RetrievalSource } from '@/lib/services/rag';

interface QuerySpec {
  label: string;
  type: 'semantic' | 'keyword';
  query: string;
}

// 固定代表查询集（与 smokeTestHybrid.ts 保持一致，覆盖长自然语言语义 + 短关键词两类场景）。
const REPRESENTATIVE_QUERIES: QuerySpec[] = [
  {
    label: 'Q1 杭州亲子轻松游',
    type: 'semantic',
    query:
      '我计划下个月带六十多岁的父母去杭州玩三天，他们腿脚不太方便不想爬太多山，希望行程轻松，顺便尝地道杭帮菜和龙井茶，请推荐合适景点和餐厅。',
  },
  {
    label: 'Q2 宁波老外滩天一阁',
    type: 'semantic',
    query:
      '宁波的老外滩和天一阁值得去吗？当地人早餐一般吃什么，有没有开几十年的老字号小吃店推荐？',
  },
  {
    label: 'Q3 绍兴水乡黄酒',
    type: 'semantic',
    query: '绍兴除了鲁迅故里还有什么小众有韵味的水乡景点，以及地道黄酒和茴香豆在哪吃？',
  },
  { label: 'Q4 西湖断桥', type: 'keyword', query: '西湖 断桥' },
  { label: 'Q5 杭州龙井茶', type: 'keyword', query: '杭州 龙井茶 哪里买正宗' },
];

type RagFlag = 'ragHybridEnabled' | 'ragRerankEnabled';

/** config 用 as const 声明（属性只读），但运行时是可变对象；retrieve 调用时才读这些开关，故就地改写做 A/B。 */
function setRagFlags(hybrid: boolean): void {
  const mutable = config as unknown as Record<RagFlag, boolean>;
  mutable.ragHybridEnabled = hybrid;
  mutable.ragRerankEnabled = hybrid;
}

function restoreRagFlags(initial: Record<RagFlag, boolean>): void {
  const mutable = config as unknown as Record<RagFlag, boolean>;
  mutable.ragHybridEnabled = initial.ragHybridEnabled;
  mutable.ragRerankEnabled = initial.ragRerankEnabled;
}

/** 百分位：p ∈ [0,1]，输入数组会被排序（升序）。 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[idx];
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function fmt(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return `${ms.toFixed(1)} ms`;
}

interface PerQueryResult {
  label: string;
  type: 'semantic' | 'keyword';
  cold: number | null; // 冷启动首响（null = 失败）
  warm: number[]; // 稳态多次计时
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  hits: number; // 末次 retrieve 命中数
  ok: boolean;
  error?: string;
}

interface CLIOpts {
  mode: 'hybrid' | 'baseline';
  repeats: number;
  warmup: number;
  limit: number;
  thresholdMs: number;
}

function parseArgs(argv: string[]): CLIOpts {
  const opts: CLIOpts = {
    mode: 'hybrid',
    repeats: 5,
    warmup: 1,
    limit: 5,
    thresholdMs: 3000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--mode':
        opts.mode = next() === 'baseline' ? 'baseline' : 'hybrid';
        break;
      case '--repeats':
        opts.repeats = Math.max(1, parseInt(next(), 10) || opts.repeats);
        break;
      case '--warmup':
        opts.warmup = Math.max(0, parseInt(next(), 10) || opts.warmup);
        break;
      case '--limit':
        opts.limit = Math.max(1, parseInt(next(), 10) || opts.limit);
        break;
      case '--threshold':
      case '--threshold-ms':
        opts.thresholdMs = Math.max(1, parseInt(next(), 10) || opts.thresholdMs);
        break;
      default:
        throw new Error(`未知参数: ${a}`);
    }
  }
  return opts;
}

async function measureOne(spec: QuerySpec, opts: CLIOpts): Promise<PerQueryResult> {
  const res: PerQueryResult = {
    label: spec.label,
    type: spec.type,
    cold: null,
    warm: [],
    avg: NaN,
    p50: NaN,
    p95: NaN,
    min: NaN,
    max: NaN,
    hits: 0,
    ok: false,
  };

  try {
    // 冷启动首响（warmup 次数内一并计算；warmup=0 时跳过 cold）
    for (let i = 0; i < opts.warmup; i++) {
      const t0 = performance.now();
      const hits = await ragService.retrieve(spec.query, { limit: opts.limit });
      const dt = performance.now() - t0;
      if (i === 0) res.cold = dt;
      res.hits = hits.length;
    }
    // 稳态重复
    for (let i = 0; i < opts.repeats; i++) {
      const t0 = performance.now();
      const hits: RetrievalSource[] = await ragService.retrieve(spec.query, { limit: opts.limit });
      const dt = performance.now() - t0;
      res.warm.push(dt);
      res.hits = hits.length;
    }
    const sorted = [...res.warm].sort((a, b) => a - b);
    res.avg = mean(res.warm);
    res.p50 = percentile(sorted, 0.5);
    res.p95 = percentile(sorted, 0.95);
    res.min = sorted[0];
    res.max = sorted[sorted.length - 1];
    res.ok = true;
  } catch (e) {
    res.error = (e as Error).message;
    res.ok = false;
  }
  return res;
}

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const hybrid = opts.mode === 'hybrid';
  const initial: Record<RagFlag, boolean> = {
    ragHybridEnabled: config.ragHybridEnabled,
    ragRerankEnabled: config.ragRerankEnabled,
  };
  setRagFlags(hybrid);

  console.log('\n=== 混合检索端到端响应时间实测 ===');
  console.log(
    `模式=${opts.mode} 阈值=${opts.thresholdMs}ms warmup=${opts.warmup} repeats=${opts.repeats} limit=${opts.limit}`,
  );
  console.log(
    `embedding=${config.embeddingModel ?? '(未配置)'} rerank=${config.rerankModel} sparseBackend=${config.ragSparseBackend}\n`,
  );

  const results: PerQueryResult[] = [];
  let hardFail = false;

  for (const spec of REPRESENTATIVE_QUERIES) {
    const r = await measureOne(spec, opts);
    results.push(r);
    if (!r.ok) hardFail = true;

    const coldStr = r.cold === null ? '—' : fmt(r.cold);
    const warmStr = r.ok
      ? `avg=${fmt(r.avg)} p50=${fmt(r.p50)} p95=${fmt(r.p95)} min=${fmt(r.min)} max=${fmt(r.max)}`
      : `ERROR: ${r.error}`;
    console.log(`---------- ${r.label} [${r.type}] ----------`);
    console.log(`查询: ${spec.query}`);
    console.log(`  冷启动=${coldStr}  稳态(${opts.repeats}次)=${warmStr}`);
    console.log(`  末次命中=${r.hits} 条\n`);
  }

  restoreRagFlags(initial);

  // ---- 全局汇总 ----
  const okWarm = results.filter((r) => r.ok).flatMap((r) => r.warm);
  const globalAvg = mean(okWarm);
  const sortedAll = [...okWarm].sort((a, b) => a - b);
  const globalP50 = percentile(sortedAll, 0.5);
  const globalP95 = percentile(sortedAll, 0.95);
  const globalMin = sortedAll[0] ?? NaN;
  const globalMax = sortedAll[sortedAll.length - 1] ?? NaN;
  // 各查询平均的均值（避免某条查询多次重复压低整体均值）
  const perQueryAvg = results.filter((r) => r.ok).map((r) => r.avg);
  const meanOfAvg = mean(perQueryAvg);

  const th = opts.thresholdMs;
  const avgPass = Number.isFinite(globalAvg) && globalAvg <= th;
  const p95Pass = Number.isFinite(globalP95) && globalP95 <= th;
  const allPass = avgPass && p95Pass && !hardFail;

  console.log('========== 响应时间汇总 ==========');
  console.log(`判定阈值: 端到端平均响应时间 ≤ ${th}ms (${th / 1000}s)`);
  console.log(`全局 平均=${fmt(globalAvg)} P50=${fmt(globalP50)} P95=${fmt(globalP95)} 最小=${fmt(globalMin)} 最大=${fmt(globalMax)}`);
  console.log(`各查询平均之均值(meanOfAvg)=${fmt(meanOfAvg)}  （${perQueryAvg.length} 条有效查询）`);
  console.log(`判定: 平均≤阈值=${avgPass ? '✓' : '✗'}  P95≤阈值=${p95Pass ? '✓' : '✗'}  无异常=${!hardFail ? '✓' : '✗'}`);
  if (allPass) {
    console.log('\n结果: PASS（端到端平均响应时间满足预验收判据）');
  } else {
    console.log('\n结果: FAIL（未达判据或存在检索异常）');
    process.exit(1);
  }
}

// 仅当本文件被直接执行（而非被其它模块 import）时才跑检索，避免作为模块引入时
// 长驻进程被全局改写 config，或误触发远程 embedding/rerank 调用与计时开销。
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  run().catch((e) => {
    console.error('致命错误:', e);
    process.exit(1);
  });
}

export { run as measureResponseTimeMain, measureOne, percentile, mean };
