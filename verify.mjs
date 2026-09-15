#!/usr/bin/env node
/**
 * verify.mjs — the acceptance test for the local metadata fallback. Runs the
 * adapter out of the real install (never modified) with and without the plugin,
 * and asserts the exact rows the two behaviours must produce.
 *
 *   node verify.mjs            # all scenarios, PASS/FAIL per assertion
 *   node verify.mjs --verbose  # print every resolved row as well
 *
 * Exit code 0 means: the pristine adapter still reports route defaults (so the
 * "problem" is real and the vendor file is untouched), and the plugin fixes
 * context window, output cap and reasoning levels without touching route-owned
 * fields or overriding explicit settings.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { adapterEntry, nodeModulesDir } from "./dev-paths.mjs";
import { pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const verbose = process.argv.includes("--verbose");
const ADAPTER = adapterEntry();
const NODE_MODULES = nodeModulesDir();
const PLUGIN = process.env.DSH_CATALOG_FALLBACK_PLUGIN ?? join(HERE, "lib/index.mjs");
const PRECEDENCE = join(HERE, "tests/settings-precedence.yaml");
const SNAPSHOT = join(HERE, "tests/snapshot-fixture.json");

if (!existsSync(ADAPTER)) {
	console.error(`no adapter at ${ADAPTER}; set DSH_INSTALL to a lib directory that has it`);
	process.exit(1);
}
/*
 * Pin the models.dev tier to a two-entry fixture rather than to whatever snapshot
 * happens to be installed in $DSH_HOME: the suite then says the same thing on any
 * machine and on any day, and the repository carries no large regenerated data file.
 */
if (existsSync(SNAPSHOT)) process.env.DSH_PI_AI_CATALOG_SNAPSHOT = SNAPSHOT;

/**
 * Run one scenario through test-fallback.mjs. The refresh policy is disabled for
 * these runs: they must judge the resolution logic against a known document,
 * never against a file a background fetch may replace mid-test.
 * @param args - arguments for the child.
 * @param env - extra environment for the child.
 * @returns the spawn result, for the scenarios that assert on stderr as well.
 */
function runRaw(args, env = {}) {
	/* The rows come back through a file rather than stdout: parsing a child's output
	 * for the first `[` broke the moment the child printed a line containing one, and
	 * a banner is not a protocol. */
	const dir = mkdtempSync(join(tmpdir(), `dsh-mm-verify-${String(process.pid)}-`));
	const out = join(dir, "rows.json");
	try {
		const result = spawnSync(process.execPath, [join(HERE, "test-fallback.mjs"), "--json-out", out, ...args], { encoding: "utf8", env: { ...process.env, DSH_PI_AI_CATALOG_REFRESH: "0", ...env } });
		const rows = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined;
		return { ...result, rows };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * One scenario's JSON rows.
 * @param args - arguments for the child.
 * @param env - extra environment for the child.
 * @returns the rows the child printed.
 */
function run(args, env = {}) {
	const result = runRaw(args, env);
	if (result.status !== 0 || result.rows === undefined) {
		console.error(result.stderr || result.stdout);
		process.exit(1);
	}
	return result.rows;
}

const failures = [];
let checks = 0;
function expect(label, actual, wanted) {
	checks++;
	const ok = JSON.stringify(actual) === JSON.stringify(wanted);
	if (!ok) failures.push(`${label}\n    expected ${JSON.stringify(wanted)}\n    actual   ${JSON.stringify(actual)}`);
	if (verbose || !ok) console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -> ${JSON.stringify(actual)}`}`);
}
const rowOf = (rows, id) => {
	const row = rows.find((entry) => entry.id === id);
	if (row === undefined) throw new Error(`no row for ${id}`);
	return row;
};

/*
 * Scenario 1 runs the installed adapter WITHOUT the plugin: it must still report
 * the route defaults, which is both the reported problem and the proof that the
 * vendor file is untouched. (If a source patch were ever applied to it, this
 * assertion is what would catch that.)
 */
const baseline = run(["--source", ADAPTER, "--node-modules", NODE_MODULES]);
expect("baseline: prefixed model falls back to the route defaults", rowOf(baseline, "probe/glm-5.3").contextWindow, 262144);
expect("baseline: no reasoning levels offered", rowOf(baseline, "probe/glm-5.3").reasoning, []);

/* Scenario 2: the plugin against the untouched install. */
const plugin = run(["--source", ADAPTER, "--plugin", PLUGIN]);
const glm = rowOf(plugin, "probe/glm-5.3");
expect("plugin: glm-5.3 matches zai, context window filled in", glm.contextWindow, 1000000);
expect("plugin: glm-5.3 matches zai, output cap filled in", glm.maxTokens, 131072);
expect("plugin: glm-5.3 matches zai, reasoning levels filled in", glm.reasoning, ["low", "high", "max"]);
expect("plugin: upstream wins for gpt-5.4 (openai, not azure)", rowOf(plugin, "probe/gpt-5.4").contextWindow, 272000);
expect("plugin: the vendor's own catalog answers by display name (minimax-m3)", [rowOf(plugin, "probe/minimax-m3").contextWindow, rowOf(plugin, "probe/minimax-m3").maxTokens], [1048576, 512000]);
/*
 * The official deepseek-official route keeps its catalog in its own package, so
 * the chain must consult it explicitly: the V41 flash's three spellings — the
 * route's display name "DeepSeek-V41-Flash", the models.dev id
 * deepseek-v4.1-flash, and the undotted alias — all name one model.
 */
expect("plugin: the official deepseek catalog answers the v41 alias", rowOf(plugin, "probe/deepseek-v41-flash").contextWindow, 1000000);
expect("plugin: the alias gets the official route's own effort levels", rowOf(plugin, "probe/deepseek-v41-flash").reasoning, ["off", "low", "high", "max"]);
expect("plugin: the dotted v4.1 spelling matches the same model", rowOf(plugin, "probe/deepseek-v4.1-flash").contextWindow, 1000000);
expect("plugin: a name missing the catalog's -exp suffix still matches", rowOf(plugin, "probe/DeepSeek-V4-Flash-Vision").input, ["text", "image"]);
expect("plugin: the models.dev tier covers a model no bundled catalog has", rowOf(plugin, "probe/zephyr-9-pro").contextWindow, 900000);
/*
 * Aggregators mirror other people's catalogs, so a catalog route that carries
 * the same name must outrank them (opencode-go says 1000000 for longcat-2.0,
 * openrouter's own entry says 1048756 and wins).
 */
expect("plugin: a catalog route outranks the aggregator for the same name", rowOf(plugin, "probe/longcat-2.0").contextWindow, 1048756);
expect("plugin: a model nothing describes keeps the route default", rowOf(plugin, "probe/unknown-model-x").contextWindow, 262144);
expect("plugin: a model nothing describes offers no levels", rowOf(plugin, "probe/unknown-model-x").reasoning, []);
/*
 * Hy/hunyuan has no vendor route of its own — only opencode-go carries it — so
 * the aggregator stays that family's upstream: a bare `hy4-preview` must not
 * fall to the same-named entries other catalogs hold.
 */
expect("plugin: the hy family keeps its aggregator upstream", rowOf(plugin, "probe/hy4-preview").contextWindow, 1024000);
expect("plugin: the route's own api is kept", glm.api, "openai-responses");
expect("plugin: the route's own baseUrl is kept", glm.baseUrl, "http://127.0.0.1:1/v1");
expect("plugin: catalog cost is not copied in", glm.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
expect("plugin: catalog compat is not copied in", glm.compat, undefined);

/* Scenario 3: explicit settings always win. */
const declared = run(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", PRECEDENCE]);
expect("declared: explicit contextWindow survives", rowOf(declared, "probe/gpt-5.4").contextWindow, 64000);
expect("declared: explicit maxTokens survives", rowOf(declared, "probe/gpt-5.4").maxTokens, 8000);
expect("declared: reasoningEfforts: false is respected", rowOf(declared, "probe/gpt-5.4").reasoning, []);
expect("declared: an explicit level subset is respected", rowOf(declared, "probe/kimi-k3").reasoning, ["low", "high"]);
expect("declared: the rest of that model is still filled in", rowOf(declared, "probe/kimi-k3").contextWindow, 1048576);
/* A declaration this plugin's own UI writes: the chain knows the name as
 * image-capable, and the row must keep saying text-only. */
expect("declared: an explicit input list survives the chain", rowOf(declared, "probe/glm-5v-turbo").input, ["text"]);

/*
 * Scenario 4: input modalities ride the same chain by default, with narrower
 * settings available, because claiming image support an endpoint lacks fails a
 * turn instead of refusing the attachment.
 */
expect("input: the chain decides images by default", rowOf(plugin, "probe/glm-5v-turbo").input, ["text", "image"]);
expect("input: a text-only upstream keeps the model text-only", rowOf(plugin, "probe/glm-5.3").input, ["text"]);
expect("input: the official route's own vision model declares image", rowOf(plugin, "probe/deepseek-v41-flash").input, ["text", "image"]);
const noInput = run(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK_INPUT: "off" });
expect("input=off: no modality is filled in", rowOf(noInput, "probe/glm-5v-turbo").input, ["text"]);
const withInput = run(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK_INPUT: "on" });
expect("input=on: a vision model declares image", rowOf(withInput, "probe/glm-5v-turbo").input, ["text", "image"]);
expect("input=on: a models.dev-only claim is honoured too", rowOf(withInput, "probe/zephyr-9-pro").input, ["text", "image"]);
const bundledOnly = run(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK_INPUT: "bundled" });
expect("input=bundled: the shipped catalog's claim still applies", rowOf(bundledOnly, "probe/glm-5v-turbo").input, ["text", "image"]);
expect("input=bundled: the official deepseek catalog counts as shipped", rowOf(bundledOnly, "probe/deepseek-v41-flash").input, ["text", "image"]);
expect("input=bundled: a models.dev-only claim is ignored", rowOf(bundledOnly, "probe/zephyr-9-pro").input, ["text"]);

/*
 * The models.dev tier is not one tier. The same bare name is published by many
 * providers, and their numbers disagree, so "whichever row the file lists first"
 * must not be the answer: the model's own vendor wins, then a row whose id is the
 * bare name, and a row that does not look like a chat model loses to one that does.
 */
expect("models.dev: the model's own vendor outranks another provider's row", rowOf(plugin, "probe/kimi-k9-ultra").contextWindow, 999999);
expect("models.dev: and its reasoning flag travels with it", rowOf(plugin, "probe/kimi-k9-ultra").reasoning.flatMap((level) => level === "high" ? [level] : []), ["high"]);
expect("models.dev: a chat row outranks a non-chat row of the same name", rowOf(plugin, "probe/nebula-5").contextWindow, 55555);

/*
 * Scenario 6: the mode switches. `off` must leave the seam exactly as it was,
 * `context` fills capacities without ever offering a level, and an unrecognized
 * value — the case that used to select the most permissive mode — must be reported
 * and resolved to a documented one.
 */
const disabled = run(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK: "off" });
expect("fallback=off: the route default is left alone", rowOf(disabled, "probe/glm-5.3").contextWindow, 262144);
expect("fallback=off: and no levels are offered", rowOf(disabled, "probe/glm-5.3").reasoning, []);
const contextOnly = run(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK: "context" });
expect("fallback=context: capacities are still filled in", rowOf(contextOnly, "probe/glm-5.3").contextWindow, 1000000);
expect("fallback=context: and reasoning is left to the seam", rowOf(contextOnly, "probe/glm-5.3").reasoning, []);
/*
 * Reasoning levels are chosen the same way input modalities are, and for the same
 * reason: a bare `reasoning: true` from a mirror becomes five offered levels, which
 * an endpoint may reject mid-turn. `bundled` restricts the claim to the catalogs
 * that ship with the product — which carry a level map — and leaves a models.dev
 * match to fill capacity only.
 */
expect("levels: the default lets the whole chain declare reasoning", rowOf(plugin, "probe/zephyr-9-pro").reasoning.length > 0, true);
const bundledLevels = run(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK_LEVELS: "bundled" });
expect("levels=bundled: a models.dev-only model fills capacity without claiming levels", [rowOf(bundledLevels, "probe/zephyr-9-pro").contextWindow, rowOf(bundledLevels, "probe/zephyr-9-pro").reasoning], [900000, []]);
expect("levels=bundled: a shipped catalog still declares its own levels", rowOf(bundledLevels, "probe/kimi-k3").reasoning, ["low", "high", "max"]);
const noLevels = run(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK_LEVELS: "off" });
expect("levels=off: nothing claims reasoning, capacities still filled in", [rowOf(noLevels, "probe/kimi-k3").reasoning, rowOf(noLevels, "probe/kimi-k3").contextWindow], [[], 1048576]);
const nonsenseLevels = runRaw(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK_LEVELS: "yes please" });
expect("an unrecognized levels value is reported and resolves to the conservative one", [
	nonsenseLevels.stderr.includes("DSH_PI_AI_CATALOG_FALLBACK_LEVELS"),
	nonsenseLevels.rows.find((row) => row.id === "probe/zephyr-9-pro").reasoning,
	nonsenseLevels.rows.find((row) => row.id === "probe/kimi-k3").reasoning
], [true, [], ["low", "high", "max"]]);

const unknownMode = runRaw(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK: "ofl" });
expect("an unrecognized fallback value is reported, not silently obeyed", unknownMode.stderr.includes("DSH_PI_AI_CATALOG_FALLBACK"), true);
expect("and it resolves to the documented default rather than disabling the plugin", unknownMode.rows.find((row) => row.id === "probe/glm-5.3").contextWindow, 1000000);

/*
 * Scenario 5: packaging invariants. Two of them are load-bearing enough to be
 * asserted rather than remembered: the client bundle must register under the package
 * name (the module system rejects anything else, silently), and the installer's patch
 * marker must not embed that name (a rename used to orphan the row, leaving two rows
 * for one plugin — which loads it twice).
 */
const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const clientSource = readFileSync(join(HERE, "lib/client.js"), "utf8");
const registered = /id:\s*"([^"]+)"/u.exec(clientSource)?.[1];
expect("packaging: the client bundle registers as the package name", registered, manifest.name);
expect("packaging: the bundle patch is declared and shipped", [manifest.dsh?.bundle?.patch, manifest.files?.includes("cordis.patch.yml")], ["./cordis.patch.yml", true]);
expect("packaging: the client half announces the web platform", manifest.dsh?.client?.platform, "web");
const installerSource = readFileSync(join(HERE, "install-plugin.mjs"), "utf8");
const marker = /const MARKER = "([^"]+)"/u.exec(installerSource)?.[1];
expect("packaging: the installer's marker is name-free, so a rename cannot orphan its row", marker?.includes(manifest.name), false);
expect("packaging: and the historical name-bearing markers are still matched", /LEGACY_MARKER = \/\^/.test(installerSource), true);

/*
 * The two drift checks that would have caught the defects this round fixed: every
 * module the entry point imports must actually be published (a flat install of the
 * published tarball would otherwise import a file that is not there), and every
 * environment variable the code reads must be documented (an undocumented switch is
 * one nobody can use, and a renamed one silently stops working).
 */
const published = new Set(manifest.files ?? []);
const imported = new Set();
for (const file of ["index.mjs", "panel.mjs", "snapshot.mjs", "names.mjs", "refresh-snapshot.mjs"]) {
	const text = readFileSync(join(HERE, "lib", file), "utf8");
	for (const match of text.matchAll(/from\s+"(\.\/[^"]+)"/gu)) imported.add(match[1].replace("./", ""));
}
const missingFiles = [...imported].filter((name) => !published.has(`lib/${name}`));
expect("packaging: every module the plugin imports is published", missingFiles, []);
expect("packaging: the browser half is published too", published.has("lib/client.js"), true);
/* The flat install copies FLAT_SOURCES; the package publishes `files`. A module in
 * one list but not the other is an install that breaks, and the two lists are far
 * apart in the tree — this is the cheapest place to notice. */
const flat = await import(pathToFileURL(join(HERE, "packaging.mjs")).href);
expect("packaging: the flat layout and the published files agree", flat.FLAT_SOURCES.filter((name) => !published.has(`lib/${name}`)), []);

const readme = readFileSync(join(HERE, "README.md"), "utf8");
const switches = new Set();
for (const file of ["index.mjs", "refresh-snapshot.mjs", "client.js", "panel.mjs", "snapshot.mjs", "names.mjs"]) {
	const text = readFileSync(join(HERE, "lib", file), "utf8");
	for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/gu)) switches.add(match[1]);
}
/* DSH's own variables are DSH's to document; everything this plugin reads is ours. */
const foreign = new Set(["DSH_HOME"]);
const undocumented = [...switches].filter((name) => !foreign.has(name) && !readme.includes(name));
expect("packaging: every switch this plugin reads is documented", undocumented, []);

/*
 * Scenario 6: the shipped suites. The snapshot must be re-read when it changes
 * (so a refreshed model list works without a restart), and the freshness policy
 * must do what it says. Their own summary is printed through.
 */
/**
 * Run one shipped suite and assert both that it exited zero and that it actually
 * asserted something. The status alone cannot tell "all good" from "the suite
 * stopped asserting": a suite that prints `0/0` and exits 0 used to pass, and its
 * summary was silently swallowed by the label this function built.
 * @param label - how the suite appears in the report.
 * @param script - the suite's path, relative to this directory.
 * @param env - extra environment for the child.
 */
function suite(label, script, env = {}) {
	if (!existsSync(join(HERE, script))) {
		expect(`${label}: the suite is present`, script, "(missing)");
		return;
	}
	const result = spawnSync(process.execPath, [join(HERE, script), ...process.argv.slice(2)], { encoding: "utf8", env: { ...process.env, ...env } });
	const stdout = result.stdout ?? "";
	const summary = stdout.trim().split("\n").map((line) => line.trim()).filter((line) => /assertions passed/u.test(line)).pop();
	const counts = /^(\d+)\/(\d+)\s+.*assertions passed/u.exec(summary ?? "");
	if (counts === null) {
		console.log(stdout, result.stderr);
		expect(`${label}: the suite printed a summary`, summary ?? "(none)", "(one line like `N/M assertions passed`)");
		return;
	}
	expect(`${label}: ${summary}`, [result.status, counts[1] === counts[2], Number(counts[2]) > 0], [0, true, true]);
	if (result.status !== 0) console.log(stdout, result.stderr);
}

suite("hot snapshot", "tests/hot-snapshot.mjs", { DSH_CATALOG_FALLBACK_PLUGIN: PLUGIN });
suite("hot add", "tests/hot-add-model.mjs", { DSH_CATALOG_FALLBACK_PLUGIN: PLUGIN });
suite("refresh policy (default)", "tests/refresh-policy.mjs", { DSH_CATALOG_FALLBACK_PLUGIN: PLUGIN, DSH_PI_AI_CATALOG_REFRESH: "24" });
suite("refresh policy (disabled)", "tests/refresh-policy.mjs", { DSH_CATALOG_FALLBACK_PLUGIN: PLUGIN, DSH_PI_AI_CATALOG_REFRESH: "0" });
suite("settings panel", "tests/panel.mjs", { DSH_CATALOG_FALLBACK_PLUGIN: PLUGIN });
suite("unit", "tests/unit.mjs", { DSH_CATALOG_FALLBACK_PLUGIN: PLUGIN });
suite("install-plugin", "tests/install-plugin.mjs");

console.log("");
console.log(`${String(checks - failures.length)}/${String(checks)} assertions passed`);
if (failures.length > 0) {
	console.log("");
	for (const failure of failures) console.log(`FAIL ${failure}`);
	process.exit(1);
}
