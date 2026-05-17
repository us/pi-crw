# pi-crw — project conventions

## What this is

An **MIT** npm package that registers `web_search` + `web_scrape` tools into
the **pi** coding agent (`github.com/earendil-works/pi`), backed by the **crw**
web scraper (`../crw-opencore`, AGPL-3.0). Shipped as a standalone repo so it
can be `npx`-installed by anyone and, later, proposed as pi's default web
provider.

## The license invariant (do not break this)

`src/crw.ts` MUST contain **zero crw source code**. It may only:

- spawn a separately distributed `crw` binary as a subprocess, or
- call a crw HTTP endpoint (`/v1/scrape`, `/v1/search`).

crw is AGPL-3.0; this package is MIT. The arms-length CLI/HTTP protocol is the
deliberate legal boundary that keeps them separate (no linking, no bundling).
Copying crw Rust/logic into this repo, vendoring crw, or adding a hard
build/runtime dependency on crw's package would collapse that boundary. The
`@earendil-works/pi-coding-agent` import is `import type` only (erased at
build) — `types/pi-coding-agent.d.ts` is a local shim so we never depend on
pi's package either.

## Runtime model

pi auto-loads every `*.ts` under `~/.pi/agent/extensions/` via jiti, resolving
`typebox` and the pi types through its own `virtualModules`. So the shipped
artifact is the raw `src/crw.ts` (not compiled); `bin/pi-crw.mjs install`
copies it into that dir. `tsconfig.json` is `noEmit` — it exists only for CI
typechecking in isolation.

## Tests

`bun test` is deterministic and has no network / no real crw dependency:
`tests/run.mjs` (registration, prompt metadata, CLI + in-process mock HTTP) and
`tests/robustness.mjs` (the error/edge paths: abort identity, timeout, stdout
truncation, non-zero exit, `--js` passthrough, limit clamp, HTTP
`format=links`, `{success:false}` envelope, non-2xx). `tests/no-backend-real.mjs`
needs a built pi checkout and is excluded from default `test` (it's in
`test:all`).

## Fix log (load-bearing — keep regression tests green)

- **M1** `runCli` registers child `error`/`close` listeners before any early
  return (a pre-aborted signal must not let a spawn failure become an
  unhandled `error` that crashes the process).
- **M2** abort preserves `error.name === "AbortError"` (CLI + HTTP) via
  `abortError()`.
- **M3** stdout truncation rejects with an actionable error, never resolves
  partial/garbage JSON.
- **M4** HTTP scrape requests the format actually needed (`links` → `["links"]`,
  `json` → `["markdown","links"]`).
- **M5** HTTP 200 with `{success:false}` throws the server's own message.
- **L1** invalid/negative `CRW_TIMEOUT_MS` falls back to 60000.
- **L2** search `limit` is finite and clamped to `MAX_SEARCH_LIMIT` (50);
  `Infinity` → safe default 5.
- **L3** HTTP `js` forwarded best-effort.
- **L4** (this repo only) the personal hardcoded crw build path was removed;
  CLI resolution is `CRW_BIN` → `crw` on `PATH` only.

## Standards

Conventional Commits (release-please owns version + CHANGELOG — never bump or
edit them by hand). `bun` for scripts. MIT headers stay MIT. Don't add AI
attribution to commits/PRs.
