#!/usr/bin/env node
/**
 * wire-effort.mjs — what a gateway actually receives as `reasoning.effort`.
 *
 * The fallback's job is to describe a model a gateway does not describe, and the
 * thinking-level map it borrows from a catalog is a *wire vocabulary* belonging
 * to a different route. Getting that translation wrong is invisible in the
 * settings UI and shows up as a failed turn instead:
 *
 *   cpa API error (400): {"message":"level \"off\" not supported, valid levels:
 *   low, medium, high","type":"invalid_request_error"}
 *
 * which is what pi-ai produced when the map borrowed from the official DeepSeek
 * catalog (`off: "off"`, a level *id* there, never a wire string) was copied onto
 * an OpenAI-compatible route: on any request that named no level — a session's
 * first turn, its title, a compaction — pi-ai writes `reasoning.effort` from
 * `map.off`, so every such request carried the literal `"off"`.
 *
 * This suite drives the real request builder with the real adapter model: the
 * payload is captured from pi-ai's own `onPayload`, so the assertion is about the
 * bytes a gateway sees, not about the plugin's intentions.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adapterEntry, nodeModulesDir } from "../dev-paths.mjs";
import { cordisContext, quietLogger, sandbox, suite } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..", "lib/index.mjs");
const RESPONSES_API = join(nodeModulesDir(), "@earendil-works/pi-ai", "dist", "api", "openai-responses.js");

/* Declarations are readable but empty: nothing is pinned, so the plugin borrows. */
const WORK = sandbox("wire-effort");
const settings = WORK.file("settings.yaml");
writeFileSync(settings, "llm-pi-ai:\n  providers: {}\n");
process.env.DSH_PI_AI_SETTINGS_FILE = settings;
process.env.DSH_PI_AI_CATALOG_SNAPSHOT = WORK.file("snapshot.json");
writeFileSync(process.env.DSH_PI_AI_CATALOG_SNAPSHOT, JSON.stringify({ fetchedAt: new Date().toISOString(), source: "test", providers: 0, count: 0, models: {} }));
process.env.DSH_PI_AI_CATALOG_REFRESH = "0";

const plugin = await import(pathToFileURL(PLUGIN).href);
const { apply, Config } = await import(pathToFileURL(adapterEntry()).href);
const { streamSimple } = await import(pathToFileURL(RESPONSES_API).href);

const { ctx, captured } = cordisContext(quietLogger());
plugin.apply(ctx);

const providers = { providers: { probe: {
	displayName: "probe",
	api: "openai-responses",
	baseURL: "http://127.0.0.1:1/v1",
	models: [
		/* borrows the official DeepSeek route's map — the one that said off: "off" */
		{ id: "probe/deepseek-v4.1-flash", name: "probe/deepseek-v4.1-flash" },
		/* borrows a pi-ai catalog map that already spells off as "none" */
		{ id: "probe/glm-5.2", name: "probe/glm-5.2" },
		/* borrows a catalog map that refuses to express off at all */
		{ id: "probe/kimi-k3", name: "probe/kimi-k3" }
	]
} } };
apply(ctx, typeof Config === "function" ? Config(providers) : providers);
const adapter = captured.adapter;

const surface = (id) => adapter.current().models.getModel("probe", id);

/**
 * The request body pi-ai would send for one model at one level.
 * @param id - configured model id.
 * @param level - the level the agent asks for, or undefined for "none named".
 * @returns the parsed body.
 */
async function payload(id, level) {
	const model = surface(id);
	if (model === undefined) throw new Error(`no model ${id}`);
	/*
	 * The system prompt travels as a leading transcript message, which is how the
	 * adapter hands it over: that is the shape pi-ai spells as `role: "system"` or
	 * `role: "developer"` depending on the model's reasoning flag.
	 */
	const context = { messages: [
		{ role: "system", content: "You are a coding agent.", timestamp: 0 },
		{ role: "user", content: "hi", timestamp: Date.now() }
	], tools: [] };
	let capturedBody;
	const capturedAsJson = (params) => {
		capturedBody = params;
		throw new Error("captured");
	};
	const stream = streamSimple(model, context, {
		...(level === undefined ? {} : { reasoning: level }),
		apiKey: "test",
		onPayload: capturedAsJson,
		fetch: async () => new Response("{}", { status: 400, headers: { "content-type": "application/json" } })
	});
	try {
		for await (const _event of stream) { /* the capture aborts the stream */ }
	} catch {
		/* `onPayload` throwing is the abort. */
	}
	if (capturedBody === undefined) throw new Error(`pi-ai built no payload for ${id}`);
	return capturedBody;
}

const { expect, finish } = suite("wire effort");

/*
 * The map itself: a borrowed "off" is never the level id of the route it came
 * from, because that id is a wire value there and not here.
 */
const deepseek = surface("probe/deepseek-v4.1-flash");
expect("the borrowed map spells off as the OpenAI family's none", deepseek?.thinkingLevelMap?.off, "none");
expect("and keeps the levels the catalog actually offers", [deepseek?.thinkingLevelMap?.low, deepseek?.thinkingLevelMap?.high, deepseek?.thinkingLevelMap?.max], ["low", "high", "max"]);

/*
 * The payloads. Before the fix the first two produced `{"effort":"off"}`, which
 * the gateway answered with a 400 naming the level.
 */
const unnamed = await payload("probe/deepseek-v4.1-flash", undefined);
expect("a request that names no level carries none, never off", unnamed.reasoning?.effort, "none");
const offExplicit = await payload("probe/deepseek-v4.1-flash", "off");
expect("asking for off carries none too", offExplicit.reasoning?.effort, "none");
const max = await payload("probe/deepseek-v4.1-flash", "max");
expect("a named level still travels as itself", max.reasoning?.effort, "max");
const high = await payload("probe/deepseek-v4.1-flash", "high");
expect("likewise high", high.reasoning?.effort, "high");

/* No level pi-ai can produce may ever be the literal string "off" on this route. */
const spelled = [];
for (const id of ["probe/deepseek-v4.1-flash", "probe/glm-5.2", "probe/kimi-k3"]) {
	for (const level of [undefined, "off", "low", "medium", "high", "max"]) {
		const body = await payload(id, level);
		if (body.reasoning?.effort === "off") spelled.push(`${id}@${level ?? "unnamed"}`);
	}
}
expect("no model on an OpenAI-compatible route ever sends the level off", spelled, []);

/*
 * Turning reasoning on flips a second wire detail that has nothing to do with
 * reasoning: pi-ai spells the system prompt `role: "developer"` for a reasoning
 * model and `role: "system"` for every other one. A hand-declared gateway model
 * was non-reasoning before this plugin described it, and one such endpoint
 * answers the other spelling with `400 {"code":3000101,"msg":"invalid parameter"}`
 * (measured; its sibling route accepts "developer", which is why this only shows
 * up on some models). The borrow therefore pins the role the route already used.
 */
expect("turning reasoning on pins the system-prompt role the route already accepted", deepseek?.compat?.supportsDeveloperRole, false);
expect("so the system prompt still travels as system", [unnamed.input[0]?.role, max.input[0]?.role], ["system", "system"]);

/*
 * The other two sources keep their own meaning: a catalog that already says
 * "none" is unchanged, and one that says "cannot express off" still omits the
 * parameter rather than inventing a spelling for it.
 */
const glm = surface("probe/glm-5.2");
expect("a catalog spelling of none is left alone", glm?.thinkingLevelMap?.off, "none");
const kimi = surface("probe/kimi-k3");
expect("a catalog that cannot express off keeps null", kimi?.thinkingLevelMap?.off, null);
const kimiBody = await payload("probe/kimi-k3", undefined);
expect("and its requests omit the parameter entirely", "reasoning" in kimiBody, false);

WORK.clean();
finish();
