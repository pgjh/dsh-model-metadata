#!/usr/bin/env node
/**
 * install-plugin.mjs — place the model-metadata plugin into the DSH home and
 * register it in a loader patch layer. Touches no vendor file: the plugin is a
 * normal cordis plugin row inserted through the documented `cordis.patch.yml`
 * mechanism.
 *
 *   node install-plugin.mjs --check        # what is installed, and the pre-flight
 *   node install-plugin.mjs --apply        # copy the plugin + snapshot, add the row
 *   node install-plugin.mjs --uninstall    # remove the row (keeps the copied files)
 *   node install-plugin.mjs --apply --profile web   # patch the profile layer instead
 *   node install-plugin.mjs --apply --purge         # with --uninstall: also delete files
 *   node install-plugin.mjs --vision on|bundled|off # input modalities via a unit drop-in
 *
 * The `--vision` switch never edits the unit file itself: with --unit <name> it writes
 * a systemd drop-in at ~/.config/systemd/user/<unit>.d/dsh-model-metadata-input.conf, so
 * the unit you (or a panel) may rewrite stays pristine and removal is one file.
 * The plugin reads the variable at load, so a restart is what activates it.
 *
 * Layout it creates under $DSH_HOME (default ~/.dsh):
 *   plugins/dsh-model-metadata/{index.mjs,package.json}   the plugin itself
 *   cordis.patch.yml                                        one inserted row
 *
 * The patch file is edited as text, so the user's comments and existing rows are
 * preserved. The row is delimited by a marker comment, which is what --uninstall
 * removes.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { FLAT_SOURCES, installedManifest } from "./packaging.mjs";
import { dshInstall } from "./dev-paths.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME ?? "";
const DSH_HOME = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(HOME, ".dsh");
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
const LEGACY_MARKER = /^#\s*dsh-[a-z0-9-]+:\s*local model-metadata fallback plugin$/u;
const isMarker = (line) => line === MARKER || LEGACY_MARKER.test(line);
const ROW_ID = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).name;

function parseArgs(argv) {
	const options = { action: "apply", profile: undefined, purge: false, vision: undefined, unit: process.env.DSH_UNIT };
	for (let at = 0; at < argv.length; at++) {
		const arg = argv[at];
		if (arg === "--check") options.action = "check";
		else if (arg === "--apply") options.action = "apply";
		else if (arg === "--update") options.action = "update";
		else if (arg === "--uninstall") options.action = "uninstall";
		else if (arg === "--purge") options.purge = true;
		else if (arg === "--profile") options.profile = argv[++at];
		else if (arg === "--vision") options.vision = argv[++at];
		else if (arg === "--unit") options.unit = argv[++at];
		else if (arg === "--unit-dir") options.unitDir = argv[++at];
		else if (arg === "--home") options.home = argv[++at];
		else if (arg === "--install") options.install = argv[++at];
		else {
			console.error(`unknown argument: ${arg}`);
			process.exit(1);
		}
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));
const dshHome = options.home === undefined ? DSH_HOME : resolve(options.home);
const install = options.install === undefined ? INSTALL : resolve(options.install);
const patchFile = options.profile === undefined ? join(dshHome, "cordis.patch.yml") : join(dshHome, "profiles", options.profile, "cordis.patch.yml");
const pluginSrc = join(HERE, "lib");
const pluginDst = join(dshHome, "plugins", "dsh-model-metadata");
/* Data lives in DSH home, where the plugin reads it and where an update to the plugin
 * cannot throw it away. A copy inside the plugin directory is the leftover of the build
 * that kept it there, and is folded back out on the next run. */
const snapshotDst = join(dshHome, "models-dev-snapshot.json");
const lodgedSnapshot = join(pluginDst, "models-dev-snapshot.json");

/** The patch rows this installer owns, as text (marker first, so removal is exact). */
function rowText() {
	return [
		MARKER,
		"# Applied over every profile layer; remove with install-plugin.mjs --uninstall.",
		"- insert:",
		`    - id: ${ROW_ID}`,
		`      name: ${join(pluginDst, "index.mjs")}`,
		""
	].join("\n");
}

function readPatch() {
	if (!existsSync(patchFile)) return undefined;
	return readFileSync(patchFile, "utf8");
}

function isRegistered(text) {
	return text !== undefined && (text.includes(MARKER) || LEGACY_MARKER.test(text) || new RegExp(`id:\\s*${ROW_ID}\\b`, "u").test(text));
}

/**
 * Strip this installer's rows from a patch document, leaving every other row and
 * every comment untouched. The block is: the marker line, its header comments,
 * the `- insert:` row, that row's indented children, and one blank line — so the
 * scan is structural rather than "delete to the end of file".
 * @param text - the patch document.
 * @returns the document without this installer's rows.
 */
function stripRows(text) {
	const lines = text.split("\n");
	const kept = [];
	for (let at = 0; at < lines.length; at++) {
		if (!isMarker(lines[at].trim())) {
			kept.push(lines[at]);
			continue;
		}
		at++;
		while (at < lines.length && lines[at].trim().startsWith("#")) at++;
		if (at < lines.length && /^- /.test(lines[at])) {
			at++;
			while (at < lines.length && /^\s/.test(lines[at])) at++;
		}
		if (at < lines.length && lines[at].trim() === "") at++;
		at--;
	}
	return kept.join("\n");
}

/** A patch document holding exactly this installer's rows. */
function withRows(text) {
	const base = text === undefined || text.trim().length === 0 ? "[]\n" : text;
	const stripped = normalizePatch(stripRows(base));
	return `${stripped.length === 0 ? "" : `${stripped}\n`}${rowText()}`;
}

/** An empty patch document reads as `[]` rather than as blank space. */
function normalizePatch(text) {
	const trimmed = text.replace(/\s+$/u, "");
	return trimmed.trim() === "[]" ? "" : trimmed;
}

/** Ask the real loader layer code whether our row actually lands in the tree. */
async function preflight() {
	const entry = join(install, "node_modules/@deepseek-ai/dsh-app-boot/lib/index.js");
	if (!existsSync(entry)) return { skipped: `no dsh-app-boot at ${entry}` };
	try {
		const { composeEntries } = await import(pathToFileURL(entry).href);
		const yamlPath = join(install, "node_modules/js-yaml/index.js");
		const yaml = await import(pathToFileURL(yamlPath).href);
		const rows = yaml.load(readFileSync(patchFile, "utf8")) ?? [];
		const composed = composeEntries([Array.isArray(rows) ? rows : []]);
		const found = composed.filter((row) => row?.id === ROW_ID);
		if (found.length !== 1) return { failure: `composeEntries produced ${String(found.length)} rows for id "${ROW_ID}"` };
		const name = found[0].name;
		return existsSync(name.startsWith("file:") ? new URL(name) : name)
			? { ok: `loader tree contains ${ROW_ID} -> ${name}` }
			: { failure: `the composed row points at a missing file: ${String(name)}` };
	} catch (error) {
		return { failure: error instanceof Error ? error.message : String(error) };
	}
}

function report(icon, message) {
	console.log(`${icon} ${message}`);
}

const dropInDir = join(options.unitDir === undefined ? join(HOME, ".config", "systemd", "user") : resolve(options.unitDir), `${String(options.unit)}.d`);
const dropInFile = join(dropInDir, "dsh-model-metadata-input.conf");
const VISION_MODES = ["off", "bundled", "on"];

/** The input-modality mode the unit drop-in currently asks for, if any. */
function visionState() {
	if (!existsSync(dropInFile)) return undefined;
	return /Environment=DSH_PI_AI_CATALOG_FALLBACK_INPUT=([a-z]+)/u.exec(readFileSync(dropInFile, "utf8"))?.[1];
}

/** Delete the drop-in file, and the drop-in directory once it holds nothing. */
function removeDropIn() {
	if (!existsSync(dropInFile)) {
		report("no-op", "no input-modality drop-in to remove");
		return false;
	}
	rmSync(dropInFile, { force: true });
	report("ok  ", `removed ${dropInFile}`);
	try {
		rmdirSync(dropInDir);
		report("ok  ", `removed the now-empty ${dropInDir}`);
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
		process.exit(1);
	}
	if (!VISION_MODES.includes(mode)) {
		console.error(`--vision expects one of ${VISION_MODES.join("|")}`);
		process.exit(1);
	}
	if (mode === "on") {
		report("note", "on is the plugin default; no unit override needed");
		return removeDropIn();
	}
	mkdirSync(dropInDir, { recursive: true });
	writeFileSync(dropInFile, `[Service]\nEnvironment=DSH_PI_AI_CATALOG_FALLBACK_INPUT=${mode}\n`);
	report("ok  ", `wrote ${dropInFile} (DSH_PI_AI_CATALOG_FALLBACK_INPUT=${mode})`);
	return true;
}

/** Best-effort `systemctl --user daemon-reload`; returns a failure line, if any. */
function reloadUnits() {
	const reload = spawnSync("systemctl", ["--user", "daemon-reload"], { encoding: "utf8" });
	return reload.status === 0 ? undefined : (reload.stderr || reload.stdout || reload.error?.message || "systemctl unavailable").trim();
}

function visionReport() {
	const mode = visionState();
	if (mode === undefined) report("ok  ", "input modalities (vision): plugin default, no unit override");
	else report("ok  ", `input modalities (vision): unit override "${mode}" via ${dropInFile}`);
}

/**
 * What the installed copy holds versus what this checkout holds, per file.
 *
 * The manifest is compared as *rendered*, not as read: the installed one is generated
 * for the flat layout, so a byte comparison against package.json would always differ.
 * @returns one row per installed file, `same` / `changed` / `new`.
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
	return rows;
}

/** The files whose change only a restart can pick up. */
const HOST_FILES = ["index.mjs", "panel.mjs", "snapshot.mjs", "refresh-snapshot.mjs"];

if (options.action === "check") {
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
	report(isRegistered(readPatch()) ? "ok  " : "MISS", `registered in ${patchFile}`);
	visionReport();
	if (isRegistered(readPatch())) {
		const flight = await preflight();
		if (flight.ok !== undefined) report("ok  ", `pre-flight: ${flight.ok}`);
		else report("FAIL", `pre-flight: ${flight.failure ?? flight.skipped}`);
	}
	if (options.vision !== undefined) {
		setVision(options.vision);
		const failure = reloadUnits();
		report(failure === undefined ? "ok  " : "note", failure === undefined ? "systemctl --user daemon-reload" : `daemon-reload: ${failure}`);
		report("note", "restart your dsh process to apply it");
	}
	process.exit(0);
}

if (options.action === "uninstall") {
	const text = readPatch();
	if (text === undefined || !isRegistered(text)) {
		report("no-op", `nothing registered in ${patchFile}`);
	} else {
		const stripped = normalizePatch(stripRows(text));
		writeFileSync(patchFile, `${stripped.length === 0 ? "[]" : stripped}\n`);
		report("ok  ", `removed the ${ROW_ID} row from ${patchFile}`);
	}
	if (options.purge) {
		rmSync(pluginDst, { recursive: true, force: true });
		if (existsSync(snapshotDst)) rmSync(snapshotDst, { force: true });
		report("ok  ", `deleted ${pluginDst} and ${snapshotDst}`);
	}
	report("note", "restart your dsh process for the change to take effect");
	process.exit(0);
}

/*
 * Every write below lands outside the workspace, so a sandbox or permission
 * refusal must read as a clear failure instead of a stack trace.
 */
/* Hoisted: the closing note below reads what this run found, after the try closes. */
let before = [];
try {
	before = existsSync(pluginDst) ? drift() : [];
	mkdirSync(join(dshHome, "plugins"), { recursive: true });
	mkdirSync(pluginDst, { recursive: true });
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
writeFileSync(patchFile, withRows(readPatch()));
report("ok  ", `registered ${ROW_ID} in ${patchFile}`);
if (options.vision !== undefined) {
	setVision(options.vision);
	const failure = reloadUnits();
	report(failure === undefined ? "ok  " : "note", failure === undefined ? "systemctl --user daemon-reload" : `daemon-reload: ${failure}`);
}
visionReport();
} catch (error) {
	report("FAIL", `cannot write ${pluginDst}: ${error instanceof Error ? error.message : String(error)}`);
	report("note", "run this under a sandbox that may write outside the workspace, then retry");
	process.exit(2);
}
const flight = await preflight();
report(flight.ok === undefined ? "FAIL" : "ok  ", `pre-flight: ${flight.ok ?? flight.failure ?? flight.skipped}`);
/*
 * The reload boundary, said precisely: the browser half is served per page load, so a
 * refresh is enough for it; the host half is an instance the process loaded at start.
 */
const changed = before.filter((row) => row.state !== "same").map((row) => row.name);
if (before.length > 0) {
	for (const row of before) report(row.state === "same" ? "ok  " : "CHG ", `${row.name}: ${row.state}`);
	const hostTouched = changed.some((name) => HOST_FILES.includes(name));
	if (changed.length === 0) report("note", "already up to date with this checkout; nothing was rewritten");
	else if (!hostTouched) report("note", "only the browser half changed: reload the page and you are done — no restart needed");
	else report("note", "the host half changed: restart your dsh process to load it");
} else {
	report("note", "restart your dsh process to load the plugin");
}
report("note", "self-check after restart: look for dsh-model-metadata in dsh's own log (systemd: journalctl --user -u <unit>)");
if (flight.ok === undefined) process.exit(2);
