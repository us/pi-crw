#!/usr/bin/env node
/**
 * pi-crw installer.
 *
 * pi auto-loads every `*.ts` under its agent extensions dir
 * (`~/.pi/agent/extensions/`). This command copies the crw extension there so
 * the pi coding agent gains `web_search` + `web_scrape` on its next session.
 *
 *   pi-crw install     copy the extension into pi's extensions dir
 *   pi-crw uninstall    remove it
 *   pi-crw status       show install state + which backend will be used
 *
 * Target dir override: PI_CRW_TARGET (defaults to ~/.pi/agent/extensions).
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "..", "src", "crw.ts");
const TARGET_DIR = process.env.PI_CRW_TARGET || join(homedir(), ".pi", "agent", "extensions");
const TARGET = join(TARGET_DIR, "crw.ts");

function backendHint() {
	if (process.env.CRW_API_URL) return `HTTP -> ${process.env.CRW_API_URL}`;
	if (process.env.CRW_BIN) return `CLI -> ${process.env.CRW_BIN} (CRW_BIN)`;
	return "CLI -> `crw` on PATH (set CRW_API_URL or CRW_BIN to override)";
}

const cmd = process.argv[2] || "help";

if (cmd === "install") {
	if (!existsSync(SOURCE)) {
		console.error(`pi-crw: cannot find bundled extension at ${SOURCE}`);
		process.exit(1);
	}
	mkdirSync(TARGET_DIR, { recursive: true });
	copyFileSync(SOURCE, TARGET);
	console.log(`pi-crw installed -> ${TARGET}`);
	console.log(`backend: ${backendHint()}`);
	console.log("Open a new pi session; the agent will have web_search + web_scrape.");
} else if (cmd === "uninstall") {
	if (existsSync(TARGET)) {
		rmSync(TARGET);
		console.log(`pi-crw removed -> ${TARGET}`);
	} else {
		console.log(`pi-crw: nothing to remove (not installed at ${TARGET})`);
	}
} else if (cmd === "status") {
	const installed = existsSync(TARGET);
	console.log(`installed: ${installed ? `yes (${TARGET})` : "no"}`);
	if (installed) console.log(`mtime:     ${statSync(TARGET).mtime.toISOString()}`);
	console.log(`backend:   ${backendHint()}`);
} else {
	console.log(`pi-crw <command>

  install     copy the crw extension into ${TARGET_DIR}
  uninstall   remove it
  status      show install state + selected backend

Backends (auto-detected at pi startup):
  CRW_API_URL set  -> HTTP (fastcrw.com cloud or a local 'crw serve')
  otherwise        -> CLI  (the 'crw' binary on PATH, or CRW_BIN)

This package bundles NO crw source. It only speaks to crw over its
stable CLI/HTTP protocol, so this MIT package and AGPL crw stay separate.`);
	process.exit(cmd === "help" ? 0 : 1);
}
