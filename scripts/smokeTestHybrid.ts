/**
 * 混合检索端到端冒烟测试（可复用）。
 *
 * 固定 5 条代表查询：3 条长自然语言语义查询 + 2 条短关键词查询，
 * 对比两种模式以验证「dense + sparse(elasticsearch) + RRF + rerank」全链路：
 *   - baseline（纯稠密）：关掉 hybrid 与 rerank，得到 Milvus 余弦排序的原始 Top-K；
 *   - hybrid（混合）：dense + sparse + RRF 融合 + cross-encoder 精排。
 *
 * 关注点：
 *   1. dense 路径（Milvus）是否正常返回；
 *   2. sparse 路径后端是否为 elasticsearch（IK 分词链路）；
 *   3. rerank 是否真实生效（出现 rerankScore，而非回退到融合顺序）；
 *   4. 短关键词查询下，sparse 是否贡献了 dense 召回不到的新文档（补位召回）。
 *
 * 用法（需 Milvus / Elasticsearch 已就绪且已 reindex）：
 *   npm run smoke:hybrid
 *
 * 退出码：存在检索异常 => 1；否则 0（⚠ 非阻断提示仍会打印）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '@/lib/config';
import { ragService, type RetrievalSource } from '@/lib/services/rag';

interface QuerySpec {
  label: string;
  type: 'semantic' | 'keyword';
  query: string;
}

// 5 条固定代表查询：覆盖长自然语言（语义检索）与短关键词（精确召回）两类典型场景。
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

const TOP_DENSE = 3; // baseline 展示条数
const TOP_HYBRID = 5; // hybrid 展示条数
const DENSE_CANDIDATE_K = 20; // baseline 取密集召回 Top-20 作为「dense 能触及的集合」，用于判定 sparse 补位

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

function num(value?: number | null): string {
  return typeof value === 'number' ? value.toFixed(4) : '—';
}

function snippet(text: string, max = 38): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function run(): Promise<void> {
  const initial: Record<RagFlag, boolean> = {
    ragHybridEnabled: config.ragHybridEnabled,
    ragRerankEnabled: config.ragRerankEnabled,
  };

  const checks: string[] = [];
  let hardFail = false;

  console.log('\n=== 混合检索端到端冒烟测试 ===');
  console.log(
    `embedding=${config.embeddingModel ?? '(未配置)'} dim=${config.embeddingDimension} rerank=${config.rerankModel}`,
  );
  console.log(
    `denseTopK=${config.ragDenseTopK} sparseTopK=${config.ragSparseTopK} rrfK=${config.ragRrfK} ` +
      `matchCount=${config.ragMatchCount} threshold=${config.ragSimilarityThreshold} minSparse=${config.ragSparseMinScore}`,
  );
  console.log(`sparseBackend配置=${config.ragSparseBackend}\n`);

  for (const spec of REPRESENTATIVE_QUERIES) {
    // ---- baseline：纯稠密向量（关闭 hybrid 与 rerank） ----
    setRagFlags(false);
    let baseline: RetrievalSource[] = [];
    try {
      baseline = await ragService.retrieve(spec.query, { limit: DENSE_CANDIDATE_K });
    } catch (e) {
      console.log(`  [ERROR] baseline 检索异常: ${(e as Error).message}`);
      hardFail = true;
    }
    const baselineIds = new Set(baseline.map((b) => b.chunkId));

    // ---- hybrid：混合（开启 hybrid 与 rerank） ----
    setRagFlags(true);
    let hybrid: RetrievalSource[] = [];
    try {
      hybrid = await ragService.retrieve(spec.query, { limit: TOP_HYBRID });
    } catch (e) {
      console.log(`  [ERROR] hybrid 检索异常: ${(e as Error).message}`);
      hardFail = true;
    }
    const hybridTop = hybrid.slice(0, TOP_HYBRID);
    const backend = hybridTop[0]?.sparseBackend ?? 'disabled';
    const rerankActive = hybridTop.some((h) => typeof h.rerankScore === 'number');
    const sparseOnly = hybridTop.filter((h) => !baselineIds.has(h.chunkId));

    // ---- 输出 ----
    console.log(`---------- ${spec.label} [${spec.type}] ----------`);
    console.log(`查询: ${spec.query}`);
    console.log(`--- 纯稠密 baseline (Top${TOP_DENSE}，无 rerank) ---`);
    if (baseline.length) {
      baseline.slice(0, TOP_DENSE).forEach((b, i) => {
        console.log(`  #${i + 1} dense=${num(b.denseScore)} | ${snippet(b.title || b.content)}`);
      });
    } else {
      console.log('  (无结果：向量召回可能全部低于阈值)');
    }
    console.log(`--- 混合 hybrid (Top${TOP_HYBRID}, RRF+rerank) ---`);
    if (hybridTop.length) {
      hybridTop.forEach((h, i) => {
        const tag = baselineIds.has(h.chunkId) ? 'D' : 'S'; // D=稠密已命中 S=纯稀疏补位
        console.log(
          `  #${i + 1} [${tag}|${h.sparseBackend ?? '-'}] rerank=${num(h.rerankScore)} dense=${num(h.denseScore)} | ${snippet(h.title || h.content)}`,
        );
      });
    } else {
      console.log('  (无结果)');
    }

    // ---- 检查项 ----
    if (hybridTop.length === 0) {
      checks.push(`✗ ${spec.label}: hybrid 无结果`);
    }
    if (spec.type === 'keyword' && sparseOnly.length === 0) {
      checks.push(`⚠ ${spec.label}: 短关键词查询未体现 sparse 补位（sparse 未贡献新文档）`);
    }
    if (backend !== 'elasticsearch') {
      checks.push(`⚠ ${spec.label}: sparseBackend=${backend}（预期 elasticsearch）`);
    }
    if (!rerankActive) {
      checks.push(`⚠ ${spec.label}: rerank 未生效（无 rerankScore，可能触发回退）`);
    }
    console.log(
      `  指标: sparse补位=${sparseOnly.length} rerank生效=${rerankActive} backend=${backend}\n`,
    );
  }

  // 还原配置（进程即退出，主要是保持整洁）
  restoreRagFlags(initial);

  // ---- 汇总 ----
  console.log('========== 冒烟结论 ==========');
  if (checks.length === 0) {
    console.log(
      '✓ 全部检查通过：dense / sparse(elasticsearch) / RRF / rerank 全链路正常，且 sparse 在短查询上贡献了补位召回。',
    );
  } else {
    checks.forEach((c) => console.log(c));
  }
  if (hardFail) {
    console.log('\n结果: FAIL（存在检索异常，见上方 [ERROR]）');
    process.exit(1);
  }
  console.log('\n结果: PASS（⚠ 为软提示，不影响退出码）');
}

// 仅当本文件被直接执行（而非被其它模块 import）时才跑检索，避免作为模块引入时
// 长驻进程被全局改写 config，或误触发远程 embedding/rerank 调用。
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  run().catch((e) => {
    console.error('致命错误:', e);
    process.exit(1);
  });
}
