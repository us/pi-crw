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
	// CRW_API_KEY must go too: with the cloud default it now outranks the
	// binary, so a developer with the key exported would test HTTP by accident.
	for (const k of ["CRW_API_URL", "CRW_API_KEY", "PI_OFFLINE", "MOCK_MODE", "ARGS_FILE", "CRW_TIMEOUT_MS"])
		delete process.env[k];
	process.env.CRW_BIN = MOCK;
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
	pi = await loadExtFresh();
	await pi.tools.get("web_search").execute("j4", { query: "x", category: "github" }, undefined);
	ok(/--category github/.test(readFileSync(ARGS_FILE, "utf8")), "search category -> '--category github' in argv");

	rmSync(ARGS_FILE);
	pi = await loadExtFresh();
	await pi.tools.get("web_scrape").execute("j5", { url: "https://x", format: "text" }, undefined);
	ok(/-f text/.test(readFileSync(ARGS_FILE, "utf8")), "M7 CLI format=text asks the binary for text, not json");

	rmSync(ARGS_FILE);
	pi = await loadExtFresh();
	await pi.tools.get("web_map").execute("j6", { url: "https://x", limit: 7 }, undefined);
	const aMap = readFileSync(ARGS_FILE, "utf8");
	ok(/^map https:\/\/x -f json --limit 7/.test(aMap.trim()), `map argv (${aMap.trim()})`);
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

console.log("\n[HTTP] wire format: M6 auth hint, M7 plainText, M8 renderJs, M9 categories");
{
	const seen = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const j = body ? JSON.parse(body) : {};
			seen.push({ path: req.url, body: j });
			res.setHeader("content-type", "application/json");
			if (req.url === "/v1/scrape" && j.url === "https://denied") {
				res.statusCode = 401;
				res.end('{"error":"Invalid or missing API key"}');
			} else if (req.url === "/v1/scrape" && j.url === "https://broke") {
				res.statusCode = 402;
				res.end('{"error":"Insufficient credits. Top up at https://fastcrw.com/dashboard"}');
			} else if (req.url === "/v1/scrape") {
				res.end(
					JSON.stringify({
						success: true,
						data: { markdown: "# md", plainText: "flat plain text", links: ["https://a"] },
					}),
				);
			} else if (req.url === "/v1/search") {
				res.end(JSON.stringify({ success: true, data: [{ url: "https://x", snippet: "from snippet" }] }));
			} else if (req.url === "/v1/map") {
				res.end(JSON.stringify({ success: true, data: { links: ["https://x/a", "https://x/b", "https://x/c"] } }));
			} else {
				res.statusCode = 404;
				res.end("{}");
			}
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	for (const k of ["CRW_BIN", "CRW_API_KEY", "PI_OFFLINE"]) delete process.env[k];
	process.env.CRW_API_URL = `http://127.0.0.1:${port}`;
	const pi = await loadExtFresh();
	const last = () => seen[seen.length - 1].body;

	await pi.tools.get("web_scrape").execute("w1", { url: "https://x", js: true }, undefined);
	ok(last().renderJs === true, `M8 js:true -> body.renderJs (body: ${JSON.stringify(last())})`);
	ok(!("js" in last()), "M8 the dead 'js' field is no longer sent");

	const tr = await pi.tools.get("web_scrape").execute("w2", { url: "https://x", format: "text" }, undefined);
	ok(JSON.stringify(last().formats) === '["plainText"]', `M7 format=text -> formats ["plainText"] (${JSON.stringify(last().formats)})`);
	ok(tr.content[0].text === "flat plain text", "M7 plainText is read back, not silently swapped for markdown");

	await pi.tools.get("web_search").execute("w3", { query: "q", category: "github" }, undefined);
	ok(JSON.stringify(last().categories) === '["github"]', `M9 category -> categories:["github"] (${JSON.stringify(last().categories)})`);
	ok(!("category" in last()), "M9 the singular 'category' field is no longer sent");

	const sq = await pi.tools.get("web_search").execute("w4", { query: "q" }, undefined);
	ok(/from snippet/.test(sq.content[0].text), "search falls back to the 'snippet' alias when description is absent");

	const mr = await pi.tools.get("web_map").execute("w5", { url: "https://x", limit: 2 }, undefined);
	ok(last().limit === 2, `map forwards limit (${last().limit})`);
	ok(mr.details.links.length === 2, "map trims an over-long server response to the requested limit");

	try {
		await pi.tools.get("web_scrape").execute("w6", { url: "https://denied" }, undefined);
		ok(false, "M6 should have thrown on 401");
	} catch (e) {
		ok(/CRW_API_KEY/.test(e.message) && /fastcrw\.com/.test(e.message), `M6 401 is actionable (${e.message})`);
	}

	try {
		await pi.tools.get("web_scrape").execute("w7", { url: "https://broke" }, undefined);
		ok(false, "should have thrown on 402");
	} catch (e) {
		ok(
			/Insufficient credits/.test(e.message) && !/set CRW_API_KEY/.test(e.message),
			`M6 402 keeps the server's own credit copy, no bogus key advice (${e.message})`,
		);
	}

	await new Promise((r) => server.close(r));
	delete process.env.CRW_API_URL;
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
