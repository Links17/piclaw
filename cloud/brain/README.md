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

工具调用：LLM 流式 `tool_calls` → bash/read/write/edit（`/workspace` 限制）。`mock-tools:` 前缀用于确定性验收。

## 验收

```bash
cd cloud
bun run verify:1a   # migrations + typecheck
bun run verify:1b   # 双副本 scenario（无需 sandbox）
# 先 bun run start，再：
bun run verify:1e       # MVP API 联调（需 CubeSandbox）
bun run verify:llm-e2e  # 真实 LLM + Wio 三步
bun run verify:web-e2e  # Web UI 浏览器验收（需 build:web:cloud + Playwright）
```

Web cloud 构建与访问（仓库根目录）：

```bash
bun run build:web:cloud   # 注入 __PICLAW_API_BASE__ → http://localhost:7801
cd cloud/brain && bun run start
open http://localhost:7801/?chat_jid=web:default
```
