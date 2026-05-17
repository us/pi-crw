# pi-crw

`web_search` + `web_scrape` for the [pi](https://github.com/earendil-works/pi)
coding agent, backed by the [crw](https://fastcrw.com) web scraper.

pi has no native web capability — out of the box its agent can only reach the
web by shelling out to `curl`. `pi-crw` registers two first-class tools and
advertises them in the agent's system prompt, so the model reaches for them
instead of curl.

## Install

```bash
npx pi-crw install      # or: bunx pi-crw install
```

That copies the extension into pi's extensions dir
(`~/.pi/agent/extensions/crw.ts`). Open a new pi session and the agent has
`web_search` and `web_scrape`. No config needed.

```bash
pi-crw status           # is it installed? which backend?
pi-crw uninstall        # remove it
```

## Backends (auto-detected, zero-config)

| Environment | Mode | Notes |
|---|---|---|
| `CRW_API_URL` set | HTTP | `POST {url}/v1/scrape` / `/v1/search`. fastcrw.com cloud or a local `crw serve`. Add `CRW_API_KEY` for cloud. |
| _unset_ | CLI | Spawns the `crw` binary (`CRW_BIN`, else `crw` on `PATH`). |

If no backend resolves, the tools are simply **not registered** — pi keeps
working exactly as before. Other tunable: `CRW_TIMEOUT_MS` (default 60000).

> HTTP `web_search` needs the target server to have SearXNG configured.
> fastcrw.com cloud bundles it; a self-hosted `crw serve` needs the SearXNG
> sidecar. The CLI backend works out of the box.

## License & the crw boundary

This package is **MIT**. crw itself is **AGPL-3.0**. `pi-crw` bundles **no crw
source code** — it only invokes a separately distributed crw binary
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
