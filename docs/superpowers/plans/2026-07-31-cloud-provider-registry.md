# Cloud Provider Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 cloud brain 根据 session 的 `provider/model` 标签解析真实的 OpenAI-compatible endpoint、凭证和模型元数据，同时保留 `runtime/` 不变。

**Architecture:** 新增 cloud 专用 provider registry，集中负责 provider 配置、用户 keychain 凭证解析、模型标签解析和 pi-ai 模型构造。kernel runtime 保留默认 provider；session loop 在每次会话运行前解析有效 provider/model，并把对应的模型传给 pi-ai。

**Tech Stack:** Bun、TypeScript、`@earendil-works/pi-ai`、PostgreSQL keychain store、现有 cloud brain/store monorepo。

## Global Constraints

- `runtime/` 保留，不删除、不迁移其核心实现。
- 不修改 `cloud/brain/src/subagents/`、`kernel/subagent-message-map.ts` 或 sandbox 核心实现。
- 本批仅支持 OpenAI-compatible completions provider；不引入 OAuth、Bedrock 或 provider-specific auth。
- provider 凭证优先使用 cloud 配置/环境变量，用户 keychain 作为覆盖来源。
- 缺少 provider 凭证或 provider 不存在时必须明确报错，不静默回退到默认 provider。
- 本批完成后运行 cloud brain/store typecheck 和 brain tests，并单独提交。

---

### Task 1: Provider registry contract and resolution tests

**Files:**
- Create: `cloud/brain/src/kernel/provider-registry.test.ts`
- Modify: `cloud/brain/src/kernel/provider.ts`
- Modify: `cloud/brain/src/config.ts`

**Interfaces:**
- `ProviderRegistryEntry`: provider id, display name, base URL, API key, model metadata.
- `parseProviderModelLabel(label: string | null | undefined)`.
- `resolveProviderModel(input)`.
- `createProviderRuntime(entry)`.

- [ ] **Step 1: Write failing tests** for provider/model parsing, default provider resolution, explicit provider resolution, and missing credentials.
- [ ] **Step 2: Run `bun test src/kernel/provider-registry.test.ts` and verify the new APIs fail.**
- [ ] **Step 3: Implement the registry types and deterministic pure resolution helpers.**
- [ ] **Step 4: Run the focused test and verify it passes.**
- [ ] **Step 5: Commit the registry contract and tests.**

### Task 2: User keychain credential lookup

**Files:**
- Modify: `cloud/store/src/keychain.ts`
- Modify: `cloud/store/src/index.ts`
- Modify: `cloud/brain/src/kernel/provider-registry.ts`
- Create: `cloud/brain/src/kernel/provider-registry.credentials.test.ts`

**Interfaces:**
- `store.revealKeychainSecret(name, userId, encryptionKey)` remains the only secret reveal primitive.
- Registry lookup uses `provider:<providerId>:api_key` and `provider:<providerId>:base_url`.

- [ ] **Step 1: Add focused tests for keychain override precedence and absent credentials.**
- [ ] **Step 2: Run the focused tests and verify they fail before lookup wiring.**
- [ ] **Step 3: Implement user-scoped credential lookup without exposing secrets in responses or logs.**
- [ ] **Step 4: Run the focused tests and verify they pass.**
- [ ] **Step 5: Commit the credential resolution batch.**

### Task 3: Runtime and session-loop integration

**Files:**
- Modify: `cloud/brain/src/kernel/runtime.ts`
- Modify: `cloud/brain/src/kernel/resolve-model.ts`
- Modify: `cloud/brain/src/kernel/loop.ts`
- Modify: `cloud/brain/src/kernel/run-session-loop.ts`
- Modify: `cloud/brain/src/turn.ts`
- Modify: `cloud/brain/src/models/service.ts`

- [ ] **Step 1: Add failing integration tests for selecting `provider/model` and logging the effective model.**
- [ ] **Step 2: Run focused tests and verify the existing single-provider behavior fails the new expectations.**
- [ ] **Step 3: Build the effective provider runtime per session and pass its model/runtime credentials to the loop.**
- [ ] **Step 4: Update model discovery and diagnostics to expose configured provider/model metadata without secrets.**
- [ ] **Step 5: Run focused tests and typecheck.**
- [ ] **Step 6: Commit the integration batch.**

### Task 4: Full verification

- [ ] **Step 1:** Run `bun run typecheck` in `cloud/store`.
- [ ] **Step 2:** Run `bun run typecheck` in `cloud/brain`.
- [ ] **Step 3:** Run `bun test` in `cloud/brain`.
- [ ] **Step 4:** Run `ReadLints` on all modified TypeScript files.
- [ ] **Step 5:** Inspect `git diff` and verify `runtime/`, `.codegraph/`, `.cursor/`, and `generated/` are not included.
- [ ] **Step 6:** Create the final provider-registry commit only after verification.
