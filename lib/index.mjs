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
 * the wrapper leaves the snapshot untouched and says so once instead of breaking.
 * A later load of this module (a hot reload) takes the seam over from an earlier
 * one, so the switches below are read by whichever copy is newest.
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
 *   DSH_PI_AI_CATALOG_REFRESH=<hours>   the daily threshold (default 24),
 *                                       checked hourly. 0 = no automatic fetch
 *                                       at all (master)
 *   DSH_PI_AI_CATALOG_REFRESH_ON_START=always|stale|off
 *                                       a launch refreshes (default always)
 *   ..._REFRESH_START_FLOOR_MINUTES=<minutes>  do not re-fetch at launch when the
 *                                       local copy is younger (default 15)
 *   ..._REFRESH_OPEN_HOURS=<hours>      opening the app (the page asking for panel
 *                                       data) refreshes a copy older than this
 *                                       (default 6; 0 disables)
 *   DSH_PI_AI_CATALOG_FALLBACK_LEVELS=on (default) any matched source may declare
 *                                       reasoning levels
 *   DSH_PI_AI_CATALOG_FALLBACK_LEVELS=bundled  only the catalogs that ship with the
 *                                       product may (models.dev only fills capacity)
 *   DSH_PI_AI_CATALOG_FALLBACK_LEVELS=off  never touch reasoning
 *   DSH_PI_AI_CATALOG_SNAPSHOT_URL=<url>  where to fetch the raw database from
 *   DSH_PI_AI_CATALOG_PANEL=off         do not register the settings-panel route
 *                                       at all (the metadata fallback is unaffected)
 *   DSH_PI_AI_CATALOG_PANEL_HOSTS=<list>  comma-separated Host values the panel
 *                                       route will answer for; unset = any host
 *                                       (see the note on the route's auth below)
 *   DSH_CATALOG_FALLBACK_NODE_MODULES=<dir>  extra node_modules root to resolve from
 *
 * Every switch is validated: a value outside its documented set is reported once
 * and falls back to the most conservative behaviour rather than to the most
 * permissive one (a typo in `..._FALLBACK_INPUT` used to mean "on").
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchModelsDevSnapshotIfChanged, snapshotDefaultPath, snapshotUrl } from "./snapshot.mjs";
import { bareName, MIN_NORMALIZED_LENGTH, normalizedKeys, normalizeName } from "./names.mjs";
import { buildMatrix, SETTINGS_NAMESPACE } from "./panel.mjs";

export const name = "dsh-model-metadata";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENRICHED = Symbol("dsh-model-metadata/enriched");

/*
 * Switch complaints are collected here and reported by apply(): the module is
 * loaded before any logger exists, and a typo that silently changes behaviour is
 * exactly what this list exists to prevent.
 */
const complaints = [];

/*
 * Warnings raised before (or after) apply() has a logger: the module body runs
 * first, and a resolution can happen long after apply() returned. Messages are
 * held until a logger exists, then each one is emitted at most once per
 * process — a corrupt snapshot would otherwise warn on every model resolution.
 */
let activeLogger;
const pendingWarnings = [];
const saidWarnings = new Set();

/**
 * Report one problem at most once, through whatever logger is available.
 * @param message - the line to emit.
 */
function warnOnce(message) {
	if (saidWarnings.has(message)) return;
	saidWarnings.add(message);
	if (activeLogger === undefined) pendingWarnings.push(message);
	else activeLogger.warn?.(message);
}

/**
 * Attach the plugin's logger and flush whatever was collected before it existed.
 *
 * A context without a logger keeps the messages queued rather than dropping them:
 * a second `apply()` (a reload) may well be the one that has somewhere to write.
 */
function useLogger(logger) {
	if (logger === undefined) return;
	activeLogger = logger;
	for (const message of pendingWarnings.splice(0)) logger.warn?.(message);
}

/**
 * Read one enumerated switch, reporting anything outside its documented set.
 *
 * Absent and unrecognized are different answers on purpose: leaving a variable
 * unset must mean the documented default, while a typo must land on the safe end
 * of that switch's range — the two used to be the same code path, which is how
 * `..._FALLBACK_INPUT=of` ended up meaning "yes, claim image support".
 * @param text - the raw environment value.
 * @param allowed - the accepted values.
 * @param defaults - `{ absent, unknown }`; the value to use for each case.
 * @param label - the variable name, for the complaint.
 * @returns one of `allowed`.
 */
function oneOf(text, allowed, defaults, label) {
	const value = String(text ?? "").trim().toLowerCase();
	if (value.length === 0) return defaults.absent;
	if (allowed.includes(value)) return value;
	complaints.push(`${label}=${JSON.stringify(value)} is not one of ${allowed.join("|")}; using ${defaults.unknown}`);
	return defaults.unknown;
}

const MODE = oneOf(process.env.DSH_PI_AI_CATALOG_FALLBACK, ["off", "context", "full"], { absent: "full", unknown: "full" }, "DSH_PI_AI_CATALOG_FALLBACK");
const ENABLED = MODE !== "off";
/*
 * Reasoning levels follow the same shape of choice as input modalities, because
 * they carry the same kind of risk: models.dev publishes a bare `reasoning: true`
 * with no level detail, and translating that into "off/minimal/low/medium/high"
 * offers five levels the endpoint may not accept — a turn that fails at request
 * time, after the message is durable. `bundled` restricts the claim to the
 * catalogs that ship with the product (the pi-ai catalog and the official route,
 * which do carry a level map), and `off` leaves reasoning to the seam.
 */
const LEVEL_MODE = oneOf(process.env.DSH_PI_AI_CATALOG_FALLBACK_LEVELS, ["on", "bundled", "off"], { absent: "on", unknown: "bundled" }, "DSH_PI_AI_CATALOG_FALLBACK_LEVELS");
const MATCH_REASONING = MODE !== "context" && LEVEL_MODE !== "off";
/** `bundled` takes reasoning only from catalogs that ship with the product. */
const LEVEL_BUNDLED_ONLY = LEVEL_MODE === "bundled";
/*
 * Input modalities follow the same chain by default: whichever entry wins for
 * this model name also decides whether it takes images. The seam's own default
 * is text-only because over-claiming admits an image the endpoint then rejects
 * mid-turn, after the message is durable — so `off` and `bundled` stay available
 * as narrower settings, and one model can always be pinned back with an explicit
 * `input:` in settings.yaml. An unrecognized value resolves to `off` rather than
 * to the default `on`: this is the one switch where guessing wrong costs a
 * broken turn, not just a borrowed number.
 */
const INPUT_MODE = oneOf(process.env.DSH_PI_AI_CATALOG_FALLBACK_INPUT, ["on", "bundled", "off"], { absent: "on", unknown: "off" }, "DSH_PI_AI_CATALOG_FALLBACK_INPUT");
const MATCH_INPUT = INPUT_MODE !== "off";
/** `bundled` takes image support only from catalogs that ship with the product, never from models.dev. */
const INPUT_BUNDLED_ONLY = INPUT_MODE === "bundled";
const MODALITIES = ["text", "image"];
/**
 * How many characters of a normalized key the near-neighbour buckets are keyed by.
 *
 * Four is the shortest family head the scan accepts (see the caller's
 * `MIN_NORMALIZED_LENGTH` guard), so a bucket never has to be subdivided: a head of
 * four or more characters picks exactly one bucket, and a shorter one falls back to
 * walking the normalized index directly.
 */
const NEARBY_PREFIX = 4;
/** The sources that ship with the product, for the `bundled` restrictions. */
const BUNDLED_SOURCES = ["pi-ai-catalog", "first-party"];
/**
 * How stale the models.dev snapshot may get before a background refresh is
 * scheduled. The daily default is what keeps a newly released model from sitting
 * uncovered until someone notices; `0` turns the automatic path off and leaves
 * the manual `refresh-snapshot.mjs` as the only way to update.
 */
const REFRESH_HOURS = nonNegative(process.env.DSH_PI_AI_CATALOG_REFRESH, 24, "DSH_PI_AI_CATALOG_REFRESH");
const REFRESH_URL = snapshotUrl();
/*
 * A launch refreshes too, not just a day-old file: "open DSH and the data is
 * current" is the point, and waiting up to 24h for it is not. The floor is what
 * keeps a restart loop (or a supervisor flapping) from hammering models.dev — a
 * file younger than it is close enough to fresh that re-fetching buys nothing.
 * An unknown mode means "do not fetch on your own" rather than the busy default.
 */
const START_MODE = oneOf(process.env.DSH_PI_AI_CATALOG_REFRESH_ON_START, ["always", "stale", "off"], { absent: "always", unknown: "off" }, "DSH_PI_AI_CATALOG_REFRESH_ON_START");
const START_FLOOR_MINUTES = nonNegative(process.env.DSH_PI_AI_CATALOG_REFRESH_START_FLOOR_MINUTES, 15, "DSH_PI_AI_CATALOG_REFRESH_START_FLOOR_MINUTES");
/*
 * Opening the app — the page asking this plugin for its data — refreshes a
 * snapshot older than this, which is what keeps a service that has been up for
 * weeks current. Deliberately bounded and deduplicated: the panel route carries no
 * token (DSH offers no request-auth hook for plugin routes), so an anonymous
 * caller must not be able to force a fetch per request.
 */
const OPEN_HOURS = nonNegative(process.env.DSH_PI_AI_CATALOG_REFRESH_OPEN_HOURS, 6, "DSH_PI_AI_CATALOG_REFRESH_OPEN_HOURS");
/*
 * The panel route answers with model names and catalog verdicts, never with a
 * credential — but DSH dispatches plugin routes ahead of its own token gate, so
 * a deployment that publishes this server to a wider network publishes that
 * inventory too. `off` drops the route (the metadata fallback keeps working), and
 * `HOSTS` narrows it to an explicit list of Host values for the deployments that
 * sit behind a proxy.
 */
const PANEL_MODE = oneOf(process.env.DSH_PI_AI_CATALOG_PANEL, ["on", "off"], { absent: "on", unknown: "on" }, "DSH_PI_AI_CATALOG_PANEL");
const PANEL_HOSTS = String(process.env.DSH_PI_AI_CATALOG_PANEL_HOSTS ?? "")
	.split(",")
	.map((host) => host.trim().toLowerCase())
	.filter((host) => host.length > 0);

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
	/*
	 * Hy/hunyuan has no vendor route of its own in the catalog — only the
	 * opencode-go aggregator carries it — so the aggregator IS this family's
	 * representative, and stays in UPSTREAM: without it, a bare `hy3` falls to
	 * the same-named open-source entries other catalogs carry (openrouter's
	 * `hy3` is a different, small model). For every other family the aggregators
	 * stay demoted (rank 2000), below real catalog routes.
	 */
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
 *
 * Two shapes have to be understood, because DSH ships in both. Under DSH's own
 * process the packages are nested inside it — `<prefix>/lib/node_modules/
 * @deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai` — and `argv[1]` names
 * that tree. Under a test runner or a tool the plugin is loaded into, `argv[1]` is
 * that tool instead, and the install is wherever `DSH_INSTALL` says it is. This
 * used to mean the plugin disabled itself completely when neither guessed right,
 * which is what happened on a machine whose DSH came from a global install.
 *
 * Computed once: the list is a property of the process, and rebuilding it per
 * import also meant re-reading a version-manager directory per import. The
 * version-manager scan stays as a last resort for an install that put the
 * packages somewhere none of the above implies.
 * @returns the absolute roots, most specific first.
 */
let moduleRoots;
function nodeModuleRoots() {
	if (moduleRoots !== undefined) return moduleRoots;
	const roots = [];
	const add = (dir) => {
		if (typeof dir !== "string" || dir.length === 0) return;
		if (!roots.includes(dir)) roots.push(dir);
	};
	add(process.env.DSH_CATALOG_FALLBACK_NODE_MODULES);
	for (const root of installRoots(process.env.DSH_INSTALL)) add(root);
	/*
	 * The dependency tree the adapter itself resolves from: asked of Node rather
	 * than guessed, so a layout this plugin has never seen still works, and the
	 * copy of a package that the running DSH actually uses is the one that wins.
	 */
	add(dependencyRoot());
	const argv1 = process.argv[1];
	if (typeof argv1 === "string" && argv1.length > 0 && !argv1.startsWith("node:")) add(join(dirname(dirname(argv1)), "node_modules"));
	add(join(HERE, "..", "node_modules"));
	add(join(dshHome(), "profiles", "node_modules"));
	add(join(dshHome(), "plugins", "node_modules"));
	const nvm = join(homedir(), ".nvm", "versions", "node");
	if (existsSync(nvm)) {
		for (const version of readdirSync(nvm)) add(join(nvm, version, "lib", "node_modules", "@deepseek-ai", "dsh", "node_modules"));
	}
	/*
	 * Any root that turns out to hold DSH itself also offers the tree *inside* that
	 * package, which is where a published install keeps its dependencies. Checked
	 * after the loop so it applies to every root above, including the configured one.
	 */
	for (const root of [...roots]) add(join(root, "@deepseek-ai", "dsh", "node_modules"));
	moduleRoots = roots;
	return moduleRoots;
}

/**
 * The node_modules roots a `DSH_INSTALL` implies.
 *
 * The variable is documented for the tools as "the package directory, or a `lib`
 * directory holding node_modules", and it is read here too: a test runner that
 * loaded this plugin has no other way to learn where DSH is, and one guess away
 * from the truth means the whole fallback stays off. Every shape it can take is
 * accepted rather than one, since guessing wrong is silent.
 * @param configured - the raw variable, if any.
 * @returns candidate roots, deepest last.
 */
export function installRoots(configured) {
	if (typeof configured !== "string" || configured.length === 0) return [];
	return [
		/* A `lib` directory that holds node_modules. */
		join(configured, "node_modules"),
		/* …and the tree inside the DSH package sitting there. */
		join(configured, "node_modules", "@deepseek-ai", "dsh", "node_modules"),
		/* The DSH package directory itself. */
		join(configured, "@deepseek-ai", "dsh", "node_modules"),
		/* A node_modules directory. */
		configured
	];
}

/**
 * The node_modules directory the vendor packages resolve from, when the
 * dependency that carries them can be located from this process.
 *
 * Two speculative layouts are tried (a global install, and this plugin's own
 * tree) and the answer is remembered; a failure is not an error, it only means
 * the guessed roots above have to do the work.
 * @returns the absolute node_modules directory, or undefined.
 */
let dependencyRootResolved = false;
let dependencyRootDir;
function dependencyRoot() {
	if (dependencyRootResolved) return dependencyRootDir;
	dependencyRootResolved = true;
	for (const anchor of [process.argv[1], fileURLToPath(import.meta.url)]) {
		if (typeof anchor !== "string" || anchor.length === 0) continue;
		try {
			/* The package's own manifest is an exported subpath, so this stays legal
			 * even though the catalog's deep files are not addressable by specifier. */
			const manifest = createRequire(anchor).resolve("@deepseek-ai/dsh-llm-pi-ai/package.json");
			dependencyRootDir = dirname(dirname(dirname(manifest)));
			return dependencyRootDir;
		} catch {
			/* Try the next anchor. */
		}
	}
	return undefined;
}

/**
 * Import one package file by absolute path, from the first root that yields it.
 *
 * A root whose file exists but cannot be imported does not end the search: a
 * half-removed copy (an interrupted update, a stale profile layer) used to shadow
 * the working one and disable the whole plugin silently. Every failure is
 * remembered and the last one is reported if no root works.
 * @param relative - the path inside a node_modules root.
 * @param bare - the specifier to fall back to when no root carries the file.
 * @returns `{ exports, from }` or `{ failure }`.
 */
async function loadFromRoots(relative, bare) {
	let failure;
	for (const root of nodeModuleRoots()) {
		const file = join(root, relative);
		if (!existsSync(file)) continue;
		try {
			return { exports: await import(pathToFileURL(file).href), from: file };
		} catch (error) {
			failure = `${file}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	try {
		return { exports: await import(bare), from: bare };
	} catch (error) {
		return { failure: failure ?? `${bare}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/*
 * Loaded together rather than one after another: the four imports are
 * independent, and in a process that already pulled the vendor graph in (the
 * normal case — DSH imports the adapter itself) they share one module cache, so
 * the only thing serializing them ever bought was wall-clock time.
 */
const [adapterLoad, catalogLoad, levelsLoad, yamlLoad, deepseekLoad] = ENABLED
	? await Promise.all([
		loadFromRoots("@deepseek-ai/dsh-llm-pi-ai/lib/index.js", "@deepseek-ai/dsh-llm-pi-ai"),
		loadFromRoots("@earendil-works/pi-ai/dist/providers/all.js", "@earendil-works/pi-ai/providers/all"),
		/*
		 * The level table itself, from the package that owns it. Optional: the deep
		 * path is not an exported subpath, so a build that moves it costs this plugin
		 * nothing but the mirror below — and the mirror is what drifts when pi-ai
		 * grows a level, which is exactly why the real function is preferred.
		 */
		loadFromRoots("@earendil-works/pi-ai/dist/models.js", "@earendil-works/pi-ai"),
		loadFromRoots("js-yaml/index.js", "js-yaml"),
		/*
		 * The official DeepSeek route's own adapter: optional on purpose. A deployment
		 * without it (or a build that renames the export) simply loses one candidate
		 * source — the pi-ai catalog and the models.dev snapshot still answer, and no
		 * warning is worth frightening a user whose install never had the package.
		 */
		loadFromRoots("@deepseek-ai/dsh-llm-deepseek/lib/index.js", "@deepseek-ai/dsh-llm-deepseek")
	])
	: [{}, {}, {}, {}, {}];

/**
 * A configured non-negative number, or the fallback when it is absent or garbage.
 *
 * Deliberately not `Number.parseFloat`: that reads `0x10` as 0 (and so turns a
 * typo'd refresh interval into "never refresh"), and silently accepts `1e9`
 * trailing text. Only a plain decimal counts.
 * @param text - the raw environment value.
 * @param fallback - the value to use when the text is absent or unreadable.
 * @param label - the variable name, for the complaint.
 * @returns the configured number, or the fallback.
 */
function nonNegative(text, fallback, label) {
	const raw = String(text ?? "").trim();
	if (raw.length === 0) return fallback;
	if (!/^\d+(\.\d+)?$/u.test(raw)) {
		complaints.push(`${label}=${JSON.stringify(raw)} is not a non-negative number; using ${String(fallback)}`);
		return fallback;
	}
	return Number.parseFloat(raw);
}

/**
 * Preferred route names for one bare name: its family upstream(s) only.
 *
 * Memoized because ranking asks this for every candidate of every name, and the
 * answer is a pure function of the name and the constant table above.
 */
const preferredCache = new Map();
function preferredRoutes(bare) {
	const key = String(bare);
	const cached = preferredCache.get(key);
	if (cached !== undefined) return cached;
	const order = [];
	for (const member of UPSTREAM) if (member[0].test(key)) order.push(...member[1]);
	/* Keys come from model ids and provider names, so this grows with the catalogs,
	 * not with traffic; the guard only keeps a pathological catalog from pinning
	 * memory forever. */
	if (preferredCache.size > 20000) preferredCache.clear();
	preferredCache.set(key, order);
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
	return snapshotDefaultPath(dshHome());
}

/**
 * The models.dev snapshot as candidates, re-read whenever the file changes.
 *
 * The change key is mtime *and* size: some filesystems only carry second-level
 * timestamps, and a rewrite that lands inside the same second would otherwise
 * leave the index stale until the next restart.
 * @returns the path, the file's change key (absent file: 0 bytes, stamp 0), the
 * parsed document's own metadata, and entries.
 */
let snapshotCache;
function snapshotState() {
	const path = snapshotPath();
	let stats;
	try {
		stats = statSync(path);
	} catch {
		return { path, stamp: 0, size: 0, etag: undefined, entries: [] };
	}
	const stamp = stats.mtimeMs;
	const size = stats.size;
	if (snapshotCache !== undefined && snapshotCache.path === path && snapshotCache.stamp === stamp && snapshotCache.size === size) return snapshotCache;
	const entries = [];
	let etag;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		etag = typeof parsed?.etag === "string" ? parsed.etag : undefined;
		for (const [id, entry] of Object.entries(parsed?.models ?? {})) {
			if (entry === null || typeof entry !== "object") continue;
			entries.push({
				id,
				bare: bareName(id),
				route: `models.dev:${String(entry.provider ?? "unknown")}`,
				provider: typeof entry.provider === "string" ? entry.provider : undefined,
				name: entry.name,
				contextWindow: entry.contextWindow,
				maxTokens: entry.maxTokens,
				input: Array.isArray(entry.input) ? entry.input.filter((modality) => MODALITIES.includes(modality)) : undefined,
				reasoning: entry.reasoning === true,
				nonChat: entry.nonChat === true,
				source: "models.dev"
			});
		}
	} catch (error) {
		/*
		 * A corrupt snapshot must never break model resolution, but it must not be
		 * invisible either: without this line the only symptom is every models.dev-only
		 * model quietly reading as "no match".
		 */
		entries.length = 0;
		warnOnce(`dsh-model-metadata: cannot read the models.dev snapshot at ${path} (${error instanceof Error ? error.message : String(error)}); models it alone describes will read as unmatched until the file is rewritten`);
	}
	snapshotCache = { path, stamp, size, etag, entries };
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
 *
 * The key carries both paths as well as both change keys: a stamp and size alone
 * cannot tell two files apart, so re-pointing an override at a different
 * document of the same shape would otherwise keep serving the old index.
 *
 * The settings state travels on the index for two reasons: resolution needs the
 * declared fields the index was built against (asking for them again would be
 * another `statSync` per model), and an unreadable document has to disable
 * enrichment rather than let it borrow over a declaration nobody can see.
 * @returns the lookup used by every resolution.
 */
let indexCache;
function fallbackIndex() {
	const snapshot = snapshotState();
	const settings = settingsState();
	const revision = `${snapshot.path}:${String(snapshot.stamp)}:${String(snapshot.size)}:${settings.path}:${String(settings.stamp)}:${String(settings.size)}`;
	if (indexCache !== undefined && indexCache.revision === revision) return indexCache.index;
	const byName = new Map();
	const byLower = new Map();
	const byNorm = new Map();
	/*
	 * A second, coarser index over the normalized keys, for the near-neighbour scan
	 * (see `inspect()`). That scan wants every key *starting with* a family head, and
	 * asking that of `byNorm` means visiting every key in the catalog — the map walk was
	 * the whole cost of an unmatched model's hint line. Bucketing the keys by their first
	 * `NEARBY_PREFIX` characters answers the same question by visiting one bucket, and the
	 * buckets hold references to the same lists, so no candidate is duplicated.
	 */
	const byPrefix = new Map();
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
			if (key.length >= NEARBY_PREFIX) {
				const bucket = key.slice(0, NEARBY_PREFIX);
				const entries = byPrefix.get(bucket);
				if (entries === undefined) byPrefix.set(bucket, [[key, byNorm.get(key)]]);
				else if (!entries.some((entry) => entry[0] === key)) entries.push([key, byNorm.get(key)]);
			}
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
	indexCache = { revision, index: { revision, settings, declared: new Map(), byName, byLower, byNorm, byPrefix, routeOrder, exact, firstPartyCount: firstParty.length } };
	return indexCache.index;
}

/**
 * The official `deepseek-official` route's reasoning levels, asked of the
 * adapter itself rather than hardcoded, so a future route that grows (or drops)
 * a level is followed without a plugin update. One question at load time, onto
 * a throwaway adapter instance; absent (undefined) when the package or the
 * answer is missing, which leaves the candidate without a level map.
 */
const OFFICIAL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const officialThinkingLevelMap = await (async () => {
	const Adapter = deepseekLoad.exports?.DeepSeekAdapter;
	if (typeof Adapter !== "function" || typeof deepseekLoad.exports?.resolveAdapterOptions !== "function") return undefined;
	try {
		const adapter = new Adapter({ options: () => deepseekLoad.exports.resolveAdapterOptions({}) });
		const first = (await adapter.resolveModel("deepseek-official", "deepseek-flash"))?.reasoning?.efforts;
		if (!Array.isArray(first)) return undefined;
		const offered = new Set(first.map((effort) => effort?.id).filter((id) => typeof id === "string"));
		if (offered.size === 0) return undefined;
		const map = {};
		for (const level of OFFICIAL_LEVELS) map[level] = offered.has(level) ? level : null;
		return map;
	} catch {
		return undefined;
	}
})();

/**
 * The official `deepseek-official` route's own catalog, as fallback candidates.
 *
 * That route (the "DeepSeek" entry in the model switcher) keeps its model list
 * in `@deepseek-ai/dsh-llm-deepseek`, not in the pi-ai catalog — so without this
 * source a gateway alias of its names matches nothing. The list is resolved the
 * way the route itself resolves it (`resolveAdapterOptions`), so a catalog the
 * user reshaped in the `llm-deepseek` settings section is what gets matched, and
 * the vendor's defaults otherwise. Reasoning rides the route's own rule: every
 * model offers the route's own levels unless thinking is configured off.
 *
 * The id is reduced to its bare name like every other source: that section
 * accepts any non-empty string, so a list written with the route prefix
 * (`deepseek-official/deepseek-v4-pro`) would otherwise be indexed under a key
 * no configured name can ever produce, and the whole source would answer nothing.
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
	return options.models
		.filter((model) => model !== null && typeof model === "object" && typeof model.id === "string" && model.id.length > 0)
		.map((model) => ({
			bare: bareName(model.id),
			route: "deepseek-official",
			name: model.name,
			contextWindow: model.contextWindow ?? options.defaultContextWindow,
			maxTokens: model.maxTokens ?? options.maxTokens,
			input: Array.isArray(model.inputModalities) ? model.inputModalities.filter((modality) => MODALITIES.includes(modality)) : undefined,
			reasoning,
			...reasoning && officialThinkingLevelMap !== undefined ? { thinkingLevelMap: { ...officialThinkingLevelMap } } : {},
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
 * half-written one. The temporary file is removed on every exit path: a failed
 * write used to leave `<snapshot>.tmp-<pid>` behind for good.
 *
 * The endpoint publishes an ETag, so the request carries the one stored with the
 * local copy: a body-less 304 means the copy is current, and the file is then
 * merely restamped so the age rules stop asking. That restamp is what moves the
 * mtime the index keys on, so the next resolution rebuilds it once — the price of
 * not re-downloading several megabytes to learn nothing changed.
 * @param logger - optional sink for the one-line outcome.
 * @returns the written document, or undefined when nothing was written.
 */
async function refreshSnapshotNow(logger) {
	const path = snapshotPath();
	const temporary = `${path}.tmp-${String(process.pid)}`;
	try {
		const result = await fetchModelsDevSnapshotIfChanged(REFRESH_URL, undefined, snapshotState().etag);
		if (result.unchanged === true) {
			const now = new Date();
			try {
				utimesSync(path, now, now);
			} catch {
				/* The file can vanish between the two calls; the age rule just stays. */
			}
			logger?.info?.("dsh-model-metadata: the models.dev snapshot is already current (not modified)");
			return undefined;
		}
		const snapshot = result.snapshot;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temporary, JSON.stringify(snapshot));
		renameSync(temporary, path);
		logger?.info?.(`dsh-model-metadata: refreshed the models.dev snapshot (${String(snapshot.count)} models, ${String(Object.values(snapshot.models).filter((model) => model.reasoning).length)} reasoning-capable) -> ${path}`);
		return snapshot;
	} catch (error) {
		logger?.warn?.(`dsh-model-metadata: could not refresh the models.dev snapshot (${error instanceof Error ? error.message : String(error)}); keeping the existing data`);
		return undefined;
	} finally {
		try {
			rmSync(temporary, { force: true });
		} catch {
			/* Nothing to clean up, or nothing that can be done about it. */
		}
	}
}

/** The fetch in flight, so several triggers in the same second produce one request. */
let refreshing;
/** When the last attempt *started*, so a failure is not retried at request rate. */
let lastAttemptAt = 0;
/**
 * How long a failed attempt keeps the next one away.
 *
 * A fetch that fails leaves the file untouched, so the staleness rules still say
 * "yes" — which used to mean one ~5 MB request per panel load for as long as the
 * network stayed down. Five minutes is long enough to stop that and short enough
 * that a transient failure heals inside a working session.
 */
const ATTEMPT_FLOOR_MS = 5 * 60 * 1000;

/** `12.4h ago` / `never fetched` for the log line. */
function describeAge(hours) {
	return Number.isFinite(hours) ? `${hours.toFixed(1)}h old` : "absent";
}

/**
 * How often the daily rule is *checked*, not how often it fires.
 *
 * A process that stays up for weeks is the case the gap between "the data is
 * older than `DSH_PI_AI_CATALOG_REFRESH`" and "something asks for it again"
 * used to fall into: the launch trigger only runs at launch, and the app-open
 * trigger only runs if somebody opens the settings page (and only if the panel
 * route is registered at all). An hourly tick against a 24-hour rule means the
 * fetch happens within an hour of becoming due, and costs one `statSync` an
 * hour otherwise.
 */
export const DAILY_CHECK_MS = 60 * 60 * 1000;

/**
 * Start a refresh when one is due for the given reason; never blocks.
 *
 * Deduplicated twice over: the in-flight promise collapses triggers that land in
 * the same second (a launch and an app-open, or a page's several cards), and the
 * attempt floor keeps a *failing* fetch from being retried per request. Only the
 * automatic triggers are floored — a manual `refreshIfDue(…, "manual")` is an
 * operator asking, and an operator can read the error it prints.
 * @param logger - optional sink for the one-line outcome.
 * @param reason - `start`, `open`, `daily` or `manual` — decides which rule applies.
 * @param now - the clock to judge against.
 * @returns whether this call started the fetch.
 */
export function refreshIfDue(logger, reason = "start", now = Date.now()) {
	if (typeof fetch !== "function") return false;
	if (refreshing !== undefined) return false;
	if (reason !== "manual" && now - lastAttemptAt < ATTEMPT_FLOOR_MS) return false;
	const due = reason === "open" ? openDue(now) : reason === "start" ? startDue(now) : refreshDue(now);
	if (!due) return false;
	logger?.info?.(`dsh-model-metadata: refreshing the models.dev snapshot on ${reason} (the local copy is ${describeAge(snapshotAgeHours(now))})`);
	lastAttemptAt = now;
	refreshing = refreshSnapshotNow(logger).finally(() => {
		refreshing = undefined;
	});
	return true;
}

/** Schedule the launch refresh; never blocks. */
function scheduleRefresh(logger) {
	refreshIfDue(logger, "start");
}

/**
 * Schedule the daily rule — the third documented trigger, and the only one that
 * does not depend on something else happening (a launch, or somebody opening the
 * app). Registered through the context's own effect when it has one, so a hot
 * reload disposes the old timer instead of leaving a second one behind; the
 * interval is `unref`ed either way, because a plugin may not be the reason a
 * process stays alive.
 * @param ctx - the plugin context.
 * @param logger - optional sink for the one-line outcome.
 */
function scheduleDailyRefresh(ctx, logger) {
	const start = () => {
		const timer = setInterval(() => refreshIfDue(logger, "daily"), DAILY_CHECK_MS);
		timer.unref?.();
		return () => clearInterval(timer);
	};
	if (typeof ctx?.effect === "function") ctx.effect(start, "dsh-model-metadata: daily refresh check");
	else start();
}

/** Where the settings panel reads its matrix from. */
export const PANEL_PATH = "/model-metadata/matrix";

/**
 * Whether the panel route may answer this request.
 *
 * Two checks, both cheap and both about who is asking rather than about what is
 * sent — there is no credential in the payload, only model names:
 *
 *   - `DSH_PI_AI_CATALOG_PANEL_HOSTS`, when set, is the only Host accepted. That
 *     is the switch for a deployment that knows which names it is reachable
 *     under, and the reason it is opt-in rather than mandatory is that a proxy
 *     rewrites Host in ways only its owner can predict.
 *   - cross-site and cross-origin browser requests are refused. A page on another
 *     origin can only read this route if the browser lets it, and a same-origin
 *     page (or a same-site one behind a proxy) is what the panel actually is. A
 *     request with no browser headers at all — a script, a health check — still
 *     passes, because refusing it would break the only deployment shape this
 *     plugin has ever been tested in.
 *
 * @param req - the incoming request.
 * @returns whether the request may be served.
 */
function panelRequestAllowed(req) {
	const host = String(req?.headers?.host ?? "").toLowerCase();
	if (PANEL_HOSTS.length > 0 && !PANEL_HOSTS.includes(host)) return false;
	if (String(req?.headers?.["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") return false;
	const origin = req?.headers?.origin;
	if (typeof origin === "string" && origin.length > 0 && origin !== "null") {
		try {
			return new URL(origin).host.toLowerCase() === host;
		} catch {
			return false;
		}
	}
	return true;
}

/*
 * The panel body, memoized by the index revision it was built from. Every card
 * on the settings page asks for its own route, and building one answer inspects
 * every configured model — so a page with several cards used to spend that work
 * several times over for a payload that cannot have changed in between.
 */
let matrixCache;

/**
 * The serialized matrix for one request.
 * @param wanted - the provider route to answer for, or undefined for all of them.
 * @returns the JSON body to send.
 */
function panelBody(wanted) {
	const revision = fallbackIndex().revision;
	const key = `${revision}\u0000${wanted ?? ""}`;
	if (matrixCache !== undefined && matrixCache.key === key) return matrixCache.body;
	const body = JSON.stringify(buildMatrix(settingsProviders(), inspect, wanted));
	matrixCache = { key, body };
	return body;
}

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
 * assets. What that means in practice: on a deployment whose port is reachable by
 * someone else, the configured route names and model ids are readable by them
 * too. The answer is to keep the payload non-secret (as here) and to pick one of
 * the two switches — `DSH_PI_AI_CATALOG_PANEL=off` drops the route entirely (the
 * two controls in the editor then do not appear at all, and no error is shown:
 * the client cannot tell a route that was switched off from one that this build
 * never registered, so it stays quiet — and the metadata fallback is untouched),
 * and `DSH_PI_AI_CATALOG_PANEL_HOSTS=<list>` narrows it to the names it is
 * served under.
 * @param ctx - the plugin context.
 * @param logger - optional sink for the one-line outcome.
 */
function registerPanel(ctx, logger) {
	if (PANEL_MODE === "off") {
		logger?.info?.("dsh-model-metadata: the settings panel route is disabled by DSH_PI_AI_CATALOG_PANEL=off");
		return;
	}
	if (typeof ctx?.inject !== "function") return;
	ctx.inject(["webServer"], (scoped) => {
		const webServer = scoped.webServer;
		if (webServer === undefined || typeof webServer.register !== "function") return;
		scoped.effect(() => webServer.register({
			kind: "exact",
			path: PANEL_PATH,
			handler: (req, res) => {
				const json = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { ...json, allow: "GET, HEAD" });
					res.end(JSON.stringify({ error: "the panel route answers GET and HEAD only" }));
					return;
				}
				if (!panelRequestAllowed(req)) {
					res.writeHead(403, json);
					res.end(JSON.stringify({ error: "this deployment does not serve the panel route to that host" }));
					return;
				}
				/*
				 * A HEAD probe (a health check, `curl -I`, a link checker) is answered from
				 * the headers alone. Building the body first and discarding it meant a probe
				 * paid for a full matrix pass whenever the memo was cold, and — worse — was
				 * read as "the app is open", i.e. it could start a several-megabyte download.
				 * The length is omitted rather than computed: this route is read by its own
				 * client, which asks for the body.
				 */
				if (req.method === "HEAD") {
					res.writeHead(200, json);
					res.end();
					return;
				}
				let body;
				try {
					/* A card asks for its own route, so one page never ships every model to
					 * every card. A request naming no route answers the whole matrix; a request
					 * naming a route that is not configured answers an empty one rather than
					 * somebody else's models. */
					const wanted = new URL(req.url ?? "/", "http://localhost").searchParams.get("provider");
					body = panelBody(wanted === null ? undefined : wanted);
					/*
					 * Being asked for the data means the app is open — the cheapest
					 * "somebody is looking at this now" signal a plugin route gets. It only
					 * fires when the local copy is past OPEN_HOURS, and the in-flight guard
					 * collapses a page's several cards into one fetch.
					 */
					refreshIfDue(logger, "open");
				} catch (error) {
					res.writeHead(500, json);
					res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
					return;
				}
				res.writeHead(200, { ...json, "content-length": Buffer.byteLength(body) });
				res.end(body);
			}
		}), `dsh-model-metadata: ${PANEL_PATH}`);
		const scope = PANEL_HOSTS.length > 0 ? `hosts ${PANEL_HOSTS.join(", ")}` : "any host";
		logger?.info?.(`dsh-model-metadata: settings panel data served at ${PANEL_PATH} (namespace ${SETTINGS_NAMESPACE}, ${scope})`);
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
 *
 * The models.dev tier is not one tier but four, because the snapshot carries the
 * same name published by many providers and the numbers disagree: the model's own
 * vendor first (the `deepseek:*` rows for a `deepseek-*` name), then a row whose id
 * is exactly the bare name, then a mirror's aliased row, and last an endpoint that
 * does not look like a chat model at all. Ties inside a tier keep the file's own
 * order, so the answer is at least stable; without the tiers it was *only* the
 * file's order.
 *
 * The returned number is a tier, not a total: `rankCandidates` breaks ties by the
 * candidate's sequence, so a tier never has to leave room for the thousands of
 * candidates a full index holds.
 */
function rank(index, bare, candidate) {
	const preferred = preferredRoutes(bare).indexOf(candidate.route);
	if (preferred !== -1) return preferred;
	if (candidate.source === "first-party") return 500;
	if (candidate.source === "models.dev") {
		const vendor = preferredRoutes(bare).indexOf(String(candidate.provider ?? ""));
		if (vendor !== -1) return 3000 + vendor;
		if (candidate.nonChat === true) return 3300;
		return candidate.id === bare ? 3100 : 3200;
	}
	if (AGGREGATORS.includes(candidate.route)) return 2000 + Math.max(0, index.routeOrder.indexOf(candidate.route));
	const at = index.routeOrder.indexOf(candidate.route);
	return 1000 + (at === -1 ? 900 : at);
}

/**
 * Every candidate that can be read as this bare name, unranked and deduplicated.
 *
 * Exact spellings first (case-sensitive, then lowercased); then the normalized
 * tier over ids and display names, including one trailing decoration suffix the
 * configured name lacks. All the hits are merged into one list — ranking, not
 * which tier happened to hit, decides who wins.
 *
 * The two exact tiers overlap for every lowercase name (which is the normal
 * case), so the merge is deduplicated: without it every candidate was ranked
 * twice and the diagnostic list carried two rows per candidate.
 * @param index - the fallback index.
 * @param bare - the bare name of the model being resolved.
 * @returns the candidates, possibly empty.
 */
function candidatesFor(index, bare) {
	const found = new Set([...(index.byName.get(bare) ?? []), ...(index.byLower.get(bare.toLowerCase()) ?? [])]);
	for (const key of normalizedKeys(bare)) {
		for (const candidate of index.byNorm.get(key) ?? []) found.add(candidate);
	}
	return [...found];
}

/**
 * Rank a list of candidates, cheapest first.
 *
 * The rank is computed once per candidate rather than inside the comparator:
 * each rank runs the family patterns and two route lookups, and a comparator
 * calls it twice per comparison — for a name with 2500 same-family neighbours
 * that was thousands of pattern matches to sort the same list.
 * @param index - the fallback index.
 * @param bare - the bare name being resolved.
 * @param candidates - the candidates to order.
 * @returns a new, ordered array.
 */
function rankCandidates(index, bare, candidates) {
	return candidates
		.map((candidate) => ({ candidate, rank: rank(index, bare, candidate) }))
		.sort((left, right) => left.rank - right.rank || left.candidate.sequence - right.candidate.sequence)
		.map((entry) => entry.candidate);
}

/*
 * Match results, keyed by bare name and the index revision they were computed
 * against. Resolution runs for every model of every route on each listModels()
 * and each request cap, and the answer changes only when the index does — so the
 * cache is dropped wholesale when the revision moves rather than tracked per
 * entry. Entries are also answers for names nothing describes (the `undefined`
 * ones), which is the common case for a hand-declared model.
 */
let matchCache;

/**
 * The entry that names one model id, or undefined when nothing shares its name.
 * @param index - the fallback index to resolve against.
 * @param id - a configured model id, prefix included.
 * @returns the winning candidate, or undefined.
 */
function matchFor(index, id) {
	if (matchCache === undefined || matchCache.revision !== index.revision) matchCache = { revision: index.revision, matches: new Map() };
	const bare = bareName(id);
	if (matchCache.matches.has(bare)) return matchCache.matches.get(bare);
	const candidates = candidatesFor(index, bare);
	const winner = candidates.length === 0 ? undefined : rankCandidates(index, bare, candidates)[0];
	matchCache.matches.set(bare, winner);
	return winner;
}

/** The settings document that decides which fields were declared explicitly. */
function settingsPath() {
	const configured = process.env.DSH_PI_AI_SETTINGS_FILE;
	return configured !== undefined && configured.length > 0 ? configured : join(dshHome(), "settings.yaml");
}

/**
 * The parsed settings document and its change key, re-read whenever the file
 * changes (mtime *and* size, for filesystems with coarse timestamps).
 *
 * `readable` is the load-bearing half of the answer: it means "the declarations
 * in this document can be honored". It is false whenever the document cannot be
 * turned into one — no YAML parser anywhere this install can reach, no file at
 * the path, a permission problem, or a YAML syntax error while the user is
 * mid-edit. The plugin's one promise is that a declared field wins, and it cannot
 * keep that promise while the declarations are invisible: measured, a declared
 * `contextWindow: 64000` came back as the catalog's 272000 and a declared
 * `reasoningEfforts: false` as reasoning-capable. So an unreadable document
 * disables enrichment instead of guessing.
 *
 * An absent file is included in that rule even though it usually means "this home
 * has no llm-pi-ai routes, so nothing is declared" — DSH resolves the same
 * `<harness home>/settings.yaml` this plugin does. The exception is exactly the
 * case worth refusing: a path that is not the document DSH is reading (a
 * mis-set `DSH_PI_AI_SETTINGS_FILE`, a home the plugin guessed wrong) looks
 * identical from here, and borrowing over declarations that exist somewhere else
 * is the failure this rule exists to prevent. It is reported as an error; the
 * absence is not, because there is nothing wrong to report — the apply summary
 * carries the reason instead.
 * @returns the path, change key, the parsed document, whether it can be honored,
 *   and why not when it cannot.
 */
let settingsCache;
function settingsState() {
	const yaml = yamlLoad.exports;
	const path = settingsPath();
	if (yaml === undefined || typeof yaml.load !== "function") {
		/*
		 * The flat install's failure mode: the copy lives in DSH home and none of the
		 * install roots carries js-yaml. Reported from here rather than from apply() so
		 * the message also covers a build whose vendor tree resolved after apply() had
		 * already logged its summary.
		 */
		warnOnce(`dsh-model-metadata: no YAML parser could be loaded (js-yaml), so ${path} cannot be read; the fields declared there are unknown and no metadata is filled in, because a borrowed value could overwrite a declaration this plugin cannot see`);
		return { path, stamp: 0, size: 0, document: undefined, readable: false, reason: "no YAML parser is available (js-yaml could not be loaded)" };
	}
	let stats;
	try {
		stats = statSync(path);
	} catch {
		return { path, stamp: 0, size: 0, document: undefined, readable: false, reason: `no settings document at ${path}` };
	}
	if (settingsCache === undefined || settingsCache.path !== path || settingsCache.stamp !== stats.mtimeMs || settingsCache.size !== stats.size) {
		let document;
		let readable = true;
		let reason;
		try {
			document = yaml.load(readFileSync(path, "utf8"));
		} catch (error) {
			document = undefined;
			readable = false;
			reason = `cannot read ${path} (${error instanceof Error ? error.message : String(error)})`;
		}
		if (!readable) {
			warnOnce(`dsh-model-metadata: ${reason}; the fields declared there cannot be honored, so no metadata is filled in until it reads again`);
		}
		settingsCache = { path, stamp: stats.mtimeMs, size: stats.size, document, readable, reason };
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

/**
 * One route's declared model entries, keyed by id, built once per index.
 *
 * Resolution asks for this on every model of every route, and the answer was a
 * linear scan of the route's `models[]` each time: a route with m models against
 * n configured rows cost m×n comparisons for a fact that cannot change while the
 * settings document stands still. Built lazily per route and held on the index,
 * so it is dropped exactly when the index it describes is.
 * @param index - the fallback index.
 * @param provider - the route.
 * @returns the declared entries by model id.
 */
function declaredFor(index, provider) {
	const hit = index.declared.get(provider);
	if (hit !== undefined) return hit;
	const entries = index.settings.document?.["llm-pi-ai"]?.providers?.[provider]?.models;
	const byId = new Map();
	if (Array.isArray(entries)) {
		for (const entry of entries) {
			if (entry === null || typeof entry !== "object" || typeof entry.id !== "string") continue;
			/* The first row wins, matching what the settings layer itself resolves. */
			if (!byId.has(entry.id)) byId.set(entry.id, entry);
		}
	}
	index.declared.set(provider, byId);
	return byId;
}

/** The settings entry declaring one model, or undefined when it declares nothing. */
function declaredFields(index, provider, id) {
	return declaredFor(index, provider).get(id);
}

/** Whether the installed catalog already describes this exact route/model pair. */
function isCatalogued(index, provider, id) {
	return index.exact.has(`${provider}\u0000${id}`);
}

/**
 * One model descriptor with the matched metadata merged under the route's own fields.
 *
 * The index is passed in rather than looked up: it is what costs a `statSync`
 * pair (the snapshot file and the settings document), and every caller already
 * holds one — a whole `getModels` list, or a single `getModel`. Before this, one
 * model resolution probed the filesystem five times (two of them from
 * `isCatalogued` and `matchFor` each calling `fallbackIndex()`, one from the
 * declared-fields lookup).
 * @param model - the resolved pi-ai model descriptor.
 * @param provider - the route it belongs to.
 * @param index - the fallback index to resolve against.
 * @returns the same object when nothing matches, else a filled-in copy.
 */
function enrichModel(model, provider, index = fallbackIndex()) {
	if (!ENABLED || model === null || typeof model !== "object") return model;
	/*
	 * Fail closed when the declarations are invisible: borrowing a value here would
	 * overwrite a field the user pinned, and this plugin's promise is that a
	 * declaration wins. `settingsState()` decides what counts as invisible, and why
	 * an absent document does too.
	 */
	if (index.settings.readable === false) return model;
	const id = model.id;
	if (typeof id !== "string" || id.length === 0 || model[ENRICHED] === true) return model;
	if (isCatalogued(index, provider, id)) return model;
	const matched = matchFor(index, id);
	if (matched === undefined) return model;
	const declared = declaredFields(index, provider, id) ?? {};
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
	if (MATCH_REASONING && (!LEVEL_BUNDLED_ONLY || BUNDLED_SOURCES.includes(matched.source)) && declared.reasoningEfforts === undefined && matched.reasoning === true && model.reasoning !== true) {
		next.reasoning = true;
		if (matched.thinkingLevelMap !== undefined && matched.thinkingLevelMap !== null) next.thinkingLevelMap = { ...matched.thinkingLevelMap };
		changed = true;
	}
	/*
	 * `bundled` takes image support only from catalogs that ship with the
	 * product: the pi-ai catalog and the official DeepSeek route's own list.
	 */
	if (MATCH_INPUT && (!INPUT_BUNDLED_ONLY || BUNDLED_SOURCES.includes(matched.source)) && declared.input === undefined && Array.isArray(matched.input) && matched.input.length > 0) {
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
	const ranked = rankCandidates(index, bare, candidatesFor(index, bare));
	const view = (candidate) => ({
		route: candidate.route,
		source: candidate.source,
		contextWindow: candidate.contextWindow,
		maxTokens: candidate.maxTokens,
		input: candidate.input,
		reasoning: candidate.reasoning === true
	});
	/*
	 * Near neighbours for an unmatched name: entries whose normalized id starts
	 * with this name's family head, so the panel can say "the catalog knows these
	 * siblings" instead of a bare "no match". The head is the leading word
	 * (`doubao` out of `doubao-seedream-5-lite`); a head too short to be a name
	 * (`ms-` out of `ms-kimi-k3`) falls back to the next word (`kimi`), because a
	 * one- or two-letter prefix would drown the suggestion in noise.
	 *
	 * Bounded on purpose, and bounded *while* collecting. A generic head (`kimi`,
	 * `gemini`, `gpt`) matches hundreds of catalog rows, and gathering every one of them
	 * to show three was both the most expensive and the least useful part of a panel
	 * request. The buckets are what made it cheap (measured against a 3698-row snapshot,
	 * per unmatched model: 0.248 → 0.177 ms for a family with many rows, 0.195 → 0.036 ms
	 * for one with none) — and the pool stays wide on purpose, because the ranking needs
	 * room to prefer distinct models over one model's spellings: at forty candidates the
	 * hint line for `kimi-internal-9` came out as four spellings of K2.5 instead of the
	 * family's actual range. The scan still stops at `NEARBY_SCAN_CAP` candidates, so the
	 * collection is bounded by that and not by the family's size. One honest consequence:
	 * the pool is the first `NEARBY_SCAN_CAP` candidates in index order rather than every
	 * match, so a family whose best-known member sits further back may be represented by a
	 * sibling instead — acceptable for a hint line, and the reason the cap is the
	 * documented behaviour rather than an invisible one.
	 */
	const NEARBY_LIMIT = 5;
	const NEARBY_SCAN_CAP = 200;
	const nearby = ranked.length === 0 ? (() => {
		const words = bare.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);
		for (const head of [words[0], words[1]]) {
			if (head === undefined || head.length < MIN_NORMALIZED_LENGTH) continue;
			const prefix = normalizeName(head);
			const seen = new Set();
			const hits = [];
			/*
			 * A head shorter than the bucket width (a `a.b.c` spelling normalizes to three
			 * characters) has no single bucket, so it walks the index, exactly as this scan
			 * did before the buckets existed.
			 */
			const scoped = prefix.length >= NEARBY_PREFIX ? index.byPrefix.get(prefix.slice(0, NEARBY_PREFIX)) ?? [] : index.byNorm;
			scan: for (const [key, list] of scoped) {
				if (key === prefix || !key.startsWith(prefix)) continue;
				for (const candidate of list) {
					if (candidate.contextWindow === undefined) continue;
					const identity = `${candidate.bare}\u0000${candidate.route}`;
					if (seen.has(identity)) continue;
					seen.add(identity);
					hits.push(candidate);
					if (hits.length >= NEARBY_SCAN_CAP) break scan;
				}
			}
			if (hits.length === 0) continue;
			/*
			 * Five *distinct* models, best first. The same model is carried by many routes and
			 * in several spellings — a vendor's own row, an aggregator's namespaced id, a
			 * display name — and taking the first five ranked candidates spent slots on
			 * repeats (`kimi-k2-thinking, kimi-k2.5, moonshot.kimi-k2-thinking, …, Kimi-K2.5`).
			 * Uniqueness is judged by the plugin's own name rule, so `Kimi-K2.5` and
			 * `kimi-k2.5` count as one model while a mirror's namespaced id stays its own
			 * entry; the client used to be the only place that deduplicated, which let a row
			 * show three names it had taken from five candidates.
			 */
			const suggestions = [];
			const used = new Set();
			for (const candidate of rankCandidates(index, bare, hits)) {
				const name = normalizeName(candidate.bare);
				if (used.has(name)) continue;
				used.add(name);
				suggestions.push({ id: candidate.bare, route: candidate.route, source: candidate.source, contextWindow: candidate.contextWindow });
				if (suggestions.length >= NEARBY_LIMIT) break;
			}
			return suggestions;
		}
		return [];
	})() : undefined;
	return {
		id,
		bare,
		cataloguedUnder: index.routeOrder.filter((route) => index.exact.has(`${route}\u0000${id}`)),
		candidates: ranked.map(view),
		chosen: ranked.length === 0 ? undefined : view(ranked[0]),
		...nearby !== undefined && nearby.length > 0 ? { nearby } : {}
	};
}

/** Every level pi-ai knows, in escalation order (mirrors its own list). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** pi-ai's own level rule, when the package could be loaded. */
const piAiSupportedLevels = typeof levelsLoad.exports?.getSupportedThinkingLevels === "function" ? levelsLoad.exports.getSupportedThinkingLevels : undefined;

/**
 * The levels one model offers.
 *
 * pi-ai's own function answers this, so a future level (or a change to the
 * `xhigh`/`max` rule) is followed without a plugin update. The mirror below is
 * the fallback for a build whose package layout moved: a level mapped to `null`
 * is unsupported, the two extended levels need an explicit mapping, everything
 * else is supported unless pinned off.
 *
 * pi-ai reports `["off"]` for a model that does not reason; this function reports
 * nothing at all, which is what the caller means by "no levels to offer".
 * @param model - an enriched pi-ai model descriptor.
 * @returns the offered level ids, in escalation order.
 */
function supportedLevels(model) {
	if (model.reasoning !== true) return [];
	if (piAiSupportedLevels !== undefined) return piAiSupportedLevels(model);
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

/**
 * Wrap the class's resolution seam. Returns a short report for the log.
 *
 * A second load of this module (a hot reload, or two copies of the plugin) takes
 * the seam over instead of being turned away: the guard below used to answer
 * "already-installed" and leave the *first* copy's closures — and therefore the
 * first copy's switch values — in charge for the life of the process, while the
 * new copy's settings were silently ignored. The originals are kept on the
 * prototype so the wrapper can always be removed cleanly, which also releases the
 * old closures.
 * @param proto - the adapter prototype.
 * @param logger - optional sink for the one-line outcome.
 * @returns `{ status }` for the log line.
 */
function install(proto, logger) {
	const installed = Symbol.for("dsh-model-metadata/installed");
	const originals = Symbol.for("dsh-model-metadata/originals");
	if (typeof proto.current !== "function" || typeof proto.modelInfo !== "function") return { status: "unsupported" };
	let takenOver = false;
	if (proto[installed] !== undefined) {
		/* Restore first, so the wrapper being replaced cannot be re-entered. */
		const saved = proto[originals];
		if (saved !== undefined) {
			proto.current = saved.current;
			proto.modelInfo = saved.modelInfo;
		}
		takenOver = true;
	}
	const originalCurrent = proto.current;
	const originalInfo = proto.modelInfo;
	proto[originals] = { current: originalCurrent, modelInfo: originalInfo };
	proto[installed] = true;
	let enriched = 0;
	const announce = (provider, model) => {
		enriched++;
		if (enriched === 1) logger?.info?.(`dsh-model-metadata: first enrichment (${provider}/${model.id} -> context ${String(model.contextWindow)}, output ${String(model.maxTokens)}, reasoning ${model.reasoning === true ? "yes" : "no"})`);
	};
	const snapshots = new WeakMap();
	proto.current = function () {
		const snapshot = originalCurrent.call(this);
		const collection = snapshot?.models;
		if (collection === undefined || collection === null || typeof collection.getModel !== "function") {
			/*
			 * The shape this plugin reads is gone, so nothing below it can be filled in.
			 * It used to pass through in silence, which looks exactly like "no model
			 * needed anything" to whoever is reading the log after an upgrade.
			 */
			warnOnce("dsh-model-metadata: the adapter's current() no longer returns a model collection with getModel(); no metadata is being filled in (a DSH upgrade may have changed the seam)");
			return snapshot;
		}
		const hit = snapshots.get(snapshot);
		if (hit !== undefined) return hit;
		const wrap = (model, provider, index) => {
			if (model === undefined || model === null) return model;
			const next = enrichModel(model, provider, index);
			if (next !== model) announce(provider, next);
			return next;
		};
		const models = new Proxy(collection, {
			get(target, property) {
				if (property === "getModel") return (provider, id) => wrap(target.getModel(provider, id), provider, fallbackIndex());
				/*
				 * One probe for the whole list. The index is the part that touches the
				 * filesystem, and every model of a route resolves against the same one — so
				 * listing a route used to pay per model for what is a property of the call.
				 */
				if (property === "getModels") return (provider) => {
					const index = fallbackIndex();
					return (target.getModels(provider) ?? []).map((model) => wrap(model, provider, index));
				};
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
	 *
	 * What it can carry is narrower than the primary path, and deliberately so.
	 * The info payload has a place for the context window, for image support and
	 * for reasoning levels; it has none for an output cap — its `defaultMaxTokens`
	 * is the *configured* value the settings layer already resolved, not a slot a
	 * borrowed number can ride. So a build that needed this path reports a
	 * borrowed context window, image support and reasoning, and keeps its own
	 * output cap, which is exactly the split the primary path produces for those
	 * three fields.
	 */
	proto.modelInfo = function (snapshot, provider, model) {
		const info = originalInfo.apply(this, arguments);
		if (info === null || typeof info !== "object") return info;
		const resolved = snapshot?.models?.getModel?.(provider, model);
		const enrichedModel = resolved === undefined ? undefined : enrichModel(resolved, provider, fallbackIndex());
		if (enrichedModel === undefined || enrichedModel === null) return info;
		const next = { ...info };
		if (Number.isInteger(enrichedModel.contextWindow) && enrichedModel.contextWindow > 0 && info.context?.contextWindow !== enrichedModel.contextWindow) {
			next.context = { ...info.context, contextWindow: enrichedModel.contextWindow };
		}
		if (info.reasoning === undefined) {
			const reasoning = reasoningField(enrichedModel);
			if (reasoning !== undefined) next.reasoning = reasoning;
		}
		if (Array.isArray(enrichedModel.input) && enrichedModel.input.length > 0) {
			const current = Array.isArray(info.inputModalities) ? info.inputModalities : [];
			if (enrichedModel.input.length !== current.length || enrichedModel.input.some((modality) => !current.includes(modality))) {
				next.inputModalities = [...enrichedModel.input];
			}
		}
		return next;
	};
	return { status: takenOver ? "taken-over" : "installed" };
}

/**
 * Cordis plugin entry. Everything below the seam is plain data, so apply() only
 * wraps the class and reports what it found.
 * @param ctx - the plugin context (only the logger is used).
 */
export function apply(ctx) {
	const logger = ctx?.logger;
	/*
	 * Attached before anything is reported: switch complaints and anything the
	 * snapshot reader raised while this module was loading are held until now, and
	 * the warnings raised later (a resolution, a refresh) need somewhere to go.
	 */
	useLogger(logger);
	for (const complaint of complaints.splice(0)) logger?.warn?.(`dsh-model-metadata: ${complaint}`);
	if (!ENABLED) {
		logger?.info?.("dsh-model-metadata: disabled by DSH_PI_AI_CATALOG_FALLBACK=off");
		return;
	}
	/*
	 * Read once here so anything the snapshot itself has to say — a corrupt file,
	 * say — is on the log before the first resolution, rather than buried in
	 * whichever request happens to look first.
	 */
	const snapshot = snapshotState();
	if (adapterLoad.failure !== undefined) {
		logger?.warn?.(`dsh-model-metadata: cannot load the pi-ai adapter (${adapterLoad.failure}); no metadata will be filled in`);
		return;
	}
	/*
	 * The installed catalog is optional, and deliberately so. It is the richest
	 * source, but it is not the only one: the official route's own list and the
	 * models.dev snapshot answer on their own. Disabling the whole plugin because
	 * one of three sources could not be loaded is how a build whose catalog moved
	 * turned into "nothing works, and the log says why only if you read it".
	 */
	if (catalogLoad.failure !== undefined) {
		warnOnce(`dsh-model-metadata: cannot load the installed pi-ai catalog (${catalogLoad.failure}); models it alone describes will read as unmatched, and the models.dev snapshot plus the official route still answer`);
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
	const index = fallbackIndex();
	/*
	 * An unreadable settings document means no enrichment at all (see
	 * `settingsState()`), and that is the one state in which "installed" would be
	 * misleading on its own. The reason travels with it: for an unreadable document
	 * the warning above already said so, but "no settings document at <path>" is a
	 * state rather than an error and is reported only here.
	 */
	const held = index.settings.readable === false ? `, enrichment off (${index.settings.reason})` : "";
	logger?.info?.(`dsh-model-metadata: ${report.status} (mode ${MODE}${MATCH_REASONING ? `+levels:${LEVEL_MODE}` : ""}${MATCH_INPUT ? `+input:${INPUT_MODE}` : ""}, refresh ${REFRESH_HOURS > 0 ? `${String(REFRESH_HOURS)}h` : "off"} + on start ${START_MODE}${START_MODE === "always" ? ` (floor ${String(START_FLOOR_MINUTES)}m)` : ""} + on open ${OPEN_HOURS > 0 ? `${String(OPEN_HOURS)}h` : "off"} + daily check ${REFRESH_HOURS > 0 ? `${String(DAILY_CHECK_MS / 3600000)}h` : "off"}, panel ${PANEL_MODE}${PANEL_HOSTS.length > 0 ? ` (hosts ${String(PANEL_HOSTS.length)})` : ""}, adapter ${adapterLoad.from}, catalog ${catalogLoad.from ?? "unavailable"}, model names indexed ${String(index.byName.size)}, official deepseek catalog ${String(index.firstPartyCount)} models, snapshot entries ${String(snapshot.entries.length)}${held})`);
	scheduleRefresh(logger);
	scheduleDailyRefresh(ctx, logger);
	registerPanel(ctx, logger);
}
