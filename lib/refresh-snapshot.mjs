#!/usr/bin/env node
/**
 * refresh-snapshot.mjs — update the models.dev snapshot by hand.
 *
 * This ships inside the plugin package so the installed copy is self-contained;
 * the workspace keeps the same file as its source of truth.
 *
 *   node refresh-snapshot.mjs                       # write $DSH_HOME/models-dev-snapshot.json
 *   node refresh-snapshot.mjs --out /tmp/snap.json
 *   node refresh-snapshot.mjs --settings ~/.dsh/settings.yaml   # + coverage report
 *   node refresh-snapshot.mjs --url https://mirror/api.json
 *
 * The file is written to a temporary sibling and renamed, so a plugin reading it
 * concurrently sees either the old document or the new one, never a partial one.
 * The running plugin notices the new file by its mtime and rebuilds its index on
 * the next model resolution — no restart.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SNAPSHOT_TIMEOUT_MS, SNAPSHOT_URL, fetchModelsDevSnapshot } from "./snapshot.mjs";
import { bareName, MIN_NORMALIZED_LENGTH, normalizedKeys } from "./names.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const USAGE = `node refresh-snapshot.mjs [--out <file>] [--url <endpoint>] [--timeout-ms <ms>] [--settings <settings.yaml>]

  --out         where to write the snapshot (default: $DSH_HOME/models-dev-snapshot.json)
  --url         the endpoint to read (default: ${SNAPSHOT_URL})
  --timeout-ms  how long the fetch may take (default: ${String(SNAPSHOT_TIMEOUT_MS)})
  --settings    also print which of the configured models this snapshot covers
`;

/**
 * Read one option, refusing a flag whose value is missing.
 *
 * A silently-undefined value used to reach `resolve()` and throw, or worse, fall
 * back to the live path: this tool writes the file a running plugin reads, so a
 * mis-read argument must stop the run rather than redirect the write.
 * @param name - the flag.
 * @param fallback - the value to use when the flag is absent.
 * @returns the flag's value.
 */
function option(name, fallback) {
	const at = argv.indexOf(name);
	if (at === -1) return fallback;
	const value = argv[at + 1];
	if (value === undefined || value.startsWith("--")) {
		console.error(`${name} needs a value\n\n${USAGE}`);
		process.exit(1);
	}
	return value;
}

if (argv.includes("--help") || argv.includes("-h")) {
	console.log(USAGE);
	process.exit(0);
}

const home = process.env.HOME ?? "";
/* Default: where the running plugin reads and writes it. */
const out = resolve((option("--out", join(process.env.DSH_HOME ?? join(home, ".dsh"), "models-dev-snapshot.json"))).replace(/^~/, home));
const url = option("--url", SNAPSHOT_URL);
const rawTimeout = option("--timeout-ms", String(SNAPSHOT_TIMEOUT_MS));
/* `Number("soon")` is NaN and `AbortSignal.timeout(NaN)` throws a RangeError from
 * inside the fetch, which reads as a network failure. */
if (!/^\d+$/u.test(rawTimeout) || Number(rawTimeout) <= 0) {
	console.error(`--timeout-ms expects a positive whole number of milliseconds, not ${JSON.stringify(rawTimeout)}\n\n${USAGE}`);
	process.exit(1);
}
const timeoutMs = Number(rawTimeout);

const snapshot = await fetchModelsDevSnapshot(url, timeoutMs);
mkdirSync(dirname(out), { recursive: true });
/* Written to a sibling and renamed, so a plugin reading it concurrently sees either
 * the old document or the new one; the temporary is removed on every exit path. */
const temporary = `${out}.tmp-${String(process.pid)}`;
try {
	writeFileSync(temporary, JSON.stringify(snapshot));
	renameSync(temporary, out);
} finally {
	rmSync(temporary, { force: true });
}
console.log(`wrote ${out}`);
console.log(`  fetched:   ${snapshot.fetchedAt}`);
console.log(`  providers: ${String(snapshot.providers)}   models: ${String(snapshot.count)}   reasoning-capable: ${String(Object.values(snapshot.models).filter((model) => model.reasoning).length)}   image-capable: ${String(Object.values(snapshot.models).filter((model) => model.input?.includes("image")).length)}`);

/**
 * Locate a YAML parser for the optional coverage report. The CLI lives beside
 * the plugin, outside any node_modules tree, so it reuses the same install roots
 * the plugin resolves the vendor packages from instead of `require`-ing blindly.
 * @returns the module, or undefined when no root carries js-yaml.
 */
async function loadYaml() {
	const home = process.env.HOME ?? "";
	const roots = [
		process.env.DSH_CATALOG_FALLBACK_NODE_MODULES,
		join(process.env.DSH_HOME ?? join(home, ".dsh"), "profiles", "node_modules"),
		join(HERE, "..", "node_modules")
	];
	const nvm = join(home, ".nvm", "versions", "node");
	if (typeof readdirSync === "function" && existsSync(nvm)) {
		for (const version of readdirSync(nvm)) roots.push(join(nvm, version, "lib", "node_modules", "@deepseek-ai", "dsh", "node_modules"));
	}
	for (const root of roots) {
		if (typeof root !== "string" || root.length === 0) continue;
		const file = join(root, "js-yaml", "index.js");
		if (!existsSync(file)) continue;
		try {
			return await import(pathToFileURL(file).href);
		} catch {
			/* Try the next root. */
		}
	}
	return undefined;
}

/** Optional coverage report against a settings document. */
const settingsPath = option("--settings", undefined);
if (settingsPath !== undefined) {
	const file = resolve(settingsPath.replace(/^~/, home));
	const yaml = await loadYaml();
	if (yaml === undefined) {
		console.error("no js-yaml reachable from here; skipping the coverage report (set DSH_CATALOG_FALLBACK_NODE_MODULES=<dir>)");
		process.exit(0);
	}
	const document = yaml.load(readFileSync(file, "utf8"));
	/*
	 * The same name rules the runtime uses, not a lowercase comparison of bare ids:
	 * this report used to call a model uncovered that the plugin resolves happily,
	 * because the two were matching differently.
	 */
	const keys = new Set();
	for (const id of Object.keys(snapshot.models)) {
		for (const key of normalizedKeys(bareName(id))) keys.add(key);
	}
	const configured = [];
	for (const profile of Object.values(document["llm-pi-ai"]?.providers ?? {})) {
		for (const entry of profile.models ?? []) if (typeof entry?.id === "string") configured.push(entry.id);
	}
	const covered = (id) => {
		const bare = bareName(id);
		if (bare.toLowerCase().length > 0 && Object.keys(snapshot.models).some((key) => bareName(key).toLowerCase() === bare.toLowerCase())) return true;
		if (bareName(id).length < MIN_NORMALIZED_LENGTH) return false;
		return normalizedKeys(bare).some((key) => keys.has(key));
	};
	const uncovered = [...new Set(configured.filter((id) => !covered(id)))];
	console.log(`  configured in ${file}: ${String(configured.length)}   covered by this snapshot: ${String(configured.length - uncovered.length)}`);
	if (uncovered.length > 0) console.log(`  still uncovered: ${uncovered.join(", ")}`);
}
