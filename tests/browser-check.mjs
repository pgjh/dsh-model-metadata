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
 *   node tests/browser-check.mjs --out shot.png
 *
 * It opens the app, clicks 设置 → 模型, then prints: whether the panel's own
 * text is in the DOM, whether the bundle URL was fetched, every console message
 * and page error, and (with --out) a screenshot to look at. The verdict is the
 * exit code: 0 when the bundle was fetched and the fused cells mounted, 2 otherwise.
 *
 * The page is driven through the shared CDP helper (`tests/cdp.mjs`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appUrl, flag, openPage, option, sleep } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const url = appUrl();
const out = option("--out", undefined);
const session = await openPage(url, {
	port: option("--port", "9333"),
	window: option("--window", "1400,1000"),
	profile: join(HERE, ".browser-profile"),
	readyMs: 3000
});
const { send, evaluate, click, logs } = session;

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
		/* Exactly ONE caret per picker: the trigger draws DSH's chevron as a child, and
		 * must not also inherit one as a background image from a copied class — that
		 * combination is what showed two arrows until the select class stopped being
		 * merged into the trigger. */
		carets: (() => {
			const trigger = first?.querySelector("button[aria-haspopup='menu']");
			if (!(trigger instanceof Element)) return undefined;
			const computed = getComputedStyle(trigger);
			return {
				chevronChildren: trigger.querySelectorAll("svg").length,
				backgroundImage: computed.backgroundImage,
				paddingRight: computed.paddingRight,
				className: trigger.className
			};
		})(),
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
if (flag("--edit")) {
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
const noise = session.chromeErrors();
if (noise.trim().length > 0 && report.cellsMounted === 0) console.log(`chromium stderr:\n${noise.split("\n").slice(-8).join("\n")}`);
session.close();
/*
 * The verdict, said in the exit code as well as in the JSON: a run where the bundle was
 * never fetched or no fused cell mounted has found the regression this tool exists for,
 * and an exit status of 0 would report it as a success to whoever called the tool.
 */
const proved = report.bundleFetched.length > 0 && report.cellsMounted > 0;
console.log(proved
	? `VERDICT ok: ${String(report.cellsMounted)} fused cell(s) mounted, the client bundle was fetched`
	: `VERDICT negative: ${String(report.bundleFetched.length)} bundle fetch(es), ${String(report.cellsMounted)} fused cell(s)`);
if (!proved) process.exitCode = 2;
