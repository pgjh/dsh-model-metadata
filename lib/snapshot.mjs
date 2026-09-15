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
 * ID shapes that are not chat models.
 *
 * models.dev lists image, embedding, speech and moderation endpoints beside the
 * chat models, and their `limit.context` is meaningless for a conversation — the
 * same name can carry wildly different numbers across providers (`gpt-image-2`
 * ranges over five orders of magnitude). A name is only ever *demoted* by this,
 * never dropped, so a gateway alias of a genuinely unknown model still resolves;
 * it only loses to a same-named entry that does look like a chat model.
 */
const NON_CHAT_PATTERNS = [
	/embed/,
	/rerank/,
	/transcribe/,
	/whisper/,
	/text-to-speech/,
	/-tts\b/,
	/^tts-/,
	/moderation/,
	/dall-e/,
	/imagen/,
	/gpt-image/,
	/-image\b/,
	/imagegen/,
	/seedream/,
	/stable-diffusion/,
	/^flux/,
	/-flux/,
	/text-to-video/,
	/video-gen/,
	/ocr/
];

/**
 * Whether an id looks like a non-chat endpoint.
 * @param id - the raw models.dev model id (prefix included).
 * @returns true when the name marks it as an image/embedding/speech model.
 */
export function looksNonChat(id) {
	const text = String(id ?? "").toLowerCase();
	return NON_CHAT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * A key that keeps this row distinct from a row an earlier provider already
 * contributed under the same id.
 *
 * models.dev publishes some ids verbatim under several providers, and this
 * document is keyed by model id — so the second row used to overwrite the first,
 * which silently decided by *file order* whose numbers a name resolves to, and
 * could keep a mirror's row while dropping the model's own vendor. The runtime
 * reduces every key to its bare name (everything after the last `/`), so a
 * disambiguated key costs it nothing and both rows stay available for ranking.
 * @param models - the rows indexed so far.
 * @param id - the id the provider published.
 * @param provider - the provider whose row this is.
 * @returns a key not yet used.
 */
function freeKey(models, id, provider) {
	if (models[id] === undefined) return id;
	const prefixed = `${provider}/${id}`;
	if (models[prefixed] === undefined) return prefixed;
	for (let nth = 2; ; nth++) {
		const candidate = `${provider}/${id}#${String(nth)}`;
		if (models[candidate] === undefined) return candidate;
	}
}

/**
 * Flatten the models.dev database into the snapshot shape.
 *
 * Tolerant by design: a provider without a `models` object is skipped, a malformed
 * row is kept with whatever fields it did carry, and unknown modalities are
 * dropped rather than passed through to a seam that models only text and image.
 * @param raw - the parsed `api.json`.
 * @param url - the endpoint this document came from, recorded so a snapshot
 * fetched from a mirror does not claim to be models.dev's own copy.
 * @param etag - the endpoint's validator for this body, when it sent one.
 * @returns the snapshot document to write (and to read back at runtime).
 */
export function flattenModelsDev(raw, url = SNAPSHOT_URL, etag) {
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
			const name = typeof model.name === "string" ? model.name : id;
			models[freeKey(models, id, provider)] = {
				provider,
				...name === id ? {} : { name },
				...Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {},
				...Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {},
				...input === undefined || input.length === 0 ? {} : { input },
				reasoning: model.reasoning === true,
				...looksNonChat(name) || looksNonChat(id) ? { nonChat: true } : {}
			};
		}
	}
	return {
		fetchedAt: new Date().toISOString(),
		source: url,
		...(typeof etag === "string" && etag.length > 0 ? { etag } : {}),
		providers,
		count: Object.keys(models).length,
		models
	};
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
	if (!response.ok) throw new Error(`${url} answered ${String(response.status)} ${response.statusText}`);
	return flattenModelsDev(await response.json(), url, response.headers?.get?.("etag") ?? undefined);
}

/**
 * Fetch the database only when the copy we already have is out of date.
 *
 * The endpoint publishes a strong ETag, so the common case — "checked, nothing
 * changed" — costs one conditional request and no body. Deliberately separate
 * from {@link fetchModelsDevSnapshot} rather than an option on it: callers that
 * hand over a validator must handle `unchanged`, and a 304 satisfies
 * `response.ok === false`, so folding the two together would turn a successful
 * revalidation into a reported failure.
 *
 * The error names the endpoint that actually answered: a mirror configured
 * through `DSH_PI_AI_CATALOG_SNAPSHOT_URL` used to blame models.dev in the log.
 * @param url - the endpoint to read.
 * @param timeoutMs - how long the fetch may take.
 * @param etag - the validator stored with the local copy, when there is one.
 * @returns `{ unchanged: true }`, or the fresh document and its validator.
 */
export async function fetchModelsDevSnapshotIfChanged(url = SNAPSHOT_URL, timeoutMs = SNAPSHOT_TIMEOUT_MS, etag = undefined) {
	const headers = typeof etag === "string" && etag.length > 0 ? { "if-none-match": etag } : undefined;
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
	if (response.status === 304) return { unchanged: true };
	if (!response.ok) throw new Error(`${url} answered ${String(response.status)} ${response.statusText}`);
	return { snapshot: flattenModelsDev(await response.json(), url, response.headers?.get?.("etag") ?? undefined) };
}
