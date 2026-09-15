/**
 * packaging.mjs — the one place that knows how this package is laid out, so the
 * installer and the tests cannot disagree about it.
 *
 * Two layouts exist for the same code:
 *
 *   the package (npm / git)   package.json · cordis.patch.yml · lib/*.mjs, lib/client.js
 *   the local flat copy        package.json · index.mjs, client.js, …   (in ~/.dsh/plugins/<name>)
 *
 * The flat copy exists because it is what a plain `~/.dsh/plugins/<name>` install can
 * be — no `lib/` indirection, and the home patch points straight at `index.mjs`. Its
 * manifest therefore cannot be copied verbatim: `exports` has to be re-pointed at the
 * flat file names, or the client module system would look for `./lib/client.js` in a
 * directory that has none and the browser half would silently never load.
 *
 * @module dsh-model-metadata/packaging
 */

/** The files of `lib/` the local copy takes, flat, in the installed directory. */
export const FLAT_SOURCES = ["index.mjs", "client.js", "panel.mjs", "snapshot.mjs", "refresh-snapshot.mjs"];

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
