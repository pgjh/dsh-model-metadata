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
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adapterEntry } from "../dev-paths.mjs";
import { recordingLogger, sandbox, suite } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER = adapterEntry();
const PLUGIN = process.env.DSH_CATALOG_FALLBACK_PLUGIN ?? join(HERE, "..", "lib/index.mjs");
const WORK = sandbox("hot-snapshot");
const SNAPSHOT = WORK.file("models-dev-snapshot.json");

process.env.DSH_PI_AI_CATALOG_SNAPSHOT = SNAPSHOT;
process.env.DSH_PI_AI_CATALOG_REFRESH = "0"; // the test owns the file
process.env.DSH_PI_AI_SETTINGS_FILE = WORK.file("settings.yaml");
writeFileSync(process.env.DSH_PI_AI_SETTINGS_FILE, "llm-pi-ai:\n  providers: {}\n");

/** One snapshot document around the given per-model values. */
function writeSnapshot(models) {
	writeFileSync(SNAPSHOT, JSON.stringify({ fetchedAt: new Date().toISOString(), source: "test", providers: 1, count: Object.keys(models).length, models }));
}
const entry = (contextWindow, reasoning = true) => ({ provider: "vendor", contextWindow, maxTokens: 4096, reasoning });

const { expect, ok, finish } = suite("hot snapshot");

const providers = { providers: { probe: { displayName: "probe", api: "openai-responses", baseURL: "http://127.0.0.1:1/v1", models: [{ id: "acme/glm-5.3", name: "acme/glm-5.3" }, { id: "acme/brand-new-model", name: "acme/brand-new-model" }] } } };

const captured = {};
const { logger: quiet, warnings } = recordingLogger();
const plugin = await import(pathToFileURL(PLUGIN).href);
const { apply } = await import(pathToFileURL(ADAPTER).href);
plugin.apply({ get: () => undefined, inject: () => {}, logger: quiet });
apply({ get: () => undefined, inject: () => {}, logger: quiet, llm: { registerConfigurableProviders: () => ({ replace: () => {} }), registerModelDiscovery: () => {}, registerAdapter: (_routes, adapter) => { captured.adapter = adapter; return { replace: () => {} }; } } }, providers);
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

/* 5. a rewrite of exactly the same size is still noticed: the change key is mtime
 * *and* size, and size alone would not see it. */
writeSnapshot({ "brand-new-model": entry(65536) });
const before = await contextOf("acme/brand-new-model");
/* The same document, one digit apart in one number: identical length, different content. */
writeSnapshot({ "brand-new-model": { provider: "vendor", contextWindow: 75536, maxTokens: 4096, reasoning: true } });
expect("a same-size rewrite is seen, so size alone is not the change key", [before, await contextOf("acme/brand-new-model")], [65536, 75536]);

/* 6. a broken file must not take resolution down with it — and must say so. */
writeFileSync(SNAPSHOT, "{ this is not json");
expect("a corrupt snapshot keeps resolution working", typeof (await contextOf("acme/glm-5.3")), "number");
expect("a corrupt snapshot is reported once, not silently swallowed", [warnings.length, warnings[0]?.includes(SNAPSHOT)], [1, true]);
/* Reading it again (a second resolution) must not repeat the warning. */
await contextOf("acme/brand-new-model");
expect("and not repeated on every resolution", warnings.length, 1);

WORK.clean();
finish();
