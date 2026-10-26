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

/**
 * Deployment qualifiers a *configured* name may carry on top of the catalog's
 * spelling, unlike {@link NAME_SUFFIXES} which only the catalog may carry.
 *
 * A gateway frequently publishes the same model twice: once under the model's
 * own name and once marked as the deployment serving it (`-official`, `-self`).
 * The marked row is the same model — a gateway alias, not a different endpoint
 * with its own window, which is why `-free` is *not* on this list.
 *
 * The direction is the opposite of {@link NAME_SUFFIXES} on purpose: these are
 * removed from the configured name, never appended to it, so a catalog entry can
 * never be reached by inventing a qualifier. They are also a last resort (see
 * {@link deploymentKeys}): a catalog row that carries the qualifier itself still
 * wins over the stripped spelling.
 */
export const DEPLOYMENT_QUALIFIERS = ["self", "official"];

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

/**
 * The keys to try only after {@link normalizedKeys} found nothing: a configured
 * name carrying one of the {@link DEPLOYMENT_QUALIFIERS} read as the name
 * without it.
 *
 * A qualifier has to be a separate trailing word (`deepseek-v4.1-flash-self`),
 * never a substring (`myself`), because a name that merely ends in those letters
 * is not a deployment marker. Qualifiers stack (`foo-official-self`), and each
 * stripped spelling still gets the append-only decorations the catalog may carry
 * on top, so a qualified alias of a `-exp` entry is reached too.
 *
 * Deliberately not part of `normalizedKeys`: these keys lose to every
 * append-only hit, so a catalog model that really is called
 * `deepseek-v4.1-flash-self` is never swapped for its unqualified sibling merely
 * because both exist.
 * @param bare - the bare name being resolved.
 * @returns the fallback keys, empty when the name carries no qualifier.
 */
export function deploymentKeys(bare) {
	const text = String(bare ?? "");
	const words = text.toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length > 0);
	const keys = [];
	let norm = normalizeName(text);
	let stripped = 0;
	while (words.length - stripped >= 2) {
		const qualifier = words[words.length - 1 - stripped];
		if (!DEPLOYMENT_QUALIFIERS.includes(qualifier)) break;
		/* A name made only of qualifiers (`self-self`) must not decay to `self`. */
		if (!words.slice(0, words.length - stripped - 1).some((word) => !DEPLOYMENT_QUALIFIERS.includes(word))) break;
		stripped++;
		norm = norm.slice(0, norm.length - qualifier.length);
		if (norm.length < MIN_NORMALIZED_LENGTH) break;
		for (const key of [norm, ...NAME_SUFFIXES.map((suffix) => norm + suffix)]) {
			if (!keys.includes(key)) keys.push(key);
		}
	}
	return keys;
}
