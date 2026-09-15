# dsh-model-metadata 优化与完善清单

> **状态：本清单中的每一条都已在当前工作区实现**，并补上了对应的回归断言（见文末「本轮改动」）。本文保留为判断依据与背景记录，不再是待办列表。
>
> 内容为通用工程结论，不含任何部署、主机、路径或凭据信息。

审计对象：本仓库（工作区版本 0.1.7）。
审计方式：全文精读 + 对一套真实 DSH 安装（pi-ai 适配器 / pi-ai 目录 / llm-deepseek 目录）+ 真实的 models.dev 快照（约 3701 条 id / 584 KB）实测，附基准与真实 HTTP 请求验证。
审计基线：当时 `npm test` 全绿，`git status` 干净——也就是说，下面这些是「测试抓不到的行为与意图不符」，不是失败用例。每条给出位置、证据、影响、修法。

标注：`[实测]` = 本次跑出来的数字；`[复现]` = 实际执行过的失败；`[代码]` = 读代码即可确认。

---

## P0 真实缺陷（会导致错误行为或用户可见故障）

### 1. 写入按钮没有防重入，`busy` 是死代码 `[代码][实测]`
- 位置：`lib/client.js:456`（`status` 初值 `"loading"`）、`:464/:472/:475`（**全部** `setStatus` 调用）、`:656`（`busy: status === "saving"`）。
- 证据：全仓库 `grep -rn saving` 只命中 `client.js:656` 一处；`status` 从未被设为 `"saving"`，所以 `busy` 恒为 `false`，`"写入中…"`（`:430`）与三处 `disabled`（`:362/:397/:428`）全是死代码。
- 影响：双击「写入」会并发跑两次 `commit(id)`，两次都先 `currentRevision()` 再 `mutate`；第一次成功、第二次拿到 `settings/conflict`，于是用户看到「写入失败…（请关闭这张卡片再打开，重试一次）」——而那次写入其实**成功了**。
- 修法：把保存态改成**按行**的 `saving` map，用早退守卫关掉竞态（`disabled` 只是兜底）：
  ```js
  const [saving, setSaving] = React.useState({});
  // commit(id): if (saving[id] === true) return; setSaving(c => ({...c,[id]:true}));
  //             try { … } finally { setSaving(c => ({...c,[id]:false})); }
  // 渲染:       busy: saving[target.id] === true
  ```

### 2. 编辑器里改/加模型 id 不会触发重读，控件永远不出现 `[代码]`
- 位置：`lib/client.js:593-604`（`read()` 从 `idInput.value` 取值）、`:612-617`（唯一触发器是 `MutationObserver`，`{childList:true,subtree:true}`）。
- 证据：全文没有任何 `input`/`attributes` 监听（只有 `:607/:612` 两处）。React 受控输入的 `value` 是 **DOM property**，不产生 childList 变更，属性变更也没被观察。
- 影响：这正是 0.1.7 想修的「新加的行没结论」问题，只修了一半——点「添加模型」后输入 id，该行不会出现任何控件/结论，直到卡片别处发生 DOM 变更；**改名更糟**：`targets` 仍持有旧 id，之后「写入」会写回旧 id。
- 修法：在同一个 effect 里加事件委托：`card.addEventListener("input", schedule, true)`，cleanup 时移除。

### 3. 写入成功后把其它行的未保存草稿一起清空 `[代码]`
- 位置：`lib/client.js:567`（`await load()`）→ `:471`（`if (options.keepChoices !== true) setChoices({})`）。
- 证据：`:469-470` 的注释明确写着「一次用户没要求的刷新不能丢掉未写入的编辑」，而这里正好违反。
- 影响：A 行、B 行都改过但没写，写 A → B 的草稿和它的「写入」按钮无声消失。
- 修法：`await load({ keepChoices: true })`。安全：写入后新 payload 的 `declared` 等于 A 的选择，A 自然不再 dirty。

### 4. `--purge` 单独使用会变成「重新安装」，而 README 就教用户这么用 `[复现]`
- 位置：`install-plugin.mjs:60/:67`（`--purge` 只置标志，不动 `action`）、`:300-316`（`options.purge` 只在 uninstall 分支里被读）。
- 证据：`node install-plugin.mjs --home <tmp> --purge` 走的是 apply 分支：重新拷贝、重新注册、退出 0，什么都没删。README:149 写的正是 `node install-plugin.mjs --purge`。
- 修法：`if (options.purge && 没有 --uninstall) options.action = "uninstall";`，或直接报错要求显式组合。

### 5. npm 包不包含 `install-plugin.mjs` / `packaging.mjs` / `dev-paths.mjs`，README 的安装/更新/卸载路径对 npm 用户必然失败 `[实测]`
- 位置：`package.json:27-36`（`files` 白名单）。
- 证据：`npm pack --dry-run` 只有 9 个文件：LICENSE、README.md、cordis.patch.yml、lib/{client,index,panel,refresh-snapshot,snapshot}.{js,mjs}、package.json。解包后 `node install-plugin.mjs --apply` → `MODULE_NOT_FOUND`（且该脚本本身还要 import 另两个未发布文件）；`npm test` 同样不可用。
- 影响：README:68/:118/:147-149 提供的「不用 pnpm 的复制安装法 / --update / 卸载」是给 npm 用户看的，却根本跑不起来。
- 修法：把这三个文件加进 `files`（`install-plugin.mjs` 必须与两个兄弟文件同时发布），或把 README 该节改写为「仅在源码 checkout 内可用」；并在 `verify.mjs` 的 packaging 场景加一条断言：README 让用户执行的每个路径都必须在 `files` 里。

### 6. `tests/new-route.mjs` 调用了未定义的 `option()`，该套件必然崩 `[代码][复现]`
- 位置：`tests/new-route.mjs:118` 调用 `option("--url", …)`；该 helper 只在 `tests/browser-check.mjs:31` 与 `tests/fusion-write.mjs:36` 里定义（三份 CDP 驱动是复制出来的，这一份漏了）。
- 影响：`node tests/new-route.mjs` 直接 `ReferenceError`，第 2、3 步（宿主判定、真界面验收）从不执行；文件头还宣传了从未解析的 `--card`。
- 修法：补上 helper（并抽成 `tests/cdp.mjs` 共享），删掉或实现 `--card`。

### 7. `routeIn` 对非数组 payload 会抛错，整张卡片的控件全灭 `[代码]`
- 位置：`lib/client.js:266-268`（`payload?.routes?.find(...)`），在 `:484` 的渲染路径上、任何 try 之外；`?? []` 挡不住「真值但非数组」，`:500` 的 `rows.map` 也会跟着抛。
- 影响：任何形状异常的响应（同路径代理、异版本宿主、`{"routes":{}}`）都会让这张卡片的 cell 抛异常；虽然 DSH 的 `SlotErrorBoundary` 把它限制在这张卡，但该卡的控件整体消失。
- 修法：`Array.isArray(payload?.routes) ? payload.routes : []`，并在 `:484` 对 `entry?.models` 做同样保护。

### 8. 目标行已经不存在时仍报「已写入」 `[代码]`
- 位置：`lib/client.js:554`（用新拉到的 `current.models` 重建数组）+ `:566`（无条件报成功）。
- 影响：两次请求之间该 id 被改名/删除时，什么都没写，却提示成功。
- 修法：`if (!current.models.some(row => row.id === id)) throw new Error("该模型已不在配置里，请重新打开这张卡片");`

---

## P1 正确性与风险

### 9. 面板路由不在应用鉴权门后，可被匿名访问（Host 也不校验）`[实测]`
- 位置：`lib/index.mjs:578-618`（`registerPanel`）。
- 实测（对正在运行的服务直接发起请求）：
  | 请求 | 结果 |
  |---|---|
  | `GET /`（无 token） | **401** |
  | `GET /api/settings/describe`（无 token） | **401** |
  | `GET /model-metadata/matrix`（无 token） | **200**，37 664 B |
  | 同上 + 伪造外部 `Host:` 头 | **200**（Host 未校验） |
  | 响应头 | 无 `access-control-allow-origin`（跨域 JS 读取被挡），无 `Allow`（405 时） |
- 载荷确认无凭据（只有 route/displayName/api + 每模型 4 个字段：`declared`/`id`/`matched`/`name`/`nearby`/`stored`），但会公开网关路由名与全部模型清单，且匿名请求可触发一次快照下载（见 P1-13）。
- 这与 README 当时的说法一致（「插件路由没有鉴权钩子」），但措辞低估了后果：任何反代或端口转发的部署，都会把这份清单一起公开。
- 修法（不需要 DSH 提供鉴权钩子）：用环境变量白名单校验 `Host`，不符返回 403；拒绝 `sec-fetch-site: cross-site` 与跨源 `Origin`（挡 DNS rebinding 与外部页面读取）；提供开关彻底关掉面板路由；并在 README 里把这个事实写清楚。

### 10. models.dev 同名多源没有质量加权，赢家由 JSON 键序决定 `[实测]`
- 位置：`lib/index.mjs:288`（`route: models.dev:<provider>`）与 `:629-637`（`rank`）；`UPSTREAM`（`:121-142`）只认裸供应商名，永远匹配不上 `models.dev:xxx`，所以快照候选一律落到 `3000 + sequence`（= 插入顺序 = `api.json` 里的键序）。
- 实测（真实快照）：2370 个裸名中 1754 个只有 models.dev 认识；其中 **215 个（12%）被 >1 家供应商的同名条目声明，94 个（44%）上下文互相冲突**，最极端的 4 个差 16000–128000 倍（`gpt-image-2` ×128000、`gpt-4o-mini-transcribe` ×16000）。按最终排序统计：2525 个裸名里 **159 个赢家是 models.dev 条目、且同名其它条目数值互相矛盾**（`qwen2.5-vl-72b-instruct`：cortecs 32000 / nano-gpt 65536 / openrouter 128000；`gemini-2.0-flash`：1048576 vs 990000）。（本轮审计所用的那套配置里，被配置的名字正好 0 例命中——这是潜伏问题，不是已发生的错误。）
- 修法：偏好测试前先剥掉 `models.dev:` 前缀（让 `deepseek:*`、`qwen:*` 能命中厂商）；剩余并列改为确定性排序（最大上下文优先，或按 provider 名稳定排序），而不是文件顺序。

### 11. 推理等级「过度声明」，与图片路径的谨慎不对称 `[代码][实测]`
- 位置：`lib/index.mjs:756-760`（只凭 `matched.reasoning === true` 就写 `reasoning: true` 并复制/合成 `thinkingLevelMap`）+ `:845-854`（`supportedLevels`：没有 map 时除 `xhigh`/`max` 外全部视为支持）。
- 证据：`tests/hot-snapshot.mjs:70` 明确断言快照里一个只有 `reasoning: true` 的条目会产出 **`off/minimal/low/medium/high` 五个等级**。而 `input` 路径为此专门做了 `INPUT_MODE`/`bundled` 分级，注释还写明「过度声明会在消息落盘后才失败」。
- 影响：模型实际只支持 `low/high` 时，界面会提供 `minimal`，用户选了就可能被上游拒绝（`resolveReasoningLevel` 只按这份合成清单校验，不会拦）。
- 修法：只声明来源能作证的等级（pi-ai 目录 / 官方目录带 `thinkingLevelMap` 的照抄；来自 models.dev/聚合器的 `reasoning: true` 只给保守子集，或与 `input` 一样加开关），并同步 README。

### 12. 未知开关值会静默选中最宽松的行为 `[实测]`
- 位置：`lib/index.mjs:79-93`、`:109`。
- 证据：`DSH_PI_AI_CATALOG_FALLBACK=ofl` → 当作 `full`；`..._FALLBACK_INPUT=of` → 当作 `on`；`..._REFRESH_ON_START=never` → 当作 `always`（`startDue()` 返回 true）。拼错一个字母就从「不抓图/不刷新」滑到最激进的分支。
- 修法：枚举白名单校验，不认的值只做一次 warn 并按**更保守**的默认处理（INPUT 未知 → `off`）。

### 13. 刷新失败后按请求频率重试，且匿名请求也能触发 `[代码][实测]`
- 位置：`lib/index.mjs:543-553`（`refreshing` 只合并**并发**请求）、`:606`（面板路由触发 `open`）、`:483-487`；`lib/snapshot.mjs:17`（超时 180 s）。
- 影响：一次失败不改变文件年龄 → 下一个面板请求（可能是匿名的）就再来一次 ~5 MB / 180 s 的下载；网络长期不可用时会持续重试，也可能被当成放大器。
- 修法：记 `lastAttemptAt`（要求距上次**尝试** ≥ max(OPEN_HOURS, ~5 min)），或连续失败退避。

### 14. `loadFromRoots` 碰到第一个「文件在但 import 失败」的 root 就整体放弃 `[代码]`
- 位置：`lib/index.mjs:176-191`：`:183` 直接 `return { failure }` 而不是继续试下一个 root。
- 影响：一个有残留/半删除的副本会遮蔽可用的 DSH 副本，插件静默停用（只有一行 warn）。相关：4 次调用每次都重建 `nodeModuleRoots()`（含 `~/.nvm/versions/node` 的 `readdirSync`，28.5 µs/次），nvm 目录是硬编码猜测且与 `$DSH_HOME/profiles/node_modules` 重复；多版本时由 readdir 顺序决定用哪份安装。`install()` 也可能给「DSH 根本不用」的那份 `PiAiAdapter` 打补丁。
- 修法：记录失败后继续；把 `$DSH_HOME/profiles/node_modules` 保持优先、nvm 扫描降级或删除；用 `createRequire(<适配器文件>).resolve("js-yaml")` 从适配器自己的依赖树解析（[实测] 可用），不再猜 root。

### 15. `firstPartyCandidates()` 的 `bare: model.id` 未做裸名处理 `[代码]`
- 位置：`lib/index.mjs:437`。其余来源都走 `bareName()`；而 `llm-deepseek` 只校验 id 非空、不去前缀。
- 影响：用户在 `llm-deepseek` 段里把 id 写成 `deepseek-official/deepseek-v4-pro`，就会生成一个 `candidatesFor` 永远查不到的键，官方目录静默失效。
- 修法：`bare: bareName(model.id)`。

### 16. 快照 `source` 字段硬编码为默认 URL `[代码]`
- 位置：`lib/snapshot.mjs:53`（`source: SNAPSHOT_URL`）而 `fetchModelsDevSnapshot(url = SNAPSHOT_URL)`（`:63-66`）把 `url` 丢掉了。
- 影响：`--url <镜像>` 或 `DSH_PI_AI_CATALOG_SNAPSHOT_URL` 指向别处时，快照仍自称来自 models.dev，排查时误导。
- 修法：给 `flattenModelsDev` 加 `url` 参数并写入实际地址。

### 17. 只读部署仍提供「写入」按钮 `[代码]`
- 位置：`lib/client.js:519`（`describe()` 已经能拿到 `writable`，但只用了 `revision`）。
- 影响：`readOnly` 的部署里写入必然失败，用户白点。修法：加载时缓存 `writable`，为 false 时禁用按钮并说明原因。

### 18. `closest("li")` 让「添加提供方」草稿卡完全没有控件 `[代码]`
- 位置：`lib/client.js:590`、`:627`。正式卡片是 `li.rowCard`，但添加卡是 `div.addCard`（`dsh-client-ui-settings-models`），其祖先没有 `li`，于是 `card === null` → 无观察器、无 cell、连失败提示都没有（该卡其实已有 route）。
- 修法：改为向上找「真正含行切换按钮」的祖先（有界循环 + `rowToggles(node).length > 0`），再退回 `closest("li")`。

### 19. 快照把图片/向量/转写模型也当聊天模型收录 `[实测]`
- 位置：`lib/snapshot.mjs:31-53`（只滤模态，不滤模型种类）。
- 证据：冲突最严重的名字正是这一类（`gpt-image-2`、`gpt-4o-mini-transcribe`、`gemini-embedding-2`），其 `limit.context` 对聊天毫无意义；`input` 只保留 `text`/`image`，音频模型会被当作纯文本。
- 修法：按 id 关键词（`embedding`/`image`/`transcribe`/`tts`）或输出模态降级/剔除；至少让「只有 text 输入且无 reasoning」的非聊天条目排在最后。

### 20. HMR/热重载后旧实例继续持有增强逻辑 `[代码]`
- 位置：`lib/index.mjs:864-868`（`Symbol.for("…/installed")` 守卫）、`:949-952`（报 `already-installed`）。
- 影响：cordis HMR 会先 dispose 旧插件、不会重复注册路由（这一点是对的），但增强包装仍属于**旧**模块闭包，新实例直接短路：`DSH_PI_AI_CATALOG_FALLBACK=off` 之类的环境变量改动只有整进程重启才生效，而日志写的是 `already-installed`，看不出这件事。
- 修法：让最新实例接管包装（保存一个可变句柄），或把日志改成「已由先前加载的实例接管，改配置需重启」。

---

## P2 性能（均为实测数字）

### 21. 面板一次 GET 就有 19–21 ms 同步阻塞 CPU `[实测]`
- 位置：`lib/index.mjs:596-599` + `lib/panel.mjs:50-85`：每次请求都对全部已配置模型做一次 `inspect()`，`?provider=` 过滤发生在**计算之后**。
- 影响：载荷只取决于索引 revision，但每个请求都重算一遍；面板每张卡各发一次请求（见 P2-25），N 张卡 = N × 20 ms 阻塞事件循环（会影响同一进程里正在跑的会话）。
- 修法：按 revision 做单条 memo（重复请求只剩 `JSON.stringify`）；或先按 provider 过滤再 inspect（单卡约 21 → 10 ms）。

### 22. `enrichModel` 完全没有缓存 `[实测]`
- 位置：`lib/index.mjs:738-773`（每次重算）、`:728-730`/`:317-321`/`:687-707`（每次 4.9 次 `statSync`）。
- 实测：单模型 p0 11.6 µs / **p50 111 µs / p90 234 µs / max 1087 µs**；重复调用耗时完全一致（说明没有负缓存）。`getModels` 一轮 200 个模型 **9.5 ms**，同场景无插件基线 ≈ 0 ms（适配器的 models 数组是现成的）。
- 关键细节：值没变时 `enrichModel` 返回**原对象**（`:772`），`ENRICHED` 标记因此永远留不下，下一轮请求又全量匹配一次。
- 修法：按 `${provider}\0${id}\0${revision}` 做 Map/WeakMap 缓存（连「无匹配」也缓存），或把标记打在原对象上。

### 23. `rank()` 在排序比较器里被反复重算 + 候选重复 `[实测][代码]`
- 位置：`lib/index.mjs:629-637`（每次调用跑 12 条正则 + 39 元素 `indexOf`）、`:669`、`:786`；重复候选来自 `:651`：`[...byName.get(bare), ...byLower.get(bare.toLowerCase())]` **没有去重**（`:656` 的 `includes` 只保护 norm 层），裸名通常已是小写 → 每个候选都进两份。
- 实测（在一条真实配置上）：某个名字的 `inspect()` 触发 446 次 `rank()`，重名最多的那个触发 2418 次；候选 52 条里只有 28 条不重复（`gpt-oss-120b` 这类公开模型名 75/26，`kimi-k3` 64/30）。
- 影响：`inspect()` 的诊断列表重复（面板不转发 `candidates`，所以只是诊断误导）+ 排序工作量翻倍。
- 修法：`[...new Set([...])]`；排序改成 decorate-sort-undecorate（每个候选算一次 rank）；再按 (bare, revision) 记忆胜者。

### 24. 「同家族邻居」扫描无上限 + O(n²) 去重 `[实测]`
- 位置：`lib/index.mjs:804-824`：遍历整个 `byNorm`（3459 个键），把所有命中都推进 `hits`（`hits.some` 去重是 O(hits²)），再整体排序，最后 `slice(0,5)`。
- 实测：常见词头代价暴涨——`gemini` 头 1.79 ms/次、`kimi` 头 2418 次 `rank()` / 1533 µs、`doubao` 733 µs（稀有词头只要 0.13 ms）。
- 修法：Set 去重 + 攒够 ~200 条就停（或用 5 元插入代替全排序）。

### 25. 浏览器端每张卡片一挂载就发请求（折叠时也发、无 route 的草稿卡也发）`[代码]`
- 位置：`lib/client.js:449`（拼 URL）、`:480-482`（挂载即 `load()`）、`:667`（`return null` 在所有 hook **之后**，所以草稿卡也会跑完 hook 并发请求）。
- 影响：打开设置页时 N 个 provider 卡 = N 次 `/model-metadata/matrix`，每次在宿主端就是 P2-21 的 ~20 ms 阻塞；而控件的 cell 只在编辑器**展开**时才存在，这些请求大多数是白做的。
- 修法：把首次 `load()` 推迟到 `targets.length > 0`（编辑器展开）时触发；`route` 为空时直接跳过请求。

### 26. 一次写入三次往返 `[代码]`
- 位置：`lib/client.js:519`（`describe()`，会连每个 namespace 的 schema 一起回传，只为读一个 `revision`）、`:550`（再拉一次 matrix）、`:567`→`:466`（写后又拉一次同样的 matrix）。
- 修法：`revision` 由宿主放进 matrix 载荷（或复用 `mutate` 的返回 `value`），写后用已有响应刷新读数，省掉一次 GET 与一次全量 `describe()`。

### 27. 缺 HTTP 条件请求（models.dev 支持 ETag）`[实测]`
- 位置：`lib/snapshot.mjs:63-66`、`lib/index.mjs:509-523`。
- 实测：`HEAD https://models.dev/api.json` 返回 `etag: W/"387b50…"`；带 `if-none-match` 时返回 **304、0 字节、`response.ok === false`** —— 也就是说直接加头会被现有 `if (!response.ok) throw` 当成失败。
- 修法：把 etag 存进快照（或 `{etag,checkedAt}` 边车，避免为一次检查重解 584 KB），发送 `if-none-match`，把 304 视为「已最新」。

### 28. 模块加载是 4 个串行 top-level await（低优先）`[实测]`
- 位置：`lib/index.mjs:193-202`。冷进程 import 287 ms（适配器 255–277 ms + pi-ai all 65 + js-yaml 10–12 + llm-deepseek 29–35），但**在真实 DSH 进程内适配器已是模块缓存命中（0.29 ms），插件增量只有 5.2 ms**——所以别为 287 ms 大改。
- 修法：`Promise.all` 并行即可（顺带省掉重复的 `nodeModuleRoots()` 扫描）；`officialThinkingLevelMap` 的 TLA 探针只要 0.21 ms，保持原样。

---

## P3 可维护性、一致性、文档

### 29. 重复逻辑应收敛
- 裸名/规范化在 `lib/index.mjs`（`bareName`/`normalizeName`）、`lib/refresh-snapshot.mjs:85,90`、`test-fallback.mjs`、`lib/client.js` 各写一遍；等级表有 **三份**（`index.mjs:387` `OFFICIAL_LEVELS`、`:836` `THINKING_LEVELS`、`client.js:80` `LEVELS`），再加 pi-ai 自己的 `EXTENDED_THINKING_LEVELS`。
- `lib/index.mjs:845-854` 是 pi-ai `getSupportedThinkingLevels` 的手抄（语义[实测]一致）。pi-ai 新增等级时，插件会静默落后（面板不提供，或提供了却被适配器拒）。
- 修法：抽 `lib/names.mjs` 供三处共用；等级判定改为按绝对路径加载 pi-ai 的 `dist/models.js` 并直接调用（注意 `@earendil-works/pi-ai` 主入口 195 ms/74 MB，且 `dist/*` 不在 exports map 里，只能用现有 `loadFromRoots` 绝对路径加载——`js-yaml` 则可以用 `createRequire(适配器).resolve()`）。

### 30. 死代码
- `lib/client.js:205-218` `capacityLine()` 生产路径**从未调用**（`readoutOf` 另写了一份；只有 `tests/panel.mjs:178` 在断言它，看起来像 UI 输出）。
- `lib/client.js:637-638` `classes.action` 的 svg 过滤在真正生效的 pi-ai 编辑器里匹配不到（那边「添加模型」按钮无 svg，只有 DeepSeek 编辑器有），所以始终走 `styles.actionFallback`——两条路都要维护。
- 另有：`props.configured`（`:687` 传入、`Panel` 从不读）、`dirty`（`:437-439` 只是 `isDirty` 的别名）、`lib/index.mjs:561` `PANEL_PATH` 外部无引用、`package.json:24` `exports["./cordis.patch.yml"]` 是死的（`dsh-app-boot` 直接按 `dsh.bundle.patch` 拼路径，不走 exports）、`exports["./refresh-snapshot"]` 没有 `bin` 也无人能 import。

### 31. 注释与代码不符
- `lib/index.mjs:19-20` 说形状不符时「降级为 no-op 并打一行日志」，实际 `:880` 直接返回、**不打日志**。
- `lib/index.mjs:594-595` 说未知 `?provider=` 会「返回整个矩阵」，实际返回 `{"routes":[]}`（`tests/panel.mjs:271` 也这么断言）。
- `lib/index.mjs:914` 整个替换 `info.context`（今天无害，写成 `{...info.context, contextWindow}` 更稳）；`:587` 的 405 没有 `allow: GET, HEAD`；`:613` 对 HEAD 也完整计算 body。
- `lib/client.js:11-12` 说 cell 「直接落在该行容量格之上」，实际 portal 成为 `div.modelEntry` 的**最后一个子节点**（首次挂载时展开的容量格在它上面）；`:317` 说容量格「shape for shape」，但 padding 与 `.modelAdvanced` 不同；`:280` 说「重新打开总会刷新」，实际只有存在未知行时才刷新；`:44-45` 说「测试断言两边一致」，18 个 `__test` 导出里只有 3 个有宿主对应物（`client.buildOps`——真正写盘的那个——从没和 `panel.buildOps` 比对过，`NS` 是第 4 份未断言的命名空间副本）。

### 32. `install-plugin.mjs` 的健壮性（该文件目前零测试）
- `:61-73` 取值型参数缺值时静默回退：`--profile`（无值）→ 落到**家目录级**补丁；`--home`/`--install`/`--unit-dir` 同理；`--vision`（无值）静默忽略并退出 0。
- `:271-298` `--check` 即使 pre-flight FAIL 也退出 0（同时打印「ok registered」）。
- `:300-316` `--uninstall` 不清理 `--vision` 写下的 systemd drop-in（`--purge` 也不清），状态会永久残留。
- `:253-266`/`:334-337` 从不删除安装目录里已不在 `FLAT_SOURCES` 的旧文件（`--check` 反而说「up to date」）；反之，`lib/` 里新增文件若忘了加进 `packaging.mjs:20`，既不会安装也不会报错。
- `:36-37` `HOME` 未设置时会把 `~/.dsh` 解析成**相对路径** `.dsh`（systemd 环境下会落到服务工作目录）；应改用 `os.homedir()` 并校验绝对路径。
- `:123-141` `stripRows` 只在标记行**紧接** `- ` 时生效：中间夹一个空行或注释块，行就删不掉 → `--apply` 之后出现**两行同 id**（正是标记设计要避免的「同一插件加载两次」），而 pre-flight 只在写完之后才发现并退出 2，重复行留在文件里。
- `:111-113` `isRegistered` 过宽（任何 `id: dsh-model-metadata` 都算「我们注册的」）+ 未转义就把包名塞进 `RegExp`。
- `:157-171` pre-flight 把包名当路径 `existsSync`，合法的 `name: dsh-model-metadata` 会被报成「指向不存在的文件」。
- `:365-369` 错误信息指向的路径不是真正失败的那个（profile 目录不存在时，先拷完文件再在写补丁时报错，留下半装状态）。

### 33. 测试覆盖与脚手架
- **没有**：`install-plugin.mjs` 的任何行为测试（只有 `verify.mjs:157-160` 几条源码正则）；`flattenModelsDev`/`fetchSnapshotNow`/HTTP 失败路径；`DSH_PI_AI_CATALOG_FALLBACK=off|context`；显式 `input:` 优先；客户端的**写入路径**（只在可选的 `tests/fusion-write.mjs` 里，需要真浏览器 + 运行中的 dsh，且判据 `style.display !== "none"` 恒真 → 连 `busy` 回归都测不出来）；同尺寸重写的 mtime+size 变更键；「只写快照文件」的承诺。
- 脚手架重复 3–5 份：`expect()`（4 份 + `hot-add-model.mjs` 的临时版本）、临时目录 + `DSH_PI_AI_*` 环境（5 份）、cordis ctx/适配器 stub（5 份）、CDP 驱动（3 份，其中一份就是 P0-6 的漏改副本）。建议 `tests/harness.mjs`、`tests/adapter-stub.mjs`、`tests/cdp.mjs`。
- `verify.mjs:52-53` 解析子进程 stdout 用 `indexOf("[")` 且无 try/catch（多一行带 `[` 的输出就变成未捕获 `SyntaxError`），`tests/new-route.mjs:99` 又用 `lastIndexOf("\n[")` 解析同一个子进程。
- `verify.mjs:167-172` 的 `suite()` 只断言子进程退出码，把「N/N assertions passed」当标签；`hot-add-model.mjs` 输出 `PASS:` 不含该字样 → 摘要静默退化成「exit status」。
- `tests/refresh-policy.mjs:64,78,84-85` 拿被测对象自己当期望（`startFloorMinutes` 默认 15 改了也照样绿），而 `hours`/`openHours` 却在 `:111-112` 硬钉住——不一致。
- `tests/hot-add-model.mjs:24` 不做 `rmSync` 预清、只在最后一行清理，且**不固定快照路径**，单跑时会拿用户机器上的真实快照判定。
- `test-fallback.mjs:59-64` 不固定刷新策略与快照路径：手动跑一次会真的去下载并覆盖用户的 `$DSH_HOME/models-dev-snapshot.json`（`verify.mjs:47` 自己有 `DSH_PI_AI_CATALOG_REFRESH=0`，`tests/new-route.mjs:90-97` 却漏了）。镜像目录用固定 `runtime/<sha1>`、只在 `exit` 清理 → 并发跑互相踩、崩溃留残留（`.gitignore` 的 `tests/.*/` 也盖不住根目录的 `runtime/`）。
- 无 CI（没有 `.github/`）；注意 `verify.mjs` 全家都需要**真实安装的 DSH**（`dev-paths.mjs:66-70` 找不到就抛），README 开发节没提这个前提。

### 34. README 与代码漂移
- `:160` 「npm test = verify.mjs + 下面三个回归」不准：`package.json:63` 是 verify+panel+hot-snapshot+refresh-policy，而 `verify.mjs:174-178` 自己又跑 panel/hot-snapshot/hot-add/refresh-policy（策略套件还跑两遍）——每个回归都跑两次，且 `tests/hot-add-model.mjs` 在 README 的清单和文件地图里都没出现。
- `:169`/`:172` 的一行命令缺了必需的 `--source`，而 `test-fallback.mjs:44-47` 没有 `--source` 直接退出 1（「它会自己找到已安装的适配器」不成立）。
- `:148-149` 教用户用有缺陷的 `--purge`；`--check`/`--vision bundled|off`/`--unit`/`--unit-dir`/`--home`/`--install` 全无文档（drop-in 那套机制在 README 里完全没露面）。
- `:155` 「删掉 `registerPanel(ctx, logger)` 一行，其它功能不受影响」低估了影响：该函数也是「打开界面触发刷新」的唯一入口（`index.mjs:606`），删掉即失去 README:97 承诺的行为，客户端两个开关也失效。
- 环境变量表缺 `DSH_CATALOG_FALLBACK_NODE_MODULES`、`DSH_PI_AI_SETTINGS_FILE`、`PLAYWRIGHT_CHROME`、`LIVE_REFRESH_DEADLINE_MS`；`…_REFRESH_ON_START` 没写可取值（`always|stale|off`）；`:127` 的后缀表少了 `-experimental`（`NAME_SUFFIXES` 里有）。
- `:99`/`:195` 的路径只对 npm 布局成立（扁平安装是 `$DSH_HOME/plugins/<name>/{index.mjs,refresh-snapshot.mjs}`，npm 是 `<pkg>/lib/index.mjs`）；`:189` 说 `dev-paths.mjs`「无硬编码路径」，但同类逻辑在 `index.mjs:168-171`、`refresh-snapshot.mjs:58-61` 里各抄了一份带 nvm 硬编码的版本。
- 建议：加 `CHANGELOG.md`；把「已发布到 npm 的包不含安装器」这件事写清楚。

### 35. i18n（两个开关全中文，而 DSH 自己是双语）
- DSH 客户端有 locale 服务：`ctx.locale.register(ns, {zh, en})` + `ctx.locale.bind(ns)`（`@deepseek-ai/dsh-client-locale`，一线插件都这么用），而本插件 `inject` 里没有 `locale`，`client.js` 里 20 多条中文串全部硬编码。
- 影响：在英文界面里，这两行是页面上唯一的中文；README 有英文段、包已发布到 npm，目标用户包含非中文用户。

### 36. 可访问性
- 触发器有 `aria-haspopup` 却没有 `aria-expanded`——那是被刻意让出来当行锚点的。可以把 `rowToggles` 的过滤改成「排除 `[data-model-metadata-cell]` 内部」，然后正常使用 `aria-expanded`。
- 每行结论（`:418-421`）与失败提示（`:672`）没有 `role="status"`/`aria-live`，所以「已写入/写入失败」永远不会被读屏播报（官方页面自己的保存提示用的是 live region）。
- 写入成功后按钮卸载，焦点掉回 `<body>`。
- 我们自己的 portal React root 没有 error boundary：一旦抛错，整张卡的 cell 全灭（DSH 的 `SlotErrorBoundary` 只保住卡片本身）。

### 37. 解析与清理的边界
- `nonNegative`（`index.mjs:205-208`）用 `parseFloat`：`DSH_PI_AI_CATALOG_REFRESH=0x10` → 0 → **静默关闭所有自动刷新**（`abc`/空串/`-5`/`Infinity` 都能正确回退，只有十六进制这种会中招）。修法：先用 `/^\d+(\.\d+)?$/` 校验。
- 快照损坏时静默吞掉（`index.mjs:297-299` 把 `entries: []` 连同损坏文件的 mtime/size 一起缓存，没有任何日志；只有 `apply()` 那行「snapshot entries 0」能间接看出）。修法：按变更键只 warn 一次。
- `refreshSnapshotNow` 写入失败/改名失败会把 `${path}.tmp-${pid}` 永久留下（只有日志），应 `try/finally rmSync`。
- `refresh-snapshot.mjs:34` `--timeout-ms` 给非数字会让 `AbortSignal.timeout(NaN)` 抛 RangeError；`--out`/`--settings` 缺值同理（`option()` 读到 `undefined`）。`:85-92` 的覆盖率报告只做「小写裸名全等」，与运行时的规范化匹配不一致 → 会被判成「未覆盖」的模型其实能匹配。
- `index.mjs:320` 的索引 revision 只含 `(stamp,size)` 不含路径：把 `DSH_PI_AI_CATALOG_SNAPSHOT` 换到另一个恰好同尺寸同 mtime 的文件上不会导致重建（几乎不可能触发，但加上路径零成本）。

### 38. 杂项
- `.gitignore` 只有 `node_modules/`、`*.tgz`、`tests/.*/`：`test-fallback.mjs` 崩溃留下的仓根 `runtime/` 不在内（而且 `tests/.*/` 只匹配目录，不匹配 `tests/.perf.yaml` 这类文件）。
- `tests/browser-check.mjs:342` / `tests/fusion-write.mjs:293` 结尾的 `if (!existsSync(CHROME)) process.exit(2)` 是死判断（`chromePath()` 已保证存在），且这两个工具在**验收失败**时也不返回非零退出码。
- `verify.mjs:168` 给子套件传 `process.argv.slice(3)`（应为 `slice(2)`）；今天没有子套件解析 argv，所以是死代码。
- 两个安装器/工具都没有 `--help`（会走到 "unknown argument" + exit 1）。
- `tests/panel.mjs:77` 断言的 `homePatchRow()`，`install-plugin.mjs` 根本没用（它自己拼 `rowText`）——测试钉住了一个没人发出去的东西。

---

## 已经做得好的地方（本次审计中确认无问题，避免误改）

- 包装接缝选得准：`PiAiAdapter.current()` 按 `profiles` 身份记忆，所以 WeakMap 缓存确实命中；`getModel`/`getModels` 拦截覆盖了 `modelOf`/`listModels`/`modelInfo` 三个消费者；Proxy 的其他属性绑定/`instanceof` 行为正常。
- `isCatalogued()` 的 route+id 短路是对的（适配器确实用 route 键作 pi-ai provider id，且对自建网关（未出现在内置目录里的 route）不会误触发）。
- `Symbol.for(.../installed)` 守卫能挡住二次加载；cordis HMR 会先 dispose 旧插件再加载，路由不会被注册两遍。
- `supportedLevels` 与 pi-ai 的 `getSupportedThinkingLevels` 语义一致；`supportedLevels`/`xhigh`/`max` 的处理与上游相同。
- 当前快照里没有任何候选的 `input` 缺 `text`（5059 个候选 / 3701 条快照行都是 0 例），所以「替换 input 会丢 text」在今天不可达。
- 规范化层的疑似误匹配经核查是合法的分隔符/别名变体（296 个键）；唯一的跨 id 显示名撞车（`GLM-5.2-FP8` → `glm52`）因为 `zai` 家族优先而不会获胜。
- `?provider=` 过滤后未知路由返回空数组（不是别人的数据）——`tests/panel.mjs:271` 有断言，`routeIn` 也按名字而不是位置取路由。
- `Menu` 的 `selectedId`/`onSelect`/`onClose`/`items`/`anchor` 用法与已安装 DSH 构建一致；`remote.settings.mutate/describe` 的读取（含 `settings/conflict`）正确。
- 原子写（同目录临时文件 + rename）、刷新去重、包布局再指向（`installedManifest`）、`dsh.client.inject` 的用法都与 in-box 约定一致。

---

## 建议的动手顺序

1. 安全与「假成功」类：9（路由暴露/加固或至少写清文档）→ 1（写入防重入）→ 8。
2. 用户可见的功能缺口：2（input 监听）→ 3（草稿被清）→ 18（添加卡无控件）→ 17（只读仍可写）。
3. 会静默失效的：14（root 失败即放弃）→ 12（未知开关值）→ 15（first-party 裸名）→ 16（source 字段）。
4. 打包与发布：5（files）→ 4（--purge）→ 32（安装器健壮性）+ 33（给它补测试）。
5. 性能（按收益/成本）：21（面板 memo + 先过滤）→ 22（enrich 缓存）→ 23（去重 + rank 外层化）→ 25（客户端延迟到展开）→ 24 → 26/27。
6. 一致性与文档：29（抽公共模块 + 复用 pi-ai 等级）→ 31/34（注释与 README 修正）→ 35/36（i18n 与 a11y）→ 37/38。

## 本轮改动

新增：`lib/names.mjs`（名称规则的唯一出处）、`tests/harness.mjs`（套件共用脚手架）、`tests/unit.mjs`（纯函数回归）、`tests/install-plugin.mjs`（安装器回归）、`tests/cdp.mjs`（三个浏览器工具共用的 CDP 驱动）、`CHANGELOG.md`、`.github/workflows/test.yml`。

修改：`lib/client.js`（1/2/3/7/8/17/18/22/26/30/31/35/36 全部客户端项）、`lib/index.mjs`（9/10/11/12/13/14/15/20/21/22/23/24/27/28/29/31/37/38：其中 11 新增 `DSH_PI_AI_CATALOG_FALLBACK_LEVELS`，29 改为调用 pi-ai 自己的等级表并保留镜像作为兜底）、`lib/snapshot.mjs`（16/19/27，并让同一 id 被多家供应商发布时两行都保留）、`lib/panel.mjs`（21 的先过滤）、`lib/refresh-snapshot.mjs`（37：参数取值校验、`--help`、临时文件清理、覆盖率报告改用运行时的同名规则）、`install-plugin.mjs` + `packaging.mjs`（4/32）、`test-fallback.mjs`（33 的自伤风险：默认改用自带临时快照、`--source` 可省、`--json-out`、镜像目录带 pid）、`verify.mjs`（33 的子进程摘要必须存在且 `N===M>0`；新增三条漂移守卫：import 的模块必须已发布、`FLAT_SOURCES ⊆ files`、代码读取的开关必须在 README 里）、`tests/*`（同尺寸重写、损坏快照只告警一次、开关取值、面板路由 403/Host 白名单/PANEL=off/HEAD/405、attempt floor、304、双语键集与依赖同级、同 id 双行保留等新增断言）、`tests/harness.mjs` 统一脚手架、`package.json`（`files` 补齐为 14 个文件、`test` 只跑 `verify.mjs`、新增 `test:unit`、版本 0.2.0）、`README.md` + `CHANGELOG.md`（34 的全部漂移项，以及 35/36 的说明）、`.gitignore`（测试与工具不再在仓库内留目录）。

验证：`npm test` 全绿（`verify.mjs` 65/65，含 `tests/unit.mjs` 74/74、`tests/install-plugin.mjs` 122/122、`tests/panel.mjs` 91/91、`tests/hot-snapshot.mjs` 11/11、`tests/hot-add-model.mjs` 5/5、`tests/refresh-policy.mjs` 42/42 与 26/26）；`npm run test:unit` 在无 DSH 安装的机器上同样通过；发布包经 `npm pack --dry-run` 核对为 14 个文件。
