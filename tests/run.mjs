// Core harness: registration, prompt metadata, CLI scrape/search (mock crw
// binary), no-backend negative, and an in-process mock crw-serve for HTTP.
// Deterministic — no network, no real crw.
import { createJiti } from "jiti";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../src/crw.ts", import.meta.url));
const MOCK = fileURLToPath(new URL("./mock-crw.sh", import.meta.url));

const jiti = createJiti(import.meta.url, {
	alias: { typebox: "@sinclair/typebox" },
	interopDefault: true,
	moduleCache: false,
});

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
	process.env.CRW_BIN = MOCK;
	delete process.env.CRW_API_URL;
	const pi = await loadExt();
	ok(pi.tools.has("web_scrape") && pi.tools.has("web_search"), "both tools registered");
	const ws = pi.tools.get("web_scrape");
	const wq = pi.tools.get("web_search");
	ok(!!ws.promptSnippet && Array.isArray(ws.promptGuidelines), "web_scrape promptSnippet+guidelines");
	ok(!!wq.promptSnippet && Array.isArray(wq.promptGuidelines), "web_search promptSnippet+guidelines");
	ok(ws.executionMode === "parallel" && wq.executionMode === "parallel", "executionMode parallel");

	const sr = await ws.execute("t1", { url: "https://example.com" }, undefined);
	ok(sr.content?.[0]?.type === "text", "scrape: content text shape");
	ok(/Example Domain/i.test(sr.content[0].text), "scrape: markdown has 'Example Domain'");
	ok(sr.details?.metadata?.statusCode === 200, "scrape: details.metadata.statusCode 200");

	const sj = await ws.execute("t2", { url: "https://example.com", format: "json" }, undefined);
	ok(sj.content[0].text.trim().startsWith("{"), "scrape: format=json returns JSON text");

	const qr = await wq.execute("t3", { query: "rust", limit: 3 }, undefined);
	ok(Array.isArray(qr.details?.hits) && qr.details.hits.length > 0, "search: returns hits");
	ok(qr.details.hits.length <= 3, "search: respects limit");
	ok(/https?:\/\//.test(qr.content[0].text), "search: text lists URLs");
}

console.log("\n[2] Negative: no backend -> tools not registered");
{
	delete process.env.CRW_BIN;
	delete process.env.CRW_API_URL;
	const savedPath = process.env.PATH;
	process.env.PATH = "/nonexistent-bin";
	try {
		const pi = await loadExt();
		ok(pi.tools.size === 0, "no tools registered when backend absent");
	} finally {
		process.env.PATH = savedPath;
	}
}

console.log("\n[3] HTTP backend (in-process mock crw serve, Firecrawl-compatible)");
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
			} else {
				res.statusCode = 404;
				res.end("{}");
			}
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	process.env.CRW_API_URL = `http://127.0.0.1:${port}`;
	delete process.env.CRW_BIN;
	const pi = await loadExt();
	ok(pi.tools.size === 2, "tools registered in HTTP mode");
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
	await new Promise((r) => server.close(r));
	delete process.env.CRW_API_URL;
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
