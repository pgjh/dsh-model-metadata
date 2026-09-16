/**
 * harness.mjs — the scaffolding every suite in this directory shares.
 *
 * Each suite used to carry its own copy of the same four helpers: an `expect`
 * that stringifies both sides, a temp directory it remembered to delete at the
 * end, the same Cordis context stub for driving `apply()`, and — in the browser
 * tools — the same client-module shim. Copies drift: one of them grew a
 * `JSON.parse` of a child's stdout, another forgot to clean up on a thrown
 * assertion, and the third lost a helper entirely while still calling it.
 *
 * @module dsh-model-metadata/tests/harness
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A suite's assertion bookkeeping and its exit contract: print `N/M assertions
 * passed`, list every failure, and exit non-zero when anything failed.
 * @param label - how the suite names itself in its summary.
 * @returns `{ expect, ok, passed, finish }`.
 */
export function suite(label) {
	const failures = [];
	let checks = 0;
	return {
		/** Assert deep equality, with both sides printed on failure. */
		expect(name, actual, wanted) {
			checks++;
			if (JSON.stringify(actual) !== JSON.stringify(wanted)) failures.push(`${name}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
		},
		/** Assert a plain condition, for the cases deep equality cannot express. */
		ok(name, condition, detail = "") {
			checks++;
			if (condition !== true) failures.push(`${name}${detail === "" ? "" : ` — ${detail}`}`);
		},
		/** The number of assertions made so far. */
		passed() {
			return checks - failures.length;
		},
		/**
		 * Print the failures and then the summary, and exit non-zero if anything
		 * failed. The summary is the last line on purpose: that is the line a wrapper
		 * reads, and it must survive whatever a failing assertion printed above it.
		 */
		finish() {
			for (const failure of failures) console.log(`FAIL ${failure}`);
			console.log(`${String(checks - failures.length)}/${String(checks)} assertions passed${label === undefined ? "" : ` (${label})`}`);
			if (failures.length > 0) process.exitCode = 1;
		}
	};
}

/**
 * A scratch directory that cleans itself up.
 *
 * Outside the checkout on purpose: a suite that dies between `mkdir` and its
 * last line used to leave a directory inside the repository, invisible to
 * `.gitignore` patterns that only match directories, and two concurrent runs of
 * the same suite used to share one path. The pid keeps them apart, and the exit
 * and signal hooks cover the pathological cases.
 * @param tag - a short name for the directory, to make a leftover identifiable.
 * @returns the directory, a file-path helper, and an explicit cleanup.
 */
export function sandbox(tag) {
	const dir = mkdtempSync(join(tmpdir(), `dsh-mm-${tag}-${String(process.pid)}-`));
	const clean = () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* A leftover temp directory is not worth failing a test over. */
		}
	};
	process.on("exit", clean);
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			clean();
			process.exit(130);
		});
	}
	return {
		dir,
		/** An absolute path inside the sandbox. */
		file(...parts) {
			return join(dir, ...parts);
		},
		/** Write a file inside the sandbox, creating parents as needed. */
		write(name, contents) {
			const path = join(dir, name);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, contents);
			return path;
		},
		clean
	};
}

/** A logger that swallows everything, plus one that records warnings. */
export function quietLogger() {
	const noop = () => {};
	return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * A logger that keeps what it was told, so a suite can assert what a user would
 * have seen in the log.
 * @returns `{ logger, lines, warnings }`.
 */
export function recordingLogger() {
	const lines = [];
	const warnings = [];
	const push = (into) => (...args) => into.push(args.map((value) => String(value)).join(" "));
	return { logger: { debug: push(lines), info: push(lines), warn: push(warnings), error: push(warnings) }, lines, warnings };
}

/**
 * The slice of a Cordis context a plugin needs to apply and hand back its
 * adapter, which is how every headless adapter suite drives the real seam.
 * @param logger - the logger the plugin should receive.
 * @returns `{ ctx, captured }`; `captured.adapter` is set once the adapter applies.
 */
export function cordisContext(logger = quietLogger()) {
	const captured = {};
	const noop = () => {};
	return {
		captured,
		ctx: {
			get: () => undefined,
			inject: noop,
			logger,
			llm: {
				registerConfigurableProviders: () => ({ replace: noop }),
				registerModelDiscovery: noop,
				registerAdapter: (_routes, adapter) => {
					captured.adapter = adapter;
					return { replace: noop };
				}
			}
		}
	};
}

/**
 * Load the browser bundle the way DSH's client module system does, so the suites
 * exercise the shipped file rather than a copy of its helpers.
 *
 * The module system hands a bundle a `require`; this stands in for the four
 * modules the bundle asks for and records every specifier it requested, which is
 * how the suite can tell that the pickers are DSH's own components.
 * @param bundlePath - absolute path to `client.js`.
 * @returns `{ registration, exportsOf, required }`.
 */
export async function loadBundle(bundlePath) {
	let registration;
	const previous = globalThis.window;
	globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry; } } };
	try {
		await import(`${pathToFileURL(bundlePath).href}?test=${String(Date.now())}`);
	} finally {
		globalThis.window = previous;
	}
	if (registration === undefined) throw new Error(`${bundlePath} did not register with window.__ModuleLoader__`);
	const required = [];
	const exportsOf = registration.factory((specifier) => {
		required.push(specifier);
		if (specifier === "react") return reactShim;
		if (specifier === "react-dom") return { createPortal: (element, container) => ({ type: "portal", container, element }) };
		if (specifier === "react-dom/client") return { createRoot: () => ({ render: () => {}, unmount: () => {} }) };
		if (specifier === "@deepseek-ai/dsh-client-ui-primitives") {
			return {
				Menu: (props) => ({ type: "menu", props }),
				IconChevronDownOutline14: (props) => ({ type: "chevron", props })
			};
		}
		throw new Error(`the client bundle required unexpected module "${specifier}"`);
	});
	return { registration, exportsOf, required };
}

/**
 * Just enough React to call a component function and walk its element tree.
 *
 * Deliberately not a renderer: the suites assert the element tree and the props,
 * which is where every defect this shim can see would show up. Hooks are
 * one-shot (`useState` returns its initial value and a no-op setter), so a
 * component's *behaviour across renders* is the browser tool's job, not this one.
 */
export const reactShim = {
	Fragment: Symbol.for("react.fragment"),
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useRef: (initial) => ({ current: initial }),
	useEffect: () => {},
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	/*
	 * `React.memo`'s result carries the comparator, and a suite that could not see it
	 * could not assert the one property the memo depends on: that a prop it compares by
	 * reference keeps that reference across renders. Dropping it here is what let the
	 * defeated memo live unnoticed.
	 */
	memo: (component, compare) => {
		const memoized = (props) => component(props);
		if (compare !== undefined) memoized.compare = compare;
		return memoized;
	},
	Component: class Component {}
};

/**
 * Flatten an element tree into a list, so an assertion can look for a node by
 * shape instead of by position.
 * @param node - an element, an array of them, or a leaf.
 * @returns every element in the tree, depth first.
 */
export function walkElements(node) {
	const found = [];
	const visit = (current) => {
		if (Array.isArray(current)) {
			for (const child of current) visit(child);
			return;
		}
		if (current === null || current === undefined || typeof current !== "object") return;
		found.push(current);
		for (const child of Array.isArray(current.children) ? current.children : []) visit(child);
	};
	visit(node);
	return found;
}
