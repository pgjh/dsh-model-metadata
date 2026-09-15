#!/usr/bin/env node
/**
 * cdp.mjs — the Chrome DevTools Protocol driver the browser tools share.
 *
 * All three browser tools do the same three things: find the launch token, open a fresh
 * headless Chromium, and drive 设置 → 模型 through one page. They used to carry a copy of
 * that driver each, which is how one of them came to call an `option()` helper its copy
 * never defined.
 *
 * `option()` reads *this* process's arguments, so a tool keeps its own flags while sharing
 * the parsing. Node's own WebSocket is used when it exists, so speaking CDP needs no DSH
 * install; an older Node falls back to the `ws` copy that ships with the install.
 *
 * @module dsh-model-metadata/tests/cdp
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromePath, dshInstall } from "../dev-paths.mjs";

const argv = process.argv.slice(2);

/**
 * The value of a `--flag <value>` option from this process's own arguments.
 * @param name - the flag, dashes included.
 * @param fallback - what to answer when the flag is absent.
 * @returns the value, or the fallback.
 */
export function option(name, fallback) {
	const at = argv.indexOf(name);
	return at === -1 ? fallback : argv[at + 1];
}

/** Whether a bare flag is present. */
export const flag = (name) => argv.includes(name);

/** Wait, without a dependency on a timer library. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The launch URL, from `--url` or from the journal of the unit named by DSH_UNIT.
 *
 * Naming the unit is required because no unit name is universal.
 * @returns the tokenised app URL.
 * @throws when neither the flag nor the unit is given, or the journal has no URL.
 */
export function appUrl() {
	const given = option("--url", undefined);
	if (given !== undefined) return given;
	const unit = process.env.DSH_UNIT;
	if (unit === undefined) throw new Error("pass --url \"http://127.0.0.1:3080/?token=…\", or set DSH_UNIT to your systemd unit name to read it from the journal");
	const line = execFileSync("journalctl", ["--user", "-u", unit, "--no-pager"], { encoding: "utf8" });
	const matches = [...line.matchAll(/dsh web: (http:\S+token=\S+)/gu)];
	if (matches.length === 0) throw new Error(`no launch URL in the journal of "${unit}"; pass --url instead`);
	return matches[matches.length - 1][1];
}

/**
 * A WebSocket constructor for the DevTools socket.
 * @returns the global WebSocket, or the installed `ws` when this Node has none.
 */
function webSocket() {
	if (typeof globalThis.WebSocket === "function") return globalThis.WebSocket;
	try {
		const require = createRequire(join(dshInstall(), "node_modules", "noop.js"));
		return require("ws");
	} catch (error) {
		throw new Error(`no WebSocket available: this Node has none, and no installed ws was found (${error instanceof Error ? error.message : String(error)})`);
	}
}

/**
 * Wait for the DevTools HTTP endpoint to answer with a page target.
 * @param port - the remote-debugging port.
 * @returns the page target's WebSocket URL.
 */
async function debuggerUrl(port) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
			const targets = await response.json();
			const page = targets.find((target) => target.type === "page");
			if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("chromium never exposed a page target");
}

/**
 * Open the app in a fresh headless Chromium and hand back a CDP session.
 * @param url - the tokenised app URL to navigate to.
 * @param options - `{ port, window, profile, readyMs }`: the debugging port, the window
 * size, the profile directory (removed on exit), and how long to let the app settle after
 * `document.readyState` turns complete.
 * @returns `{ send, evaluate, click, logs, exceptions, chromeErrors, close }`.
 */
export async function openPage(url, options = {}) {
	const port = Number(options.port ?? 9333);
	const profile = options.profile;
	if (typeof profile !== "string" || profile.length === 0) throw new Error("openPage needs a profile directory to keep Chromium out of the repository");
	rmSync(profile, { recursive: true, force: true });
	mkdirSync(profile, { recursive: true });
	/* A crash must not leave a Chromium profile (and its device ids) inside the repository. */
	process.on("exit", () => rmSync(profile, { recursive: true, force: true }));
	const chrome = spawn(options.chrome ?? chromePath(), [
		"--headless=new",
		`--remote-debugging-port=${String(port)}`,
		`--user-data-dir=${profile}`,
		"--no-sandbox",
		"--disable-gpu",
		"--disable-dev-shm-usage",
		`--window-size=${options.window ?? "1400,1000"}`,
		"about:blank"
	], { stdio: ["ignore", "ignore", "pipe"] });
	let chromeErrors = "";
	chrome.stderr.on("data", (chunk) => { chromeErrors += String(chunk); });

	const Socket = webSocket();
	const socket = new Socket(await debuggerUrl(port));
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("chromium's DevTools socket would not open")));
	});

	let nextId = 0;
	const pending = new Map();
	const logs = [];
	const exceptions = [];
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
		if (message.id !== undefined) {
			const waiter = pending.get(message.id);
			if (waiter !== undefined) {
				pending.delete(message.id);
				message.error === undefined ? waiter.resolve(message.result) : waiter.reject(new Error(JSON.stringify(message.error)));
			}
			return;
		}
		if (message.method === "Runtime.consoleAPICalled") logs.push(`[console.${String(message.params.type)}] ${message.params.args.map((arg) => String(arg.value ?? arg.description ?? arg.type)).join(" ")}`);
		else if (message.method === "Runtime.exceptionThrown") {
			const line = String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
			exceptions.push(line);
			logs.push(`[exception] ${line}`);
		} else if (message.method === "Log.entryAdded") logs.push(`[log.${String(message.params.entry.level)}] ${String(message.params.entry.text)}`);
	});
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const id = ++nextId;
		pending.set(id, { resolve, reject });
		socket.send(JSON.stringify({ id, method, params }));
	});
	const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

	await send("Page.enable");
	await send("Runtime.enable");
	await send("Log.enable");
	await send("Page.navigate", { url });
	for (let attempt = 0; attempt < 60 && (await evaluate("document.readyState")) !== "complete"; attempt++) await sleep(250);
	await sleep(options.readyMs ?? 2500);

	/**
	 * Click the first leaf element whose trimmed text matches: exactly, then by
	 * containment, then by accessible label.
	 * @param text - the visible label to click.
	 * @returns whether something was clicked.
	 */
	const click = async (text) => evaluate(`(() => {
	const wanted = ${JSON.stringify(text)};
	const all = [...document.querySelectorAll("button, a, li, div, span, p")];
	const exact = all.find((node) => node.children.length === 0 && node.textContent.trim() === wanted);
	const contains = all.find((node) => node.children.length === 0 && node.textContent.includes(wanted));
	const labelled = document.querySelector(\`[aria-label*=\${JSON.stringify(wanted)}]\`);
	const hit = exact ?? contains ?? labelled;
	if (hit === undefined || hit === null) return false;
	hit.click();
	return true;
})()`);

	/** Tear the page down and leave no profile behind. */
	const close = () => {
		socket.close();
		chrome.kill("SIGKILL");
		rmSync(profile, { recursive: true, force: true });
	};

	return { socket, chrome, send, evaluate, click, logs, exceptions, chromeErrors: () => chromeErrors, close };
}
