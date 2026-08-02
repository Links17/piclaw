# piclaw

## Git workflow

- **Always use pull requests** — never commit directly to `main`
- Create a feature branch, commit, push, and open a PR via `gh pr create`
- Wait for the user to approve or say "merge" before merging
- Use `gh pr merge --merge --delete-branch` to merge and clean up
- PR descriptions should include a summary, the change, and test results
- One logical change per PR; don't bundle unrelated work

### Worktrees

- Use `git worktree add` for parallel work instead of switching branches in the main checkout
- After merging a PR, remove the worktree (`git worktree remove <path>`) and confirm cleanup with `git worktree list`
- Before starting new work, run `git worktree list` and prune any stale/orphaned worktrees (`git worktree prune`)
- Never leave merged-branch worktrees lying around

## Build and test

- `bun run typecheck` — type-check the runtime
- `bun run build:web` — build the web frontend
- `bun test <path>` — run tests
- `make ci-fast` — full CI gate

## Agent architecture

PiClaw uses an orchestration-first agent architecture. Keep conversation
reasoning, reliable scheduling, business execution, and execution
infrastructure as separate concerns.

### Main agent

The main agent is the user-facing orchestrator. It should:

- understand intent and distinguish discussion, immediate execution, background
  execution, and scheduled execution
- ask focused clarification questions when required inputs are missing
- select an agent profile or workflow and construct a normalized invocation
- submit work to the common invocation dispatcher
- summarize progress and results for the user

The main agent should not absorb business implementations that need their own
lifecycle, permissions, retries, accounting, or execution context. It may still
answer conceptual questions, discuss designs, summarize results, and handle
trivial self-contained work when delegation would cost more than the work.

### Scheduler

The scheduler is a reliable control plane, not a subagent. It owns:

- persisted `once`, `interval`, and `cron` triggers
- timezone-aware `next_run` calculation
- claims, leases, heartbeats, retries, pause/cancel, and failure recovery
- idempotent dispatch of the invocation attached to a due task
- run status, result metadata, and recurrence calculation

A scheduled task is a trigger plus an invocation template:

```text
ScheduledTask = Trigger + AgentInvocationTemplate
```

The scheduler must not interpret business intent, call an LLM to decide what
the task means, or implement the task itself. When a task becomes due, it
dispatches the stored invocation through the same path used by immediate and
background work.

### Agent runtime and execution backends

A subagent is an independently managed work unit with its own context,
capabilities, lifecycle, permissions, budget, accounting, and result. A
subagent does not imply a sandbox.

Agent profiles declare an execution backend:

- `sandbox` — isolated filesystem, shell, coding, builds, and tests
- `service` — restricted in-process capabilities without a sandbox
- `remote` — MCP, HTTP, or a dedicated external worker
- `workflow` — deterministic business steps with optional agent reasoning at
  defined points

For example, a coding agent normally uses `sandbox`; a research agent can use
`service` or `remote`; notification and maintenance work should usually use a
deterministic `workflow`.

### Unified invocation contract

Immediate, background, and scheduled work must converge on one invocation
dispatcher and one lifecycle model. An invocation should carry, at minimum:

- user and session ownership
- agent profile and task input
- execution backend and run mode
- model, turn, timeout, and token budgets where applicable
- stable operation ID and attempt number
- owner token and generation for fencing

The run modes differ only in admission and delivery:

```text
immediate -> invocation dispatcher
background -> invocation queue -> invocation dispatcher
scheduled -> scheduler -> invocation queue -> invocation dispatcher
```

Token reservation, usage receipts, quota settlement, heartbeat, drain,
cancelation, and recovery should apply consistently across all execution
backends, including agents that do not use a sandbox.

### Extending the system

Do not create a new subagent type for every business request. Choose the
smallest reusable extension point:

- add a **capability/tool** for a new atomic operation
- add an **agent profile** for a distinct reasoning role, capability set,
  permission boundary, or execution policy
- add a **workflow** for a stable, repeatable business process
- add a **scheduled task** when an existing invocation must run later or recur

Prefer composing reusable capabilities into a small set of well-defined agent
profiles. For example, daily and weekly news jobs should normally share a
research agent and differ in their prompt and trigger rather than becoming
separate agent types.

### Scheduling contract

Natural-language time expressions may be interpreted by the main agent, but
they must be normalized and validated before persistence. Store structured
trigger type, value, and IANA timezone; never persist an ambiguous phrase as
the executable schedule.

Timezone precedence is:

1. timezone explicitly supplied in the current request
2. the user's saved IANA timezone
3. clarification through the question flow

Only report that a task was created after persistence succeeds and a real task
ID is returned. Discussion about reminders or scheduling must not create a
task.

## Release process

Releases follow a two-phase tag workflow. **No release ships without passing UX tests.**

### Phase 1 — Prerelease validation

1. Build, run `make ci-fast` (unit + integration tests) locally.
2. Push a prerelease tag: `v<version>-ux` (e.g. `v2.3.0-ux`).
3. This tag triggers the **E2E Tests** workflow (Playwright UX regression suite) on CI.
4. It does **not** trigger Docker builds, the integration gate, or publish workflows.
5. Wait for the E2E workflow to complete. Review the uploaded report artifact.
6. If UX tests fail, fix and re-push the `-ux` tag.

### Phase 2 — Final release

1. Once the `-ux` tag is green, push the final release tag: `v<version>` (e.g. `v2.3.0`).
2. This tag triggers **Integration gate** and **Publish Docker images**, but not the **CI** or **E2E Tests** workflows.
3. The integration gate must pass before Docker images are built.
4. Publish release notes to GitHub Releases.
5. Download the E2E report artifact from the `-ux` workflow run and **attach it as a release asset** (PDF or HTML).

### Tag routing summary

| Tag pattern | CI | Integration gate | E2E (UX) | Docker publish |
|---|---|---|---|---|
| Push to `main` | ✅ | — | — | — |
| `v*-ux` / `v*-prerelease` | — | — | ✅ | — |
| `v*` (no suffix) | — | ✅ | — | ✅ |

### Quick reference

```bash
# Push a UX prerelease tag to trigger E2E tests
git tag -a v2.3.0-ux -m 'UX prerelease' && git push origin v2.3.0-ux

# After E2E passes, push the final release tag
git tag -a v2.3.0 -m 'PiClaw v2.3.0 — Movie Name' && git push origin v2.3.0

# Clean up the prerelease tag
git tag -d v2.3.0-ux && git push origin :refs/tags/v2.3.0-ux
```

### Rules

- Never push a final release tag without a passing `-ux` run first.
- The `-ux` tag can be deleted after the final tag is pushed.
- Use `workflow_dispatch` on the E2E workflow for ad-hoc UX test runs on any branch.

## Conventions

- See `skel/AGENTS.md` for the agent operating context and working style
- For add-on settings panes, prefer the **direct backend add-on config API** (`/agent/addons/api/<addon>/<action>` plus runtime registration via `__piclaw_registerAddonConfigApi`) instead of routing browser settings traffic through slash commands
- Treat slash-command config dispatch as a legacy fallback only; new settings-pane work should register direct handlers in the add-on runtime entry and use browser fetches from the pane
- For web visuals/SVG diagrams, prefer attached `.svg` files (via `attach_file`) over raw SVG markup in message text; use widget/artifact paths only when interactivity is needed
- See `WORKITEMS.md` for the workitem lifecycle
