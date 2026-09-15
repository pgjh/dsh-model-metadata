#!/usr/bin/env node
/**
 * live-refresh.mjs — the network end-to-end for the automatic refresh.
 *
 * Opt-in (it downloads ~5 MB from models.dev) and not part of verify.mjs:
 *
 *   node tests/live-refresh.mjs
 *
 * It starts the plugin against an empty snapshot path, waits for the plugin's own
 * background fetch to land the file, and checks that the very same process then
 * resolves models out of the new data — i.e. "a newly released model starts
 * working after a daily refresh, without a restart".
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandbox } from "./harness.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adapterEntry } from "../dev-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER = adapterEntry();
const PLUGIN = process.env.DSH_CATALOG_FALLBACK_PLUGIN ?? join(HERE, "..", "lib/index.mjs");
/* Outside the checkout, like every other suite: a run killed before its cleanup hook
 * used to leave a scratch directory inside the repository. */
const WORK = sandbox("live-refresh");
const SNAPSHOT = WORK.file("models-dev-snapshot.json");
const DEADLINE_MS = Number(process.env.LIVE_REFRESH_DEADLINE_MS ?? 300000);

process.env.DSH_PI_AI_CATALOG_SNAPSHOT = SNAPSHOT;
process.env.DSH_PI_AI_SETTINGS_FILE = WORK.file("settings.yaml");
writeFileSync(process.env.DSH_PI_AI_SETTINGS_FILE, "llm-pi-ai:\n  providers: {}\n");
delete process.env.DSH_PI_AI_CATALOG_REFRESH; // default policy: refresh a missing file
const noop = () => {};
const captured = {};
const plugin = await import(pathToFileURL(PLUGIN).href);
const { apply } = await import(pathToFileURL(ADAPTER).href);
plugin.apply({ get: () => undefined, inject: noop, logger: { debug: noop, info: console.log, warn: console.error, error: console.error } });
apply({ get: () => undefined, inject: noop, logger: { debug: noop, info: noop, warn: noop, error: noop }, llm: { registerConfigurableProviders: () => ({ replace: noop }), registerModelDiscovery: noop, registerAdapter: (_routes, adapter) => { captured.adapter = adapter; return { replace: noop }; } } }, { providers: { probe: { api: "openai-responses", baseURL: "http://127.0.0.1:1/v1", models: [{ id: "probe/deepseek-v4.1-flash", name: "probe/deepseek-v4.1-flash" }] } } });

console.log(`waiting for the plugin to write ${SNAPSHOT} (deadline ${String(Math.round(DEADLINE_MS / 1000))}s)`);
const before = plugin.inspect("probe/deepseek-v4.1-flash");
console.log(`  before the refresh: ${before.chosen === undefined ? "no candidate" : `chosen ${before.chosen.route}`}`);

const started = Date.now();
let wrote = false;
while (Date.now() - started < DEADLINE_MS) {
	if (existsSync(SNAPSHOT) && statSync(SNAPSHOT).size > 1024) {
		wrote = true;
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 1000));
}

const failures = [];
const after = plugin.inspect("probe/deepseek-v4.1-flash");
if (!wrote) failures.push(`the snapshot file never appeared within ${String(Math.round(DEADLINE_MS / 1000))}s`);
else {
	console.log(`  wrote ${SNAPSHOT} (${String(Math.round(statSync(SNAPSHOT).size / 1024))} KiB) after ${String(Math.round((Date.now() - started) / 1000))}s`);
	if (after.chosen === undefined) failures.push("the new data is not visible to the running process");
	else console.log(`  after the refresh:  chosen ${after.chosen.route} (context ${String(after.chosen.contextWindow)}, image ${String(after.chosen.input?.includes("image") ?? false)})`);
}
const resolved = await captured.adapter.resolveModel("probe", "probe/deepseek-v4.1-flash");
if (resolved.context?.contextWindow === 262144) failures.push("resolution still reports the route default");
console.log(`  resolution now reports context ${String(resolved.context?.contextWindow)}`);

WORK.clean();
if (failures.length > 0) {
	for (const failure of failures) console.log(`FAIL ${failure}`);
	process.exit(1);
}
console.log("live refresh: ok");
