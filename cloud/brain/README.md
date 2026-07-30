# @piclaw-cloud/brain

无状态 Brain 服务：turn 执行、Redis→SSE（Web `agent_*` 词表）、CubeSandbox 工具路由、Web UI 兼容 API。

## 启动

```bash
cd cloud && bun install
cp brain.config.example.json brain.config.json
# 编辑 brain.config.json：openai.apiKey、openai.baseUrl、sandbox 等
cd brain && bun run start
```

可选：指定配置文件路径

```bash
bun run start -- --config=/path/to/brain.config.json
```

### 配置文件

主配置位于 [`cloud/brain.config.json`](../brain.config.json)（本地文件，已 gitignore）。模板见 [`cloud/brain.config.example.json`](../brain.config.example.json)。

| 节 | 说明 |
|----|------|
| `pg` / `redis` | 数据库与 Redis |
| `openai` | LLM 端点与 API Key |
| `sandbox` | CubeSandbox / E2B 集群 |
| `subagent` | `coding_agent` worker 模式 |
| `server` | 端口、replicaId 等 |

**优先级**：`brain.config.json` > 环境变量（CI 可选覆盖）> 代码默认值。

### 环境变量（可选 CI 覆盖）

本地开发推荐只维护 JSON。CI/部署仍可通过环境变量覆盖：

| 环境变量 | 配置项 |
|----------|--------|
| `POC_PG_URL` / `CLOUD_PG_URL` | `pg.url` |
| `POC_REDIS_URL` / `CLOUD_REDIS_URL` | `redis.url` |
| `POC_OPENAI_BASE_URL` / `CLOUD_OPENAI_BASE_URL` | `openai.baseUrl` |
| `POC_OPENAI_API_KEY` / `CLOUD_OPENAI_API_KEY` | `openai.apiKey` |
| `POC_OPENAI_MODEL` / `CLOUD_OPENAI_MODEL` | `openai.model` |
| `E2B_API_URL` / `CUBE_API_URL` | `sandbox.apiUrl` |
| `CUBE_TEMPLATE_ID` | `sandbox.templateId` |
| `CUBE_PROXY_NODE_IP` | `sandbox.proxyNodeIp` |
| `CLOUD_CODING_WORKER_MODE` | `subagent.codingWorkerMode` |
| `CLOUD_LLM_MOCK` | 设为 `1` 启用 `mock-tools:` / `mock-coding:` 测试响应 |

## API

| 路径 | 说明 |
|------|------|
| `POST /sessions` | 创建 session（原生） |
| `POST /sessions/:id/messages` | 提交消息 |
| `GET /sessions/:id/stream` | SSE（Web 词表） |
| `GET /sse/stream?chat_jid=` | Web UI SSE |
| `POST /agent/default/message?chat_jid=` | Web UI 发消息 |
| `GET /timeline?chat_jid=` | Web UI 历史 |
| `GET /` | Web UI（同源静态，`build:web:cloud` 后可用） |
| `GET /agent/branches` | Web UI 分支列表 |
| `POST /agent/root-session` | Web UI 新建 session |
| `GET /terminal/session?chat_jid=` | Terminal 会话信息 |
| `POST /terminal/handoff` | Terminal handoff（cloud no-op） |
| `GET /terminal/ws?chat_jid=` | Terminal WebSocket |

工具调用：LLM 流式 `tool_calls` → bash/read/write/edit（`/workspace` 限制），或 **`coding_agent`** 委派 Sandbox 内 coding worker。

**Mock 仅用于测试**：`mock-tools:` / `mock-coding:` 前缀在 brain 进程设置 `CLOUD_LLM_MOCK=1` 时启用确定性验收响应；未配置 LLM 时不再静默返回 `mock-reply`，而是 `turn_failed` 报错。

| 路径 | 说明 |
|------|------|
| `GET /sessions/:id/subagents` | 列出 `subagent_runs`（PG 状态真相） |

### Subagent（`coding_agent`）测试

主 Agent 通过 `coding_agent` 工具委派；Gateway 阻塞等待 worker，只向主 turn 回传 `{ run_id, status, summary, artifacts }`。Subagent 内部的 bash/read/write **不会**写入主 session messages。

**Worker 模式**（`subagent.codingWorkerMode` in config）：

| 值 | 行为 |
|----|------|
| `auto`（默认） | 有 LLM + sandbox 时用 sandbox worker；缺失时报错（不再 silent mock） |
| `sandbox` | 上传 Python worker 到 microVM；若 microVM 无法直连 LLM，Gateway 自动 fallback 到 Brain 侧 coding loop（工具仍走 Sandbox） |
| `brain` | Brain 侧隔离 tool loop，工具仍走 sandbox |
| `mock` | 纯 mock（需 `CLOUD_LLM_MOCK=1`），无需 sandbox |

**Mock 回归（无需真实 LLM）**：

```bash
cd cloud
CLOUD_LLM_MOCK=1 cd brain && bun run start   # 终端 A
bun test                                     # gateway / sse 单元测试
bun run verify:1b                            # scenario 自启双副本（已内置 CLOUD_LLM_MOCK=1）
```

**手动 API**（brain 已启动）：

```bash
SESSION="test-subagent-$(date +%s)"
curl -X POST http://localhost:7801/sessions -H 'Content-Type: application/json' \
  -d "{\"id\":\"$SESSION\",\"title\":\"subagent-test\"}"
curl -X POST "http://localhost:7801/sessions/$SESSION/messages?wait=1" \
  -H 'Content-Type: application/json' -d '{"content":"mock-tools:coding_agent"}'
curl http://localhost:7801/sessions/$SESSION/subagents
curl http://localhost:7801/sessions/$SESSION/messages
```

**真实 LLM + Sandbox subagent**（需 brain 已启、brain.config.json 已填 LLM + sandbox）：

```bash
# 建议在 brain.config.json 中设置 subagent.codingWorkerMode = "sandbox"
cd cloud && bun run verify:llm-subagent-e2e
```

E2E 前会自动运行 `scripts/cleanup-sandbox-quota.ts` 释放测试 session 占用的 sandbox 配额。

## 验收

```bash
cd cloud
bun run verify:1a   # migrations + typecheck
bun run verify:1b   # 双副本 scenario（无需 sandbox；spawn 内置 CLOUD_LLM_MOCK=1）
# 先 CLOUD_LLM_MOCK=1 bun run start（mock-tools 步骤），或配置 openai 后 bun run start：
bun run verify:1e       # MVP API 联调（mock-tools 步骤需 CLOUD_LLM_MOCK=1）
bun run verify:llm-e2e  # 真实 LLM + Wio 三步（直连工具，非 subagent）
bun run verify:llm-subagent-e2e  # 真实 LLM 委派 coding_agent + sandbox worker
bun run verify:web-e2e  # Web UI 浏览器验收（需 build:web:cloud + Playwright）
```

Web cloud 构建与访问（仓库根目录）：

```bash
bun run build:web:cloud   # 注入 __PICLAW_API_BASE__ → http://localhost:7801
cd cloud/brain && bun run start
open http://localhost:7801/?chat_jid=web:default
```
