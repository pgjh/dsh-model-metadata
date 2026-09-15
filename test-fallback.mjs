#!/usr/bin/env node
/**
 * test-fallback.mjs — exercise one adapter build against a settings document
 * without starting a server, and print what DSH would resolve per model.
 *
 *   node test-fallback.mjs [--source <…/dsh-llm-pi-ai/lib/index.js>] \
 *                          [--settings ~/.dsh/settings.yaml] [--provider my-gateway] \
 *                          [--json] [--json-out <file>]
 *
 * `--source` defaults to the installed adapter, found the same way the other tools
 * find it, so the one-line invocation in the README works as written. The run gets
 * a scratch snapshot of its own unless the caller names one, so nothing here can
 * overwrite the data a running DSH is reading: this tool used to inherit the live
 * snapshot path and its launch refresh, which meant one hand-run could rewrite it.
 *
 * The adapter file is copied into a throwaway mirror directory whose
 * `node_modules` symlinks the real install, so the copy imports the same
 * dependency tree it does in production. A captured adapter instance is then
 * driven directly: `resolveModel()` for what the composer shows, and
 * `current().models.getModel()` for the full resolved descriptor.
 */
import { existsSync, mkdirSync, symlinkSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { adapterEntry } from "./dev-paths.mjs";
import { sandbox } from "./tests/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Arguments that must be followed by a value. */
const VALUED = ["--source", "--settings", "--provider", "--plugin", "--node-modules", "--json-out"];

function parseArgs(argv) {
	const options = { source: undefined, settings: undefined, provider: undefined, nodeModules: undefined, json: false, jsonOut: undefined, refresh: false };
	for (let at = 0; at < argv.length; at++) {
		const arg = argv[at];
		if (arg === "--help") {
			console.log("node test-fallback.mjs [--source <adapter.js>] [--settings <settings.yaml>] [--provider <route>] [--plugin <lib/index.mjs>] [--node-modules <dir>] [--json] [--json-out <file>] [--refresh]");
			process.exit(0);
		}
		if (arg === "--json") options.json = true;
		else if (arg === "--refresh") options.refresh = true;
		else if (VALUED.includes(arg)) {
			const value = argv[++at];
			/* A flag whose value is missing must not fall back to a default: this tool
			 * writes files, and a mis-read argument is a mis-directed write. */
			if (value === undefined || value.startsWith("--")) {
				console.error(`${arg} needs a value`);
				process.exit(1);
			}
			if (arg === "--source") options.source = value;
			else if (arg === "--settings") options.settings = value;
			else if (arg === "--provider") options.provider = value;
			else if (arg === "--plugin") options.plugin = value;
			else if (arg === "--node-modules") options.nodeModules = value;
			else options.jsonOut = value;
		} else {
			console.error(`unknown argument: ${arg}`);
			process.exit(1);
		}
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));
options.plugin = options.plugin === undefined ? undefined : resolve(options.plugin);
/* The scratch directory is created here, before anything reads an environment
 * variable, so the defaults below can point into it. */
const WORK = sandbox("fallback");
const SOURCE = resolve(options.source ?? adapterEntry());
if (!existsSync(SOURCE)) {
	console.error(`no such adapter file: ${SOURCE}`);
	process.exit(1);
}
if (process.env.DSH_PI_AI_CATALOG_SNAPSHOT === undefined || process.env.DSH_PI_AI_CATALOG_SNAPSHOT.length === 0) {
	/* A run nobody configured gets its own empty catalog rather than the machine's:
	 * the alternative is a diagnostic that silently judges against live data and can
	 * replace it. */
	process.env.DSH_PI_AI_CATALOG_SNAPSHOT = WORK.file("snapshot.json");
	writeFileSync(process.env.DSH_PI_AI_CATALOG_SNAPSHOT, JSON.stringify({ fetchedAt: new Date().toISOString(), source: "scratch", providers: 0, count: 0, models: {} }));
}
if (options.refresh !== true) process.env.DSH_PI_AI_CATALOG_REFRESH = "0";
const MATCH = /^(.*[\\/]node_modules)[\\/]@deepseek-ai[\\/]dsh-llm-pi-ai[\\/]lib[\\/]index\.js$/.exec(SOURCE);
const NODE_MODULES = options.nodeModules === undefined ? (MATCH === null ? undefined : MATCH[1]) : resolve(options.nodeModules);
if (NODE_MODULES === undefined || !existsSync(join(NODE_MODULES, "@earendil-works", "pi-ai"))) {
	console.error(`cannot find the dependency tree for ${SOURCE}; pass --node-modules <…/node_modules>`);
	process.exit(1);
}
/*
 * The plugin decides precedence from the settings document, so point it at the
 * same file this run feeds the adapter — otherwise a synthetic run would be
 * judged against the live ~/.dsh/settings.yaml.
 */
if (options.settings !== undefined) process.env.DSH_PI_AI_SETTINGS_FILE = resolve(options.settings.replace(/^~/, process.env.HOME ?? "~"));

/**
 * Throwaway mirror so the copy resolves the install's own dependencies.
 *
 * The directory lives in the system temp area and carries this process's id: two
 * concurrent runs used to share one path derived from the source name alone, and a
 * crashed run used to leave it behind inside the checkout. The shared sandbox hook
 * removes it on exit and on a signal.
 * @param source - the adapter file to copy.
 * @returns the path of the copied module.
 */
function mirrorFor(source) {
	const dir = WORK.file("mirror");
	mkdirSync(dir, { recursive: true });
	symlinkSync(NODE_MODULES, join(dir, "node_modules"), "dir");
	const target = join(dir, "adapter.mjs");
	copyFileSync(source, target);
	return target;
}

/** The settings section to feed the adapter (`{ providers: { … } }`). */
function loadProviders() {
	if (options.settings === undefined) {
		return { providers: {
			probe: {
				displayName: "probe",
				api: "openai-responses",
				baseURL: "http://127.0.0.1:1/v1",
				models: [
					{ id: "probe/glm-5.3", name: "probe/glm-5.3" },
					{ id: "probe/gpt-5.4", name: "probe/gpt-5.4" },
					{ id: "probe/kimi-k3", name: "probe/kimi-k3" },
					{ id: "miclprobe/mimo-v2.5", name: "miclprobe/mimo-v2.5" },
					{ id: "probe/minimax-m3", name: "probe/minimax-m3" },
					{ id: "probe/glm-5v-turbo", name: "probe/glm-5v-turbo" },
					/* the official deepseek route's V41 flash, in its three spellings */
					{ id: "probe/deepseek-v4.1-flash", name: "probe/deepseek-v4.1-flash" },
					{ id: "probe/deepseek-v41-flash", name: "probe/deepseek-v41-flash" },
					{ id: "probe/DeepSeek-V4-Flash-Vision", name: "probe/DeepSeek-V4-Flash-Vision" },
					/* a model only the models.dev fixture knows */
					{ id: "probe/zephyr-9-pro", name: "probe/zephyr-9-pro" },
					/* the same name from two snapshot providers, one of them the vendor */
					{ id: "probe/kimi-k9-ultra", name: "probe/kimi-k9-ultra" },
					/* a chat row and a non-chat row sharing one bare name */
					{ id: "probe/nebula-5", name: "probe/nebula-5" },
					/* an aggregator/catalog disagreement: the catalog must win */
					{ id: "probe/longcat-2.0", name: "probe/longcat-2.0" },
					/* a model nothing anywhere describes */
					{ id: "probe/unknown-model-x", name: "probe/unknown-model-x" },
					/* the hy family's own upstream is the opencode-go aggregator */
					{ id: "probe/hy4-preview", name: "probe/hy4-preview" },
					{ id: "deepseek-v4-flash", name: "deepseek-v4-flash" }
				]
			}
		} };
	}
	const require = createRequire(join(NODE_MODULES, "noop.js"));
	const yaml = require("js-yaml");
	const document = yaml.load(readFileSync(resolve(options.settings.replace(/^~/, process.env.HOME ?? "~")), "utf8"));
	const section = document["llm-pi-ai"];
	if (section === undefined || typeof section.providers !== "object") {
		console.error("that settings file has no llm-pi-ai.providers section");
		process.exit(1);
	}
	return section;
}

/** A Cordis context stub: enough for `apply()` to build and hand us the adapter. */
function fakeContext() {
	const captured = {};
	const noop = () => {};
	const logged = (level) => (...args) => process.stderr.write(`[${level}] ${args.map((value) => String(value)).join(" ")}\n`);
	const ctx = {
		get: () => undefined,
		inject: noop,
		logger: { debug: logged("debug"), info: logged("plugin"), warn: logged("warn"), error: logged("error") },
		llm: {
			registerConfigurableProviders: () => ({ replace: noop }),
			registerModelDiscovery: noop,
			registerAdapter: (routes, adapter) => {
				captured.routes = routes;
				captured.adapter = adapter;
				return { replace: noop };
			}
		}
	};
	return { ctx, captured };
}

/*
 * A plugin test must import the very module the plugin patches: a copied mirror
 * would be a different module instance under a different URL. So a plugin run
 * loads the source in place, and `--node-modules` only matters for the mirror
 * path used by the source-patch runs.
 */
const adapterPath = options.plugin === undefined ? mirrorFor(SOURCE) : SOURCE;
const { apply } = await import(pathToFileURL(adapterPath).href);
const providers = loadProviders();
const { ctx, captured } = fakeContext();
if (options.plugin !== undefined) {
	const plugin = await import(pathToFileURL(options.plugin).href);
	plugin.apply(ctx);
	console.log(`plugin: ${options.plugin} -> ${plugin.name ?? "(unnamed)"}`);
}
apply(ctx, providers);
const adapter = captured.adapter;
if (adapter === undefined) {
	console.error("apply() registered no adapter — nothing to test");
	process.exit(1);
}

const rows = [];
for (const [provider, profile] of Object.entries(providers.providers)) {
	if (options.provider !== undefined && options.provider !== provider) continue;
	for (const entry of profile.models ?? []) {
		const id = typeof entry === "string" ? entry : entry.id;
		const model = adapter.current().models.getModel(provider, id);
		const info = model === undefined ? undefined : await adapter.resolveModel(provider, id);
		rows.push({
			provider,
			id,
			contextWindow: model?.contextWindow,
			maxTokens: model?.maxTokens,
			input: model?.input,
			api: model?.api,
			baseUrl: model?.baseUrl,
			cost: model?.cost,
			compat: model?.compat,
			reasoning: info?.reasoning === undefined ? [] : info.reasoning.efforts.map((effort) => effort.id)
		});
	}
}

if (options.jsonOut !== undefined) {
	/* A file, not stdout: the caller gets the rows without having to find where a
	 * banner ended, and the human-readable report below stays readable. */
	writeFileSync(resolve(options.jsonOut), JSON.stringify(rows));
	console.log(`${String(rows.length)} rows -> ${resolve(options.jsonOut)}`);
	process.exit(0);
}

if (options.json) {
	console.log(JSON.stringify(rows, undefined, 2));
	process.exit(0);
}

const DEFAULT_CONTEXT = 262144;
let matched = 0;
let reasoned = 0;
console.log(`source: ${SOURCE}`);
console.log(`models: ${String(rows.length)}   (default context window when nothing is known: ${String(DEFAULT_CONTEXT)})`);
console.log("");
console.log("provider/model".padEnd(38), "context".padStart(9), "maxTok".padStart(8), "api".padEnd(17), "levels");
for (const row of rows) {
	if (row.contextWindow !== undefined && row.contextWindow !== DEFAULT_CONTEXT) matched++;
	if (row.reasoning.length > 0) reasoned++;
	console.log(
		`${row.provider}/${row.id}`.padEnd(38),
		String(row.contextWindow ?? "-").padStart(9),
		String(row.maxTokens ?? "-").padStart(8),
		String(row.api ?? "-").padEnd(17),
		row.reasoning.length === 0 ? "-" : row.reasoning.join("/")
	);
}
console.log("");
console.log(`non-default context windows: ${String(matched)}/${String(rows.length)}   models offering reasoning levels: ${String(reasoned)}/${String(rows.length)}`);
const sample = rows.find((row) => row.maxTokens !== undefined && row.reasoning.length > 0);
if (sample !== undefined) {
	console.log("");
	console.log("route-owned fields on the first filled-in row (must NOT come from the catalog):");
	console.log(`  ${sample.provider}/${sample.id}`);
	console.log(`  api=${String(sample.api)}  baseUrl=${String(sample.baseUrl)}`);
	console.log(`  cost=${JSON.stringify(sample.cost)}  compat=${JSON.stringify(sample.compat)}`);
}
