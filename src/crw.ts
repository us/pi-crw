/**
 * crw web tools extension for pi
 *
 * Gives the pi coding agent first-class `web_search`, `web_scrape` and
 * `web_map` tools backed by the crw web scraper. pi has no native web
 * capability, so without this the agent can only reach the web by shelling out
 * via curl.
 *
 * This file contains NO crw source code. It only invokes a separately
 * distributed crw binary (subprocess) or a crw HTTP endpoint. That arms-length
 * boundary is deliberate: crw is AGPL-3.0, this extension is MIT, and they are
 * never linked or bundled — only spoken to over a stable CLI/HTTP protocol.
 *
 * Backend is selected from the environment, first hit wins:
 *   1. CRW_API_URL set   -> HTTP against that base (self-hosted `crw serve`,
 *                           or the cloud spelled out explicitly).
 *   2. CRW_API_KEY set   -> HTTP against the cloud (api.fastcrw.com). A key
 *                           with no URL can only mean the managed API, and the
 *                           cloud is strictly more capable than a bare local
 *                           binary (its search backend is already provisioned).
 *   3. `crw` on PATH     -> CLI mode (CRW_BIN overrides the binary).
 *   4. nothing local     -> HTTP against the cloud anyway, keyless. The tools
 *                           still register and the first call returns an
 *                           actionable "set CRW_API_KEY" message, which beats
 *                           an agent that silently has no web access.
 *
 * PI_OFFLINE disables the extension entirely (mirrors pi's own fd/rg
 * convention), so an air-gapped session registers nothing.
 *
 * Tunables: CRW_TIMEOUT_MS (default 60000), CRW_BIN, CRW_API_URL, CRW_API_KEY.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Managed crw API. Matches the official SDKs' `CLOUD_API_URL`. */
const CLOUD_API_URL = "https://api.fastcrw.com";
const SIGNUP_HINT =
	"set CRW_API_KEY (free key, 1000 credits, no card: https://fastcrw.com) " +
	"or point CRW_API_URL at your own `crw serve`";

const TIMEOUT_MS = (() => {
	// L1: a negative/NaN CRW_TIMEOUT_MS must not bypass the default (a value
	// like -5 is truthy and would make setTimeout fire immediately).
	const n = Number(process.env.CRW_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? n : 60_000;
})();
const MAX_STDOUT_BYTES = 5 * 1024 * 1024; // 5 MB cap, then truncate
const MAX_SEARCH_LIMIT = 50; // L2: clamp so limit=Infinity can't reach the backend
const MAX_MAP_LIMIT = 5000; // a coding agent reads a list, it does not dump a sitemap

/** A cancellation error that preserves abort identity for callers (M2). */
function abortError(): Error {
	const e = new Error("crw aborted");
	e.name = "AbortError";
	return e;
}

type Backend = { kind: "http"; url: string; key?: string } | { kind: "cli"; bin: string };

/** Resolve the crw backend once, synchronously, at load time. */
function resolveBackend(): Backend | null {
	if (process.env.PI_OFFLINE) return null;

	const key = process.env.CRW_API_KEY?.trim() || undefined;
	const apiUrl = process.env.CRW_API_URL?.trim();
	if (apiUrl) return { kind: "http", url: apiUrl.replace(/\/+$/, ""), key };
	if (key) return { kind: "http", url: CLOUD_API_URL, key };

	const candidates = [process.env.CRW_BIN?.trim(), "crw"].filter((c): c is string => !!c && c.length > 0);
	for (const bin of candidates) {
		// Absolute path: just check existence. Bare name: probe PATH.
		if (bin.includes("/")) {
			if (existsSync(bin)) return { kind: "cli", bin };
			continue;
		}
		const probe = spawnSync(bin, ["--version"], { stdio: "ignore" });
		if (!probe.error && probe.status === 0) return { kind: "cli", bin };
	}

	// No key, no binary: default to the cloud rather than leaving pi web-less.
	return { kind: "http", url: CLOUD_API_URL };
}

/** Spawn the crw binary, honoring the abort signal, timeout, and a stdout cap. */
function runCli(bin: string, args: string[], signal: AbortSignal | undefined): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let stdoutBytes = 0;
		let truncated = false;
		let stderr = "";
		let settled = false;

		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => {
			child.kill("SIGKILL");
			finish(() => reject(abortError()));
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => reject(new Error(`crw timed out after ${TIMEOUT_MS}ms`)));
		}, TIMEOUT_MS);

		// M1: register the child listeners BEFORE any early return. If the
		// signal is already aborted we call onAbort() below, which kills the
		// child; a failed spawn then emits an 'error' event, and a child with
		// no 'error' listener throws an unhandled exception that crashes the
		// process. The `finish` guard makes the extra listeners harmless.
		child.on("error", (e: Error) => finish(() => reject(new Error(`crw spawn failed: ${e.message}`))));
		child.on("close", (code) => {
			finish(() => {
				// M3: a truncated stream is incomplete JSON. Resolving it would
				// surface as a confusing downstream parse error (or, worse,
				// silently parse to garbage). Fail loud and actionable instead.
				if (truncated) {
					return reject(
						new Error(`crw output exceeded ${MAX_STDOUT_BYTES} bytes and was truncated; narrow the request`),
					);
				}
				if (code === 0) return resolve(Buffer.concat(chunks).toString("utf8"));
				reject(new Error(`crw exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
			});
		});
		child.stdout.on("data", (d: Buffer) => {
			if (truncated) return;
			stdoutBytes += d.length;
			if (stdoutBytes > MAX_STDOUT_BYTES) {
				truncated = true;
				child.kill("SIGKILL");
			} else {
				chunks.push(d);
			}
		});
		child.stderr.on("data", (d: Buffer) => {
			if (stderr.length < 4096) stderr += d.toString();
		});

		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort);
	});
}

/** HTTP backend call. Never echoes the API key into errors. */
async function httpCall(
	backend: { url: string; key?: string },
	path: string,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	let res: Response;
	try {
		res = await fetch(`${backend.url}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(backend.key ? { authorization: `Bearer ${backend.key}` } : {}),
			},
			body: JSON.stringify(body),
			signal,
		});
	} catch (e) {
		// M2: a fetch abort surfaces as a DOMException named "AbortError".
		// Wrapping it into a generic Error loses that identity, so callers can
		// no longer tell a user cancellation apart from a real failure.
		if (signal?.aborted || (e as Error)?.name === "AbortError") throw abortError();
		throw new Error(`crw request to ${backend.url}${path} failed: ${(e as Error).message}`);
	}
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		// M6: an auth rejection is the one failure the user can fix from the
		// shell, and it is the expected first response for the keyless cloud
		// default. Say what to do instead of leaking a bare status. 402 is
		// deliberately NOT here: the managed API uses it for exhausted credits
		// and declined cards, whose own body already carries the right copy,
		// and "set CRW_API_KEY" would be wrong advice for a caller who has one.
		if (res.status === 401 || res.status === 403) {
			throw new Error(`crw ${path} -> HTTP ${res.status}: ${SIGNUP_HINT}${text ? ` (${text.slice(0, 200)})` : ""}`);
		}
		throw new Error(`crw ${path} -> HTTP ${res.status}${text ? `: ${text.slice(0, 500)}` : ""}`);
	}
	let json: unknown;
	try {
		json = await res.json();
	} catch (e) {
		throw new Error(`crw ${path}: response was not valid JSON: ${(e as Error).message}`);
	}
	// M5: crw answers HTTP 200 with { success: false, error } when the page
	// itself failed (anti-bot wall, upstream error page). Without this the
	// error is silently dropped and the caller only sees an empty result.
	if (json && typeof json === "object" && !Array.isArray(json)) {
		const j = json as Record<string, unknown>;
		if (j.success === false) {
			const msg =
				typeof j.error === "string"
					? j.error
					: typeof j.details === "string"
						? j.details
						: JSON.stringify(j).slice(0, 500);
			throw new Error(`crw ${path} -> server reported failure: ${msg}`);
		}
	}
	return json;
}

interface ScrapeNorm {
	markdown?: string;
	html?: string;
	text?: string;
	links?: string[];
	metadata?: Record<string, unknown>;
	creditCost?: number;
}

/** CLI scrape returns a flat object; HTTP wraps it as { success, data }. */
function normalizeScrape(raw: unknown): ScrapeNorm {
	const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const d = (obj.data && typeof obj.data === "object" ? obj.data : obj) as Record<string, unknown>;
	// M7: the engine's plain-text field is `plainText` (ScrapeData.plain_text).
	// Reading only `text` meant `format=text` never found anything and always
	// fell through to markdown. `text` stays in the chain for older servers.
	const plain = typeof d.plainText === "string" ? d.plainText : typeof d.text === "string" ? d.text : undefined;
	return {
		markdown: typeof d.markdown === "string" ? d.markdown : undefined,
		html: typeof d.html === "string" ? d.html : undefined,
		text: plain,
		links: Array.isArray(d.links) ? (d.links as string[]) : undefined,
		metadata: d.metadata && typeof d.metadata === "object" ? (d.metadata as Record<string, unknown>) : undefined,
		creditCost: typeof d.creditCost === "number" ? d.creditCost : undefined,
	};
}

interface SearchHit {
	url: string;
	title?: string;
	description?: string;
	position?: number;
}

/** CLI search returns an array; HTTP wraps it as { success, data: [...] }. */
function normalizeSearch(raw: unknown): SearchHit[] {
	const arr = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).data)
			? ((raw as Record<string, unknown>).data as unknown[])
			: [];
	return arr
		.filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
		.map((h) => ({
			url: String(h.url ?? ""),
			title: typeof h.title === "string" ? h.title : undefined,
			description:
				typeof h.description === "string"
					? h.description
					: typeof h.snippet === "string"
						? h.snippet
						: undefined,
			position: typeof h.position === "number" ? h.position : undefined,
		}))
		.filter((h) => h.url.length > 0);
}

/** HTTP map wraps links in { success, data: { links } }; the CLI puts them at the top level. */
function normalizeMap(raw: unknown): string[] {
	const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const d = (obj.data && typeof obj.data === "object" ? obj.data : obj) as Record<string, unknown>;
	return Array.isArray(d.links) ? d.links.filter((l): l is string => typeof l === "string") : [];
}

function parseJson(text: string, what: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`crw ${what}: could not parse JSON output`);
	}
}

/** Finite, positive, clamped. Guards against limit=Infinity reaching a backend (L2). */
function clampLimit(raw: unknown, fallback: number, max: number): number {
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

const SCRAPE_FORMATS = ["markdown", "html", "text", "links", "json"] as const;

export default function crwExtension(pi: ExtensionAPI) {
	const backend = resolveBackend();
	if (!backend) {
		// PI_OFFLINE: stay invisible so the agent is unaffected.
		console.error("[crw] PI_OFFLINE is set; web tools disabled");
		return;
	}

	pi.registerTool({
		name: "web_scrape",
		label: "Web Scrape",
		description:
			"Fetch a single URL and return its main content as clean markdown (or html/text/links/json). Use this instead of curl to read web pages.",
		promptSnippet: "Fetch a URL and read it as clean markdown",
		promptGuidelines: ["Use web_scrape instead of curl/wget when you need to read the content of a web page."],
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL to fetch" }),
			format: Type.Optional(
				Type.Union(
					SCRAPE_FORMATS.map((f) => Type.Literal(f)),
					{ description: "Output format (default: markdown)" },
				),
			),
			js: Type.Optional(Type.Boolean({ description: "Enable JavaScript rendering for dynamic pages" })),
		}),
		executionMode: "parallel",
		async execute(_id, params, signal) {
			const format = (params.format ?? "markdown") as (typeof SCRAPE_FORMATS)[number];
			let norm: ScrapeNorm;
			if (backend.kind === "http") {
				// M4: ask the server for the format we actually need. Requesting
				// "markdown" for `links` left norm.links empty and made
				// `format=links` throw. `json` here is this tool's own bundle
				// (content + links), not the engine's LLM-extraction `json`
				// format, which needs a jsonSchema we do not take.
				const fmtMap: Record<string, string[]> = {
					markdown: ["markdown"],
					html: ["html"],
					text: ["plainText"],
					links: ["links"],
					json: ["markdown", "links"],
				};
				const body: Record<string, unknown> = {
					url: params.url,
					formats: fmtMap[format] ?? ["markdown"],
				};
				// M8: the engine's field is `renderJs` (null = auto-detect).
				// It was sent as `js`, which the engine does not read, so JS
				// rendering was a silent no-op on the HTTP backend while the
				// CLI backend honored the same parameter.
				if (params.js) body.renderJs = true;
				const raw = await httpCall(backend, "/v1/scrape", body, signal);
				norm = normalizeScrape(raw);
			} else if (format === "text") {
				// The CLI's `-f json` bundle carries markdown/html/links but no
				// plain text, so ask for it directly and take stdout verbatim.
				const args = ["scrape", params.url, "-f", "text"];
				if (params.js) args.push("--js");
				norm = { text: await runCli(backend.bin, args, signal) };
			} else {
				const args = ["scrape", params.url, "-f", "json"];
				if (params.js) args.push("--js");
				norm = normalizeScrape(parseJson(await runCli(backend.bin, args, signal), "web_scrape"));
			}

			let text: string;
			if (format === "json") text = JSON.stringify(norm, null, 2);
			else if (format === "html") text = norm.html ?? norm.markdown ?? "";
			else if (format === "text") text = norm.text ?? norm.markdown ?? "";
			else if (format === "links") text = (norm.links ?? []).join("\n");
			else text = norm.markdown ?? norm.text ?? JSON.stringify(norm, null, 2);

			if (!text) throw new Error(`crw web_scrape: empty ${format} for ${params.url}`);
			return { content: [{ type: "text", text }], details: norm };
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the live web and return ranked results (title, URL, snippet). Use this instead of guessing URLs or shelling out to curl for current information.",
		promptSnippet: "Search the live web for current information",
		promptGuidelines: ["Prefer web_search over bash+curl when you need current or external information."],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
			category: Type.Optional(
				Type.String({
					description:
						"Narrow the search: 'github' for repos and code, 'research' for papers, 'pdf' for documents. Omit for a general web search.",
				}),
			),
		}),
		executionMode: "parallel",
		async execute(_id, params, signal) {
			const limit = clampLimit(params.limit, 5, MAX_SEARCH_LIMIT);
			let hits: SearchHit[];
			if (backend.kind === "http") {
				const body: Record<string, unknown> = { query: params.query, limit };
				// M9: the engine takes `categories` as a list. The singular
				// string was an unknown field, so every category request
				// silently ran as a plain web search. The CLI does the same
				// wrapping internally for its own --category flag.
				if (params.category) body.categories = [params.category];
				hits = normalizeSearch(await httpCall(backend, "/v1/search", body, signal));
			} else {
				const args = ["search", params.query, "-l", String(limit), "-f", "json"];
				if (params.category) args.push("--category", params.category);
				hits = normalizeSearch(parseJson(await runCli(backend.bin, args, signal), "web_search"));
			}

			if (hits.length === 0) {
				return {
					content: [{ type: "text", text: `No results for: ${params.query}` }],
					details: { query: params.query, hits },
				};
			}
			const text = hits
				.slice(0, limit)
				.map((h, i) => `${i + 1}. ${h.title ?? h.url}\n   ${h.url}${h.description ? `\n   ${h.description}` : ""}`)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: { query: params.query, hits } };
		},
	});

	pi.registerTool({
		name: "web_map",
		label: "Web Map",
		description:
			"List the URLs of a website (sitemap plus link discovery). Use it to find the page you actually need before scraping, instead of guessing paths.",
		promptSnippet: "Discover the URLs a website exposes",
		promptGuidelines: [
			"Use web_map to locate the right page on a site (docs, changelog, API reference), then web_scrape that URL.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Site or section URL to map, e.g. https://example.com/docs" }),
			limit: Type.Optional(Type.Number({ description: "Max URLs to return (default: 100)" })),
		}),
		executionMode: "parallel",
		async execute(_id, params, signal) {
			const limit = clampLimit(params.limit, 100, MAX_MAP_LIMIT);
			let links: string[];
			if (backend.kind === "http") {
				const raw = await httpCall(backend, "/v1/map", { url: params.url, limit }, signal);
				links = normalizeMap(raw);
			} else {
				// `crw map --limit` is newer than the subcommand itself. Retry
				// without it rather than hard-failing on an older binary: the
				// slice below caps the result either way, we just do more work.
				const args = ["map", params.url, "-f", "json", "--limit", String(limit)];
				let out: string;
				try {
					out = await runCli(backend.bin, args, signal);
				} catch (e) {
					if (!/unexpected argument '--limit'/.test((e as Error).message)) throw e;
					out = await runCli(backend.bin, ["map", params.url, "-f", "json"], signal);
				}
				links = normalizeMap(parseJson(out, "web_map"));
			}
			links = links.slice(0, limit);

			if (links.length === 0) {
				return {
					content: [{ type: "text", text: `No URLs discovered for: ${params.url}` }],
					details: { url: params.url, links },
				};
			}
			return {
				content: [{ type: "text", text: links.join("\n") }],
				details: { url: params.url, links },
			};
		},
	});

	const where =
		backend.kind === "http"
			? `http ${backend.url}${backend.key ? "" : " (no CRW_API_KEY yet)"}`
			: `cli ${backend.bin}`;
	console.error(`[crw] web_search + web_scrape + web_map registered (backend: ${where})`);
}
