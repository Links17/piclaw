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
| `GET /terminal/ws?chat_jid=` | Terminal WebSocket |

Sandbox 命令：消息以 `bash:` 前缀触发 CubeSandbox exec，例如 `bash:echo hello`。

## 验收

```bash
cd cloud
bun run verify:1a   # migrations + typecheck
bun run verify:1b   # 双副本 scenario（无需 sandbox）
# 先 bun run start，再：
bun run verify:1e   # MVP 联调（需 CubeSandbox）
```

Web cloud 构建（仓库根目录）：

```bash
bun run build:web:cloud   # 注入 __PICLAW_API_BASE__ → http://localhost:7801
```
