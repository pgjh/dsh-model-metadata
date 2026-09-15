/**
 * client.js — the browser half: per-model reasoning/vision controls inside the
 * shipped Models editor, drawn with DSH's own components.
 *
 * WHY THE CONTROLS ARE HERE AND NOT IN A PANEL OF THEIR OWN. The shipped page lets a
 * provider card declare exactly two child seats — `settings.models.provider-card`
 * (keyed, rendered as a sibling just above the editor) and `settings.models.footer`
 * (list). Neither is inside `renderProviderEditor`, so a declarative plugin cannot put
 * anything into 编辑 → 自定义设置 → 模型目录. This cell therefore renders nothing of its
 * own and *fuses into the editor* instead: when the card's editor is open, the watcher
 * finds its model rows and portals one cell into each, inside that row's own entry.
 * The anchor is the per-row 容量 disclosure button (`aria-expanded`) and its grid, so it
 * holds in any locale.
 *
 * WHY IT IS REACT, AND WHY IT REUSES THE PAGE'S CLASSES. A native `<select>` hands the
 * choice to the platform — on Android that is a full-screen radio sheet, which looks
 * nothing like DSH ("跟 dsh 格格不入"). So the selects are gone: each picker is a `Menu`
 * from `@deepseek-ai/dsh-client-ui-primitives`, the component DSH's own dropdowns use,
 * so the popup, the selection marks, the typography and the theme variables are DSH's
 * rather than ours. The triggers and the write button copy the className of the row's
 * own input and of the catalog's own 添加模型 button, so an injected control is the same
 * widget as its neighbours even if a future build restyles them.
 *
 * WHAT IT EDITS, AND WHAT IT DELIBERATELY DOES NOT. `contextWindow` and `maxTokens`
 * belong to the shipped 容量 disclosure: two boxes for one stored field, and both write
 * the same `providers.<route>.models[]` array, so the user would have to guess which
 * wins. This half therefore only *reports* capacity (declared, else what the chain
 * matched, else the provider default — the one fact the 容量 placeholder cannot show,
 * since it only ever prints the route default). What it edits is the pair upstream has
 * no control for at all: `reasoningEfforts` and `input`. Upstream states the rule
 * itself — "There is deliberately no reasoning-effort control, here or on the editor
 * card."
 *
 * WHEN IT WRITES. Per row, on demand: a row's cell acquires a 「写入」 button the moment
 * it differs from the stored declaration, and it writes that one row through
 * `remote.settings.mutate` after re-reading the matrix, so keys this half does not own
 * (`compat`, …) survive and a concurrent edit is not clobbered. Two guards make that
 * safe to click twice: a row already writing returns immediately (the button is also
 * disabled, but the guard is what closes the race), and the payload is re-read inside
 * the write, not reused from the last render. DSH protects the other direction itself:
 * the editor captures a settings revision when it opens and refuses its own save once
 * ours has moved it ("这张卡片打开期间，这些设置已被其他地方改动"), so a stale draft can never
 * silently drop a reasoning declaration.
 *
 * WHAT IT SAYS, AND IN WHICH LANGUAGE. Every user-visible string lives in the
 * dictionaries below and is read through the page's own locale service, so the fused
 * cells follow the language the rest of the Settings page is in; Simplified Chinese is
 * the key-set source of truth and the fallback when no locale service is present.
 *
 * This file is served as-is (no build step): `dsh.client` in package.json names it, and
 * the client module system wraps it in `window.__ModuleLoader__.load`. The pure helpers
 * here are deliberate twins of ../panel.mjs on the host side; tests/panel.mjs asserts
 * the two agree, since the client bundle cannot import a sibling file.
 */
window.__ModuleLoader__.load({
	id: "dsh-model-metadata",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;
		const createPortal = require("react-dom").createPortal;
		const createRoot = require("react-dom/client").createRoot;
		/* DSH's own dropdown, so this plugin's pickers are the page's pickers. */
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const Menu = primitives.Menu;
		const IconChevronDownOutline14 = primitives.IconChevronDownOutline14;
		const NS = "llm-pi-ai";
		/** The locale namespace this bundle owns; also the key-set source of truth below. */
		const LOCALE_NS = "dsh-model-metadata";
		const MATRIX_URL = "/model-metadata/matrix";
		/*
		 * Read (to report and to preserve), then written. Only the second list is ever
		 * written by this half; the capacity pair is the shipped editor's.
		 */
		const PANEL_FIELDS = ["contextWindow", "maxTokens", "reasoningEfforts", "input"];
		const EDITABLE_FIELDS = ["reasoningEfforts", "input"];
		const VISION = ["follow", "on", "off"];
		/** The menu id that means "not one of the presets: show me the text field". */
		const CUSTOM = "__custom__";
		const LEVEL_PRESETS = [
			["", "levels.preset.follow"],
			["false", "levels.preset.off"],
			["low, medium, high", "levels.preset.lowMidHigh"],
			["off, low, medium, high", "levels.preset.offLowMidHigh"],
			["off, minimal, low, medium, high", "levels.preset.minimal"],
			["off, minimal, low, medium, high, max", "levels.preset.all"]
		];
		const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		const VISION_LABELS = { follow: "vision.follow", on: "vision.on", off: "vision.off" };
		/** The attribute that marks a cell this plugin mounted into an editor row. */
		const CELL_ATTR = "data-model-metadata-cell";

		/** Simplified Chinese: the key-set source of truth for this bundle. */
		const zh = {
			"capacity.output": "输出 {value}",
			"levels.label": "推理等级",
			"levels.preset.follow": "跟随自动匹配",
			"levels.preset.off": "关闭推理（声明不支持）",
			"levels.preset.lowMidHigh": "低 / 中 / 高",
			"levels.preset.offLowMidHigh": "关闭 / 低 / 中 / 高",
			"levels.preset.minimal": "关闭 / 最小 / 低 / 中 / 高",
			"levels.preset.all": "全等级 + max",
			"levels.custom": "自定义…",
			"levels.customHint": "如 low, high, max",
			"levels.customLabel": "自定义：{text}",
			"levels.error.unknown": "未知等级「{level}」，可用：{levels}",
			"levels.error.wire": "等级「{level}」需要线上取值，例如 {level}={level}",
			"levels.aria": "{id} 推理等级",
			"levels.customAria": "{id} 推理等级自定义",
			"vision.label": "视觉",
			"vision.follow": "跟随自动匹配",
			"vision.on": "开启（可收图）",
			"vision.off": "关闭（纯文本）",
			"vision.aria": "{id} 视觉",
			"readout.noMatch": "无匹配：哪里的目录都不认识这个名字，容量请在「容量」里填",
			"readout.siblings": "同家族目录里有：{names}{more}",
			"readout.more": " 等",
			"readout.matched": "自动匹配：{route}",
			"readout.reasoningYes": "有推理等级",
			"readout.reasoningNo": "无推理等级",
			"readout.visionYes": "视觉",
			"readout.visionNo": "纯文本",
			"readout.declaredLevels": "已声明推理等级 {levels}",
			"readout.declaredLevelsEmpty": "已声明推理等级（无）",
			"readout.declaredVisionOn": "已声明视觉 开启",
			"readout.declaredVisionOff": "已声明视觉 关闭",
			"write.action": "写入",
			"write.busy": "写入中…",
			"write.done": "已写入 {id}；显式声明优先于自动匹配。",
			"write.failed": "写入失败：{reason}",
			"write.conflict": "{reason}（请关闭这张卡片再打开，重试一次）",
			"write.noSettings": "写入失败：设置服务不可用（请重新打开设置页）",
			"write.readOnly": "这张卡片是只读的，无法写入（检查 DSH 的设置写入权限）",
			"write.nothing": "没有改动可写入。",
			"write.gone": "该模型已不在配置里，请重新打开这张卡片",
			"write.routeGone": "该提供方已不在配置里",
			"write.noData": "无法重新读取当前配置，请稍后重试",
			"write.rejected": "写入被拒绝",
			"load.failed": "读取匹配结果失败：{reason}",
			"panel.cellFailed": "此行的元数据控件加载失败，请刷新页面"
		};
		/** English dictionary, key for key with `zh`. */
		const en = {
			"capacity.output": "output {value}",
			"levels.label": "Reasoning effort",
			"levels.preset.follow": "Follow auto-match",
			"levels.preset.off": "Reasoning off (declared unsupported)",
			"levels.preset.lowMidHigh": "Low / Medium / High",
			"levels.preset.offLowMidHigh": "Off / Low / Medium / High",
			"levels.preset.minimal": "Off / Minimal / Low / Medium / High",
			"levels.preset.all": "All levels + max",
			"levels.custom": "Custom…",
			"levels.customHint": "e.g. low, high, max",
			"levels.customLabel": "Custom: {text}",
			"levels.error.unknown": "Unknown level \"{level}\"; available: {levels}",
			"levels.error.wire": "Level \"{level}\" needs the value sent upstream, e.g. {level}={level}",
			"levels.aria": "{id} reasoning effort",
			"levels.customAria": "{id} custom reasoning levels",
			"vision.label": "Vision",
			"vision.follow": "Follow auto-match",
			"vision.on": "On (accepts images)",
			"vision.off": "Off (text only)",
			"vision.aria": "{id} vision",
			"readout.noMatch": "No match: no catalog knows this name — set the capacity under 容量",
			"readout.siblings": "Known in this family: {names}{more}",
			"readout.more": " and more",
			"readout.matched": "Auto-matched: {route}",
			"readout.reasoningYes": "has reasoning levels",
			"readout.reasoningNo": "no reasoning levels",
			"readout.visionYes": "vision",
			"readout.visionNo": "text only",
			"readout.declaredLevels": "declared reasoning levels {levels}",
			"readout.declaredLevelsEmpty": "declared reasoning levels (none)",
			"readout.declaredVisionOn": "declared vision on",
			"readout.declaredVisionOff": "declared vision off",
			"write.action": "Write",
			"write.busy": "Writing…",
			"write.done": "Wrote {id}; an explicit declaration wins over the automatic match.",
			"write.failed": "Write failed: {reason}",
			"write.conflict": "{reason} (close and reopen this card, then try again)",
			"write.noSettings": "Write failed: the settings service is unavailable (reopen the Settings page)",
			"write.readOnly": "This card is read-only, so nothing can be written (check DSH's settings write permission)",
			"write.nothing": "Nothing to write.",
			"write.gone": "That model is no longer in the configuration; reopen this card",
			"write.routeGone": "That provider is no longer in the configuration",
			"write.noData": "Could not re-read the current configuration; try again in a moment",
			"write.rejected": "The write was rejected",
			"load.failed": "Could not read the match results: {reason}",
			"panel.cellFailed": "This row's metadata controls failed to load; reload the page"
		};

		/**
		 * The active translator. Replaced by `apply()` when the page's locale service is
		 * available, and left on the Chinese dictionary otherwise — which is also what
		 * the headless tests exercise, since they hand this bundle a stub context.
		 */
		let translate;

		/**
		 * Substitute `{name}` placeholders. Mirrors the locale service's own rule, so a
		 * template behaves the same whichever dictionary answered.
		 * @param template - the text with optional placeholders.
		 * @param params - the values, by placeholder name.
		 * @returns the filled-in text.
		 */
		function fill(template, params) {
			if (params === undefined || params === null) return template;
			return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
		}

		/**
		 * One user-visible string.
		 * @param key - the dictionary key.
		 * @param params - optional placeholder values.
		 * @returns the text in the active language.
		 */
		function text(key, params) {
			const template = translate === undefined ? zh[key] : translate(key);
			return fill(template === undefined ? key : template, params);
		}

		/**
		 * Spell a capacity for the readout. Display only — this plugin has no capacity
		 * input, so nothing here has to survive a round trip through a parser.
		 *
		 * Exact forms first, largest first; a binary-sized capacity that is not a whole
		 * number of thousands (131072, 262144) is spelled by 1024, which is how anyone
		 * reads it — and how the shipped 容量 placeholder spells its own defaults.
		 * @param value - the token count.
		 * @returns the shortest honest spelling, `""` when there is nothing to spell.
		 */
		function formatCapacity(value) {
			if (!Number.isFinite(value) || value <= 0) return "";
			if (value % 1000000 === 0) return `${String(value / 1000000)}M`;
			/* A whole number of mebibytes is what a model card calls "1M", so check that
			 * before the kilo spellings — 1048576 reads as 1M, not as 1024K. */
			if (value % 1048576 === 0) return `${String(value / 1048576)}M`;
			if (value % 1000 === 0) return `${String(value / 1000)}K`;
			if (value % 1024 === 0) return `${String(value / 1024)}K`;
			return value >= 1000 ? `约 ${String(Math.round(value / 1000))}K` : String(value);
		}

		/**
		 * Parse `low, high, max`, `off`, `medium=medium_custom`, or `false`.
		 * @returns `{ value }` for a good declaration, `{ error }` otherwise.
		 */
		function parseLevels(input) {
			const trimmed = String(input).trim();
			if (trimmed.length === 0) return { value: undefined };
			if (trimmed.toLowerCase() === "false") return { value: false };
			const map = {};
			for (const item of trimmed.split(",")) {
				const part = item.trim();
				if (part.length === 0) continue;
				const at = part.indexOf("=");
				const named = at !== -1;
				const level = (named ? part.slice(0, at) : part).trim().toLowerCase();
				const wire = named ? part.slice(at + 1).trim() : level;
				if (!LEVELS.includes(level)) return { error: text("levels.error.unknown", { level, levels: LEVELS.join(" / ") }) };
				if (!named) {
					/* A bare `off` means "send no reasoning parameter at all", which is the
					 * adapter's `null` wire value; every other level sends itself. */
					if (level === "off") map.off = null;
					else map[level] = level;
				} else if (wire.length === 0) {
					/* A named level with no value is a mistake, `off=` included: it used to be
					 * read as "send nothing" while every other level errored, so the one
					 * spelling that looks like an omission silently meant something. */
					return { error: text("levels.error.wire", { level }) };
				} else map[level] = wire;
			}
			return Object.keys(map).length === 0 ? { value: undefined } : { value: map };
		}

		/** Spell a stored `reasoningEfforts` declaration back into the text field. */
		function formatLevels(efforts) {
			if (efforts === false) return "false";
			if (efforts === null || typeof efforts !== "object") return "";
			return Object.entries(efforts)
				.map(([level, wire]) => (wire === null || wire === level ? level : `${level}=${String(wire)}`))
				.join(", ");
		}

		/** A row's starting state: what settings declares, else follow the chain. */
		function initialChoice(row) {
			const declared = row.declared ?? {};
			const declaredInput = Array.isArray(declared.input) ? declared.input : undefined;
			return {
				vision: declaredInput === undefined ? "follow" : declaredInput.includes("image") ? "on" : "off",
				levels: formatLevels(declared.reasoningEfforts)
			};
		}

		/** The stored fields the panel manages, as the host's panel.mjs reads them. */
		function declaredOf(entry) {
			const declared = {};
			for (const key of PANEL_FIELDS) if (entry?.[key] !== undefined) declared[key] = entry[key];
			return declared;
		}

		/**
		 * Merge one row's choices into its stored entry. The stored entry is the base so
		 * keys this half does not own survive; a cleared field is deleted, which is how
		 * "follow the chain again" is expressed.
		 *
		 * Only {@link EDITABLE_FIELDS} are touched: `contextWindow`/`maxTokens` are the
		 * shipped editor's 容量 disclosure, and writing them here as well would make one
		 * stored field with two controls.
		 */
		function mergeRow(stored, choice) {
			const next = { ...(stored ?? {}) };
			const set = (key, value) => {
				if (value === undefined) Reflect.deleteProperty(next, key);
				else next[key] = value;
			};
			set("reasoningEfforts", parseLevels(choice.levels).value);
			if (choice.vision === "follow") set("input", undefined);
			else set("input", choice.vision === "on" ? ["text", "image"] : ["text"]);
			return next;
		}

		/** The preset a level declaration spells, else {@link CUSTOM}. */
		function presetOf(levels) {
			const value = String(levels).trim();
			return LEVEL_PRESETS.some(([preset]) => preset === value) ? value : CUSTOM;
		}

		/** What the level picker shows when it is closed. */
		function levelLabel(levels) {
			const preset = presetOf(levels);
			if (preset === CUSTOM) {
				const trimmed = String(levels).trim();
				return trimmed.length === 0 ? text("levels.custom") : text("levels.customLabel", { text: trimmed });
			}
			const found = LEVEL_PRESETS.find(([value]) => value === preset);
			return found === undefined ? text("levels.preset.follow") : text(found[1]);
		}

		/** The ops one row's write sends: its route's whole model array, in order. */
		function buildOps(route, models) {
			return [{ op: "set", path: ["providers", route, "models"], value: models }];
		}

		/** `1M / 输出 131K` for the fields present, `undefined` when neither is. */
		function capacityText(source) {
			if (source === undefined || source === null) return undefined;
			const parts = [];
			if (Number.isInteger(source.contextWindow)) parts.push(formatCapacity(source.contextWindow));
			if (Number.isInteger(source.maxTokens)) {
				const spelled = formatCapacity(source.maxTokens);
				if (spelled.length > 0) parts.push(text("capacity.output", { value: spelled }));
			}
			return parts.length === 0 ? undefined : parts.join(" / ");
		}

		/**
		 * What belongs under one row's id: the chain's verdict, what settings already
		 * declares, and where the capacity comes from.
		 *
		 * The capacity wording is the point of the line: the shipped 容量 field can only
		 * ever show the route default, so a user looking at 256K has no way to tell
		 * whether the chain matched something better.
		 * @param row - one matrix row.
		 * @returns the sentence to show.
		 */
		function readoutOf(row) {
			const declared = row.declared ?? {};
			const parts = [];
			if (row.matched === undefined) {
				parts.push(text("readout.noMatch"));
				/* Near neighbours the host found: same-family catalog entries, so the
				 * user sees what the catalogs DO know instead of a bare refusal. */
				if (Array.isArray(row.nearby) && row.nearby.length > 0) {
					const seen = new Set();
					const names = row.nearby.filter((entry) => entry.id !== undefined && !seen.has(entry.id) && seen.add(entry.id)).map((entry) => entry.id);
					parts.push(text("readout.siblings", { names: names.slice(0, 3).join("、"), more: names.length > 3 ? text("readout.more") : "" }));
				}
			} else {
				parts.push(text("readout.matched", { route: row.matched.route }));
				const capacity = capacityText(row.matched);
				if (capacity !== undefined) parts.push(capacity);
				parts.push(row.matched.reasoning ? text("readout.reasoningYes") : text("readout.reasoningNo"));
				parts.push(row.matched.input?.includes("image") ? text("readout.visionYes") : text("readout.visionNo"));
			}
			if (declared.reasoningEfforts !== undefined) {
				const spelled = formatLevels(declared.reasoningEfforts);
				parts.push(spelled.length === 0 ? text("readout.declaredLevelsEmpty") : text("readout.declaredLevels", { levels: spelled }));
			}
			if (Array.isArray(declared.input)) parts.push(declared.input.includes("image") ? text("readout.declaredVisionOn") : text("readout.declaredVisionOff"));
			return parts.join(" · ");
		}

		/** Whether a row's controls differ from what settings already declares. */
		function isDirty(row, choice) {
			const declared = initialChoice(row);
			return choice.levels !== declared.levels || choice.vision !== declared.vision;
		}

		/**
		 * This card's route inside a matrix payload, by NAME rather than by position.
		 *
		 * The host answers one route per request, but a host older than that request
		 * filter answers every route — and taking position 0 would then show, and offer
		 * to write, another provider's models. Every level is shape-checked rather than
		 * trusted: this runs while rendering, and a payload from a proxy, a future host or
		 * a developer's stub must not be able to throw the card's controls away.
		 * @param payload - a matrix response.
		 * @param route - the route this card owns.
		 * @returns the matching route, or undefined.
		 */
		function routeIn(payload, route) {
			const routes = Array.isArray(payload?.routes) ? payload.routes : [];
			const found = routes.find((entry) => entry?.route === route);
			if (found === undefined || found === null) return undefined;
			return { ...found, models: Array.isArray(found.models) ? found.models : [] };
		}

		/**
		 * Whether the panel must ask the host for its matrix again.
		 *
		 * The rows the editor is showing are the truth about what the user has: a row
		 * the payload cannot answer for is a model added (or renamed) since the fetch,
		 * and without a fresh answer that row renders no controls at all — which is
		 * indistinguishable from the plugin not being installed, and is exactly why a
		 * newly added model used to look unmatched until the page was reloaded.
		 *
		 * One refetch per distinct row set, which is what the returned key is for; the
		 * caller forgets the key when the editor closes, so reopening always refreshes.
		 * @param targetIds - the model ids the editor's rows carry right now.
		 * @param knownIds - the ids the payload in hand can answer for.
		 * @param lastKey - the row set the previous refetch was made for.
		 * @returns the key to remember, or `""` when no refetch is needed.
		 */
		function reloadKeyFor(targetIds, knownIds, lastKey) {
			const ids = targetIds.filter((id) => typeof id === "string" && id.length > 0);
			if (ids.length === 0 || ids.every((id) => knownIds.has(id))) return "";
			const key = [...ids].sort().join("\u0000");
			return key === lastKey ? "" : key;
		}

		/**
		 * The editor's model rows, found by the one structural fact that needs no
		 * translation: each row's first grid cell is its id input, and the grid also
		 * holds the 容量 disclosure button. Deliberately NOT "every button with
		 * aria-expanded" — a control of ours that used that attribute would count itself,
		 * which is why anything inside a cell of ours is excluded first.
		 * @param card - the provider card element.
		 * @returns the 容量 toggle of every model row, in order.
		 */
		function rowToggles(card) {
			return [...card.querySelectorAll("button[aria-expanded]")].filter((toggle) => {
				if (toggle.closest(`[${CELL_ATTR}]`) !== null) return false;
				const first = toggle.parentElement?.children?.[0];
				return first !== undefined && first !== null && first.tagName === "INPUT";
			});
		}

		/**
		 * The card element this seat was rendered into.
		 *
		 * `closest("li")` is the shipped shape of a configured provider card, and it stays
		 * the first choice — but it is not the only one: the add-provider draft is a
		 * different element, and a build that re-lays the settings page could change
		 * either. The fallback walks up to the nearest ancestor that actually holds this
		 * card's editor (a row toggle, or the id/name inputs), which is what the watcher
		 * needs; returning null when there is none is fine — that card then gets no
		 * controls, exactly as today.
		 * @param anchor - the hidden marker this seat renders.
		 * @returns the card element, or null.
		 */
		function cardOf(anchor) {
			const element = anchor?.current ?? null;
			if (element === null) return null;
			const list = element.closest?.("li") ?? null;
			if (list !== null) return list;
			let node = element.parentElement;
			for (let depth = 0; node !== null && depth < 8; depth++, node = node.parentElement) {
				if (node.querySelector?.('button[aria-expanded]') !== null || node.querySelector?.('input[type="text"]') !== null) return node;
			}
			return null;
		}

		/** Whether a mutation happened inside a cell this plugin mounted. */
		function isOurNode(node) {
			const element = node?.nodeType === 1 ? node : node?.parentElement;
			if (element === null || element === undefined) return false;
			return element.hasAttribute(CELL_ATTR) || element.closest(`[${CELL_ATTR}]`) !== null;
		}

		const styles = {
			/* The row's own 容量 grid, shape for shape. */
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: "8px", padding: "2px 4px 6px" },
			field: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
			caption: { fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
			/* The trigger keeps the row input's box; the caret is DSH's own icon, and
			 * the background is pinned so no inherited class can add a second one. */
			trigger: { boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", width: "100%", textAlign: "left", cursor: "pointer", backgroundImage: "none" },
			/* Only used when the page's own input class could not be read: a trigger with
			 * no class at all would render as bare text with no border and no theme. */
			triggerFallback: { boxSizing: "border-box", height: "28px", padding: "0 8px", font: "inherit", fontSize: "13px", cursor: "pointer", color: "var(--dsw-alias-label-primary)", background: "transparent", border: "0.5px solid var(--dsw-alias-border-l3)", borderRadius: "6px" },
			triggerText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			foot: { gridColumn: "1/-1", display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
			note: { margin: "0", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)", overflowWrap: "anywhere" },
			/* Only used when the page's own button class could not be read. */
			actionFallback: { boxSizing: "border-box", height: "28px", padding: "0 10px", font: "inherit", fontSize: "12px", cursor: "pointer", color: "var(--dsw-alias-label-primary)", background: "transparent", border: "0.5px solid var(--dsw-alias-border-l3)", borderRadius: "14px", flex: "none" },
			/* The only thing this plugin can render in the card itself: a failure, because
			 * an unreadable matrix would otherwise make every row silently blank. */
			failed: { margin: "0", fontSize: "12px", lineHeight: "18px", color: "var(--dsw-alias-state-error-primary)" }
		};

		/**
		 * One model row's controls: 推理等级, 视觉, the chain's verdict, and — once the row
		 * differs from settings — the button that writes it.
		 *
		 * @param props - `{ row, choice, classes, message, busy, onChoice, onCommit }`.
		 * @returns the cell element.
		 */
		function Cell(props) {
			const { row, choice, classes, message, busy } = props;
			const [levelsOpen, setLevelsOpen] = React.useState(false);
			const [visionOpen, setVisionOpen] = React.useState(false);
			/* 自定义… is a mode, not a value: it reveals the text field even while the
			 * declaration still matches a preset. */
			const [custom, setCustom] = React.useState(false);
			const note = React.useRef(null);
			const preset = presetOf(choice.levels);
			const invalid = parseLevels(choice.levels).error;
			const levelItems = [
				...LEVEL_PRESETS.map(([value, key]) => ({ id: value, label: text(key) })),
				{ type: "separator", id: "custom-separator" },
				{ id: CUSTOM, label: text("levels.custom") }
			];
			const visionItems = VISION.map((value) => ({ id: value, label: text(VISION_LABELS[value]) }));
			/*
			 * A write is over: whatever happened, the row's status line now holds the
			 * answer, and the button the user just used is gone. Moving focus there keeps a
			 * keyboard or screen-reader user in the row instead of dropping them to the
			 * document body.
			 */
			const wasBusy = React.useRef(busy);
			React.useEffect(() => {
				if (wasBusy.current && !busy) note.current?.focus?.();
				wasBusy.current = busy;
			}, [busy]);
			const trigger = (label, open, setOpen, aria) => h("button", {
				type: "button",
				className: classes.control,
				style: classes.control === undefined || classes.control === "" ? { ...styles.trigger, ...styles.triggerFallback } : styles.trigger,
				"aria-label": aria,
				/* This plugin's own row anchor is the row's 容量 toggle; ours is excluded
				 * from that search by the cell attribute above, so the standard attribute is
				 * safe here — and it is what tells a screen reader the button opens a menu. */
				"aria-haspopup": "menu",
				"aria-expanded": open,
				disabled: busy,
				onClick: () => setOpen(!open)
			}, [
				h("span", { key: "t", style: styles.triggerText }, label),
				h(IconChevronDownOutline14, { key: "c" })
			]);
			return h("div", { [CELL_ATTR]: "", style: styles.grid }, [
				h("div", { key: "levels", style: styles.field }, [
					h("span", { key: "c", style: styles.caption }, text("levels.label")),
					h(Menu, {
						key: "m",
						open: levelsOpen,
						/* DSH's own call sites put the popup in a portal: without one the list is
						 * positioned inside the card's scroll container, where it can be clipped
						 * and is never clamped to the viewport. */
						portal: true,
						align: "start",
						anchor: trigger(levelLabel(choice.levels), levelsOpen, setLevelsOpen, text("levels.aria", { id: row.id })),
						items: levelItems,
						selectedId: custom ? CUSTOM : preset,
						onSelect: (id) => {
							setLevelsOpen(false);
							if (id === CUSTOM) {
								/* Reveal the field; whatever is spelled stays as it is. */
								setCustom(true);
								return;
							}
							setCustom(false);
							props.onChoice({ levels: id });
						},
						onClose: () => setLevelsOpen(false)
					}),
					custom || preset === CUSTOM
						? h("input", {
							key: "i",
							type: "text",
							className: classes.control,
							value: choice.levels,
							placeholder: text("levels.customHint"),
							"aria-label": text("levels.customAria", { id: row.id }),
							disabled: busy,
							onChange: (event) => props.onChoice({ levels: event.target.value })
						})
						: null
				]),
				h("div", { key: "vision", style: styles.field }, [
					h("span", { key: "c", style: styles.caption }, text("vision.label")),
					h(Menu, {
						key: "m",
						open: visionOpen,
						portal: true,
						align: "start",
						anchor: trigger(text(VISION_LABELS[choice.vision] ?? choice.vision), visionOpen, setVisionOpen, text("vision.aria", { id: row.id })),
						items: visionItems,
						selectedId: choice.vision,
						onSelect: (id) => {
							setVisionOpen(false);
							props.onChoice({ vision: id });
						},
						onClose: () => setVisionOpen(false)
					})
				]),
				h("div", { key: "foot", style: styles.foot }, [
					h("p", {
						key: "n",
						ref: note,
						/* Announce the outcome: a write that fails silently is worse than one
						 * that fails loudly, and this line is where it is reported. */
						role: "status",
						"aria-live": "polite",
						tabIndex: -1,
						style: invalid === undefined ? styles.note : { ...styles.note, color: "var(--dsw-alias-state-error-primary)" }
					}, invalid ?? message ?? readoutOf(row)),
					invalid === undefined && props.dirty
						? h("button", {
							key: "w",
							type: "button",
							className: classes.action,
							style: classes.action === undefined ? styles.actionFallback : undefined,
							disabled: busy,
							onClick: () => props.onCommit()
						}, busy ? text("write.busy") : text("write.action"))
						: null
				])
			]);
		}

		/*
		 * Re-render only the rows that changed. Every edit lives in the Panel's state, so
		 * without this a keystroke in one row's custom-levels field re-rendered all of
		 * them; the comparison is by value on purpose, since the callbacks are recreated
		 * per render but do the same thing.
		 */
		const MemoCell = React.memo(Cell, (before, after) => before.row === after.row
			&& before.choice === after.choice
			&& before.classes === after.classes
			&& before.message === after.message
			&& before.busy === after.busy
			&& before.dirty === after.dirty);

		/**
		 * Keeps one card's cells on screen: a failure inside a cell would otherwise take
		 * the whole portal root down with it, blanking every row of the card.
		 */
		class CellBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			render() {
				return this.state.failed ? h("p", { style: styles.failed }, text("panel.cellFailed")) : this.props.children;
			}
		}

		/**
		 * One matrix request, understood well enough to report what went wrong.
		 * @param url - the panel route, provider filter included.
		 * @returns `{ payload }`, `{ unavailable: true }` or `{ failure }`.
		 */
		async function fetchMatrix(url) {
			let response;
			try {
				response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
			} catch (error) {
				return { failure: error instanceof Error ? error.message : String(error) };
			}
			/* The host's "this deployment has no panel route" answer, and a route that was
			 * never registered, are not user errors — they are a switch someone chose
			 * (`DSH_PI_AI_CATALOG_PANEL=off`, or a host build without the route), so the card
			 * stays quiet rather than showing a red line on every provider. Silence is also
			 * the only honest answer here: the client cannot tell which of the two it is. */
			if (response.status === 404 || response.status === 501) return { unavailable: true };
			if (response.ok !== true) {
				/* A 500 from the host carries its own message; anything else (a proxy, the
				 * SPA's HTML fallback) is reported by status and content type rather than by
				 * whatever `JSON.parse` made of a page of markup. */
				let detail = `HTTP ${String(response.status)}`;
				try {
					const body = await response.text();
					const parsed = JSON.parse(body);
					if (typeof parsed?.error === "string" && parsed.error.length > 0) detail = parsed.error;
				} catch {
					/* Not JSON, or no body: the status is the message. */
				}
				return { failure: detail };
			}
			try {
				return { payload: await response.json() };
			} catch (error) {
				return { failure: error instanceof Error ? error.message : String(error) };
			}
		}

		/**
		 * The panel for one provider card: it fetches that route's matrix, owns the
		 * pending per-model choices, and portals one cell into each open editor row.
		 * @param props - `{ remote, provider }` from the card seat.
		 * @returns the hidden anchor plus a failure line, or null for a route-less card.
		 */
		function Panel(props) {
			const route = props.provider?.provider;
			const url = `${MATRIX_URL}?provider=${encodeURIComponent(typeof route === "string" ? route : "")}`;
			const anchor = React.useRef(null);
			const host = React.useRef(null);
			const root = React.useRef(null);
			const [matrix, setMatrix] = React.useState(undefined);
			const [choices, setChoices] = React.useState({});
			const [messages, setMessages] = React.useState({});
			const [saving, setSaving] = React.useState({});
			const [status, setStatus] = React.useState("idle");
			const [message, setMessage] = React.useState("");
			/* The editor's rows right now: `{entry, id}`, re-read whenever its DOM moves. */
			const [targets, setTargets] = React.useState([]);
			const choicesRef = React.useRef(choices);
			choicesRef.current = choices;
			const savingRef = React.useRef(saving);
			savingRef.current = saving;
			/*
			 * The newest request wins. The mount load, the "the editor added a row" reload
			 * and a write's own re-read can overlap, and without this the oldest answer
			 * could land last and put a stale payload back on screen.
			 */
			const requestSeq = React.useRef(0);

			/**
			 * Read the matrix.
			 * @param options - `{ keepChoices }`: a refresh the user did not ask for must
			 * not throw away edits they have not written yet.
			 * @returns the payload, or null when the request failed or was superseded.
			 */
			const load = React.useCallback(async (options = {}) => {
				const seq = ++requestSeq.current;
				setStatus("loading");
				const result = await fetchMatrix(url);
				if (seq !== requestSeq.current) return null;
				if (result.unavailable === true) {
					setMatrix(undefined);
					setStatus("unavailable");
					return null;
				}
				if (result.failure !== undefined) {
					setStatus("failed");
					setMessage(text("load.failed", { reason: result.failure }));
					return null;
				}
				/* A fresh answer invalidates whatever the previous one said about a row. */
				setMessages({});
				setStatus("ready");
				setMessage("");
				setMatrix(result.payload);
				if (options.keepChoices !== true) setChoices({});
				return result.payload;
			}, [url]);

			const rows = React.useMemo(() => routeIn(matrix, route)?.models ?? [], [matrix, route]);
			const rowOf = React.useCallback((id) => rows.find((row) => row.id === id), [rows]);

			/*
			 * Nothing is fetched until this card has something to draw: the cells only
			 * exist while the editor is open, so a collapsed card (and the add-provider
			 * draft, which has no route yet) used to cost a request on every settings page
			 * load for an answer nothing would read.
			 */
			const started = React.useRef(false);
			React.useEffect(() => {
				if (started.current || targets.length === 0) return;
				started.current = true;
				void load();
			}, [load, targets]);

			/*
			 * Keep the payload in step with the editor. A model added here — or saved
			 * while the card stayed open — is a row this fetch answered nothing for, and
			 * the cell is portaled per row id: without this it would stay blank. The
			 * refetch never overwrites choices the user has not written yet.
			 */
			const reloadedFor = React.useRef("");
			React.useEffect(() => {
				if (targets.length === 0) {
					/* The editor closed: forget, so reopening always asks again. */
					reloadedFor.current = "";
					started.current = false;
					return;
				}
				/* Nothing has been read yet: the first load is what gives this effect
				 * something to compare the editor's rows against, and asking for the same
				 * answer twice would be the request this whole path exists to avoid. */
				if (matrix === undefined) return;
				const known = new Set(rows.map((row) => row.id));
				const key = reloadKeyFor(targets.map((target) => target.id), known, reloadedFor.current);
				if (key === "") return;
				reloadedFor.current = key;
				void load({ keepChoices: true });
			}, [targets, rows, matrix, load]);

			const choiceOf = (row) => choices[row.id] ?? initialChoice(row);

			const change = React.useCallback((id, patch) => {
				setChoices((current) => {
					const row = rows.find((entry) => entry.id === id);
					if (row === undefined) return current;
					return { ...current, [id]: { ...(current[id] ?? initialChoice(row)), ...patch } };
				});
				/* The note belonged to the previous attempt; the row is being edited again. */
				setMessages((current) => {
					if (current[id] === undefined) return current;
					const next = { ...current };
					delete next[id];
					return next;
				});
			}, [rows]);

			/**
			 * The settings revision of the namespace this plugin writes, or `undefined`
			 * when it cannot be read (the write then proceeds unconditionally).
			 */
			const readSettingsState = React.useCallback(async () => {
				try {
					const described = await props.remote?.settings?.describe();
					const value = described?.ok === false ? undefined : described?.value ?? described;
					const view = value?.namespaces?.find((candidate) => candidate.ns === NS);
					return {
						revision: typeof view?.revision === "number" ? view.revision : undefined,
						/* `writable` is the page's own answer to "may anything write here?", and
						 * a read-only deployment disables its own inputs; offering a button that
						 * can only fail is worse than saying so. */
						writable: typeof value?.writable === "boolean" ? value.writable : undefined
					};
				} catch {
					return { revision: undefined, writable: undefined };
				}
			}, [props.remote]);

			/**
			 * Write one row. The matrix is fetched again first: this half owns two keys,
			 * and rebuilding the array from a stale copy would drop a concurrent edit.
			 */
			const commit = React.useCallback(async (id) => {
				const settings = props.remote?.settings;
				const say = (value) => setMessages((current) => ({ ...current, [id]: value }));
				/* The guard, not the disabled button, is what makes a double click one write:
				 * two writes race for the same settings revision, and the loser reports a
				 * conflict for a row that was in fact written. */
				if (savingRef.current[id] === true) return;
				if (settings?.mutate === undefined) {
					say(text("write.noSettings"));
					return;
				}
				const choice = choicesRef.current[id];
				const row = rows.find((entry) => entry.id === id);
				if (choice === undefined || row === undefined) {
					say(text("write.nothing"));
					return;
				}
				const levels = parseLevels(choice.levels);
				if (levels.error !== undefined) {
					say(levels.error);
					return;
				}
				setSaving((current) => ({ ...current, [id]: true }));
				try {
					const payload = await load({ keepChoices: true });
					if (payload === null) throw new Error(text("write.noData"));
					const current = routeIn(payload, route);
					if (current === undefined) throw new Error(text("write.routeGone"));
					if (!current.models.some((entry) => entry.id === id)) throw new Error(text("write.gone"));
					const models = current.models.map((entry) => (entry.id === id ? mergeRow(entry.stored ?? { id: entry.id }, choice) : entry.stored ?? { id: entry.id }));
					const state = await readSettingsState();
					if (state.writable === false) throw new Error(text("write.readOnly"));
					const result = await settings.mutate(NS, buildOps(current.route, models), state.revision);
					if (result !== undefined && result !== null && result.ok === false) {
						const failure = result.error?.message ?? result.message ?? text("write.rejected");
						throw new Error(result.error?.code === "settings/conflict" ? text("write.conflict", { reason: String(failure) }) : String(failure));
					}
					/*
					 * No second fetch: this half knows exactly what it stored, and the only
					 * thing the next render needs from it is the row's declared fields. The
					 * choice is dropped for that row so it re-derives from the declaration —
					 * which is also what makes its 写入 button go away.
					 */
					const written = models.find((entry) => entry.id === id);
					setMatrix((currentMatrix) => {
						const found = routeIn(currentMatrix, route);
						if (found === undefined || written === undefined) return currentMatrix;
						const patched = found.models.map((entry) => (entry.id === id ? { ...entry, stored: written, declared: declaredOf(written) } : entry));
						return { ...currentMatrix, routes: currentMatrix.routes.map((entry) => (entry.route === route ? { ...entry, models: patched } : entry)) };
					});
					setChoices((currentChoices) => {
						if (currentChoices[id] === undefined) return currentChoices;
						const next = { ...currentChoices };
						delete next[id];
						return next;
					});
					say(text("write.done", { id }));
				} catch (error) {
					say(text("write.failed", { reason: error instanceof Error ? error.message : String(error) }));
				} finally {
					setSaving((current) => {
						if (current[id] !== true) return current;
						const next = { ...current };
						delete next[id];
						return next;
					});
				}
			}, [load, props.remote, rows, route, readSettingsState]);

			/* Whether the editor is showing rows, which is also when its container is findable. */
			const editorOpen = targets.length > 0;

			/* One React root inside this card; every cell is portaled into its own row. */
			React.useEffect(() => {
				if (host.current === null) return undefined;
				const mounted = createRoot(host.current);
				root.current = mounted;
				return () => {
					root.current = null;
					mounted.unmount();
				};
			}, []);

			/*
			 * Watch this card for the editor opening, its rows changing, and it closing.
			 * The anchor is the per-row 容量 disclosure button and the grid holding it, so
			 * nothing here depends on a translated label.
			 *
			 * Three triggers, because a row's id is a DOM *property* of a controlled input:
			 * React writes it without touching the child list, so the observer alone never
			 * sees an id being typed — which is why a freshly added row kept no controls
			 * until something else happened to mutate the card. The capture-phase `input`
			 * listener is what makes a typed (or renamed) id reach `read()`.
			 */
			React.useEffect(() => {
				const card = cardOf(anchor);
				if (card === null) return undefined;
				let frame = 0;
				const read = () => {
					const found = [];
					for (const toggle of rowToggles(card)) {
						const grid = toggle.parentElement;
						const entry = grid?.parentElement;
						const idInput = grid?.children?.[0];
						const id = idInput === undefined || idInput === null ? "" : idInput.value;
						if (entry === undefined || entry === null || typeof id !== "string" || id.length === 0) continue;
						if (!found.some((target) => target.id === id)) found.push({ entry, id });
					}
					setTargets((current) => current.length === found.length && current.every((target, index) => target.id === found[index].id && target.entry === found[index].entry) ? current : found);
				};
				const schedule = () => {
					if (frame !== 0) return;
					frame = requestAnimationFrame(() => {
						frame = 0;
						read();
					});
				};
				const observer = new MutationObserver((records) => {
					/* Our own cells are React-portaled into the rows; ignore those edits, both
					 * the ones inside a cell and the insertion of a cell itself. */
					if (records.every((record) => isOurNode(record.target) || [...record.addedNodes].every((node) => isOurNode(node)))) return;
					schedule();
				});
				observer.observe(card, { childList: true, subtree: true });
				const onInput = (event) => {
					if (isOurNode(event.target)) return;
					schedule();
				};
				card.addEventListener("input", onInput, true);
				card.addEventListener("change", onInput, true);
				read();
				return () => {
					observer.disconnect();
					card.removeEventListener("input", onInput, true);
					card.removeEventListener("change", onInput, true);
					if (frame !== 0) cancelAnimationFrame(frame);
				};
				/* Re-armed when the editor opens or closes: a draft card's container is only
				 * findable once it renders its own inputs. */
			}, [anchor, editorOpen]);

			/* The card's own classes, so an injected control is the page's own widget. */
			const classes = React.useMemo(() => {
				const card = cardOf(anchor);
				const sample = card?.querySelector('input[type="text"]');
				/*
				 * Only the text input's class is copied. The row's `<select>` class is
				 * deliberately NOT: it carries its own caret as a background image
				 * (`appearance:none` plus a chevron data-URL), and this cell draws DSH's
				 * chevron as a child — inheriting both is what showed two arrows per
				 * picker. The trigger's own `backgroundImage: none` keeps that true even if
				 * a future build moves a caret into the input class.
				 *
				 * The catalog's action button is the section's own direct child. It is not
				 * filtered by "has an svg": in the pi-ai editor the 添加模型 button is text-only,
				 * so that filter matched nothing and this half always fell back to its own
				 * styling while the page's class went unused.
				 */
				const catalog = sample?.closest("section") ?? null;
				const action = catalog?.querySelector(":scope > button") ?? null;
				return {
					control: sample?.className ?? "",
					action: action?.className ?? undefined
				};
			}, [anchor, targets]);

			React.useEffect(() => {
				root.current?.render(targets.map((target) => {
					const row = rowOf(target.id);
					if (row === undefined) return null;
					const choice = choiceOf(row);
					return createPortal(
						h(CellBoundary, { key: target.id },
							h(MemoCell, {
								row,
								choice,
								classes,
								message: messages[target.id],
								busy: saving[target.id] === true,
								dirty: isDirty(row, choice),
								onChoice: (patch) => change(target.id, patch),
								onCommit: () => void commit(target.id)
							})
						),
						target.entry,
						target.id
					);
				}));
			}, [targets, rows, choices, messages, saving, classes, change, commit, rowOf]);

			/* A card with no route id (the add-provider draft before it is saved) gets nothing. */
			if (typeof route !== "string" || route.length === 0) return null;

			return h(React.Fragment, null,
				h("span", { key: "anchor", ref: anchor, style: { display: "none" } }),
				h("span", { key: "host", ref: host, style: { display: "none" } }),
				status === "failed" ? h("p", { key: "note", role: "status", "aria-live": "polite", style: styles.failed }, message) : null
			);
		}

		/**
		 * Register the cell inside every provider card of the `llm-pi-ai` family.
		 *
		 * The seat is keyed by the card's settings namespace, so one registration covers
		 * the shipped rows, the hand-declared ones and the first-run setup card alike;
		 * without a registrant the area renders nothing.
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			/*
			 * The page's own translator when it is there, the Chinese dictionary otherwise:
			 * this bundle is the only place in the Settings page that used to be
			 * single-language regardless of what the rest of the page was set to.
			 */
			const locale = ctx.locale;
			if (locale !== undefined && typeof locale.register === "function" && typeof locale.bind === "function") {
				ctx.effect?.(() => locale.register(LOCALE_NS, { zh, en }), "dsh-model-metadata: dictionaries");
				const bound = locale.bind(LOCALE_NS);
				if (typeof bound === "function") translate = (key, params) => fill(bound(key, params), params);
			}
			ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register(
				{ name: "settings.models.provider-card", key: NS, order: 100 },
				(ownerProps) => h(Panel, { remote: ctx.remote, provider: ownerProps?.provider })
			));
		}

		exports.name = "dsh-model-metadata-ui";
		exports.apply = apply;
		exports.inject = ["slots", "remote", "remote.settings", "locale"];
		/* Exposed so the headless tests can hold these twins against ../panel.mjs. */
		exports.__test = {
			NS,
			LOCALE_NS,
			PANEL_FIELDS,
			EDITABLE_FIELDS,
			CELL_ATTR,
			CUSTOM,
			LEVEL_PRESETS,
			LEVELS,
			zh,
			en,
			text,
			formatCapacity,
			parseLevels,
			formatLevels,
			initialChoice,
			declaredOf,
			mergeRow,
			presetOf,
			levelLabel,
			isDirty,
			readoutOf,
			capacityText,
			routeIn,
			reloadKeyFor,
			rowToggles,
			cardOf,
			isOurNode,
			buildOps,
			fetchMatrix,
			MemoCell,
			Cell
		};
		return module.exports;
	}
});
