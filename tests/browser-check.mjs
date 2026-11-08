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
 * DSH 0.2.2-rc.1 moved Settings out of the sidebar's 更多 menu into the
 * bottom-left 账号菜单 popup, so the way in is: click button[aria-label="账号菜单"],
 * click 设置 in that popup, wait for the role=dialog, then click 模型 in its nav.
 *
 * The models editor's rows changed shape too: the grid holding a row's 容量
 * disclosure no longer starts with the id input (a drag handle now precedes it),
 * so this tool identifies a row by the disclosure's own aria-label (模型选项 N),
 * with "the toggle's grid holds a text input" as the build-independent fallback.
 * A custom provider such as `cpa` keeps its rows behind the 自定义设置 summary,
 * which is opened before the first row is expanded.
 *
 * It reports which navigation steps clicked, which provider cards were tried,
 * how many rows each has, whether [data-model-metadata-cell] mounted, each
 * cell's exact text and placement inside its modelEntry, DSH's own expanded-row
 * controls (推理等级 / 输入类型), the bundle fetch, console/page errors, and
 * (with --out) a screenshot. The verdict is the exit code: 0 only when the
 * bundle was fetched, at least one cell mounted inside an expanded row, and its
 * readout carries 自动匹配 / 无匹配 (Auto-matched / no match); 2 otherwise.
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
const { send, evaluate, logs, exceptions } = session;

/** Poll a page expression until it is true, without blocking this process. */
const waitFor = async (expression, timeoutMs = 8000) => {
	for (let elapsed = 0; elapsed <= timeoutMs; elapsed += 250) {
		if ((await evaluate(expression)) === true) return true;
		await sleep(250);
	}
	return false;
};

/** Click the one element whose aria-label is exactly `label`. */
const clickAria = (label) => evaluate(`(() => {
	const node = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
	if (node === null) return false;
	node.click();
	return true;
})()`);

/** Click the first button/menuitem/tab under `scope` whose trimmed text is exactly `wanted`. */
const clickText = (scope, wanted) => evaluate(`(() => {
	const root = ${scope} ?? document;
	const node = [...root.querySelectorAll("button, [role=menuitem], [role=tab]")]
		.find((candidate) => candidate.textContent.trim() === ${JSON.stringify(wanted)});
	if (node === undefined) return false;
	node.click();
	return true;
})()`);

/* 1. Navigate the 0.2.2 way: account menu → 设置 → dialog → 模型. Every click is
 * recorded, because "the tool could not get there" must not look like "the page
 * has no cells". */
const nav = { accountMenu: false, settings: false, dialog: false, models: false };
nav.accountMenu = await clickAria("账号菜单");
if (nav.accountMenu) await sleep(900);
if (nav.accountMenu) {
	/* The popup's item is a menu entry in this build; older/newer builds may
	 * render it as a plain button, so fall back to the whole document. */
	nav.settings = await clickText('document.querySelector(\'[role="menu"]\')', "设置");
	if (!nav.settings) nav.settings = await clickText("document", "设置");
}
nav.dialog = nav.settings && await waitFor('document.querySelector(\'[role="dialog"]\') !== null', 10000);
nav.models = nav.dialog && await clickText('document.querySelector(\'[role="dialog"]\')', "模型");
await sleep(1800);

const cardsReady = nav.models && await waitFor(
	`[...document.querySelectorAll('[role="dialog"] li')].some((card) => [...card.querySelectorAll("button")].some((button) => button.textContent.trim() === "编辑"))`,
	8000
);

/* 2. Open provider cards and measure the fusion: every model row must carry the
 * plugin's cell INSIDE its own modelEntry, and DSH's native expanded controls
 * must be visible next to it so the tool can tell the two apart. Nothing here is
 * assumed to have mounted: the run reports 0 cells as a finding, not a crash. */
/* Nothing of this plugin's may be on the page while no card editor is open: the
 * seat renders cells INTO an open editor, never a block of its own. Reported rather
 * than gated — the fusion result below is what this tool exists to prove. */
const strayWhileClosed = await evaluate('document.querySelectorAll("[data-model-metadata-cell]").length');

const scan = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const ATTR = "data-model-metadata-cell";
	const PREFERRED = ${JSON.stringify(option("--card", ""))};
	const MAX_CARDS = ${JSON.stringify(Number(option("--cards", "6")))};
	/* --all keeps scanning after the first card with cells, so an after-fix run can
	 * report every provider's rows instead of stopping at the first match. */
	const ALL = ${JSON.stringify(flag("--all"))};
	const dialog = document.querySelector('[role="dialog"]') ?? document.body;
	const cards = [...dialog.querySelectorAll("li")].filter((card) =>
		[...card.querySelectorAll("button")].some((button) => button.textContent.trim() === "编辑"));
	/* An optional --card substring moves the wanted card first; the deployment's
	 * first card is often a provider family this plugin does not serve, and a
	 * regression run should not depend on card order. */
	const ordered = PREFERRED.length === 0
		? cards
		: [...cards].sort((a, b) => Number(b.textContent.includes(PREFERRED)) - Number(a.textContent.includes(PREFERRED)));
	const isRowToggle = (toggle) => {
		if (toggle.closest("[" + ATTR + "]") !== null) return false;
		/* Our own pickers carry aria-expanded as well; the menu hint tells them apart. */
		if (toggle.getAttribute("aria-haspopup") === "menu") return false;
		if (/模型选项/u.test(toggle.getAttribute("aria-label") ?? "")) return true;
		/* Fallback for a build without that label: the row's grid holds its id input. */
		return toggle.parentElement?.querySelector("input") !== null;
	};
	const entryOf = (toggle) => toggle.closest("[class*=modelEntry]") ?? toggle.parentElement?.parentElement ?? null;
	const describe = (node) => node === null || node === undefined
		? null
		: { tag: node.tagName.toLowerCase(), cls: String(node.className ?? "").slice(0, 80) };
	const squash = (text) => String(text ?? "").replace(/\\s+/gu, " ").trim();
	const results = [];
	const list = ordered.slice(0, MAX_CARDS);
	/* Remember the last expanded entry: with no cell to scroll to (the broken state),
	 * that is what the --out screenshot should still show. */
	let lastExpandedEntry = null;
	for (let index = 0; index < list.length; index++) {
		const card = list[index];
		const result = {
			label: squash(card.textContent).slice(0, 72),
			rows: 0,
			cellsBeforeExpand: 0,
			expandedRows: 0,
			cells: 0,
			cellsInExpandedRow: 0,
			readouts: [],
			readoutsAll: [],
			observed: [],
			native: null,
			errorBoundaryText: card.textContent.includes("此行的元数据控件加载失败"),
			closed: false
		};
		const edit = [...card.querySelectorAll("button")].find((button) => button.textContent.trim() === "编辑");
		if (edit === undefined) { result.skipped = "no 编辑 button"; results.push(result); continue; }
		edit.click();
		await sleep(1500);
		/* A custom provider (cpa, for one) keeps its model rows behind 自定义设置. */
		const summary = [...card.querySelectorAll("summary")].find((node) => node.textContent.includes("自定义设置"));
		if (summary !== undefined && summary.parentElement?.open !== true) {
			summary.click();
			await sleep(1400);
		}
		await sleep(300);
		let toggles = [...card.querySelectorAll("button[aria-expanded]")].filter(isRowToggle);
		result.rows = toggles.length;
		result.cellsBeforeExpand = card.querySelectorAll("[" + ATTR + "]").length;
		/* Rows are collapsed by default: open the first one so its own advanced grid
		 * (上下文窗口 / 最大输出 token 数 / 输入类型 …) is on the page next to the cell. */
		if (toggles[0] !== undefined) {
			toggles[0].click();
			await sleep(1000);
		}
		toggles = [...card.querySelectorAll("button[aria-expanded]")].filter(isRowToggle);
		const expanded = toggles.filter((toggle) => toggle.getAttribute("aria-expanded") === "true");
		result.expandedRows = expanded.length;
		result.cells = card.querySelectorAll("[" + ATTR + "]").length;
		const expandedEntry = expanded[0] === undefined ? null : entryOf(expanded[0]);
		lastExpandedEntry = expandedEntry ?? lastExpandedEntry;
		if (expandedEntry !== null) result.cellsInExpandedRow = expandedEntry.querySelectorAll("[" + ATTR + "]").length;
		const advanced = expandedEntry?.querySelector("[class*=modelAdvanced]") ?? null;
		result.native = {
			advancedText: advanced === null ? null : squash(advanced.textContent).slice(0, 400),
			hasReasoning: advanced === null ? null : /推理等级/u.test(advanced.textContent),
			hasInputType: advanced === null ? null : /输入类型/u.test(advanced.textContent)
		};
		result.observed = [...card.querySelectorAll("[" + ATTR + "]")].slice(0, 3).map((cell) => {
			const entry = cell.closest("[class*=modelEntry]") ?? cell.parentElement;
			const children = entry === null ? [] : [...entry.children];
			const kinds = children.map((node) =>
				node.hasAttribute(ATTR) ? "cell"
					: node.querySelector("button[aria-expanded]") !== null ? "row"
						: "other");
			const ownLabel = (node) => node.getAttribute("aria-label") ?? null;
			/* The row grid inside its entry: the child that is not our cell and holds a
			 * disclosure button. Its first text input is the row's id (0.2.2 wraps both
			 * inputs in <label>s, so the id attribute is not guaranteed). */
			const rowGrid = children.find((node) => !node.hasAttribute(ATTR) && node.querySelector("button[aria-expanded]") !== null) ?? null;
			return {
				/* The readout-only cell (0.2.2+) draws a plain <p>; the picker cell draws one with
				 * role=status. Either is the readout this tool reports. */
				readout: (cell.querySelector('p[role="status"]') ?? cell.querySelector("p"))?.textContent ?? null,
				text: squash(cell.textContent).slice(0, 240),
				captions: [...cell.querySelectorAll("span")].map(squash).filter((text) => text.length > 0 && text.length < 24).slice(0, 6),
				pickers: cell.querySelectorAll('button[aria-haspopup="menu"]').length,
				buttons: cell.querySelectorAll("button").length,
				inputs: cell.querySelectorAll("input, select").length,
				placement: {
					parent: describe(cell.parentElement),
					entry: describe(entry),
					entryChildren: kinds,
					cellIndex: children.indexOf(cell)
				},
				row: {
					id: (rowGrid?.querySelector('input[id]') ?? rowGrid?.querySelector('input[type="text"]'))?.value ?? null,
					expanded: expandedEntry !== null && entry === expandedEntry,
					toggleAria: expanded[0] === undefined ? null : ownLabel(expanded[0])
				}
			};
		});
		result.readouts = result.observed.map((cell) => squash(cell.readout)).filter((text) => text.length > 0);
		/* Every row's readout, not only the three described above: a row whose name no
		 * catalog knows must still be visible as 无匹配 in the report. */
		result.readoutsAll = [...card.querySelectorAll("[" + ATTR + "]")]
			.map((cell) => squash(cell.textContent)).filter((text) => text.length > 0).slice(0, 16);
		/* Keep a card only if it produced cells; otherwise close its editor before the
		 * next card so two editors cannot confuse the row search — except the last one,
		 * which stays open so the screenshot shows the row the tool measured. --all
		 * deliberately leaves every editor open to report all cards. */
		if (result.cells > 0 && !ALL) { results.push(result); break; }
		if (result.cells === 0 && index < list.length - 1) {
			const cancel = [...card.querySelectorAll("button")].find((button) => button.textContent.trim() === "取消");
			if (cancel !== undefined) { cancel.click(); await sleep(700); result.closed = true; }
		}
		results.push(result);
	}
	return {
		cardsFound: cards.length,
		preferred: PREFERRED,
		cards: results,
		/* Scroll the first cell into view so the --out screenshot actually shows the
		 * readout instead of the top of a long card; fall back to the expanded row. */
		scrolled: (() => {
			const target = dialog.querySelector("[" + ATTR + "]") ?? lastExpandedEntry;
			if (target === null) return false;
			target.scrollIntoView({ block: "center" });
			return true;
		})()
	};
})()`);

/* 3. What the page loaded: the aggregate plugin bundle must carry this package's
 * client.js, and the failure boundary must not be on the page. The resource
 * filter is name-agnostic (the package name comes from package.json) because a
 * hardcoded one stops matching the moment the package is renamed. */
const manifest = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
const resources = await evaluate("performance.getEntriesByType('resource').map((entry) => entry.name)");
const bundleFetched = resources.filter((name) => name.includes(`${manifest.name}/client.js`));
const aggregate = resources.filter((name) => name.includes("??"));
const body = await evaluate("document.body.innerText");
const cells = (scan?.cards ?? []).flatMap((card) => card.observed);
const allReadoutTexts = (scan?.cards ?? []).flatMap((card) => card.readoutsAll ?? []);
const readoutOk = allReadoutTexts.some((text) => /自动匹配|无匹配|Auto-matched/iu.test(text));
const cardsWithCells = (scan?.cards ?? []).filter((card) => card.cellsInExpandedRow > 0);

const report = {
	url,
	nav: { clicked: nav, cardsReady },
	scan,
	bundle: {
		fetched: bundleFetched,
		aggregate: aggregate.map((name) => name.split("??").at(-1) ?? name),
		pluginResourceCount: resources.filter((name) => name.includes("plugins/")).length
	},
	cells: {
		strayWhileClosed,
		rowsWithCells: cardsWithCells.length,
		mountedInExpandedRow: cardsWithCells.reduce((total, card) => total + card.cellsInExpandedRow, 0),
		observed: cells,
		readoutTexts: allReadoutTexts,
		readoutOk
	},
	errorBoundaryText: body.includes("此行的元数据控件加载失败"),
	pageExceptions: exceptions.slice(0, 10),
	logs: logs.map((line) => line.replace(/\s+/gu, " ").slice(0, 500)).slice(0, 60),
	logCount: logs.length
};

if (out !== undefined) {
	const shot = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(out, Buffer.from(shot.data, "base64"));
	report.screenshot = out;
}

console.log(JSON.stringify(report, null, 2));
const noise = session.chromeErrors();
if (noise.trim().length > 0 && !readoutOk) console.log(`chromium stderr:\n${noise.split("\n").slice(-8).join("\n")}`);
session.close();
/*
 * The verdict, said in the exit code as well as in the JSON: a run where the
 * bundle was never fetched, no fused cell mounted, or the cell carries no
 * readout has found the regression this tool exists for, and an exit status of 0
 * would report it as a success to whoever called the tool.
 */
const mounted = report.cells.mountedInExpandedRow;
const proved = report.bundle.fetched.length > 0 && mounted > 0 && readoutOk;
console.log(proved
	? `VERDICT ok: ${String(mounted)} fused cell(s) mounted in an expanded row, readout ${allReadoutTexts.filter((text) => /自动匹配|无匹配|Auto-matched/iu.test(text)).slice(0, 4).map((text) => `"${text}"`).join(" | ")}`
	: `VERDICT negative: ${String(report.bundle.fetched.length)} bundle fetch(es), ${String(mounted)} cell(s) in an expanded row, readout ${readoutOk ? "present" : "missing"}`);
if (!proved) process.exitCode = 2;
