#!/usr/bin/env node
/**
 * install-plugin.mjs — place the model-metadata plugin into the DSH home and
 * register it in a loader patch layer. Touches no vendor file: the plugin is a
 * normal cordis plugin row inserted through the documented `cordis.patch.yml`
 * mechanism.
 *
 *   node install-plugin.mjs --check        # what is installed, and the pre-flight
 *   node install-plugin.mjs --apply        # copy the plugin, add the row
 *   node install-plugin.mjs --uninstall    # remove the row (keeps the copied files)
 *   node install-plugin.mjs --purge        # --uninstall, and delete the copied files too
 *   node install-plugin.mjs --apply --profile web   # patch the profile layer instead
 *   node install-plugin.mjs --vision on|bundled|off # input modalities via a unit drop-in
 *   node install-plugin.mjs --help
 *
 * `--purge` on its own means "uninstall and delete": that is the promise the README
 * makes, so it selects the uninstall action instead of re-installing (which is what it
 * used to do, silently). Pairing it with a conflicting action is refused as a usage
 * error. Exit codes: 0 ok, 1 usage error, 2 the requested work did not succeed —
 * `--check` reports 2 when its pre-flight fails, and every value-taking flag is refused
 * when its value is missing rather than falling back to a default target.
 *
 * The `--vision` switch never edits the unit file itself: with --unit <name> it writes
 * a systemd drop-in at <unit-dir>/<unit>.d/dsh-model-metadata-input.conf (default
 * <home>/.config/systemd/user), so the unit you (or a panel) may rewrite stays pristine
 * and removal is one file. `--uninstall` and `--purge` remove that drop-in too: without
 * it, a mode override outlives the plugin it configured.
 * The plugin reads the variable at load, so a restart is what activates it.
 *
 * Layout it creates under the DSH home ($DSH_HOME, else the OS's own home + /.dsh):
 *   plugins/dsh-model-metadata/{index.mjs,package.json}   the plugin itself
 *   cordis.patch.yml                                        one inserted row
 *
 * The patch file is edited as text, so the user's comments and existing rows are
 * preserved. The row is delimited by a marker comment, which is what --uninstall
 * removes; a row left without its marker by an older run (or by hand) is recognized by
 * its shape, and a row that merely shares this package's id is left alone.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { FLAT_SOURCES, homePatchRow, installedManifest, layoutGaps } from "./packaging.mjs";
import { dshInstall } from "./dev-paths.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/*
 * The DSH home falls back to the OS's answer for this user, never to a relative `.dsh`
 * under the cwd: with HOME unset that fallback used to install into `./.dsh` and report
 * success, and the absolute-path check below refuses even an explicit relative home.
 */
const DSH_HOME = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), ".dsh");
const INSTALL = (() => {
	try {
		return dshInstall();
	} catch {
		/* The pre-flight check is skipped without it; the installer still works. */
		return undefined;
	}
})();

/*
 * The marker is deliberately NAME-FREE: it used to embed the package name, so
 * renaming the package orphaned the row — the installer then looked for a comment it
 * no longer had, reported "nothing registered", and left the old row in the patch
 * next to the new one (two rows for one plugin, which loads it twice). The historical
 * spellings are matched by shape so an install from before the rename still cleans up.
 */
const MARKER = "# dsh local model-metadata plugin: managed by install-plugin.mjs";
const ROW_HEADER = "# Applied over every profile layer; remove with install-plugin.mjs --uninstall.";
const LEGACY_MARKER = /^#\s*dsh-[a-z0-9-]+:\s*local model-metadata fallback plugin$/u;
const isMarker = (line) => line === MARKER || LEGACY_MARKER.test(line);
const ROW_ID = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).name;

const USAGE = [
	"Usage: node install-plugin.mjs [--check|--apply|--update|--uninstall|--purge] [options]",
	"",
	"  --check                 report what is installed, and run the pre-flight (exit 2 on failure)",
	"  --apply                 copy the plugin into the DSH home and register the row",
	"  --update                same as --apply",
	"  --uninstall             remove this installer's row; the copied files stay",
	"  --purge                 --uninstall, and delete the copied files and the snapshot too",
	"  --profile <name>        write the row into <home>/profiles/<name>/cordis.patch.yml",
	"  --home <path>           the DSH home to install into (default: $DSH_HOME, else the OS home + /.dsh);",
	"                          a relative path is refused",
	"  --install <path>        the DSH install the pre-flight composes against (default: discovered)",
	"  --vision on|bundled|off write (or, for `on`, remove) the unit drop-in; needs --unit",
	"  --unit <name>           the systemd unit whose drop-in --vision writes (default: $DSH_UNIT)",
	"  --unit-dir <path>       the systemd user-unit directory (default: the OS home + /.config/systemd/user)",
	"  --help                  print this"
].join("\n");

/**
 * Refuse to continue, with the reason and the usage summary.
 * @param message - why the run cannot proceed.
 */
function usage(message) {
	console.error(message);
	console.error(USAGE);
	process.exit(1);
}

/**
 * The value of a flag that takes one.
 *
 * Reading `argv[at + 1]` without looking at it left the option undefined when the value
 * was missing, and every default then applied: `--profile` with no value retargeted the
 * install to the home-level patch and reported success.
 * @param argv - the argument list.
 * @param at - the flag's index.
 * @param flag - the flag, for the message.
 * @returns the value.
 */
function valueOf(argv, at, flag) {
	const value = argv[at + 1];
	if (value === undefined || value.length === 0) usage(`${flag} needs a value`);
	if (value.startsWith("--")) usage(`${flag} needs a value; ${JSON.stringify(value)} is another flag`);
	return value;
}

/** The flags whose value is the next argument, mapped to the option each one sets. */
const VALUED = new Map([
	["--profile", "profile"],
	["--vision", "vision"],
	["--unit", "unit"],
	["--unit-dir", "unitDir"],
	["--home", "home"],
	["--install", "install"]
]);

/**
 * The run's options, refusing anything the installer cannot honour.
 * @param argv - the arguments after the script name.
 * @returns `{ action, purge, profile, vision, unit, unitDir, home, install }`.
 */
function parseArgs(argv) {
	const options = { action: undefined, purge: false, profile: undefined, vision: undefined, unit: process.env.DSH_UNIT };
	for (let at = 0; at < argv.length; at++) {
		const arg = argv[at];
		if (arg === "--help" || arg === "-h") {
			console.log(USAGE);
			process.exit(0);
		} else if (arg === "--check") options.action = "check";
		else if (arg === "--apply") options.action = "apply";
		else if (arg === "--update") options.action = "update";
		else if (arg === "--uninstall") options.action = "uninstall";
		else if (arg === "--purge") options.purge = true;
		else if (VALUED.has(arg)) options[VALUED.get(arg)] = valueOf(argv, at++, arg);
		else usage(`unknown argument: ${arg}`);
	}
	/* `--purge` is the README's own instruction for "remove it and its files", so alone it
	 * is an uninstall. Next to an explicit --apply/--check it is a contradiction: doing
	 * either half would destroy or write files the user did not ask about. */
	if (options.purge && options.action !== undefined && options.action !== "uninstall") usage(`--purge means "uninstall and delete", so it cannot be combined with --${options.action}`);
	if (options.purge) options.action = "uninstall";
	if (options.action === undefined) options.action = "apply";
	return options;
}

const options = parseArgs(process.argv.slice(2));
/* Not resolved: resolving a relative --home against the cwd is exactly how an install once
 * landed in `./.dsh` and reported success. */
const dshHome = options.home === undefined ? DSH_HOME : options.home;
if (!isAbsolute(dshHome)) usage(`the DSH home must be an absolute path, got ${JSON.stringify(dshHome)}`);
const install = options.install === undefined ? INSTALL : resolve(options.install);
if (options.profile !== undefined && [".", ".."].includes(options.profile)) usage(`--profile takes a profile name, not ${JSON.stringify(options.profile)}`);
if (options.profile !== undefined && /[/\\]/u.test(options.profile)) usage(`--profile takes a profile name, not a path: ${JSON.stringify(options.profile)}`);
const patchFile = options.profile === undefined ? join(dshHome, "cordis.patch.yml") : join(dshHome, "profiles", options.profile, "cordis.patch.yml");
const pluginSrc = join(HERE, "lib");
const pluginDst = join(dshHome, "plugins", "dsh-model-metadata");
/* Data lives in DSH home, where the plugin reads it and where an update to the plugin
 * cannot throw it away. A copy inside the plugin directory is the leftover of the build
 * that kept it there, and is folded back out on the next run. */
const snapshotDst = join(dshHome, "models-dev-snapshot.json");
const lodgedSnapshot = join(pluginDst, "models-dev-snapshot.json");

/** A YAML scalar for a value: bare when nothing in it needs quoting. */
function yamlScalar(value) {
	return /^[A-Za-z0-9_@./+-]+$/u.test(value) ? value : JSON.stringify(value);
}

/**
 * The patch rows this installer owns, as text.
 *
 * The id and the name come from `packaging.mjs` rather than from a second copy of the
 * layout written here, so the row this installer writes is the row the layout module (and
 * its tests) describe.
 * @returns the row text, marker first, so removal can name exactly what it removed.
 */
function rowText() {
	const row = homePatchRow(pluginDst, ROW_ID);
	return [
		MARKER,
		ROW_HEADER,
		"- insert:",
		`    - id: ${yamlScalar(row.id)}`,
		`      name: ${yamlScalar(row.name)}`,
		""
	].join("\n");
}

function readPatch() {
	if (!existsSync(patchFile)) return undefined;
	return readFileSync(patchFile, "utf8");
}

/** A scalar with its YAML quoting removed. */
function unquote(text) {
	const value = text.trim();
	const quoted = value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")));
	return quoted ? value.slice(1, -1) : value;
}

/**
 * The plain scalar a `key: value` line carries, in a top-level row or its children.
 * @param line - one line of a patch document.
 * @param key - the key to read.
 * @returns the unquoted value, or undefined when the line is not that key.
 */
function scalarOf(line, key) {
	const match = new RegExp(`^\\s*-?\\s*${key}:\\s*(.*?)\\s*$`, "u").exec(line);
	return match === null ? undefined : unquote(match[1]);
}

/** Every `id:` a patch document names, in document order. */
function rowIds(text) {
	return text.split("\n").map((line) => scalarOf(line, "id")).filter((id) => id !== undefined && id.length > 0);
}

/** The first `name:` a patch item carries, in document order. */
function itemName(text) {
	return text.split("\n").map((line) => scalarOf(line, "name")).find((value) => value !== undefined && value.length > 0);
}

/**
 * Whether a patch item is a row this installer wrote.
 *
 * The id alone is not ownership: a bundle-style row (`name: <package>`) for the same
 * package is a package manager's row, and deleting it would undo an install this script
 * never made. Ownership is our id on a path-shaped row, plus either a name pointing into
 * the flat directory this script owns or one of our markers — a home that moved between
 * runs still has to be cleanable, and the marker is the claim we wrote there ourselves.
 * @param item - one item of {@link patchItems}.
 * @param directory - the flat install directory.
 * @returns whether the item is ours.
 */
function isOwnedItem(item, directory) {
	if (!rowIds(item.body).includes(ROW_ID)) return false;
	const name = itemName(item.body);
	if (name === undefined || (!name.includes("/") && !name.includes("\\"))) return false;
	if (item.markerAt !== undefined) return true;
	const owned = resolve(directory);
	const target = resolve(name);
	return target === join(owned, "index.mjs") || target.startsWith(`${owned}${sep}`) || target.startsWith(`${owned}/`);
}

/**
 * A patch document's top-level list items, so a row is removed as a range.
 *
 * Removing "from the marker to the next `- ` line" is what left a row behind whenever a
 * blank line or a comment sat between the two — the run still reported success, and the
 * next --apply wrote a second row for the same id. The range of an item is what YAML
 * says it is: the line carrying the top-level dash, its children, nothing else.
 * @param text - the patch document.
 * @returns `{ lines, items }`, each item `{ start, end, markerAt, body }` where
 * `[start, end)` is the item and `markerAt` the index of a marker comment introducing it.
 */
function patchItems(text) {
	const lines = text.split("\n");
	const starts = [];
	for (let at = 0; at < lines.length; at++) if (/^-(?:\s|$)/u.test(lines[at])) starts.push(at);
	const items = starts.map((start, index) => {
		const next = index + 1 < starts.length ? starts[index + 1] : lines.length;
		/* An item is its own dash line plus its indented children; anything at column 0
		 * (a comment, the next item) is not part of it, so a trailing comment survives the
		 * removal of the row it happened to follow. */
		let end = start + 1;
		while (end < next && (lines[end].trim() === "" || /^\s/u.test(lines[end]))) end++;
		let markerAt;
		/* Only blank and comment lines may stand between a marker and its row; the first
		 * real line (the previous item's content) ends the search, so an earlier managed
		 * row's marker is never borrowed by this one. */
		for (let at = start - 1; at >= 0; at--) {
			const line = lines[at].trim();
			if (line.startsWith("#")) {
				if (isMarker(line)) markerAt = at;
				continue;
			}
			if (line === "") continue;
			break;
		}
		return { start, end, markerAt, body: lines.slice(start, end).join("\n") };
	});
	return { lines, items };
}

/**
 * Strip this installer's rows from a patch document, leaving every other row and comment
 * untouched.
 * @param text - the patch document.
 * @returns `{ text, rows, markers, names }`: the document without our rows, how many rows
 * were removed, how many stale marker comments were dropped, and the removed rows' names.
 */
function stripRows(text) {
	const { lines, items } = patchItems(text);
	const drop = new Set();
	const names = [];
	let rows = 0;
	let markers = 0;
	for (const item of items) {
		const owned = isOwnedItem(item, pluginDst);
		if (owned) {
			/* A marker announces the whole block: comments between it and the row are part
			 * of what it manages, so the block goes from the marker (or the row, when an
			 * older or hand-edited file has no marker) to the row's own last line. */
			for (let at = item.markerAt ?? item.start; at < item.end; at++) drop.add(at);
			rows++;
			names.push(itemName(item.body));
			continue;
		}
		if (item.markerAt !== undefined) {
			/* A marker with no row of ours under it (the row was hand-edited away, or the
			 * next row is someone else's): drop the marker, never a row we do not own. */
			for (let at = item.markerAt; at < item.start; at++) if (isMarker(lines[at].trim()) || lines[at].trim() === ROW_HEADER) drop.add(at);
			markers++;
		}
	}
	return { text: lines.filter((_, at) => !drop.has(at)).join("\n"), rows, markers, names };
}

/** An empty patch document reads as `[]` rather than as blank space. */
function normalizePatch(text) {
	const trimmed = text.replace(/\s+$/u, "");
	return trimmed.trim() === "[]" ? "" : trimmed;
}

/** A patch document holding exactly this installer's rows. */
function withRows(text) {
	const base = text === undefined || text.trim().length === 0 ? "[]\n" : text;
	const stripped = normalizePatch(stripRows(base).text);
	return `${stripped.length === 0 ? "" : `${stripped}\n`}${rowText()}`;
}

/**
 * Ask the real loader layer code whether our row actually lands in the composed layer.
 *
 * What this proves is the composed layer — that the document composes to exactly one row
 * for this id and, when that row names a file, that the file is there. A bare package
 * specifier is resolved by the loader, not by this check: existence-testing it reported
 * a legitimately registered bundle row as "a missing file".
 * @returns `{ ok }`, `{ failure }` or `{ skipped }`.
 */
async function preflight() {
	if (install === undefined) return { skipped: "no DSH install found; pass --install <the DSH install>" };
	const entry = join(install, "node_modules/@deepseek-ai/dsh-app-boot/lib/index.js");
	if (!existsSync(entry)) return { skipped: `no dsh-app-boot at ${entry}` };
	try {
		const { composeEntries } = await import(pathToFileURL(entry).href);
		const yamlPath = join(install, "node_modules/js-yaml/index.js");
		const yaml = await import(pathToFileURL(yamlPath).href);
		const rows = yaml.load(readFileSync(patchFile, "utf8")) ?? [];
		const composed = composeEntries([Array.isArray(rows) ? rows : []]);
		const found = composed.filter((row) => row?.id === ROW_ID);
		if (found.length !== 1) return { failure: `the composed layer holds ${String(found.length)} rows for id "${ROW_ID}", not 1` };
		const name = found[0].name;
		if (typeof name !== "string" || !(name.startsWith("/") || name.startsWith(".") || name.startsWith("file:"))) {
			return { ok: `the composed layer holds one row for ${ROW_ID} -> ${String(name)} (a package specifier the loader resolves; nothing to existence-check)` };
		}
		const file = name.startsWith("file:") ? fileURLToPath(name) : name;
		return existsSync(file)
			? { ok: `the composed layer holds one row for ${ROW_ID} -> ${file}` }
			: { failure: `the composed row points at a missing file: ${file}` };
	} catch (error) {
		return { failure: error instanceof Error ? error.message : String(error) };
	}
}

function report(icon, message) {
	console.log(`${icon} ${message}`);
}

/** The systemd drop-in directory the `--vision` override lives in. */
function dropInDir() {
	return join(options.unitDir === undefined ? join(homedir(), ".config", "systemd", "user") : resolve(options.unitDir), `${String(options.unit)}.d`);
}

function dropInFile() {
	return join(dropInDir(), "dsh-model-metadata-input.conf");
}

const VISION_MODES = ["off", "bundled", "on"];

/** The input-modality mode the unit drop-in currently asks for, if any. */
function visionState() {
	const file = dropInFile();
	if (!existsSync(file)) return undefined;
	return /Environment=DSH_PI_AI_CATALOG_FALLBACK_INPUT=([a-z]+)/u.exec(readFileSync(file, "utf8"))?.[1];
}

/**
 * Delete the drop-in file, and the drop-in directory once it holds nothing.
 * @returns whether a file was removed.
 */
function removeDropIn() {
	if (options.unit === undefined) {
		report("note", "no --unit/DSH_UNIT given, so no unit drop-in directory was named to clean");
		return false;
	}
	const file = dropInFile();
	if (!existsSync(file)) {
		report("no-op", "no input-modality drop-in to remove");
		return false;
	}
	rmSync(file, { force: true });
	report("ok  ", `removed ${file}`);
	try {
		rmdirSync(dropInDir());
		report("ok  ", `removed the now-empty ${dropInDir()}`);
	} catch {
		/* Something else lives in that drop-in directory; leave it alone. */
	}
	return true;
}

/**
 * Narrow (or restore) the input-modality mode. `on` is the plugin's own default,
 * so it removes the drop-in rather than pinning a value that could later drift
 * from the code; only `bundled` and `off` need a unit override.
 * @param mode - `on` removes the drop-in; `bundled`/`off` write it.
 * @returns whether anything changed.
 */
function setVision(mode) {
	if (options.unit === undefined) {
		console.error("--vision needs --unit <name> (or DSH_UNIT) so it knows which systemd drop-in directory to write");
		console.error(USAGE);
		process.exit(1);
	}
	if (!VISION_MODES.includes(mode)) {
		console.error(`--vision expects one of ${VISION_MODES.join("|")}`);
		console.error(USAGE);
		process.exit(1);
	}
	if (mode === "on") {
		report("note", "on is the plugin default; no unit override needed");
		return removeDropIn();
	}
	mkdirSync(dropInDir(), { recursive: true });
	writeFileSync(dropInFile(), `[Service]\nEnvironment=DSH_PI_AI_CATALOG_FALLBACK_INPUT=${mode}\n`);
	report("ok  ", `wrote ${dropInFile()} (DSH_PI_AI_CATALOG_FALLBACK_INPUT=${mode})`);
	return true;
}

/** Best-effort `systemctl --user daemon-reload`; returns a failure line, if any. */
function reloadUnits() {
	const reload = spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
	return reload.status === 0 ? undefined : (reload.stderr || reload.stdout || reload.error?.message || "systemctl unavailable").trim();
}

/** Apply a `--vision` mode and say whether the unit reload worked. */
function applyVision() {
	setVision(options.vision);
	const failure = reloadUnits();
	report(failure === undefined ? "ok  " : "note", failure === undefined ? "systemctl --user daemon-reload" : `daemon-reload: ${failure}`);
}

/** What the unit drop-in asks for, or that the plugin's own default is what applies. */
function visionReport() {
	if (options.unit === undefined) {
		report("ok  ", "input modalities (vision): plugin default (no --unit/DSH_UNIT names the drop-in to inspect)");
		return;
	}
	const mode = visionState();
	if (mode === undefined) report("ok  ", "input modalities (vision): plugin default, no unit override");
	else report("ok  ", `input modalities (vision): unit override "${mode}" via ${dropInFile()}`);
}

/** The module files the flat copy already holds (its top level: the copy is flat). */
function installedModules() {
	if (!existsSync(pluginDst)) return [];
	return readdirSync(pluginDst).filter((name) => /\.(?:mjs|js)$/u.test(name) && statSync(join(pluginDst, name), { throwIfNoEntry: false })?.isFile() === true);
}

/**
 * Delete module files the copy holds that this checkout no longer ships.
 *
 * A walk that only follows `FLAT_SOURCES` cannot see a file a previous layout left
 * behind, so a renamed or dropped source kept living in the installed directory.
 * @returns the names removed.
 */
function pruneStale() {
	const stale = installedModules().filter((name) => !FLAT_SOURCES.includes(name));
	for (const name of stale) rmSync(join(pluginDst, name), { force: true });
	return stale;
}

/**
 * What the installed copy holds versus what this checkout holds, per file.
 *
 * The manifest is compared as *rendered*, not as read: the installed one is generated
 * for the flat layout, so a byte comparison against package.json would always differ.
 * @returns one row per installed file, `same` / `changed` / `new` / `stray`.
 */
function drift() {
	const rows = [];
	for (const name of FLAT_SOURCES) {
		const source = join(pluginSrc, name);
		if (!existsSync(source)) continue;
		const target = join(pluginDst, name);
		if (!existsSync(target)) rows.push({ name, state: "new" });
		else rows.push({ name, state: readFileSync(source).equals(readFileSync(target)) ? "same" : "changed" });
	}
	const rendered = `${JSON.stringify(installedManifest(JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"))), undefined, 2)}\n`;
	const target = join(pluginDst, "package.json");
	rows.push({ name: "package.json", state: !existsSync(target) ? "new" : readFileSync(target, "utf8") === rendered ? "same" : "changed" });
	for (const name of installedModules()) if (!FLAT_SOURCES.includes(name)) rows.push({ name, state: "stray" });
	return rows;
}

/** The files whose change only a restart can pick up. */
const HOST_FILES = ["index.mjs", "panel.mjs", "names.mjs", "snapshot.mjs", "refresh-snapshot.mjs"];

/**
 * Whether this checkout can build a copy that works, said loudly when it cannot.
 * @returns whether the flat layout is complete.
 */
function layoutIsComplete() {
	const sources = Object.fromEntries(FLAT_SOURCES.map((name) => [name, existsSync(join(pluginSrc, name)) ? readFileSync(join(pluginSrc, name), "utf8") : undefined]));
	const gaps = layoutGaps(JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")), sources);
	for (const name of gaps.missing) report("FAIL", `packaging.mjs lists ${name}, but this checkout has no lib/${name}`);
	for (const gap of gaps.uncovered) report("FAIL", `lib/${gap.from} imports ${gap.specifier}, which packaging.mjs's FLAT_SOURCES does not list`);
	for (const name of gaps.unlisted) report("FAIL", `the installed manifest points at ${name}, which FLAT_SOURCES does not list`);
	return gaps.missing.length === 0 && gaps.uncovered.length === 0 && gaps.unlisted.length === 0;
}

/* Removal does not need a complete copy, but building one does: refusing here is what
 * stops a broken copy from being written silently. */
if (options.action !== "uninstall" && !layoutIsComplete()) {
	report("note", "fix packaging.mjs before installing: the copy would be missing a file it imports");
	process.exit(2);
}

if (options.action === "check") {
	let failed = false;
	report(existsSync(join(pluginDst, "index.mjs")) ? "ok  " : "MISS", `plugin files: ${pluginDst}`);
	if (existsSync(pluginDst)) {
		const rows = drift();
		const stale = rows.filter((row) => row.state !== "same");
		if (stale.length === 0) report("ok  ", "up to date with this checkout");
		else {
			for (const row of stale) report("note", `${row.name}: ${row.state}`);
			report("note", `${String(stale.length)} file(s) differ — run: node install-plugin.mjs --update`);
		}
	}
	report(existsSync(snapshotDst) ? "ok  " : "none", `models.dev snapshot: ${snapshotDst}`);
	if (existsSync(lodgedSnapshot)) report("note", `a copy is inside the plugin directory (${lodgedSnapshot}); --update folds it back out`);
	const text = readPatch();
	const ours = text === undefined ? [] : patchItems(text).items.filter((item) => isOwnedItem(item, pluginDst));
	const others = text === undefined ? 0 : rowIds(text).filter((id) => id === ROW_ID).length - ours.length;
	if (ours.length > 0) report("ok  ", `registered in ${patchFile} (this installer's row)`);
	else if (others > 0) report("note", `${String(others)} row(s) for ${ROW_ID} are in ${patchFile}, but none is this installer's; --uninstall leaves them alone`);
	else report("MISS", `registered in ${patchFile}`);
	visionReport();
	if (ours.length > 0 || others > 0) {
		const flight = await preflight();
		if (flight.ok !== undefined) report("ok  ", `pre-flight: ${flight.ok}`);
		else if (flight.skipped !== undefined) report("note", `pre-flight: skipped — ${flight.skipped}`);
		else {
			report("FAIL", `pre-flight: ${flight.failure}`);
			failed = true;
		}
	}
	if (options.vision !== undefined) {
		applyVision();
		report("note", "restart your dsh process to apply it");
	}
	process.exit(failed ? 2 : 0);
}

if (options.action === "uninstall") {
	const text = readPatch();
	if (text === undefined) {
		report("no-op", `nothing registered in ${patchFile}`);
	} else {
		const stripped = stripRows(text);
		if (stripped.rows > 0 || stripped.markers > 0) {
			const kept = normalizePatch(stripped.text);
			writeFileSync(patchFile, `${kept.length === 0 ? "[]" : kept}\n`);
			if (stripped.rows > 0) report("ok  ", `removed this installer's ${ROW_ID} row (${stripped.names.filter((name) => name !== undefined).join(", ")}) from ${patchFile}`);
			if (stripped.markers > 0) report("note", `removed ${String(stripped.markers)} stale marker comment(s) with no row of ours under them`);
		} else {
			report("no-op", `nothing this installer wrote in ${patchFile}`);
		}
	}
	/* The unit drop-in is state this installer wrote too: leaving it behind kept a mode
	 * override alive after the plugin it configured was gone. */
	if (removeDropIn()) {
		const failure = reloadUnits();
		report(failure === undefined ? "ok  " : "note", failure === undefined ? "systemctl --user daemon-reload" : `daemon-reload: ${failure}`);
	}
	/* A row that merely shares our id belongs to whoever wrote it: say so, so a leftover
	 * row is not mistaken for a failed uninstall. */
	const left = readPatch();
	const remaining = left === undefined ? 0 : rowIds(left).filter((id) => id === ROW_ID).length;
	if (remaining > 0) report("note", `${String(remaining)} row(s) for ${ROW_ID} are still in ${patchFile}, and none of them is this installer's (a bundle or hand-written row); remove it where it was added`);
	if (options.purge) {
		rmSync(pluginDst, { recursive: true, force: true });
		if (existsSync(snapshotDst)) rmSync(snapshotDst, { force: true });
		report("ok  ", `deleted ${pluginDst} and ${snapshotDst}`);
	}
	report("note", "restart your dsh process for the change to take effect");
	process.exit(0);
}

/*
 * The patch document is composed and checked before the first write: a refusal must not
 * leave a half-install behind, and a document that would hold two rows for our id loads
 * the plugin twice — the exact failure the marker was introduced to prevent.
 */
const nextPatch = withRows(readPatch());
const duplicates = rowIds(nextPatch).filter((id) => id === ROW_ID).length;
if (duplicates > 1) {
	report("FAIL", `${patchFile} would hold ${String(duplicates)} rows for id "${ROW_ID}", so the loader would mount the plugin that many times`);
	report("note", `only one of them is this installer's; remove the other where it was added (a bundle install is removed with its package manager) and retry`);
	process.exit(2);
}

/*
 * Every write below lands outside the workspace, so a sandbox or permission
 * refusal must read as a clear failure instead of a stack trace.
 */
/* Hoisted: the closing note below reads what this run found, after the try closes. */
let before = [];
try {
	before = existsSync(pluginDst) ? drift() : [];
	/* Create every directory this run writes into before the first copy: a --profile whose
	 * directory did not exist yet used to fail after the files were already in place, with
	 * an error naming the directory that had just been written successfully. */
	mkdirSync(join(dshHome, "plugins"), { recursive: true });
	mkdirSync(pluginDst, { recursive: true });
	mkdirSync(dirname(patchFile), { recursive: true });
	const pruned = pruneStale();
	if (pruned.length > 0) report("note", `removed ${String(pruned.length)} file(s) this checkout no longer ships: ${pruned.join(", ")}`);
/*
 * Copy the package's sources flat, then write the manifest that layout needs: the
 * package's own `exports` point into `lib/`, which does not exist here, so copying it
 * verbatim would leave the client module system unable to find `./client`.
 */
const manifest = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const pluginFiles = FLAT_SOURCES.filter((name) => existsSync(join(pluginSrc, name)));
for (const file of pluginFiles) copyFileSync(join(pluginSrc, file), join(pluginDst, file));
writeFileSync(join(pluginDst, "package.json"), `${JSON.stringify(installedManifest(manifest), undefined, 2)}\n`);
report("ok  ", `copied plugin -> ${pluginDst} (${[...pluginFiles, "package.json"].join(", ")})`);
/*
 * The repository ships no snapshot: models.dev data is fetched by the plugin itself (at
 * start, on opening the app, or daily). What this step does is housekeeping — a copy that
 * a previous version kept inside the plugin directory is moved back to DSH home, so
 * nobody has to wait for a re-download. A file already there is never overwritten by a
 * staler one.
 */
const sizeOf = (file) => (existsSync(file) ? `${String(Math.round(statSync(file).size / 1024))} KiB` : "none");
if (existsSync(lodgedSnapshot) && (!existsSync(snapshotDst) || statSync(lodgedSnapshot).mtimeMs > statSync(snapshotDst).mtimeMs)) {
	renameSync(lodgedSnapshot, snapshotDst);
	report("ok  ", `moved the models.dev snapshot back to DSH home (${sizeOf(snapshotDst)}) -> ${snapshotDst}`);
} else if (existsSync(lodgedSnapshot)) {
	rmSync(lodgedSnapshot, { force: true });
	report("ok  ", `removed the copy inside the plugin directory; keeping ${snapshotDst} (${sizeOf(snapshotDst)})`);
} else if (existsSync(snapshotDst)) {
	report("ok  ", `models.dev snapshot kept as is (${sizeOf(snapshotDst)}) -> ${snapshotDst}`);
} else {
	report("note", `no snapshot yet; the plugin downloads one on the next start (or run node lib/refresh-snapshot.mjs)`);
}
writeFileSync(patchFile, nextPatch);
report("ok  ", `registered ${ROW_ID} in ${patchFile}`);
if (options.vision !== undefined) applyVision();
visionReport();
} catch (error) {
	/* Name the path that actually failed: the copy may have succeeded and the patch write,
	 * in a directory of its own, may be the one that could not be created. */
	const failed = error?.path;
	report("FAIL", `cannot write ${typeof failed === "string" && failed.length > 0 ? failed : dshHome}: ${error instanceof Error ? error.message : String(error)}`);
	report("note", "run this under a sandbox that may write outside the workspace, then retry");
	process.exit(2);
}
const flight = await preflight();
report(flight.ok === undefined ? "FAIL" : "ok  ", `pre-flight: ${flight.ok ?? flight.failure ?? flight.skipped}`);
/*
 * The reload boundary, said precisely: the browser half is served per page load, so a
 * refresh is enough for it; the host half is an instance the process loaded at start.
 */
const changed = before.filter((row) => row.state !== "same" && row.state !== "stray").map((row) => row.name);
if (before.length > 0) {
	for (const row of before) report(row.state === "same" ? "ok  " : row.state === "stray" ? "DEL " : "CHG ", `${row.name}: ${row.state}`);
	const hostTouched = changed.some((name) => HOST_FILES.includes(name));
	if (changed.length === 0) report("note", "already up to date with this checkout; nothing was rewritten");
	else if (!hostTouched) report("note", "only the browser half changed: reload the page and you are done — no restart needed");
	else report("note", "the host half changed: restart your dsh process to load it");
} else {
	report("note", "restart your dsh process to load the plugin");
}
report("note", "self-check after restart: look for dsh-model-metadata in dsh's own log (systemd: journalctl --user -u <unit>)");
if (flight.ok === undefined) process.exit(2);
