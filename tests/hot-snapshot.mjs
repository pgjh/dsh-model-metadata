#!/usr/bin/env node
/**
 * hot-snapshot.mjs — the "new model without a restart" acceptance test.
 *
 * A running server must notice a rewritten snapshot by itself: the plugin keys
 * its lookup on the file's mtime, so an update made by refresh-snapshot.mjs — or
 * by the background refresh — has to change what the very next resolution sees,
 * inside the same process. This drives that directly:
 *
 *   1. a model nothing describes resolves on the route default
 *   2. adding it to the snapshot gives it metadata, mid-process
 *   3. changing its values is seen immediately
 *   4. the ranking still prefers the shipped catalog over models.dev
 *   5. an unreadable document keeps resolution working
 *
 * Runs against the real install (never modified) with this checkout's plugin, in
 * its own temp directory, and exits non-zero on any mismatch.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adapterEntry } from "../dev-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER = adapterEntry();
const PLUGIN = process.env.DSH_CATALOG_FALLBACK_PLUGIN ?? join(HERE, "..", "lib/index.mjs");
const WORK = join(HERE, ".hot-snapshot");
const SNAPSHOT = join(WORK, "models-dev-snapshot.json");

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
process.env.DSH_PI_AI_CATALOG_SNAPSHOT = SNAPSHOT;
process.env.DSH_PI_AI_CATALOG_REFRESH = "0"; // the test owns the file
process.env.DSH_PI_AI_SETTINGS_FILE = join(WORK, "settings.yaml");
writeFileSync(join(WORK, "settings.yaml"), "llm-pi-ai:\n  providers: {}\n");

/** One snapshot document around the given per-model values. */
function writeSnapshot(models) {
	writeFileSync(SNAPSHOT, JSON.stringify({ fetchedAt: new Date().toISOString(), source: "test", providers: 1, count: Object.keys(models).length, models }));
}
const entry = (contextWindow, reasoning = true) => ({ provider: "vendor", contextWindow, maxTokens: 4096, reasoning });

const failures = [];
let checks = 0;
function expect(label, actual, wanted) {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) failures.push(`${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
}

const providers = { providers: { probe: { displayName: "probe", api: "openai-responses", baseURL: "http://127.0.0.1:1/v1", models: [{ id: "acme/glm-5.3", name: "acme/glm-5.3" }, { id: "acme/brand-new-model", name: "acme/brand-new-model" }] } } };

const captured = {};
const noop = () => {};
const quiet = { debug: noop, info: noop, warn: noop, error: noop };
const plugin = await import(pathToFileURL(PLUGIN).href);
const { apply } = await import(pathToFileURL(ADAPTER).href);
plugin.apply({ get: () => undefined, inject: noop, logger: quiet });
apply({ get: () => undefined, inject: noop, logger: quiet, llm: { registerConfigurableProviders: () => ({ replace: noop }), registerModelDiscovery: noop, registerAdapter: (_routes, adapter) => { captured.adapter = adapter; return { replace: noop }; } } }, providers);
const adapter = captured.adapter;
const infoOf = (id) => adapter.resolveModel("probe", id);
const contextOf = async (id) => (await infoOf(id)).context?.contextWindow;

/* 1. nothing anywhere describes this model yet */
expect("undescribed model starts on the route default", await contextOf("acme/brand-new-model"), 262144);
expect("a bundled-catalog model resolves from the catalog", await contextOf("acme/glm-5.3"), 1000000);

/* 2. the snapshot adds it — no restart */
writeSnapshot({ "brand-new-model": entry(131072) });
expect("a model added to the snapshot gains metadata live", await contextOf("acme/brand-new-model"), 131072);
expect("its reasoning levels arrive with it", (await infoOf("acme/brand-new-model")).reasoning?.efforts.map((effort) => effort.id), ["off", "minimal", "low", "medium", "high"]);

/* 3. changed values are seen immediately */
writeSnapshot({ "brand-new-model": entry(65536, false) });
expect("a changed context window is seen immediately", await contextOf("acme/brand-new-model"), 65536);
expect("a withdrawn reasoning capability is seen immediately", (await infoOf("acme/brand-new-model")).reasoning, undefined);

/* 4. models.dev never outranks the shipped catalog for the same name */
writeSnapshot({ "glm-5.3": entry(123456), "brand-new-model": entry(65536) });
expect("the shipped catalog still wins for a known name", await contextOf("acme/glm-5.3"), 1000000);

/* 5. a broken file must not take resolution down with it */
writeFileSync(SNAPSHOT, "{ this is not json");
expect("a corrupt snapshot keeps resolution working", typeof (await contextOf("acme/glm-5.3")), "number");

console.log(`${String(checks - failures.length)}/${String(checks)} hot-snapshot assertions passed`);
rmSync(WORK, { recursive: true, force: true });
if (failures.length > 0) {
	for (const failure of failures) console.log(`FAIL ${failure}`);
	process.exit(1);
}
