#!/usr/bin/env node
/**
 * new-route.mjs — "I just added a new custom API: will it be auto-matched?"
 *
 * Opt-in (it needs the running server and momentarily adds one throwaway provider
 * to settings.yaml, which it restores byte-for-byte):
 *
 *   node tests/new-route.mjs [--url <app url>] [--card <provider>]
 *                            # 或 DSH_UNIT=<your systemd unit> 从 journal 里取 URL
 *
 * It answers the question at the three layers that matter, for a route nobody has
 * ever declared — `zzprobe`, with three model ids chosen to cover the cases:
 *
 *   zzprobe/glm-5.3           a name both catalogs know (prefixed, like probe/glm-5.3)
 *   zzprobe/claude-opus-4-6   a name only the catalogs know, no family hint needed
 *   zzprobe/whatever-9000     a name nothing knows
 *
 *   1. ADAPTER: the real pi-ai adapter, driven in-process, resolves each model of
 *      that route (context window, output cap, reasoning levels, modalities).
 *   2. HOST: the live plugin's own route reports what it matched for each model —
 *      the same verdict the fused readout prints.
 *   3. UI: the live page grows a card for the new route, and that card's editor
 *      rows carry the fused controls with the right readouts.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromePath, dshInstall } from "../dev-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH = dshInstall();
const CHROME = chromePath();
const HOME = process.env.DSH_HOME ?? join(process.env.HOME, ".dsh");
const SETTINGS = join(HOME, "settings.yaml");
const BACKUP = `${SETTINGS}.new-route-backup`;
const ROUTE = "zzprobe";
const MODELS = ["zzprobe/glm-5.3", "zzprobe/claude-opus-4-6", "zzprobe/whatever-9000"];

const original = readFileSync(SETTINGS);
copyFileSync(SETTINGS, BACKUP);
let restored = false;
const restore = () => {
	if (restored) return;
	restored = true;
	try {
		copyFileSync(BACKUP, SETTINGS);
		rmSync(BACKUP, { force: true });
	} catch (error) {
		console.error(`COULD NOT RESTORE ${SETTINGS}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	console.log(`settings.yaml restored byte-for-byte: ${String(readFileSync(SETTINGS).equals(original))}`);
};
process.on("exit", restore);
process.on("SIGINT", () => {
	restore();
	process.exit(130);
});

/* Add the throwaway route right under `  providers:` — the same shape the shipped
 * create card writes, so this is what "a new custom API" looks like on disk. */
const text = original.toString("utf8");
const lines = text.split("\n");
const at = lines.indexOf("  providers:");
if (at === -1) throw new Error("settings.yaml has no `llm-pi-ai.providers` section to extend");
const block = [
	`    ${ROUTE}:`,
	"      api: openai-responses",
	"      baseURL: http://127.0.0.1:9/v1",
	"      models:",
	...MODELS.flatMap((id) => [`        - id: ${id}`, `          name: ${id}`])
];
lines.splice(at + 1, 0, ...block);
writeFileSync(SETTINGS, lines.join("\n"));
await new Promise((resolve) => setTimeout(resolve, 2500));

const report = { route: ROUTE, models: MODELS };

/* 1. the adapter, in-process, on a COPY of the same document — this step needs no
 * live edit at all, and the plugin has to be named explicitly or the adapter is
 * driven bare (which would "prove" that nothing is filled in). */
const WORK = join(HERE, ".newroute");
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const copy = join(WORK, "settings.yaml");
writeFileSync(copy, lines.join("\n"));
try {
	const raw = execFileSync("node", [
		join(HERE, "..", "test-fallback.mjs"),
		"--source", join(DSH, "node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"),
		"--plugin", join(HERE, "..", "lib/index.mjs"),
		"--settings", copy,
		"--provider", ROUTE,
		"--json"
	], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	/* The plugin logs a line before the JSON document, so read the last array. */
	const jsonAt = raw.lastIndexOf("\n[");
	if (jsonAt === -1) throw new Error(`test-fallback printed no JSON array:\n${raw}`);
	report.adapter = JSON.parse(raw.slice(jsonAt + 1)).map((row) => ({
		id: row.id,
		contextWindow: row.contextWindow,
		maxTokens: row.maxTokens,
		levels: row.reasoning,
		input: row.input,
		api: row.api,
		baseUrl: row.baseUrl
	}));
} catch (error) {
	report.adapter = { failure: error instanceof Error ? error.message : String(error) };
}
rmSync(WORK, { recursive: true, force: true });

/* 2. the live plugin's own verdict — the fused readout's source. The app URL comes from
 * --url, or from the journal of the unit named by DSH_UNIT: no unit name is universal. */
function resolveUrl() {
	const given = option("--url", undefined);
	if (given !== undefined) return given;
	const unit = process.env.DSH_UNIT;
	if (unit === undefined) throw new Error('pass --url "http://127.0.0.1:3080/?token=…", or set DSH_UNIT to your systemd unit name');
	const line = execFileSync("journalctl", ["--user", "-u", unit, "--no-pager"], { encoding: "utf8" });
	const matches = [...line.matchAll(/dsh web: (http:\S+token=\S+)/gu)];
	if (matches.length === 0) throw new Error(`no launch URL in the journal of "${unit}"; pass --url instead`);
	return matches[matches.length - 1][1];
}
const url = resolveUrl();
try {
	const payload = await (await fetch(`${new URL(url).origin}/model-metadata/matrix?provider=${ROUTE}`)).json();
	const found = payload.routes.find((entry) => entry.route === ROUTE);
	report.host = found === undefined ? { failure: "the live plugin does not report this route" } : found.models.map((row) => ({
		id: row.id,
		readout: row.matched === undefined ? "无匹配" : `${row.matched.route} · context ${String(row.matched.contextWindow)} · output ${String(row.matched.maxTokens)} · reasoning ${String(row.matched.reasoning)} · input ${String(row.matched.input)}`
	}));
} catch (error) {
	report.host = { failure: error instanceof Error ? error.message : String(error) };
}

/* 3. the live page: a card for the new route, with fused cells in its editor. */
const require = createRequire(join(DSH, "node_modules", "noop.js"));
const { WebSocket } = require("ws");
const port = 9337;
const profile = join(HERE, ".browser-profile-newroute");
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
/* A crash must not leave a Chromium profile (and its device ids) inside the repository. */
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${String(port)}`, `--user-data-dir=${profile}`, "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--window-size=1400,1000", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr.on("data", () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
	let debuggerUrl;
	for (let attempt = 0; attempt < 100 && debuggerUrl === undefined; attempt++) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json();
			debuggerUrl = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl;
		} catch {
			/* not up yet */
		}
		if (debuggerUrl === undefined) await sleep(200);
	}
	socket = new WebSocket(debuggerUrl);
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	let nextId = 0;
	const pending = new Map();
	const errors = [];
	socket.on("message", (raw) => {
		const message = JSON.parse(String(raw));
		if (message.id !== undefined) {
			const waiter = pending.get(message.id);
			if (waiter !== undefined) {
				pending.delete(message.id);
				message.error === undefined ? waiter.resolve(message.result) : waiter.reject(new Error(JSON.stringify(message.error)));
			}
			return;
		}
		if (message.method === "Runtime.exceptionThrown") errors.push(String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text));
	});
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = ++nextId;
		pending.set(id, { resolve, reject });
		socket.send(JSON.stringify({ id, method, params }));
	});
	const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Page.navigate", { url });
	for (let attempt = 0; attempt < 60 && (await evaluate("document.readyState")) !== "complete"; attempt++) await sleep(250);
	await sleep(2500);
	const click = async (text) => evaluate(`(() => {
		const hit = [...document.querySelectorAll("button, a, li, div, span, p")].find((node) => node.children.length === 0 && node.textContent.trim() === ${JSON.stringify(text)});
		if (hit === undefined) return false;
		hit.click();
		return true;
	})()`);
	await click("设置");
	await sleep(1500);
	await click("模型");
	await sleep(3000);
	report.ui = await evaluate(`(async () => {
		const card = [...document.querySelectorAll("li")].find((node) => node.textContent.includes(${JSON.stringify(ROUTE)}));
		if (card === undefined) return { card: false };
		const button = [...card.querySelectorAll("button")].find((node) => node.textContent.trim() === "编辑");
		if (button !== undefined) button.click();
		await new Promise((resolve) => setTimeout(resolve, 1800));
		const cells = [...card.querySelectorAll("[data-model-metadata-cell]")];
		return {
			card: true,
			rowControls: card.querySelectorAll("button[aria-expanded]").length,
			cells: cells.length,
			readouts: cells.map((cell) => cell.lastElementChild.querySelector("span")?.textContent),
			modelIds: [...card.querySelectorAll("input")].map((node) => node.value).filter((value) => value.startsWith("zzprobe/"))
		};
	})()`);
	report.ui.errors = errors;
} catch (error) {
	report.ui = { failure: error instanceof Error ? error.message : String(error) };
} finally {
	socket?.close();
	chrome.kill("SIGKILL");
	rmSync(profile, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
restore();
