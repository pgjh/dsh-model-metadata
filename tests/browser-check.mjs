#!/usr/bin/env node
/**
 * browser-check.mjs — drive the real Web UI headlessly and report what the
 * browser actually does with this plugin's client bundle.
 *
 * Diagnostic tool, not part of `verify.mjs` (it needs the running server and a
 * Chromium build):
 *
 *   node tests/browser-check.mjs                     # newest launch token from journalctl
 *   node tests/browser-check.mjs --url "http://127.0.0.1:3080/?token=…"   # --card <provider> picks a card
 *   node tests/browser-check.mjs --out shot.png --keep-logs
 *
 * It opens the app, clicks 设置 → 模型, then prints: whether the panel's own
 * text is in the DOM, whether the bundle URL was fetched, every console message
 * and page error, and (with --out) a screenshot to look at.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromePath, dshInstall } from "../dev-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DSH = dshInstall();
const CHROME = chromePath();
const require = createRequire(join(DSH, "node_modules", "noop.js"));
const { WebSocket } = require("ws");

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
const out = option("--out", undefined);
const port = Number(option("--port", "9333"));
const window = option("--window", "1400,1000");
const profile = join(HERE, ".browser-profile");
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
	`--window-size=${window}`,
	"about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
let chromeErrors = "";
chrome.stderr.on("data", (chunk) => { chromeErrors += String(chunk); });

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
	if (message.method === "Runtime.consoleAPICalled") logs.push(`[console.${String(message.params.type)}] ${message.params.args.map((arg) => String(arg.value ?? arg.description ?? arg.type)).join(" ")}`);
	else if (message.method === "Runtime.exceptionThrown") logs.push(`[exception] ${String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)}`);
	else if (message.method === "Log.entryAdded") logs.push(`[log.${String(message.params.entry.level)}] ${String(message.params.entry.text)}`);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = ++nextId;
	pending.set(id, { resolve, reject });
	socket.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Page.navigate", { url });
await sleep(3000);
for (let attempt = 0; attempt < 40 && (await evaluate("document.readyState")) !== "complete"; attempt++) await sleep(250);

/** Click the first leaf element whose trimmed text matches exactly. */
const click = async (text) => evaluate(`(() => {
	const wanted = ${JSON.stringify(text)};
	const all = [...document.querySelectorAll("button, a, li, div, span, p")];
	const exact = all.find((node) => node.children.length === 0 && node.textContent.trim() === wanted);
	const contains = all.find((node) => node.children.length === 0 && node.textContent.includes(wanted));
	const labelled = document.querySelector(\`[aria-label*=\${JSON.stringify(wanted)}]\`);
	const hit = exact ?? contains ?? labelled;
	if (hit === undefined || hit === null) return false;
	hit.click();
	return true;
})()`);

const clickedSettings = await click("设置");
await sleep(1500);
const clickedModels = await click("模型");
await sleep(2500);

/* 1. This plugin must NOT render a block of its own: no second place to edit a
 * model. The card may carry one hint line, never a disclosure or its own fields. */
const ownBlock = await evaluate(`(() => {
	const cards = [...document.querySelectorAll("li")];
	const withDisclosure = cards.filter((card) => [...card.querySelectorAll("summary")].some((node) => node.textContent.includes("目录回退"))).length;
	const stray = [...document.querySelectorAll("[data-model-metadata-cell]")].length;
	/* Nothing of this plugin's own may be visible while no editor is open: not a
	 * disclosure, not a hint line, not a stray cell. */
	const ownText = [...document.querySelectorAll("p, summary, span, div")]
		.map((node) => node.children.length === 0 ? node.textContent.trim() : "")
		.filter((text) => text.includes("目录回退") || text.includes("自定义设置 → 模型目录"));
	return { withDisclosure, strayCellsWhileClosed: stray, ownTextWhileClosed: ownText };
})()`);

/* 2. Open the first provider card's editor and measure the fusion: every model row
 * must carry the two extra controls INSIDE that row, above its own capacity grid. */
const fusion = await evaluate(`(async () => {
	/* Empty unless asked: the first provider card of whatever deployment this runs
	 * against, so the tool has no hardcoded provider name. */
	const CARD = ${JSON.stringify(option("--card", ""))};
	const wanted = CARD;
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	/* Walk the cards until one carries this plugin's cells: a deployment's first card
	 * may well be a provider of another family, so "the plugin's card" is what the
	 * tool must find — not a name it was told. */
	const cards = [...document.querySelectorAll("li")].filter((node) => [...node.querySelectorAll("button")].some((button) => button.textContent.trim() === "编辑"));
	let card;
	let used = "";
	for (const candidate of cards.slice(0, 8)) {
		if (wanted.length > 0 && !candidate.textContent.includes(wanted)) continue;
		[...candidate.querySelectorAll("button")].find((node) => node.textContent.trim() === "编辑").click();
		await sleep(1400);
		const toggles = [...candidate.querySelectorAll("button[aria-expanded]")].filter((node) => node.parentElement?.children?.[0]?.tagName === "INPUT");
		if (toggles[0] !== undefined) { toggles[0].click(); await sleep(500); }
		if (candidate.querySelector("[data-model-metadata-cell]") !== null) { card = candidate; used = candidate.textContent.slice(0, 40).trim(); break; }
	}
	if (card === undefined) return { opened: false, cardsTried: cards.length };
	await sleep(600);
	/* A model row is the grid whose first cell is the id input; its 容量 toggle is the
	 * only aria-expanded button there. Our own triggers must not add to this count. */
	/* Already expanded inside the search loop above — toggling here would collapse it. */
	const toggles = [...card.querySelectorAll("button[aria-expanded]")].filter((node) => node.parentElement?.children?.[0]?.tagName === "INPUT");
	const cells = [...card.querySelectorAll("[data-model-metadata-cell]")];
	const rowOf = (node) => node.closest("li") === card;
	const entryOf = (toggle) => toggle.parentElement.parentElement;
	const insideEntry = cells.filter((cell) => toggles.some((toggle) => entryOf(toggle) === cell.parentElement)).length;
	const first = cells[0];
	const entry = first?.parentElement;
	const order = entry === undefined ? undefined : [...entry.children].map((node) => node.hasAttribute("data-model-metadata-cell") ? "cell" : node.querySelector("button[aria-expanded]") !== null ? "row" : "capacity");
	const labelled = first === undefined ? [] : [...first.querySelectorAll(":scope > div > span")].map((node) => node.textContent);
	const controls = first === undefined ? 0 : first.querySelectorAll("input, select").length;
	const edge = card.getBoundingClientRect();
	const overflowing = cells.flatMap((cell) => [...cell.querySelectorAll("input, select")]).filter((node) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.right > edge.right + 1; }).length;
	return {
		opened: true,
		rows: toggles.length,
		cells: cells.length,
		cellsInsideTheirOwnRow: insideEntry,
		entryOrder: order,
		labels: labelled,
		controlsPerCell: controls,
		readout: first?.querySelector("div span")?.textContent,
		/* Look, not just position: the injected controls must be indistinguishable
		 * from the row's own 容量 fields, so compare computed styles directly. */
		styleParity: (() => {
			if (first === undefined || entry === undefined) return undefined;
			/* Ours is the Menu trigger (there is no platform control any more); theirs is
			 * the row's own 容量 input, the widget this one must be indistinguishable from. */
			const theirs = entry.querySelector('input[inputMode="numeric"]') ?? entry.querySelector("input");
			const mine = first.querySelector("button[aria-haspopup='menu']");
			const theirLabel = theirs?.closest("label")?.querySelector("span") ?? null;
			const myLabel = first.querySelector("span");
			if (!(theirs instanceof Element) || !(mine instanceof Element)) return { sameBox: undefined, reason: "the row's own capacity grid is not expanded" };
			const pick = (node) => {
				if (!(node instanceof Element)) return undefined;
				const computed = getComputedStyle(node);
				return [computed.height, computed.fontSize, computed.borderRadius, computed.borderTopWidth, computed.paddingLeft, computed.color, computed.backgroundColor].join("|");
			};
			const theirLabelStyle = theirLabel instanceof Element ? getComputedStyle(theirLabel) : undefined;
			const myLabelStyle = myLabel instanceof Element ? getComputedStyle(myLabel) : undefined;
			return {
				sameBox: pick(theirs) === pick(mine),
				theirBox: pick(theirs),
				myBox: pick(mine),
				labelSame: theirLabelStyle !== undefined && myLabelStyle !== undefined && theirLabelStyle.fontSize === myLabelStyle.fontSize && theirLabelStyle.color === myLabelStyle.color,
				gap: getComputedStyle(first).gap,
				gridColumns: getComputedStyle(first).gridTemplateColumns
			};
		})(),
		overflowingControls: overflowing,
		stillInCard: rowOf(card),
		card: used,
		/* The pickers must be DSH's own in-page Menu, never the platform's sheet. */
		popup: await (async () => {
			const trigger = first?.querySelector("button[aria-haspopup='menu']");
			if (trigger === undefined) return undefined;
			trigger.click();
			await new Promise((resolve) => setTimeout(resolve, 500));
			const lists = [...card.querySelectorAll("[role='menu'], [role='listbox'], ul")].filter((node) => node.offsetParent !== null);
			const list = lists.at(-1);
			const items = list === undefined ? [] : [...list.querySelectorAll("li, [role='menuitem'], [role='menuitemradio']")];
			const style = list === undefined ? undefined : getComputedStyle(list);
			const shot = {
				triggerText: trigger.textContent.trim(),
				lists: lists.length,
				items: items.length,
				itemTexts: items.slice(0, 8).map((node) => node.textContent.trim()),
				background: style?.backgroundColor,
				radius: style?.borderRadius,
				zIndex: style?.zIndex,
				insideCard: list === undefined ? undefined : card.contains(list)
			};
			document.body.click();
			return shot;
		})()
	};
})()`);

/* `--edit`: enumerate what the shipped editor itself offers, so "which control
 * belongs to whom" is answered from the DOM rather than the source map. This is
 * how the capacity duplication was found: 编辑 → 自定义设置 → 模型目录 → each
 * row's 容量 grid already owns 上下文窗口 and 最大输出 token. */
let editor;
if (argv.includes("--edit")) {
	editor = await evaluate(`(() => {
		const cards = [...document.querySelectorAll("li")];
		const card = cards.find((node) => [...node.querySelectorAll("button")].some((b) => b.textContent.trim() === "取消" || b.textContent.trim() === "保存"));
		if (card === undefined) return { opened: false };
		return {
			opened: true,
			details: [...card.querySelectorAll("details")].map((node) => node.querySelector("summary")?.textContent.trim()),
			labels: [...card.querySelectorAll("span")].map((node) => node.textContent.trim()).filter((text) => text.length > 0 && text.length < 20),
			controls: [...card.querySelectorAll("input, select")].map((node) => ({ aria: node.getAttribute("aria-label"), placeholder: node.getAttribute("placeholder") })).slice(-6)
		};
	})()`);
}

/* Name-agnostic on purpose: the aggregate bundle URL carries the package name, and a
 * hardcoded one silently stopped matching the moment the package was renamed. */
const manifest = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
const aggregate = await evaluate("performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('plugins/??')).map((name) => name.split('&rev=')[0])");
/* No leading slash: after `??` the first id has none. */
const resources = aggregate.filter((url) => url.includes(`${manifest.name}/client.js`));
const body = await evaluate("document.body.innerText");
const report = {
	url,
	clicked: { settings: clickedSettings, models: clickedModels },
	bundleFetched: resources,
	aggregateBundle: aggregate.map((url) => url.split("??").at(-1)?.split(",").filter((id) => id.includes("client.js") && !id.startsWith("@deepseek-ai")).join(",") ?? url),
	ownBlock,
	fusion,
	editor,
	/* With no editor open this plugin shows nothing at all, so "is it alive?" is
	 * answered by the bundle fetch and the cells it mounts, not by its own text. */
	ownTextPresent: body.includes("目录回退"),
	cellsMounted: fusion?.cells ?? 0,
	bodyHead: body.slice(0, 1200),
	logs: logs.filter((line) => /catalog|model-metadata|slots|Cannot|Error|error/u.test(line)).slice(0, 40),
	logCount: logs.length
};

if (out !== undefined) {
	const shot = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(out, Buffer.from(shot.data, "base64"));
	report.screenshot = out;
}

console.log(JSON.stringify(report, null, 2));
if (chromeErrors.trim().length > 0 && (report.fusion?.cells ?? 0) === 0) console.log(`chromium stderr:\n${chromeErrors.split("\n").slice(-8).join("\n")}`);
socket.close();
chrome.kill("SIGKILL");
rmSync(profile, { recursive: true, force: true });
if (!existsSync(CHROME)) process.exit(2);
