# dsh-model-metadata

[![npm](https://img.shields.io/npm/v/dsh-model-metadata?label=npm&color=cb3837)](https://www.npmjs.com/package/dsh-model-metadata)
[![license](https://img.shields.io/npm/l/dsh-model-metadata?color=3da639)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-model-metadata?color=5fa04e)](package.json)

已发布到 npm（`dsh-model-metadata`），源码在 [github.com/pgjh/dsh-model-metadata](https://github.com/pgjh/dsh-model-metadata)。

> **English** — Fills in the missing capability metadata of models you declared yourself on a
> custom gateway (context window, output cap, reasoning levels, can it see images). Every
> model is looked up **by name** at runtime; no DSH file is touched, and your settings
> document changes only when you press 写入 yourself. The fused controls follow the Settings
> page's language (Simplified Chinese, English).

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

1. **按模型名查**：取 id 里最后一个 `/` 后面的名字（`my-gateway/gpt-4o` → `gpt-4o`），按"官方路由 → 内置目录 → opencode → models.dev"的顺序查（详见下面「哪些名字认得出」），查到之后，就把这个模型该有的上下文长度、输出上限、推理等级、图片支持补上去。名字的写法差一点也没关系：`deepseek-v41-flash`、`deepseek-v4.1-flash`、"DeepSeek-V41-Flash" 算同一个名字，显示名和 `-exp` 之类的后缀也能对上。
2. **只补缺的**：你在 `settings.yaml` 里亲手写过的字段，它不动。反过来，**它读不到这份文档时也绝不猜**——文件不在它找的位置、机器上没有 YAML 解析器、或者你正编辑到一半 YAML 语法坏了，它都会**完全不补**，并在日志里说明原因（`enrichment off (…)`）：这时候"你有没有声明"是它看不见的事实，而"借用"会把你亲手钉住的 64K 覆盖成目录里的 272K。
3. **界面上给你两个开关**：推理等级、视觉。DSH 官方界面没有这两个控件，这里是唯一的图形入口；改完点「写入」固定下来，不点就一直跟着目录走。写入是**按行**的：双击只写一次，也不会把别的行还没写入的改动丢掉；只读的部署会直接说明写不了。这两个控件和结论行跟随设置页的语言（简体中文 / English）。
4. **目录数据自己更新**：启动、打开界面、以及按天（每小时检查一次是否过期）各更新一次 models.dev，所以新模型不用你手动管；数据没变时只确认一次，不重新下载。

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

> 还有一种不用 pnpm 的"复制文件"装法：`node install-plugin.mjs --apply`。这个文件也在 npm 包里（装好之后在包的目录里一样能跑），它不经过 `dsh plugin`。它写在 DSH home 的 `cordis.patch.yml` 里，对**所有** profile 生效，所以**别和上面三种混用**，否则插件会被装两遍。

## 用法

### 界面：设置 → 模型 → 你的网关卡片 → 编辑 → 自定义设置 → 模型目录

每个模型行里（名称下面、"容量"上面）会多出两行：

- **推理等级**：菜单里挑一个（跟随自动匹配 / 关闭推理 / 低·中·高 / 自定义…）。选「自定义…」可以填 `low, high, max`，写法和 `settings.yaml` 里一样。
- **视觉**：跟随自动匹配 / 开启（能看图）/ 关闭（只收文字）。
- 下面那行是**结论**，告诉你查到了什么：

  ```
  自动匹配：anthropic · 200K / 输出 64K · 有推理等级 · 视觉
  ```

  写「无匹配」就是这个名字哪里的目录都没有，需要你自己填。
- **新加的行自己会出结论**：卡片开着时点「添加模型」、输入完 id、或保存后重新打开这张卡，插件都会重新问一次目录，不用关掉设置再进来（更不用重启 dsh）。
- 改动之后才会出现「**写入**」按钮：只写这一行的两个字段，其它内容原样保留。写入是**按行**做的——双击只写一次，写完那一行仍留着写入结果，别的行还没写入的改动也不会跟着消失。
- 只读的部署（设置页自己就不让改）点「写入」会得到「这张卡片是只读的，无法写入」，而不是一个看不出原因的失败。
- 控件和结论行的文字跟随设置页的语言：设置页是简体中文就用中文，是 English 就用英文。

### 容量为什么不在这个界面里改

官方那一行的「容量」折叠已经管上下文和输出上限了，再开两个框只会让你纠结哪个算数。插件只**告诉你**这两个值的真实来源（你自己声明的 → 目录里查到的 → 网关默认）；而官方输入框里的灰字永远只是网关默认值（比如 256K），认不出 `gpt-4o` 其实是 128K。要改就用同一行的「容量」。

### 目录数据什么时候更新

| 时机 | 说明 |
|---|---|
| 启动 dsh | 默认检查一次；本地数据不到 15 分钟就跳过（`DSH_PI_AI_CATALOG_REFRESH_ON_START=stale` 改成按天判断，`off` 则不在启动时检查） |
| 打开 dsh 界面 | 数据超过 6 小时就后台更新（`DSH_PI_AI_CATALOG_REFRESH_OPEN_HOURS`，`0` = 不按这个时机更新）。这个时机是**界面数据路由**被请求时触发的，所以 `DSH_PI_AI_CATALOG_PANEL=off` 会让它一起消失（见下表） |
| 按天（进程常驻时的那条路） | 插件每小时看一次本地数据的年龄，超过 24 小时（`DSH_PI_AI_CATALOG_REFRESH`）就后台更新；`0` = 关掉所有自动更新（总开关）。这条是给"一直不重启、也不打开设置页"的部署准备的：以前没有它，这种进程会一直用最初那份数据 |
| 手动 | `node lib/refresh-snapshot.mjs`，立刻生效、不用重启（`--help` 列出 `--out` / `--url` / `--timeout-ms` / `--settings`；`--settings` 会顺带打印"你配的模型里这份数据覆盖到了哪些"） |

一次检查不一定等于一次下载：请求会带上本地数据里存的 ETag，models.dev 回一个**没有内容的 304** 就说明数据没变——这时只把本地文件的时间戳重新盖一次，不重新下载。下载**失败**也不会被反复重试：自动触发的两次尝试之间至少隔 5 分钟，所以网络不通时反复打开界面不会变成一连串下载请求（手动跑 `refresh-snapshot.mjs` 不受这条限制）。

数据存在 **`$DSH_HOME/models-dev-snapshot.json`**（当前约 0.6 MB，随 models.dev 数据量增长；机器上只此一份，所有 profile 共用）。放这里是有意的：更新插件会替换整个插件目录，数据若跟着插件走就会被一起丢掉、下次启动还得重下一遍；放在 DSH home 里，**更新插件完全不会碰它，也不用等下载**。装好第一次启动时如果还没有数据，它会自己下载一份（约 5 MB，几秒钟）。想换位置就用 `DSH_PI_AI_CATALOG_SNAPSHOT` 指到别处。

### 开关（环境变量，按需）

| 变量 | 默认 | 取值 / 作用 |
|---|---|---|
| `DSH_PI_AI_CATALOG_FALLBACK` | `full` | `full` = 容量 + 推理等级 + 图片都补；`context` = 容量和图片照补，推理那一半关掉（等价于把 `DSH_PI_AI_CATALOG_FALLBACK_LEVELS` 设成 `off`；图片要一起关就用 `DSH_PI_AI_CATALOG_FALLBACK_INPUT=off`）；`off` = 插件完全不干活 |
| `DSH_PI_AI_CATALOG_FALLBACK_LEVELS` | `on` | `on` = 任何匹配到的来源都能声明推理等级；`bundled` = 只有 DSH 自带目录（pi-ai 目录、官方 DeepSeek 路由自己的目录）能，models.dev 只补容量；`off` = 完全不碰推理等级 |
| `DSH_PI_AI_CATALOG_FALLBACK_INPUT` | `on` | `on` = 图片也走同一套匹配；`bundled` = 只信 DSH 自带目录（含官方 DeepSeek 路由自己的目录），不信 models.dev；`off` = 不判断图片 |
| `DSH_PI_AI_CATALOG_REFRESH` | `24` | 过期小时数，超过就认为数据旧了；`0` = 关掉所有自动更新 |
| `DSH_PI_AI_CATALOG_REFRESH_ON_START` | `always` | `always` = 启动就检查（受下面的下限保护）；`stale` = 只在超过 `DSH_PI_AI_CATALOG_REFRESH` 小时时才检查；`off` = 启动不检查 |
| `DSH_PI_AI_CATALOG_REFRESH_START_FLOOR_MINUTES` | `15` | 启动检查的下限：本地数据比它新就跳过，避免重启循环反复下载 |
| `DSH_PI_AI_CATALOG_REFRESH_OPEN_HOURS` | `6` | 打开界面时，数据超过这个小时数才后台更新；`0` = 不按这个时机更新 |
| `DSH_PI_AI_CATALOG_SNAPSHOT` | `$DSH_HOME/models-dev-snapshot.json` | 数据文件换位置（插件在磁盘上只写这一个文件） |
| `DSH_PI_AI_CATALOG_SNAPSHOT_URL` | models.dev 的公开地址（默认数据源） | 换数据来源（自建镜像 / 代理用） |
| `DSH_PI_AI_CATALOG_PANEL` | `on` | `off` = 根本不注册界面数据路由（补全本身不受影响，只是编辑器里不会出现那两行控件，也不会显示任何报错）。注意它同时会关掉「数据超过 6 小时、打开界面时更新」这个时机——那个时机就是这条路由被请求时触发的 |
| `DSH_PI_AI_CATALOG_PANEL_HOSTS` | 不设 = 任何 Host | 逗号分隔的 Host 白名单：只回应列出来的 Host，不在其中的一律拒绝；反代后面用 |
| `DSH_CATALOG_FALLBACK_NODE_MODULES` | 不设 | 额外的一个 `node_modules` 根目录：找不到 DSH 的包时从这里找 |
| `DSH_PI_AI_SETTINGS_FILE` | `$DSH_HOME/settings.yaml` | 读哪个设置文档（判断哪些字段是你自己声明的） |

`DSH_PI_AI_CATALOG_FALLBACK_LEVELS` 是为什么存在的：镜像站对某些模型只给一个"会推理"的裸标记、没有等级细节，把它当作"低/中/高都行"可能给端点送去它当场就拒绝的等级——和图片那个开关防的是同一类过度声明。设成 `bundled` 时，自带目录（它们本来就带等级映射）说了算，models.dev 只用来补容量。

每个开关都做校验：**不设**就是上面的默认值；**写了但不认识**会在日志里报一次，然后落回一个写明的取值——大多数开关落到**保守**的那一端：`DSH_PI_AI_CATALOG_FALLBACK_INPUT` 认不出算 `off`、`DSH_PI_AI_CATALOG_FALLBACK_LEVELS` 认不出算 `bundled`、`DSH_PI_AI_CATALOG_REFRESH_ON_START` 认不出算 `off`；两个例外是**故意**落到宽松端（那正是它们的默认值，认不出时宁可维持原行为）：`DSH_PI_AI_CATALOG_FALLBACK` 认不出算 `full`、`DSH_PI_AI_CATALOG_PANEL` 认不出算 `on`。小时数只认普通的非负十进制数：`0x10` 这种写法会被拒绝并按默认值处理，不会悄悄读成 `0`（那等于关掉自动更新）。

### 更新插件

| 装法 | 命令 |
|---|---|
| npm / GitHub | `dsh plugin --profile web update dsh-model-metadata` |
| 本地复制 | `node install-plugin.mjs --update`（等同 `--apply`：重新拷一份文件、把插件行补上；跑完会告诉你只需刷新页面还是必须重启 dsh） |

两种更新都只替换**插件目录**：目录数据（`$DSH_HOME/models-dev-snapshot.json`）在 DSH home 里，更新插件不会碰它，也不用重新下载。想连数据一起删掉是另一条命令（见「卸载」里的 `--purge`）。

## 哪些名字认得出

- 只看**最后一个 `/` 后面的名字**：`my-gateway/gpt-4o` 和 `other-gateway/gpt-4o` 一样好使，网关叫什么不影响。
- 名字怎么算一样，按顺序试：
  1. 完全一样，或只有大小写不同；
  2. 忽略 `.`、`-`、`_` 和空格再比一次——`deepseek-v41-flash`、`deepseek-v4.1-flash`、"DeepSeek V41 Flash" 都读作同一个名字（网关别名差的基本就是这点写法）；
  3. **显示名也算数**——官方 DeepSeek 路由把 V41 flash 叫 `deepseek-flash`、显示成 "DeepSeek-V41-Flash"，按显示名就能对上；
  4. 目录里的名字多带一个 `-exp`、`-experimental`、`-latest`、`-preview`、`-free` 后缀也算——`DeepSeek-V4-Flash-Vision` 对上 `deepseek-v4-flash-vision-exp`。这个宽松只朝**一个方向**：目录里的名字可以多一个装饰后缀，你自己写的名字多带则不算同一个（`gpt-4o-free` 不是 `gpt-4o`——同名的 `-free` 端点经常是另一套部署、另一个窗口）。
- 查的顺序（先查到的赢）：模型自家厂商的**官方**路由（glm→智谱、kimi→月之暗面、deepseek→**官方 `deepseek-official` 路由自己的目录**、gpt→openai、claude→anthropic…）→ DSH 内置目录（pi-ai）的其余部分 → opencode 聚合器 → models.dev 快照。官方目录在 `@deepseek-ai/dsh-llm-deepseek` 里，不翻 pi-ai 目录就查不到它——所以这一路是单独去问的（你在 `llm-deepseek` 设置段里改过的目录也会被用上）；聚合器是转抄别人目录的，所以永远排在正经目录后面，只用来补缺。
- models.dev 那一层里，同一个名字往往有好几家 provider 都发布，数字并不一致，所以里面的顺序是：**这个模型自家厂商发布的行** → **id 正好等于裸名的行** → 别人转抄或起别名的行 → 看起来不像聊天模型的行（图片、embedding、语音这类端点只是排在最后，不会让本来能匹配的名字变成「无匹配」）。
- **新加的网关不用注册任何东西**，加完就能认；官方路由新出的型号在 models.dev 跟上之前，也能靠官方目录先对上。
- 名字是自己编的（比如 `my-gateway/internal-model-v3`），哪里都没有 → 界面写「无匹配」，自己填即可。若目录里有同家族的其它型号（比如你写了 `doubao-seedream-5-lite`，目录里有一堆 `doubao-seed-*`），「无匹配」那行会把它们列出来供参考——但**不会自动拿来当元数据**，写法对不上就是没把握，宁缺毋滥。

## 常见问题

**会不会改我的配置？** 不会。你不点「写入」，它一个字节都不写 `settings.yaml`；点了也只写那一行的推理等级和视觉：写之前会重读一次当前配置，别的行的内容、以及别的行你还没写入的改动都不会被顺手带走。

**界面文字是中文还是英文？** 跟随设置页：设置页切到 English，这两个控件和结论行就是英文，其它语言回落到简体中文。

**会不会改 DSH 自己的文件？** 不会。它只在运行时包一层，官方文件一字未动。

**和"把元数据写进配置"的插件有什么不同？** 那种是查一次就把值复制进你的配置，写进去就固定了；这里是每次按名字现查，目录更新了值也跟着变。想固定就点「写入」。

**来源写着第三方（`models.dev:xxx`、`openrouter`）可信吗？** 一般没问题，结论行会写出来源；不对就在那一行改写，你自己的声明永远优先。

**手机上能用吗？** 能。两个选择器用的是 DSH 自己的菜单，不会弹系统那套全屏单选。

## 卸载

```sh
dsh plugin --profile web remove dsh-model-metadata     # npm / GitHub / 本地源码装法
node install-plugin.mjs --uninstall                    # 复制文件装法：只删插件行，拷进去的文件留着
node install-plugin.mjs --purge                        # 卸载，并把拷进去的文件和目录数据一起删掉
```

用 `--vision` 写过的 systemd drop-in，`--uninstall` 和 `--purge` 会一起删掉。

复制安装器还有几个选项（`node install-plugin.mjs --help` 是完整列表）：`--check` 只报告当前状态并跑一次挂载自检（**不写任何文件**，`--vision` 也一样），`--apply` / `--update` 都是"重新拷一份并补上插件行"，`--profile <名>` 只改某个 profile 的补丁文件，`--home <目录>` / `--install <目录>` 指定 DSH home 与 DSH 安装位置，`--unit <名>` + `--unit-dir <目录>` 指出 systemd 的 drop-in 目录，`--vision on|bundled|off` 就是给这个单元写 `DSH_PI_AI_CATALOG_FALLBACK_INPUT` 的 override（`on` 是删掉 override、回到插件默认）。另外 `--purge` 删的是**插件真正读的那个**快照文件：你设过 `DSH_PI_AI_CATALOG_SNAPSHOT` 就删那个路径，而不是默认名字那个。

## 注意

- 插件挂在 DSH 内部一个没有公开文档的位置（`PiAiAdapter`）。DSH 升级若改动它，插件会自动停用并打一行日志，不会让 DSH 起不来。
- 界面读数据用的 `GET /model-metadata/matrix` 不走应用的登录校验（DSH 目前没给插件路由留校验钩子）。它只回答模型名和目录结论，不含地址、也不含任何密钥——但另一面要说清楚：**端口对别人可达的部署，别人也能读到"你配置了哪些模型"**。
- 不想要这条路由就用开关关掉：`DSH_PI_AI_CATALOG_PANEL=off`。补全本身完全不受影响，编辑器里只是**不会出现那两行控件**（也不会显示任何报错——客户端分不清"开关关了"还是"路由没注册过"，所以它什么都不说）。只想在特定的名字上回应（比如在反代后面）就用 `DSH_PI_AI_CATALOG_PANEL_HOSTS` 给出允许的 Host 列表，不在列表里的 Host 一律拒绝；来自别的站点的浏览器跨站请求也一律拒绝。真要连注册这段代码都去掉，最后的手段才是删掉 `lib/index.mjs` 里的 `registerPanel(ctx, logger)` 一行——那是改源码、插件更新后会回来，能不改就不改；而且它不只去掉那条路由，还会一起失去"打开界面时更新数据"这个时机（`registerPanel` 是那个时机的唯一入口，另一个入口是每小时检查一次的按天规则，不受影响）。

## 开发

这一节的东西要**源码检出**；除 `npm run test:unit` 之外，都还要一份**真的 DSH 安装**——它们要驱动真实的 `PiAiAdapter`，缺了这份安装会直接失败（`verify.mjs` 和 `test-fallback.mjs` 会明确提示用 `DSH_INSTALL` 指路），不会假装跑过。

```sh
npm test                 # = node verify.mjs：主回归。verify.mjs 自己会拉起下面带 ✔ 的套件
npm run verify           # 同上，名字更直白
npm run test:unit        # 不需要 DSH 安装：unit + install-plugin + refresh-policy 三个套件
```

`node verify.mjs` 里包含：官方文件没被改动、补全真的生效、你自己声明的字段优先、mode/input 开关生效、打包不变量（该发布的文件都发了、客户端注册名和包名一致、安装器标记不带包名），以及「`lib/` 读的每个环境变量都写进了 README」这类防漂移断言，再加上这几个套件（✔）：

| 套件 | 需要什么 | 测什么 |
|---|---|---|
| ✔ `tests/unit.mjs` | 无（不联网、不装 DSH） | 三个纯模块：名字规则、快照整理、面板数据与写入 |
| ✔ `tests/install-plugin.mjs` | 无（在临时目录里合成 DSH 布局） | 复制安装器：写行、卸载、`--purge`、退出码 |
| ✔ `tests/refresh-policy.mjs` | 无（`fetch` 打桩，不联网） | 更新时机：启动、打开界面、按天、各个开关、去重 |
| ✔ `tests/panel.mjs` | DSH 的包，**不需要**起服务器 | 面板数据；浏览器半边能否按 DSH 的模块形状加载、和宿主半边是否一致 |
| ✔ `tests/hot-snapshot.mjs` | 同上 | 目录数据换了以后，同一个进程里下次解析就用新数据 |
| ✔ `tests/hot-add-model.mjs` | 同上 | 运行中新增的模型也会被补全 |
| `tests/browser-check.mjs` | 跑着的 dsh + Chromium | 真浏览器里验收界面 |
| `tests/fusion-write.mjs` | 跑着的 dsh + Chromium | 真点一次「写入」，跑完把 settings.yaml 还原 |
| `tests/new-route.mjs` | 跑着的 dsh + Chromium | 临时加一个网关，验证"新网关自动匹配"，跑完还原 |
| `tests/live-refresh.mjs` | 联网（约 5 MB） | 真去 models.dev 拉一次，验证自动更新 |
| `tests/harness.mjs` | — | 不是套件：上面各套件共用的脚手架（断言、临时目录、Cordis 上下文替身） |

每个套件跑完都会打印一行 `N/M assertions passed`；`verify.mjs` 连这一行也检查，套件"一个断言都没做就退出 0"会被判失败。

单跑诊断工具：

```sh
node test-fallback.mjs --source <…/@deepseek-ai/dsh-llm-pi-ai/lib/index.js> \
                       --plugin ./lib/index.mjs --settings <settings.yaml>
```

`--source` 不写会去自动找已安装的适配器（找不到就让它报错，用下面的 `DSH_INSTALL` 指路）；`--plugin` 加上就会带上本插件，用来对比"有插件 / 没插件"同一个模型的两行结果。不写 `--settings` 时它会自带一份空文档（既不读、也不会被机器上的 `settings.yaml` 影响）；`--plugin-settings <settings.yaml>` 让适配器和插件读**不同**的文档，用来复现"声明存在、插件读不到"这一类情况（这时代码会拒绝补任何字段，见「插件做的事」第 2 条）。真浏览器工具同理，需要时用环境变量指路（不写死任何绝对路径）：

```sh
DSH_INSTALL=<dsh 包目录或含 node_modules 的 lib 目录>   # 找不到 DSH 时
CHROME=<chromium 可执行文件>                            # 找不到浏览器时（默认扫 Playwright 缓存与 PATH）
PLAYWRIGHT_CHROME=<chromium 可执行文件>                 # 同上，兼容 Playwright 自己的变量名
DSH_UNIT=<你的 systemd 单元名>                          # 浏览器工具要从 journal 里取应用 URL 时（或用 --url 直接给）
LIVE_REFRESH_DEADLINE_MS=<毫秒>                         # tests/live-refresh.mjs 等真下载完成的上限（默认 300000）
```

```
lib/index.mjs            宿主端：按名字查目录、补元数据、提供界面数据、更新时机
lib/names.mjs            模型名怎么读（裸名、宽松比较、后缀）的唯一实现
lib/client.js            浏览器端：把两个开关放进模型行（用 DSH 自己的菜单组件）
lib/panel.mjs            界面数据与写入内容的纯函数
lib/snapshot.mjs         models.dev 目录的下载与整理
lib/refresh-snapshot.mjs 手动更新目录的 CLI
cordis.patch.yml         安装时自动挂载插件的那一行
install-plugin.mjs       不用 pnpm 的本地安装 / 更新 / 卸载
packaging.mjs            包布局与本地布局的约定（安装器和测试共用）
dev-paths.mjs            开发工具找 DSH 与浏览器的唯一出处（不含机器相关的绝对路径；浏览器那部分要真的 DSH 安装和 Chromium）
tests/harness.mjs        各套件共用的脚手架
tests/unit.mjs           三个纯模块的套件
tests/install-plugin.mjs 复制安装器的套件
tests/cdp.mjs            三个浏览器工具共用的 CDP 驱动
tests/snapshot-fixture.json  回归测试用的两条目录数据（让结果与当天数据无关）
CHANGELOG.md             每个版本改了什么
```

npm 包里发的是 `lib/index.mjs`、`lib/names.mjs`、`lib/panel.mjs`、`lib/snapshot.mjs`、`lib/refresh-snapshot.mjs`、`lib/client.js`、`cordis.patch.yml`、`install-plugin.mjs`、`packaging.mjs`、`dev-paths.mjs`、`README.md`、`CHANGELOG.md`、`LICENSE` 和 `package.json`——所以"复制文件"装法在 npm 装好的副本里也能用。`verify.mjs`、`test-fallback.mjs` 和 `tests/` 是开发工具，**不在**包里，只有源码检出里有。

## 问题与贡献

遇到问题、想让某个名字被认出来、或想改点别的，直接开 issue：<https://github.com/pgjh/dsh-model-metadata/issues>——带上 DSH 版本和插件启动那行日志，形如：

```
dsh-model-metadata: installed (mode full+levels:on+input:on, refresh 24h + on start always (floor 15m) + on open 6h + daily check 1h, panel on, adapter <…>/dsh-llm-pi-ai/lib/index.js, catalog <…>/pi-ai/dist/providers/all.js, model names indexed 2604, official deepseek catalog 4 models, snapshot entries 3698)
```

（这行里有用的就是括号里那几段开关状态和三个数字；它不含地址也不含密钥。）另外**别贴 `baseURL`、API key 或任何 credentials**：真正需要的是模型名和目录来源，够定位了。

## 许可

MIT（见 `LICENSE`）。
