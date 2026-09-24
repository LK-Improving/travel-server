#!/usr/bin/env bash
#
# #7 chunk_id 归一化重灌 · 一键执行脚本
#
# 流程（每步带 verify 门禁）：
#   步骤0  重灌前校验（预期 PG PASS，Milvus/ES 可能 FAIL —— 仅 PG 失败才致命）
#   步骤1  reindex:es        （先 deleteIndex 再全量重建，清除 32-hex 孤儿）
#   步骤2  ES 门禁           （只判定 ES 是否 PASS，Milvus 未重灌时 FAIL 容忍）
#   步骤3  reindex:milvus    （先 dropCollection 再重建 —— 关键修复，避免孤儿向量）
#   步骤4  全部门禁          （PG / ES / Milvus 必须全部 PASS）
#
# 用法：
#   bash scripts/run-chunk-id-reindex.sh                # 交互确认 + 仅 published（线上口径）
#   bash scripts/run-chunk-id-reindex.sh --yes          # 跳过确认
#   bash scripts/run-chunk-id-reindex.sh --yes --all    # 全量回灌（含未发布切片）
#   bash scripts/run-chunk-id-reindex.sh --yes --smoke  # 收尾跑 eval:keyword + smoke:hybrid
#
# 注意：reindex 会 DROP Milvus collection 并 DELETE ES 索引，建议在低流量期执行。
#       重灌不改动任何源码，PG 是 UUID 列（始终 hyphenated），为唯一权威源，无数据丢失风险。
#
set -euo pipefail

YES=0
ALL=0
SMOKE=0
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    --all)    ALL=1 ;;
    --smoke)  SMOKE=1 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

# 定位到仓库根（脚本位于 scripts/ 下）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
echo "==> 工作目录: $(pwd)"

# 前置：工作树检查（仅警告，不阻断 —— 重灌不碰源码）
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "⚠️  工作树存在未提交改动（git status --porcelain 非空）。重灌不改动源码，但建议先提交/暂存。"
fi

# 依赖检查：tsx 必须存在（npm run 脚本依赖它）
if [[ ! -x node_modules/.bin/tsx ]]; then
  echo "⚠️  未找到 node_modules/.bin/tsx，先 npm install ..."
  npm install
fi

# 危险操作确认（非交互环境且未传 --yes 时出于安全中止）
if [[ $YES -eq 0 ]]; then
  if [[ -t 0 ]]; then
    read -r -p "即将 DROP Milvus collection 并 DELETE ES 索引（建议低流量期执行）。确认继续？[y/N] " ans
    case "$ans" in
      y|Y|yes|YES) ;;
      *) echo "已取消。"; exit 1 ;;
    esac
  else
    echo "非交互环境且未传 --yes，出于安全中止。若确认执行，请加 --yes。" >&2
    exit 1
  fi
fi

VERIFY_OUT="$(mktemp)"
cleanup() { rm -f "$VERIFY_OUT"; }
trap cleanup EXIT

# 运行 verify:chunk-id，输出到终端并缓存到 $VERIFY_OUT
run_verify() {
  set +e
  npm run verify:chunk-id > "$VERIFY_OUT" 2>&1
  set -e
  cat "$VERIFY_OUT"
}

# 判定某后端在该次 verify 输出中是否通过：
#   - 该行不存在（verify 脚本异常/崩溃）-> 视为不通过
#   - 该行为 [FAIL] -> 不通过
#   - [PASS] / [SKIP] -> 通过
backend_ok() {
  local label="$1"
  if ! grep -Eq "^\\[(PASS|FAIL|SKIP)\\] ${label}" "$VERIFY_OUT"; then
    echo "  (警告: 未找到 [${label}] 的校验行，可能 verify 脚本异常，视为不通过)" >&2
    return 1
  fi
  if grep -Eq "^\\[(FAIL)\\] ${label}" "$VERIFY_OUT"; then
    return 1
  fi
  return 0
}

echo
echo "########## 步骤 0：重灌前校验（预期 PG PASS，Milvus/ES 可能 FAIL）##########"
run_verify
if ! backend_ok "PG"; then
  echo "❌ PG 校验 FAIL 或 verify 异常：源数据 travel_document_chunks 存在非 hyphenated chunk_id，" >&2
  echo "   需先排查源数据 / DATABASE_URL 后再重灌，终止。" >&2
  exit 1
fi
echo "✅ PG 权威源一致，继续。"

echo
echo "########## 步骤 1：重灌 Elasticsearch（全量，先 deleteIndex 再重建）##########"
npm run reindex:es

echo
echo "########## 步骤 2：ES 门禁校验（仅判定 ES；Milvus 未重灌时 FAIL 容忍）##########"
run_verify
if ! backend_ok "ES"; then
  echo "❌ ES 重灌后仍 FAIL（见上方 orphan/数量），请检查 ELASTICSEARCH_* 与索引名后重跑 npm run reindex:es。" >&2
  exit 1
fi
echo "✅ ES 已归一化（orphans=0，total=T）。"

echo
echo "########## 步骤 3：重灌 Milvus（先 dropCollection 再重建 —— 关键修复）##########"
if [[ $ALL -eq 1 ]]; then
  echo "-> 全量回灌（含未发布）：MILVUS_REINDEX_ONLY_PUBLISHED=false"
  MILVUS_REINDEX_ONLY_PUBLISHED=false npm run reindex:milvus
else
  echo "-> 仅 published（默认，与线上检索口径一致）"
  npm run reindex:milvus
fi

echo
echo "########## 步骤 4：全部门禁校验（PG / ES / Milvus 必须全部 PASS）##########"
run_verify
ANY_FAIL=0
for b in "PG" "ES" "Milvus"; do
  if ! backend_ok "$b"; then
    echo "  ❌ [${b}] 未通过（见上方）"
    ANY_FAIL=1
  else
    echo "  ✅ [${b}] 通过"
  fi
done
if [[ $ANY_FAIL -eq 1 ]]; then
  echo "❌ 仍有后端 FAIL，请按 docs/chunk-id-reindex-runbook.md 故障排查后重跑对应 reindex。" >&2
  exit 1
fi

echo
echo "🎉 三处 chunk_id 表示一致，无 32-hex 孤儿，#7 归一化完成。"

if [[ $SMOKE -eq 1 ]]; then
  echo
  echo "########## 步骤 5：收尾回归（eval:keyword + smoke:hybrid）##########"
  npm run eval:keyword
  npm run smoke:hybrid
  echo "✅ 回归通过。"
fi
