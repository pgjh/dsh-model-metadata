#!/usr/bin/env node
/**
 * fusion-write.mjs — prove the fused controls actually write.
 *
 * Diagnostic tool, not part of `verify.mjs` (it needs the running server, a
 * Chromium build, and it mutates the real settings document for a moment):
 *
 *   node tests/fusion-write.mjs                 # newest launch token from journalctl
 *   node tests/fusion-write.mjs --card <provider> --keep   # default: the first provider card
 *
 * It backs up settings.yaml, drives the real UI (设置 → 模型 → 编辑 → the first model
 * row's fused 推理等级 control → 写入), then reports:
 *   - what the row's own note said;
 *   - whether the host's matrix route now reports the declaration (i.e. the write
 *     reached the settings layer and came back through the resolver);
 *   - whether the write touched anything else in `models[]`.
 * settings.yaml is restored byte-for-byte before the process exits, on any path.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromePath, dshInstall } from "../dev-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH = dshInstall();
const CHROME = chromePath();
const require = createRequire(join(DSH, "node_modules", "noop.js"));
const { WebSocket } = require("ws");
const HOME = process.env.DSH_HOME ?? join(process.env.HOME, ".dsh");
const SETTINGS = join(HOME, "settings.yaml");
const BACKUP = `${SETTINGS}.fusion-write-backup`;

const argv = process.argv.slice(2);
const option = (name, fallback) => {
	const at = argv.indexOf(name);
	return at === -1 ? fallback : argv[at + 1];
};

/**
 * The launch URL, from `--url` or from the journal of the unit named by `DSH_UNIT`.
 * Naming the unit is required because no unit name is universal.
 * @returns the tokenised app URL.
 */
function tokenUrl() {
	const unit = process.env.DSH_UNIT;
	const line = execFileSync("journalctl", ["--user", "-u", unit, "--no-pager"], { encoding: "utf8" });
	const matches = [...line.matchAll(/dsh web: (http:\S+token=\S+)/gu)];
	if (matches.length === 0) throw new Error(`no launch URL in the journal of "${String(unit)}"; pass --url instead`);
	return matches[matches.length - 1][1];
}

/** Resolve the URL, and say what to do when the unit was not named. */
function resolveUrl() {
	const given = option("--url", undefined);
	if (given !== undefined) return given;
	if (process.env.DSH_UNIT === undefined) {
		throw new Error("pass --url \"http://127.0.0.1:3080/?token=…\", or set DSH_UNIT to your systemd unit name to read it from the journal");
	}
	return tokenUrl();
}
const url = resolveUrl();
/* Empty unless asked: whatever provider the deployment's first card holds. */
let card = option("--card", "");
const port = Number(option("--port", "9335"));
const keep = argv.includes("--keep");

/* Back up first: nothing below may leave the user's settings changed. */
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
		console.error(`COULD NOT RESTORE ${SETTINGS} FROM ${BACKUP}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const same = readFileSync(SETTINGS).equals(original);
	console.log(`settings.yaml restored byte-for-byte: ${String(same)}`);
	if (!same) console.error("RESTORE MISMATCH — settings.yaml differs from the original");
};
process.on("exit", restore);
process.on("SIGINT", () => {
	restore();
	process.exit(130);
});

const profile = join(HERE, ".browser-profile-write");
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
/* A crash must not leave a Chromium profile (and its device ids) inside the repository. */
process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
const chrome = spawn(CHROME, [
	"--headless=new",
	`--remote-debugging-port=${String(port)}`,
	`--user-data-dir=${profile}`,
	"--no-sandbox",
	"--disable-gpu",
	"--disable-dev-shm-usage",
	"--window-size=1400,1000",
	"about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr.on("data", () => {});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the DevTools HTTP endpoint to answer. */
async function debuggerUrl() {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
			const targets = await response.json();
			const page = targets.find((target) => target.type === "page");
			if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("chromium never exposed a page target");
}

const socket = new WebSocket(await debuggerUrl());
await new Promise((resolve, reject) => {
	socket.once("open", resolve);
	socket.once("error", reject);
});
let nextId = 0;
const pending = new Map();
const logs = [];
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
	if (message.method === "Runtime.exceptionThrown") logs.push(String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text));
	else if (message.method === "Runtime.consoleAPICalled") logs.push(`[${String(message.params.type)}] ${message.params.args.map((arg) => String(arg.value ?? arg.description ?? arg.type)).join(" ")}`);
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

/** Click the first leaf element whose trimmed text matches exactly. */
const click = async (text) => evaluate(`(() => {
	const wanted = ${JSON.stringify(text)};
	const all = [...document.querySelectorAll("button, a, li, div, span, p")];
	const hit = all.find((node) => node.children.length === 0 && node.textContent.trim() === wanted);
	if (hit === undefined) return false;
	hit.click();
	return true;
})()`);

await click("设置");
await sleep(1500);
await click("模型");
await sleep(2500);

const opened = await evaluate(`(async () => {
	const wanted = ${JSON.stringify(card)};
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	/* Walk the cards until one shows this plugin's cells: no provider name is assumed,
	 * and the deployment's first card may well belong to another family. */
	const cards = [...document.querySelectorAll("li")].filter((node) => [...node.querySelectorAll("button")].some((button) => button.textContent.trim() === "编辑"));
	for (const candidate of cards.slice(0, 8)) {
		if (wanted.length > 0 && !candidate.textContent.includes(wanted)) continue;
		[...candidate.querySelectorAll("button")].find((node) => node.textContent.trim() === "编辑").click();
		/* Poll rather than sleep-and-hope: a cell is portaled once the editor has
		 * rendered its rows and this plugin's observer has seen them. */
		for (let attempt = 0; attempt < 12 && candidate.querySelector("[data-model-metadata-cell]") === null; attempt++) await sleep(250);
		if (candidate.querySelector("[data-model-metadata-cell]") !== null) {
			/* Report every model id this card shows: whichever route in the matrix holds
			 * one of them is the card's route — no hashed class, no copy, no assumed name. */
			return [...candidate.querySelectorAll("input")].map((node) => node.value).filter((value) => value.length > 0);
		}
	}
	return false;
})()`);
await sleep(800);

/** Read one route's rows, by name: a host older than the request filter answers
 * every route at once, and position 0 would be another provider. */
const matrixOf = async (route) => {
	const payload = await (await fetch(`${new URL(url).origin}/model-metadata/matrix?provider=${encodeURIComponent(route)}`)).json();
	return payload.routes.find((entry) => entry.route === route);
};
/* Resolve the route from the model id the card showed, when no --card was given. */
const whole = await (await fetch(`${new URL(url).origin}/model-metadata/matrix`)).json();
if (Array.isArray(opened) && card.length === 0) {
	card = whole.routes.find((entry) => entry.models.some((model) => opened.includes(model.id)))?.route ?? "";
}
console.log(`card: ${card.length > 0 ? `${card}${Array.isArray(opened) ? ` (found via ${opened[0] ?? "?"})` : ""}` : `not found (saw ${JSON.stringify(opened).slice(0, 120)})`}`);
const before = whole.routes.find((entry) => entry.route === card);
if (before === undefined) throw new Error(`no route "${card}" in the matrix; pass --card <provider>`);
const storedBefore = before.models[0].stored;

/* Set the first row's 推理等级 through the real control, the way a user does it:
 * open the picker and click a row. There is no platform select any more — the whole
 * point of the Menu rewrite — so a test that set `select.value` would test nothing. */
const WANTED_LABEL = "关闭 / 低 / 中 / 高";
const setting = await evaluate(`(async () => {
	const cell = document.querySelector("[data-model-metadata-cell]");
	if (cell === null) return { found: false };
	const trigger = cell.querySelector("button[aria-haspopup='menu']");
	if (trigger === null) return { found: true, trigger: false };
	const before = trigger.textContent.trim();
	trigger.click();
	await new Promise((resolve) => setTimeout(resolve, 500));
	const items = [...document.querySelectorAll("[role='menuitem'],[role='menuitemradio'],li")].filter((node) => node.offsetParent !== null);
	const labels = items.map((node) => node.textContent.trim());
	const item = items.find((node) => node.textContent.trim() === ${JSON.stringify("关闭 / 低 / 中 / 高")});
	if (item === undefined) return { found: true, trigger: true, picked: false, labels: labels.slice(-10) };
	item.click();
	await new Promise((resolve) => setTimeout(resolve, 300));
	const write = [...cell.querySelectorAll("button")].find((node) => node.textContent.trim() === "写入");
	return {
		found: true,
		trigger: true,
		picked: true,
		before,
		after: trigger.textContent.trim(),
		dirty: write !== undefined && write.style.display !== "none",
		model: cell.parentElement?.children?.[0]?.children?.[0]?.value
	};
})()`);
/* The look flips in a later tick: React commits the choice, then the button appears. */
await sleep(600);
const settled = await evaluate(`(() => {
	const cell = document.querySelector("[data-model-metadata-cell]");
	const trigger = cell.querySelector("button[aria-haspopup='menu']");
	const write = [...cell.querySelectorAll("button")].find((node) => node.textContent.trim() === "写入");
	return { value: trigger.textContent.trim(), dirty: write !== undefined && write.style.display !== "none" };
})()`);

let outcome = { skipped: "no cell found" };
if (setting.found === true && setting.dirty === true) {
	const clicked = await evaluate(`(() => {
		const cell = document.querySelector("[data-model-metadata-cell]");
		[...cell.querySelectorAll("button")].find((node) => node.textContent.trim() === "写入").click();
		return true;
	})()`);
	await sleep(1200);
	const noteRightAfter = await evaluate(`document.querySelector("[data-model-metadata-cell]")?.lastElementChild?.querySelector("p")?.textContent`);
	await sleep(2000);
	const storedAfter = (await matrixOf(card)).models[0].stored;
	const note = await evaluate(`document.querySelector("[data-model-metadata-cell]")?.lastElementChild?.querySelector("p")?.textContent`);
	const stillDirty = await evaluate(`(() => {
		const cell = document.querySelector("[data-model-metadata-cell]");
		const write = [...cell.querySelectorAll("button")].find((node) => node.textContent.trim() === "写入");
		return write !== undefined && write.style.display !== "none";
	})()`);
	const keys = (entry) => Object.keys(entry).sort();
	outcome = {
		written: storedAfter.reasoningEfforts,
		expected: { off: null, low: "low", medium: "medium", high: "high" },
		clicked,
		noteRightAfter,
		matches: JSON.stringify(storedAfter.reasoningEfforts) === JSON.stringify({ off: null, low: "low", medium: "medium", high: "high" }),
		note,
		dirtyCleared: stillDirty === false,
		report: note,
		keysBefore: keys(storedBefore),
		keysAfter: keys(storedAfter),
		capacityUntouched: storedAfter.contextWindow === storedBefore.contextWindow && storedAfter.maxTokens === storedBefore.maxTokens
	};
}

console.log(JSON.stringify({ url, card, opened, setting, settled, outcome, errors: logs.filter((line) => /catalog|Cannot|Error/u.test(line)) }, null, 2));
socket.close();
chrome.kill("SIGKILL");
rmSync(profile, { recursive: true, force: true });

/* Report the file's own state, then restore. */
restore();
if (!existsSync(CHROME)) process.exit(2);
