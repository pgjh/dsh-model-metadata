# dsh-model-metadata

[![npm](https://img.shields.io/npm/v/dsh-model-metadata?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-model-metadata)
[![license](https://img.shields.io/npm/l/dsh-model-metadata?color=3da639)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-model-metadata?color=5fa04e)](package.json)

已发布到 npm（`dsh-model-metadata`），源码在 [github.com/pgjh/dsh-model-metadata](https://github.com/pgjh/dsh-model-metadata)。

> **English** — Fills in the missing capability metadata of models you declared yourself on a
> custom gateway (context window, output cap, reasoning levels, can it see images). Every
> model is looked up **by name** at runtime; nothing is written to your settings, and no DSH
> file is touched.

**一句话**：你在 DSH 里接自己的网关时，模型往往只写了个名字。这个插件按**模型名**去目录里查一次，把上下文长度、输出上限、推理等级、能不能看图补上。

## 这是怎么回事

接自定义网关时，`settings.yaml` 里一般只写 id：

```yaml
llm-pi-ai:
  providers:
    my-gateway:                     # 你给这个网关起的名字
      api: openai-responses
      baseURL: https://gateway.example/v1
      models:
        - id: my-gateway/gpt-4o
          name: gpt-4o
        - id: my-gateway/claude-sonnet-4-5
          name: claude-sonnet-4-5
```

问题是 DSH 查元数据的方式：它拿**网关名 + 模型 id 原样**去内置目录里对，而 `my-gateway` 当然不在目录里。于是这两个模型被当成"什么都不支持"：

- 上下文按 256K 算 → 长对话被提前压缩，或者反过来爆掉；
- 没有推理等级 → 模型选择器写着「当前模型未提供推理等级。」；
- 只能收文字 → 发图片直接被拒。

但 `gpt-4o`、`claude-sonnet-4-5` 这些名字，目录里其实都有。差的只是**按名字查一次**。

## 插件做的事

1. **按模型名查**：取 id 里最后一个 `/` 后面的名字（`my-gateway/gpt-4o` → `gpt-4o`），依次找 DSH 内置目录、opencode、models.dev 快照，查到之后，就把这个模型该有的上下文长度、输出上限、推理等级、图片支持补上去。
2. **只补缺的**：你在 `settings.yaml` 里亲手写过的字段，它不动。
3. **界面上给你两个开关**：推理等级、视觉。DSH 官方界面没有这两个控件，这里是唯一的图形入口；改完点「写入」固定下来，不点就一直跟着目录走。
4. **目录数据自己更新**：启动、打开界面、每天各检查一次 models.dev，所以新模型不用你手动管。

## 安装

装插件用的是 pnpm（和 npm 一个意思），先确认有：

```sh
corepack enable pnpm        # Node 自带；或者 npm i -g pnpm
```

然后三种方式**选一种**（`web` 是 profile 名，一般不用改）：

| 方式 | 命令 |
|---|---|
| npm 包（推荐） | `dsh plugin --profile web add dsh-model-metadata` |
| GitHub 仓库 | `dsh plugin --profile web add github:pgjh/dsh-model-metadata` |
| 本地源码 | `dsh plugin --profile web add /path/to/checkout` |

命令会把包装好，并自动挂进 DSH 的插件列表，不用你手改配置文件。装完**重启一次**（用你启动 dsh 的方式：直接跑 `dsh web` 的就重跑一遍；交给 systemd 的就 `systemctl --user restart <你的服务名>`；Docker 里就重启容器）。

之后记住这条界线：**界面上的改动刷新页面就行，逻辑上的改动要重启**。

> 还有一种不用 pnpm 的"复制文件"装法：`node install-plugin.mjs --apply`。它写在 `~/.dsh/cordis.patch.yml` 里，对**所有** profile 生效，所以**别和上面三种混用**，否则插件会被装两遍。

## 用法

### 界面：设置 → 模型 → 你的网关卡片 → 编辑 → 自定义设置 → 模型目录

每个模型行里（名称下面、"容量"上面）会多出两行：

- **推理等级**：菜单里挑一个（跟随自动匹配 / 关闭推理 / 低·中·高 / 自定义…）。选「自定义…」可以填 `low, high, max`，写法和 `settings.yaml` 里一样。
- **视觉**：跟随自动匹配 / 开启（能看图）/ 关闭（只收文字）。
- 下面那行是**结论**，告诉你查到了什么：

  ```
  自动匹配：anthropic · 200K / 输出 64K · 有推理等级 · 视觉
  ```

  写「无匹配」就是这个名字两处目录都没有，需要你自己填。
- 改动之后才会出现「**写入**」按钮：只写这一行的两个字段，其它内容原样保留。

### 容量为什么不在这个界面里改

官方那一行的「容量」折叠已经管上下文和输出上限了，再开两个框只会让你纠结哪个算数。插件只**告诉你**这两个值的真实来源（你自己声明的 → 目录里查到的 → 网关默认）；而官方输入框里的灰字永远只是网关默认值（比如 256K），认不出 `gpt-4o` 其实是 128K。要改就用同一行的「容量」。

### 目录数据什么时候更新

| 时机 | 说明 |
|---|---|
| 启动 dsh | 默认拉一次（15 分钟内刚拉过就跳过） |
| 打开 dsh 界面 | 数据超过 6 小时就后台更新 |
| 每天 | 超过 24 小时算过期 |
| 手动 | 跑 `lib/refresh-snapshot.mjs`，立刻生效、不用重启 |

数据存在 **`$DSH_HOME/models-dev-snapshot.json`**（约 571 KB，机器上只此一份，所有 profile 共用）。放这里是有意的：更新插件会替换整个插件目录，数据若跟着插件走就会被一起丢掉、下次启动还得重下一遍；放在 DSH home 里，**更新插件完全不会碰它，也不用等下载**。装好第一次启动时如果还没有数据，它会自己下载一份（约 5 MB，几秒钟）。想换位置就用 `DSH_PI_AI_CATALOG_SNAPSHOT` 指到别处。

### 开关（环境变量，按需）

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_PI_AI_CATALOG_FALLBACK` | `full` | `context` = 只补容量、不判断推理等级；`off` = 插件完全不干活 |
| `DSH_PI_AI_CATALOG_FALLBACK_INPUT` | `on` | `bundled` = 只信 DSH 自带目录；`off` = 不判断图片 |
| `DSH_PI_AI_CATALOG_REFRESH` | `24` | 每天过期小时数；`0` = 关掉所有自动更新 |
| `..._REFRESH_ON_START` / `..._REFRESH_START_FLOOR_MINUTES` / `..._REFRESH_OPEN_HOURS` | `always` / `15` / `6` | 启动时是否更新、启动更新的最小间隔、打开界面时的阈值 |
| `DSH_PI_AI_CATALOG_SNAPSHOT` / `..._SNAPSHOT_URL` | `$DSH_HOME/models-dev-snapshot.json` / models.dev | 换数据文件或数据源（插件在磁盘上只写这一个文件） |

### 更新插件

| 装法 | 命令 |
|---|---|
| npm / GitHub | `dsh plugin --profile web update dsh-model-metadata` |
| 本地复制 | `node install-plugin.mjs --update`（会告诉你只需刷新还是必须重启） |

## 哪些名字认得出

- 只看**最后一个 `/` 后面的名字**：`my-gateway/gpt-4o` 和 `other-gateway/gpt-4o` 一样好使，网关叫什么不影响。
- 名字完全一样就命中；只有大小写不同时，再试一次全小写。
- 查的顺序：模型自家厂商的目录（glm→智谱、kimi→月之暗面、deepseek、gpt→openai、claude→anthropic…）→ opencode → DSH 自带目录的其余部分 → models.dev 快照。
- **新加的网关不用注册任何东西**，加完就能认。
- 名字是自己编的（比如 `my-gateway/internal-model-v3`），两处目录都不会有 → 界面写「无匹配」，自己填即可。

## 常见问题

**会不会改我的配置？** 不会。你不点「写入」，它一个字节都不写 `settings.yaml`；点了也只写那一行的推理等级和视觉。

**会不会改 DSH 自己的文件？** 不会。它只在运行时包一层，官方文件一字未动。

**和"把元数据写进配置"的插件有什么不同？** 那种是查一次就把值复制进你的配置，写进去就固定了；这里是每次按名字现查，目录更新了值也跟着变。想固定就点「写入」。

**来源写着第三方（`models.dev:xxx`、`openrouter`）可信吗？** 一般没问题，结论行会写出来源；不对就在那一行改写，你自己的声明永远优先。

**手机上能用吗？** 能。两个选择器用的是 DSH 自己的菜单，不会弹系统那套全屏单选。

## 卸载

```sh
dsh plugin --profile web remove dsh-model-metadata     # npm / GitHub / 本地源码装法
node install-plugin.mjs --uninstall                    # 复制文件装法：只删插件行
node install-plugin.mjs --purge                        # 连目录数据一起删
```

## 注意

- 插件挂在 DSH 内部一个没有公开文档的位置（`PiAiAdapter`）。DSH 升级若改动它，插件会自动停用并打一行日志，不会让 DSH 起不来。
- 界面读数据用的 `GET /model-metadata/matrix` 不走应用的登录校验（DSH 目前没给插件路由留校验钩子）。它只传"模型名 + 目录信息"，不含你的地址和密钥。介意的话删掉 `lib/index.mjs` 里的 `registerPanel(ctx, logger)` 一行，其它功能不受影响。

## 开发

```sh
npm test                         # = verify.mjs + 下面三个回归（都不联网）
node verify.mjs                  # 主回归：官方文件未改动 + 补全生效 + 你的声明优先 + 开关 + 子测试
node tests/panel.mjs             # 界面逻辑回归
node tests/hot-snapshot.mjs      # 目录数据热更新
node tests/refresh-policy.mjs    # 更新时机（不联网）
node tests/live-refresh.mjs      # 可选，真联网跑一次自动下载
node tests/browser-check.mjs     # 可选，真浏览器验收界面（需要 dsh 正在跑）
node tests/fusion-write.mjs      # 可选，真浏览器点一次「写入」，跑完还原配置
node tests/new-route.mjs         # 可选，临时加一个网关验证"新网关能否自动匹配"，跑完还原
node test-fallback.mjs --plugin ./lib/index.mjs --settings <settings.yaml>
```

`test-fallback.mjs` 一句就够：它会自己找到已安装的适配器和目录数据。两个真浏览器工具同理，需要时用环境变量指路（不写死任何绝对路径）：

```sh
DSH_INSTALL=<dsh 包目录或含 node_modules 的 lib 目录>   # 找不到 DSH 时
CHROME=<chromium 可执行文件>                            # 找不到浏览器时（默认扫 Playwright 缓存与 PATH）
DSH_UNIT=<你的 systemd 单元名>                          # 浏览器工具要从 journal 里取应用 URL 时（或用 --url 直接给）
```

```
lib/index.mjs            宿主端：按名字查目录、补元数据、提供界面数据、更新时机
lib/client.js            浏览器端：把两个开关放进模型行（用 DSH 自己的菜单组件）
lib/panel.mjs            界面数据与写入内容的纯函数
lib/snapshot.mjs         models.dev 目录的下载与整理
lib/refresh-snapshot.mjs 手动更新目录的 CLI
cordis.patch.yml         安装时自动挂载插件的那一行
install-plugin.mjs       不用 pnpm 的本地安装 / 更新 / 卸载
packaging.mjs            包布局与本地布局的约定（安装器和测试共用）
dev-paths.mjs            开发工具找 DSH 与浏览器的唯一出处（无硬编码路径）
tests/snapshot-fixture.json  回归测试用的两条目录数据（让结果与当天数据无关）
```

## 问题与贡献

遇到问题、想让某个名字被认出来、或想改点别的，直接开 issue：<https://github.com/pgjh/dsh-model-metadata/issues>——带上 DSH 版本、插件启动那行日志（`<插件目录>/index.mjs` 被装载的那行），**别贴 `baseURL`、API key 或任何 credentials**：其中不带这些信息的是模型名和目录来源，够定位了。

## 许可

MIT（见 `LICENSE`）。
