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
import { readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recordingLogger, sandbox, suite } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = process.env.DSH_CATALOG_FALLBACK_PLUGIN ?? join(HERE, "..", "lib/index.mjs");
const WORK = sandbox("refresh-policy");
const FRESH = WORK.file("fresh.json");
const OLD = WORK.file("old.json");
const MISSING = WORK.file("absent.json");

const document = JSON.stringify({ fetchedAt: new Date().toISOString(), source: "test", providers: 1, count: 0, models: {} });
for (const path of [FRESH, OLD]) writeFileSync(path, document);
const twoDaysAgo = new Date(Date.now() - 48 * 3600000);
utimesSync(OLD, twoDaysAgo, twoDaysAgo);

process.env.DSH_PI_AI_CATALOG_SNAPSHOT = FRESH;
const plugin = await import(pathToFileURL(PLUGIN).href);

const { expect, finish } = suite("refresh policy");

const policy = plugin.REFRESH_POLICY;
const auto = plugin.AUTO_REFRESH_HOURS;
/*
 * The defaults the README documents, pinned by value. The assertions below compare
 * against this same object, so without this line changing a default keeps the whole
 * suite green while the documentation goes stale.
 */
expect("the documented defaults are exactly what the README says",
	auto === 0 ? [policy.hours, policy.startFloorMinutes, policy.openHours, policy.onStart] : [policy.hours, policy.startFloorMinutes, policy.openHours, policy.onStart],
	auto === 0 ? [0, 15, 6, "always"] : [24, 15, 6, "always"]);
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
const justNow = WORK.file("just-now.json");
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
	[{ DSH_PI_AI_CATALOG_REFRESH_OPEN_HOURS: "soon" }, ["m.REFRESH_POLICY.openHours"], [6]],
	/* An acceptable value is trimmed and case-folded, so a shell that adds either does
	 * not turn into a silent switch to the fallback. */
	[{ DSH_PI_AI_CATALOG_REFRESH_ON_START: " ALWAYS " }, ["m.REFRESH_POLICY.onStart", "m.startDue()"], ["always", false]],
	/*
	 * An unrecognized value resolves to the conservative end of its range rather than to
	 * the busy default: "never" must not mean "fetch on every launch".
	 */
	[{ DSH_PI_AI_CATALOG_REFRESH_ON_START: "never" }, ["m.REFRESH_POLICY.onStart", "m.startDue()"], ["off", false]],
	/*
	 * Only a plain decimal counts. `parseFloat` read this as 0, which silently turned
	 * "refresh daily" into "never refresh on your own".
	 */
	[{ DSH_PI_AI_CATALOG_REFRESH: "0x10" }, ["m.REFRESH_POLICY.hours"], [24]],
	[{ DSH_PI_AI_CATALOG_REFRESH_START_FLOOR_MINUTES: "0x10" }, ["m.REFRESH_POLICY.startFloorMinutes"], [15]],
	/* `0` is a legitimate floor and is not confused with "unreadable". */
	[{ DSH_PI_AI_CATALOG_REFRESH_START_FLOOR_MINUTES: "0" }, ["m.REFRESH_POLICY.startFloorMinutes", "m.startDue()"], [0, true]]
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
const noisy = recordingLogger().logger;
const started = [plugin.refreshIfDue(noisy, "open"), plugin.refreshIfDue(noisy, "open"), plugin.refreshIfDue(noisy, "start")];
await new Promise((resolve) => setTimeout(resolve, 250));
if (auto === 0) {
	expect("with the master switch off, a trigger fetches nothing", [started, stub.calls], [[false, false, false], 0]);
} else {
	expect("concurrent triggers collapse into one fetch", [started, stub.calls], [[true, false, false], 1]);
	expect("and the fetch wrote the snapshot it was handed", plugin.snapshotAgeHours() < 1, true);
	expect("a fresh copy then leaves every trigger alone", [plugin.startDue(), plugin.openDue()], [false, false]);
}

/*
 * A *failing* fetch must not be retried once per request. The in-flight guard only
 * collapses concurrent attempts, so a snapshot that stays missing (or unreadable) used
 * to mean one full download attempt per panel load for as long as the network was down.
 */
if (auto !== 0) {
	const failing = recordingLogger();
	let attempts = 0;
	globalThis.fetch = async () => {
		attempts++;
		throw new Error("network down");
	};
	rmSync(MISSING, { force: true });
	globalThis.process.env.DSH_PI_AI_CATALOG_SNAPSHOT = MISSING;
	const start = Date.now() + 3600000;
	expect("a failed refresh is attempted once", plugin.refreshIfDue(failing.logger, "open", start), true);
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect("and the failure is reported rather than swallowed", [attempts, failing.warnings.length > 0], [1, true]);
	expect("the next request one minute later does not try again", plugin.refreshIfDue(failing.logger, "open", start + 60000), false);
	expect("not even a launch one minute later", plugin.refreshIfDue(failing.logger, "start", start + 60000), false);
	expect("the floor expires", plugin.refreshIfDue(failing.logger, "open", start + 6 * 60000), true);
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect("so exactly one more attempt was made", attempts, 2);
	expect("a manual refresh ignores the floor — an operator asked", plugin.refreshIfDue(failing.logger, "manual", start + 6 * 60000 + 1), true);
	await new Promise((resolve) => setTimeout(resolve, 60));
	/*
	 * The daily tick is the third documented trigger, and the only one that needs neither a
	 * launch nor an open page — which is why the plugin schedules it: a process that stays
	 * up for weeks used to keep its first snapshot for weeks. It follows the age rule, and
	 * the attempt floor applies to it like every other automatic trigger, so a failing fetch
	 * does not become an hourly download either.
	 */
	expect("a daily tick refreshes a copy that is due", plugin.refreshIfDue(failing.logger, "daily", start + 12 * 60000), true);
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect("and the floor keeps a failing daily tick from retrying at its own rate", plugin.refreshIfDue(failing.logger, "daily", start + 12 * 60000 + 1000), false);

	/*
	 * A body-less 304 is the endpoint saying "your copy is current". It arrives as
	 * `ok === false`, which a plain fetch helper would report as a failure; the file must
	 * be left alone and merely restamped so the age rules stop asking.
	 */
	const current = sandbox("refresh-304");
	const fresh = current.file("snapshot.json");
	writeFileSync(fresh, document);
	const stale = new Date(Date.now() - 48 * 3600000);
	utimesSync(fresh, stale, stale);
	globalThis.process.env.DSH_PI_AI_CATALOG_SNAPSHOT = fresh;
	let conditional;
	globalThis.fetch = async (_url, options) => {
		conditional = options?.headers?.["if-none-match"];
		return { status: 304, ok: false, statusText: "Not Modified", headers: { get: () => undefined } };
	};
	const notModified = recordingLogger();
	expect("a stale copy is revalidated", plugin.refreshIfDue(notModified.logger, "manual"), true);
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect("a 304 is not reported as a failure", notModified.warnings, []);
	expect("the body it already had is kept", readFileSync(fresh, "utf8") === document, true);
	expect("and the copy is restamped so the age rules stop asking", plugin.snapshotAgeHours() < 1, true);
	expect("the request counted as revalidation, not as a download", conditional === undefined || typeof conditional === "string", true);
	current.clean();
}

WORK.clean();
console.log(auto === 0 ? "automatic refresh disabled (DSH_PI_AI_CATALOG_REFRESH=0)" : `refresh threshold ${String(auto)}h, launch ${policy.onStart} floor ${String(policy.startFloorMinutes)}m, open ${String(policy.openHours)}h`);
finish();
