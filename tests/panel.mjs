#!/usr/bin/env node
/**
 * panel.mjs (test) — the Settings → Models panel, verified without a browser.
 *
 * Three things are checked:
 *   1. `buildMatrix` reports what the chain matched for every configured model;
 *   2. a write produces ops that preserve keys the panel does not own, delete the
 *      fields the user cleared, and never touch the capacity pair — those two
 *      belong to the shipped editor's own 容量 disclosure;
 *   3. the client bundle loads through the real `window.__ModuleLoader__` shape,
 *      registers into `settings.models.provider-card` without rendering a block of
 *      its own, and its helpers agree with the host's `panel.mjs` — the two halves
 *      must not drift.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { installedManifest, homePatchRow } from "../packaging.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = process.env.DSH_CATALOG_FALLBACK_PLUGIN ?? join(HERE, "..", "lib/index.mjs");
const CLIENT = join(dirname(PLUGIN), "client.js");

const failures = [];
let checks = 0;
function expect(label, actual, wanted) {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) failures.push(`${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
}

/* 1 + 2: the host-side builders. */
const panel = await import(pathToFileURL(join(dirname(PLUGIN), "panel.mjs")).href);
const providers = {
	"my-gateway": {
		displayName: "my-gateway",
		api: "openai-responses",
		models: [
			{ id: "probe/glm-5.3", name: "probe/glm-5.3" },
			{ id: "probe/glm-5v-turbo", name: "probe/glm-5v-turbo", compat: { supportsStore: false } },
			{ id: "probe/qwen-3.8-max", name: "probe/qwen-3.8-max" }
		]
	}
};
const inspect = (id) => id === "probe/qwen-3.8-max"
	? { id, candidates: [], cataloguedUnder: [], chosen: undefined }
	: { id, candidates: [], cataloguedUnder: [], chosen: { route: id === "probe/glm-5.3" ? "zai" : "zai-coding-cn", source: "pi-ai-catalog", contextWindow: 1000000, maxTokens: 131072, reasoning: true, input: ["text", "image"] } };

const matrix = panel.buildMatrix(providers, inspect);
expect("matrix lists the configured route", matrix.routes.map((route) => route.route), ["my-gateway"]);
expect("matrix lists every model", matrix.routes[0].models.map((row) => row.id), ["probe/glm-5.3", "probe/glm-5v-turbo", "probe/qwen-3.8-max"]);
expect("an unmatched model is reported as unmatched", matrix.routes[0].models[2].matched, undefined);
expect("a matched model carries its verdict and source", [matrix.routes[0].models[1].matched.route, matrix.routes[0].models[1].matched.input], ["zai-coding-cn", ["text", "image"]]);
expect("nothing is declared yet", matrix.routes[0].models[0].declared, {});
expect("the stored entry travels with the row", matrix.routes[0].models[1].stored.compat, { supportsStore: false });

const edited = panel.applyChoice(matrix.routes[0].models[1].stored, { contextWindow: 200000, maxTokens: undefined, reasoningEfforts: { low: "low" }, input: ["text", "image"] });
expect("an edit keeps keys the panel does not own", edited.compat, { supportsStore: false });
expect("an edit writes the two fields upstream has no control for", [edited.reasoningEfforts, edited.input], [{ low: "low" }, ["text", "image"]]);
expect("the capacity pair is left to the shipped 容量 disclosure, never rewritten here", [edited.contextWindow, "maxTokens" in edited], [undefined, false]);
expect("a capacity the panel did not touch survives untouched", panel.applyChoice({ id: "x", contextWindow: 262144, maxTokens: 32768 }, {}).contextWindow, 262144);
expect("clearing every editable field leaves the rest of the entry", Object.keys(panel.applyChoice({ id: "x", name: "x", contextWindow: 1 }, {})), ["id", "name", "contextWindow"]);
expect("the payload names what is reportable and what is editable", [matrix.fields, matrix.editable], [["contextWindow", "maxTokens", "reasoningEfforts", "input"], ["reasoningEfforts", "input"]]);
expect("a write writes the whole model array of one route", panel.buildOps("my-gateway", [edited]), [{ op: "set", path: ["providers", "my-gateway", "models"], value: [edited] }]);

/* 3: the client bundle, loaded through the shape DSH's client runtime uses. */
/* The manifest is the package root's now, not the entry's directory: `lib/` holds
 * only sources, the package metadata lives one level up. */
const manifest = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
expect("the manifest points the client module system at the bundle", [manifest.exports?.["./client"], manifest.dsh?.client?.platform], ["./lib/client.js", "web"]);
/* The npm/git install route: a bundle patch that registers the plugin row itself. */
expect("the package ships its own patch layer and publishes the files it needs", [manifest.dsh?.bundle?.patch, manifest.files?.includes("cordis.patch.yml")], ["./cordis.patch.yml", true]);
/* The local flat install route: same identity, entry points re-pointed. */
const flat = installedManifest(manifest);
expect("a flat install re-points the entry points at the files it actually has", [flat.exports["./client"], flat.exports["."], flat.name, flat.dsh?.client?.platform], ["./client.js", "./index.mjs", manifest.name, "web"]);
expect("and the home patch row loads that layout's entry", homePatchRow("/home/u/.dsh/plugins/" + manifest.name, manifest.name), { id: manifest.name, name: `/home/u/.dsh/plugins/${manifest.name}/index.mjs` });
expect("the client half declares the page it extends", manifest.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-ui-settings-models"), true);
const source = readFileSync(CLIENT, "utf8");
let registration;
globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry; } } };
const moduleShim = { exports: {} };
const react = {
	Fragment: Symbol.for("react.fragment"),
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useRef: (initial) => ({ current: initial }),
	useEffect: () => {},
	useCallback: (fn) => fn,
	useMemo: (fn) => fn()
};
await import(`${pathToFileURL(CLIENT).href}?test=${String(Date.now())}`);
/* The name is load-bearing: the client module system rejects a bundle that registers
 * under anything other than its package name, so derive it rather than hardcode it. */
expect("the bundle registers itself under the package's own name", [registration?.id, typeof registration?.factory], [manifest.name, "function"]);
if (typeof registration?.factory === "function") {
	const required = [];
	const exportsOf = registration.factory((specifier) => {
		required.push(specifier);
		if (specifier === "react") return react;
		if (specifier === "react-dom") return { createPortal: (element, container) => ({ type: "portal", container, element }) };
		if (specifier === "react-dom/client") return { createRoot: () => ({ render: () => {}, unmount: () => {} }) };
		if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return {
			Menu: (props) => ({ type: "menu", props }),
			IconChevronDownOutline14: (props) => ({ type: "chevron", props })
		};
		throw new Error(`the client bundle required unexpected module "${specifier}"`);
	});
	expect("the client plugin declares its services", exportsOf.inject, ["slots", "remote", "remote.settings"]);
	/* The picker must be DSH's own dropdown: a platform <select> is what the owner
	 * saw opening the operating system's radio sheet on mobile. */
	expect("the bundle loads DSH's primitives and a React root to draw into", required.includes("@deepseek-ai/dsh-client-ui-primitives") && required.includes("react-dom/client"), true);
	expect("the client plugin has an apply", typeof exportsOf.apply, "function");

	/* Drive the registration the slot API performs, then compare the twins. */
	const client = exportsOf.__test;
	const slotCalls = [];
	const ctx = {
		slots: { inject: (name, callback) => callback(), register: (options, component) => slotCalls.push({ options, component }) },
		remote: { settings: { mutate: () => ({ ok: true }) } }
	};
	exportsOf.apply(ctx);
	expect("it registers into the provider-card seat, keyed by the settings namespace", [slotCalls[0]?.options.name, slotCalls[0]?.options.key], ["settings.models.provider-card", "llm-pi-ai"]);
	expect("the registered cell renders an element", typeof slotCalls[0]?.component, "function");
	/* The seat hands owner props in; the cell must read its route from them and
	 * render nothing but a hint line for a card that has no route id yet. */
	const cell = slotCalls[0]?.component;
	const element = cell({ provider: { provider: "panel-probe", displayName: "probe", settingsNs: "llm-pi-ai" }, configured: true });
	const view = element?.type?.(element.props);
	expect("the card gets nothing visible of its own: two hidden markers, no block", [view?.type, view?.children?.length, view?.children?.map((child) => child === null ? null : child.props?.style?.display)], [Symbol.for("react.fragment"), 3, ["none", "none", null]]);
	const blank = cell({});
	expect("a card with no route id renders nothing", blank?.type?.(blank.props), null);

	expect("twins: managed fields", [client.PANEL_FIELDS, client.EDITABLE_FIELDS], [panel.PANEL_FIELDS, panel.EDITABLE_FIELDS]);
	expect("twins: no capacity parser is exported — this half has no capacity input", client.parseCapacity, undefined);
	expect("twins: capacity spells exactly when it can, and says 约 when it cannot",
		[client.formatCapacity(1000000), client.formatCapacity(200000), client.formatCapacity(131072), client.formatCapacity(262144), client.formatCapacity(32768), client.formatCapacity(123456), client.formatCapacity(undefined)],
		["1M", "200K", "128K", "256K", "32K", "约 123K", ""]);
	expect("twins: level parsing", [client.parseLevels("low, high, max").value, client.parseLevels("false").value, client.parseLevels("off").value, client.parseLevels("nope").error !== undefined], [{ low: "low", high: "high", max: "max" }, false, { off: null }, true]);
	expect("twins: level spelling", client.formatLevels({ off: null, low: "low", high: "HIGH" }), "off, low, high=HIGH");
	expect("twins: every preset the menu offers round-trips through the parser", client.LEVEL_PRESETS.map(([value]) => value === "" || client.parseLevels(value).error === undefined), [true, true, true, true, true, true]);
	expect("twins: the menu label spells a declaration no preset holds", [client.levelLabel(""), client.levelLabel("low, medium, high"), client.levelLabel("medium=medium_custom")], ["跟随自动匹配", "低 / 中 / 高", "自定义：medium=medium_custom"]);
	const twins = client.mergeRow({ id: "x", compat: { a: 1 }, contextWindow: 262144, maxTokens: 32768 }, { levels: "", vision: "follow" });
	expect("twins: merge matches the host's rule", twins, panel.applyChoice({ id: "x", compat: { a: 1 }, contextWindow: 262144, maxTokens: 32768 }, { reasoningEfforts: undefined, input: undefined }));
	expect("twins: the merged row keeps the foreign key and the capacity it did not edit", [twins.compat, twins.contextWindow, twins.maxTokens], [{ a: 1 }, 262144, 32768]);
	expect("twins: a declaration survives the round trip through the control", client.formatLevels(client.mergeRow({ id: "probe/qwen-3.8-max" }, { levels: "off, low, high", vision: "on" }).reasoningEfforts), "off, low, high");
	expect("twins: a declaration the presets do not spell is kept for editing", client.presetOf("medium=medium_custom"), client.CUSTOM);

	/* A payload for a different route must not be mistaken for this card's: a host
	 * older than the request filter answers every route at once. */
	const stalePayload = { routes: [{ route: "my-gateway", models: [{ id: "probe/glm-5.3" }] }, { route: "other-gateway", models: [{ id: "sentinel" }] }] };
	expect("the card picks its own route out of a full payload", client.routeIn(stalePayload, "other-gateway").models[0].id, "sentinel");
	expect("and finds nothing (rather than another route) when it is absent", client.routeIn(stalePayload, "deepseek-official"), undefined);
	expect("an empty payload is not a crash", client.routeIn(undefined, "my-gateway"), undefined);

	/* The fusion contract, held against the primitives the cells actually use: the
	 * chain's verdict is reported, the capacity 容量 cannot show is spelled, and a
	 * row is dirty only once it differs from what settings declares. */
	const matched = { id: "probe/glm-5.3", declared: {}, matched: { route: "zai", contextWindow: 1000000, maxTokens: 131072, reasoning: true, input: ["text", "image"] } };
	const unmatchedRow = { id: "probe/qwen-3.8-max", declared: { reasoningEfforts: { low: "low" }, input: ["text"] }, matched: undefined };
	expect("cells: the chain's verdict is reported incl. the capacity 容量 cannot show", client.readoutOf(matched), "自动匹配：zai · 1M / 输出 128K · 有推理等级 · 视觉");
	expect("cells: a declared row says so, on top of the match", client.readoutOf({ id: "x", declared: { reasoningEfforts: { low: "low" }, input: ["text"] }, matched: matched.matched }), "自动匹配：zai · 1M / 输出 128K · 有推理等级 · 视觉 · 已声明推理等级 low · 已声明视觉 关闭");
	expect("cells: an unmatched row says capacity must be typed into 容量", client.readoutOf(unmatchedRow).startsWith("无匹配"), true);
	expect("cells: capacity provenance is named, so 容量's route default cannot mislead", [client.capacityLine(matched).text, client.capacityLine(unmatchedRow).tone], ["容量：自动匹配 1M / 输出 128K · 来源 zai", "warn"]);
	expect("cells: nothing is dirty until it differs from the declaration", [client.isDirty(matched, { levels: "", vision: "follow" }), client.isDirty(matched, { levels: "low", vision: "follow" }), client.isDirty(unmatchedRow, { levels: "low", vision: "off" })], [false, true, false]);
	expect("cells: a declared row starts on its own declaration, not on the match", [client.initialChoice(unmatchedRow).levels, client.presetOf(client.initialChoice(unmatchedRow).levels), client.initialChoice(unmatchedRow).vision], ["low", client.CUSTOM, "off"]);
	/* The cell as rendered: the whole point of the rework is that nothing here is a
	 * platform control any more. Walk the element tree the React shim produced. */
	const walk = (node, visit) => {
		/* The shim keeps a single array child as one entry, so flatten as we go. */
		if (Array.isArray(node)) {
			for (const child of node) walk(child, visit);
			return;
		}
		if (node === null || node === undefined || typeof node !== "object") return;
		visit(node);
		for (const child of Array.isArray(node.children) ? node.children : []) walk(child, visit);
	};
	const nodes = [];
	const bareRow = { id: "probe/glm-5.3", declared: {}, matched: { route: "zai", contextWindow: 1000000, maxTokens: 131072, reasoning: true, input: ["text", "image"] } };
	walk(client.Cell({ row: bareRow, choice: client.initialChoice(bareRow), classes: { control: "page-input" }, message: undefined, busy: false, onChoice: () => {}, onCommit: () => {} }), (node) => nodes.push(node));
	/* A Menu element is identified by its props: the component is DSH's, not ours. */
	const isMenu = (node) => node.props !== undefined && node.props.items !== undefined && node.props.anchor !== undefined;
	const types = nodes.map((node) => node.type);
	expect("cells: nothing in the cell is a platform control", types.some((type) => type === "select" || type === "option"), false);
	expect("cells: both pickers are DSH's Menu", nodes.filter(isMenu).length, 2);
	const levelMenu = nodes.find((node) => isMenu(node) && node.props.items.some((item) => item.id === client.CUSTOM));
	expect("cells: the level menu carries the presets, a separator and 自定义…", [levelMenu.props.items.length, levelMenu.props.items.at(-1), levelMenu.props.items.at(-2).type], [client.LEVEL_PRESETS.length + 2, { id: client.CUSTOM, label: "自定义…" }, "separator"]);
	expect("cells: the menu marks what is currently chosen", [levelMenu.props.selectedId, levelMenu.props.open], ["", false]);
	expect("cells: the trigger is the page's own input widget", levelMenu.props.anchor.props.className, "page-input");
	expect("cells: the chain's verdict is printed under the pickers", nodes.some((node) => node.type === "p" && String(node.children?.[0] ?? "").startsWith("自动匹配：zai")), true);
	expect("cells: an untouched row offers no write button", nodes.some((node) => node.type === "button" && node.children?.[0] === "写入"), false);
	const dirtyRow = client.Cell({ row: bareRow, choice: { levels: "low", vision: "follow" }, classes: { control: "page-input", action: "page-button" }, message: undefined, busy: false, onChoice: () => {}, onCommit: () => {} });
	const dirtyNodes = [];
	walk(dirtyRow, (node) => dirtyNodes.push(node));
	const write = dirtyNodes.find((node) => node.type === "button" && node.children?.[0] === "写入");
	expect("cells: a changed row offers the write button, styled as the page's own", [write !== undefined, write.props.className, write.props.style], [true, "page-button", undefined]);
	expect("cells: choosing 自定义… reveals the text field instead of a platform input", client.LEVEL_PRESETS.every(([value]) => value !== client.CUSTOM), true);
}

delete globalThis.window;

/*
 * 4: the host route the panel fetches, driven end to end with a synthetic
 * settings document and snapshot so the assertions do not depend on the live one.
 */
const WORK = join(HERE, ".panel");
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
process.env.DSH_PI_AI_SETTINGS_FILE = join(WORK, "settings.yaml");
process.env.DSH_PI_AI_CATALOG_SNAPSHOT = join(WORK, "snapshot.json");
process.env.DSH_PI_AI_CATALOG_REFRESH = "0";
writeFileSync(process.env.DSH_PI_AI_SETTINGS_FILE, [
	"llm-pi-ai:",
	"  providers:",
	"    panel-probe:",
	"      api: openai-responses",
	"      baseURL: http://127.0.0.1:1/v1",
	"      models:",
	"        - id: probe/glm-5.3",
	"          name: probe/glm-5.3",
	"        - id: probe/app-auto",
	"          name: probe/app-auto",
	""
].join("\n"));
writeFileSync(process.env.DSH_PI_AI_CATALOG_SNAPSHOT, JSON.stringify({ fetchedAt: new Date().toISOString(), source: "test", providers: 0, count: 0, models: {} }));

const pluginUrl = pathToFileURL(PLUGIN).href;
const host = await import(pluginUrl);
const routes = [];
const noop = () => {};
const hostCtx = {
	get: () => undefined,
	inject: (names, callback) => {
		if (Array.isArray(names) && names.includes("webServer")) callback({ webServer: { register: (route) => { routes.push(route); return noop; } }, effect: (fn) => fn() });
	},
	logger: { debug: noop, info: noop, warn: noop, error: noop },
	llm: { registerConfigurableProviders: () => ({ replace: noop }), registerModelDiscovery: noop, registerAdapter: () => ({ replace: noop }) }
};
host.apply(hostCtx);
expect("the host registered exactly one panel route", routes.map((route) => `${route.kind} ${route.path}`), ["exact /model-metadata/matrix"]);
if (routes.length === 1) {
	const answer = { end: (body) => { answer.body = body; }, writeHead: (status, headers) => { answer.status = status; answer.headers = headers; } };
	routes[0].handler({ method: "GET" }, answer);
	expect("the route answers 200 JSON", [answer.status, answer.headers?.["content-type"]], [200, "application/json; charset=utf-8"]);
	const payload = JSON.parse(answer.body);
	expect("the payload lists the configured route", payload.routes.map((route) => route.route), ["panel-probe"]);
	expect("the payload lists its models", payload.routes[0].models.map((row) => row.id), ["probe/glm-5.3", "probe/app-auto"]);
	expect("a matched model reports its verdict", payload.routes[0].models[0].matched.route, "zai");
	expect("an unmatched model reports nothing to report", payload.routes[0].models[1].matched, undefined);
	/* A card asks for its own route only. */
	const one = { end: (body) => { one.body = body; }, writeHead: (status, headers) => { one.status = status; one.headers = headers; } };
	routes[0].handler({ method: "GET", url: "/model-metadata/matrix?provider=panel-probe" }, one);
	expect("a per-route request returns just that route", JSON.parse(one.body).routes.map((route) => route.route), ["panel-probe"]);
	const none = { end: (body) => { none.body = body; }, writeHead: () => {} };
	routes[0].handler({ method: "GET", url: "/model-metadata/matrix?provider=absent" }, none);
	expect("an unknown route returns an empty list, not the other routes' data", JSON.parse(none.body).routes, []);
	const refused = { end: () => { refused.ended = true; }, writeHead: (status) => { refused.status = status; } };
	routes[0].handler({ method: "POST" }, refused);
	expect("the route refuses anything but GET/HEAD", refused.status, 405);
}
rmSync(WORK, { recursive: true, force: true });

console.log(`${String(checks - failures.length)}/${String(checks)} panel assertions passed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`FAIL ${failure}`);
	process.exit(1);
}
