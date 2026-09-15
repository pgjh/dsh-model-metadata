/**
 * panel.mjs — the data the settings panel renders, and the settings ops a save
 * writes. Pure functions with no I/O: the host route, the client build and the
 * tests all go through this one place, so the panel can never disagree with what
 * the runtime resolves.
 *
 * @module dsh-model-metadata/panel
 */

/** The one settings section both halves talk to. */
export const SETTINGS_NAMESPACE = "llm-pi-ai";

/**
 * The per-model fields the panel reads: what it reports, and what a merge must
 * leave intact when the user has declared one of them by hand.
 */
export const PANEL_FIELDS = ["contextWindow", "maxTokens", "reasoningEfforts", "input"];

/**
 * The subset the panel writes. `contextWindow`/`maxTokens` are the shipped
 * editor's own 容量 disclosure — the same stored fields, in the same
 * `providers.<route>.models[]` array — so writing them from here as well would be
 * two controls for one fact, with no way for the user to tell which one wins.
 */
export const EDITABLE_FIELDS = ["reasoningEfforts", "input"];

/**
 * One row's stored fields, as the panel compares them against a match.
 * @param entry - one stored `models[]` entry.
 * @returns the four fields the panel manages, absent when undeclared.
 */
function declaredOf(entry) {
	const declared = {};
	for (const key of PANEL_FIELDS) if (entry[key] !== undefined) declared[key] = entry[key];
	return declared;
}

/**
 * The whole panel payload: every configured route and model, with what the
 * fallback matched for it.
 *
 * Borrowed metadata is reported, never applied here: the panel shows the user
 * what the runtime would use, so a row left alone keeps following the chain
 * (a new catalog release can still correct it), while a row the user edits
 * becomes an explicit declaration that wins from then on.
 * @param providers - the stored `llm-pi-ai.providers` section.
 * @param inspect - the plugin's own `inspect(id)` verdict, keyed by model id.
 * @returns the routes, in stored order, each with its models.
 */
export function buildMatrix(providers, inspect) {
	const routes = [];
	for (const [route, profile] of Object.entries(providers ?? {})) {
		if (profile === null || typeof profile !== "object") continue;
		const models = [];
		for (const entry of profile.models ?? []) {
			if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.length === 0) continue;
			const view = inspect(entry.id);
			models.push({
				id: entry.id,
				...typeof entry.name === "string" ? { name: entry.name } : {},
				/* The stored entry verbatim: the client bases its merge on this so a
				 * field neither half owns (`compat`, a future build's key) survives. */
				stored: { ...entry },
				declared: declaredOf(entry),
				...view.chosen === undefined ? {} : { matched: {
					route: view.chosen.route,
					source: view.chosen.source,
					contextWindow: view.chosen.contextWindow,
					maxTokens: view.chosen.maxTokens,
					reasoning: view.chosen.reasoning === true,
					input: view.chosen.input
				} },
				...view.cataloguedUnder.length === 0 ? {} : { cataloguedUnder: view.cataloguedUnder }
			});
		}
		routes.push({
			route,
			...typeof profile.displayName === "string" ? { displayName: profile.displayName } : {},
			...typeof profile.api === "string" ? { api: profile.api } : {},
			models
		});
	}
	return { namespace: SETTINGS_NAMESPACE, fields: [...PANEL_FIELDS], editable: [...EDITABLE_FIELDS], routes };
}

/**
 * Merge one row's panel choices into its stored entry.
 *
 * The stored entry is the base, so a field the panel does not manage (`compat`,
 * `modelOverrides`, anything a future build adds) survives untouched. A blank or
 * cleared field is deleted rather than written as `undefined`, which is what
 * makes "leave this one to the chain" expressible. Only {@link EDITABLE_FIELDS}
 * are visited — see the note there about the capacity pair.
 * @param entry - the stored `models[]` entry.
 * @param choice - the panel's values for {@link EDITABLE_FIELDS}.
 * @returns the entry to store.
 */
export function applyChoice(entry, choice) {
	const next = { ...entry };
	for (const key of EDITABLE_FIELDS) {
		const value = choice?.[key];
		if (value === undefined || value === null || value === "") Reflect.deleteProperty(next, key);
		else next[key] = value;
	}
	return next;
}

/**
 * The path ops one save sends to `settings.mutate`.
 *
 * The whole `models` array is written, not per-row path ops: that is exactly what
 * the shipped Models page does, and it keeps the array's order and the user's
 * untouched keys under the panel's control instead of the settings layer's.
 * @param route - the provider route whose catalog changed.
 * @param models - the rows to store, in order.
 * @returns the ops to write into {@link SETTINGS_NAMESPACE}.
 */
export function buildOps(route, models) {
	return [{ op: "set", path: ["providers", route, "models"], value: models }];
}
