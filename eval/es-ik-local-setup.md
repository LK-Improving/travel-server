# 本机搭建 Elasticsearch + IK 分词（用于 travel-server 关键字检索评测）

> 目标：让 `RAG_SPARSE_BACKEND` 的 `elasticsearch` 臂真正生效，跑出与 pg_trgm 可比的评测。
> ✅ **已就绪（2026-09-20）**：本机已用本地 Dockerfile 构建并启动带 IK 的 ES（host 9200），`.env` 的 `ELASTICSEARCH_URL=http://127.0.0.1:9200` 已填，已 `reindex:es`，pg_trgm vs ES 对比评测已完成（见 `eval/es-vs-pg_trgm-comparison.md`）。

---

## 一、环境需求

| 项 | 要求 |
| --- | --- |
| OS | Windows 10/11（本机） |
| 内存 | ES 8.x 默认堆 1GB，建议 ≥4GB 可用；紧张可调到 512m |
| 端口 | 9200（HTTP，必用）；9300（transport，单节点本地不用管） |
| 网络 | 能访问外网下载 ES 与 IK 插件（或提前下好离线包） |
| 版本匹配 | **IK 插件版本必须与 ES 主版本严格一致**（如 ES 8.11.x ↔ ik 8.11.x） |
| JDK | ES 8.x / 7.x 发行包**已内置 JDK**，无需单独安装 |

---

## 二、两种落地方式

### 方式 A：Docker（最省心，推荐）— 需先装 Docker Desktop（WSL2 后端）

> ⚠️ **重要变更（2026-09-20）**：原 `medcl/elasticsearch-analysis-ik` 镜像**已从 Docker Hub 下架**（pull access denied），不能再 `docker run medcl/...`。改为**基于官方 ES 镜像本地 bake 一个带 IK 的镜像**：把 IK 插件 zip 离线 COPY 进去安装。项目已提供 `docker/es-ik/Dockerfile` + 预下载的 `docker/es-ik/elasticsearch-analysis-ik-8.11.3.zip`，一键构建：

```bash
# 在 travel-server 根目录（docker-compose.yml 已引用该 build 上下文）
docker compose up -d --build elasticsearch
# 或单独 build 镜像
docker build -t travel-elasticsearch-ik:8.11.3 -f docker/es-ik/Dockerfile docker/es-ik
docker run -d --name es-ik -p 9200:9200 -p 9300:9300 \
  -e "discovery.type=single-node" \
  -e "xpack.security.enabled=false" \
  -e "ES_JAVA_OPTS=-Xms512m -Xmx512m" \
  travel-elasticsearch-ik:8.11.3
```

> IK 版本必须与 ES 主版本**严格一致**（8.11.3 ↔ ik 8.11.3）。若换 ES 版本，需重新下载对应 `elasticsearch-analysis-ik-<ver>.zip`（来源：`https://get.infini.cloud/elasticsearch/analysis-ik/<ver>`，例如 `https://get.infini.cloud/elasticsearch/analysis-ik/8.11.3`，约 4.6MB）。
> 验证：`curl http://localhost:9200/_cat/plugins` 应出现 `analysis-ik 8.11.3`；分词测试见下方 §三 步骤 3 之前的 IK 验证。

### 方式 B：Windows 裸装（官方 ZIP）
1. 下载 ES（Windows ZIP）：https://www.elastic.co/cn/downloads/elasticsearch （例 8.11.x）。
2. 解压到 `D:\Tools\elasticsearch-8.11.x`（路径**不要带中文/空格**）。
3. 装 IK（管理员 PowerShell 进 `bin`）：
   ```powershell
   # 在线（CDN，已验证可用；版本须与 ES 一致）
   .\elasticsearch-plugin install https://get.infini.cloud/elasticsearch/analysis-ik/8.11.3
   ```
   > ⚠️ IK 官方 GitHub Releases 已不再托管 zip 包（访问会 404），现统一由 `get.infini.cloud` 分发。
   > 离线则先下好 zip（`Invoke-WebRequest https://get.infini.cloud/elasticsearch/analysis-ik/8.11.3 -OutFile ik.zip`），再用 `.\elasticsearch-plugin install file:///D:/path/ik.zip`。
4. 配置 `config/elasticsearch.yml`（单节点、本地关安全）：
   ```yaml
   discovery.type: single-node
   xpack.security.enabled: false
   network.host: 127.0.0.1
   ```
   > 本地评测关掉安全最省事；适配器仅在 `ELASTICSEARCH_API_KEY` 非空时才带鉴权头。
5. 启动：双击 / 运行 `bin\elasticsearch.bat`（保持窗口开；或装成服务）。
6. 验证：`curl http://localhost:9200`。

---

### 方式 C：docker compose 统一环境（推荐，一次起 PG + Redis + ES+IK）
项目根目录已提供 `docker-compose.yml`，把后端依赖一次性编排，端口已规避本机现有 Docker 容器：
- PostgreSQL → host **5434**（避开 5432 native / 5433 dt-postgres / 7311 ai-retouch）
- Redis → host **6381**（避开 6379 local-redis / 6380 dt-redis / 7312 ai-retouch）
- Elasticsearch+IK → host **9200**（本地 `travel-elasticsearch-ik:8.11.3`，基于官方 ES + 离线 IK 构建，避开 9000/9001 dt-minio）
```bash
# 仅起 ES（最小改动，配合现有 native PG/Redis=5432/6379 即可跑评测）：
docker compose up -d elasticsearch
# 或起全部（完整容器化，注意数据迁移，见下）：
docker compose up -d
```
> **数据提示**：原生 PG(5432) 已存 travel 库（知识库/切片/评测数据）。只跑 ES 时，应用与评测脚本继续连原生 5432/6379，`.env` 只需设 `ELASTICSEARCH_URL=http://127.0.0.1:9200`，无需动 PG/Redis；若要跑全部容器，需先把原生 travel 库迁到容器 PG(5434) 并改 `.env` 的 `AUTH_DB_PORT=5434`、`REDIS_URL=redis://localhost:6381`，否则应用读不到数据。（迁移示例见 `docker-compose.yml` 顶部注释。）

## 三、接入 travel-server

1. `.env`：
   ```env
   ELASTICSEARCH_URL=http://127.0.0.1:9200
   ELASTICSEARCH_INDEX=travel-rag-chunks-v1
   ELASTICSEARCH_ANALYZER=ik_max_word
   ELASTICSEARCH_SEARCH_ANALYZER=ik_smart
   ELASTICSEARCH_API_KEY=
   ```
   ⚠️ 分析器 `ik_max_word` / `ik_smart` **依赖 IK 插件**；没装 IK 时 `reindex:es` 会因 mapping 找不到分析器而失败。
2. 回灌索引（删旧索引 + 重建 + 写全量切片）：
   ```bash
   npm run reindex:es
   ```
3. 跑 ES 评测（与 pg_trgm 同 KB、同数据集）：
   ```powershell
   $env:EVAL_KB_ID="fded519d-0984-49b9-8a72-d2db0ad983aa"
   $env:EVAL_SPARSE_VARIANT="elasticsearch"
   npm run eval:keyword
   ```
   结果写 `eval/results-elasticsearch.json`。
4. 对比：运营台 `GET /api/admin/evaluations/compare`（已按 `sparse_backend` 打标）；或两份 `results-*.json` 直接对表。

---

## 四、常见坑

- **IK 版本 ≠ ES 版本** → 插件加载失败、节点起不来。务必同版本。
- **9200 被占用** → 改 `elasticsearch.yml` 的 `http.port`，并同步 `.env` 的 `ELASTICSEARCH_URL`。
- **内存不足** → 调 `ES_JAVA_OPTS=-Xms512m -Xmx512m`（本地评测够用）。
- **ES 8 默认开安全（TLS+账号）** → 本地未关会导致适配器连不上 / 401；关掉或配 `ELASTICSEARCH_API_KEY`。
- **错字维度** → ES 不开 `fuzziness` 时，错字用例（西胡/价恪/搭）会明显劣于 pg_trgm；建议在 `lib/infra/elasticsearch.ts` 的 `multi_match` 加 `fuzziness: 'AUTO'`。

---

## 五、pg_trgm 基线已暂存

`scripts/importKeywordEvalBaseline.ts` 已把 `eval/results-pg_trgm.json` 写入评测框架
（`ai_eval_runs` + `ai_eval_results`，`sparse_backend='pg_trgm'`）。ES 评测跑完并同样 `import` 后，
`/compare` 即可并列两后端指标。导入命令：
```powershell
$env:EVAL_KB_ID="fded519d-0984-49b9-8a72-d2db0ad983aa"; node --import tsx scripts/importKeywordEvalBaseline.ts
```
