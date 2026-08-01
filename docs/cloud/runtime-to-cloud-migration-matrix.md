# Runtime → Cloud 迁移矩阵

状态值：

- `not-started`：尚未实现
- `scaffolded`：已有设计或骨架
- `implemented`：主路径已实现并有局部测试
- `verified`：有与风险匹配的自动化验收证据
- `production-ready`：已验证，并完成观测、容量、恢复和运维要求
- `intentionally-not-migrated`：依据 Cloud 设计明确不迁移

“完全迁移”只允许在对应能力达到 `verified`，且没有未记录的语义降级时宣称。

| ID | 功能域 | 用户可验收行为 | Runtime 基线 | Cloud 实现 | 数据/隔离 | 验收证据 | 状态 | 风险/差异 |
|---|---|---|---|---|---|---|---|---|
| SESSION-CRUD | session | 创建、查看、重命名和删除会话 | `runtime/src/db`、Web session API | `cloud/store/src/index.ts`、`cloud/brain/src/web-adapter.ts` | PG `sessions`，`user_id` | `real-lifecycle-e2e.ts`（真实 Cube Sandbox/Volume 删除后才删除 Session，2026-08-01） | verified | 不提供 archive/restore |
| TURN-STREAM | turn/SSE | 消息持久化、流式回复、刷新后恢复 | `docs/runtime-flows.md` | `cloud/brain/src/turn.ts`、`events.ts`、`server.ts` | PG + Redis | `side-prompt-e2e.ts`、`real-steer-e2e.ts`（真实 LLM / PG / Redis，2026-08-01） | verified | 生产多副本压测仍属 production-ready |
| TURN-RECOVERY | recovery | 执行副本中断后可恢复，消息不重复 | `cloud/poc/turn-loop` 对应 runtime cursor 语义 | `cloud/brain/src/turn.ts`、recovery sweep、`kernel/history-bound.ts` | PG cursor + advisory lock | `real-recovery-e2e.ts`（双 Brain 真实 LLM：A 中断 → B `agent_recovery` retry → 一条 recovery assistant + follow-up 只消费一次，2026-08-01） | verified | turn hydrate 以 `throughMessageId` 隔离未处理 follow-up |
| FOLLOWUP | queue | turn 执行中追加消息并按顺序处理 | `docs/runtime-flows.md` | `cloud/store/src/index.ts`、`turn.ts` | PG cursor/queue | `real-steer-e2e.ts` + `real-recovery-e2e.ts`（真实 LLM streaming/queue-steer 与崩溃后一次消费，2026-08-01） | verified | — |
| WORKSPACE-TOOLS | sandbox | LLM 在真实 Sandbox 创建并编辑文件 | runtime tool routes | `cloud/brain/src/tools`、`sandbox/session.ts` | CubeAPI `:13000`、volume | `llm-subagent-e2e.ts`（外部真实 LLM、Sandbox worker、同一 Volume 文件创建/二次编辑，2026-08-01） | verified | Volume 仅用于 Sandbox 工作区；不使用 artifact 兜底 |
| SUBAGENT | agent | 主 Agent 委派子代理，子代理在同 Sandbox 产出并编辑文件 | runtime agent pool | `cloud/brain/src/subagents` | PG runs + Sandbox | `llm-subagent-e2e.ts`（外部真实 LLM、两次 `coding_agent` 委派、PG run 记录及 Volume 文件落盘，2026-08-01） | verified | 真实 Sandbox worker 已可访问外部 LLM |
| TERMINAL | terminal | 创建 terminal，页面断开后恢复同一 PTY | runtime terminal pane / PTY | `cloud/brain/src/server.ts`、`006_terminal_sessions.sql` | session `terminal_pid` | `terminal-reconnect-e2e.ts` 真实 Cube：断连复用 PID、stale PID recovery 通过（2026-08-01） | implemented | **明确延期**：pause 后 Cube 控制面 PTY resume 未通过，不阻塞非 Terminal Agent Core |
| PAUSE-RESUME | lifecycle | 空闲 Sandbox pause，后续工具/terminal resume，文件由同一 volume 保留 | `cloud/poc/sandbox` | `cloud/scheduler/src/main.ts`、`sandbox/session.ts` | PG paused marker + CubeAPI + `workspace_volume_id` | `real-lifecycle-e2e.ts`（真实 marker 跨 pause/resume，2026-08-01） | verified | terminal PTY resume 仍延期；workspace volume 路径已 verified |
| SCHEDULER | scheduled tasks | due task 只执行一次并记录 run | runtime scheduled tasks | `cloud/scheduler`、`cloud/store/src/scheduler.ts` | PG task/run log；lease/`FOR UPDATE SKIP LOCKED` claim | `real-automation-e2e.ts`（真实 PG claim、Brain internal execute、run log，2026-08-01） | verified | 真正多进程压测与生产观测仍属 production-ready 门槛 |
| AUTH-RLS | security | 用户只能访问自己的 session、消息、SSE、terminal 和 runs | runtime auth boundary | `cloud/brain/src/auth.ts`、`007_enforce_user_rls.sql` | API key + PG RLS | `user-isolation-e2e.ts`（真实双用户/API key，2026-08-01） | verified | 当前连接角色可绕过 RLS；request-scoped DB 身份仍需生产架构验证 |
| MODEL-PROVIDERS | model | 用户模型配置可解析并选择 provider | runtime model registry | `cloud/brain/src/models`、`kernel/provider-registry.ts` | PG settings/keychain | `provider-routing-e2e.ts`（本地 OpenAI-compatible 双 provider）+ `make ci-fast`（2026-07-31） | verified | 真实第三方 provider 可靠性属于生产验收 |
| MEDIA | storage | 媒体可上传、访问并按生命周期管理 | runtime media | Cloud media routes + local ObjectStorage | PG 仅存 metadata/object key，二进制在 DB 外 | `real-lifecycle-e2e.ts`（真实上传、object key、`media` 无 binary column，2026-08-01） | verified | 暂不接 COS；本地 ObjectStorage 目录需挂载持久化卷 |
| QUOTA-USAGE | limits | Sandbox/token 超限有明确拒绝 | runtime usage | `cloud/store/src/quota.ts`、Brain quota、side-prompt 429 | PG usage | `real-quota-e2e.ts`（真实 LLM 写入 `user_daily_usage`，并发 turn + side-prompt HTTP 429，2026-08-01）+ `quota.test.ts` 并发 sandbox reservation | verified | 计费聚合未迁移；生产容量观测仍属 production-ready |
| REMOTE-INTEROP | runtime-only | 跨实例远程互操作 | runtime channel integrations | 不纳入 Cloud MVP | — | 设计明确延期 | intentionally-not-migrated | 需产品文档保持一致 |
| INSTANCE-AUTH | runtime-only | 自托管实例 TOTP/passkey | runtime auth | 不纳入 Cloud MVP，改用 Cloud identity | — | 设计明确延期 | intentionally-not-migrated | OAuth/SSO 属于阶段 2 |
| WORKSPACE-FTS | search | 工作区全文搜索 | runtime local index | 不纳入当前 Cloud 迁移 | — | 设计明确延期 | intentionally-not-migrated | 需标注能力差异 |

## 更新规则

每个改变 runtime/cloud 用户行为的 PR 必须更新对应行的实现、验收证据、状态和核验日期。没有真实测试输出的能力不得标记为 `verified`。

## 2026-08-01 MVP 判定

当前 Cloud MVP 采用 CubeSandbox Volume-only workspace、local ObjectStorage-only media、无 Session archive/restore、无 workspace artifact 兜底。

**非 Terminal Agent Core 真实验收已通过**（报告位于 `generated/real-acceptance/` 与各脚本 stdout）：

- Side Prompt / steer / follow-up
- 真实 `coding_agent` Sandbox worker + Volume 落盘
- 双 Brain 真实 LLM 故障接管（`real-recovery-e2e.ts`）
- 真实 daily token 耗尽与并发 429（`real-quota-e2e.ts`）
- autoresearch / internal scheduler / Dream
- Volume 生命周期、资源删除、媒体铁律、双用户隔离

**明确延期**：Terminal pause/resume（CubeSandbox 控制面 PTY）。因此可宣称非 Terminal 阶段 0–2 Agent Core 已 `verified`，但仍不宣称 production-ready，也不宣称含 Terminal 的完整 Cloud MVP 已完全验收。
