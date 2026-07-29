# @piclaw-cloud/brain

无状态 Brain 服务：turn 执行、Redis→SSE（Web `agent_*` 词表）、CubeSandbox 工具路由、Web UI 兼容 API。

## 启动

```bash
cd cloud && bun install
export POC_PG_URL=postgres://sensecraft:sensecraft@localhost:25432/piclaw_cloud_poc
export POC_REDIS_URL=redis://localhost:26379/5
# 可选：CubeSandbox
export E2B_API_URL=http://192.168.200.127:12088
export CUBE_TEMPLATE_ID=tpl-474f7cc593f145f0bb4cf232
export CUBE_PROXY_NODE_IP=192.168.200.127

cd brain && bun run start
```

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

工具调用：LLM 流式 `tool_calls` → bash/read/write/edit（`/workspace` 限制），或 **`coding_agent`** 委派 Sandbox 内 coding worker。`mock-tools:` / `mock-coding:` 前缀用于确定性验收。

| 路径 | 说明 |
|------|------|
| `GET /sessions/:id/subagents` | 列出 `subagent_runs`（PG 状态真相） |

### Subagent（`coding_agent`）测试

主 Agent 通过 `coding_agent` 工具委派；Gateway 阻塞等待 worker，只向主 turn 回传 `{ run_id, status, summary, artifacts }`。Subagent 内部的 bash/read/write **不会**写入主 session messages。

**Worker 模式**（`CLOUD_CODING_WORKER_MODE`）：

| 值 | 行为 |
|----|------|
| `auto`（默认） | 有 LLM + sandbox 时用 sandbox worker，否则 mock |
| `sandbox` | 上传 Python worker 到 microVM；若 microVM 无法直连 LLM，Gateway 自动 fallback 到 Brain 侧 coding loop（工具仍走 Sandbox） |
| `brain` | Brain 侧隔离 tool loop，工具仍走 sandbox |
| `mock` | 纯 mock，无需 sandbox |

**Mock 回归（无需真实 LLM）**：

```bash
cd cloud
bun test                                    # gateway / sse 单元测试
bun run verify:1b                           # scenario 步骤 [5] mock-tools:coding_agent
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

**真实 LLM + Sandbox subagent**（需 brain 已启、LLM 凭证、CubeSandbox）：

```bash
export CLOUD_CODING_WORKER_MODE=sandbox
export POC_OPENAI_BASE_URL=http://192.168.1.190/v1
export POC_OPENAI_API_KEY=sk-...
cd cloud && bun run verify:llm-subagent-e2e
```

E2E 前会自动运行 `scripts/cleanup-sandbox-quota.ts` 释放测试 session 占用的 sandbox 配额。

## 验收

```bash
cd cloud
bun run verify:1a   # migrations + typecheck
bun run verify:1b   # 双副本 scenario（无需 sandbox）
# 先 bun run start，再：
bun run verify:1e       # MVP API 联调（需 CubeSandbox）
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
