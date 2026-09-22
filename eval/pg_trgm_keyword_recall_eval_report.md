# 关键词稀疏召回评测文档（pg_trgm → Elasticsearch）

> 适用系统：`travel-server`（智能旅行 RAG 平台）
> 评测对象：混合检索中的**稀疏/关键字**召回后端（`pg_trgm` 与 `elasticsearch`）
> 文档版本：`city-kb-kw-recall-v5`
> 数据集版本：`city-kb-kw-recall-v5`（66 例，浙江省 11 地市 56 切片）
> 历史数据集：`pg-trgm-kw-recall-v4-grounded`（71 例，杭州西湖 8 切片）

---

## 1. 现状结论（是否有现成评测集）

经全工作区排查（`travel-server` / `travel-recommend` / `docs`），结论：原系统**没有任何** keyword-recall 评测用例，只有结果**存储/导入**框架（`ai_eval_runs` / `ai_eval_results` + `importRun`）。本次新建三件套，并完成首轮 **pg_trgm 基线评测**（数据见 §6）。

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 评测结果存储/导入框架 | ✅ 已有 | `metrics` 为不可变 JSONB 快照，按 `sparse_backend` 打标 |
| keyword-recall 评测集 | ✅ 本次新建 | `eval/pg_trgm_keyword_recall_dataset.json`（18 例，三维） |
| 一键评测脚本 | ✅ 本次新建 | `scripts/evaluateKeywordRecall.ts`（纯稀疏，复用生产路由 `KeywordSearchRouter`） |
| 按后端并列对比接口 | ✅ 本次新建 | `GET /api/admin/evaluations/compare` |

---

## 2. 评测目标与维度

目的：量化把稀疏后端从 `pg_trgm` 全量切到 `elasticsearch`（IK 分词）后，关键字召回质量的变化，并定位两类后端各自擅长的边界。

| 维度 | 含义 | 预期差异（pg_trgm vs ES IK） |
| --- | --- | --- |
| **召回准确率** | 显式关键词查询能否命中含关键词的切片 | ES 词级 BM25 排序更准（title/section/tags 加权）；pg_trgm 三元组对短查询子串命中同样好 |
| **错别字纠正** | 查询含错别字/形近字时是否仍能召回 | **pg_trgm 天然错字鲁棒**（三元组重叠）；ES 精确分词，错字易 miss——除非开 `fuzziness` |
| **指代词问答** | 查询为代词/指代（它、那里、上面说的）时能否召回 | 两者都弱：代词无关键词信号，纯关键字检索的结构性上限，需 dense 向量兜底 |
| **多约束组合**（v3 新增） | 查询含多个属性/约束（免费、季节、交通方式、登高等），能否同时命中多个约束信号 | ES 词项匹配+字段加权更擅长；pg_trgm 对长句相似度稀释严重 |
| **长自然语言**（v3 新增） | 接近真实用户口语的长句（缺精确关键词、隐含意图），能否召回相关切片 | ES(IK+`cross_fields`) 显著优于 pg_trgm 的 trigram 子串相似度；最能拉开两者差距 |

---

## 3. 指标定义

基于「金标准是否在 Top-K 命中」计算。金标准（ground truth）由 `goldKeywords` 经 PostgreSQL 内容反查**独立**得到，**不依赖被测后端**，保证 pg_trgm 与 ES 在同一标准下可比。

**金标准解析规则（`scripts/evaluateKeywordRecall.ts` `resolveGoldChunkIds`）**：
一个切片判定为「相关」当且仅当——

1. 包含主实体关键词 `goldKeywords[0]`（保证主题相关）；且
2. 当关键词 > 1 个时，至少包含其余关键词中的**任意一个**（保证命中答题切片，而非仅擦边提及）。

> ⚠️ 历史坑位（已修复）：早期实现要求「单一切片同时包含【全部】关键词（AND）」且 `ILIKE` 漏写 `%` 通配（退化为精确相等），导致金标准在任何语料下都解析为空 → 全量 `recallAtK=0`。现已改为主实体 + 任意上下文词，并补 `%` 通配。

| 指标 | 公式 | 说明 |
| --- | --- | --- |
| **Recall@K** | 命中金标准用例数 / 已解析金标准用例数 | 主指标 |
| **MRR@K** | 各用例首命中排名倒数均值 | 衡量「排得有多靠前」 |
| **错字下降率** | 1 − (错字查询 Recall@K / 干净查询 Recall@K) | 仅「错别字纠正」维度；越低越抗错字 |

> 默认 `K = 5`（数据集 `recallK` 与脚本 `EVAL_K`）。

---

## 4. 评测集设计（已对齐真实语料）

知识库实际只有 **1 篇已发布文档《西湖带图片千问》（8 切片）**，内容覆盖西湖十景、灵隐寺、西溪湿地、龙井、雷峰塔、杭州东站、门票、美食、交通、最佳季节等。原 v1 数据集按「每 POI 一篇文档」的想象语料编写（含千岛湖/乌镇/价格/产地等真实文档中不存在的词），已废弃。v2 全部问题均可在本 8 切片内找到答案，goldKeywords 选取「主实体 + 至少一个上下文词」且保证在同一切片共现，使金标准精确可解。

共 **71** 例（v4）：召回准确率 16 / 错别字纠正 13 / 指代词问答 14 / 多约束组合 14 / 长自然语言 14。较 v3（50 例）新增 21 例，重点放大 ES 优势维度（长自然语言 6→14、多约束组合 8→14、指代词 10→14、错别字 10→13）。v2（18 例，三维度）与 v3（50 例）保留作历史对照，分别见 `eval/pg_trgm_keyword_recall_dataset.json` 与 `eval/pg_trgm_keyword_recall_dataset_v3.json`；v4 见 `eval/pg_trgm_keyword_recall_dataset_v4.json`。

### v5（当前主对比集）：跨 11 地市 56 切片

v4 的语料只有 1 篇文档 8 切片，ES 拿到满分 1.000，属于「题库被做穿」、区分度不足。v5 按 §7 建议**把语料扩到真实规模**：新增《浙江省地市旅游美食知识库》（KB `26929070-a2a2-43ec-818a-ff1f6d53a996`），收录杭州、宁波、温州、绍兴、金华、衢州、湖州、嘉兴、舟山、台州、丽水 **11 篇地市文档 / 56 个 published 切片**，共 **66 例**（召回准确率 15 / 错别字 12 / 指代词 13 / 多约束 13 / 长自然语言 13）。

设计要点：
- **跨文档干扰**：刻意选用跨城市近似实体（古镇：南浔/西塘/乌镇/安昌/廿八都；海岛：普陀山/朱家尖/东极岛/嵊泗；烧饼类：缙云烧饼/金华酥饼/衢州烤饼；杨梅：仙居/余姚慈溪），让「召回对的城市」成为真实难点。
- **全部用例过校验**：`scripts/_verifyEvalDataset.ts` 校验每条用例 (1) goldKeywords 能反查到 ≥1 个 published 切片、(2) 查询与金标准切片存在 ≥2 字子串重叠（防结构性假阴性）。v5 校验结果 **0 问题**。
- 用例示例（v5）：

| 维度 | 用例示例 | 金标准关键词 |
| --- | --- | --- |
| 召回准确率 | 普陀山是哪位菩萨的道场 | 普陀山 / 观音 |
| 错别字纠正 | 神先居的如意桥好玩吗（仙→先） | 神仙居 / 如意桥 |
| 指代词问答 | 那个被称为世界第九大奇迹的石窟在哪里 | 龙游石窟 / 谜 |
| 多约束组合 | 浙江哪个古镇免费开放还能坐乌篷船 | 安昌古镇 / 乌篷船 |
| 长自然语言 | 对溶洞和地下奇观感兴趣，成因说不清的神秘地下石窟 | 龙游石窟 / 谜 |

> **v4 关键修复**：原 `pron-003`（`question="这个地方有什么特色活动可以玩"`、`gold=["西溪湿地","摇橹船"]`）为纯泛指代词、与 gold 词面零重叠，任何无状态稀疏检索都无法命中，属评测集结构性假阴性。v4 改为保留可检索上下文词（`question="前面提到的那个国家湿地公园有什么特色活动"`、`gold=["西溪湿地","湿地公园"]`，chunk#3 西溪湿地简介即「国内首个国家湿地公园」），假阴性消除。

| 维度 | 用例示例 | 金标准关键词 | 目标切片 |
| --- | --- | --- | --- |
| 召回准确率 | 西湖边免费的景点有哪些 | 西湖 / 免费 / 景点 | 门票信息段（含「免费景点：西湖环湖公园」） |
| 召回准确率 | 从杭州东站怎么去西湖 | 杭州东站 / 西湖 / 交通 | 交通指南段 |
| 召回准确率 | 苏堤是哪个朝代谁主持修筑的 | 苏堤 / 北宋 | 景区简介段（北宋苏东坡） |
| 错别字纠正 | 西胡边免费的景点有哪些（西湖→西胡） | 西湖 / 免费 / 景点 | 同召回准确率 |
| 错别字纠正 | 雷峰搭可以登塔俯瞰西湖吗（塔→搭） | 雷峰塔 / 俯瞰 | 雷峰夕照段 |
| 指代词问答 | 它附近有推荐的餐厅吗（它=西湖） | 西湖 / 餐厅 / 美食 | 美食推荐段 |
| 指代词问答 | 上面说的那座塔能登顶看全景吗（塔=雷峰塔） | 雷峰塔 / 俯瞰 | 雷峰夕照段 |

> **指代词维度说明**：查询本身不含实体关键词（「它」「那里」「上面说的」），goldKeywords 为**消解后的真实实体**。这类用例预期召回偏低——正说明纯关键字检索处理指代的天花板，需 dense 向量召回兜底。

---

## 5. 执行步骤

### 5.1 前置条件
- 知识库已写入 PG（`travel_document_chunks`），文档 `status=published`、知识库 `status=active`。
- 取得目标知识库 uuid，记为 `<KB_ID>`：
  - **v5 地市库**：`26929070-a2a2-43ec-818a-ff1f6d53a996`（11 文档 / 56 切片）
  - v4 杭州西湖库：`fded519d-0984-49b9-8a72-d2db0ad983aa`（8 切片，历史）
- 跑 ES 对比前：`ELASTICSEARCH_URL` 指向**已装 IK 插件**的集群，并执行 `npm run reindex:es`。
- ⚠️ **入库后必须确认 ES 的 `published` 标记**：批量写入后紧跟的 `_update_by_query` 若未带 `refresh=true` 会匹配不到刚写入的切片，导致 `published` 仍为 false、检索全 0（v5 踩过，已在 `lib/infra/elasticsearch.ts` 修复）。验证：`GET /<index>/_search {"query":{"bool":{"filter":[{"term":{"published":true}}]}}}` 的条数应等于 PG 里 published 切片数。

### 5.2 跑评测（两后端各一遍）
```bash
# 默认数据集（v2，18 例）：EVAL_DATASET 省略
EVAL_KB_ID=<KB_ID> EVAL_SPARSE_VARIANT=pg_trgm        npm run eval:keyword
EVAL_KB_ID=<KB_ID> EVAL_SPARSE_VARIANT=elasticsearch  npm run eval:keyword
# 扩量数据集（v3，50 例，5 维度）——历史对照
EVAL_KB_ID=<KB_ID> EVAL_SPARSE_VARIANT=pg_trgm        EVAL_DATASET=eval/pg_trgm_keyword_recall_dataset_v3.json npm run eval:keyword
EVAL_KB_ID=<KB_ID> EVAL_SPARSE_VARIANT=elasticsearch  EVAL_DATASET=eval/pg_trgm_keyword_recall_dataset_v3.json npm run eval:keyword
# 主对比集（v5，66 例，5 维度，11 地市）——当前主对比集
EVAL_KB_ID=26929070-a2a2-43ec-818a-ff1f6d53a996 EVAL_SPARSE_VARIANT=pg_trgm       EVAL_DATASET=eval/pg_trgm_keyword_recall_dataset_v5.json npm run eval:keyword
EVAL_KB_ID=26929070-a2a2-43ec-818a-ff1f6d53a996 EVAL_SPARSE_VARIANT=elasticsearch EVAL_DATASET=eval/pg_trgm_keyword_recall_dataset_v5.json npm run eval:keyword

# 历史对照（v4，71 例，杭州西湖 8 切片）
EVAL_KB_ID=fded519d-0984-49b9-8a72-d2db0ad983aa EVAL_SPARSE_VARIANT=pg_trgm       EVAL_DATASET=eval/pg_trgm_keyword_recall_dataset_v4.json npm run eval:keyword
EVAL_KB_ID=fded519d-0984-49b9-8a72-d2db0ad983aa EVAL_SPARSE_VARIANT=elasticsearch EVAL_DATASET=eval/pg_trgm_keyword_recall_dataset_v4.json npm run eval:keyword

# 评测集落地校验（改完用例必跑，要求 problems=0）
npx tsx scripts/_verifyEvalDataset.ts eval/pg_trgm_keyword_recall_dataset_v5.json eval/_city_chunks_dump.json
# 切片快照导出（语料变更后重导）
KB_ID=26929070-a2a2-43ec-818a-ff1f6d53a996 npx tsx scripts/_dumpCityChunks.ts
```
输出：结果文件 `eval/results-pg_trgm.json` 与 `eval/results-elasticsearch.json`（含逐例 `hit`/`goldSourceIds` 与维度 `recallAtK`/`mrr`）。v4 结果另存为 `eval/results-v4-*.json` 以备对照。

### 5.3 留存与对比
通过运营台 `POST /api/admin/evaluations/runs/import` 导入（按 `sparse_backend` 打标），随后 `GET /api/admin/evaluations/compare` 并列取出两后端最近一次运行对照。

> ✅ **ES 前置已就绪（2026-09-20）**：`.env` 的 `ELASTICSEARCH_URL=http://127.0.0.1:9200` 已指向本机带 IK 的 ES（`travel-elasticsearch-ik:8.11.3`，本地 Dockerfile 构建），已完成 `reindex:es`（写入 32 切片）。此时 `EVAL_SPARSE_VARIANT=elasticsearch` 跑出的即真实 ES 结果，可与 pg_trgm 有效对比。详细对比见 `eval/es-vs-pg_trgm-comparison.md`。

---

## 6. 评测结果（pg_trgm 基线，已实跑）

> 运行环境：KB `fded519d-...`（文档《西湖带图片千问》8 切片），Top-K=5，数据集 `pg-trgm-kw-recall-v2-grounded`。
> 数据来源：`eval/results-pg_trgm.json`（2026-09-19 实跑）。

| 维度 | 用例数 | 已解析 | Recall@5 | MRR@5 |
| --- | --- | --- | --- | --- |
| 召回准确率 | 8 | 8 | **1.000** | **1.000** |
| 错别字纠正 | 5 | 5 | **1.000** | **1.000** |
| 指代词问答 | 5 | 5 | **0.400** | **0.167** |
| **总体** | 18 | 18 | **0.833** | **0.769** |

**错别字纠正维度（错字鲁棒性）**：

| 后端 | 干净查询 Recall@5 | 错字查询 Recall@5 | 错字下降率 |
| --- | --- | --- | --- |
| **pg_trgm** | 1.000（对应 recall-001/002/003/004/007 全命中） | 1.000（typo-001/002/003/004/005 全命中） | **0.000**（完全抗错字） |

**指代词问答逐例（pg_trgm）**：

| 用例 | 查询 | 命中 | 说明 |
| --- | --- | --- | --- |
| pron-001 | 它附近有推荐的餐厅吗 | ✅ | 残留词「餐厅/美食」命中美食段 |
| pron-002 | 那里的门票贵不贵 | ❌ | 检索返回空——「那里的门票贵不贵」与切片相似度 < 0.05 阈值，连候选都无 |
| pron-003 | 这个地方有什么特色活动可以玩 | ❌ | 检索命中简介段，但金标准为西溪湿地段（摇橹船），错位 |
| pron-004 | 上面说的那座塔能登顶看全景吗 | ✅ | 残留词「塔/俯瞰」命中雷峰夕照段 |
| pron-005 | 这趟行程的最佳季节是什么时候 | ❌ | 检索命中简介段，但金标准为季节段，错位 |

---

## 6.5 Elasticsearch(IK) 实跑结果（2026-09-20，v4 数据集 71 例）

> 运行环境：同一 KB、Top-K=5、数据集 `pg-trgm-kw-recall-v4-grounded`（71 例，5 维度）；ES 为本机 `travel-elasticsearch-ik:8.11.3`（IK 8.11.3），已 `reindex:es`。
> 数据来源：`eval/results-v4-elasticsearch.json`；落库 runId `71572fb8-4255-453e-a338-54098888e023`。

| 维度 | 用例数 | 已解析 | Recall@5 | MRR@5 |
| --- | --- | --- | --- | --- |
| 召回准确率 | 16 | 16 | **1.000** | **1.000** |
| 错别字纠正 | 13 | 13 | **1.000** | **1.000** |
| 指代词问答 | 14 | 14 | **1.000** | **1.000** |
| 多约束组合 | 14 | 14 | **1.000** | **1.000** |
| 长自然语言 | 14 | 14 | **1.000** | **1.000** |
| **总体** | 71 | 71 | **1.000** | **1.000** |

ES 全中（71/71），且命中为 pg_trgm 命中集合的严格超集（恢复 pg 的 12 例失败，零共漏、零回退）。新增的 `fuzziness:'AUTO'` 以独立 `best_fields` `should` 子句落地（ES 不允许在 `cross_fields` 上用 fuzziness）。详细逐例差异见 `eval/es-vs-pg_trgm-comparison.md` §3。

> 历史对照：v2（18 例）ES 0.944 / 0.944；v3（50 例）ES 0.980 / 0.980（唯一共漏 `pron-003`）；v4（71 例）因 `pron-003` 修复 + 维度扩充，ES 达满分 1.000 / 1.000。

### 6.6 pg_trgm 基线（v4 数据集 71 例，对照用）

> 数据来源：`eval/results-v4-pg_trgm.json`；落库 runId `f227b860-be0b-4700-b903-e0d92cbfe1b0`。

| 维度 | 用例数 | 已解析 | Recall@5 | MRR@5 |
| --- | --- | --- | --- | --- |
| 召回准确率 | 16 | 16 | **1.000** | **1.000** |
| 错别字纠正 | 13 | 13 | 0.923 | 0.923 |
| 指代词问答 | 14 | 14 | 0.786 | 0.649 |
| 多约束组合 | 14 | 14 | 0.786 | 0.786 |
| 长自然语言 | 14 | 14 | 0.643 | 0.607 |
| **总体** | 71 | 71 | **0.831** | **0.797** |

pg 漏 12 例（typo-009、pron-002/005/007、attr-001/005/014、nl-001/002/003/010/013），全部被 ES 恢复。

### 6.7 v5 实跑结果（2026-09-20，11 地市 56 切片，66 例）

> 运行环境：KB `26929070-...`（11 文档 / 56 published 切片），Top-K=5，数据集 `city-kb-kw-recall-v5`；ES 为本机 `travel-elasticsearch-ik:8.11.3`，已 `reindex:es`（88 切片，其中 `published=true` 64）。
> 数据来源：`eval/results-v5-pg_trgm.json` / `eval/results-v5-elasticsearch.json`；
> 落库 runId：pg_trgm `1399f168-dfe9-4d43-bd54-a44980328882`，elasticsearch `1ef74f2e-b561-49e4-9e74-62c1a882ebf0`。

| 维度 | 例数 | pg_trgm Recall@5 / MRR | ES Recall@5 / MRR | 差值 |
| --- | --- | --- | --- | --- |
| 召回准确率 | 15 | 1.000 / 1.000 | 1.000 / 1.000 | 持平 |
| 错别字纠正 | 12 | 0.833 / 0.778 | **0.917 / 0.917** | +0.083 / +0.139 |
| 指代词问答 | 13 | 1.000 / 0.910 | **1.000 / 0.949** | +0.000 / +0.039 |
| 多约束组合 | 13 | 0.846 / 0.769 | **1.000 / 0.910** | +0.154 / +0.141 |
| 长自然语言 | 13 | 0.462 / 0.372 | **0.692 / 0.590** | +0.231 / +0.218 |
| **总体** | 66 | 0.833 / 0.773 | **0.924 / 0.876** | **+0.091 / +0.104** |

- **pg 漏 11 例**：typo-004/005、multi-002/009、nl-001/004/007/009/010/011/012
- **ES 漏 5 例**：typo-005、nl-001/004/010/012（**全部是 pg 漏例的子集**）
- **ES 恢复 6 例、回退 0 例** → ES 命中集合仍是 pg 的严格超集
- **5 例共漏**全在长自然语言与极端错字，属稀疏检索天花板，需 dense/rerank 或查询改写补齐

---

## 7. 分析与结论（pg_trgm vs ES，已实跑）

| 特性 | pg_trgm（三元组） | Elasticsearch + IK |
| --- | --- | --- |
| 中文匹配方式 | 字符三元组重叠（`word_similarity`） | 词级 BM25（ik_max_word/ik_smart） |
| 显式词召回/排序 | 好（短查询子串命中优秀，1.000） | 持平（1.000），title/section/tags 加权 |
| **错字/形近字鲁棒性** | 强但非完美（v3 错字 0.900，首字错会翻车） | **更优（v3 错字 1.000）** |
| 指代词 | 弱（v3 0.600，多例零召回） | **更优（v3 0.900）**，`cross_fields` 借残留实义词命中 |
| 多约束组合 | 弱（v3 0.750，长句稀释） | **更优（v3 1.000）** |
| 长自然语言 | 弱（v3 0.500，弱信号几乎失效） | **大幅更优（v3 1.000）** |
| 长文档噪声 | 三元组可能引入无关重叠 | 词级更聚焦 |

**关键结论（v5，66 例 5 维度，11 地市 56 切片）**：
1. **pg_trgm 整体 Recall@5 = 0.833 / MRR = 0.773**；**ES 整体 Recall@5 = 0.924 / MRR = 0.876**，总体提升 **+0.091 / +0.104**。
2. **ES 命中仍是 pg_trgm 命中集合的严格超集**：pg 漏 11 例，ES 恢复其中 6 例，**回退 0 例**。
3. **v4 的 ES 满分 1.000 是语料太小造成的假象**。扩到 11 地市后双方分数都下降（pg 0.831→0.833 基本持平，ES 1.000→0.924），但 **ES 的相对优势稳定在 +0.09 R@5**，说明优势不是小样本偶然，在更接近真实的语料上依然成立——这是本次扩充语料最有价值的结论。
4. **召回准确率维度两者持平（均 1.000）**：查询带准实体词时，三元组与 IK 词级 BM25 都能命中，切换 ES 的收益不在这里。
5. **核心收益仍在「弱信号」两类**：多约束组合（0.846→1.000）、长自然语言（0.462→0.692）。pg_trgm 的整句子串相似度在多约束长句上稀释严重；ES 的词项命中 + `tags^4` 加权（地市名即为 tag）能同时满足多个信号。
6. **长自然语言是稀疏检索的共同天花板**：ES 仅 0.692，5 例共漏全在此维度。这已不是换稀疏后端能解决的，需 dense/rerank 或 LLM 查询改写补齐。
7. **`pron-003` 已在 v4 修复**（gold 改为可检索上下文词「湿地公园」）；v5 全部 66 例均通过 `_verifyEvalDataset` 校验（gold 可解 + 词面重叠），无结构性假阴性。
8. **ES 已加 `fuzziness:'AUTO'`**（独立 `best_fields` `should` 子句，因 ES 禁止在 `cross_fields` 上用 fuzziness）。注意 `AUTO` 对 ≤2 字 token 给 0 编辑距离，2 字错字仍靠 pg_trgm 三元组 + `pg_trgm_fallback` 兜底。
9. **入库踩坑已修复**：ES 批量写入后未 refresh 导致 `published` 漏标、检索全 0（详见 §5.1 与对比报告 §4.1）。
10. 完整对比见 `eval/es-vs-pg_trgm-comparison.md`。

---

## 附：文件清单

| 文件 | 作用 |
| --- | --- |
| `eval/pg_trgm_keyword_recall_dataset.json` | 评测集 v2（18 例，三维，已对齐真实语料，历史） |
| `scripts/evaluateKeywordRecall.ts` | 一键评测脚本（纯稀疏，复用生产路由；金标准解析已修复） |
| `eval/pg_trgm_keyword_recall_dataset_v3.json` | 评测集 v3（50 例，5 维度，历史对照） |
| `eval/pg_trgm_keyword_recall_dataset_v5.json` | **评测集 v5（66 例，5 维度，浙江省 11 地市语料）——当前主对比集** |
| `eval/results-v5-pg_trgm.json` / `results-v5-elasticsearch.json` | **v5 双后端实跑结果** |
| `docs/city-kb/01~11_*.md` | **入库用的 11 篇 enriched 地市文档** |
| `scripts/ingestCityDocs.ts` | 地市文档批量入库脚本（`npm run ingest:city`） |
| `eval/pg_trgm_keyword_recall_dataset_v4.json` | 评测集 v4（71 例，5 维度，含 pron-003 修复，历史） |
| `eval/results-v4-pg_trgm.json` | **pg_trgm 实跑结果（v4）** |
| `eval/results-v4-elasticsearch.json` | **ES 实跑结果（v4）** |
| `eval/results-v3-pg_trgm.json` / `results-v3-elasticsearch.json` | v3 结果（历史备份，50 例） |
| `eval/results-v2-pg_trgm.json` / `results-v2-elasticsearch.json` | v2 结果（历史备份，18 例） |
| `eval/es-vs-pg_trgm-comparison.md` | pg_trgm vs ES 对比结论 |
| `eval/pg_trgm_keyword_recall_eval_report.md` | 本文档 |
| `migrations/20260919_add_eval_sparse_backend.sql` | 评测运行按后端打标 + 历史回填 |
| `app/api/admin/evaluations/compare/route.ts` | 按后端并列对比最近一次评测 |
