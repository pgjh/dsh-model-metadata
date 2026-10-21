#!/usr/bin/env node
/**
 * settings-service.mjs — the declarations source DSH 0.2.1 moved.
 *
 * DSH 0.2.1 stopped reading `$DSH_HOME/settings.yaml`: it imports that file once
 * and renames it to `settings.yaml.imported`, then serves the active profile's
 * values through `ctx.settings`. A plugin that keeps reading the old path finds
 * nothing, and this plugin's fail-closed rule then disables enrichment — the
 * regression this suite pins.
 *
 * The run has no settings file and no `DSH_PI_AI_SETTINGS_FILE`; the only
 * declarations are the `user` values a stub settings service reports. Three
 * things must follow from that:
 *   1. a declared field still wins (the fail-closed promise, now sourced from the service),
 *   2. an undeclared field is still borrowed from the catalog,
 *   3. the settings panel lists the route and its declarations instead of an empty matrix.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adapterEntry, nodeModulesDir } from "../dev-paths.mjs";
import { quietLogger, sandbox, suite } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = process.env.DSH_CATALOG_FALLBACK_PLUGIN ?? join(HERE, "..", "lib/index.mjs");
const WORK = sandbox("settings-service");

/* The 0.2.1 shape: no settings document on disk, and no override pointing at one. */
delete process.env.DSH_PI_AI_SETTINGS_FILE;
process.env.DSH_HOME = WORK.dir;
process.env.DSH_PI_AI_CATALOG_SNAPSHOT = WORK.file("snapshot.json");
writeFileSync(process.env.DSH_PI_AI_CATALOG_SNAPSHOT, JSON.stringify({ fetchedAt: new Date().toISOString(), source: "test", providers: 0, count: 0, models: {} }));
process.env.DSH_PI_AI_CATALOG_REFRESH = "0";

const route = {
	displayName: "probe",
	api: "openai-responses",
	baseURL: "http://127.0.0.1:1/v1",
	models: [
		{ id: "probe/glm-5.3", name: "probe/glm-5.3" },
		{ id: "probe/gpt-5.4", name: "probe/gpt-5.4", contextWindow: 64000, reasoningEfforts: false }
	]
};
const providers = { providers: { probe: route } };

/* What `settings.describe()` reports for a profile patch that declares the route. */
const settingsDocument = { providers: { probe: route } };
const settings = {
	configure: () => () => {},
	describe: (options) => {
		settings.describeOptions = options;
		return [{ ns: "llm-pi-ai", revision: 7, user: settingsDocument }];
	},
	describeOptions: undefined
};

/** A context whose injections answer with the stubbed services. */
function cordisContext(logger) {
	const noop = () => {};
	const effect = (fn) => {
		const dispose = fn();
		return typeof dispose === "function" ? dispose : noop;
	};
	const captured = { panel: undefined };
	return {
		captured,
		ctx: {
			get: () => undefined,
			on: noop,
			/* The adapter reads its settings namespace off the plugin fiber. */
			fiber: { entry: { options: { id: "llm-pi-ai" } } },
			inject: (names, callback) => {
				if (names.includes("settings")) callback({ settings, effect });
				if (names.includes("webServer")) callback({ effect, webServer: { register: (panel) => { captured.panel = panel; return noop; } } });
			},
			logger,
			llm: {
				registerConfigurableProviders: () => ({ replace: noop }),
				registerModelDiscovery: noop,
				registerAdapter: (_routes, adapter) => {
					captured.adapter = adapter;
					return { replace: noop };
				}
			}
		}
	};
}

const plugin = await import(pathToFileURL(PLUGIN).href);
const { apply, Config } = await import(pathToFileURL(adapterEntry()).href);
const { ctx, captured } = cordisContext(quietLogger());
plugin.apply(ctx);
apply(ctx, typeof Config === "function" ? Config(providers) : providers);
const adapter = captured.adapter;

const model = adapter.current().models.getModel("probe", "probe/gpt-5.4");
const info = await adapter.resolveModel("probe", "probe/gpt-5.4");

/* One catalog row to compare the borrowed half against: the route the plugin ranks first. */
const catalog = await import(pathToFileURL(join(nodeModulesDir(), "@earendil-works", "pi-ai", "dist", "providers", "all.js")).href);

/** A JSON response captured from the panel route. */
let status;
let body;
captured.panel.handler(
	{ method: "GET", url: "/model-metadata/matrix?provider=probe", headers: { host: "127.0.0.1" } },
	{ writeHead(code) { status = code; }, end(value) { body = value; } }
);
const matrix = JSON.parse(body);

const { expect, ok, finish } = suite("settings service");

expect("a declaration reported by the settings service wins over the catalog", model.contextWindow, 64000);
expect("an undeclared output cap is still borrowed", Number.isInteger(model.maxTokens) && model.maxTokens > 0, true);
expect("a declared reasoning opt-out is honored", info.reasoning, undefined);
ok("the service was asked to redact credentials", settings.describeOptions?.redactSecrets === true);
expect("the panel lists the configured route", matrix.routes.map((entry) => entry.route), ["probe"]);
expect("the panel lists every model", matrix.routes[0]?.models?.length, 2);
expect("the panel reports the declaration the service reported", matrix.routes[0]?.models?.[1]?.declared?.contextWindow, 64000);
expect("the panel answers 200", status, 200);
if (catalog !== undefined) {
	const row = (catalog.getBuiltinModels("openai") ?? []).find((entry) => entry.id === "gpt-5.4");
	if (row !== undefined) expect("the borrowed cap is the catalog's", model.maxTokens, row.maxTokens);
}

WORK.clean();
finish();
