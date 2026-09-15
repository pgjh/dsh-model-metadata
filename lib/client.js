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
 * finds its model rows and portals one cell into each, directly above that row's own
 * 容量 grid. The anchor is the per-row 容量 disclosure button (`aria-expanded`) and its
 * grid, so it holds in any locale.
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
 * (`compat`, …) survive and a concurrent edit is not clobbered. DSH protects the other
 * direction itself: the editor captures a settings revision when it opens and refuses
 * its own save once ours has moved it ("这张卡片打开期间，这些设置已被其他地方改动"),
 * so a stale draft can never silently drop a reasoning declaration.
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
			["", "跟随自动匹配"],
			["false", "关闭推理（声明不支持）"],
			["low, medium, high", "低 / 中 / 高"],
			["off, low, medium, high", "关闭 / 低 / 中 / 高"],
			["off, minimal, low, medium, high", "关闭 / 最小 / 低 / 中 / 高"],
			["off, minimal, low, medium, high, max", "全等级 + max"]
		];
		const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		const VISION_LABELS = { follow: "跟随自动匹配", on: "开启（可收图）", off: "关闭（纯文本）" };
		/** The attribute that marks a cell this plugin mounted into an editor row. */
		const CELL_ATTR = "data-model-metadata-cell";

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
			if (value % 1000 === 0) return `${String(value / 1000)}K`;
			if (value % 1024 === 0) return `${String(value / 1024)}K`;
			return value >= 1000 ? `约 ${String(Math.round(value / 1000))}K` : String(value);
		}

		/**
		 * Parse `low, high, max`, `off`, `medium=medium_custom`, or `false`.
		 * @returns `{ value }` for a good declaration, `{ error }` otherwise.
		 */
		function parseLevels(text) {
			const trimmed = String(text).trim();
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
				if (!LEVELS.includes(level)) return { error: `未知等级「${level}」，可用：${LEVELS.join(" / ")}` };
				/* A bare `off` means "send no reasoning parameter at all", which is the
				 * adapter's `null` wire value; `off=none` sends the literal. */
				if (level === "off" && (!named || wire.length === 0)) map.off = null;
				else if (!named) map[level] = level;
				else if (wire.length === 0) return { error: `等级「${level}」需要线上取值，例如 ${level}=${level}` };
				else map[level] = wire;
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
			const next = { ...stored };
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
			const text = String(levels).trim();
			return LEVEL_PRESETS.some(([value]) => value === text) ? text : CUSTOM;
		}

		/** What the level picker shows when it is closed. */
		function levelLabel(levels) {
			const preset = presetOf(levels);
			if (preset === CUSTOM) return levels.trim().length === 0 ? "自定义…" : `自定义：${levels.trim()}`;
			const found = LEVEL_PRESETS.find(([value]) => value === preset);
			return found === undefined ? "跟随自动匹配" : found[1];
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
			if (Number.isInteger(source.maxTokens)) parts.push(`输出 ${formatCapacity(source.maxTokens)}`);
			return parts.length === 0 ? undefined : parts.join(" / ");
		}

		/**
		 * Where this row's capacity comes from — the one fact the shipped 容量 field
		 * cannot show, because its placeholder is only the route default and never the
		 * value the chain matched for a prefixed id.
		 * @param row - one matrix row.
		 * @returns the line to print and its tone.
		 */
		function capacityLine(row) {
			const declared = row.declared ?? {};
			const declaredText = capacityText(declared);
			if (declaredText !== undefined) {
				const matched = capacityText(row.matched);
				return {
					text: `容量：已声明 ${declaredText}${matched === undefined ? "" : `（自动匹配 ${matched}）`}`,
					tone: "ok"
				};
			}
			const matchedText = capacityText(row.matched);
			if (matchedText !== undefined) return { text: `容量：自动匹配 ${matchedText} · 来源 ${row.matched.route}`, tone: "auto" };
			return { text: "容量：无匹配，运行时用提供方默认；改它用本行的「容量」折叠", tone: "warn" };
		}

		/**
		 * What belongs under one row's id: the chain's verdict, what settings already
		 * declares, and where the capacity comes from.
		 * @param row - one matrix row.
		 * @returns the sentence to show.
		 */
		function readoutOf(row) {
			const declared = row.declared ?? {};
			const parts = [];
			if (row.matched === undefined) {
				parts.push("无匹配：哪里的目录都不认识这个名字，容量请在「容量」里填");
				/* Near neighbours the host found: same-family catalog entries, so the
				 * user sees what the catalogs DO know instead of a bare refusal. */
				if (Array.isArray(row.nearby) && row.nearby.length > 0) {
					const seen = new Set();
					const names = row.nearby.filter((entry) => entry.id !== undefined && !seen.has(entry.id) && seen.add(entry.id)).map((entry) => entry.id);
					parts.push(`同家族目录里有：${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}`);
				}
			} else {
				parts.push(`自动匹配：${row.matched.route}`);
				const capacity = capacityText(row.matched);
				if (capacity !== undefined) parts.push(capacity);
				parts.push(row.matched.reasoning ? "有推理等级" : "无推理等级");
				parts.push(row.matched.input?.includes("image") ? "视觉" : "纯文本");
			}
			if (declared.reasoningEfforts !== undefined) parts.push(`已声明推理等级 ${formatLevels(declared.reasoningEfforts) || "（无）"}`);
			if (Array.isArray(declared.input)) parts.push(`已声明视觉 ${declared.input.includes("image") ? "开启" : "关闭"}`);
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
		 * to write, another provider's models.
		 * @param payload - a matrix response.
		 * @param route - the route this card owns.
		 * @returns the matching route, or undefined.
		 */
		function routeIn(payload, route) {
			return payload?.routes?.find((entry) => entry.route === route);
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
		 * aria-expanded" — a control of ours that used that attribute would count itself.
		 * @param card - the provider card element.
		 * @returns the 容量 toggle of every model row, in order.
		 */
		function rowToggles(card) {
			return [...card.querySelectorAll("button[aria-expanded]")].filter((toggle) => {
				const first = toggle.parentElement?.children?.[0];
				return first !== undefined && first !== null && first.tagName === "INPUT";
			});
		}

		/** Whether a mutation happened inside a cell this plugin mounted. */
		function isOurNode(node) {
			const element = node.nodeType === 1 ? node : node.parentElement;
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
			const preset = presetOf(choice.levels);
			const invalid = parseLevels(choice.levels).error;
			const levelItems = [
				...LEVEL_PRESETS.map(([value, label]) => ({ id: value, label })),
				{ type: "separator", id: "custom-separator" },
				{ id: CUSTOM, label: "自定义…" }
			];
			const visionItems = VISION.map((value) => ({ id: value, label: VISION_LABELS[value] }));
			const trigger = (text, open, setOpen, label) => h("button", {
				type: "button",
				className: classes.control,
				style: styles.trigger,
				"aria-label": label,
				/* NOT aria-expanded: that is this plugin's own row anchor. */
				"aria-haspopup": "menu",
				disabled: busy,
				onClick: () => setOpen(!open)
			}, [
				h("span", { key: "t", style: styles.triggerText }, text),
				h(IconChevronDownOutline14, { key: "c" })
			]);
			return h("div", { [CELL_ATTR]: "", style: styles.grid }, [
				h("div", { key: "levels", style: styles.field }, [
					h("span", { key: "c", style: styles.caption }, "推理等级"),
					h(Menu, {
						key: "m",
						open: levelsOpen,
						anchor: trigger(levelLabel(choice.levels), levelsOpen, setLevelsOpen, `${row.id} 推理等级`),
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
							placeholder: "如 low, high, max",
							"aria-label": `${row.id} 推理等级自定义`,
							disabled: busy,
							onChange: (event) => props.onChoice({ levels: event.target.value })
						})
						: null
				]),
				h("div", { key: "vision", style: styles.field }, [
					h("span", { key: "c", style: styles.caption }, "视觉"),
					h(Menu, {
						key: "m",
						open: visionOpen,
						anchor: trigger(VISION_LABELS[choice.vision] ?? choice.vision, visionOpen, setVisionOpen, `${row.id} 视觉`),
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
						style: invalid === undefined ? styles.note : { ...styles.note, color: "var(--dsw-alias-state-error-primary)" }
					}, invalid ?? message ?? readoutOf(row)),
					invalid === undefined && dirty(row, choice)
						? h("button", {
							key: "w",
							type: "button",
							className: classes.action,
							style: classes.action === undefined ? styles.actionFallback : undefined,
							disabled: busy,
							onClick: () => props.onCommit()
						}, busy ? "写入中…" : "写入")
						: null
				])
			]);
		}

		/** `isDirty` under the name the cell reads. */
		function dirty(row, choice) {
			return isDirty(row, choice);
		}

		/**
		 * The panel for one provider card: it fetches that route's matrix, owns the
		 * pending per-model choices, and portals one cell into each open editor row.
		 * @param props - `{ remote, provider, configured }` from the card seat.
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
			const [status, setStatus] = React.useState("loading");
			const [message, setMessage] = React.useState("");
			/* The editor's rows right now: `{entry, id}`, re-read whenever its DOM moves. */
			const [targets, setTargets] = React.useState([]);
			const choicesRef = React.useRef(choices);
			choicesRef.current = choices;

			const load = React.useCallback(async (options = {}) => {
				setStatus("loading");
				try {
					const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
					if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
					setMatrix(await response.json());
					/* A refresh the user did not ask for must not throw away edits they have
					 * not written yet; the first load has none to keep. */
					if (options.keepChoices !== true) setChoices({});
					setStatus("ready");
					setMessage("");
				} catch (error) {
					setStatus("failed");
					setMessage(`读取匹配结果失败：${error instanceof Error ? error.message : String(error)}`);
				}
			}, [url]);

			React.useEffect(() => {
				void load();
			}, [load]);

			const rows = routeIn(matrix, route)?.models ?? [];
			const rowOf = React.useCallback((id) => rows.find((row) => row.id === id), [rows]);

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
					return;
				}
				const known = new Set(rows.map((row) => row.id));
				const key = reloadKeyFor(targets.map((target) => target.id), known, reloadedFor.current);
				if (key === "") return;
				reloadedFor.current = key;
				void load({ keepChoices: true });
			}, [targets, rows, load]);
			const choiceOf = (row) => choices[row.id] ?? initialChoice(row);
			const change = React.useCallback((id, patch) => setChoices((current) => {
				const row = rows.find((entry) => entry.id === id);
				if (row === undefined) return current;
				return { ...current, [id]: { ...(current[id] ?? initialChoice(row)), ...patch } };
			}), [rows]);

			/**
			 * The settings revision of the namespace this plugin writes, or `undefined`
			 * when it cannot be read (the write then proceeds unconditionally).
			 */
			const currentRevision = React.useCallback(async () => {
				try {
					const described = await props.remote?.settings?.describe();
					const value = described?.ok === false ? undefined : described?.value ?? described;
					const view = value?.namespaces?.find((candidate) => candidate.ns === NS);
					return typeof view?.revision === "number" ? view.revision : undefined;
				} catch {
					return undefined;
				}
			}, [props.remote]);

			/**
			 * Write one row. The matrix is fetched again first: this half owns two keys,
			 * and rebuilding the array from a stale copy would drop a concurrent edit.
			 */
			const commit = React.useCallback(async (id) => {
				const settings = props.remote?.settings;
				const say = (text) => setMessages((current) => ({ ...current, [id]: text }));
				if (settings?.mutate === undefined) {
					say("写入失败：设置服务不可用（请重新打开设置页）");
					return;
				}
				const choice = choicesRef.current[id];
				if (choice === undefined) {
					say("没有改动可写入。");
					return;
				}
				const levels = parseLevels(choice.levels);
				if (levels.error !== undefined) {
					say(levels.error);
					return;
				}
				try {
					const response = await fetch(url, { headers: { accept: "application/json" }, cache: "no-store" });
					if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
					const current = routeIn(await response.json(), route);
					if (current === undefined) throw new Error("该提供方已不在配置里");
					const models = current.models.map((row) => (row.id === id ? mergeRow(row.stored, choice) : row.stored));
					/*
					 * `mutate` demands the revision argument explicitly, and passing the real
					 * one buys conflict detection: if the page wrote in between, the write is
					 * refused instead of silently rebuilding the array on a stale copy.
					 */
					const revision = await currentRevision();
					const result = await settings.mutate(NS, buildOps(current.route, models), revision);
					if (result !== undefined && result !== null && result.ok === false) {
						const failure = result.error?.message ?? result.message ?? "写入被拒绝";
						throw new Error(result.error?.code === "settings/conflict" ? `${String(failure)}（请关闭这张卡片再打开，重试一次）` : String(failure));
					}
					say(`已写入 ${id}；显式声明优先于自动匹配。`);
					await load();
				} catch (error) {
					say(`写入失败：${error instanceof Error ? error.message : String(error)}`);
				}
			}, [currentRevision, load, props.remote, route, url]);

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
			 */
			React.useEffect(() => {
				const card = anchor.current?.closest("li") ?? null;
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
					/* Our own cells are React-portaled into the rows; ignore those edits. */
					if (records.every((record) => isOurNode(record.target))) return;
					schedule();
				});
				observer.observe(card, { childList: true, subtree: true });
				read();
				return () => {
					observer.disconnect();
					if (frame !== 0) cancelAnimationFrame(frame);
				};
			}, [anchor]);

			/* The card's own classes, so an injected control is the page's own widget. */
			const classes = React.useMemo(() => {
				const card = anchor.current?.closest("li") ?? null;
				const sample = card?.querySelector('input[type="text"]');
				/*
				 * Only the text input's class is copied. The row's `<select>` class is
				 * deliberately NOT: it carries its own caret as a background image
				 * (`appearance:none` plus a chevron data-URL), and this cell draws DSH's
				 * chevron as a child — inheriting both is what showed two arrows per
				 * picker. The trigger's own `backgroundImage: none` keeps that true even if
				 * a future build moves a caret into the input class.
				 */
				const catalog = sample?.closest("section") ?? null;
				const action = [...(catalog?.querySelectorAll(":scope > button") ?? [])].find((node) => node.querySelector("svg") !== null);
				return {
					control: sample?.className ?? "",
					action: action?.className
				};
			}, [anchor, targets]);

			React.useEffect(() => {
				root.current?.render(targets.map((target) => {
					const row = rowOf(target.id);
					if (row === undefined) return null;
					return createPortal(
						h(Cell, {
							key: target.id,
							row,
							choice: choiceOf(row),
							classes,
							message: messages[target.id],
							busy: status === "saving",
							onChoice: (patch) => change(target.id, patch),
							onCommit: () => void commit(target.id)
						}),
						target.entry,
						target.id
					);
				}));
			}, [targets, matrix, choices, messages, classes, status, change, commit, rowOf]);

			/* A card with no route id (the add-provider draft before it is saved) gets nothing. */
			if (typeof route !== "string" || route.length === 0) return null;

			return h(React.Fragment, null,
				h("span", { key: "anchor", ref: anchor, style: { display: "none" } }),
				h("span", { key: "host", ref: host, style: { display: "none" } }),
				status === "failed" ? h("p", { key: "note", style: styles.failed }, message) : null
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
			ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register(
				{ name: "settings.models.provider-card", key: NS, order: 100 },
				(ownerProps) => h(Panel, { remote: ctx.remote, provider: ownerProps?.provider, configured: ownerProps?.configured })
			));
		}

		exports.name = "dsh-model-metadata-ui";
		exports.apply = apply;
		exports.inject = ["slots", "remote", "remote.settings"];
		/* Exposed so the headless tests can hold these twins against ../panel.mjs. */
		exports.__test = {
			PANEL_FIELDS,
			EDITABLE_FIELDS,
			CELL_ATTR,
			CUSTOM,
			LEVEL_PRESETS,
			formatCapacity,
			parseLevels,
			formatLevels,
			initialChoice,
			mergeRow,
			presetOf,
			levelLabel,
			isDirty,
			readoutOf,
			capacityLine,
			routeIn,
			reloadKeyFor,
			buildOps,
			Cell
		};
		return module.exports;
	}
});
