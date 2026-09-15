#!/usr/bin/env node
/**
 * fusion-write.mjs — prove the fused controls actually write.
 *
 * Diagnostic tool, not part of `verify.mjs` (it needs the running server, a
 * Chromium build, and it mutates the real settings document for a moment):
 *
 *   node tests/fusion-write.mjs                 # newest launch token from journalctl
 *   node tests/fusion-write.mjs --card <provider>   # default: the first provider card
 *   node tests/fusion-write.mjs --keep              # leave the written value in place
 *
 * It backs up settings.yaml, drives the real UI (设置 → 模型 → 编辑 → the first model
 * row's fused 推理等级 control → 写入), then reports:
 *   - what the row's own note said;
 *   - whether the host's matrix route now reports the declaration (i.e. the write
 *     reached the settings layer and came back through the resolver);
 *   - whether the write touched anything else in `models[]`.
 * settings.yaml is restored byte-for-byte before the process exits, on any path, unless
 * `--keep` asks for the written value to stay (then the pre-write copy stays beside it).
 * The verdict is the exit code: 0 when a pending edit really went in and the row became
 * clean again, 2 when it did not.
 *
 * The page is driven through the shared CDP helper (`tests/cdp.mjs`).
 */
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appUrl, flag, openPage, option, sleep } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.DSH_HOME ?? join(process.env.HOME, ".dsh");
const SETTINGS = join(HOME, "settings.yaml");
const BACKUP = `${SETTINGS}.fusion-write-backup`;

const url = appUrl();
/* Empty unless asked: whatever provider the deployment's first card holds. */
let card = option("--card", "");
const keep = flag("--keep");

/* Back up first: nothing below may leave the user's settings changed. */
const original = readFileSync(SETTINGS);
copyFileSync(SETTINGS, BACKUP);
let restored = false;
const restore = () => {
	if (restored || keep) return;
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

const session = await openPage(url, {
	port: option("--port", "9335"),
	profile: join(HERE, ".browser-profile-write"),
	readyMs: 2500
});
const { evaluate } = session;

await session.click("设置");
await sleep(1500);
await session.click("模型");
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
	/* The 写入 control exists only while the row differs from what is stored, so its
	 * presence *is* the dirty signal. Its inline style is empty whenever it is rendered,
	 * which is what made the old \`style.display !== "none"\` check true by construction. */
	const writeButton = () => [...cell.querySelectorAll("button")].find((node) => node.textContent.trim() === "写入");
	const noteOf = () => cell.lastElementChild?.querySelector("p")?.textContent?.trim();
	const beforeLabel = trigger.textContent.trim();
	const cleanBefore = writeButton() === undefined;
	const readoutBefore = noteOf();
	trigger.click();
	await new Promise((resolve) => setTimeout(resolve, 500));
	const items = [...document.querySelectorAll("[role='menuitem'],[role='menuitemradio'],li")].filter((node) => node.offsetParent !== null);
	const labels = items.map((node) => node.textContent.trim());
	const item = items.find((node) => node.textContent.trim() === ${JSON.stringify(WANTED_LABEL)});
	if (item === undefined) return { found: true, trigger: true, picked: false, labels: labels.slice(-10) };
	item.click();
	await new Promise((resolve) => setTimeout(resolve, 300));
	return {
		found: true,
		trigger: true,
		picked: true,
		beforeLabel,
		readoutBefore,
		afterLabel: trigger.textContent.trim(),
		labelChanged: trigger.textContent.trim() !== beforeLabel,
		cleanBefore,
		dirtyAppeared: writeButton() !== undefined,
		model: cell.parentElement?.children?.[0]?.children?.[0]?.value
	};
})()`);
/* The look flips in a later tick: React commits the choice, then the button appears. */
await sleep(600);
const settled = await evaluate(`(() => {
	const cell = document.querySelector("[data-model-metadata-cell]");
	const trigger = cell.querySelector("button[aria-haspopup='menu']");
	const write = [...cell.querySelectorAll("button")].find((node) => node.textContent.trim() === "写入");
	return { value: trigger.textContent.trim(), dirty: write !== undefined };
})()`);

let outcome = { skipped: "no cell found" };
if (setting.found === true && setting.dirtyAppeared === true) {
	const clicked = await evaluate(`(() => {
		const cell = document.querySelector("[data-model-metadata-cell]");
		[...cell.querySelectorAll("button")].find((node) => node.textContent.trim() === "写入").click();
		return true;
	})()`);
	await sleep(1200);
	const noteRightAfter = await evaluate(`document.querySelector("[data-model-metadata-cell]")?.lastElementChild?.querySelector("p")?.textContent`);
	await sleep(2000);
	const storedAfter = (await matrixOf(card)).models[0].stored;
	const finished = await evaluate(`(() => {
		const cell = document.querySelector("[data-model-metadata-cell]");
		const write = [...cell.querySelectorAll("button")].find((node) => node.textContent.trim() === "写入");
		return { note: cell.lastElementChild?.querySelector("p")?.textContent?.trim(), dirty: write !== undefined };
	})()`);
	const keys = (entry) => Object.keys(entry).sort();
	outcome = {
		written: storedAfter.reasoningEfforts,
		expected: { off: null, low: "low", medium: "medium", high: "high" },
		clicked,
		noteRightAfter,
		matches: JSON.stringify(storedAfter.reasoningEfforts) === JSON.stringify({ off: null, low: "low", medium: "medium", high: "high" }),
		note: finished.note,
		/* The control is rendered only while the row is dirty: it had to be absent before
		 * the pick, present after it, and absent again once the write settled. */
		cleanBefore: setting.cleanBefore === true,
		dirtyAppeared: setting.dirtyAppeared === true,
		dirtyCleared: finished.dirty === false,
		readoutBefore: setting.readoutBefore,
		readoutChanged: finished.note !== setting.readoutBefore,
		noteSaysWritten: typeof finished.note === "string" && finished.note.includes("已写入"),
		report: finished.note,
		keysBefore: keys(storedBefore),
		keysAfter: keys(storedAfter),
		capacityUntouched: storedAfter.contextWindow === storedBefore.contextWindow && storedAfter.maxTokens === storedBefore.maxTokens
	};
}

const report = { url, card, opened, setting, settled, outcome, errors: session.logs.filter((line) => /catalog|Cannot|Error/u.test(line)) };
console.log(JSON.stringify(report, null, 2));
session.close();

/* Report the file's own state, then restore (or keep, when that is what was asked). */
restore();
if (keep) console.log(`--keep: ${SETTINGS} keeps the written value; the pre-write copy is ${BACKUP}`);

/*
 * The verdict, as an exit code: the tool exists to catch a fused control that stops
 * writing, and printing JSON while exiting 0 reported every such run as a success.
 */
const proved = outcome.matches === true && outcome.readoutChanged === true && outcome.dirtyAppeared === true && outcome.dirtyCleared === true && outcome.capacityUntouched === true;
console.log(proved
	? "VERDICT ok: the pending edit landed in settings, the row's readout followed it, and the row went clean again"
	: `VERDICT negative: ${outcome.skipped ?? `matches=${String(outcome.matches)} readoutChanged=${String(outcome.readoutChanged)} dirtyAppeared=${String(outcome.dirtyAppeared)} dirtyCleared=${String(outcome.dirtyCleared)} capacityUntouched=${String(outcome.capacityUntouched)}`}`);
if (!proved) process.exitCode = 2;
