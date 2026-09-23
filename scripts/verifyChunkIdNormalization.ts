/**
 * #7 chunk_id 归一化一键校验：扫描 PG / Milvus / ES 三处 chunk_id，
 * 确认不存在「32 位无连字符 hex」孤儿（历史 buildChunkId 旧格式），
 * 且各存储的 chunk_id 表示与 PG（UUID 列，始终 hyphenated）完全一致。
 *
 * 背景：buildChunkId 现输出带连字符的 8-4-4-4-12 UUID；但 Milvus/ES 历史切片曾以
 * 32-hex 写入。由于 PG 的 chunk_id 是 UUID 列、Postgres 始终返回 hyphenated，不一致只
 * 存在于 ES/Milvus 两端。本脚本用于重灌（reindex:es / reindex:milvus）后确认已无残留。
 *
 * 用法：
 *   npm run verify:chunk-id
 *
 * 依赖：DB / Milvus / ES 齐备。任一未配置则跳过该项并记为跳过（不算失败）。
 * 退出码：发现 32-hex 孤儿、或数量与权威源对不上（超出 published 差异）则 1，否则 0。
 *
 * 数量预期：
 *   - PG：权威源，切片总数 = T，published = P。
 *   - ES：reindex:es 不过滤 published，故应 = T。
 *   - Milvus：reindex:milvus 默认仅 published（ONLY_PUBLISHED=true），故应 = P；
 *             若用 MILVUS_REINDEX_ONLY_PUBLISHED=false 全量回灌，则 = T。
 */
import { config } from '@/lib/config';
import { milvusRepository } from '@/lib/infra/milvus';
import { elasticsearchKeywordSearch } from '@/lib/infra/elasticsearch';
import { closePool, query } from '@/lib/db/pool';

// buildChunkId 输出：8-4-4-4-12，全小写 hex（sha256.slice(32)）。
const HYPHENATED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isHyphenated = (id: string): boolean => HYPHENATED.test(id);

interface Check {
  name: string;
  total: number;
  orphans: number;
  sampleOrphans: string[];
  ok: boolean;
  note: string;
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  let failed = false;

  // ---- PG：权威源 ----
  const totalRows = await query<{ count: string }>('SELECT count(*)::text AS count FROM travel_document_chunks');
  const publishedRows = await query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM travel_document_chunks c JOIN travel_documents d ON d.id=c.document_id
     WHERE d.status='published'`,
  );
  const orphanRows = await query<{ chunk_id: string }>(
    `SELECT chunk_id FROM travel_document_chunks
     WHERE chunk_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
  );
  const pgTotal = Number(totalRows[0]?.count ?? 0);
  const pgPublished = Number(publishedRows[0]?.count ?? 0);
  const pgOrphans = orphanRows.map((r) => String(r.chunk_id));
  checks.push({
    name: 'PG (权威源)',
    total: pgTotal,
    orphans: pgOrphans.length,
    sampleOrphans: pgOrphans.slice(0, 5),
    ok: pgOrphans.length === 0,
    note: `published=${pgPublished}`,
  });
  if (pgOrphans.length) failed = true;

  // ---- Milvus ----
  if (config.milvusHost) {
    if (await milvusRepository.hasCollection()) {
      try {
        const ids = await milvusRepository.scanChunkIds();
        const orphans = ids.filter((id) => !isHyphenated(id));
        // 数量应等于 published（默认）或 total（全量回灌），二者皆可。
        const countOk = ids.length === pgPublished || ids.length === pgTotal;
        const ok = orphans.length === 0 && countOk;
        if (orphans.length || !countOk) failed = true;
        checks.push({
          name: 'Milvus',
          total: ids.length,
          orphans: orphans.length,
          sampleOrphans: orphans.slice(0, 5),
          ok,
          note: `期望=${pgPublished} 或 ${pgTotal}（取决于是否含未发布）${countOk ? '' : ' ⚠ 数量不符'}`,
        });
      } catch (error) {
        failed = true;
        checks.push({
          name: 'Milvus',
          total: 0,
          orphans: 0,
          sampleOrphans: [],
          ok: false,
          note: `连接/查询失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } else {
      failed = true;
      checks.push({
        name: 'Milvus',
        total: 0,
        orphans: 0,
        sampleOrphans: [],
        ok: false,
        note: 'collection 不存在（尚未 reindex:milvus）',
      });
    }
  } else {
    checks.push({ name: 'Milvus', total: 0, orphans: 0, sampleOrphans: [], ok: true, note: '未配置，跳过' });
  }

  // ---- ES ----
  if (elasticsearchKeywordSearch.configured) {
    try {
      const ids = await elasticsearchKeywordSearch.listAllChunkIds();
      const orphans = ids.filter((id) => !isHyphenated(id));
      const countOk = ids.length === pgTotal;
      const ok = orphans.length === 0 && countOk;
      if (orphans.length || !countOk) failed = true;
      checks.push({
        name: 'ES',
        total: ids.length,
        orphans: orphans.length,
        sampleOrphans: orphans.slice(0, 5),
        ok,
        note: `期望=${pgTotal}（ES 含全部切片）${countOk ? '' : ' ⚠ 数量不符'}`,
      });
    } catch (error) {
      failed = true;
      checks.push({
        name: 'ES',
        total: 0,
        orphans: 0,
        sampleOrphans: [],
        ok: false,
        note: `连接/查询失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  } else {
    checks.push({ name: 'ES', total: 0, orphans: 0, sampleOrphans: [], ok: true, note: '未配置，跳过' });
  }

  // ---- 汇总 ----
  console.log('\n========== #7 chunk_id 归一化校验 ==========');
  console.log(`PG 切片总数=${pgTotal}，published=${pgPublished}`);
  console.log('-------------------------------------------');
  for (const c of checks) {
    const status = c.ok ? 'PASS' : c.note.includes('跳过') ? 'SKIP' : 'FAIL';
    console.log(`[${status}] ${c.name.padEnd(12)} total=${String(c.total).padEnd(6)} orphans=${c.orphans}  ${c.note}`);
    if (c.sampleOrphans.length) {
      console.log(`        孤儿样本: ${c.sampleOrphans.join(', ')}`);
    }
  }
  console.log('===========================================');
  if (failed) {
    console.log('结论：存在不一致或孤儿向量，需重跑 npm run reindex:es / reindex:milvus。');
  } else {
    console.log('结论：三处 chunk_id 表示一致，无 32-hex 孤儿。');
  }
  process.exitCode = failed ? 1 : 0;
}

main()
  .catch((error: unknown) => {
    console.error('校验失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
