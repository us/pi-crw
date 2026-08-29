# pi-crw — project conventions

## What this is

An **MIT** npm package that registers `web_search`, `web_scrape` and `web_map`
tools into the **pi** coding agent (`github.com/earendil-works/pi`), backed by the **crw**
web scraper (`../crw-opencore`, AGPL-3.0). Shipped as a standalone repo so it
can be `npx`-installed by anyone and, later, proposed as pi's default web
provider.

## The license invariant (do not break this)

`src/crw.ts` MUST contain **zero crw source code**. It may only:

- spawn a separately distributed `crw` binary as a subprocess, or
- call a crw HTTP endpoint (`/v1/scrape`, `/v1/search`, `/v1/map`).

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
`tests/run.mjs` (registration, prompt metadata, backend resolution, CLI +
in-process mock HTTP) and `tests/robustness.mjs` (the error/edge paths plus the
wire-format locks: abort identity, timeout, stdout truncation, non-zero exit,
argv passthrough, limit clamp, `{success:false}` envelope, non-2xx, and the
exact JSON keys sent to `/v1/*`). `tests/no-backend-real.mjs` needs a built pi
checkout and is excluded from default `test` (it's in `test:all`).

Every test file clears `CRW_API_URL` / `CRW_API_KEY` / `CRW_BIN` / `PI_OFFLINE`
before it picks a backend. A developer with `CRW_API_KEY` exported would
otherwise land in HTTP mode and silently test the wrong path.

**A green suite is not proof the wire is right.** The M7/M8/M9 bugs below all
passed the old suite, because the mock server accepted whatever was sent. When
you touch a request body, verify against a real crw (`api.fastcrw.com` with a
key, or a local `crw serve`) and read the response back.

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
- **L3** superseded by M8.
- **L4** (this repo only) the personal hardcoded crw build path was removed;
  CLI resolution is `CRW_BIN` → `crw` on `PATH` only.
- **M6** HTTP 401/403 answers with what to actually do (`set CRW_API_KEY`,
  or point `CRW_API_URL` somewhere), because that is the expected first
  response for the keyless cloud default. 402 is deliberately excluded: the
  managed API uses it for exhausted credits and declined cards, so the
  server's own body is the correct copy there.
- **M7** the engine's plain-text field is `plainText`, not `text`, and its CLI
  `-f json` bundle does not carry it at all. `format=text` therefore never
  found anything and silently degraded to markdown. HTTP now requests
  `formats:["plainText"]`; the CLI path asks for `-f text` and takes stdout.
- **M8** JS rendering is `renderJs`, not `js`. The old key was an unknown
  field, so the server ignored it and fell back to auto-detection. Measured
  live: `{js:true}` on example.com came back `renderedWith: http`,
  `{renderJs:true}` came back `renderedWith: lightpanda`.
- **M9** search categories is `categories: [...]`, not `category: "..."`.
  Measured live on `tokio async runtime`: the singular key returned
  tokio.rs/github.com/docs.rs (i.e. a plain web search), the array returned
  three github.com results.
- **M10** the cloud is the fallback backend when nothing else resolves, so a
  fresh install has web access. `PI_OFFLINE=1` is the opt-out.
- **M11** `crw map --limit` is newer than the `map` subcommand, so an older
  binary hard-failed with a clap error. The CLI path retries once without the
  flag; the client-side slice caps the result either way.

## Keeping up with crw

The request bodies here mirror `crw-core`'s `ScrapeRequest` / `SearchRequest` /
`MapRequest` (camelCase, `serde` aliases for snake_case). None of them use
`deny_unknown_fields`, so **a wrong key is not an error, it is silently
ignored**. That is exactly how M7/M8/M9 survived unnoticed across roughly
twenty crw releases. When crw ships a new parameter worth exposing, check the
struct, not the docs.

## Standards

Conventional Commits (release-please owns version + CHANGELOG — never bump or
edit them by hand). `bun` for scripts. MIT headers stay MIT. Don't add AI
attribution to commits/PRs.
