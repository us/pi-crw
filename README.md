# pi-crw

`web_search`, `web_scrape` and `web_map` for the
[pi](https://github.com/earendil-works/pi) coding agent, backed by the
[crw](https://fastcrw.com) web scraper.

pi has no native web capability. Out of the box its agent can only reach the
web by shelling out to `curl`. `pi-crw` registers three first-class tools and
advertises them in the agent's system prompt, so the model reaches for them
instead of curl.

## Install

```bash
npx github:us/pi-crw install      # or: bunx github:us/pi-crw install
```

That copies the extension into pi's extensions dir
(`~/.pi/agent/extensions/crw.ts`). Open a new pi session and the agent has
`web_search`, `web_scrape` and `web_map`.

```bash
npx github:us/pi-crw status       # is it installed? which backend?
npx github:us/pi-crw uninstall    # remove it
```

> Installed straight from the GitHub repo (no npm registry). For a pinned
> version use `npx github:us/pi-crw#v0.1.0 install`, or clone and run
> `node bin/pi-crw.mjs install`.

## Tools

| Tool | What the agent gets |
|---|---|
| `web_scrape` | One URL as clean markdown (or `html` / `text` / `links` / `json`). `js: true` forces browser rendering for a page that needs it. |
| `web_search` | Ranked live results (title, URL, snippet). `category` narrows to `github`, `research` or `pdf`. |
| `web_map` | The URLs a site exposes (sitemap plus link discovery), so the agent can find the right page instead of guessing paths. |

## Backends (auto-detected, zero-config)

Resolved once at startup, first hit wins:

| Condition | Mode |
|---|---|
| `CRW_API_URL` set | HTTP against that base: your own `crw serve`, or the cloud spelled out explicitly. |
| `CRW_API_KEY` set | HTTP against the managed API (`api.fastcrw.com`). |
| `crw` on `PATH` | CLI. Spawns the binary (`CRW_BIN` overrides which one). |
| none of the above | HTTP against the managed API, keyless. The first call tells you to set `CRW_API_KEY`. |

Defaulting to the managed API means a fresh install always has web access. Get
a key with 1000 free credits, no card, at [fastcrw.com](https://fastcrw.com).

`PI_OFFLINE=1` skips registration entirely, so an air-gapped session is
unaffected. Other tunable: `CRW_TIMEOUT_MS` (default 60000).

> The CLI backend runs everything locally, but its `web_search` needs a search
> sidecar that `crw setup --local` provisions for you. The managed API has one
> already, which is why a key outranks a local binary.

## License & the crw boundary

This package is **MIT**. crw itself is **AGPL-3.0**. `pi-crw` bundles **no crw
source code**. It only invokes a separately distributed crw binary
(subprocess) or a crw HTTP endpoint. The boundary is a stable CLI/HTTP
protocol, never linking or bundling, so the MIT package and AGPL crw stay
cleanly separate.

## Development

```bash
bun install
bun run typecheck
bun run test            # deterministic: mock crw binary + mock HTTP server
```

See `.claude/CLAUDE.md` for the project's conventions and the license rationale.
