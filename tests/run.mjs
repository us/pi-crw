// Core harness: registration, prompt metadata, CLI scrape/search/map (mock crw
// binary), backend resolution, and an in-process mock crw-serve for HTTP.
// Deterministic — no network, no real crw.
import { createJiti } from "jiti";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../src/crw.ts", import.meta.url));
const MOCK = fileURLToPath(new URL("./mock-crw.sh", import.meta.url));
const CLOUD = "https://api.fastcrw.com";

const jiti = createJiti(import.meta.url, {
	alias: { typebox: "@sinclair/typebox" },
	interopDefault: true,
	moduleCache: false,
});

// A developer with CRW_API_KEY exported would otherwise silently land in HTTP
// mode and this whole file would test the wrong backend.
function clearEnv() {
	for (const k of ["CRW_API_URL", "CRW_API_KEY", "CRW_BIN", "PI_OFFLINE"]) delete process.env[k];
}

function makePi() {
	const tools = new Map();
	return { tools, registerTool: (d) => tools.set(d.name, d), on() {}, registerCommand() {} };
}
async function loadExt() {
	const mod = await jiti.import(EXT, { default: true });
	const pi = makePi();
	mod(pi);
	return pi;
}

let pass = 0,
	fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  PASS ${m}`)) : (fail++, console.log(`  FAIL ${m}`)));

console.log("\n[1] CLI backend (mock crw binary)");
{
	clearEnv();
	process.env.CRW_BIN = MOCK;
	const pi = await loadExt();
	ok(
		pi.tools.has("web_scrape") && pi.tools.has("web_search") && pi.tools.has("web_map"),
		"all three tools registered",
	);
	const ws = pi.tools.get("web_scrape");
	const wq = pi.tools.get("web_search");
	const wm = pi.tools.get("web_map");
	ok(!!ws.promptSnippet && Array.isArray(ws.promptGuidelines), "web_scrape promptSnippet+guidelines");
	ok(!!wq.promptSnippet && Array.isArray(wq.promptGuidelines), "web_search promptSnippet+guidelines");
	ok(!!wm.promptSnippet && Array.isArray(wm.promptGuidelines), "web_map promptSnippet+guidelines");
	ok(
		ws.executionMode === "parallel" && wq.executionMode === "parallel" && wm.executionMode === "parallel",
		"executionMode parallel",
	);

	const sr = await ws.execute("t1", { url: "https://example.com" }, undefined);
	ok(sr.content?.[0]?.type === "text", "scrape: content text shape");
	ok(/Example Domain/i.test(sr.content[0].text), "scrape: markdown has 'Example Domain'");
	ok(sr.details?.metadata?.statusCode === 200, "scrape: details.metadata.statusCode 200");

	const sj = await ws.execute("t2", { url: "https://example.com", format: "json" }, undefined);
	ok(sj.content[0].text.trim().startsWith("{"), "scrape: format=json returns JSON text");

	const st = await ws.execute("t2b", { url: "https://example.com", format: "text" }, undefined);
	ok(/plain text body/.test(st.content[0].text), "scrape: format=text returns the CLI's plain text");

	const qr = await wq.execute("t3", { query: "rust", limit: 3 }, undefined);
	ok(Array.isArray(qr.details?.hits) && qr.details.hits.length > 0, "search: returns hits");
	ok(qr.details.hits.length <= 3, "search: respects limit");
	ok(/https?:\/\//.test(qr.content[0].text), "search: text lists URLs");

	const mr = await wm.execute("t4", { url: "https://example.com" }, undefined);
	ok(mr.details?.links?.length === 2, "map: returns the discovered links");
	ok(/example\.com\/docs/.test(mr.content[0].text), "map: text lists one URL per line");
}

console.log("\n[2] Backend resolution");
{
	clearEnv();
	const savedPath = process.env.PATH;
	process.env.PATH = "/nonexistent-bin";
	try {
		const pi = await loadExt();
		ok(pi.tools.size === 3, "no key and no binary -> tools still registered (cloud default)");

		process.env.PI_OFFLINE = "1";
		const off = await loadExt();
		ok(off.tools.size === 0, "PI_OFFLINE=1 -> nothing registered");
		delete process.env.PI_OFFLINE;

		// CRW_API_KEY with no URL must resolve to the cloud, not to the CLI.
		process.env.CRW_API_KEY = "test-key-not-a-real-credential";
		process.env.PATH = savedPath;
		process.env.CRW_BIN = MOCK;
		const cloudPi = await loadExt();
		let hit = null;
		const realFetch = globalThis.fetch;
		globalThis.fetch = async (url) => {
			hit = String(url);
			return new Response(JSON.stringify({ success: true, data: { markdown: "# x" } }), {
				headers: { "content-type": "application/json" },
			});
		};
		try {
			await cloudPi.tools.get("web_scrape").execute("b1", { url: "https://example.com" }, undefined);
		} finally {
			globalThis.fetch = realFetch;
		}
		ok(hit === `${CLOUD}/v1/scrape`, `CRW_API_KEY alone -> ${CLOUD} (got ${hit})`);
	} finally {
		process.env.PATH = savedPath;
		clearEnv();
	}
}

console.log("\n[3] HTTP backend (in-process mock crw serve)");
{
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const j = body ? JSON.parse(body) : {};
			res.setHeader("content-type", "application/json");
			if (req.url === "/v1/scrape") {
				res.end(
					JSON.stringify({
						success: true,
						data: { markdown: "# Example Domain\nMock body", metadata: { statusCode: 200 } },
					}),
				);
			} else if (req.url === "/v1/search") {
				res.end(
					JSON.stringify({
						success: true,
						data: [
							{ url: "https://tokio.rs", title: "Tokio", description: "async runtime", position: 1 },
							{ url: "https://github.com/tokio-rs/tokio", title: "tokio-rs", position: 2 },
						].slice(0, j.limit ?? 5),
					}),
				);
			} else if (req.url === "/v1/map") {
				res.end(
					JSON.stringify({
						success: true,
						data: { links: ["https://example.com/", "https://example.com/docs"], sitemaps: [] },
					}),
				);
			} else {
				res.statusCode = 404;
				res.end("{}");
			}
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	clearEnv();
	process.env.CRW_API_URL = `http://127.0.0.1:${port}`;
	const pi = await loadExt();
	ok(pi.tools.size === 3, "tools registered in HTTP mode");
	try {
		const r = await pi.tools.get("web_scrape").execute("h1", { url: "https://example.com" }, undefined);
		ok(/Example Domain/i.test(r.content[0].text), "HTTP scrape: 'Example Domain'");
		ok(r.details?.metadata?.statusCode === 200, "HTTP scrape: statusCode 200");
	} catch (e) {
		ok(false, `HTTP scrape failed: ${e.message}`);
	}
	try {
		const q = await pi.tools.get("web_search").execute("h2", { query: "tokio rust", limit: 2 }, undefined);
		ok(Array.isArray(q.details?.hits) && q.details.hits.length === 2, "HTTP search: returned hits");
		ok(/tokio\.rs/.test(q.content[0].text), "HTTP search: text lists result URLs");
	} catch (e) {
		ok(false, `HTTP search failed: ${e.message}`);
	}
	try {
		const m = await pi.tools.get("web_map").execute("h3", { url: "https://example.com" }, undefined);
		ok(m.details?.links?.length === 2, "HTTP map: unwraps data.links");
		ok(/example\.com\/docs/.test(m.content[0].text), "HTTP map: text lists the URLs");
	} catch (e) {
		ok(false, `HTTP map failed: ${e.message}`);
	}
	await new Promise((r) => server.close(r));
	clearEnv();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
