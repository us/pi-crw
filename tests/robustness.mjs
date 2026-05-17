// Error/edge-path coverage + regression locks for the M1-M5 / L1-L2 fixes.
// Deterministic: mock crw binary + in-process mock HTTP server.
import { createJiti } from "jiti";
import { createServer } from "node:http";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../src/crw.ts", import.meta.url));
const MOCK = fileURLToPath(new URL("./mock-crw.sh", import.meta.url));
const ARGS_FILE = fileURLToPath(new URL("./.args", import.meta.url));

let pass = 0,
	fail = 0;
const ok = (c, m) => (c ? (pass++, console.log(`  PASS ${m}`)) : (fail++, console.log(`  FAIL ${m}`)));

// Fresh module eval each call so module-level reads (TIMEOUT_MS) pick up env.
async function loadExtFresh() {
	const jiti = createJiti(import.meta.url, {
		alias: { typebox: "@sinclair/typebox" },
		interopDefault: true,
		moduleCache: false,
	});
	const tools = new Map();
	const pi = { tools, registerTool: (d) => tools.set(d.name, d), on() {}, registerCommand() {} };
	const mod = await jiti.import(EXT, { default: true });
	mod(pi);
	return pi;
}
function cliEnv(extra = {}) {
	delete process.env.CRW_API_URL;
	process.env.CRW_BIN = MOCK;
	for (const k of ["MOCK_MODE", "ARGS_FILE", "CRW_TIMEOUT_MS"]) delete process.env[k];
	Object.assign(process.env, extra);
}

console.log("\n[CLI] M2 abort -> error.name === 'AbortError'");
{
	cliEnv({ MOCK_MODE: "slow" });
	const pi = await loadExtFresh();
	const ac = new AbortController();
	const p = pi.tools.get("web_scrape").execute("a1", { url: "https://x" }, ac.signal);
	setTimeout(() => ac.abort(), 100);
	try {
		await p;
		ok(false, "should have rejected on abort");
	} catch (e) {
		ok(e.name === "AbortError", `abort preserves AbortError identity (name=${e.name})`);
	}
}

console.log("\n[CLI] M1 already-aborted signal -> clean reject, no unhandled 'error'");
{
	cliEnv({ MOCK_MODE: "slow" });
	const pi = await loadExtFresh();
	const ac = new AbortController();
	ac.abort();
	try {
		await pi.tools.get("web_scrape").execute("a2", { url: "https://x" }, ac.signal);
		ok(false, "should have rejected (pre-aborted)");
	} catch (e) {
		ok(e.name === "AbortError", `pre-aborted rejects as AbortError (name=${e.name})`);
	}
}

console.log("\n[CLI] timeout -> rejects with timeout message");
{
	cliEnv({ MOCK_MODE: "slow", CRW_TIMEOUT_MS: "250" });
	const pi = await loadExtFresh();
	const t0 = Date.now();
	try {
		await pi.tools.get("web_scrape").execute("t1", { url: "https://x" }, undefined);
		ok(false, "should have timed out");
	} catch (e) {
		ok(/timed out after 250ms/.test(e.message), `timeout message (${e.message})`);
		ok(Date.now() - t0 < 2000, "timeout fired well before the mock's 5s sleep");
	}
}

console.log("\n[CLI] M3 >5MB stdout -> rejects (no broken-JSON resolve)");
{
	cliEnv({ MOCK_MODE: "huge" });
	const pi = await loadExtFresh();
	try {
		await pi.tools.get("web_scrape").execute("tr1", { url: "https://x" }, undefined);
		ok(false, "should have rejected on truncation");
	} catch (e) {
		ok(/truncat|exceeded/i.test(e.message), `truncation rejects with actionable error (${e.message})`);
		ok(!/JSON/i.test(e.message), "truncation error is NOT a confusing JSON parse error");
	}
}

console.log("\n[CLI] non-zero exit -> rejects with exit code + stderr");
{
	cliEnv({ MOCK_MODE: "fail" });
	const pi = await loadExtFresh();
	try {
		await pi.tools.get("web_search").execute("f1", { query: "x" }, undefined);
		ok(false, "should have rejected on exit 1");
	} catch (e) {
		ok(/exited 1/.test(e.message) && /boom/.test(e.message), `exit+stderr surfaced (${e.message})`);
	}
}

console.log("\n[CLI] --js arg passthrough  &  L2 limit clamp");
{
	if (existsSync(ARGS_FILE)) rmSync(ARGS_FILE);
	cliEnv({ MOCK_MODE: "argecho", ARGS_FILE });
	let pi = await loadExtFresh();
	await pi.tools.get("web_scrape").execute("j1", { url: "https://x", js: true }, undefined);
	ok(/--js/.test(readFileSync(ARGS_FILE, "utf8")), "web_scrape js:true -> '--js' in argv");

	rmSync(ARGS_FILE);
	pi = await loadExtFresh();
	await pi.tools.get("web_search").execute("j2", { query: "x", limit: Infinity }, undefined);
	const aInf = readFileSync(ARGS_FILE, "utf8");
	ok(/-l 5\b/.test(aInf), `limit=Infinity -> safe default 5 (argv: ${aInf.trim()})`);
	ok(!/Infinity/.test(aInf), "literal 'Infinity' never reaches the backend");

	rmSync(ARGS_FILE);
	pi = await loadExtFresh();
	await pi.tools.get("web_search").execute("j3", { query: "x", limit: 9999 }, undefined);
	ok(/-l 50\b/.test(readFileSync(ARGS_FILE, "utf8")), "large finite limit clamped to MAX_SEARCH_LIMIT 50");
	rmSync(ARGS_FILE);
}

console.log("\n[CLI] L1 negative CRW_TIMEOUT_MS does not become the timeout");
{
	cliEnv({ CRW_TIMEOUT_MS: "-5" });
	const pi = await loadExtFresh();
	try {
		const r = await pi.tools.get("web_scrape").execute("l1", { url: "https://x" }, undefined);
		ok(/Example Domain/.test(r.content[0].text), "negative timeout fell back to default (call succeeded)");
	} catch (e) {
		ok(false, `negative CRW_TIMEOUT_MS leaked into setTimeout: ${e.message}`);
	}
}

console.log("\n[HTTP] mock crw serve: M4 links, M5 {success:false}, non-2xx, M2 abort");
{
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const j = body ? JSON.parse(body) : {};
			res.setHeader("content-type", "application/json");
			if (req.url === "/v1/scrape" && Array.isArray(j.formats) && j.formats.includes("links")) {
				res.end(JSON.stringify({ success: true, data: { links: ["https://a.com", "https://b.com"] } }));
			} else if (req.url === "/v1/scrape" && j.url === "https://slow") {
				setTimeout(() => res.end('{"success":true,"data":{"markdown":"late"}}'), 5000);
			} else if (req.url === "/v1/scrape") {
				res.end(JSON.stringify({ success: true, data: { markdown: "# OK", metadata: { statusCode: 200 } } }));
			} else if (req.url === "/v1/search" && j.query === "boom") {
				res.end(JSON.stringify({ success: false, error: "searxng is not configured" }));
			} else if (req.url === "/v1/search" && j.query === "5xx") {
				res.statusCode = 502;
				res.end("upstream exploded");
			} else if (req.url === "/v1/search") {
				res.end(JSON.stringify({ success: true, data: [{ url: "https://tokio.rs", title: "T" }] }));
			} else {
				res.statusCode = 404;
				res.end("{}");
			}
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	delete process.env.CRW_BIN;
	process.env.CRW_API_URL = `http://127.0.0.1:${port}`;
	const pi = await loadExtFresh();

	const lr = await pi.tools.get("web_scrape").execute("m4", { url: "https://x", format: "links" }, undefined);
	ok(/a\.com[\s\S]*b\.com/.test(lr.content[0].text), "M4 HTTP format=links returns the link list");

	try {
		await pi.tools.get("web_search").execute("m5", { query: "boom" }, undefined);
		ok(false, "M5 should have thrown on {success:false}");
	} catch (e) {
		ok(/searxng is not configured/.test(e.message), `M5 surfaces server failure verbatim (${e.message})`);
	}

	try {
		await pi.tools.get("web_search").execute("h5", { query: "5xx" }, undefined);
		ok(false, "should have thrown on HTTP 502");
	} catch (e) {
		ok(/HTTP 502/.test(e.message) && /exploded/.test(e.message), `non-2xx surfaced (${e.message})`);
	}

	const ac = new AbortController();
	const p = pi.tools.get("web_scrape").execute("h6", { url: "https://slow" }, ac.signal);
	setTimeout(() => ac.abort(), 100);
	try {
		await p;
		ok(false, "should have rejected on HTTP abort");
	} catch (e) {
		ok(e.name === "AbortError", `M2 HTTP abort preserves AbortError (name=${e.name})`);
	}

	await new Promise((r) => server.close(r));
	delete process.env.CRW_API_URL;
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
