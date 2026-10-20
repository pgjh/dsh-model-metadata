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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 *
 * Missing means stop, not "judge against the machine": a conditional pin was how this
 * suite would silently turn into a data- and date-dependent one (every models.dev
 * assertion would read whatever the operator had fetched) with nothing to say so.
 */
if (!existsSync(SNAPSHOT)) {
	console.error(`no ${SNAPSHOT}: the models.dev tier is pinned to that two-entry fixture on purpose, and a missing fixture must not fall back to the machine's snapshot. Restore it from git (tests/snapshot-fixture.json).`);
	process.exit(2);
}
process.env.DSH_PI_AI_CATALOG_SNAPSHOT = SNAPSHOT;

/**
 * The switches a child scenario must not inherit from the operator's shell.
 *
 * This plugin is the kind of thing one exports while working on it, and a scenario
 * that inherits a switch does not test what it says it tests: with
 * `DSH_PI_AI_CATALOG_FALLBACK=off` in the environment the "the plugin fills a value
 * in" scenario failed in a way that named the plugin rather than the environment,
 * and with `DSH_PI_AI_CATALOG_PANEL=off` the panel suite registered no route at
 * all. Each scenario re-applies the values it means to exercise.
 */
const SCENARIO_STRIPPED = [
	"DSH_PI_AI_CATALOG_FALLBACK",
	"DSH_PI_AI_CATALOG_FALLBACK_LEVELS",
	"DSH_PI_AI_CATALOG_FALLBACK_INPUT",
	"DSH_PI_AI_CATALOG_REFRESH",
	"DSH_PI_AI_CATALOG_REFRESH_ON_START",
	"DSH_PI_AI_CATALOG_REFRESH_START_FLOOR_MINUTES",
	"DSH_PI_AI_CATALOG_REFRESH_OPEN_HOURS",
	"DSH_PI_AI_CATALOG_SNAPSHOT",
	"DSH_PI_AI_CATALOG_SNAPSHOT_URL",
	"DSH_PI_AI_CATALOG_PANEL",
	"DSH_PI_AI_CATALOG_PANEL_HOSTS",
	"DSH_PI_AI_SETTINGS_FILE",
	"DSH_CATALOG_FALLBACK_NODE_MODULES"
];

/**
 * The environment one scenario runs in: this process's, minus the switches above,
 * with the refresh policy off and the fixture pin re-applied — then whatever the
 * scenario sets on top.
 * @param extra - the scenario's own values.
 * @returns the child's environment.
 */
function scenarioEnv(extra = {}) {
	const env = { ...process.env };
	for (const name of SCENARIO_STRIPPED) delete env[name];
	return { ...env, DSH_PI_AI_CATALOG_REFRESH: "0", DSH_PI_AI_CATALOG_SNAPSHOT: SNAPSHOT, ...extra };
}

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
		const result = spawnSync(process.execPath, [join(HERE, "test-fallback.mjs"), "--json-out", out, ...args], { encoding: "utf8", env: scenarioEnv(env) });
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
 * The numbers several scenarios expect come from catalogs that ship inside the installed
 * DSH package, and pinning them as literals made a DSH release fail this suite with no
 * change in this repository — the assertion below would read "272000" while the catalog
 * had moved on. So the expected values are read from the same catalogs the plugin reads,
 * which is also what the assertion should say: *this name takes that route's numbers*. A
 * name the catalog no longer carries stops the run with a message naming it, rather than
 * silently testing nothing.
 *
 * The two-entry fixture's own numbers (zephyr, kimi-k9, nebula) stay literal: those are
 * ours, in tests/snapshot-fixture.json.
 */
const catalog = await import(pathToFileURL(join(NODE_MODULES, "@earendil-works/pi-ai", "dist", "providers", "all.js")).href);
const CATALOG_ROWS = new Map();
for (const route of catalog.getBuiltinProviders()) {
	for (const model of catalog.getBuiltinModels(route) ?? []) CATALOG_ROWS.set(`${route}\u0000${model.id}`, model);
}

/** One route's own row for one model id, or a stop when the catalog moved. */
function catalogRow(route, id) {
	const row = CATALOG_ROWS.get(`${route}\u0000${id}`);
	if (row === undefined) {
		console.error(`the installed catalog no longer carries ${route}/${id}; this suite's scenario for that name needs a new one`);
		process.exit(2);
	}
	return row;
}

/** The official DeepSeek route's own list, resolved the way that route resolves it. */
const OFFICIAL = await import(pathToFileURL(join(NODE_MODULES, "@deepseek-ai", "dsh-llm-deepseek", "lib", "index.js")).href);
const OFFICIAL_MODELS = OFFICIAL.resolveAdapterOptions({}).models;
/** The official route's row for one of its own ids, or a stop. */
function officialRow(id) {
	const row = OFFICIAL_MODELS.find((model) => model.id === id);
	if (row === undefined) {
		console.error(`the official DeepSeek route no longer lists ${id}; this suite's scenario for it needs a new one`);
		process.exit(2);
	}
	return row;
}

/** The levels pi-ai knows, for the assertions that care about the shape, not the rule. */
const KNOWN_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The modalities that travel through the seam; a catalog may list others. */
const KNOWN_MODALITIES = ["text", "image"];

/** A catalog row's own modalities, reduced to the two that travel through the seam. */
function catalogInput(route, id) {
	return (catalogRow(route, id).input ?? []).filter((modality) => KNOWN_MODALITIES.includes(modality));
}

/** The official route's own modalities for one of its ids, likewise reduced. */
function officialInput(id) {
	return (officialRow(id).inputModalities ?? []).filter((modality) => KNOWN_MODALITIES.includes(modality));
}

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
const ZAI_GLM = catalogRow("zai", "glm-5.3");
expect("plugin: glm-5.3 takes zai's own context window", glm.contextWindow, ZAI_GLM.contextWindow);
expect("plugin: and zai's own output cap", glm.maxTokens, ZAI_GLM.maxTokens);
/* The exact level list is pi-ai's own rule (it reads the row's thinkingLevelMap), so what
 * this asserts is the shape: real levels, from the known set, and a reasoning model's
 * middle level among them. */
expect("plugin: glm-5.3 offers real reasoning levels", [glm.reasoning.length > 0, glm.reasoning.every((level) => KNOWN_LEVELS.includes(level)), glm.reasoning.includes("high")], [true, true, true]);
expect("plugin: upstream wins for gpt-5.4 (openai, not azure)", rowOf(plugin, "probe/gpt-5.4").contextWindow, catalogRow("openai", "gpt-5.4").contextWindow);
expect("plugin: the vendor's own catalog answers by display name (minimax-m3)", [rowOf(plugin, "probe/minimax-m3").contextWindow, rowOf(plugin, "probe/minimax-m3").maxTokens], [catalogRow("minimax", "MiniMax-M3").contextWindow, catalogRow("minimax", "MiniMax-M3").maxTokens]);
/*
 * `probe/minimax-m3` is also published by the openrouter aggregator (`minimax/minimax-m3`,
 * a different window), so this pins which route answered, not only that something did.
 */
expect("plugin: and it is the vendor's row, not the aggregator's", rowOf(plugin, "probe/minimax-m3").contextWindow === catalogRow("openrouter", "minimax/minimax-m3").contextWindow, false);
/*
 * The official deepseek-official route keeps its catalog in its own package, so
 * the chain must consult it explicitly: the V41 flash's three spellings — the
 * route's display name "DeepSeek-V41-Flash", the models.dev id
 * deepseek-v4.1-flash, and the undotted alias — all name one model.
 */
const OFFICIAL_FLASH = officialRow("deepseek-flash");
expect("plugin: the official deepseek catalog answers the v41 alias", rowOf(plugin, "probe/deepseek-v41-flash").contextWindow, OFFICIAL_FLASH.contextWindow);
expect("plugin: the alias gets the official route's own effort levels", rowOf(plugin, "probe/deepseek-v41-flash").reasoning, ["off", "low", "high", "max"]);
expect("plugin: the dotted v4.1 spelling matches the same model", rowOf(plugin, "probe/deepseek-v4.1-flash").contextWindow, OFFICIAL_FLASH.contextWindow);
expect("plugin: a name missing the catalog's -exp suffix still matches", rowOf(plugin, "probe/DeepSeek-V4-Flash-Vision").input, ["text", "image"]);
expect("plugin: the models.dev tier covers a model no bundled catalog has", rowOf(plugin, "probe/zephyr-9-pro").contextWindow, 900000);
/*
 * Aggregators mirror other people's catalogs, so a catalog route that carries
 * the same name must outrank them: openrouter's own row wins over opencode-go's
 * for longcat-2.0, and both numbers are read from those catalogs rather than
 * pinned here (the assertion is about which route answered, not about its size).
 */
expect("plugin: a catalog route outranks the aggregator for the same name", rowOf(plugin, "probe/longcat-2.0").contextWindow, catalogRow("openrouter", "meituan/longcat-2.0").contextWindow);
expect("plugin: and it is not the aggregator's row that answered", catalogRow("openrouter", "meituan/longcat-2.0").contextWindow === catalogRow("opencode-go", "longcat-2.0").contextWindow, false);
expect("plugin: a model nothing describes keeps the route default", rowOf(plugin, "probe/unknown-model-x").contextWindow, 262144);
expect("plugin: a model nothing describes offers no levels", rowOf(plugin, "probe/unknown-model-x").reasoning, []);
/*
 * Hy/hunyuan has no vendor route of its own — only opencode-go carries it — so
 * the aggregator stays that family's upstream: a bare `hy4-preview` must not
 * fall to the same-named entries other catalogs hold.
 */
expect("plugin: the hy family keeps its aggregator upstream", rowOf(plugin, "probe/hy4-preview").contextWindow, catalogRow("opencode-go", "hy4-preview").contextWindow);
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
expect("declared: the rest of that model is still filled in", rowOf(declared, "probe/kimi-k3").contextWindow, catalogRow("moonshotai", "kimi-k3").contextWindow);
/* A declaration this plugin's own UI writes: the chain knows the name as
 * image-capable, and the row must keep saying text-only. */
expect("declared: an explicit input list survives the chain", rowOf(declared, "probe/glm-4.6v").input, ["text"]);

/*
 * Scenario 3b: the precedence rule's one dangerous hole. When the plugin cannot read the
 * declarations, it must refuse to borrow rather than borrow over a field it cannot see —
 * before this rule, a declared `contextWindow: 64000` came back as the catalog's 272000 and
 * `reasoningEfforts: false` as reason-capable, silently, on a config that was merely
 * mid-edit or on an install whose YAML parser could not be loaded.
 *
 * `--plugin-settings` is what makes the case reachable: the adapter is fed one document,
 * the plugin is pointed at another.
 */
const brokenDir = mkdtempSync(join(tmpdir(), "dsh-mm-broken-"));
try {
	const broken = join(brokenDir, "settings.yaml");
	writeFileSync(broken, "llm-pi-ai:\n  providers:\n   - [unclosed\n");
	const midEdit = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", PRECEDENCE, "--plugin-settings", broken]);
	expect("an unreadable settings document is reported", [midEdit.status, midEdit.stderr.includes("cannot read")], [0, true]);
	expect("and the declarations it could not read are left alone", [rowOf(midEdit.rows, "probe/gpt-5.4").contextWindow, rowOf(midEdit.rows, "probe/gpt-5.4").maxTokens, rowOf(midEdit.rows, "probe/gpt-5.4").reasoning], [64000, 8000, []]);
	const notThere = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", PRECEDENCE, "--plugin-settings", join(brokenDir, "no-such-document.yaml")]);
	expect("a document that is not where the plugin looks is refused too, not guessed at", [notThere.status, rowOf(notThere.rows, "probe/gpt-5.4").contextWindow, rowOf(notThere.rows, "probe/gpt-5.4").reasoning], [0, 64000, []]);
	/*
	 * And the rule must not become "never fill anything in": with a readable document that
	 * declares nothing for this row, the chain still fills it.
	 */
	const empty = join(brokenDir, "empty-settings.yaml");
	writeFileSync(empty, "llm-pi-ai:\n  providers: {}\n");
	const readable = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", PRECEDENCE, "--plugin-settings", empty]);
	expect("a readable document that declares nothing lets the chain fill the row", rowOf(readable.rows, "probe/glm-5.3").contextWindow, catalogRow("zai", "glm-5.3").contextWindow);
} finally {
	rmSync(brokenDir, { recursive: true, force: true });
}

/*
 * Scenario 3c: the 0.2.x home, where `settings.yaml` no longer exists.
 *
 * Since 0.2.0 the settings service renames that document to `settings.yaml.imported`
 * on start and folds each section into `<home>/profiles/<name>/cordis.patch.yml`.
 * A plugin that only ever reads `<home>/settings.yaml` therefore finds nothing on
 * an upgraded install, and its fail-closed rule then turns the metadata fallback
 * off entirely — the two controls vanish from the Settings page and reasoning
 * levels stop being offered. So the same declarations must be honoured when they
 * live in a patch layer, which is a list of `{ id, config }` entries rather than
 * a mapping of section names.
 */
const upgradeDir = mkdtempSync(join(tmpdir(), "dsh-mm-upgrade-"));
try {
	/*
	 * A home with no settings.yaml at all, and a profile patch carrying the same
	 * rows: this is what the operator's disk looks like after the upgrade.
	 */
	const profileDir = join(upgradeDir, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	const patchPath = join(profileDir, "cordis.patch.yml");
	writeFileSync(patchPath, [
		"- id: ui-settings-general",
		"  config:",
		"    welcomeNoticeVersion: 2026-09-28.1",
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      my-gateway:",
		"        displayName: my-gateway",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/gpt-5.4",
		"            name: probe/gpt-5.4",
		"            contextWindow: 64000",
		"            maxTokens: 8000",
		"            reasoningEfforts: false",
		"          - id: probe/kimi-k3",
		"            name: probe/kimi-k3",
		"            reasoningEfforts:",
		"              low: low",
		"              high: high",
		"          - id: probe/glm-4.6v",
		"            name: probe/glm-4.6v",
		"            input:",
		"              - text",
		"          - id: probe/glm-5.3",
		"            name: probe/glm-5.3",
		""
	].join("\n"));
	/*
	 * The plugin reads the profile patch without being told which profile: the
	 * `profileContext` service is what knows, and a headless run has none, so the
	 * newest patch file in the home is what answers. `DSH_HOME` is the whole input
	 * here — the point of the scenario is that no settings document is required.
	 */
	const upgraded = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", patchPath, "--plugin-settings", patchPath], { DSH_HOME: upgradeDir });
	expect("0.2.x: a patch layer is read as the declarations, not refused", [upgraded.status, upgraded.rows === undefined], [0, false]);
	expect("0.2.x: an explicit contextWindow in a patch row survives", rowOf(upgraded.rows, "probe/gpt-5.4").contextWindow, 64000);
	expect("0.2.x: an explicit maxTokens in a patch row survives", rowOf(upgraded.rows, "probe/gpt-5.4").maxTokens, 8000);
	expect("0.2.x: reasoningEfforts: false in a patch row is respected", rowOf(upgraded.rows, "probe/gpt-5.4").reasoning, []);
	expect("0.2.x: an explicit level subset in a patch row is respected", rowOf(upgraded.rows, "probe/kimi-k3").reasoning, ["low", "high"]);
	expect("0.2.x: an explicit input list in a patch row is respected", rowOf(upgraded.rows, "probe/glm-4.6v").input, ["text"]);
	expect("0.2.x: a row that declares nothing is still filled from the chain", rowOf(upgraded.rows, "probe/glm-5.3").contextWindow, catalogRow("zai", "glm-5.3").contextWindow);

	/*
	 * And the shape alone is not enough: the same file has to answer when it is the
	 * only thing on disk, found by discovery rather than passed by name. That is the
	 * operator's actual case — nothing points the plugin at the profile patch.
	 */
	const discovered = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", patchPath, "--plugin-settings-auto"], { DSH_HOME: upgradeDir });
	expect("0.2.x: the profile patch is found without being named", [discovered.status, rowOf(discovered.rows, "probe/gpt-5.4").contextWindow], [0, 64000]);

	/*
	 * A patch layer that parses but carries no llm-pi-ai row declares nothing, which
	 * is not the same as being unreadable: the chain must still fill rows in.
	 */
	const otherProfile = join(upgradeDir, "profiles", "headless");
	mkdirSync(otherProfile, { recursive: true });
	const otherPatch = join(otherProfile, "cordis.patch.yml");
	writeFileSync(otherPatch, "- id: ui-settings-general\n  config: {}\n");
	const unrelated = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", PRECEDENCE, "--plugin-settings", otherPatch], { DSH_HOME: upgradeDir });
	expect("0.2.x: a patch layer with no llm-pi-ai row is readable and declares nothing", [unrelated.status, rowOf(unrelated.rows, "probe/glm-5.3").contextWindow], [0, catalogRow("zai", "glm-5.3").contextWindow]);
} finally {
	rmSync(upgradeDir, { recursive: true, force: true });
}

/*
 * Scenario 3d: the two layers 0.2.x composes, and the order between them.
 *
 * `readProfilePatches()` reads the profile patch and then `<home>/cordis.patch.yml`,
 * and `applyEntryPatches` lets the later row replace the earlier row's config. So
 * the home layer is not an alternative to the profile one — it composes *after* it,
 * and a plugin that reads only one of the two sees a strict subset of what DSH
 * resolves. That shows up twice: a route declared only in the home layer is missing
 * from the panel, and a home row that restates a model's limits loses to the
 * profile row, because the plugin never sees the value that is actually in force.
 */
const layeredDir = mkdtempSync(join(tmpdir(), "dsh-mm-layered-"));
try {
	const profileDir = join(layeredDir, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	const profilePatch = join(profileDir, "cordis.patch.yml");
	/*
	 * The profile layer declares the route and one limit; the home layer restates a
	 * different limit and adds a second route the profile never mentions.
	 */
	writeFileSync(profilePatch, [
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      shared:",
		"        displayName: shared",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/gpt-5.4",
		"            name: probe/gpt-5.4",
		"            contextWindow: 111111",
		"            maxTokens: 2222",
		""
	].join("\n"));
	writeFileSync(join(layeredDir, "cordis.patch.yml"), [
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      shared:",
		"        displayName: shared",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/gpt-5.4",
		"            name: probe/gpt-5.4",
		"            contextWindow: 333333",
		"      home-only:",
		"        displayName: home-only",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/kimi-k3",
		"            name: probe/kimi-k3",
		"            maxTokens: 4444",
		""
	].join("\n"));
	/*
	 * The adapter is fed the composed result the way DSH composes it, so the plugin's
	 * view and the adapter's view can be compared: whatever the plugin thinks is
	 * declared has to be what the adapter was given.
	 */
	const composed = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", join(layeredDir, "cordis.patch.yml"), "--plugin-settings-auto"], { DSH_HOME: layeredDir });
	expect("layers: a route declared only in the home layer still reaches the panel", [composed.status, composed.rows.some((row) => row.provider === "home-only")], [0, true]);
	expect("layers: the home layer's row wins over the profile layer's, as the Loader composes them", rowOf(composed.rows, "probe/gpt-5.4").contextWindow, 333333);
	/*
	 * A patch row replaces the target entry's `config` wholesale (`applyEntryPatches`
	 * assigns each override key), so the home layer's `llm-pi-ai` row does not merge
	 * into the profile layer's — it supersedes it. `maxTokens` therefore stops being
	 * declared at all and the catalog fills it, which is the value DSH itself resolves.
	 */
	expect("layers: the home row supersedes the profile row's config rather than merging", rowOf(composed.rows, "probe/gpt-5.4").maxTokens, catalogRow("openai", "gpt-5.4").maxTokens);
	expect("layers: a home-only row's own declaration survives", rowOf(composed.rows, "probe/kimi-k3").maxTokens, 4444);
} finally {
	rmSync(layeredDir, { recursive: true, force: true });
}

/*
 * Scenario 3e: a profile that has never been edited.
 *
 * `profileContext.patchPath` names the running profile even when no file is there
 * yet. Discovery must not then reach for a *different* profile's patch: that mixes
 * declarations from a profile that is not running into the one that is, which is
 * how the panel ends up listing routes nobody configured.
 */
const uneditedDir = mkdtempSync(join(tmpdir(), "dsh-mm-unedited-"));
try {
	/*
	 * An inactive profile whose patch declares the same route with a distinctive
	 * `contextWindow`, and a home layer that declares the route without one. If the
	 * plugin reaches for the inactive profile it believes 555555 is declared and keeps
	 * it; reading only the running profile (which has no patch) plus the home layer
	 * leaves the catalog's value in place. Both outcomes are distinguishable, which is
	 * the point — a scenario where they coincide proves nothing.
	 */
	const stale = join(uneditedDir, "profiles", "stale");
	mkdirSync(stale, { recursive: true });
	writeFileSync(join(stale, "cordis.patch.yml"), [
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      probe:",
		"        displayName: probe",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/gpt-5.4",
		"            name: probe/gpt-5.4",
		"            contextWindow: 555555",
		""
	].join("\n"));
	/*
	 * The home layer must declare an UNRELATED section. A home `llm-pi-ai` row would
	 * replace the stale profile's whole section during composition, wiping the
	 * `contextWindow: 555555` the scenario depends on — so the test would pass even
	 * if discovery wrongly selected the stale profile. Keeping the home layer away
	 * from `llm-pi-ai` leaves that value visible to anything that reads it.
	 */
	writeFileSync(join(uneditedDir, "cordis.patch.yml"), [
		"- id: some-other-plugin",
		"  config:",
		"    someSetting: true",
		""
	].join("\n"));
	/* What the adapter is fed: the same route, declaring nothing. */
	const adapterSettings = join(uneditedDir, "adapter-settings.yaml");
	writeFileSync(adapterSettings, [
		"llm-pi-ai:",
		"  providers:",
		"    probe:",
		"      displayName: probe",
		"      api: openai-responses",
		"      baseURL: http://127.0.0.1:1/v1",
		"      models:",
		"        - id: probe/gpt-5.4",
		"          name: probe/gpt-5.4",
		""
	].join("\n"));
	/*
	 * `DSH_PI_AI_SETTINGS_FILE` cannot express this case — it names a file, and the
	 * point is that nothing is named. So the service is supplied instead and the
	 * plugin is left to discover the rest: `--profile-patch` points at a patch that
	 * does not exist, exactly as a profile nobody has edited yet looks.
	 */
	const unedited = runRaw(
		["--source", ADAPTER, "--plugin", PLUGIN, "--settings", adapterSettings, "--plugin-settings-auto", "--profile-patch", join(uneditedDir, "profiles", "web", "cordis.patch.yml")],
		{ DSH_HOME: uneditedDir }
	);
	/*
	 * Assert on the plugin's own view of the declarations, not on the resolved value:
	 * selecting the stale profile would make `555555` look declared, which is the
	 * behaviour under test. The resolved value is reported alongside so a failure says
	 * which of the two happened.
	 */
	const uneditedRow = rowOf(unedited.rows, "probe/gpt-5.4");
	expect(
		"an unedited running profile does not fall back to another profile's declarations",
		[unedited.status, uneditedRow.declared, uneditedRow.contextWindow],
		[0, undefined, catalogRow("openai", "gpt-5.4").contextWindow]
	);
} finally {
	rmSync(uneditedDir, { recursive: true, force: true });
}

/*
 * Scenario 3f: what the layers do when one of them cannot be read.
 *
 * `existingPatchLayers()` drops the layers that are not there, so an error reaching
 * the reader means the file exists and could not be opened. Treating that as
 * "declares nothing" would honor the other layers while the failing one holds
 * declarations this plugin cannot see — the exact borrow-over-invisible-declarations
 * failure the fail-closed rule exists to prevent. And the composed answer has to be
 * dropped with it, because the settings panel reads it without consulting the flag
 * and writes the whole `providers.<route>.models` array back: a partial document
 * would present superseded rows as stored declarations and could persist them.
 */
const unreadableDir = mkdtempSync(join(tmpdir(), "dsh-mm-unreadable-"));
try {
	const profileDir = join(unreadableDir, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	const profilePatch = join(profileDir, "cordis.patch.yml");
	writeFileSync(profilePatch, [
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      probe:",
		"        displayName: probe",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/gpt-5.4",
		"            name: probe/gpt-5.4",
		"            contextWindow: 111111",
		""
	].join("\n"));
	const homePatch = join(unreadableDir, "cordis.patch.yml");
	writeFileSync(homePatch, [
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      probe:",
		"        displayName: probe",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/gpt-5.4",
		"            name: probe/gpt-5.4",
		""
	].join("\n"));
	const adapterSettings = join(unreadableDir, "adapter-settings.yaml");
	writeFileSync(adapterSettings, [
		"llm-pi-ai:",
		"  providers:",
		"    probe:",
		"      displayName: probe",
		"      api: openai-responses",
		"      baseURL: http://127.0.0.1:1/v1",
		"      models:",
		"        - id: probe/gpt-5.4",
		"          name: probe/gpt-5.4",
		""
	].join("\n"));
	try {
		chmodSync(homePatch, 0o000);
		const denied = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", adapterSettings, "--plugin-settings-auto", "--profile-patch", profilePatch], { DSH_HOME: unreadableDir });
		expect("an unreadable layer is reported", denied.stderr.includes("cannot read"), true);
		/*
		 * 262144 is the route default, which is what enrichment being off produces.
		 * The point is that it is not 111111: the readable layer's declaration must
		 * not be honored while the other layer's declarations are invisible.
		 */
		expect("and an unreadable layer disables enrichment instead of honoring the rest", rowOf(denied.rows, "probe/gpt-5.4").contextWindow, 262144);
	} finally {
		chmodSync(homePatch, 0o644);
	}
} finally {
	rmSync(unreadableDir, { recursive: true, force: true });
}

/*
 * Scenario 3g: an `insert:` row declares entries too.
 *
 * This package's own `cordis.patch.yml` adds its plugin row with `- insert:`, and
 * `applyEntryPatches` pushes those rows into the target group — so an operator
 * copying that form to declare a settings section would otherwise declare into a
 * void: the routes vanish from the panel and enrichment borrows over limits it
 * cannot see.
 */
const insertDir = mkdtempSync(join(tmpdir(), "dsh-mm-insert-"));
try {
	const profileDir = join(insertDir, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	const insertPatch = join(profileDir, "cordis.patch.yml");
	writeFileSync(insertPatch, [
		"- insert:",
		"    - id: llm-pi-ai",
		"      config:",
		"        providers:",
		"          probe:",
		"            displayName: probe",
		"            api: openai-responses",
		"            baseURL: http://127.0.0.1:1/v1",
		"            models:",
		"              - id: probe/gpt-5.4",
		"                name: probe/gpt-5.4",
		"                contextWindow: 777777",
		""
	].join("\n"));
	const inserted = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", insertPatch, "--plugin-settings-auto", "--profile-patch", insertPatch], { DSH_HOME: insertDir });
	expect("insert: a section declared through an insert row is read", [inserted.status, rowOf(inserted.rows, "probe/gpt-5.4").contextWindow], [0, 777777]);
} finally {
	rmSync(insertDir, { recursive: true, force: true });
}

/*
 * Scenario 3h: a profile layer that cannot be read.
 *
 * `existsSync()` answers false for every failure, so an EACCES on the profile
 * directory looked exactly like a profile that was never edited: the layer was
 * dropped as "declares nothing" and the home layer was composed from — while the
 * running adapter still held the declarations this plugin had stopped seeing. The
 * home layer below declares the same route without the limit, so a partial view
 * resolves to the catalog's value instead of the declared one.
 */
const hiddenDir = mkdtempSync(join(tmpdir(), "dsh-mm-hidden-"));
try {
	const profileDir = join(hiddenDir, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	const profilePatch = join(profileDir, "cordis.patch.yml");
	writeFileSync(profilePatch, [
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      probe:",
		"        displayName: probe",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/gpt-5.4",
		"            name: probe/gpt-5.4",
		"            contextWindow: 888888",
		""
	].join("\n"));
	writeFileSync(join(hiddenDir, "cordis.patch.yml"), [
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      probe:",
		"        displayName: probe",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/gpt-5.4",
		"            name: probe/gpt-5.4",
		""
	].join("\n"));
	const adapterSettings = join(hiddenDir, "adapter-settings.yaml");
	writeFileSync(adapterSettings, [
		"llm-pi-ai:",
		"  providers:",
		"    probe:",
		"      displayName: probe",
		"      api: openai-responses",
		"      baseURL: http://127.0.0.1:1/v1",
		"      models:",
		"        - id: probe/gpt-5.4",
		"          name: probe/gpt-5.4",
		""
	].join("\n"));
	try {
		/* The profile directory becomes untraversable, so stat on its patch fails EACCES. */
		chmodSync(profileDir, 0o000);
		const hidden = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", adapterSettings, "--plugin-settings-auto", "--profile-patch", profilePatch], { DSH_HOME: hiddenDir });
		expect("an unreadable profile layer is reported, not skipped", hidden.stderr.includes("cannot read"), true);
		/*
		 * 262144 is the route default, which is what enrichment being off produces.
		 * The catalog's 272000 is the value a partial view would resolve to — the
		 * home layer composes over the profile one and the declared limit is invisible.
		 */
		expect("an unreadable profile layer disables enrichment instead of being skipped", [hidden.status, rowOf(hidden.rows, "probe/gpt-5.4").contextWindow], [0, 262144]);
	} finally {
		chmodSync(profileDir, 0o755);
	}
} finally {
	rmSync(hiddenDir, { recursive: true, force: true });
}

/*
 * Scenario 3i: the same permission failure, reached by discovery.
 *
 * Scenario 3h supplies the service, so it never exercises the other branch: with no
 * `profileContext` the plugin ranks candidate layers by mtime, and a `statSync`
 * that fails for a reason other than absence used to be dropped as "no patch file
 * in that profile". A profile directory that cannot be traversed then vanished,
 * an *older* profile or the home layer composed in its place, and the result looked
 * complete — while the running adapter still held the declarations.
 */
const discoverDir = mkdtempSync(join(tmpdir(), "dsh-mm-discover-"));
try {
	const profileDir = join(discoverDir, "profiles", "web");
	mkdirSync(profileDir, { recursive: true });
	const profilePatch = join(profileDir, "cordis.patch.yml");
	writeFileSync(profilePatch, [
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      probe:",
		"        displayName: probe",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/gpt-5.4",
		"            name: probe/gpt-5.4",
		"            contextWindow: 999999",
		""
	].join("\n"));
	/* A readable home layer that declares the same route without the limit. */
	writeFileSync(join(discoverDir, "cordis.patch.yml"), [
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      probe:",
		"        displayName: probe",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/gpt-5.4",
		"            name: probe/gpt-5.4",
		""
	].join("\n"));
	const adapterSettings = join(discoverDir, "adapter-settings.yaml");
	writeFileSync(adapterSettings, [
		"llm-pi-ai:",
		"  providers:",
		"    probe:",
		"      displayName: probe",
		"      api: openai-responses",
		"      baseURL: http://127.0.0.1:1/v1",
		"      models:",
		"        - id: probe/gpt-5.4",
		"          name: probe/gpt-5.4",
		""
	].join("\n"));
	try {
		chmodSync(profileDir, 0o000);
		/*
		 * No `--profile-patch`: this is the discovery branch, which is the one under
		 * test. 262144 is the route default (enrichment off); 272000 would be the
		 * partial view the home layer alone resolves to.
		 */
		const discovered = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", adapterSettings, "--plugin-settings-auto"], { DSH_HOME: discoverDir });
		expect("discovery reports a layer it could not read", discovered.stderr.includes("cannot read"), true);
		expect("discovery does not compose from the layers it can reach", [discovered.status, rowOf(discovered.rows, "probe/gpt-5.4").contextWindow], [0, 262144]);
	} finally {
		chmodSync(profileDir, 0o755);
	}
} finally {
	rmSync(discoverDir, { recursive: true, force: true });
}

/*
 * Scenario 3j: a profiles directory that cannot be listed.
 *
 * The other half of the same failure. `readdirSync` on the profiles directory threw
 * out of discovery, which is out of model resolution — a degraded install is not a
 * crash. It now becomes the unreadable-document case like any other layer failure.
 */
const listedDir = mkdtempSync(join(tmpdir(), "dsh-mm-listed-"));
try {
	mkdirSync(join(listedDir, "profiles"), { recursive: true });
	writeFileSync(join(listedDir, "cordis.patch.yml"), [
		"- id: llm-pi-ai",
		"  config:",
		"    providers:",
		"      probe:",
		"        displayName: probe",
		"        api: openai-responses",
		"        baseURL: http://127.0.0.1:1/v1",
		"        models:",
		"          - id: probe/gpt-5.4",
		"            name: probe/gpt-5.4",
		""
	].join("\n"));
	const adapterSettings = join(listedDir, "adapter-settings.yaml");
	writeFileSync(adapterSettings, [
		"llm-pi-ai:",
		"  providers:",
		"    probe:",
		"      displayName: probe",
		"      api: openai-responses",
		"      baseURL: http://127.0.0.1:1/v1",
		"      models:",
		"        - id: probe/gpt-5.4",
		"          name: probe/gpt-5.4",
		""
	].join("\n"));
	try {
		chmodSync(join(listedDir, "profiles"), 0o000);
		const unlisted = runRaw(["--source", ADAPTER, "--plugin", PLUGIN, "--settings", adapterSettings, "--plugin-settings-auto"], { DSH_HOME: listedDir });
		expect("a profiles directory that cannot be listed is reported", unlisted.stderr.includes("cannot read"), true);
		/* Degrades, never throws: the run completes and enrichment is off. */
		expect("a profiles directory that cannot be listed degrades instead of throwing", [unlisted.status, rowOf(unlisted.rows, "probe/gpt-5.4").contextWindow], [0, 262144]);
	} finally {
		chmodSync(join(listedDir, "profiles"), 0o755);
	}
} finally {
	rmSync(listedDir, { recursive: true, force: true });
}

/*
 * Scenario 4: input modalities ride the same chain by default, with narrower
 * settings available, because claiming image support an endpoint lacks fails a
 * turn instead of refusing the attachment.
 */
expect("input: the chain decides images by default", rowOf(plugin, "probe/glm-4.6v").input, catalogInput("zai-coding-cn", "glm-4.6v"));
expect("input: and that catalog row is not text-only, or this scenario would prove nothing", catalogInput("zai-coding-cn", "glm-4.6v").includes("image"), true);
expect("input: a text-only upstream keeps the model text-only", rowOf(plugin, "probe/glm-5.3").input, catalogInput("zai", "glm-5.3"));
expect("input: the official route's own vision model declares image", rowOf(plugin, "probe/deepseek-v41-flash").input, officialInput("deepseek-flash"));
const noInput = run(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK_INPUT: "off" });
expect("input=off: no modality is filled in", rowOf(noInput, "probe/glm-4.6v").input, ["text"]);
const withInput = run(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK_INPUT: "on" });
expect("input=on: a vision model declares image", rowOf(withInput, "probe/glm-4.6v").input, catalogInput("zai-coding-cn", "glm-4.6v"));
expect("input=on: a models.dev-only claim is honoured too", rowOf(withInput, "probe/zephyr-9-pro").input, ["text", "image"]);
const bundledOnly = run(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK_INPUT: "bundled" });
expect("input=bundled: the shipped catalog's claim still applies", rowOf(bundledOnly, "probe/glm-4.6v").input, catalogInput("zai-coding-cn", "glm-4.6v"));
expect("input=bundled: the official deepseek catalog counts as shipped", rowOf(bundledOnly, "probe/deepseek-v41-flash").input, officialInput("deepseek-flash"));
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
expect("fallback=context: capacities are still filled in", rowOf(contextOnly, "probe/glm-5.3").contextWindow, catalogRow("zai", "glm-5.3").contextWindow);
/*
 * `context` means "capacities, not reasoning" — and, worth pinning because the README
 * used to say "capacities only": image support still rides the chain in this mode, which
 * is the same over-declaration the LEVELS/INPUT switches exist to bound, so a reader must
 * be able to see which half is off here.
 */
expect("fallback=context: and reasoning is left to the seam", rowOf(contextOnly, "probe/glm-5.3").reasoning, []);
expect("fallback=context: while image support still rides the chain", rowOf(contextOnly, "probe/glm-4.6v").input, catalogInput("zai-coding-cn", "glm-4.6v"));
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
expect("levels=bundled: a shipped catalog still declares its own levels", [rowOf(bundledLevels, "probe/kimi-k3").reasoning.length > 0, rowOf(bundledLevels, "probe/kimi-k3").reasoning.includes("high")], [true, true]);
const noLevels = run(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK_LEVELS: "off" });
expect("levels=off: nothing claims reasoning, capacities still filled in", [rowOf(noLevels, "probe/kimi-k3").reasoning, rowOf(noLevels, "probe/kimi-k3").contextWindow], [[], catalogRow("moonshotai", "kimi-k3").contextWindow]);
const nonsenseLevels = runRaw(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK_LEVELS: "yes please" });
expect("an unrecognized levels value is reported and resolves to the conservative one", [
	nonsenseLevels.stderr.includes("DSH_PI_AI_CATALOG_FALLBACK_LEVELS"),
	nonsenseLevels.rows.find((row) => row.id === "probe/zephyr-9-pro").reasoning,
	nonsenseLevels.rows.find((row) => row.id === "probe/kimi-k3").reasoning.length > 0
], [true, [], true]);

const unknownMode = runRaw(["--source", ADAPTER, "--plugin", PLUGIN], { DSH_PI_AI_CATALOG_FALLBACK: "ofl" });
expect("an unrecognized fallback value is reported, not silently obeyed", unknownMode.stderr.includes("DSH_PI_AI_CATALOG_FALLBACK"), true);
expect("and it resolves to the documented default rather than disabling the plugin", unknownMode.rows.find((row) => row.id === "probe/glm-5.3").contextWindow, catalogRow("zai", "glm-5.3").contextWindow);

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
	const result = spawnSync(process.execPath, [join(HERE, script), ...process.argv.slice(2)], { encoding: "utf8", env: scenarioEnv(env) });
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

/*
 * Scenario 7: the diagnostic's own argument parsing.
 *
 * `--profile-patch` had its own inline branch that only rejected a missing value, so
 * `--profile-patch --plugin-settings-auto` consumed the flag as a filename — and then
 * fell back to scratch settings, which looks exactly like a run that found no
 * declarations. Every other valued option already refused flag-shaped values.
 */
{
	const probe = spawnSync(process.execPath, [join(HERE, "test-fallback.mjs"), "--source", ADAPTER, "--settings", PRECEDENCE, "--profile-patch", "--plugin-settings-auto"], { encoding: "utf8", env: scenarioEnv({ DSH_CATALOG_FALLBACK_PLUGIN: PLUGIN }) });
	expect("diagnostic: a flag where --profile-patch expects a path is refused", [probe.status, (probe.stderr ?? "").includes("needs a value")], [1, true]);
}

console.log("");
console.log(`${String(checks - failures.length)}/${String(checks)} assertions passed`);
if (failures.length > 0) {
	console.log("");
	for (const failure of failures) console.log(`FAIL ${failure}`);
	process.exit(1);
}
