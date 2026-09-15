/**
 * dev-paths.mjs — where the development tools find the DSH install and a browser.
 *
 * Nothing here is hardcoded to one machine's home directory: these scripts ship with the
 * repository, so every location is either taken from an environment variable or
 * discovered from this process's own layout (the Node that runs the script knows where
 * its global `node_modules` is).
 *
 *   DSH_INSTALL   the DSH package directory, or a `lib` directory holding node_modules
 *   CHROME        a Chromium executable for the two browser tools
 *
 * @module dsh-model-metadata/dev-paths
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Candidate `lib` directories: each one's `node_modules` may hold the packages the tools
 * need. The layout this process runs under comes first, because it is the one that
 * certainly exists; the DSH_HOME profile keeps its own copies for a profile install.
 * @returns absolute `lib` directories, most specific first.
 */
function libRoots() {
	const home = process.env.HOME ?? "";
	const dshHome = process.env.DSH_HOME ?? join(home, ".dsh");
	const configured = process.env.DSH_INSTALL;
	const roots = [];
	/* A DSH_INSTALL that points at the package itself is used verbatim; a lib dir is a root. */
	if (configured !== undefined && configured.length > 0) {
		roots.push(existsSync(join(configured, "package.json")) ? dirname(configured) : configured);
	}
	roots.push(join(dirname(process.execPath), "..", "lib"));
	roots.push(join(dshHome, "profiles"));
	roots.push("/usr/local/lib");
	roots.push("/usr/lib");
	return [...new Set(roots)];
}

/**
 * The first `lib` root whose `node_modules` holds a given package.
 * @param specifier - the package to look for.
 * @returns the `lib` directory, or undefined.
 */
function rootWith(specifier) {
	for (const root of libRoots()) {
		if (existsSync(join(root, "node_modules", specifier, "package.json"))) return root;
	}
	return undefined;
}

/**
 * The `node_modules` directory the tools should load DSH packages from.
 * @returns the absolute directory, or undefined when DSH is not installed here.
 */
export function nodeModulesDir() {
	const root = rootWith("@deepseek-ai/dsh-llm-pi-ai");
	return root === undefined ? undefined : join(root, "node_modules");
}

/**
 * The installed DSH package directory.
 * @returns the absolute directory.
 * @throws when DSH cannot be found, naming the variable that would settle it.
 */
export function dshInstall() {
	const root = rootWith("@deepseek-ai/dsh");
	if (root === undefined) throw new Error("cannot find an installed @deepseek-ai/dsh; set DSH_INSTALL to its directory or to the lib directory that contains it");
	return join(root, "node_modules", "@deepseek-ai/dsh");
}

/**
 * The pi-ai adapter entry the tools drive directly.
 *
 * Built from the directory rather than resolved through the package: its `exports` map
 * does not expose this path, so a specifier resolution is refused even though the file is
 * right there.
 * @returns the absolute file path.
 */
export function adapterEntry() {
	const root = rootWith("@deepseek-ai/dsh-llm-pi-ai");
	if (root === undefined) throw new Error("cannot find @deepseek-ai/dsh-llm-pi-ai; set DSH_INSTALL to a lib directory that contains it");
	return join(root, "node_modules", "@deepseek-ai/dsh-llm-pi-ai", "lib", "index.js");
}

/**
 * A Chromium executable for the browser-driven tools.
 *
 * Order: `CHROME` (or `PLAYWRIGHT_CHROME`), then the newest Playwright download under the
 * user's cache, then whatever Chromium this machine has on PATH.
 * @returns the absolute executable path.
 * @throws when nothing is found, naming the variable that would settle it.
 */
export function chromePath() {
	const configured = process.env.CHROME ?? process.env.PLAYWRIGHT_CHROME;
	if (configured !== undefined && configured.length > 0) return configured;
	const cache = join(process.env.HOME ?? "", ".cache", "ms-playwright");
	if (existsSync(cache)) {
		/* Newest first, and a full browser before the headless shell: the tools drive a
		 * real page (screenshots included), which is what the browser build is for. */
		const builds = readdirSync(cache)
			.filter((name) => name.startsWith("chromium"))
			.sort((left, right) => (left.startsWith("chromium-") === right.startsWith("chromium-") ? right.localeCompare(left) : left.startsWith("chromium-") ? -1 : 1));
		for (const build of builds) {
			for (const layout of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
				const candidate = join(cache, build, layout);
				if (existsSync(candidate)) return candidate;
			}
		}
	}
	for (const command of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
		try {
			const found = execFileSync("which", [command], { encoding: "utf8" }).trim();
			if (found.length > 0) return found;
		} catch {
			/* not on PATH */
		}
	}
	throw new Error("no Chromium found; set CHROME to its executable path");
}
