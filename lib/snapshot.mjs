/**
 * snapshot.mjs — the models.dev source of truth, shared by the plugin and the
 * refresh CLI so both produce and read exactly the same shape.
 *
 * models.dev publishes one big `api.json` keyed by provider, and the runtime
 * wants a flat, cheap-to-read index keyed by model id. Flattening here (rather
 * than at read time) is what lets the plugin's synchronous resolution path do
 * one `JSON.parse` and no transformation.
 *
 * @module dsh-model-metadata/snapshot
 */

/** Where the raw database lives. */
export const SNAPSHOT_URL = "https://models.dev/api.json";

/** How long a fetch may take before it is abandoned (models.dev is ~5 MB). */
export const SNAPSHOT_TIMEOUT_MS = 180000;

/** The modalities DSH models; anything else models.dev reports is dropped. */
const MODALITIES = ["text", "image"];

/**
 * Flatten the models.dev database into the snapshot shape.
 *
 * Tolerant by design: a provider without a `models` object is skipped, a malformed
 * row is kept with whatever fields it did carry, and unknown modalities are
 * dropped rather than passed through to a seam that models only text and image.
 * @param raw - the parsed `api.json`.
 * @returns the snapshot document to write (and to read back at runtime).
 */
export function flattenModelsDev(raw) {
	const models = {};
	let providers = 0;
	for (const [provider, entry] of Object.entries(raw ?? {})) {
		const listed = entry?.models;
		if (listed === null || typeof listed !== "object") continue;
		providers++;
		for (const [id, model] of Object.entries(listed)) {
			if (model === null || typeof model !== "object") continue;
			const contextWindow = model.limit?.context;
			const maxTokens = model.limit?.output;
			const input = Array.isArray(model.modalities?.input) ? model.modalities.input.filter((modality) => MODALITIES.includes(modality)) : undefined;
			models[id] = {
				provider,
				...typeof model.name === "string" ? { name: model.name } : {},
				...Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {},
				...Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {},
				...input === undefined || input.length === 0 ? {} : { input },
				reasoning: model.reasoning === true
			};
		}
	}
	return { fetchedAt: new Date().toISOString(), source: SNAPSHOT_URL, providers, count: Object.keys(models).length, models };
}

/**
 * Fetch and flatten the database.
 * @param url - the endpoint to read.
 * @param timeoutMs - how long the fetch may take.
 * @returns the snapshot document.
 * @throws whatever the fetch throws; callers keep their previous data.
 */
export async function fetchModelsDevSnapshot(url = SNAPSHOT_URL, timeoutMs = SNAPSHOT_TIMEOUT_MS) {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`models.dev answered ${String(response.status)} ${response.statusText}`);
	return flattenModelsDev(await response.json());
}
