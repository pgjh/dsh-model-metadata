/**
 * dsh-model-metadata — match a model to the metadata it should have, by name.
 *
 * WHY: a hand-declared gateway route (`my-gateway` + `vendor/model-name`) exists in no
 * installed catalog, so the pi-ai adapter resolves it with the route defaults:
 * 262144 context tokens and no reasoning levels. The Models page cannot fix this
 * (it deliberately exposes no reasoning control), and the API has no "consult
 * the catalog by name" fallback. This plugin adds one without editing any
 * vendor file, by wrapping the exported `PiAiAdapter` class at its resolution
 * seam.
 *
 * HOW: `PiAiAdapter.current()` hands back `{ profiles, models }`, whose `models`
 * collection is the single source every consumer reads — `modelOf()` (streaming
 * and request caps), `listModels()`, and `modelInfo()` (which the composer, the
 * token meter and `dsh-compaction-basic` all go through). Wrapping `getModel` /
 * `getModels` on a Proxy therefore fixes the whole surface at once, including the
 * adapter's own context-overflow detection. `modelInfo` is wrapped a second time
 * as a belt-and-braces path in case a future version stops routing through
 * `current()`. This is an undocumented seam: if a DSH upgrade changes the shape,
 * the wrapper degrades to a no-op and logs one line instead of breaking.
 *
 * WHAT IT FILLS IN: context window, output cap, reasoning capability and input
 * modalities. `api`, `baseURL`, `compat` and `cost` are left alone — the entry it
 * matched describes a different endpoint and would send the wrong request shape.
 * Anything explicitly declared for that model in settings.yaml wins over the
 * matched value.
 *
 * WHERE FROM, first match wins:
 *   1. the model family's own official route (glm -> zai, kimi -> moonshotai, …;
 *      the deepseek family also consults the official deepseek-official route's
 *      own catalog — @deepseek-ai/dsh-llm-deepseek, display names included —
 *      and that catalog outranks every other source even off-family)
 *   2. the rest of the installed pi-ai catalog, in catalog order
 *   3. opencode / opencode-go (aggregators mirror other people's catalogs, so
 *      they only fill a gap the catalog leaves)
 *   4. $DSH_HOME/models-dev-snapshot.json (lib/refresh-snapshot.mjs refreshes it)
 *
 * HOW A NAME MATCHES, best match wins:
 *   - exact bare id, then the same id lowercased (as before);
 *   - otherwise ids and DISPLAY names are compared separator-insensitively —
 *     `deepseek-v41-flash`, `deepseek-v4.1-flash` and "DeepSeek V41 Flash" all
 *     read as the same name, which is what a gateway alias usually is;
 *   - a candidate may carry one trailing -exp / -latest / -preview / -free
 *     suffix the configured name lacks (`DeepSeek-V4-Flash-Vision` matches
 *     `deepseek-v4-flash-vision-exp`).
 *
 * SWITCHES (read once at load):
 *   DSH_PI_AI_CATALOG_FALLBACK=off      disable the whole fallback
 *   DSH_PI_AI_CATALOG_FALLBACK=context  fill in capacities only, never reasoning
 *   DSH_PI_AI_CATALOG_FALLBACK=full     (default) capacities + reasoning levels
 *   DSH_PI_AI_CATALOG_FALLBACK_INPUT=on (default) the chain also decides images
 *   DSH_PI_AI_CATALOG_FALLBACK_INPUT=bundled   only the shipped catalog may add images
 *   DSH_PI_AI_CATALOG_FALLBACK_INPUT=off       never touch input modalities
 *   DSH_PI_AI_CATALOG_SNAPSHOT=<path>   models.dev snapshot to read and write
 *                                       (default: $DSH_HOME/models-dev-snapshot.json)
 *   DSH_PI_AI_CATALOG_REFRESH=<hours>   the daily threshold (default 24).
 *                                       0 = no automatic fetch at all (master)
 *   DSH_PI_AI_CATALOG_REFRESH_ON_START=always|stale|off
 *                                       a launch refreshes (default always)
 *   ..._REFRESH_START_FLOOR_MINUTES=<minutes>  do not re-fetch at launch when the
 *                                       local copy is younger (default 15)
 *   ..._REFRESH_OPEN_HOURS=<hours>      opening the app (the page asking for panel
 *                                       data) refreshes a copy older than this
 *                                       (default 6; 0 disables)
 *   DSH_PI_AI_CATALOG_SNAPSHOT_URL=<url>  where to fetch the raw database from
 *   DSH_CATALOG_FALLBACK_NODE_MODULES=<dir>  extra node_modules root to resolve from
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SNAPSHOT_URL, fetchModelsDevSnapshot } from "./snapshot.mjs";
import { buildMatrix, SETTINGS_NAMESPACE } from "./panel.mjs";

export const name = "dsh-model-metadata";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENRICHED = Symbol("dsh-model-metadata/enriched");
const MODE = (process.env.DSH_PI_AI_CATALOG_FALLBACK ?? "full").trim().toLowerCase();
const ENABLED = MODE !== "off";
const MATCH_REASONING = MODE !== "context";
/*
 * Input modalities follow the same chain by default: whichever entry wins for
 * this model name also decides whether it takes images. The seam's own default
 * is text-only because over-claiming admits an image the endpoint then rejects
 * mid-turn, after the message is durable — so `off` and `bundled` stay available
 * as narrower settings, and one model can always be pinned back with an explicit
 * `input:` in settings.yaml.
 */
const INPUT_MODE = (process.env.DSH_PI_AI_CATALOG_FALLBACK_INPUT ?? "on").trim().toLowerCase();
const MATCH_INPUT = INPUT_MODE !== "off";
/** `bundled` takes image support only from catalogs that ship with the product, never from models.dev. */
const INPUT_BUNDLED_ONLY = INPUT_MODE === "bundled";
const MODALITIES = ["text", "image"];
/**
 * How stale the models.dev snapshot may get before a background refresh is
 * scheduled. The daily default is what keeps a newly released model from sitting
 * uncovered until someone notices; `0` turns the automatic path off and leaves
 * the manual `refresh-snapshot.mjs` as the only way to update.
 */
const REFRESH_HOURS = nonNegative(process.env.DSH_PI_AI_CATALOG_REFRESH, 24);
const REFRESH_URL = process.env.DSH_PI_AI_CATALOG_SNAPSHOT_URL ?? SNAPSHOT_URL;
/*
 * A launch refreshes too, not just a day-old file: "open DSH and the data is
 * current" is the point, and waiting up to 24h for it is not. The floor is what
 * keeps a restart loop (or a supervisor flapping) from hammering models.dev — a
 * file younger than it is close enough to fresh that re-fetching buys nothing.
 */
const START_MODE = (process.env.DSH_PI_AI_CATALOG_REFRESH_ON_START ?? "always").trim().toLowerCase();
const START_FLOOR_MINUTES = nonNegative(process.env.DSH_PI_AI_CATALOG_REFRESH_START_FLOOR_MINUTES, 15);
/*
 * Opening the app — the page asking this plugin for its data — refreshes a
 * snapshot older than this, which is what keeps a service that has been up for
 * weeks current. Deliberately bounded and deduplicated: the panel route carries no
 * token (DSH offers no request-auth hook for plugin routes), so an anonymous
 * caller must not be able to force a fetch per request.
 */
const OPEN_HOURS = nonNegative(process.env.DSH_PI_AI_CATALOG_REFRESH_OPEN_HOURS, 6);

/** First-party route per model family, in preference order. */
const UPSTREAM = [
	[/^glm/i, ["zai", "zai-coding-cn"]],
	[/^kimi|^moonshot/i, ["moonshotai", "moonshotai-cn"]],
	[/^deepseek/i, ["deepseek-official", "deepseek"]],
	[/^gpt|^chatgpt|^o[1-9]|^codex/i, ["openai", "openai-codex"]],
	[/^claude/i, ["anthropic"]],
	[/^gemini/i, ["google", "google-vertex"]],
	[/^minimax/i, ["minimax", "minimax-cn"]],
	[/^mimo/i, ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"]],
	[/^qwen|^qwq/i, ["qwen-token-plan-cn", "qwen-token-plan", "qwen-token-plan-individual"]],
	[/^grok/i, ["xai"]],
	[/^mistral|^magistral|^devstral|^codestral/i, ["mistral"]],
	[/^hy[0-9]|^hunyuan/i, ["opencode-go"]]
];
const AGGREGATORS = ["opencode", "opencode-go"];

/** DSH home: the settings document and the optional models.dev snapshot live here. */
function dshHome() {
	const configured = process.env.DSH_HOME;
	return configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".dsh");
}

/**
 * node_modules roots to resolve the vendor packages from. The running install is
 * derived from `process.argv[1]` (`<install>/lib/bin.js`) so the plugin does not
 * depend on being installed inside a tree that has its own node_modules.
 */
function nodeModuleRoots() {
	const roots = [];
	const add = (dir) => {
		if (typeof dir !== "string" || dir.length === 0) return;
		if (!roots.includes(dir)) roots.push(dir);
	};
	add(process.env.DSH_CATALOG_FALLBACK_NODE_MODULES);
	const argv1 = process.argv[1];
	if (typeof argv1 === "string" && argv1.length > 0 && !argv1.startsWith("node:")) add(join(dirname(dirname(argv1)), "node_modules"));
	add(join(HERE, "..", "node_modules"));
	add(join(dshHome(), "plugins", "node_modules"));
	add(join(dshHome(), "profiles", "node_modules"));
	const nvm = join(homedir(), ".nvm", "versions", "node");
	if (existsSync(nvm)) {
		for (const version of readdirSync(nvm)) add(join(nvm, version, "lib", "node_modules", "@deepseek-ai", "dsh", "node_modules"));
	}
	return roots;
}

/** Import one package file by absolute path from the first root holding it. */
async function loadFromRoots(relative, bare) {
	for (const root of nodeModuleRoots()) {
		const file = join(root, relative);
		if (!existsSync(file)) continue;
		try {
			return { exports: await import(pathToFileURL(file).href), from: file };
		} catch (error) {
			return { failure: `${file}: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
	try {
		return { exports: await import(bare), from: bare };
	} catch (error) {
		return { failure: `${bare}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

const adapterLoad = ENABLED ? await loadFromRoots("@deepseek-ai/dsh-llm-pi-ai/lib/index.js", "@deepseek-ai/dsh-llm-pi-ai") : {};
const catalogLoad = ENABLED ? await loadFromRoots("@earendil-works/pi-ai/dist/providers/all.js", "@earendil-works/pi-ai/providers/all") : {};
const yamlLoad = ENABLED ? await loadFromRoots("js-yaml/index.js", "js-yaml") : {};
/*
 * The official DeepSeek route's own adapter: optional on purpose. A deployment
 * without it (or a build that renames the export) simply loses one candidate
 * source — the pi-ai catalog and the models.dev snapshot still answer, and no
 * warning is worth frightening a user whose install never had the package.
 */
const deepseekLoad = ENABLED ? await loadFromRoots("@deepseek-ai/dsh-llm-deepseek/lib/index.js", "@deepseek-ai/dsh-llm-deepseek") : {};

/** A configured non-negative number, or the fallback when it is absent or garbage. */
function nonNegative(text, fallback) {
	const value = Number.parseFloat(text ?? "");
	return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Bare name of a model id: everything after the last `/`. */
function bareName(id) {
	const at = id.lastIndexOf("/");
	return at === -1 ? id : id.slice(at + 1);
}

/*
 * The relaxed spelling a name is compared under once the exact forms miss:
 * lowercase, then every run of non-alphanumerics folded away. `v4.1-flash`,
 * `v41-flash` and "V41 Flash" all collapse to `v41flash`, which is the spelling
 * difference a gateway alias almost always is (DeepSeek's own official route
 * writes the V41 flash `deepseek-flash` but DISPLAYS "DeepSeek-V41-Flash";
 * models.dev writes it `deepseek-v4.1-flash`).
 */
/** Separator-free lowercase form of a model id or display name. */
function normalizeName(text) {
	return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Trailing decorations a configured name may lack while still naming the same
 * model: `DeepSeek-V4-Flash-Vision` is the catalog's `deepseek-v4-flash-vision-exp`.
 * Compared normalized (no separators), so `-exp` and `-experimental` differ.
 */
const NAME_SUFFIXES = ["exp", "experimental", "latest", "preview", "free"];

/** A normalized key short enough to be coincidence rather than a name. */
const MIN_NORMALIZED_LENGTH = 4;

/** Preferred route names for one bare name: its family upstream(s) only. */
function preferredRoutes(bare) {
	const order = [];
	for (const member of UPSTREAM) if (member[0].test(bare)) order.push(...member[1]);
	return order;
}

/** Where the models.dev snapshot lives: an override, else the DSH home. */
/**
 * Where this plugin keeps its models.dev data.
 *
 * In DSH home, on purpose: updating the plugin replaces its whole directory, and data
 * that lives there would be thrown away with it — this way an update never costs a
 * re-download. All profiles share the one file, which is also what you want: the
 * catalog is the same everywhere.
 * @returns the snapshot file path.
 */
function snapshotPath() {
	const configured = process.env.DSH_PI_AI_CATALOG_SNAPSHOT;
	return configured !== undefined && configured.length > 0 ? configured : join(dshHome(), "models-dev-snapshot.json");
}

/**
 * The models.dev snapshot as candidates, re-read whenever the file changes.
 *
 * The change key is mtime *and* size: some filesystems only carry second-level
 * timestamps, and a rewrite that lands inside the same second would otherwise
 * leave the index stale until the next restart.
 * @returns the path, the file's change key (absent file: 0 bytes, stamp 0), and entries.
 */
let snapshotCache;
function snapshotState() {
	const path = snapshotPath();
	let stats;
	try {
		stats = statSync(path);
	} catch {
		return { path, stamp: 0, size: 0, entries: [] };
	}
	const stamp = stats.mtimeMs;
	const size = stats.size;
	if (snapshotCache !== undefined && snapshotCache.path === path && snapshotCache.stamp === stamp && snapshotCache.size === size) return snapshotCache;
	const entries = [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		for (const [id, entry] of Object.entries(parsed?.models ?? {})) {
			if (entry === null || typeof entry !== "object") continue;
			entries.push({
				bare: bareName(id),
				route: `models.dev:${String(entry.provider ?? "unknown")}`,
				name: entry.name,
				contextWindow: entry.contextWindow,
				maxTokens: entry.maxTokens,
				input: Array.isArray(entry.input) ? entry.input.filter((modality) => MODALITIES.includes(modality)) : undefined,
				reasoning: entry.reasoning === true,
				source: "models.dev"
			});
		}
	} catch {
		/* A corrupt snapshot must never break model resolution. */
	}
	snapshotCache = { path, stamp, size, entries };
	return snapshotCache;
}

/**
 * The by-name index over the installed catalog, the official DeepSeek route and
 * the snapshot.
 *
 * Memoized by the snapshot's and the settings document's change keys, not
 * forever: `refresh-snapshot.mjs` (or the background refresh below) rewrites the
 * snapshot file, and the `llm-deepseek` settings section can reshape the
 * official route's catalog — the very next model resolution must see the new
 * data without a restart. The installed catalogs cannot change while the
 * process lives, so they are not part of the key.
 * @returns the lookup used by every resolution.
 */
let indexCache;
function fallbackIndex() {
	const snapshot = snapshotState();
	const settings = settingsState();
	const revision = `${String(snapshot.stamp)}:${String(snapshot.size)}:${String(settings.stamp)}:${String(settings.size)}`;
	if (indexCache !== undefined && indexCache.revision === revision) return indexCache.index;
	const byName = new Map();
	const byLower = new Map();
	const byNorm = new Map();
	const routeOrder = typeof catalogLoad.exports?.getBuiltinProviders === "function" ? catalogLoad.exports.getBuiltinProviders() : [];
	const exact = new Map();
	let sequence = 0;
	const add = (candidate) => {
		candidate.sequence = sequence++;
		for (const [map, key] of [[byName, candidate.bare], [byLower, candidate.bare.toLowerCase()]]) {
			const list = map.get(key);
			if (list === undefined) map.set(key, [candidate]);
			else list.push(candidate);
		}
		/*
		 * The relaxed tier: the candidate's id AND its display name, normalized.
		 * A display name is how a vendor's own list spells a model for humans
		 * ("DeepSeek-V41-Flash"), which is exactly the spelling a hand-declared
		 * gateway row borrows — and the pi-ai catalog and models.dev entries
		 * carry their own display names, so they join the same tier.
		 */
		const keys = new Set([normalizeName(candidate.bare), normalizeName(candidate.name)]);
		for (const key of keys) {
			if (key.length < MIN_NORMALIZED_LENGTH) continue;
			const list = byNorm.get(key);
			if (list === undefined) byNorm.set(key, [candidate]);
			else if (!list.includes(candidate)) list.push(candidate);
		}
	};
	for (const route of routeOrder) {
		let models = [];
		try {
			models = catalogLoad.exports.getBuiltinModels(route) ?? [];
		} catch {
			continue;
		}
		for (const model of models) {
			if (typeof model.id !== "string" || model.id.length === 0) continue;
			exact.set(`${route}\u0000${model.id}`, model);
			add({
				bare: bareName(model.id),
				route,
				name: model.name,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				input: Array.isArray(model.input) ? model.input.filter((modality) => MODALITIES.includes(modality)) : undefined,
				reasoning: model.reasoning === true,
				thinkingLevelMap: model.thinkingLevelMap,
				source: "pi-ai-catalog"
			});
		}
	}
	const firstParty = firstPartyCandidates();
	for (const candidate of firstParty) add(candidate);
	for (const entry of snapshot.entries) add(entry);
	indexCache = { revision, index: { byName, byLower, byNorm, routeOrder, exact, firstPartyCount: firstParty.length } };
	return indexCache.index;
}

/**
 * The official `deepseek-official` route's own catalog, as fallback candidates.
 *
 * That route (the "DeepSeek" entry in the model switcher) keeps its model list
 * in `@deepseek-ai/dsh-llm-deepseek`, not in the pi-ai catalog — so without this
 * source a gateway alias of its names matches nothing. The list is resolved the
 * way the route itself resolves it (`resolveAdapterOptions`), so a catalog the
 * user reshaped in the `llm-deepseek` settings section is what gets matched, and
 * the vendor's defaults otherwise. Reasoning rides the route's own rule: every
 * model offers Off/Low/High/Max unless thinking is configured off.
 * @returns candidates for the index, empty when the package or its export is absent.
 */
function firstPartyCandidates() {
	const resolve = deepseekLoad.exports?.resolveAdapterOptions;
	if (typeof resolve !== "function") return [];
	let options;
	try {
		const section = settingsDocument()?.["llm-deepseek"];
		options = resolve(section === null || typeof section !== "object" ? {} : section);
	} catch {
		/* A malformed llm-deepseek section must not take the whole chain down. */
		try {
			options = resolve({});
		} catch {
			return [];
		}
	}
	if (options === null || typeof options !== "object" || !Array.isArray(options.models)) return [];
	const reasoning = options.defaults?.thinking !== "disabled";
	/* The route's own Off/Low/High/Max, in the pi-ai level vocabulary. */
	const thinkingLevelMap = { minimal: null, low: "low", medium: null, high: "high", max: "max" };
	return options.models
		.filter((model) => model !== null && typeof model === "object" && typeof model.id === "string" && model.id.length > 0)
		.map((model) => ({
			bare: model.id,
			route: "deepseek-official",
			name: model.name,
			contextWindow: model.contextWindow ?? options.defaultContextWindow,
			maxTokens: model.maxTokens ?? options.maxTokens,
			input: Array.isArray(model.inputModalities) ? model.inputModalities.filter((modality) => MODALITIES.includes(modality)) : undefined,
			reasoning,
			...reasoning ? { thinkingLevelMap: { ...thinkingLevelMap } } : {},
			source: "first-party"
		}));
}

/** The snapshot file's age in hours, or Infinity when it does not exist. */
export function snapshotAgeHours(now = Date.now()) {
	const stamp = snapshotState().stamp;
	return stamp === 0 ? Number.POSITIVE_INFINITY : (now - stamp) / 3600000;
}

/** Whether the daily threshold is met (also the `onStart=stale` rule). */
export function refreshDue(now = Date.now()) {
	return REFRESH_HOURS > 0 && snapshotAgeHours(now) >= REFRESH_HOURS;
}

/**
 * Whether a launch should fetch.
 *
 * `always` (the default) is "yes, whatever the file says", minus the restart
 * floor; `stale` keeps the daily rule; `off` leaves refreshing to the app-open
 * trigger and the CLI. `DSH_PI_AI_CATALOG_REFRESH=0` is the master switch and
 * overrides both of the others — 0 means "do not fetch on your own".
 * @param now - the clock to judge against.
 * @returns whether to start a fetch.
 */
export function startDue(now = Date.now()) {
	if (REFRESH_HOURS === 0 || START_MODE === "off") return false;
	const age = snapshotAgeHours(now);
	if (!Number.isFinite(age)) return true;
	if (START_MODE === "stale") return refreshDue(now);
	return START_FLOOR_MINUTES <= 0 || age * 60 >= START_FLOOR_MINUTES;
}

/**
 * Whether opening the app should fetch — the panel route being asked for its data.
 * @param now - the clock to judge against.
 * @returns whether to start a fetch.
 */
export function openDue(now = Date.now()) {
	if (REFRESH_HOURS === 0 || OPEN_HOURS <= 0) return false;
	const age = snapshotAgeHours(now);
	return !Number.isFinite(age) || age >= OPEN_HOURS;
}

/** How many hours of staleness the automatic refresh tolerates (0 = disabled). */
export const AUTO_REFRESH_HOURS = REFRESH_HOURS;

/** The whole policy in one place, so the log line and the tests read the same facts. */
export const REFRESH_POLICY = {
	hours: REFRESH_HOURS,
	onStart: START_MODE,
	startFloorMinutes: START_FLOOR_MINUTES,
	openHours: OPEN_HOURS
};

/**
 * Fetch the database and replace the snapshot file atomically.
 *
 * Written to a sibling temporary file and renamed, so a resolution reading this
 * file concurrently sees either the old document or the new one — never a
 * half-written one.
 * @param logger - optional sink for the one-line outcome.
 * @returns the written document, or undefined when the fetch failed.
 */
async function refreshSnapshotNow(logger) {
	const path = snapshotPath();
	try {
		const snapshot = await fetchModelsDevSnapshot(REFRESH_URL);
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.tmp-${String(process.pid)}`;
		writeFileSync(temporary, JSON.stringify(snapshot));
		renameSync(temporary, path);
		logger?.info?.(`dsh-model-metadata: refreshed the models.dev snapshot (${String(snapshot.count)} models, ${String(Object.values(snapshot.models).filter((model) => model.reasoning).length)} reasoning-capable) -> ${path}`);
		return snapshot;
	} catch (error) {
		logger?.warn?.(`dsh-model-metadata: could not refresh the models.dev snapshot (${error instanceof Error ? error.message : String(error)}); keeping the existing data`);
		return undefined;
	}
}

/** The fetch in flight, so several triggers in the same second produce one request. */
let refreshing;

/** `12.4h ago` / `never fetched` for the log line. */
function describeAge(hours) {
	return Number.isFinite(hours) ? `${hours.toFixed(1)}h old` : "absent";
}

/**
 * Start a refresh when one is due for the given reason; never blocks.
 *
 * Deduplicated by the in-flight promise: a launch and an app-open can land in the
 * same second, and models.dev should see one request for that.
 * @param logger - optional sink for the one-line outcome.
 * @param reason - `start`, `open` or `manual` — decides which rule applies.
 * @param now - the clock to judge against.
 * @returns whether this call started the fetch.
 */
export function refreshIfDue(logger, reason = "start", now = Date.now()) {
	if (typeof fetch !== "function") return false;
	if (refreshing !== undefined) return false;
	const due = reason === "open" ? openDue(now) : reason === "start" ? startDue(now) : refreshDue(now);
	if (!due) return false;
	logger?.info?.(`dsh-model-metadata: refreshing the models.dev snapshot on ${reason} (the local copy is ${describeAge(snapshotAgeHours(now))})`);
	refreshing = refreshSnapshotNow(logger).finally(() => {
		refreshing = undefined;
	});
	return true;
}

/** Schedule the launch refresh; never blocks. */
function scheduleRefresh(logger) {
	refreshIfDue(logger, "start");
}

/** Where the settings panel reads its matrix from. */
export const PANEL_PATH = "/model-metadata/matrix";

/**
 * Serve the settings panel's data.
 *
 * Read-only, and deliberately narrow: the stored model ids of the configured
 * routes plus the catalog verdict for each — the same facts the Models page
 * shows, no credentials and no base URLs. It is registered through a scoped
 * `webServer` injection, so a deployment without a web server (a headless or ACP
 * profile) still gets the metadata fallback itself; only the panel is absent.
 *
 * DSH has no request-authorization hook for plugin routes, so this endpoint is
 * not behind the app's own token gate, the same as the `/plugins/*` static
 * assets. Keep it to non-secret data (as here) or drop the panel route entirely.
 * @param ctx - the plugin context.
 * @param logger - optional sink for the one-line outcome.
 */
function registerPanel(ctx, logger) {
	if (typeof ctx?.inject !== "function") return;
	ctx.inject(["webServer"], (scoped) => {
		const webServer = scoped.webServer;
		if (webServer === undefined || typeof webServer.register !== "function") return;
		scoped.effect(() => webServer.register({
			kind: "exact",
			path: PANEL_PATH,
			handler: (req, res) => {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405);
					res.end();
					return;
				}
				let body;
				try {
					/* A card asks for its own route, so one page never ships 124 models to
					 * every card. An unknown or absent route answers the whole matrix. */
					const wanted = new URL(req.url ?? "/", "http://localhost").searchParams.get("provider");
					const matrix = buildMatrix(settingsProviders(), inspect);
					if (wanted !== null) matrix.routes = matrix.routes.filter((route) => route.route === wanted);
					body = JSON.stringify(matrix);
					/*
					 * Being asked for the data means the app is open — the cheapest
					 * "somebody is looking at this now" signal a plugin route gets. It only
					 * fires when the local copy is past OPEN_HOURS, and the in-flight guard
					 * collapses a page's several cards into one fetch.
					 */
					refreshIfDue(logger, "open");
				} catch (error) {
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
					return;
				}
				res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(req.method === "HEAD" ? undefined : body);
			}
		}), `dsh-model-metadata: ${PANEL_PATH}`);
		logger?.info?.(`dsh-model-metadata: settings panel data served at ${PANEL_PATH} (namespace ${SETTINGS_NAMESPACE})`);
	});
}

/**
 * Rank one candidate for a bare name: smaller wins.
 *
 * The order is deliberate: the model's own official route first (family
 * upstreams, and the official deepseek-official catalog even off-family), then
 * the rest of the installed pi-ai catalog, then the opencode aggregators, then
 * models.dev. An aggregator mirrors other people's catalogs, so it must never
 * outrank the vendor's own entry — only fill a gap the catalog leaves.
 */
function rank(index, bare, candidate) {
	const preferred = preferredRoutes(bare).indexOf(candidate.route);
	if (preferred !== -1) return preferred;
	if (candidate.source === "first-party") return 500;
	if (candidate.source === "models.dev") return 3000 + candidate.sequence;
	if (AGGREGATORS.includes(candidate.route)) return 2000 + Math.max(0, index.routeOrder.indexOf(candidate.route));
	const at = index.routeOrder.indexOf(candidate.route);
	return 1000 + (at === -1 ? 900 : at);
}

/**
 * Every candidate that can be read as this bare name, unranked.
 *
 * Exact spellings first (case-sensitive, then lowercased); then the normalized
 * tier over ids and display names, including one trailing decoration suffix the
 * configured name lacks. All the hits are merged into one list — ranking, not
 * which tier happened to hit, decides who wins.
 * @param index - the fallback index.
 * @param bare - the bare name of the model being resolved.
 * @returns the candidates, possibly empty.
 */
function candidatesFor(index, bare) {
	const found = [...(index.byName.get(bare) ?? []), ...(index.byLower.get(bare.toLowerCase()) ?? [])];
	const norm = normalizeName(bare);
	if (norm.length >= MIN_NORMALIZED_LENGTH) {
		for (const key of [norm, ...NAME_SUFFIXES.map((suffix) => norm + suffix)]) {
			for (const candidate of index.byNorm.get(key) ?? []) {
				if (!found.includes(candidate)) found.push(candidate);
			}
		}
	}
	return found;
}

/** The entry that names one model id, or undefined when nothing shares its name. */
function matchFor(id) {
	const index = fallbackIndex();
	const bare = bareName(id);
	const candidates = candidatesFor(index, bare);
	if (candidates.length === 0) return undefined;
	return [...candidates].sort((left, right) => rank(index, bare, left) - rank(index, bare, right))[0];
}

/** The settings document that decides which fields were declared explicitly. */
function settingsPath() {
	const configured = process.env.DSH_PI_AI_SETTINGS_FILE;
	return configured !== undefined && configured.length > 0 ? configured : join(dshHome(), "settings.yaml");
}

/**
 * The parsed settings document and its change key, re-read whenever the file
 * changes (mtime *and* size, for filesystems with coarse timestamps). The
 * document is undefined when it is missing, unreadable, or has no YAML parser
 * available — never a failure; the change key still tracks the file so the
 * fallback index notices a settings edit without a restart.
 * @returns the path, change key, and the parsed document.
 */
let settingsCache;
function settingsState() {
	const yaml = yamlLoad.exports;
	const path = settingsPath();
	if (yaml === undefined || typeof yaml.load !== "function") return { path, stamp: 0, size: 0, document: undefined };
	let stats;
	try {
		stats = statSync(path);
	} catch {
		return { path, stamp: 0, size: 0, document: undefined };
	}
	if (settingsCache === undefined || settingsCache.path !== path || settingsCache.stamp !== stats.mtimeMs || settingsCache.size !== stats.size) {
		let document;
		try {
			document = yaml.load(readFileSync(path, "utf8"));
		} catch {
			document = undefined;
		}
		settingsCache = { path, stamp: stats.mtimeMs, size: stats.size, document };
	}
	return settingsCache;
}

/** The parsed settings document, or undefined when it is unavailable. */
function settingsDocument() {
	return settingsState().document;
}

/** The configured pi-ai routes, as stored — what the settings panel lists. */
function settingsProviders() {
	return settingsDocument()?.["llm-pi-ai"]?.providers ?? {};
}

/** The settings entry declaring one model, or an empty object. */
function declaredFields(provider, id) {
	const entries = settingsProviders()[provider]?.models;
	if (!Array.isArray(entries)) return {};
	const entry = entries.find((item) => item !== null && typeof item === "object" && item.id === id);
	return entry ?? {};
}

/** Whether the installed catalog already describes this exact route/model pair. */
function isCatalogued(provider, id) {
	return fallbackIndex().exact.has(`${provider}\u0000${id}`);
}

/**
 * One model descriptor with the matched metadata merged under the route's own fields.
 * @param model - the resolved pi-ai model descriptor.
 * @param provider - the route it belongs to.
 * @returns the same object when nothing matches, else a filled-in copy.
 */
function enrichModel(model, provider) {
	if (!ENABLED || model === null || typeof model !== "object") return model;
	const id = model.id;
	if (typeof id !== "string" || id.length === 0 || model[ENRICHED] === true) return model;
	if (isCatalogued(provider, id)) return model;
	const matched = matchFor(id);
	if (matched === undefined) return model;
	const declared = declaredFields(provider, id);
	const next = { ...model, [ENRICHED]: true };
	let changed = false;
	if (declared.contextWindow === undefined && Number.isInteger(matched.contextWindow) && matched.contextWindow > 0 && matched.contextWindow !== model.contextWindow) {
		next.contextWindow = matched.contextWindow;
		changed = true;
	}
	if (declared.maxTokens === undefined && Number.isInteger(matched.maxTokens) && matched.maxTokens > 0 && matched.maxTokens !== model.maxTokens) {
		next.maxTokens = matched.maxTokens;
		changed = true;
	}
	if (MATCH_REASONING && declared.reasoningEfforts === undefined && matched.reasoning === true && model.reasoning !== true) {
		next.reasoning = true;
		if (matched.thinkingLevelMap !== undefined && matched.thinkingLevelMap !== null) next.thinkingLevelMap = { ...matched.thinkingLevelMap };
		changed = true;
	}
	/*
	 * `bundled` takes image support only from catalogs that ship with the
	 * product: the pi-ai catalog and the official DeepSeek route's own list.
	 */
	if (MATCH_INPUT && (!INPUT_BUNDLED_ONLY || matched.source === "pi-ai-catalog" || matched.source === "first-party") && declared.input === undefined && Array.isArray(matched.input) && matched.input.length > 0) {
		const current = Array.isArray(model.input) ? model.input : [];
		if (matched.input.length !== current.length || matched.input.some((modality) => !current.includes(modality))) {
			next.input = [...matched.input];
			changed = true;
		}
	}
	return changed ? next : model;
}

/**
 * Diagnostic view of what the fallback sees for one configured model: every
 * candidate that shares its bare name and which one wins. Exported so the
 * report tooling reads the same ranking the resolution uses.
 * @param id - a configured model id, prefix included.
 * @returns the bare name, the ranked candidates, and the chosen one.
 */
export function inspect(id) {
	const index = fallbackIndex();
	const bare = bareName(id);
	const candidates = candidatesFor(index, bare);
	const ranked = [...candidates].sort((left, right) => rank(index, bare, left) - rank(index, bare, right));
	const view = (candidate) => ({
		route: candidate.route,
		source: candidate.source,
		contextWindow: candidate.contextWindow,
		maxTokens: candidate.maxTokens,
		input: candidate.input,
		reasoning: candidate.reasoning === true
	});
	return {
		id,
		bare,
		cataloguedUnder: index.routeOrder.filter((route) => index.exact.has(`${route}\u0000${id}`)),
		candidates: ranked.map(view),
		chosen: ranked.length === 0 ? undefined : view(ranked[0])
	};
}

/** Every level pi-ai knows, in escalation order (mirrors its own list). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The levels one model offers, by pi-ai's own rule: a level mapped to `null` is
 * unsupported, the two extended levels need an explicit mapping, everything else
 * is supported unless pinned off.
 * @param model - an enriched pi-ai model descriptor.
 * @returns the offered level ids, in escalation order.
 */
function supportedLevels(model) {
	if (model.reasoning !== true) return [];
	const map = model.thinkingLevelMap;
	return THINKING_LEVELS.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** The `reasoning` field shape the LLM seam exposes for one model. */
function reasoningField(model) {
	const levels = supportedLevels(model);
	if (levels.length === 0) return undefined;
	return { efforts: levels.map((level) => ({ id: level, name: `${level.charAt(0).toUpperCase()}${level.slice(1)}` })) };
}

/** Wrap the class's resolution seam. Returns a short report for the log. */
function install(proto, logger) {
	const installed = Symbol.for("dsh-model-metadata/installed");
	if (proto[installed] === true) return { status: "already-installed" };
	if (typeof proto.current !== "function" || typeof proto.modelInfo !== "function") return { status: "unsupported" };
	proto[installed] = true;
	let enriched = 0;
	const announce = (provider, model) => {
		enriched++;
		if (enriched === 1) logger?.info?.(`dsh-model-metadata: first enrichment (${provider}/${model.id} -> context ${String(model.contextWindow)}, output ${String(model.maxTokens)}, reasoning ${model.reasoning === true ? "yes" : "no"})`);
	};
	const originalCurrent = proto.current;
	const originalInfo = proto.modelInfo;
	const snapshots = new WeakMap();
	proto.current = function () {
		const snapshot = originalCurrent.call(this);
		const collection = snapshot?.models;
		if (collection === undefined || collection === null || typeof collection.getModel !== "function") return snapshot;
		const hit = snapshots.get(snapshot);
		if (hit !== undefined) return hit;
		const wrap = (model, provider) => {
			if (model === undefined || model === null) return model;
			const next = enrichModel(model, provider);
			if (next !== model) announce(provider, next);
			return next;
		};
		const models = new Proxy(collection, {
			get(target, property) {
				if (property === "getModel") return (provider, id) => wrap(target.getModel(provider, id), provider);
				if (property === "getModels") return (provider) => (target.getModels(provider) ?? []).map((model) => wrap(model, provider));
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			}
		});
		const wrapped = { ...snapshot, models };
		snapshots.set(snapshot, wrapped);
		return wrapped;
	};
	/**
	 * Second path, for a build whose `modelInfo()` stops reading through
	 * `current()`: enrich the descriptor directly. It only fills fields the
	 * adapter left empty, so it can never overwrite a catalogued or configured
	 * value.
	 */
	proto.modelInfo = function (snapshot, provider, model) {
		const info = originalInfo.apply(this, arguments);
		if (info === null || typeof info !== "object") return info;
		const resolved = snapshot?.models?.getModel?.(provider, model);
		const enrichedModel = resolved === undefined ? undefined : enrichModel(resolved, provider);
		if (enrichedModel === undefined || enrichedModel === null) return info;
		const next = { ...info };
		if (Number.isInteger(enrichedModel.contextWindow) && enrichedModel.contextWindow > 0 && info.context?.contextWindow !== enrichedModel.contextWindow) next.context = { contextWindow: enrichedModel.contextWindow };
		if (info.reasoning === undefined) {
			const reasoning = reasoningField(enrichedModel);
			if (reasoning !== undefined) next.reasoning = reasoning;
		}
		return next;
	};
	return { status: "installed" };
}

/**
 * Cordis plugin entry. Everything below the seam is plain data, so apply() only
 * wraps the class and reports what it found.
 * @param ctx - the plugin context (only the logger is used).
 */
export function apply(ctx) {
	const logger = ctx?.logger;
	if (!ENABLED) {
		logger?.info?.("dsh-model-metadata: disabled by DSH_PI_AI_CATALOG_FALLBACK=off");
		return;
	}
	if (adapterLoad.failure !== undefined) {
		logger?.warn?.(`dsh-model-metadata: cannot load the pi-ai adapter (${adapterLoad.failure}); no metadata will be filled in`);
		return;
	}
	if (catalogLoad.failure !== undefined) {
		logger?.warn?.(`dsh-model-metadata: cannot load the installed catalog (${catalogLoad.failure}); no metadata will be filled in`);
		return;
	}
	const adapter = adapterLoad.exports?.PiAiAdapter;
	if (typeof adapter !== "function") {
		logger?.warn?.("dsh-model-metadata: @deepseek-ai/dsh-llm-pi-ai exports no PiAiAdapter class; no metadata will be filled in");
		return;
	}
	const report = install(adapter.prototype, logger);
	if (report.status === "unsupported") {
		logger?.warn?.("dsh-model-metadata: PiAiAdapter.current()/modelInfo() has an unexpected shape in this build; no metadata will be filled in");
		return;
	}
	/*
	 * The summary reports whatever snapshot was on disk at this point; a stale
	 * one is replaced in the background just below and picked up by the next
	 * model resolution, without a restart.
	 */
	const snapshot = snapshotState();
	logger?.info?.(`dsh-model-metadata: ${report.status} (mode ${MODE}${MATCH_INPUT ? `+input:${INPUT_MODE}` : ""}, refresh ${REFRESH_HOURS > 0 ? `${String(REFRESH_HOURS)}h` : "off"} + on start ${START_MODE}${START_MODE === "always" ? ` (floor ${String(START_FLOOR_MINUTES)}m)` : ""} + on open ${OPEN_HOURS > 0 ? `${String(OPEN_HOURS)}h` : "off"}, adapter ${adapterLoad.from}, model names indexed ${String(fallbackIndex().byName.size)}, official deepseek catalog ${String(fallbackIndex().firstPartyCount)} models, snapshot entries ${String(snapshot.entries.length)})`);
	scheduleRefresh(logger);
	registerPanel(ctx, logger);
}
