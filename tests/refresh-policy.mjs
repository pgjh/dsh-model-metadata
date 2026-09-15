#!/usr/bin/env node
/**
 * refresh-policy.mjs — when the plugin decides its data is too old.
 *
 * Reads the plugin's own exported policy rather than a copy of it, and proves every
 * trigger: the daily threshold, the launch refresh (and its restart floor), the
 * app-open refresh, the off switches, and the in-flight dedupe that keeps a page's
 * several cards from becoming several fetches. Network-free: the one place that
 * would fetch gets a stub `fetch`, and nothing leaves the machine.
 *
 *   node tests/refresh-policy.mjs                    # default policy
 *   DSH_PI_AI_CATALOG_REFRESH=0 node tests/refresh-policy.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = process.env.DSH_CATALOG_FALLBACK_PLUGIN ?? join(HERE, "..", "lib/index.mjs");
const WORK = join(HERE, ".refresh-policy");
const FRESH = join(WORK, "fresh.json");
const OLD = join(WORK, "old.json");
const MISSING = join(WORK, "absent.json");

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const document = JSON.stringify({ fetchedAt: new Date().toISOString(), source: "test", providers: 1, count: 0, models: {} });
for (const path of [FRESH, OLD]) writeFileSync(path, document);
const twoDaysAgo = new Date(Date.now() - 48 * 3600000);
utimesSync(OLD, twoDaysAgo, twoDaysAgo);

process.env.DSH_PI_AI_CATALOG_SNAPSHOT = FRESH;
const plugin = await import(pathToFileURL(PLUGIN).href);

const failures = [];
let checks = 0;
function expect(label, actual, wanted) {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) failures.push(`${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
}

const policy = plugin.REFRESH_POLICY;
const auto = plugin.AUTO_REFRESH_HOURS;
process.env.DSH_PI_AI_CATALOG_SNAPSHOT = FRESH;
expect("a fresh snapshot is not due for the daily refresh", plugin.refreshDue(), false);
process.env.DSH_PI_AI_CATALOG_SNAPSHOT = OLD;
expect("a two-day-old snapshot is due", plugin.refreshDue(), auto > 0);
expect("its age is reported in hours", Math.round(plugin.snapshotAgeHours()), 48);
process.env.DSH_PI_AI_CATALOG_SNAPSHOT = MISSING;
expect("a missing snapshot is due", plugin.refreshDue(), auto > 0);
expect("a missing snapshot reads as infinitely old", plugin.snapshotAgeHours(), Number.POSITIVE_INFINITY);

/* The two triggers this round added. */
process.env.DSH_PI_AI_CATALOG_SNAPSHOT = FRESH;
if (auto === 0) {
	/* The master switch means "do not fetch on your own", so no trigger may fire. */
	expect("with the daily refresh disabled, no trigger fetches a fresh copy", [plugin.startDue(), plugin.openDue(), plugin.refreshDue()], [false, false, false]);
	process.env.DSH_PI_AI_CATALOG_SNAPSHOT = OLD;
	expect("nor an old one", [plugin.startDue(), plugin.openDue(), plugin.refreshDue()], [false, false, false]);
	process.env.DSH_PI_AI_CATALOG_SNAPSHOT = MISSING;
	expect("nor a missing one", [plugin.startDue(), plugin.openDue(), plugin.refreshDue()], [false, false, false]);
} else {
	expect("a launch refreshes a file that is not stale yet, once past the floor", [policy.onStart, plugin.startDue()], ["always", policy.startFloorMinutes === 0]);
	expect("opening the app does not refresh a fresh copy", plugin.openDue(), false);
	expect("and the daily rule alone would not have fetched it", plugin.refreshDue(), false);
	process.env.DSH_PI_AI_CATALOG_SNAPSHOT = OLD;
	expect("a two-day-old file is refreshed by every trigger", [plugin.startDue(), plugin.openDue(), plugin.refreshDue()], [true, true, true]);
	process.env.DSH_PI_AI_CATALOG_SNAPSHOT = MISSING;
	expect("a missing file is refreshed by every trigger too", [plugin.startDue(), plugin.openDue(), plugin.refreshDue()], [true, true, true]);
}

/* A file just written by a launch must not be fetched again by the next launch. */
const justNow = join(WORK, "just-now.json");
writeFileSync(justNow, document);
process.env.DSH_PI_AI_CATALOG_SNAPSHOT = justNow;
expect("the restart floor keeps a fresh file from being re-fetched at launch", [plugin.startDue(), plugin.openDue()], [false, false]);
expect("and the floor is what does it, not a missing policy", [policy.startFloorMinutes > 0], [true]);

/* The app-open trigger must be reachable: an hour-old copy is past its floor but
 * not past the 6h open rule, so only the launch trigger fires there. */
const hourAgo = new Date(Date.now() - 3600000);
utimesSync(justNow, hourAgo, hourAgo);
const launchWouldFetch = auto !== 0 && policy.onStart === "always" && policy.startFloorMinutes <= 60;
expect("an hour-old copy: launch yes past the 15m floor, open no under the 6h rule", [plugin.startDue(), plugin.openDue()], [launchWouldFetch, auto !== 0 && policy.openHours <= 1]);

/* Modes and off switches, each in its own process: the policy is read at import. */
const probe = (env, expressions) => {
	const script = `const m = await import(${JSON.stringify(pathToFileURL(PLUGIN).href)});
console.log(JSON.stringify([${expressions.map((expression) => `(${expression})`).join(",")}]));`;
	try {
		return JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], {
			encoding: "utf8",
			/* Pin the daily threshold: this suite is also run with it disabled, and a
			 * child must exercise the case it was given, not the parent's mode. */
			env: { ...process.env, DSH_PI_AI_CATALOG_REFRESH: "24", DSH_PI_AI_CATALOG_SNAPSHOT: FRESH, ...env }
		}).trim().split("\n").pop());
	} catch (error) {
		return { failure: error instanceof Error ? error.message : String(error) };
	}
};
const cases = [
	[{ DSH_PI_AI_CATALOG_REFRESH_ON_START: "off" }, ["m.startDue()", "m.openDue()", "m.REFRESH_POLICY.onStart"], [false, false, "off"]],
	[{ DSH_PI_AI_CATALOG_REFRESH_ON_START: "stale" }, ["m.startDue()", "m.refreshDue()"], [false, false]],
	[{ DSH_PI_AI_CATALOG_REFRESH_ON_START: "stale", DSH_PI_AI_CATALOG_SNAPSHOT: OLD }, ["m.startDue()"], [true]],
	[{ DSH_PI_AI_CATALOG_REFRESH_OPEN_HOURS: "0" }, ["m.openDue()"], [false]],
	[{ DSH_PI_AI_CATALOG_REFRESH_START_FLOOR_MINUTES: "0" }, ["m.startDue()"], [true]],
	/* 0 is the master switch: no trigger fetches on its own, whatever the mode. */
	[{ DSH_PI_AI_CATALOG_REFRESH: "0" }, ["m.refreshDue()", "m.startDue()", "m.openDue()"], [false, false, false]],
	/* Garbage in an env var must fall back to the default, not silently disable. */
	[{ DSH_PI_AI_CATALOG_REFRESH: "daily" }, ["m.REFRESH_POLICY.hours"], [24]],
	[{ DSH_PI_AI_CATALOG_REFRESH_OPEN_HOURS: "soon" }, ["m.REFRESH_POLICY.openHours"], [6]]
];
for (const [env, expressions, wanted] of cases) {
	const got = probe(env, expressions);
	expect(`env ${JSON.stringify(env)}`, got.failure === undefined ? got : got, wanted);
}

/* One fetch, not N: the page asks per card, and a launch may land at the same time. */
const stub = { calls: 0 };
globalThis.fetch = async () => {
	stub.calls++;
	await new Promise((resolve) => setTimeout(resolve, 50));
	return { ok: true, status: 200, statusText: "OK", json: async () => ({ probe: { models: { "probe/x": { name: "X", limit: { context: 4096, output: 1024 } } } } }) };
};
process.env.DSH_PI_AI_CATALOG_SNAPSHOT = MISSING;
const noisy = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const started = [plugin.refreshIfDue(noisy, "open"), plugin.refreshIfDue(noisy, "open"), plugin.refreshIfDue(noisy, "start")];
await new Promise((resolve) => setTimeout(resolve, 250));
if (auto === 0) {
	expect("with the master switch off, a trigger fetches nothing", [started, stub.calls], [[false, false, false], 0]);
} else {
	expect("concurrent triggers collapse into one fetch", [started, stub.calls], [[true, false, false], 1]);
	expect("and the fetch wrote the snapshot it was handed", plugin.snapshotAgeHours() < 1, true);
	expect("a fresh copy then leaves every trigger alone", [plugin.startDue(), plugin.openDue()], [false, false]);
}

rmSync(WORK, { recursive: true, force: true });
if (auto === 0) console.log(`automatic refresh disabled (DSH_PI_AI_CATALOG_REFRESH=0): ${String(checks - failures.length)}/${String(checks)} assertions passed`);
else console.log(`refresh policy (daily ${String(auto)}h, launch ${policy.onStart} floor ${String(policy.startFloorMinutes)}m, open ${String(policy.openHours)}h): ${String(checks - failures.length)}/${String(checks)} assertions passed`);
if (failures.length > 0) {
	for (const failure of failures) console.log(`FAIL ${JSON.stringify(failure)}`);
	process.exit(1);
}
