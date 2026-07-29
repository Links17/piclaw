# Serverless 云端版 — 分阶段执行路线图

状态：阶段 1 MVP 已验证（2026-07-29）
依据：[implementation-plan.md](implementation-plan.md) · [serverless-design.md](serverless-design.md)

## 总览

```mermaid
flowchart LR
  P0[阶段0 PoC] --> P1a[1a 基础]
  P1a --> P1b[1b Brain]
  P1b --> P1c[1c Sandbox]
  P1c --> P1d[1d Web]
  P1d --> P1e[1e 联调]
  P1e --> P2[阶段2 多用户]
  P2 --> P3[阶段3 生产化]
```

| 阶段 | 分支/PR | 验收 |
|------|---------|------|
| **0** PoC | （本地，未合 main） | turn-loop + sandbox scenario 全绿 ✅ |
| **1a–1e** MVP | `cloud/phase-1-foundation` | 全部验收通过 ✅ |
| **2** 多用户 | 多个 PR | OAuth、RLS、scheduler、配额 |
| **3** 生产化 | 多个 PR | 计费、可观测、压测、安全 |

---

## 阶段 0 — 已完成 ✅

- [x] PoC 1 `cloud/poc/turn-loop`：PG advisory lock、Redis SSE、inflight 恢复
- [x] PoC 2 `cloud/poc/sandbox`：CubeSandbox exec/PTY/pause/artifacts

实测备注见各 PoC README（`files.write` fallback、JWT 认证、resume p95 ~3s 等）。

---

## 阶段 1 — MVP（已完成 ✅）

| 子阶段 | 状态 | 验收命令 |
|--------|------|----------|
| **1a** 基础 | ✅ | `cd cloud && bun run verify:1a` |
| **1b** Brain | ✅ | `cd cloud && bun run verify:1b` |
| **1c** Sandbox | ✅ | 含于 `verify:1e`（`bash:` + PTY WS） |
| **1d** Web | ✅ | `bun run build:web:cloud`（`__PICLAW_API_BASE__` → brain） |
| **1e** 联调 | ✅ | 先 `cd cloud/brain && bun run start`，再 `cd cloud && bun run verify:1e` |

**1e 清单**（implementation-plan §1.8）：

- [x] 创建 session（timeline bootstrap）
- [x] 对话 + 流式（Web SSE `agent_*` 词表）
- [x] 跑代码（`bash:` → CubeSandbox）
- [x] 开 terminal + 断线重连（`/terminal/ws` + timeline catch-up）
- [x] follow-up 排队

---

## 阶段 1a — 基础（已完成 ✅）

**目标**：可复用的 schema、store、shared 事件词表；PoC 代码不删，brain 从 package 引用 store。

交付物：

1. `cloud/package.json` — bun workspace
2. `cloud/migrations/001_core.sql` — MVP 表 + RLS 骨架
3. `cloud/shared/` — SSE 事件类型（与 `runtime/web` 词表对齐）
4. `cloud/store/` — 自 PoC 提升的 PG 访问层（session_cursors 状态机）

验收：

```bash
cd cloud && bun install
bun run --filter @piclaw-cloud/store typecheck   # 待接根 typecheck
psql $POC_PG_URL -f migrations/001_core.sql
```

---

## 阶段 1b — Brain 服务

**目标**：无状态 brain 替代 PoC HTTP 壳；SSE 发 Web 兼容事件名。

1. `cloud/brain/` ← 合并 `poc/turn-loop` 逻辑
2. `events/` 发布 `agent_*` 词表（见 `shared/sse-events.ts`）
3. 路由：`POST /sessions`、`POST .../messages`、`GET .../stream`
4. 双副本 scenario 迁移到 `cloud/brain/scripts/`

依赖：1a store + shared

---

## 阶段 1c — Sandbox 层

**目标**：session 绑定 sandbox_id；工具调用进 CubeSandbox。

1. `cloud/brain/sandbox/` ← 合并 `poc/sandbox`（auth、proxy-fetch、fs fallback）
2. sessions 表 `sandbox_id` 惰性创建/恢复
3. turn 内 bash/edit 路由（首版：exec + 文件 shell fallback）

依赖：1b turn 执行器钩子

---

## 阶段 1d — Web cloud target

**目标**：现有 Preact UI 连 brain，单用户免登录。

1. `runtime/web`：`VITE_API_BASE` / cloud 构建脚本
2. `chat_jid` → `session_id` 映射层（API adapter）
3. Terminal：PTY WebSocket 代理（或直连 sandbox，视网络）

依赖：1b API 契约稳定

---

## 阶段 1e — MVP 联调

**清单**（implementation-plan §1.8）— 已由 `cloud/brain/scripts/e2e-scenario.ts` 自动化：

- [x] 创建 session
- [x] 对话 + 流式
- [x] 跑代码（sandbox）
- [x] 开 terminal + 断线重连
- [x] follow-up 排队 / steering

---

## 阶段 2 / 3 — 概要

见 [implementation-plan.md](implementation-plan.md) §阶段 2、§阶段 3。1e 绿后再开 `cloud/phase-2-*` worktree。

## 环境与密钥

| 变量 | 用途 |
|------|------|
| `POC_PG_URL` | Postgres（本地 docker 25432 / `piclaw_cloud_poc`） |
| `POC_REDIS_URL` | Redis db 5 @ 26379 |
| `E2B_API_URL` / `CUBE_*` | CubeSandbox @ 192.168.200.127:12088 |
| `POC_OPENAI_*` | NewAPI @ 192.168.1.190（cache 实测） |
