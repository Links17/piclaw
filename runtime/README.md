# runtime/ — Legacy reference (cloud-only)

This directory is the **frozen local/desktop PiClaw implementation**. The product
direction is **cloud-only**; new feature work belongs under `cloud/`.

## Status

- **Do not add features here.** Use `cloud/brain`, `cloud/store`, `cloud/shared`, etc.
- **Web UI** has moved to [`cloud/web/`](../cloud/web/).
- **Agent kernel / pi facade** lives in [`cloud/brain/src/kernel/`](../cloud/brain/src/kernel/).
- This tree remains as a **porting reference** until cloud reaches feature parity, then it will be deleted.

## What to reference when porting

| runtime area | cloud target |
|---|---|
| `src/task-scheduler.ts`, dream, agent-memory | `cloud/scheduler`, new brain modules |
| `src/agent-control/` | `cloud/brain` API + store |
| `src/channels/` (push, etc.) | `cloud/brain` routes |
| `src/addons/` | cloud addon framework (planned) |
| Sandbox/PTY in cloud | already in `cloud/brain/src/sandbox/` — do not re-port |

## Local-only (not ported)

- Electrobun desktop shell (`runtime/desktop`, root `electrobun.config.ts`)
- Local filesystem workspace + FTS
- CDP browser automation (`extensions/browser/`)
- OS keychain / single-instance file IPC
