#!/usr/bin/env node
/**
 * unit.mjs — the three pure modules, checked on their own.
 *
 * `names.mjs`, `snapshot.mjs` and `panel.mjs` are the plugin's only pure seams:
 * no DSH install, no network, no settings file, no browser. Everything else in
 * this directory drives the real thing through a real seam, which is valuable
 * but means a rule that lives in one of these three files is only ever observed
 * second-hand. This suite calls them directly, so a change to a name rule, a
 * flattening rule or a merge rule fails here — named — instead of surfacing as a
 * puzzling difference three layers up.
 *
 * Four things here are drift checks rather than behaviour checks, and they are
 * the reason the suite exists:
 *   - `NAME_SUFFIXES` against the list the README publishes;
 *   - `MIN_NORMALIZED_LENGTH` against the boundary this suite pins;
 *   - `source` in a snapshot against the URL that was actually fetched (a mirror
 *     used to be recorded as the shipped endpoint);
 *   - `buildMatrix`'s route parameter, which exists so one card does not pay for
 *     every other route's lookups.
 *
 * `fetch` is stubbed for the two network functions; the stub is restored in a
 * `finally`, so nothing after that section sees it. The only file this suite
 * writes is a snapshot round-tripped through JSON inside a scratch directory
 * taken from the OS and removed again on every exit path.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAME_SUFFIXES, MIN_NORMALIZED_LENGTH, bareName, normalizeName, normalizedKeys } from "../lib/names.mjs";
import { SNAPSHOT_URL, fetchModelsDevSnapshot, fetchModelsDevSnapshotIfChanged, flattenModelsDev, looksNonChat } from "../lib/snapshot.mjs";
import { applyChoice, buildMatrix, buildOps } from "../lib/panel.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const README = join(HERE, "..", "README.md");

/* One scratch directory per run, named after the pid so two runs cannot collide. */
const WORK = mkdtempSync(join(tmpdir(), `dsh-mm-unit-${String(process.pid)}-`));

const failures = [];
const notes = [];
let checks = 0;

/**
 * Remove the scratch directory. Registered on `exit` as well as called from the
 * end of the run, so a suite that dies mid-assertion leaves nothing behind.
 */
function cleanWork() {
	try {
		rmSync(WORK, { recursive: true, force: true });
	} catch {
		/* A leftover temp directory is not worth turning into a test failure. */
	}
}
process.on("exit", cleanWork);

/**
 * Print every failure, then the summary — the count is always the last line —
 * and set the exit status.
 */
function finish() {
	for (const failure of failures) console.log(`FAIL ${failure}`);
	for (const note of notes) console.log(`note: ${note}`);
	console.log(`${String(Math.max(checks - failures.length, 0))}/${String(checks)} assertions passed (unit)`);
	if (failures.length > 0) process.exitCode = 1;
	cleanWork();
}

/*
 * A throw inside an assertion — a fixture that lost a field it reads — must
 * still print the summary rather than a bare stack trace, since the normal exit
 * below is skipped by an uncaught error. Both events land here.
 */
for (const event of ["uncaughtException", "unhandledRejection"]) {
	process.on(event, (error) => {
		checks++;
		failures.push(`the suite threw before it finished — ${String(error?.message ?? error)}`);
		finish();
	});
}

/**
 * Assert deep equality, printing both sides with the failure.
 * @param label - what the behaviour under test is, in one sentence.
 * @param actual - the value the module produced.
 * @param wanted - the value the behaviour promises.
 */
function expect(label, actual, wanted) {
	checks++;
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) failures.push(`${label} — expected ${JSON.stringify(wanted)} actual ${JSON.stringify(actual)}`);
}

/**
 * Assert a plain condition, for the cases deep equality cannot state: "this did
 * not throw", "this is an instance of that".
 * @param label - what the behaviour under test is, in one sentence.
 * @param condition - must be exactly true.
 * @param detail - extra context printed with the failure.
 */
function ok(label, condition, detail = "") {
	checks++;
	if (condition !== true) failures.push(`${label} — expected a true condition actual false${detail === "" ? "" : ` (${detail})`}`);
}

/**
 * Run something that must reject, and hand back the message.
 * @param label - what the behaviour under test is, in one sentence.
 * @param run - a function returning a promise.
 * @returns the error message, or `""` when the call resolved (recorded as a failure).
 */
async function rejection(label, run) {
	checks++;
	try {
		const value = await run();
		failures.push(`${label} — expected a thrown error actual ${JSON.stringify(value)}`);
		return "";
	} catch (error) {
		return String(error?.message ?? error);
	}
}

/**
 * The name suffixes the README promises, read out of the document instead of
 * restated here: a list copied into the test would drift exactly like the code
 * it is meant to check. The list is the line carrying two or more backticked
 * `-word` entries; a line that mentions one suffix inline is not the list, and a
 * README reformatted so that no line carries two is reported by the guard below
 * rather than silently agreeing with everything.
 * @param markdown - the whole document.
 * @returns the suffixes it lists, deduplicated, in order of appearance.
 */
function documentedSuffixes(markdown) {
	const found = new Set();
	for (const line of markdown.split("\n")) {
		const spans = [...line.matchAll(/`-([a-z]+)`/g)].map((match) => match[1]);
		if (spans.length >= 2) for (const suffix of spans) found.add(suffix);
	}
	return [...found];
}

/* ------------------------------------------------------------------ names.mjs */

expect("a bare name is what follows the last slash, however many there are", [bareName("plain-model"), bareName("gateway/alias/plain-model"), bareName("gateway/plain-model/")], ["plain-model", "plain-model", ""]);
expect("an empty, missing or non-string id is read as its text", [bareName(""), bareName(null), bareName(undefined), bareName(42)], ["", "", "", "42"]);
expect("case and every separator fold to the same spelling", [normalizeName("V4.1-Flash"), normalizeName("v41-flash"), normalizeName("V41 Flash"), normalizeName("v4_1_flash")], ["v41flash", "v41flash", "v41flash", "v41flash"]);
expect("a run of punctuation folds away once, and characters outside ascii are erased", [normalizeName("a---b__..c"), normalizeName("Ωmega-V4"), normalizeName(41.5)], ["abc", "megav4", "415"]);
expect("an empty or missing name normalizes to empty", [normalizeName(""), normalizeName(undefined)], ["", ""]);
expect("a name too short to be anything but a coincidence yields no keys", [normalizedKeys("a-b-c"), normalizedKeys(""), normalizedKeys("----")], [[], [], []]);
expect("the length floor is four characters, as this suite pins it", MIN_NORMALIZED_LENGTH, 4);
expect("a name at the floor yields the exact spelling plus one key per suffix", normalizedKeys("abcd"), ["abcd", "abcdexp", "abcdexperimental", "abcdlatest", "abcdpreview", "abcdfree"]);
expect("a name missing a decoration still reaches the decorated catalog entry", normalizedKeys("deepseek-v4-flash-vision").includes("deepseekv4flashvisionexp"), true);

/*
 * The deliberate one-directionality. The catalog may carry a decoration the
 * configured name lacks; a configured name that carries one the catalog lacks is
 * a different model, because a `-free` endpoint is frequently its own deployment
 * with its own window. So a configured `x-free` is never looked up as plain `x`,
 * and every key comes from appending, never from dropping.
 */
const freeKeys = normalizedKeys("gpt-4o-free");
expect("a configured decoration is never stripped, and keys only ever append", [freeKeys[0], freeKeys.includes("gpt4o"), freeKeys.filter((key) => !key.startsWith("gpt4ofree"))], ["gpt4ofree", false, []]);

const documented = documentedSuffixes(readFileSync(README, "utf8"));
ok("the README's suffix list is still readable by this check", documented.length >= 4, `parsed ${JSON.stringify(documented)}`);
expect("every suffix the README promises is implemented", documented.filter((suffix) => !NAME_SUFFIXES.includes(suffix)), []);
expect("NAME_SUFFIXES is exactly the list the suite pins", NAME_SUFFIXES, ["exp", "experimental", "latest", "preview", "free"]);
/*
 * Reported, not failed. Documented-but-missing is a code bug and fails above;
 * implemented-but-undocumented is a gap in a document this suite does not own,
 * and a suite that goes red over a markdown line gets switched off rather than
 * fixed. A run that prints this line is a run that found a gap.
 */
const undocumented = NAME_SUFFIXES.filter((suffix) => !documented.includes(suffix));
if (undocumented.length > 0) notes.push(`README.md does not document these implemented suffixes: ${undocumented.join(", ")}`);

/* --------------------------------------------------------------- snapshot.mjs */

const MIRROR = "https://mirror.example/api.json";
/*
 * Synthetic catalog: three providers that count, two that must not, and one row
 * per shape the flattener has to be tolerant about.
 */
const RAW = {
	"alpha-vendor": {
		models: {
			"acme-chat-large": { name: "Acme Chat Large", limit: { context: 131072, output: 16384 }, modalities: { input: ["text", "image"] }, reasoning: true },
			"acme-chat-small": { name: "acme-chat-small", limit: { context: 32768, output: 4096 }, modalities: { input: ["text", "audio"] }, reasoning: "yes" },
			"acme-audio-only": { name: "Acme Audio Only", modalities: { input: ["audio"] } }
		}
	},
	"beta-vendor": { models: { "beta-visual-1": { name: "Beta Visual 1", limit: { context: 0, output: -1 }, modalities: { input: ["image"] } } } },
	"gamma-vendor": {},
	"delta-vendor": { models: null },
	"epsilon-vendor": {
		models: {
			"eps-text-embedding-9": { name: "Eps Text Embedding 9", limit: { context: 8192 } },
			"eps-chat-fractional": { limit: { context: 1.5, output: "4096" } },
			"eps-chat-no-limit": {},
			"eps-chat-not-a-row": null,
			"eps-chat-whisper-named": { name: "Eps Whisper Deluxe" }
		}
	}
};
const snapshot = flattenModelsDev(RAW, MIRROR, 'W/"abc"');

expect("a flattened row records the provider it came from", [snapshot.models["acme-chat-large"].provider, snapshot.models["beta-visual-1"].provider], ["alpha-vendor", "beta-vendor"]);
expect("a display name is kept when it differs from the id, and omitted when it is the id", [snapshot.models["acme-chat-large"].name, "name" in snapshot.models["acme-chat-small"]], ["Acme Chat Large", false]);
expect("the capacity pair comes from limit.context and limit.output", [snapshot.models["acme-chat-large"].contextWindow, snapshot.models["acme-chat-large"].maxTokens], [131072, 16384]);
expect("only the modalities the seam models survive, and an empty result carries no field", [snapshot.models["acme-chat-large"].input, snapshot.models["acme-chat-small"].input, "input" in snapshot.models["acme-audio-only"]], [["text", "image"], ["text"], false]);
expect("a zero, negative, fractional, textual or missing capacity is left absent", ["contextWindow" in snapshot.models["beta-visual-1"], "maxTokens" in snapshot.models["beta-visual-1"], "contextWindow" in snapshot.models["eps-chat-fractional"], "maxTokens" in snapshot.models["eps-chat-fractional"], "contextWindow" in snapshot.models["eps-chat-no-limit"], "maxTokens" in snapshot.models["eps-chat-no-limit"]], [false, false, false, false, false, false]);
expect("a row that is not an object is skipped", "eps-chat-not-a-row" in snapshot.models, false);
expect("only a real true counts as reasoning-capable", [snapshot.models["acme-chat-large"].reasoning, snapshot.models["eps-chat-no-limit"].reasoning, snapshot.models["acme-chat-small"].reasoning], [true, false, false]);
expect("a non-chat id is marked in its row, and a chat row carries no such field", [snapshot.models["eps-text-embedding-9"].nonChat, "nonChat" in snapshot.models["acme-chat-large"]], [true, false]);
/* The display name is matched as well as the id, so a chat row whose *name*
 * reads like a speech model is demoted too. Demotion only ever loses to a
 * same-named row that does look like a chat model, so the cost is bounded. */
expect("a display name that reads non-chat demotes the row as well", snapshot.models["eps-chat-whisper-named"].nonChat, true);
expect("a provider without a models object is skipped and not counted", [snapshot.providers, snapshot.count, snapshot.count === Object.keys(snapshot.models).length], [3, 8, true]);
expect("the source is the URL that was actually fetched, never the shipped default", [snapshot.source, snapshot.source === SNAPSHOT_URL], [MIRROR, false]);
expect("a validator is stored with the document when one was passed, and never when none was", [snapshot.etag, "etag" in flattenModelsDev(RAW, MIRROR), "etag" in flattenModelsDev(RAW, MIRROR, "")], ['W/"abc"', false, false]);
expect("an absent document flattens to an empty snapshot from the shipped endpoint", [flattenModelsDev().count, flattenModelsDev(null).providers, flattenModelsDev({}).source], [0, 0, SNAPSHOT_URL]);
expect("fetchedAt is a parseable ISO timestamp", snapshot.fetchedAt, new Date(snapshot.fetchedAt).toISOString());

/*
 * Two providers publishing the identical id must both survive flattening.
 *
 * The document is keyed by id, so the second row used to overwrite the first,
 * which decided by *file order* whose numbers a name resolves to — and could keep
 * a mirror's row while dropping the model's own vendor. The extra key is
 * disambiguated with the provider name, and the runtime reduces every key to its
 * bare name (everything after the last `/`), so both rows stay available for
 * ranking.
 */
const bare = (key) => key.slice(key.lastIndexOf("/") + 1);
const duplicates = flattenModelsDev({ "vendor-one": { models: { "shared-id": { limit: { context: 4096 } } } }, "vendor-two": { models: { "shared-id": { limit: { context: 8192 } } } } }, MIRROR);
const duplicateKeys = Object.keys(duplicates.models);
expect("a repeated id keeps both rows", [duplicates.count, duplicateKeys.length, duplicates.providers], [2, 2, 2]);
expect("the first row keeps the plain key", [duplicates.models["shared-id"].provider, duplicates.models["shared-id"].contextWindow], ["vendor-one", 4096]);
expect("the second row is disambiguated but still reads as the same model", [duplicateKeys[1], duplicates.models[duplicateKeys[1]].provider, bare(duplicateKeys[1])], ["vendor-two/shared-id", "vendor-two", "shared-id"]);
/* A third provider colliding again must not lose a row either. */
const triple = flattenModelsDev({ a: { models: { x: {} } }, b: { models: { x: {} } }, c: { models: { x: {} } } }, MIRROR);
expect("a third provider keeps its row too", [triple.count, new Set(Object.keys(triple.models).map(bare)).size], [3, 1]);
/* A provider whose own id is already prefixed collides with nothing. */
const prefixed = flattenModelsDev({ a: { models: { x: {} } }, b: { models: { "b/x": {} } } }, MIRROR);
expect("a prefixed id that would collide gets its own key", prefixed.count, 2);

/*
 * The runtime reads the written document back with a single JSON.parse, so the
 * round trip is part of the contract rather than an implementation detail.
 */
const SNAPSHOT_FILE = join(WORK, "snapshot.json");
writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot));
expect("the document written to disk reads back unchanged", JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")), snapshot);

expect("image, embedding, speech, video and moderation ids all read as non-chat", ["acme-gpt-image-9", "acme-dall-e-3", "acme-imagen-4", "acme-image", "acme-imagegen-2", "acme-seedream-5", "acme-stable-diffusion-2", "acme-flux", "acme-paddleocr-4", "acme-text-embedding-9", "acme-bge-rerank-2", "acme-transcribe-1", "acme-whisper-large", "Acme-Whisper-Large", "tts-acme-1", "acme-voice-tts", "acme-text-to-speech", "acme-moderation-2", "acme-text-to-video-1", "acme-video-gen-2"].map(looksNonChat), [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true]);
expect("ordinary chat ids are left alone", ["acme-chat-large", "acme/family-3-8-max", "acme-flash-9", "plain-model"].map(looksNonChat), [false, false, false, false]);
/* The near misses: `-image` and `-tts` need a word end, and an id the list does
 * not name is never guessed at, so a chat row is not demoted by resemblance. */
expect("a chat id that merely resembles a pattern is left alone", ["acme-vision-images", "acme-ttsx-chat-1", "sdxl-turbo", "", undefined, 42].map(looksNonChat), [false, false, false, false, false, false]);
/* The other boundary, pinned because a later edit would move it without noticing:
 * the image prefix at the start of a name is a plain prefix test, not a word. */
expect("an id that merely starts with an image prefix is demoted anyway", looksNonChat("fluxion-chat-9b"), true);

/*
 * The two network functions, driven through a stubbed `fetch`. The stub answers
 * with the real shapes — including `ok: false` for a 304, which is exactly the
 * response shape `fetchModelsDevSnapshotIfChanged` exists to survive.
 */
const originalFetch = globalThis.fetch;
const requests = [];
const TIMEOUT_MS = 1000;
const STATUS_TEXT = { 200: "OK", 304: "Not Modified", 500: "Internal Server Error", 503: "Service Unavailable" };
const FETCH_BODY = { "gateway-vendor": { models: { "acme-tiny-1": { name: "Acme Tiny 1", limit: { context: 4096, output: 1024 } }, "acme-tiny-2": {} } } };

/**
 * Replace `globalThis.fetch` with a stub that always answers with `response`,
 * recording the requests so the assertions can read what the caller sent.
 * @param response - the stand-in response object.
 */
function stubFetch(response) {
	globalThis.fetch = (url, init) => {
		requests.push({ url, init });
		return Promise.resolve(response);
	};
}

/**
 * The fields of a `Response` these two functions actually read.
 * @param body - the parsed body `response.json()` should answer with.
 * @param status - the HTTP status.
 * @param etag - the validator the endpoint would have sent, when it sends one.
 * @returns the stand-in response.
 */
function fakeResponse(body, status = 200, etag = undefined) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: STATUS_TEXT[status] ?? "",
		headers: etag === undefined ? undefined : { get: (name) => (name.toLowerCase() === "etag" ? etag : undefined) },
		json: () => Promise.resolve(body)
	};
}

try {
	stubFetch(fakeResponse(FETCH_BODY, 200, 'W/"new"'));
	const fresh = await fetchModelsDevSnapshotIfChanged(MIRROR, TIMEOUT_MS, 'W/"old"');
	expect("a 200 answers with a document under `snapshot`", Object.keys(fresh), ["snapshot"]);
	expect("the request goes to the endpoint given, with the stored validator as if-none-match", [requests[0].url, requests[0].init.headers], [MIRROR, { "if-none-match": 'W/"old"' }]);
	ok("the request carries an abort signal for the timeout", requests[0].init.signal instanceof AbortSignal);
	expect("the validator the endpoint answered with is kept beside the document", fresh.snapshot.etag, 'W/"new"');
	expect("the document records where it really came from, not the shipped default", [fresh.snapshot.source, fresh.snapshot.source === SNAPSHOT_URL], [MIRROR, false]);
	expect("the body is flattened exactly as a direct call would flatten it", [fresh.snapshot.providers, fresh.snapshot.count], [1, 2]);

	requests.length = 0;
	stubFetch(fakeResponse(FETCH_BODY));
	const unvalidated = await fetchModelsDevSnapshotIfChanged(MIRROR, TIMEOUT_MS);
	expect("no stored validator means no header sent, and none learned from an answer without one", [requests[0].init.headers, "etag" in unvalidated.snapshot], [undefined, false]);

	requests.length = 0;
	await fetchModelsDevSnapshotIfChanged(MIRROR, TIMEOUT_MS, "");
	expect("a blank validator is not sent either", requests[0].init.headers, undefined);

	stubFetch(fakeResponse({}, 304));
	expect("a 304 is reported as unchanged rather than as a failure", await fetchModelsDevSnapshotIfChanged(MIRROR, TIMEOUT_MS, 'W/"old"'), { unchanged: true });

	stubFetch(fakeResponse({}, 503));
	const statusFailure = await rejection("a non-ok status throws instead of answering with a document", () => fetchModelsDevSnapshotIfChanged(MIRROR, TIMEOUT_MS));

	stubFetch(fakeResponse(FETCH_BODY, 200, 'W/"plain"'));
	const plainSource = (await fetchModelsDevSnapshot(MIRROR, TIMEOUT_MS)).source;
	stubFetch(fakeResponse({}, 500));
	const plainFailure = await rejection("the unconditional fetcher throws on a non-ok status too", () => fetchModelsDevSnapshot(MIRROR, TIMEOUT_MS));

	expect("both thrown errors carry the status the endpoint answered with", [statusFailure.includes("503"), plainFailure.includes("500")], [true, true]);
	expect("the unconditional fetcher records the same source", plainSource, MIRROR);
} finally {
	globalThis.fetch = originalFetch;
}

/* ------------------------------------------------------------------ panel.mjs */

const alphaEntry = { id: "route-a/alpha", name: "acme-alpha", contextWindow: 131072, maxTokens: 16384, reasoningEfforts: { low: "low" }, input: ["text", "image"], compat: { supportsStore: true }, modelOverrides: { temperature: 0.2 } };
const PANEL_PROVIDERS = {
	"route-a": {
		displayName: "Route A",
		api: "openai-responses",
		models: [
			alphaEntry,
			{ id: "route-a/beta" },
			{ id: "" },
			{ id: 42 },
			null,
			"not-a-row"
		]
	},
	"route-b": { models: [{ id: "route-b/gamma" }] }
};
const asked = [];
const HINTS = [{ id: "beta-hint-1" }, { id: "beta-hint-2" }, { id: "beta-hint-3" }, { id: "beta-hint-4" }, { id: "beta-hint-5" }, { id: "beta-hint-6" }, { id: "beta-hint-7" }];

/**
 * Stand in for the plugin's own `inspect`, recording which ids it was asked
 * about: that record is how the suite proves the route filter runs before the
 * lookups instead of after them.
 * @param id - the configured model id.
 * @returns a verdict shaped like the real one.
 */
function inspectStub(id) {
	asked.push(id);
	if (id === "route-a/beta") return { id, chosen: undefined, candidates: [], cataloguedUnder: ["alpha-catalog"], nearby: HINTS };
	return { id, chosen: { route: "alpha-catalog", source: "pi-ai-catalog", contextWindow: 131072, maxTokens: 16384, reasoning: true, input: ["text", "image"] }, candidates: [], cataloguedUnder: [], nearby: [] };
}

const oneRoute = buildMatrix(PANEL_PROVIDERS, inspectStub, "route-a");
expect("naming a route answers just that route", oneRoute.routes.map((route) => route.route), ["route-a"]);
expect("answering one route never inspects another route's models", asked, ["route-a/alpha", "route-a/beta"]);

asked.length = 0;
const everyRoute = buildMatrix(PANEL_PROVIDERS, inspectStub);
expect("omitting the route answers, and inspects, every configured route in stored order", [everyRoute.routes.map((route) => route.route), asked], [["route-a", "route-b"], ["route-a/alpha", "route-a/beta", "route-b/gamma"]]);

asked.length = 0;
expect("asking for a route that is not configured answers nothing and costs no inspections", [buildMatrix(PANEL_PROVIDERS, inspectStub, "route-absent").routes, asked], [[], []]);
expect("no stored providers means no routes, and a profile that is not an object is skipped", [buildMatrix(undefined, inspectStub).routes, buildMatrix({ "route-null": null, "route-text": "nope", "route-real": { models: [] } }, inspectStub).routes.map((route) => route.route)], [[], ["route-real"]]);

const rows = oneRoute.routes[0].models;
const [alpha, beta] = rows;
expect("only rows with a usable id are kept, and a display name only when it was declared", [rows.map((row) => row.id), "name" in alpha, "name" in beta], [["route-a/alpha", "route-a/beta"], true, false]);
expect("the stored entry travels with the row, copied rather than aliased, with unowned keys intact", [alpha.stored === alphaEntry, alpha.stored.compat, alpha.stored.modelOverrides], [false, { supportsStore: true }, { temperature: 0.2 }]);
expect("declared carries the four fields the panel manages and nothing else, and is empty for a row that declares nothing", [Object.keys(alpha.declared), beta.declared], [["contextWindow", "maxTokens", "reasoningEfforts", "input"], {}]);
expect("a matched row reports the verdict the runtime chose", alpha.matched, { route: "alpha-catalog", source: "pi-ai-catalog", contextWindow: 131072, maxTokens: 16384, reasoning: true, input: ["text", "image"] });
expect("a matched row carries no hints, and an unmatched row carries no match", ["nearby" in alpha, "matched" in beta], [false, false]);
expect("an unmatched row's hint list is capped, in rank order", beta.nearby.map((hint) => hint.id), ["beta-hint-1", "beta-hint-2", "beta-hint-3", "beta-hint-4", "beta-hint-5"]);
expect("an unmatched row reports where the catalog files the id, and an empty list is not reported", [beta.cataloguedUnder, "cataloguedUnder" in alpha], [["alpha-catalog"], false]);
expect("the payload names its namespace, its reported fields and its written ones", [oneRoute.namespace, oneRoute.fields, oneRoute.editable], ["llm-pi-ai", ["contextWindow", "maxTokens", "reasoningEfforts", "input"], ["reasoningEfforts", "input"]]);
expect("a route keeps its display name and api when declared, and carries neither when not", [[oneRoute.routes[0].displayName, oneRoute.routes[0].api], ["displayName" in everyRoute.routes[1], "api" in everyRoute.routes[1]]], [["Route A", "openai-responses"], [false, false]]);
/* The least a verdict may carry: the real `inspect` omits `nearby` for a match,
 * so a verdict without it has to be as usable as one without hints. */
expect("a verdict may carry nothing but its chosen row and its catalogued routes", buildMatrix({ "route-min": { models: [{ id: "route-min/one" }] } }, () => ({ chosen: undefined, cataloguedUnder: [] })).routes[0].models[0], { id: "route-min/one", stored: { id: "route-min/one" }, declared: {} });

const storedEntry = { id: "route-a/alpha", name: "acme-alpha", contextWindow: 131072, maxTokens: 16384, reasoningEfforts: { low: "low" }, input: ["text"], compat: { supportsStore: true } };
const storedBefore = JSON.parse(JSON.stringify(storedEntry));
const written = applyChoice(storedEntry, { reasoningEfforts: { high: "high" }, input: ["text", "image"] });
expect("a cleared field is deleted rather than stored as undefined", Object.keys(applyChoice(storedEntry, { reasoningEfforts: "", input: null })), ["id", "name", "contextWindow", "maxTokens", "compat"]);
expect("a write stores the fields the panel owns and leaves keys it does not own alone", [written.reasoningEfforts, written.input, written.compat], [{ high: "high" }, ["text", "image"], { supportsStore: true }]);
expect("the capacity pair is never written from the panel and survives clearing everything it owns", [applyChoice(storedEntry, { contextWindow: 1, maxTokens: 2 }).contextWindow, applyChoice(storedEntry, { reasoningEfforts: "", input: "" }).maxTokens], [131072, 16384]);
expect("an empty list is a choice, not a clear", applyChoice({ id: "model" }, { input: [] }), { id: "model", input: [] });
expect("an absent choice declares nothing at all", applyChoice(storedEntry, undefined), { id: "route-a/alpha", name: "acme-alpha", contextWindow: 131072, maxTokens: 16384, compat: { supportsStore: true } });
expect("a write keeps the entry's own key order, so the settings file does not churn", Object.keys(applyChoice(storedEntry, { reasoningEfforts: { low: "low" }, input: ["text"] })), Object.keys(storedEntry));
expect("the entry handed in is not mutated, and a new object comes back", [storedEntry, applyChoice(storedEntry, {}) === storedEntry], [storedBefore, false]);

const firstRow = { id: "route-a/alpha" };
const secondRow = { id: "route-a/beta" };
expect("one save writes the whole model array of one route, as given", [buildOps("route-a", [firstRow, secondRow]), buildOps("route-a", [firstRow])[0].value[0] === firstRow], [[{ op: "set", path: ["providers", "route-a", "models"], value: [firstRow, secondRow] }], true]);
expect("an emptied catalog still writes an array", buildOps("route-a", []), [{ op: "set", path: ["providers", "route-a", "models"], value: [] }]);

/* ---------------------------------------------------------------------- done */

finish();
