#!/usr/bin/env node
/**
 * fusion-live.mjs — the live regression gate for the fused model-row cell.
 *
 * Exits 0 only when the real Web UI (DSH 0.2.2-rc.1) mounts at least one
 * [data-model-metadata-cell] INSIDE AN EXPANDED model row and that cell's
 * readout carries 自动匹配 / 无匹配 (Auto-matched / no match). Exits 2 in every
 * other case — no navigation, no cards, no rows, no cell, or a cell whose
 * readout is missing — so a broken build can never pass by silence.
 *
 *   node tests/fusion-live.mjs --url "http://127.0.0.1:3080/?token=…" [--card cpa] [--out .shots/fusion-live.png]
 *
 * Navigation is the 0.2.2 path: button[aria-label="账号菜单"] → 设置 → the
 * role=dialog's 模型 nav → a provider card's 编辑 → its 自定义设置 summary (custom
 * providers such as cpa hide their rows there) → the first row's 模型选项 N
 * disclosure. The shared CDP driver is tests/cdp.mjs; the Chromium profile is
 * tests/.browser-profile; no other dependency is used.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appUrl, openPage, option, sleep } from "./cdp.mjs";

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

/** Poll a page expression until it is true. */
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

/* 1. The 0.2.2 way into Settings → 模型. */
const nav = { accountMenu: false, settings: false, dialog: false, models: false };
nav.accountMenu = await clickAria("账号菜单");
if (nav.accountMenu) await sleep(900);
if (nav.accountMenu) {
	nav.settings = await clickText('document.querySelector(\'[role="menu"]\')', "设置");
	if (!nav.settings) nav.settings = await clickText("document", "设置");
}
nav.dialog = nav.settings && await waitFor('document.querySelector(\'[role="dialog"]\') !== null', 10000);
nav.models = nav.dialog && await clickText('document.querySelector(\'[role="dialog"]\')', "模型");
await sleep(1500);

/* 2. Open cards until one mounts the cell inside its expanded row, and say
 * exactly what was found there. */
const scan = await evaluate(`(async () => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const ATTR = "data-model-metadata-cell";
	const PREFERRED = ${JSON.stringify(option("--card", ""))};
	const dialog = document.querySelector('[role="dialog"]') ?? null;
	if (dialog === null) return { navigated: false, cards: [] };
	const cards = [...dialog.querySelectorAll("li")].filter((card) =>
		[...card.querySelectorAll("button")].some((button) => button.textContent.trim() === "编辑"));
	const ordered = PREFERRED.length === 0
		? cards
		: [...cards].sort((a, b) => Number(b.textContent.includes(PREFERRED)) - Number(a.textContent.includes(PREFERRED)));
	const isRowToggle = (toggle) => {
		if (toggle.closest("[" + ATTR + "]") !== null) return false;
		if (toggle.getAttribute("aria-haspopup") === "menu") return false;
		if (/模型选项/u.test(toggle.getAttribute("aria-label") ?? "")) return true;
		return toggle.parentElement?.querySelector("input") !== null;
	};
	const squash = (text) => String(text ?? "").replace(/\\s+/gu, " ").trim();
	const tried = [];
	let pass = null;
	for (const card of ordered.slice(0, 6)) {
		const rows = [];
		const result = { label: squash(card.textContent).slice(0, 60), rows: 0, expandedRows: 0, cells: 0, readout: null };
		const edit = [...card.querySelectorAll("button")].find((button) => button.textContent.trim() === "编辑");
		if (edit === undefined) { tried.push(result); continue; }
		edit.click();
		await sleep(1400);
		const summary = [...card.querySelectorAll("summary")].find((node) => node.textContent.includes("自定义设置"));
		if (summary !== undefined && summary.parentElement?.open !== true) { summary.click(); await sleep(1200); }
		await sleep(300);
		let toggles = [...card.querySelectorAll("button[aria-expanded]")].filter(isRowToggle);
		result.rows = toggles.length;
		if (toggles[0] !== undefined) { toggles[0].click(); await sleep(900); }
		toggles = [...card.querySelectorAll("button[aria-expanded]")].filter(isRowToggle);
		const expanded = toggles.filter((toggle) => toggle.getAttribute("aria-expanded") === "true");
		result.expandedRows = expanded.length;
		for (const toggle of expanded) {
			const entry = toggle.closest("[class*=modelEntry]") ?? toggle.parentElement?.parentElement ?? null;
			if (entry === null) continue;
			for (const cell of entry.querySelectorAll("[" + ATTR + "]")) {
				rows.push({
					text: squash(cell.textContent).slice(0, 200),
					/* A readout-only cell draws a plain <p>; an older build draws role=status. */
					readout: squash((cell.querySelector('p[role="status"]') ?? cell.querySelector("p"))?.textContent),
					pickers: cell.querySelectorAll('button[aria-haspopup="menu"]').length,
					cellIndex: [...entry.children].indexOf(cell),
					entryChildren: [...entry.children].map((node) => node.hasAttribute(ATTR) ? "cell" : node.querySelector("button[aria-expanded]") !== null ? "row" : "other")
				});
			}
		}
		result.cells = rows.length;
		result.readout = rows[0]?.readout ?? null;
		result.observed = rows.slice(0, 2);
		tried.push(result);
		if (rows.some((row) => /自动匹配|无匹配|Auto-matched/iu.test(row.readout))) { pass = result; break; }
		const cancel = [...card.querySelectorAll("button")].find((button) => button.textContent.trim() === "取消");
		if (cancel !== undefined && card !== ordered.at(-1)) { cancel.click(); await sleep(600); }
	}
	const cell = pass === null ? null : dialog.querySelector("[" + ATTR + "]");
	cell?.scrollIntoView({ block: "center" });
	return { navigated: true, cardsFound: cards.length, tried, pass };
})()`);

if (out !== undefined) {
	const shot = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(out, Buffer.from(shot.data, "base64"));
}

const readoutOk = (scan?.tried ?? []).some((card) => (card.observed ?? []).some((row) => /自动匹配|无匹配|Auto-matched/iu.test(row.readout)));
const summary = {
	url,
	nav,
	cards: (scan?.tried ?? []).map((card) => ({ label: card.label, rows: card.rows, expandedRows: card.expandedRows, cells: card.cells, readout: card.readout })),
	readouts: (scan?.tried ?? []).flatMap((card) => (card.observed ?? []).map((row) => row.readout)).filter((text) => text.length > 0),
	cellsMounted: (scan?.tried ?? []).reduce((total, card) => total + card.cells, 0),
	readoutOk,
	errorBoundaryText: null,
	pageExceptions: exceptions.slice(0, 10),
	logCount: logs.length,
	screenshot: out
};
summary.errorBoundaryText = await evaluate("document.body.innerText.includes('此行的元数据控件加载失败')");
console.log(JSON.stringify(summary, null, 2));
session.close();

/* 3. The gate: exit 0 only on a mounted cell with a match/no-match readout. */
if (readoutOk) {
	const readout = summary.readouts.find((text) => /自动匹配|无匹配|Auto-matched/iu.test(text));
	console.log(`FUSION-LIVE ok: ${String(summary.cellsMounted)} cell(s) mounted, readout "${readout}"`);
	process.exit(0);
}
console.log(`FUSION-LIVE negative: ${String(summary.cellsMounted)} cell(s) mounted, readout ${readoutOk ? "present" : "missing"}; nav=${JSON.stringify(nav)}`);
process.exit(2);
