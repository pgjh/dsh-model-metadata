/**
 * names.mjs — how this plugin reads a model name, in exactly one place.
 *
 * The name rules are used by the runtime resolver, by the refresh CLI's coverage
 * report and by the tests. They used to be re-implemented in each of those, which
 * meant a rule could be fixed in one place and stay broken in another: the CLI
 * reported a model as "still uncovered" that the runtime matched happily, only
 * because the CLI compared bare ids for equality while the runtime also folds
 * separators and display names.
 *
 * @module dsh-model-metadata/names
 */

/** Bare name of a model id: everything after the last `/`. */
export function bareName(id) {
	const at = String(id ?? "").lastIndexOf("/");
	return at === -1 ? String(id ?? "") : String(id ?? "").slice(at + 1);
}

/**
 * The relaxed spelling a name is compared under once the exact forms miss:
 * lowercase, then every run of non-alphanumerics folded away. `v4.1-flash`,
 * `v41-flash` and "V41 Flash" all collapse to `v41flash`, which is the spelling
 * difference a gateway alias almost always is.
 * @param text - a model id or a display name.
 * @returns the separator-free lowercase form.
 */
export function normalizeName(text) {
	return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Trailing decorations a configured name may lack while still naming the same
 * model: `DeepSeek-V4-Flash-Vision` is the catalog's
 * `deepseek-v4-flash-vision-exp`. Compared normalized (no separators), so `-exp`
 * and `-experimental` differ. Kept in sync with the README's list by the suite.
 */
export const NAME_SUFFIXES = ["exp", "experimental", "latest", "preview", "free"];

/** A normalized key short enough to be coincidence rather than a name. */
export const MIN_NORMALIZED_LENGTH = 4;

/**
 * Every normalized key a configured name is looked up under, exact spelling
 * first and then once per decoration it may be missing.
 *
 * Deliberately one-directional: the catalog may carry a decoration the
 * configured name lacks (`-exp`), but a configured name that carries one the
 * catalog lacks is a different model as far as this plugin is concerned. Adding
 * the reverse direction would make `gpt-4o-free` and `gpt-4o` interchangeable,
 * which is wrong the other way round — a `-free` endpoint is frequently a
 * different deployment with a smaller window.
 * @param bare - the bare name being resolved.
 * @returns the keys to try against the normalized index, possibly empty.
 */
export function normalizedKeys(bare) {
	const norm = normalizeName(bare);
	if (norm.length < MIN_NORMALIZED_LENGTH) return [];
	return [norm, ...NAME_SUFFIXES.map((suffix) => norm + suffix)];
}
