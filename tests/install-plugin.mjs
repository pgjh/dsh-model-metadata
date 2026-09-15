#!/usr/bin/env node
/**
 * install-plugin.mjs (test) — the copy installer, driven as a child process.
 *
 * Every child runs against a synthetic DSH home under the system temp directory, so the
 * suite is incapable of touching a real home: `--home` and `--unit-dir` are always passed,
 * and the child's PATH holds only the directory of the running Node, so the
 * `systemctl --user daemon-reload` the installer performs cannot reach the user's units
 * (the installer already reports a failed reload as a note).
 *
 * The pre-flight is exercised through a synthetic DSH install holding the two modules it
 * imports: the exit codes under test are the installer's, not a YAML parser's, and the
 * suite must not need a real DSH install to run. When one is found, the same check is
 * repeated against the real loader as a cross-check.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dshInstall } from "../dev-paths.mjs";
import { FLAT_SOURCES, homePatchRow, installedManifest, layoutGaps, relativeImports } from "../packaging.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const INSTALLER = join(ROOT, "install-plugin.mjs");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const ID = MANIFEST.name;
/* The on-disk contract, pinned here on purpose: a test that imported the installer's own
 * constant could not tell whether the marker it writes is still the one on disk. */
const MARKER = "# dsh local model-metadata plugin: managed by install-plugin.mjs";
const ROW_HEADER = "# Applied over every profile layer; remove with install-plugin.mjs --uninstall.";
const UNIT = "probe-unit";

const failures = [];
let checks = 0;
function expect(label, actual, wanted) {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) failures.push(`${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
}

/** How many times a literal appears in a text. */
const occurrences = (text, needle) => text.split(needle).length - 1;

const WORK = mkdtempSync(join(tmpdir(), "dsh-install-plugin-"));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));

const home = join(WORK, "home");
const units = join(WORK, "systemd");
const fixtureInstall = join(WORK, "install");
const patchFile = join(home, "cordis.patch.yml");
const pluginDst = join(home, "plugins", ID);
const snapshotDst = join(home, "models-dev-snapshot.json");
const dropInFile = join(units, `${UNIT}.d`, "dsh-model-metadata-input.conf");
/** The row this installer writes for the synthetic home. */
const rowName = homePatchRow(pluginDst, ID).name;

/*
 * Every child's HOME also points inside the work directory, so even a run that names no
 * `--home` can only ever reach a synthetic home: no test here can touch a real one, which
 * is what an audit run of the installer once did.
 */
const childEnv = { ...process.env, PATH: dirname(process.execPath), HOME: join(WORK, "user-home") };
delete childEnv.DSH_UNIT;
delete childEnv.DSH_HOME;
delete childEnv.DSH_INSTALL;

/**
 * Run the installer once.
 * @param args - its arguments.
 * @param options - `{ cwd, env, probe }`; `probe` marks the runs that must fail before
 * they touch a home (usage errors), which are the only ones allowed to name none.
 * @returns `{ status, output, stdout }`.
 */
function run(args, options = {}) {
	if (options.probe !== true && !args.includes("--home")) throw new Error(`run() must name --home (or be a probe): ${args.join(" ")}`);
	const result = spawnSync(process.execPath, [INSTALLER, ...args], {
		encoding: "utf8",
		cwd: options.cwd ?? ROOT,
		env: options.env ?? childEnv,
		timeout: 120_000
	});
	const output = `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`;
	return { status: result.status, output, stdout: String(result.stdout ?? "") };
}

/** The synthetic home's patch document, empty when there is none. */
function readPatch() {
	return existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
}

/** Seed the synthetic home's patch document. */
function writePatch(text) {
	mkdirSync(home, { recursive: true });
	writeFileSync(patchFile, text);
}

/** The arguments that keep a run inside the synthetic home, fixture install and unit. */
function args(extra = []) {
	return [...extra, "--home", home, "--install", fixtureInstall, "--unit", UNIT, "--unit-dir", units];
}

/*
 * The fixture install: the composed layer, and a reader for the documents this installer
 * writes. Only the shape the installer uses is understood — a row item, its `insert`
 * children, or a bare row — which is all the pre-flight check needs to see.
 */
const YAML_FIXTURE = `/*
 * A stand-in for the loader's YAML reader, written for this fixture alone.
 */
export function load(text) {
	const rows = [];
	let item = null;
	let child = null;
	const unquote = (value) => {
		const first = value.slice(0, 1);
		const last = value.slice(-1);
		return value.length >= 2 && first === last && (first === '"' || first === "'") ? value.slice(1, -1) : value;
	};
	for (const raw of text.split("\\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line === "[]") continue;
		const indent = raw.length - raw.trimStart().length;
		const starts = line.startsWith("- ");
		const body = starts ? line.slice(2).trim() : line;
		const colon = body.indexOf(":");
		if (colon <= 0) continue;
		const key = body.slice(0, colon).trim();
		const value = unquote(body.slice(colon + 1).trim());
		if (starts && indent === 0 && key === "insert") {
			item = { insert: [] };
			rows.push(item);
			child = null;
			continue;
		}
		if (starts && indent === 0) {
			item = { [key]: value };
			rows.push(item);
			child = null;
			continue;
		}
		if (starts && item !== null && Array.isArray(item.insert)) {
			child = { [key]: value };
			item.insert.push(child);
			continue;
		}
		if (child !== null) child[key] = value;
		else if (item !== null) item[key] = value;
	}
	return rows;
}
`;

mkdirSync(join(fixtureInstall, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib"), { recursive: true });
mkdirSync(join(fixtureInstall, "node_modules", "js-yaml"), { recursive: true });
writeFileSync(join(fixtureInstall, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js"), [
	"/* The composed layer, the one step the pre-flight check asks the real loader for. */",
	"export function composeEntries(layers) {",
	"\treturn layers.flat().flatMap((entry) => entry.insert ?? [entry]);",
	"}",
	""
].join("\n"));
writeFileSync(join(fixtureInstall, "node_modules", "js-yaml", "index.js"), YAML_FIXTURE);

/* 0. The layout the installer and this suite both read. */
const sources = Object.fromEntries(FLAT_SOURCES.map((name) => [name, existsSync(join(ROOT, "lib", name)) ? readFileSync(join(ROOT, "lib", name), "utf8") : undefined]));
expect("packaging: the checkout's flat layout is complete", layoutGaps(MANIFEST, sources), { missing: [], uncovered: [], unlisted: [] });
expect("packaging: FLAT_SOURCES covers every relative import of index.mjs", relativeImports(sources["index.mjs"]).map((specifier) => specifier.replace(/^\.\//u, "")).every((name) => FLAT_SOURCES.includes(name)), true);
expect("packaging: FLAT_SOURCES covers every relative import of refresh-snapshot.mjs", relativeImports(sources["refresh-snapshot.mjs"]).map((specifier) => specifier.replace(/^\.\//u, "")).every((name) => FLAT_SOURCES.includes(name)), true);
expect("packaging: an import that is not listed is reported", layoutGaps(MANIFEST, { ...sources, "index.mjs": "import { probe } from \"./stray.mjs\";\n" }).uncovered, [{ from: "index.mjs", specifier: "./stray.mjs" }]);
expect("packaging: a listed file the checkout lacks is reported", layoutGaps(MANIFEST, { ...sources, "panel.mjs": undefined }).missing, ["panel.mjs"]);

/* 1. Help and usage. */
const help = run(["--help"], { probe: true });
expect("--help exits 0", help.status, 0);
expect("--help documents --purge", help.stdout.includes("--purge"), true);
expect("--help documents --home", help.stdout.includes("--home"), true);
expect("an unknown argument is a usage error", run(["--probe"], { probe: true }).status, 1);
expect("--purge combined with --apply is a usage error", run(["--apply", "--purge"], { probe: true }).status, 1);
expect("--purge combined with --check is a usage error", run(["--check", "--purge"], { probe: true }).status, 1);

/* 2. A flag without its value: refused, with nothing written. */
const emptyHome = join(WORK, "empty-home");
for (const flag of ["--profile", "--home", "--install", "--unit", "--unit-dir", "--vision"]) {
	const result = run([flag], { probe: true });
	expect(`${flag} with no value exits 1`, result.status, 1);
	expect(`${flag} with no value says what is missing`, result.output.includes("needs a value"), true);
}
expect("a missing value wrote nothing", [existsSync(join(emptyHome, "plugins")), existsSync(join(WORK, "plugins"))], [false, false]);
const swallowed = run(["--profile", "--apply", "--home", emptyHome, "--install", fixtureInstall]);
expect("a flag value that is another flag is refused", swallowed.status, 1);
expect("and the run says which flag was taken", swallowed.output.includes("is another flag"), true);
const relative = run(["--home", "relative-probe", "--install", fixtureInstall], { cwd: WORK });
expect("a relative --home is refused", relative.status, 1);
expect("a relative --home says why", relative.output.includes("absolute"), true);
expect("a relative --home created nothing under the cwd", existsSync(join(WORK, "relative-probe")), false);
/* The same rule covers the fallback: a relative HOME must not become `./.dsh`. */
const relativeHome = run(["--check"], { cwd: WORK, env: { ...childEnv, HOME: "probe-relative", DSH_HOME: "" }, probe: true });
expect("a relative HOME is refused too", relativeHome.status, 1);
expect("a relative HOME says why", relativeHome.output.includes("absolute"), true);
expect("a relative HOME created nothing under the cwd", existsSync(join(WORK, "probe-relative")), false);

/* 3. --apply: the copy, the flat manifest, the row. */
const applied = run(args(["--apply"]));
expect("--apply exits 0", applied.status, 0);
for (const name of FLAT_SOURCES) expect(`--apply copied ${name}`, existsSync(join(pluginDst, name)), true);
const flat = JSON.parse(readFileSync(join(pluginDst, "package.json"), "utf8"));
expect("--apply wrote the flat manifest packaging.mjs describes", flat, installedManifest(MANIFEST));
expect("the flat manifest keeps the package identity", [flat.name, flat.version], [MANIFEST.name, MANIFEST.version]);
expect("the flat manifest re-points every entry point", [flat.main, flat.exports["."], flat.exports["./client"], flat.exports["./refresh-snapshot"]], ["./index.mjs", "./index.mjs", "./client.js", "./refresh-snapshot.mjs"]);
expect("the flat manifest keeps the client declaration", flat.dsh, { client: MANIFEST.dsh.client });
expect("the flat manifest drops the package's own lib/ entry points", readFileSync(join(pluginDst, "package.json"), "utf8").includes("lib/"), false);
expect("--apply wrote exactly one row for the id", occurrences(readPatch(), `id: ${ID}`), 1);
expect("--apply wrote exactly one marker", occurrences(readPatch(), MARKER), 1);
expect("--apply wrote exactly one header comment", occurrences(readPatch(), ROW_HEADER), 1);
expect("the row's name is the flat entry point", readPatch().includes(`name: ${rowName}`), true);
expect("the row is inserted, not merged into another entry", occurrences(readPatch(), "- insert:"), 1);
expect("--apply reported the pre-flight as ok", applied.output.includes("pre-flight: the composed layer holds one row"), true);
expect("--apply reported a failed daemon-reload as a note, not a failure", applied.status, 0);

/* 4. The run that finds its own row again. */
const firstBytes = readPatch();
const repeated = run(args(["--apply"]));
expect("a second --apply exits 0", repeated.status, 0);
expect("a second --apply leaves the document byte-identical", readPatch(), firstBytes);
expect("a second --apply still holds exactly one row", occurrences(readPatch(), `id: ${ID}`), 1);
expect("--update behaves like --apply", run(args(["--update"])).status, 0);
expect("--update did not add a row either", occurrences(readPatch(), `id: ${ID}`), 1);

/* 5. What the user wrote in the patch file stays. */
writePatch([
	"# a user's own note",
	"- insert:",
	"    - id: probe-plugin",
	"      name: probe-plugin",
	"",
	"# a note about the next row",
	"- insert:",
	"    - id: probe-other",
	"      name: /tmp/probe/other/index.mjs",
	"",
	"# tail note",
	""
].join("\n"));
expect("--apply onto a hand-written document exits 0", run(args(["--apply"])).status, 0);
const preserved = readPatch();
expect("the user's comments survive --apply", ["# a user's own note", "# a note about the next row", "# tail note"].map((line) => preserved.includes(line)), [true, true, true]);
expect("the user's rows survive --apply", [occurrences(preserved, "- id: probe-plugin"), occurrences(preserved, "- id: probe-other")], [1, 1]);
expect("and exactly one row is ours", occurrences(preserved, `id: ${ID}`), 1);

/* 6. Tolerant removal: a blank line and a comment between the marker and its row. */
writePatch([
	"# user note",
	"- insert:",
	"    - id: probe-plugin",
	"      name: probe-plugin",
	"",
	MARKER,
	ROW_HEADER,
	"",
	"# a comment inside the block",
	"- insert:",
	`    - id: ${ID}`,
	`      name: ${rowName}`,
	"",
	"# tail note",
	""
].join("\n"));
const tolerant = run(args(["--uninstall"]));
expect("--uninstall exits 0 when a blank line separates the marker and its row", tolerant.status, 0);
expect("--uninstall removed the row the marker introduced", occurrences(readPatch(), `id: ${ID}`), 0);
expect("--uninstall removed the marker with it", occurrences(readPatch(), MARKER), 0);
expect("--uninstall kept the user's comment", readPatch().includes("# user note"), true);
expect("--uninstall kept the trailing note", readPatch().includes("# tail note"), true);
expect("--uninstall kept the user's row", occurrences(readPatch(), "- id: probe-plugin"), 1);
expect("--uninstall kept the copied files", existsSync(join(pluginDst, "index.mjs")), true);
expect("and said which row it removed", tolerant.output.includes(`removed this installer's ${ID} row`), true);
expect("the re-apply after that tolerant removal exits 0", run(args(["--apply"])).status, 0);
expect("and wrote one row, not two", occurrences(readPatch(), `id: ${ID}`), 1);
expect("with one marker", occurrences(readPatch(), MARKER), 1);

/* 7. A row left without its marker is still ours to remove. */
writePatch([
	"# keep me",
	"- insert:",
	"    - id: probe-plugin",
	"      name: probe-plugin",
	"",
	"- insert:",
	`    - id: ${ID}`,
	`      name: ${rowName}`,
	""
].join("\n"));
const markerless = run(args(["--uninstall"]));
expect("--uninstall removes a row that has no marker but is shaped like ours", occurrences(readPatch(), `id: ${ID}`), 0);
expect("and reports what it removed", markerless.output.includes(`removed this installer's ${ID} row`), true);
expect("leaving the neighbouring row alone", occurrences(readPatch(), "- id: probe-plugin"), 1);
expect("and its comment", readPatch().includes("# keep me"), true);

/* 8. A row that merely shares the id is not this installer's. */
writePatch(["- insert:", `    - id: ${ID}`, `      name: ${ID}`, ""].join("\n"));
const bundleRow = run(args(["--uninstall"]));
expect("--uninstall exits 0 when only another installer's row shares the id", bundleRow.status, 0);
expect("a bundle-style row that merely shares the id is left alone", occurrences(readPatch(), `- id: ${ID}`), 1);
expect("and the run says the row is not its own", bundleRow.output.includes("none of them is this installer's"), true);
const clash = run(args(["--apply"]));
expect("--apply refuses to install a second row for the same id", clash.status, 2);
expect("--apply names the row count it refuses", clash.output.includes("would hold 2 rows"), true);
const bundleCheck = run(args(["--check"]));
expect("--check reports a row that is present but not this installer's", bundleCheck.output.includes("none is this installer's"), true);

/* 9. The marker an older install wrote is recognized and replaced. */
writePatch([
	"# user note",
	"# dsh-model-metadata: local model-metadata fallback plugin",
	"- insert:",
	`    - id: ${ID}`,
	`      name: ${rowName}`,
	""
].join("\n"));
const migrated = run(args(["--apply"]));
expect("migrating a legacy marker exits 0", migrated.status, 0);
expect("the legacy marker is gone", readPatch().includes("local model-metadata fallback plugin"), false);
expect("the current marker is written", occurrences(readPatch(), MARKER), 1);
expect("exactly one row survives the migration", occurrences(readPatch(), `id: ${ID}`), 1);
expect("the user's comment survives the migration", readPatch().includes("# user note"), true);

/* 10. --check, on a clean tree and on broken ones. */
expect("--check on a clean install exits 0", run(args(["--check"])).status, 0);
rmSync(join(pluginDst, "index.mjs"), { force: true });
const missing = run(args(["--check"]));
expect("--check exits 2 when the composed row points at a missing file", missing.status, 2);
expect("--check names the missing file", missing.output.includes("points at a missing file"), true);
expect("--check reports the file drift too", missing.output.includes("index.mjs: new"), true);
run(args(["--apply"]));
writePatch([
	MARKER,
	ROW_HEADER,
	"- insert:",
	`    - id: ${ID}`,
	`      name: ${rowName}`,
	"",
	MARKER,
	ROW_HEADER,
	"- insert:",
	`    - id: ${ID}`,
	`      name: ${rowName}`,
	""
].join("\n"));
const doubled = run(args(["--check"]));
expect("--check exits 2 when the document holds two rows for the id", doubled.status, 2);
expect("--check says how many rows it composed", doubled.output.includes("2 rows for id"), true);
expect("--apply repairs the doubled document to one row", [run(args(["--apply"])).status, occurrences(readPatch(), `id: ${ID}`)], [0, 1]);

/* 11. A file this checkout no longer ships is reported and pruned. */
writeFileSync(join(pluginDst, "legacy-thing.mjs"), "// left by an older layout\n");
const stray = run(args(["--check"]));
expect("--check reports a file the copy holds but this checkout does not", stray.output.includes("legacy-thing.mjs: stray"), true);
const pruned = run(args(["--apply"]));
expect("--apply prunes the stale file", existsSync(join(pluginDst, "legacy-thing.mjs")), false);
expect("--apply says which file it pruned", pruned.output.includes("legacy-thing.mjs"), true);
expect("--apply keeps the files that are shipped", FLAT_SOURCES.every((name) => existsSync(join(pluginDst, name))), true);

/* 12. --profile: a profile directory that does not exist yet is created first. */
const profileHome = join(WORK, "profile-home");
const profileFile = join(profileHome, "profiles", "probe-web", "cordis.patch.yml");
const profiled = run(["--apply", "--profile", "probe-web", "--home", profileHome, "--install", fixtureInstall]);
expect("--apply --profile into a fresh home exits 0", profiled.status, 0);
expect("the profile patch directory was created", existsSync(profileFile), true);
expect("the profile patch holds one row", occurrences(readFileSync(profileFile, "utf8"), `id: ${ID}`), 1);
expect("the home-level patch was not written instead", existsSync(join(profileHome, "cordis.patch.yml")), false);
expect("a profile name that is a path is refused", run(["--apply", "--profile", "../probe", "--home", profileHome, "--install", fixtureInstall]).status, 1);

/* 13. The unit drop-in lifecycle. */
expect("--vision off exits 0", run(args(["--vision", "off"])).status, 0);
expect("--vision off wrote the drop-in", existsSync(dropInFile), true);
expect("the drop-in carries the mode", readFileSync(dropInFile, "utf8").includes("DSH_PI_AI_CATALOG_FALLBACK_INPUT=off"), true);
expect("--vision on is the default and removes the drop-in", [run(args(["--vision", "on"])).status, existsSync(dropInFile)], [0, false]);
run(args(["--vision", "bundled"]));
expect("--vision bundled writes the drop-in again", readFileSync(dropInFile, "utf8").includes("bundled"), true);
expect("--vision rejects a mode it does not know", run(args(["--vision", "sometimes"])).status, 1);
expect("--vision without a unit is refused", run(["--home", home, "--install", fixtureInstall, "--unit-dir", units, "--vision", "off"]).status, 1);
expect("--apply does not remove a drop-in", [run(args(["--apply"])).status, existsSync(dropInFile)], [0, true]);
expect("--uninstall removes the drop-in", [run(args(["--uninstall"])).status, existsSync(dropInFile)], [0, false]);
expect("--purge removes the drop-in too", (() => {
	run(args(["--apply"]));
	run(args(["--vision", "off"]));
	const before = existsSync(dropInFile);
	const status = run(args(["--purge"])).status;
	return [before, status, existsSync(dropInFile)];
})(), [true, 0, false]);

/* 14. --uninstall and --purge. */
run(args(["--apply"]));
writeFileSync(snapshotDst, "{}\n");
expect("--uninstall keeps the copied files", [run(args(["--uninstall"])).status, existsSync(join(pluginDst, "index.mjs"))], [0, true]);
expect("--uninstall removed the row", occurrences(readPatch(), `id: ${ID}`), 0);
expect("--uninstall keeps the snapshot", existsSync(snapshotDst), true);
run(args(["--apply"]));
const purged = run(args(["--purge"]));
expect("--purge alone exits 0", purged.status, 0);
expect("--purge alone removed the copied files", existsSync(pluginDst), false);
expect("--purge alone removed the snapshot", existsSync(snapshotDst), false);
expect("--purge alone removed the row", occurrences(readPatch(), `id: ${ID}`), 0);
expect("--purge alone did not re-install anything", purged.output.includes("copied plugin"), false);
expect("--uninstall on a home with nothing installed exits 0", run(args(["--uninstall"])).status, 0);

/* 15. The real loader, when this machine has one: everything above proved the exit codes
 * with a stand-in, this proves the document really composes there. */
let real;
try {
	real = dshInstall();
} catch {
	real = undefined;
}
const realLoader = real !== undefined && existsSync(join(real, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js")) && existsSync(join(real, "node_modules", "js-yaml", "index.js"));
run(args(["--apply"]));
if (realLoader) {
	const against = run(["--check", "--home", home, "--install", real, "--unit", UNIT, "--unit-dir", units]);
	expect("the real loader composes the row this installer wrote", against.status, 0);
} else {
	console.log("note: no DSH install to cross-check against — the fixture loader covered the pre-flight exit codes");
}

if (failures.length > 0) for (const failure of failures) console.log(`FAIL ${failure}`);
console.log(`${String(checks - failures.length)}/${String(checks)} install-plugin assertions passed`);
if (failures.length > 0) process.exit(1);
