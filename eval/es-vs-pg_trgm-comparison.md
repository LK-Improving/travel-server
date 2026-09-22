# pg_trgm vs Elasticsearch(IK) 关键词召回对比报告

> 系统：`travel-server`（智能旅行 RAG 平台）
> 对比对象：混合检索稀疏后端 `pg_trgm`（PostgreSQL `pg_trgm` 三元组） vs `elasticsearch`（BM25 + IK 分词）
> **当前对比数据集：`city-kb-kw-recall-v5`（66 例，5 维度）**
> 知识库：`26929070-a2a2-43ec-818a-ff1f6d53a996`《浙江省地市旅游美食知识库》
> 语料：11 篇地市文档｜**v5 基线 56 切片（chunk=800/120）**｜**v6 切片实验 103 切片（chunk=500/100）**
> Top-K：5 ｜ 数据集 `city-kb-kw-recall-v5`（66 例）｜ 主运行日期：2026-09-20 ｜ **切片实验：2026-09-21**

---

## 1. 结论先行（v5，66 例，跨 11 地市 56 切片）

| 维度 | 例数 | pg_trgm (R@5 / MRR) | Elasticsearch+IK | 差值（ES − pg） | 结论 |
| --- | --- | --- | --- | --- | --- |
| 召回准确率 | 15 | 1.000 / 1.000 | 1.000 / 1.000 | +0.000 / +0.000 | **持平** |
| 错别字纠正 | 12 | 0.833 / 0.778 | **0.917 / 0.917** | **+0.083 / +0.139** | **ES 占优** |
| 指代词问答 | 13 | 1.000 / 0.910 | **1.000 / 0.949** | +0.000 / **+0.039** | ES 略优（排序更好） |
| 多约束组合 | 13 | 0.846 / 0.769 | **1.000 / 0.910** | **+0.154 / +0.141** | **ES 占优** |
| 长自然语言 | 13 | 0.462 / 0.372 | **0.692 / 0.590** | **+0.231 / +0.218** | **ES 大幅占优** |
| **总体** | 66 | 0.833 / 0.773 | **0.924 / 0.876** | **+0.091 / +0.104** | **ES 占优，零回退** |

**一句话结论**：把语料从「1 篇文档 8 切片」扩到「11 篇地市文档 56 切片」后，ES 总体 Recall@5 **0.833 → 0.924**、MRR **0.773 → 0.876**；且 **ES 的命中集合仍是 pg_trgm 的严格超集**——pg 漏的 11 例中 ES 恢复 6 例，**无任何用例回退**。

**与 v4 最重要的差异：这次两边都没拿满分。** v4 语料太小（8 切片）导致 ES 满分 1.000，属于「题库被做穿」；v5 的 56 切片跨 11 个城市、大量同名/近似实体（古镇、梯田、海岛、烧饼、杨梅）互相干扰，才真正暴露出差异上限——**长自然语言仍是纯稀疏检索的硬骨头（ES 仅 0.692）**。

> **切片尺寸实验（2026-09-21，800 → 500）**：把 `RAG_CHUNK_SIZE` 从 800 降到 500（overlap 120→100）后重灌，切片数 56 → **103**。重跑 v5 评测：**ES 总体 Recall@5 仍为 0.924（MRR 0.876→0.843 微降），pg_trgm 兜底则 Recall@5 0.833→0.773 略退步**。结论——**对这个 KB + 当前检索架构，缩切片并未提升稀疏召回，反而让兜底后端略差、且存储/向量翻倍**。详见 §9。

---

## 2. 逐维度对比（v5）

### 2.1 召回准确率 — 持平 1.000
15 例含明确实体词的直问（门票价、朝代/人物、产地、时令），两类后端都满分。说明**只要查询里带准实体词，pg_trgm 三元组与 IK 词级 BM25 都能命中**，切换 ES 的收益不在这个维度。

### 2.2 错别字纠正 — ES 0.917 vs pg_trgm 0.833（ES 胜）
12 例单字形近/音近错字。pg 漏 2 例：`typo-004`（江朗→江郎）、`typo-005`（南寻→南浔）；ES 只漏 `typo-005`。
`typo-005` 是两者**共漏**：「南寻古镇」与「南浔」首字不同且「寻/浔」为 1 字替换，ES 的 `fuzziness:'AUTO'` 对 3~5 字 token 给 1 编辑距离本应覆盖，但该查询同时带「在哪里」这类虚词稀释了 BM25 排序，未进 Top-5。

### 2.3 指代词问答 — ES 1.000 / MRR 0.949 vs pg 1.000 / 0.910（ES 排序更优）
13 例均命中，但 **ES 的 MRR 更高**，说明 ES 把正确切片排得更靠前（第 1 位命中更多）。这类查询用描述性短语指代实体（「那个被称为世界第九大奇迹的石窟」「那座中国现存最早的私家藏书楼」），ES 的 `cross_fields` 多字段加权能把描述性残词与正文对齐得更好。

### 2.4 多约束组合 — ES 1.000 vs pg_trgm 0.846（ES 胜）
pg 漏 2 例：`multi-002`（带娃 + 沙滩 + 玩水 → 朱家尖）、`multi-009`（溶洞 + 避暑 → 双龙洞）。多约束长句对 pg_trgm 的整句相似度稀释严重；ES 靠词项命中 + `tags^4` 加权（地市名、城市名都是 tag）能同时满足多个信号。

### 2.5 长自然语言 — ES 0.692 vs pg_trgm 0.462（ES 大幅胜，但仍是最弱项）
**差距最大、也最真实的一类**（口语长句、隐含意图、缺精确关键词）。
- pg 漏 7/13：`nl-001/004/007/009/010/011/012`
- ES 漏 4/13：`nl-001/004/010/012`
- **ES 恢复 3 例**（nl-007 普陀山拜观音、nl-009 莫干山民宿避暑、nl-011 龙游石窟成因成谜），且这 3 例恰好是「意图最隐晦、关键词最弱」的。
- 仍共漏的 4 例说明：**纯稀疏检索对长句意图的理解存在天花板**，这是后续要靠 dense / rerank 补的方向，不是换稀疏后端能解决的。

---

## 3. 逐例差异（v5）

| 用例 | 维度 | 查询（摘要） | pg | ES | 说明 |
| --- | --- | --- | --- | --- | --- |
| typo-004 | 错别字 | 江朗山门票多少 | ❌ | ✅ | 江朗→江郎，ES 模糊 + 词项命中 |
| multi-002 | 多约束 | 带娃有沙滩能玩水的海岛 | ❌ | ✅ | 朱家尖「亲子玩沙」ES 命中 |
| multi-009 | 多约束 | 有溶洞还能避暑的地方 | ❌ | ✅ | 双龙洞 tags 含避暑，ES `tags^4` 命中 |
| nl-007 | 长句 | 老人信佛想拜观音顺便看海岛 | ❌ | ✅ | 南海观音 + 海岛词项 ES 命中 |
| nl-009 | 长句 | 民宿成熟能避暑还有民国建筑的山 | ❌ | ✅ | 莫干山别墅 ES 命中 |
| nl-011 | 长句 | 成因说不清的神秘地下石窟 | ❌ | ✅ | 龙游石窟「成谜」ES 命中 |
| typo-005 | 错别字 | 南寻古镇在哪里 | ❌ | ❌ | **共漏**，首字不同 + 虚词稀释 |
| nl-001 | 长句 | 带腿脚不便父母逛人少水乡古镇 | ❌ | ❌ | **共漏**（南浔） |
| nl-004 | 长句 | 爱吃生腌，梭子蟹几月吃、哪现捞 | ❌ | ❌ | **共漏**（梭子蟹/秋季） |
| nl-010 | 长句 | 送人特产火腿用什么原料、怎么挑 | ❌ | ❌ | **共漏**（金华火腿） |
| nl-012 | 长句 | 带老人不爬山的5A佛教景区 | ❌ | ❌ | **共漏**（天台山/国清寺） |

> **ES 命中 ⊇ pg_trgm 命中**：ES 恢复 6 例、回退 0 例；5 例共漏均为长句/极端错字，属稀疏检索能力天花板。

---

## 4. 工程实现要点（v5 变更与踩坑）

### 4.1 ⚠ 修复：ES 写入后未 refresh 导致「已发布」标记丢失（本次最严重的一个坑）
**现象**：11 篇文档入库、PG 里 56 切片全部 published，但 ES 检索全 0（v5 首跑 ES 总体 Recall 直接 0.000）。
**根因**：`indexChunks` 批量写入后，ES 默认 1s 才刷新可见；紧随其后的 `setDocumentPublished` 走 `_update_by_query`，**匹配不到刚写入的切片**，于是 `published` 仍为 false。实测当时 ES 里 `published=true` 仅 13/88（只有 1 篇文档侥幸被刷到），而检索强制 `filter: term published=true` → 全 0。
**修复**（`lib/infra/elasticsearch.ts`）：
- `_update_by_query` / `_delete_by_query` 请求加 `?refresh=true`；
- 入库脚本改为**先把 PG 置 published、再按 `published: true` 直接写入 ES**，不再依赖「写 false 再改 true」的两步。
**教训**：ES 写入与后续按条件更新之间必须显式 refresh，否则「静默漏标」，且不会报错、极难发现。

### 4.2 `regions` 字段有 CHECK 约束（只认杭州 13 区县）
`travel_documents.regions` / `travel_document_chunks.regions` 有 `CHECK (regions <@ ARRAY['上城','拱墅','西湖',…,'淳安'])` 且 `cardinality <= 3`，**地市名写进去会直接报错**。
**处理**：地市维度信息改放 `tags`（无取值约束，且 ES 里 `tags^4` 权重最高，反而更利于地市名召回）；`regions` 留空。若将来要支持按地市过滤，需要改约束（加 11 个地市名）。

### 4.3 Milvus 未启动，dense 向量暂缺
本次入库时 Milvus（`127.0.0.1:19530`）不可达，脚本自动跳过 dense 写入并在日志告警。**稀疏（ES/pg_trgm）链路不受影响，本次评测也不依赖 dense**。补 dense 需先起 Milvus，再 `npm run reindex:milvus`。

### 4.4 `created_by` 是 uuid 外键
`createKnowledgeBase` / `createDocument` 的 `created_by` 指向 `travel_users`，填非 uuid 会报类型错、填不存在的 uuid 会违反外键。入库脚本默认用本地 admin 账号，可用 `CITY_KB_ACTOR` 覆盖。

### 4.5 ES `fuzziness:'AUTO'`（v4 引入，v5 沿用）
ES 8.11.3 不允许在 `type: cross_fields` 上启用 `fuzziness`（会 HTTP 400 → 抛错 → 回落 `pg_trgm_fallback`）。实现上保留 `cross_fields` 作主 `must`，另起 `best_fields` 的 `should` 子句携带 `fuzziness:'AUTO'`（纯加分项）。已知限制：`AUTO` 对 ≤2 字 token 给 0 编辑距离，2 字错字仍靠 pg_trgm 兜底。

### 4.6 索引持久化
`docker-compose.yml` 已为 ES 配置 `travel_es_data` 持久卷，本次容器重启后索引仍在（88 切片）。但**切换 analyzer / mapping 后必须 `npm run reindex:es`**（脚本会先删索引再重建），否则字段分析器变更不生效。

---

## 5. 历史对照（v3 → v4 → v5）

| 维度 | pg(v3) | ES(v3) | pg(v4) | ES(v4) | pg(v5) | ES(v5) |
| --- | --- | --- | --- | --- | --- | --- |
| 召回准确率 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| 错别字纠正 | 0.900 | 1.000 | 0.923 | 1.000 | 0.833 | 0.917 |
| 指代词问答 | 0.600 | 0.900 | 0.786 | 1.000 | 1.000 | 1.000 |
| 多约束组合 | 0.750 | 1.000 | 0.786 | 1.000 | 0.846 | 1.000 |
| 长自然语言 | 0.500 | 1.000 | 0.643 | 1.000 | 0.462 | 0.692 |
| **总体 R@5** | 0.800 | 0.980 | 0.831 | 1.000 | **0.833** | **0.924** |
| 语料规模 | 8 切片 | | 8 切片 | | **56 切片 / 11 文档** | |

**怎么读这张表**：
- v4 的 ES 满分 1.000 不代表「无限好」，而是**语料太小、区分度不够**；
- v5 扩到 11 地市后，**双方分数都下降**（pg 0.833、ES 0.924），但**ES 相对 pg 的优势依然稳定在 +0.09 R@5 / +0.10 MRR**，且保持「严格超集、零回退」；
- 这说明 ES 的优势不是小样本偶然，在更接近真实的语料上依然成立——**这才是本次扩充语料最有价值的结论**。

---

## 6. 运行记录（可复现，v5）

| 项 | 值 |
| --- | --- |
| 知识库 | `26929070-a2a2-43ec-818a-ff1f6d53a996`《浙江省地市旅游美食知识库》 |
| 语料 | `docs/city-kb/*.md`（11 篇地市文档，enriched 后约 8KB/篇） |
| 入库 | `npm run ingest:city` → 11 文档 / 56 切片，全部 published（脚本：`scripts/ingestCityDocs.ts`） |
| ES 重灌 | `npm run reindex:es` → 88 切片（`published=true` 64） |
| 评测集 | `eval/pg_trgm_keyword_recall_dataset_v5.json`（66 例，5 维度，已过 `_verifyEvalDataset` 校验 0 问题） |
| 评测命令 | `EVAL_KB_ID=26929070-… EVAL_DATASET=eval/pg_trgm_keyword_recall_dataset_v5.json EVAL_SPARSE_VARIANT={pg_trgm\|elasticsearch} npm run eval:keyword` |
| 落库 runId | pg_trgm(v5): `1399f168-dfe9-4d43-bd54-a44980328882`；elasticsearch(v5): `1ef74f2e-b561-49e4-9e74-62c1a882ebf0` |
| 历史 runId | pg(v4) `f227b860-be0b-4700-b903-e0d92cbfe1b0`；ES(v4) `71572fb8-4255-453e-a338-54098888e023` |
| **v6 切片重灌（2026-09-21）** | `npm run ingest:city`（`.env` 改 `RAG_CHUNK_SIZE=500`）→ 11 文档 / **103 切片**全部 published；ES 重灌同步完成（Milvus 仍不可达，dense 跳过） |
| **v6 评测** | 同 v5 命令，variant 分别跑 pg_trgm / elasticsearch；**ES 首跑因 chunk_id 表示不一致显 0，已修**（`evaluateKeywordRecall.ts` 去连字符归一化），真实值见 §9.2 |

---

## 7. 后续建议

1. **补 dense 向量**：起 Milvus 后 `npm run reindex:milvus`，再评估「dense + sparse(RRF) + rerank」能否把长自然语言从 0.692 拉上去——这是当前最大的短板，且单靠稀疏后端已到顶。
2. **长自然语言专项**：本次 5 例共漏全在长句。可考虑查询改写（LLM 抽取实体/意图后再检索），比继续调稀疏后端更有效。
3. **2 字错字兜底**：如需 ES 独立覆盖（如 南寻→南浔 这类首字替换），评估 `fuzziness:1`；当前由 pg_trgm 三元组 + `pg_trgm_fallback` 兜底。
4. **地市维度过滤**：若要按地市过滤，需放宽 `regions` 的 CHECK 约束（当前只认杭州 13 区县）。
5. **灰度策略不变**：走 `ab` 分流（先 10% ES）→ 全量；ES 失败自动回落 `pg_trgm_fallback`，零风险。

---

## 8. 文件清单

| 文件 | 作用 |
| --- | --- |
| `eval/pg_trgm_keyword_recall_dataset_v5.json` | **v5 评测集（66 例，5 维度，浙江省 11 地市语料）** |
| `eval/results-v5-pg_trgm.json` / `results-v5-elasticsearch.json` | **v5 双后端实跑结果** |
| `docs/city-kb/01~11_*.md` | **入库用的 11 篇 enriched 地市文档（项目内副本）** |
| `scripts/ingestCityDocs.ts` | 地市文档批量入库脚本（`npm run ingest:city`） |
| `scripts/_dumpCityChunks.ts` | 导出 published 切片，供评测集落地校验 |
| `scripts/_verifyEvalDataset.ts` | 评测集校验（gold 可解 + 词面重叠） |
| `eval/_city_chunks_dump.json` | 56 个切片快照（评测集校验基准） |
| `eval/pg_trgm_keyword_recall_dataset_v4.json` | v4 评测集（71 例，杭州西湖语料，历史） |
| `eval/results-v4-pg_trgm.json` / `results-v4-elasticsearch.json` | v4 结果（历史） |
| `lib/infra/elasticsearch.ts` | ES 适配器（fuzziness should 子句 + **refresh=true 修复**） |
| `eval/es-vs-pg_trgm-comparison.md` | 本文档 |
| `eval/pg_trgm_keyword_recall_eval_report.md` | 评测方法论总文档 |
| `eval/results-v6-elasticsearch.json` / `results-v6-pg_trgm.json` | **v6 切片实验（chunk=500）双后端实跑结果** |
| `eval/results-baseline-800-elasticsearch.json` / `-pg_trgm.json` | v5/800 基线（实验前备份，用于对比） |
| `eval/_chunkLenAnalysis.mjs` + `eval/_chunklen.txt` | 切片长度分布分析（证明 800 偏粗） |
| `scripts/evaluateKeywordRecall.ts` | 评测脚本（**命中判定已加 chunk_id 去连字符归一化**，修复 ES 全 0 bug） |

---

## 9. 切片尺寸实验（2026-09-21）：800 → 500 ——「800 是不是太粗」的实测结论

### 9.1 背景与动机
`splitText` 是**纯字符滑动切分**（先 `.split(/\s+/).join(' ')` 压平换行，再按 chunkSize 滑动；仅在超过 55% 处才尝试在 `。/段落` 边界断句，否则硬切）。v5 基线 `RAG_CHUNK_SIZE=800/120` 实测：56 切片里 **71% 顶到 800 上限、p50≈762**，一个 800 字符分片常混入 3–5 个互不相关实体（如「西溪/蒋村鱼圆/龙井茶 + 千岛湖」），稀释稀疏信号。据此怀疑 800 偏粗，遂降到 **500/100** 重测。

### 9.2 实测结果（同一 v5 数据集 66 例，KB `26929070-…`）

| 维度 | 例数 | ES@800 (R@5/MRR) | ES@500 (R@5/MRR) | pg@800 | pg@500 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 召回准确率 | 15 | 1.000 / 1.000 | 1.000 / 0.967 | 1.000 | 0.933 | 基本持平 |
| 错别字纠正 | 12 | 0.917 / 0.917 | 0.917 / 0.833 | 0.833 | 0.750 | ES 持平；pg 略降 |
| 指代词问答 | 13 | 1.000 / 0.949 | 1.000 / 0.910 | 1.000 | 1.000 | 持平 |
| 多约束组合 | 13 | 1.000 / 0.910 | 1.000 / 0.891 | 0.846 | 0.769 | ES 持平；pg 略降 |
| 长自然语言 | 13 | 0.692 / 0.590 | 0.692 / 0.596 | 0.462 | 0.385 | **两端均持平**（稀疏天花板） |
| **总体** | 66 | **0.924 / 0.876** | **0.924 / 0.843** | **0.833** | **0.773** | **ES 召回零变化；pg 兜底略退步** |

> 数据来源：`results-v5-*.json`（800 基线）vs `results-v6-*.json`（500，已备份 `results-baseline-800-*.json`）。

### 9.3 结论：缩切片没有带来可测量的收益
1. **生产后端 ES 召回完全没变**（Recall@5 恒为 0.924），MRR 仅微降 0.03——IK + BM25 + `tags^4` 加权 + `fuzziness` 已经把「粗分片」问题消化掉了。
2. **兜底 pg_trgm 反而略退步**（0.833→0.773）：三元组相似度对切片更碎、候选更多时分心更严重。
3. **成本翻倍**：切片 56 → 103（≈1.84×），ES 文档、将来 Milvus 向量都要翻倍。
4. 长自然语言仍是 0.692 不变——它本来就不是切片粒度能解的（稀疏天花板），得靠 dense/rerank/查询改写。

### 9.4 ⚠ 实验途中暴露的真 bug：chunk_id 表示不一致导致 ES 评测一度全 0
初跑 500 时 ES 总体 Recall 显示 **0.000**（所有用例 `hit=false`）。排查发现：ES 返回的 `retrievedSourceIds` 是 `buildChunkId` 生成的 **32 位无连字符 hex**（如 `c8fe4dc2e53ba49f45cc30b2cf75119a`），而金标准来自 PG `uuid` 列、被 PostgreSQL **自动规整成带连字符**形式（`c8fe4dc2-e53b-…`）。**字符串比对永远不相等 → 全 0**。
- 旧 800 评测之所以正常，只是因为**旧 chunk_id 是随机 UUID（自带连字符）**，碰巧能匹配；重灌后改用 sha256 hex，表示才分歧。
- **生产不影响**：`indexChunks` 把 `content` 直接存进 ES，search 返回的是 ES 自带 `content`（见 `lib/infra/elasticsearch.ts:122 / :208`），不回 PG 按 chunk_id 取正文，故线上不会取不到正文。
- **修复（评测侧，`scripts/evaluateKeywordRecall.ts`）**：命中判定改为去连字符 + 小写归一化后再比（保留为安全网）。
- **修复（生产硬化，2026-09-21 已完成）**：把归一化下沉到数据源——`buildChunkId`（`lib/services/document_processing.ts`）直接输出**带连字符的规范 uuid** 形式，使 PG（uuid 列）、ES、Milvus 三处 `chunk_id` 表示完全一致；顺带修复了 RRF 融合时 ES/PG 同片无法去重的小隐患。重灌 city-kb（103 切片）后验证：ES 返回 `daef9fc3-6864-…` 这类带连字符 id，与 PG 金标准直接相等、`hit` 不再为假。
- **遗留**：其他经 worker 入库的历史 KB 仍是无连字符旧格式，需各自 `npm run reindex:es`（及将来 Milvus 重灌）才会更新为带连字符。

### 9.5 建议与最终决定
- **切片尺寸：维持 `RAG_CHUNK_SIZE=500/100`（用户 2026-09-21 决定）**。本实验证明 500 对稀疏召回无 measurable 收益、且让兜底 pg 略退步、存储翻倍；但用户后续会继续补充文档，细切片对增量内容更友好，故保留 500。
  - 只有在「开启 dense + rerank 后、且 LLM 取 top-k 喂文时碎片噪声成为瓶颈」时，400–500 才可能显现收益——那部分本评测无法度量（Milvus 当前未启动），需用 dense 评测另行验证。
  - **chunk_id 表示归一化硬化已完成**（见 9.4），比调切片尺寸更值得做的这条已落地。

---

## 10. 混合检索实测（2026-09-22）：dense + sparse(ES) + RRF + rerank

### 10.1 背景
§7.1 的假设：纯稀疏对长自然语言存在天花板（ES-only 长句 Recall@5=0.692），靠 dense 向量 + rerank 补。彼时 Milvus 未启动，无法度量。现 Milvus 已起、`reindex:milvus` 已灌、混合管线已实现并冒烟通过，遂在 **同口径 66 例 v5 集**（`pg_trgm_keyword_recall_dataset_v5.json`，KB `26929070-…`）上实跑 `npm run eval:hybrid`（`scripts/evaluateHybridRecall.ts`，强制 `ragHybridEnabled=true` + `ragRerankEnabled=true` + `sparseVariant=elasticsearch`，金标准与 sparse 评测完全一致：按 goldKeywords 反查 PG published 切片 + 去连字符归一化）。

### 10.2 结果（Recall@5 / MRR，与 §9.2 同口径）

| 维度 | 例数 | ES-only(§9.2) | pg_trgm(§9.2) | **hybrid(本次)** |
| --- | --- | --- | --- | --- |
| 召回准确率 | 15 | 1.000 / 1.000 | 1.000 | 1.000 / 1.000 |
| 错别字纠正 | 12 | 0.917 / 0.917 | 0.833 | 1.000 / 0.958 |
| 指代词问答 | 13 | 1.000 / 0.949 | 1.000 | 1.000 / 0.962 |
| 多约束组合 | 13 | 1.000 / 0.910 | 0.846 | 1.000 / 0.885 |
| 长自然语言 | 13 | 0.692 / 0.590 | 0.462 | **1.000 / 0.962** |
| **总体** | 66 | **0.924 / 0.843** | 0.833 | **1.000 / 0.955** |

> 数据来源：`eval/results-hybrid.json` vs `results-v5-elasticsearch.json` / `results-v5-pg_trgm.json`。hybrid 的稀疏臂走的是 ES（IK），与 ES-only 基线同后端，差异仅来自叠加的 dense 臂 + RRF + rerank。

### 10.3 结论
1. **§7.1 假设成立**：dense + rerank 把长自然语言 Recall@5 从 **0.692 拉到 1.000**、MRR 从 0.590 拉到 0.962——稀疏天花板被打破，且不是换稀疏后端能解决的方向（§7.2 的查询改写仍可锦上添花，但已非必需）。
2. **整体 Recall@5 从 0.924 提到 1.000**，错别字 / 多约束等维度也轻微上扬；MRR 0.955，相关片基本排在 top-1~2。
3. **风险面已收敛**：§7.1 担心的「long-NL 是最大短板」在 hybrid 下消失，可以放心推进 §7.5 的 A/B 灰度（先 10% ES/混合 → 全量），ES 失败仍自动回落 `pg_trgm_fallback`。

### 10.4 新增产物
- `scripts/evaluateHybridRecall.ts` + `package.json` 的 `eval:hybrid` 入口（复刻 `evaluateKeywordRecall.ts` 的金标准与指标，改走 `ragService.retrieve`）。
- `eval/results-hybrid.json`（66 例逐条 retrieved/gold/hit/rr）。
