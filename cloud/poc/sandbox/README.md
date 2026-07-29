# PoC 2 — CubeSandbox execution layer

Validated against `http://192.168.200.127:12088` with template `tpl-474f7cc593f145f0bb4cf232`.

## Run

```bash
export E2B_API_URL=http://192.168.200.127:12088
export CUBE_TEMPLATE_ID=tpl-474f7cc593f145f0bb4cf232
export CUBE_PROXY_NODE_IP=192.168.200.127
export CUBE_OPS_USER=admin
export CUBE_OPS_PASSWORD=admin   # dashboard login; JWT fetched from /opsapi/v1/auth/login

bun install
bun run scenario
```

## Results (2026-07-29)

| Check | Result | Notes |
|-------|--------|-------|
| exec + files | ✅ | `commands.run` native; `files.write` **404 on this build** → shell fallback in `src/fs.ts` |
| PTY create + reattach | ✅ | `pty.create` + `pty.connect(samePid)` |
| pause/resume FS | ✅ | marker file survives |
| pause/resume memory | ✅ | `sleep 300` background PID alive after pause (`kill -0`) |
| artifacts roundtrip | ✅ | archive → kill → new sandbox → restore |
| resume p95 | ✅ 3161ms | budget 5000ms; first resume after cold create ~3–4s, subsequent ~1s |

## CubeSandbox-specific adaptations (`src/`)

- **`auth.ts`** — JWT from `/opsapi/v1/auth/login` (dashboard creds); passed as E2B `accessToken`, not `E2B_API_KEY`
- **`proxy-fetch.ts`** — rewrite `https://{port}-{id}.cube.app` → `http://{CUBE_PROXY_NODE_IP}` with Host header
- **`client.ts`** — REST create (CubeAPI omits `envdVersion` on POST) + manual `new Sandbox(...)` wrapper; `/connect` returns 502 on this build
- **`fs.ts`** — `files.read` works; `files.write` does not → `printf > file` via `commands.run`

## LLM (PoC 1 cache measurement)

For real-provider runs against your NewAPI gateway:

```bash
export POC_OPENAI_BASE_URL=http://192.168.1.190/v1   # confirm path on your gateway
export POC_OPENAI_API_KEY=sk-...
cd ../turn-loop && bun run scenario
```
