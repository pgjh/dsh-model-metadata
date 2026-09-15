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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SNAPSHOT_TIMEOUT_MS, SNAPSHOT_URL, fetchModelsDevSnapshot } from "./snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
function option(name, fallback) {
	const at = argv.indexOf(name);
	return at === -1 ? fallback : argv[at + 1];
}

const home = process.env.HOME ?? "";
/* Default: where the running plugin reads and writes it. */
const out = resolve((option("--out", join(process.env.DSH_HOME ?? join(home, ".dsh"), "models-dev-snapshot.json"))).replace(/^~/, home));
const url = option("--url", SNAPSHOT_URL);
const timeoutMs = Number(option("--timeout-ms", String(SNAPSHOT_TIMEOUT_MS)));

const snapshot = await fetchModelsDevSnapshot(url, timeoutMs);
mkdirSync(dirname(out), { recursive: true });
const temporary = `${out}.tmp-${String(process.pid)}`;
writeFileSync(temporary, JSON.stringify(snapshot));
renameSync(temporary, out);
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
	const byBare = new Set(Object.keys(snapshot.models).map((id) => id.slice(id.lastIndexOf("/") + 1).toLowerCase()));
	const configured = [];
	for (const profile of Object.values(document["llm-pi-ai"]?.providers ?? {})) {
		for (const entry of profile.models ?? []) if (typeof entry?.id === "string") configured.push(entry.id);
	}
	const uncovered = [...new Set(configured.filter((id) => !byBare.has(id.slice(id.lastIndexOf("/") + 1).toLowerCase())))];
	console.log(`  configured in ${file}: ${String(configured.length)}   covered by this snapshot: ${String(configured.length - uncovered.length)}`);
	if (uncovered.length > 0) console.log(`  still uncovered: ${uncovered.join(", ")}`);
}
