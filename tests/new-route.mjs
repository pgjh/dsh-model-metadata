#!/usr/bin/env node
/**
 * new-route.mjs — "I just added a new custom API: will it be auto-matched?"
 *
 * Opt-in (it needs the running server and momentarily adds one throwaway provider
 * to settings.yaml, which it restores byte-for-byte):
 *
 *   node tests/new-route.mjs [--url <app url>]
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
 *
 * The page is driven through the shared CDP helper (`tests/cdp.mjs`); the exit code is
 * the verdict: 0 when all three layers answered, 2 when one of them failed.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adapterEntry } from "../dev-paths.mjs";
import { appUrl, openPage, sleep } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.DSH_HOME ?? join(process.env.HOME, ".dsh");
const SETTINGS = join(HOME, "settings.yaml");
const BACKUP = `${SETTINGS}.new-route-backup`;
const ROUTE = "zzprobe";
const MODELS = ["zzprobe/glm-5.3", "zzprobe/claude-opus-4-6", "zzprobe/whatever-9000"];
/* Resolve the app URL before anything else: the steps below write the throwaway route
 * into settings.yaml, and a run that cannot reach a page has no business doing that. */
const url = appUrl();

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
	/* Resolved inside the try: without the adapter installed, that is this step's answer,
	 * not a reason for the whole tool to stop before its host and UI checks. */
	const raw = execFileSync("node", [
		join(HERE, "..", "test-fallback.mjs"),
		"--source", adapterEntry(),
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

/* 2. the live plugin's own verdict — the fused readout's source. */
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
let session;
try {
	session = await openPage(url, { port: 9337, profile: join(HERE, ".browser-profile-newroute") });
	await session.click("设置");
	await sleep(1500);
	await session.click("模型");
	await sleep(3000);
	report.ui = await session.evaluate(`(async () => {
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
	report.ui.errors = session.exceptions;
} catch (error) {
	report.ui = { failure: error instanceof Error ? error.message : String(error) };
} finally {
	session?.close();
}

console.log(JSON.stringify(report, null, 2));
restore();

/*
 * The verdict, as an exit code: a run whose adapter, host or page step failed has not
 * answered the question this tool asks, and exiting 0 said it had.
 */
const answered = typeof report.adapter?.failure === "undefined"
	&& typeof report.host?.failure === "undefined"
	&& typeof report.ui?.failure === "undefined"
	&& report.ui?.card === true;
console.log(answered
	? "VERDICT ok: the adapter, the host route and the new card's editor all answered"
	: `VERDICT negative: adapter=${report.adapter?.failure === undefined ? "ok" : "failed"} host=${report.host?.failure === undefined ? "ok" : "failed"} ui=${report.ui?.failure === undefined ? (report.ui?.card === true ? "ok" : "no card") : "failed"}`);
if (!answered) process.exitCode = 2;
