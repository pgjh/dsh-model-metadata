#!/usr/bin/env node
/**
 * hot-add-model.mjs — diagnostic: does a model ADDED to a provider while the
 * process runs get enriched, without a restart?
 *
 * Production mechanism under test: a settings change makes the settings service
 * hand the adapter a new raw config; `profiles()` resolves a NEW profiles Map;
 * `current()` sees the identity change and builds a NEW models collection; the
 * plugin's prototype wrap then wraps that fresh collection. This script
 * reproduces exactly that on ONE adapter instance: after the first apply, the
 * instance's `config.profiles` is pointed at a second apply's profiles closure
 * (the same "new object identity" a settings edit produces), and a model that
 * only exists in the second config is resolved through the SAME instance.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adapterEntry, nodeModulesDir } from "../dev-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..", "lib/index.mjs");

/* A settings file the plugin can read (declarations win over matches). */
const WORK = join(HERE, ".hot-add");
mkdirSync(WORK, { recursive: true });
const settings = join(WORK, "settings.yaml");
writeFileSync(settings, "llm-pi-ai:\n  providers: {}\n");
process.env.DSH_PI_AI_SETTINGS_FILE = settings;
process.env.DSH_PI_AI_CATALOG_REFRESH = "0";

const plugin = await import(pathToFileURL(PLUGIN).href);
const { apply } = await import(pathToFileURL(adapterEntry()).href);

const noop = () => {};
const quiet = { debug: noop, info: noop, warn: noop, error: noop };
const captured = {};
const ctx = {
	get: () => undefined,
	inject: noop,
	logger: quiet,
	llm: {
		registerConfigurableProviders: () => ({ replace: noop }),
		registerModelDiscovery: noop,
		registerAdapter: (_routes, adapter) => {
			captured.adapter = adapter;
			return { replace: noop };
		}
	}
};

const route = (models) => ({
	displayName: "probe",
	api: "openai-responses",
	baseURL: "http://127.0.0.1:1/v1",
	models
});

/* Config A: what the process started with. */
const providersA = { providers: { probe: route([
	{ id: "probe/glm-5.3", name: "probe/glm-5.3" }
]) } };
/* Config B: the same route with one model ADDED at runtime. */
const providersB = { providers: { probe: route([
	{ id: "probe/glm-5.3", name: "probe/glm-5.3" },
	{ id: "probe/deepseek-v41-flash", name: "probe/deepseek-v41-flash" },
	{ id: "probe/DeepSeek-V4-Flash-Vision", name: "probe/DeepSeek-V4-Flash-Vision" }
]) } };

plugin.apply(ctx);
apply(ctx, providersA);
const adapter = captured.adapter;

const show = async (label, id) => {
	const model = adapter.current().models.getModel("probe", id);
	const info = model === undefined ? undefined : await adapter.resolveModel("probe", id);
	console.log(`${label}  ${id}`);
	console.log(`    descriptor: context=${String(model?.contextWindow)}  maxTokens=${String(model?.maxTokens)}  input=${JSON.stringify(model?.input)}`);
	console.log(`    reasoning:  ${info?.reasoning === undefined ? "none" : info.reasoning.efforts.map((effort) => effort.id).join("/")}`);
	return { contextWindow: model?.contextWindow, efforts: info?.reasoning?.efforts?.map((effort) => effort.id) };
};

console.log("=== before the settings change (config A) ===");
await show("start ", "probe/glm-5.3");

/*
 * The settings change, as the settings service performs it: the adapter's
 * profiles source starts answering with the new configuration. Same instance,
 * same prototype wrap, same running process.
 */
apply(ctx, providersB);
adapter.config.profiles = captured.adapter.config.profiles;

console.log("=== after the settings change, same process (config B) ===");
const added1 = await show("added ", "probe/deepseek-v41-flash");
const added2 = await show("added ", "probe/DeepSeek-V4-Flash-Vision");
const kept = await show("kept  ", "probe/glm-5.3");

const failures = [];
if (added1.contextWindow !== 1000000) failures.push(`v41-flash context: ${String(added1.contextWindow)} (wanted 1000000)`);
if (added1.efforts?.join("/") !== "off/low/high/max") failures.push(`v41-flash levels: ${String(added1.efforts?.join("/"))}`);
if (added2.contextWindow !== 1000000) failures.push(`Vision context: ${String(added2.contextWindow)} (wanted 1000000)`);
if (added2.efforts?.join("/") !== "off/low/high/max") failures.push(`Vision levels: ${String(added2.efforts?.join("/"))}`);
if (kept.contextWindow !== 1000000) failures.push(`glm-5.3 context: ${String(kept.contextWindow)}`);
console.log("");
if (failures.length === 0) console.log("PASS: models added at runtime are enriched without a restart");
else {
	console.log("FAIL:");
	for (const failure of failures) console.log(`  ${failure}`);
	process.exitCode = 1;
}
rmSync(WORK, { recursive: true, force: true });
