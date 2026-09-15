/**
 * packaging.mjs — the one place that knows how this package is laid out, so the
 * installer and the tests cannot disagree about it.
 *
 * Two layouts exist for the same code:
 *
 *   the package (npm / git)   package.json · cordis.patch.yml · lib/*.mjs, lib/client.js
 *   the local flat copy        package.json · index.mjs, client.js, …   (in the DSH home)
 *
 * The flat copy exists because it is what a plain `<home>/plugins/<name>` install can
 * be — no `lib/` indirection, and the home patch points straight at `index.mjs`. Its
 * manifest therefore cannot be copied verbatim: `exports` has to be re-pointed at the
 * flat file names, or the client module system would look for `./lib/client.js` in a
 * directory that has none and the browser half would silently never load.
 *
 * {@link FLAT_SOURCES} is the single source of truth for that copy: what the installer
 * copies, what the installed manifest may point at, and what a relative import inside a
 * flat source is allowed to reach. {@link layoutGaps} is how the installer proves all
 * three agree *before* it writes anything — a new `lib/*.mjs` missing from this list used
 * to produce a copy that was broken at its first import, with nothing said about it.
 *
 * @module dsh-model-metadata/packaging
 */

/** The files of `lib/` the local copy takes, flat, in the installed directory. */
export const FLAT_SOURCES = ["index.mjs", "client.js", "panel.mjs", "names.mjs", "snapshot.mjs", "refresh-snapshot.mjs"];

/**
 * The manifest for a flat install of this package.
 * @param manifest - this package's own `package.json`.
 * @returns the installed manifest: same identity, flat entry points, no dev fields.
 */
export function installedManifest(manifest) {
	return {
		name: manifest.name,
		version: manifest.version,
		description: manifest.description,
		type: manifest.type ?? "module",
		license: manifest.license,
		engines: manifest.engines,
		main: "./index.mjs",
		exports: {
			".": "./index.mjs",
			"./client": "./client.js",
			"./refresh-snapshot": "./refresh-snapshot.mjs",
			"./package.json": "./package.json"
		},
		/* The client half must still announce the platform and what it extends. */
		...(manifest.dsh?.client === undefined ? {} : { dsh: { client: manifest.dsh.client } })
	};
}

/**
 * The row a home-level `cordis.patch.yml` needs to load a flat install.
 * @param directory - the installed directory.
 * @param id - the plugin id.
 * @returns the patch row.
 */
export function homePatchRow(directory, id) {
	return { id, name: `${directory}/index.mjs` };
}

/**
 * The relative specifiers a module's source imports.
 *
 * A flat source's relative import can only resolve when its file is copied next to it,
 * so this is what turns "did we remember to list it?" from a hope into a check.
 * @param source - the module's text.
 * @returns the relative specifiers, in source order.
 */
export function relativeImports(source) {
	const specifiers = [];
	for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.[^"']+)["']/gu)) specifiers.push(match[1]);
	return specifiers;
}

/**
 * Everything that would make a flat install broken, in one answer.
 *
 * Three lists, because there are three ways the layout drifts apart: a listed file that
 * is not in the checkout, an import of a file that is not listed, and a manifest entry
 * point that is not listed (it would 404 the moment the loader followed it).
 * @param manifest - this package's own `package.json`.
 * @param sources - the flat sources' text, by flat name; a name mapped to `undefined` is
 * one this checkout does not have.
 * @returns `{ missing, uncovered, unlisted }` — file names, `{ from, specifier }` rows,
 * and file names.
 */
export function layoutGaps(manifest, sources) {
	const missing = FLAT_SOURCES.filter((name) => sources[name] === undefined);
	const uncovered = [];
	for (const name of FLAT_SOURCES) {
		const source = sources[name];
		if (source === undefined) continue;
		for (const specifier of relativeImports(source)) {
			const target = specifier.replace(/^\.\//u, "");
			if (!FLAT_SOURCES.includes(target)) uncovered.push({ from: name, specifier });
		}
	}
	const installed = installedManifest(manifest);
	const entries = [installed.main, ...Object.values(installed.exports)];
	const unlisted = [...new Set(entries.map((specifier) => specifier.replace(/^\.\//u, "")))].filter((name) => name !== "package.json" && !FLAT_SOURCES.includes(name));
	return { missing, uncovered, unlisted };
}
