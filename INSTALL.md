# 安装 dsh-jarvis

**当前状态：已安装、已激活、正在运行，9 个工具全部可用。**（2026-10-11 实测）
无需重启即生效；数据目录 `C:\Users\<you>\.dsh\jarvis\` 已自动创建。
`jarvis_status`、技能 `jarvis-project`、`jarvis_preflight` 都已在真实对话里跑通（见「三、验证」）。

---

## 一、现在磁盘上到底是什么（3 个环节）

### 环节 1：profile 的 `package.json`（只改了 2 行）

文件：`C:\Users\<you>\.dsh\profiles\desktop\package.json`

- `dependencies` 里加了 `"dsh-jarvis": "link:C:\\Users\\<you>\\jarvis"`
- `dsh.profile.bundles` **末尾**追加了 `"dsh-jarvis"`

> `dsh.profile.bundles` 顺序敏感：前两项必须依次是 `@deepseek-ai/dsh-base`、
> `@deepseek-ai/dsh-web-app`，新项一律追加到末尾。

profile 自己那层 `cordis.patch.yml` **一行都没动**。

### 环节 2：转发器目录

`C:\Users\<you>\.dsh\profiles\desktop\node_modules\dsh-jarvis\`：

| 文件 | 作用 |
| --- | --- |
| `package.json` | 声明 `main: index.js`、`dsh.bundle.patch: ./cordis.patch.yml`，`exports` 含 `"."` 与 `"./dsh"` |
| `index.js` | 包根入口 = 一句静态再导出 |
| `dsh.js` / `dsh2.js` / `dsh3.js` | 历史镜像（`dsh3.js` 是当年的诊断镜像），留着无害 |
| `dsh4.js` | 历史镜像（已被 `dsh5.js` 取代） |
| `dsh5.js` | **当前真正被装载的就是它** |
| `cordis.patch.yml` | 插入插件行（写法与 `dsh-context` / `modlens` 一致） |

镜像内容只有这一句有效代码：

```js
export * from 'file:///C:/Users/Tony%20Huang/jarvis/index.js?v=4';
```

末尾的 `?v=5` 见「坑 6：Node 的 ESM 缓存按 URL 生效」。

**改完 `jarvis/` 里的源码想立刻生效，必须同时换两个 URL**（只换一个不够，实测各栽过一次）：

1. 复制成**新文件名的镜像**（`dsh5.js` → `dsh6.js` → …）—— 因为**镜像文件自己也被缓存**，
   只改它的内容不生效；
2. 把镜像里真源码的 `?v=` **递增**（`?v=5` → `?v=6`）—— 否则会命中真源码的旧缓存；
3. 把 patch 的 `name` 改成新的镜像文件名。

**为什么用转发器而不是 `mklink`**：ESM 以真实文件的 URL 实例化模块，所以真身里的相对
导入 `./lib/*.js`、以及用 `import.meta.url` 定位的 `skills/` 目录，都会解析到
`C:\Users\<you>\jarvis\`。**改源码完全不用动这个目录。**

> 四条硬约束，改之前一定先看「二、装载调试记录」：
> 1. **绝不写 `export default`**（坑 1）
> 2. **绝不用顶层 await**（坑 2）
> 3. **工具定义的 `output` 必须带 `render`**（坑 4）
> 4. 镜像靠不同文件名 / `?v=N` 换 URL，绕开 Node 的 ESM 模块缓存（坑 6）

### 环节 3：patch 里的 `name` 用了绝对 file URL

`...\node_modules\dsh-jarvis\cordis.patch.yml` 现在是：

```yaml
- insert:
    - id: jarvis
      name: 'file:///C:/Users/Tony%20Huang/.dsh/profiles/desktop/node_modules/dsh-jarvis/dsh4.js'
```

（对照：`dsh-context` 那种常规写法是 `name: 'dsh-context'`，即包名。）

**为什么不用包名**：见下文坑 3 —— 包名解析会命中已被缓存的包清单，当前进程里解析不了
子路径。绝对 file URL 直接指向文件，绕开包解析。**重启之后可以改回 `name: 'dsh-jarvis'`**
（重启后包清单会重新读取，包根入口是干净的），但现在**别改**，一改就掉回 failed。

---

## 二、装载调试记录（三小时换来的，别再踩）

### 观察通道：只有这两个管用

| 想知道 | 用什么 |
| --- | --- |
| 插件到底挂上没有 | `plugin_manager` → `list_plugins` → 看该行的 **`fiberPhase`**：`active` = 活着，`failed` = 载入失败，`null` = 被禁用 |
| 载入失败的确切原因 | `plugin_manager` → `set_plugin` / `set_bundle` 关掉再打开 → 返回里的 **`error.diagnostic`** 就是 loader 的告警原文 |

⚠️ **别用 `cordis_inspect_query`（host / Config / listConfigs）的 `status` 字段判断失败**：
它返回 `absent` 只表示"这个 entry 没有可读的 Config schema"。实测 `@liustack/modlens`
（确凿可用）同样是 `absent`。该接口的 `packageDir` 字段倒是能证明 loader 解析到了包目录。

⚠️ 本机 `pwsh` **完全不可用**（见文末），所以没有 `node --check`、没有 DSH 自己的启动日志可看，
上面这两个 MCP 工具是唯一的活体诊断手段。

### 坑 1（致命）：`export default apply` —— 插件装载后 `inject` 全丢

原写法 `jarvis/index.js` 末尾有 `export default apply;`，转发器又把它 `export { default } from` 出来。
loader 报的原文是：

```
dsh: warning: 1 entry did not activate
jarvis (dsh-jarvis): Error: cannot get property "tools" without inject
    at new apply (file:///C:/Users/Tony%20Huang/jarvis/index.js:87:11)
    at Fiber.execute (...resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:1068:24)
```

根因：Cordis 在模块命名空间里若看到 `default` 导出，就**只把那个裸函数当插件本体**，
于是 `export const name` / `export const inject = ['tools']` 全部被丢掉。apply 里一碰
`ctx.tools` 就抛 `cannot get property "tools" without inject`。

**规则：Cordis 插件模块只导出 `name` / `inject` / `apply`（外加自己的常量），绝不写 `export default`。**

对照证据（两个确凿可用、无构建步骤的插件，全文搜不到 `export default`）：
`...\node_modules\dsh-secure-audit\index.js:30 export const inject = ['tools'];`、
`...\dsh-secure-audit\index.js:163 export function apply(ctx, config = {}) {`。

### 坑 2：插件模块不能有顶层 await

第二版转发器用 `const real = await import(...)` 想自己打日志。结果：

```
jarvis (dsh-jarvis/dsh): failed to import
```

而且日志文件**根本没生成**（模块体一行都没执行）→ 带 TLA 的 ESM 在 loader 走的
`require(esm)` 路径下装不上，只会给出这句笼统的 `failed to import`。
改成纯静态 `export *`（零 TLA）后即可装载。

### 坑 3：`'dsh-jarvis/dsh'` 这种子路径在当前进程里解析不了

想用子路径换一个新 URL 来绕开模块缓存（因为包根入口载入过一次带 default 的旧版本，
已成功求值的 URL 不会重新求值）。结果：

```
jarvis (dsh-jarvis/dsh): failed to import
```

即使文件真的存在、`exports` 里也写明了 `"./dsh": "./dsh.js"`（形状与已激活的
`@vectorize-io/hindsight-coding-agents` 的 `"./dsh": "./dist/dsh.js"` 完全一致）。
判断是 loader 的**包清单缓存**：包清单在进程启动时读一次，之后新增的 `exports` 子路径不生效。
（用无依赖的探针模块验证过：探针同样 `failed to import`，所以不是模块内容的问题。）

**解法：patch 的 `name` 直接写绝对 file URL**，指向镜像文件（现在是 `dsh5.js`）。
这样既绕开包解析，又拿到一个全新的模块 URL。实测：`set_bundle` 关-开 → 返回
`"application":"applied"`、零告警，`fiberPhase` 变 `active`。

### 坑 4（致命，最隐蔽）：工具定义的 `output` 必须同时给 `schema` 和 `render`

表现是「**插件明明 active、人格卡也注入了，但 9 个工具一个都不在工具目录里**」——
典型的"薛定谔的加载成功"。真凶是注册时抛的：

```
TypeError: tool "jarvis_probe_v3" must declare output { schema, render, presentationMeta? }
    at Proxy.register (...resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js:2881:188)
```

`output: { schema: TEXT_OUT({}) }` 少了 `render`。**`render` 不是可选项**：它返回模型
真正看到的内容，所以必须把整个返回值都渲染进去，不能只丢一个 `message`。

对照确凿可用的 `@liustack/modsearch\dsh\index.js:183` 的 `x_search`：
`output: { schema, render: (_args, value) => [{type:'text', text: ...}], presentationMeta }`。

**当前写法**：9 个工具的定义里仍然只写 `output: { schema }`，由 `apply()` 里的
`register()` 统一补 `render`（幂等）——这样以后新增工具不会再漏。

> 这个坑是靠**诊断镜像**抓到的（`dsh3.js`：静态 import 真源码 → 调 apply → 再问活体
> `tools.get()` / `tools.schemas()`，并用一个同形状的临时探针工具试注册）。
> 先问"工具进没进目录"、再用探针试"这个形状收不收"，两步就能把范围锁死。

### 坑 5：空 catch 会把这类致命错误吞掉

`register()` 原来是 `catch (e) { warn(...) }`，而 `warn()` **只写 `ctx.logger`**、
不写 `jarvis.log` —— 于是上面那个 `TypeError` 完全不可见，插件"看起来正常"。

**已修**：
- `warn()` 现在**同时**写 `jarvis.log`；
- 启动横幅不再写死 `tools=9`（那是硬编码数组长度，当初直接误导了排查），
  改成真实计数 `tools=9/9; commands=5/5; names=jarvis_status,...`，工具缺一个就带 `WARNING=`；
- `safe()`（工具执行期异常）本来就写盘，保持不变。

### 坑 6：Node 的 ESM 缓存按 URL 生效（**两个 URL 都要换**）

`file:///C:/Users/Tony%20Huang/jarvis/index.js` 在第一次成功装载时就被求值并缓存，
**此后改磁盘上的源码不会重新求值**（表现为：改完重新激活，日志里还是旧行为，
甚至新加的日志一行都不写）。

解决：镜像里加查询串换 URL —— `...index.js?v=5`。Node 把它当另一个模块，重新读盘。
`lib/*.js` 各自也是独立 URL、独立缓存，改它们同理（各自加版本号）。

⚠️ **还有一半**：**镜像文件（`dshN.js`）自己也是按 URL 缓存的**。所以「改 patch 从
`dsh4.js` 指向 `dsh4.js` 的新内容」这种操作完全无效——URL 没变，拿到的还是旧模块。
必须**新文件名**（`dsh5.js`）。实测证据：只改了 `dsh4.js` 的内容并递增内部 `?v=5`，
重新激活后日志里仍是旧的横幅格式（少了 `commands=` 字段）。

**归纳成一句**：让改动生效 = patch 的 `name` 指向一个**从未装载过的 URL**。

### 附带教训

- **绝不能用 `set_plugin` 关掉这一行**：关掉后该 row 会变成
  `readOnlyReason:"unaddressable"`（丢掉 patchId），只能用 `set_bundle`（bundle 级）触发重组。
- 判断文件是否真的在磁盘上，用 `read`，**不要用带 `/` 的 `glob` pattern** —— 在
  `node_modules` 下它经常错报 "No files found"。

---

## 三、验证

重启 DSH 后（或现在就）在任意对话里：

1. **工具**：让助手调用 `jarvis_status` —— 应返回一段自检摘要
2. **命令**：输入 `/jarvis` —— 应能补全（共 5 个：`/jarvis`、`/jarvis-mode`、
   `/jarvis-project`、`/jarvis-intel`、`/jarvis-weekly`）
3. **人格卡**：问它"你是谁" —— 应自称你的贴身助手/兄弟，并知道你的四战线与硬截止
4. **技能**：技能列表里应出现 `jarvis-project`、`jarvis-review`、`jarvis-intel`
5. **数据目录**：`C:\Users\<you>\.dsh\jarvis\` 应已存在（实测已有
   `profile.md`、`rules.md`、`jarvis.log`）

### 已实测通过的部分

- ✅ 插件行 `include:jarvis` 的 `fiberPhase` = **`active`**
- ✅ `jarvis.log` 的启动横幅打出了真实的注册结果：
  `jarvis v0.1 ready; mode=hybrid; tools=9/9; commands=5/5; names=jarvis_status,jarvis_mode,jarvis_profile,jarvis_memory,jarvis_project,jarvis_knowledge,jarvis_preflight,jarvis_intel,jarvis_weekly`
- ✅ **9 个工具全在**、**5 个斜杠命令全部注册成功**（原来是写死的 `tools=9`，
  现在是真实计数，并且任何注册失败都会在 `jarvis.log` 里留下 `warn:` 行）
- ✅ **`jarvis_status` 在真实对话里被调用成功**，返回模式/记忆/知识库/项目/四个硬截止倒计时
  （丘赛 141 天、暑期小课题 334 天、夏令营材料 567 天、夏令营与预推免 599 天）
- ✅ **技能 `jarvis-project` 可被加载**（`skill` 工具返回了完整的五闸门协议正文）
- ✅ **`jarvis_preflight` 可被调用**，实测返回 `verdict: "partial"`：
  arXiv(200/417ms)、GitHub(200/655ms) 可达；Hugging Face / Google Scholar / Google 超时 → 提示开梯子
- ✅ 人格卡已注入 system prompt（`systemPrompt.section` 生效），且模式切换后内容随之变化
- ✅ 数据目录 `C:\Users\<you>\.dsh\jarvis\` 已创建：`profile.md`、`rules.md`、`config.json`、`jarvis.log`

### 还没实测的部分

- ❌ `/jarvis` 等 5 个斜杠命令**在输入框里的实际补全与输出**（注册本身已被日志证明是 5/5 成功，
  但敲命令是人的动作，我无法代敲 —— **这条要你亲自试一次**）
- ❌ 需要写盘的几个工具（`jarvis_memory` 写入 / `jarvis_project` 立项 / `jarvis_weekly` 生成周报）
  —— 没随手造测试数据污染真实库
- ❌ 没跑过 `node --check`：写插件的会话里 `pwsh` 完全不可用
  （`Error: Windows ACL temp root must be outside the workspace: workspace=C:\Users\<you>;
  temp=C:\Users\TONYHU~1\AppData\Local\Temp`，根因是用户目录本身就是 workspace，而 Windows
  临时目录落在 workspace 里），因此**全程没有任何命令执行能力**；
  语法正确性是由"模块真的被装载并跑完 apply"间接证明的

### 出问题时看哪里

```
C:\Users\<you>\.dsh\jarvis\jarvis.log
```

再用 `plugin_manager` → `list_plugins` 看 `fiberPhase`，用 `set_bundle` 关-开拿到
`error.diagnostic`。插件全程有 try/catch，载入失败不会拖垮 DSH 启动，但上面 1–5 会全都看不到。

---

## 四、回滚

1. 从 `dsh.profile.bundles` 里删掉 `"dsh-jarvis"`
2. 删掉 `C:\Users\<you>\.dsh\profiles\desktop\node_modules\dsh-jarvis\` 整个目录
3. 重启 DSH

数据不会丢：`C:\Users\<you>\.dsh\jarvis\` 是独立目录，删插件不影响它。

---

## 五、之后想变成"官方安装"

在**终端**（PowerShell）里跑:

```powershell
dsh plugin --profile desktop add link:"C:\Users\<you>\jarvis"
```

这条命令会建正式链接、补 `dependencies`、reconcile `dsh.profile.bundles`（新 bundle 追加末尾）。
装完重启 DSH，然后把 patch 的 `name` 从绝对 file URL 改回 `'dsh-jarvis'`。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-jarvis
```

### 方式 A 不可用时的手动装法

**B1 建立包链接**。在 `...\profiles\desktop\node_modules\` 下创建 `dsh-jarvis`，指向源码目录。
两种做法：

- **B1-a 目录联接（不需要管理员）**
  ```powershell
  cmd /c mklink /J "C:\Users\<you>\.dsh\profiles\desktop\node_modules\dsh-jarvis" "C:\Users\<you>\jarvis"
  ```
- **B1-b 转发 shim（完全不需要 shell，最容易回滚，本次采用的就是它）**
  放 `package.json` + 一个镜像 `dshN.js`，其中镜像 **只能**是：
  ```js
  export * from 'file:///C:/Users/Tony%20Huang/jarvis/index.js?v=1';
  ```
  > 千万别再加 `export { default } from ...`（坑 1），也别用 `await import(...)`（坑 2）；
  > 改完源码要把 `?v=` 递增一次（坑 6）。

**B2 把 bundle 登记进 profile**（同环节 1）。

**B3 重启 DSH。**

---

## 六、源码位置与依赖

- 源码：`C:\Users\<you>\jarvis\`（纯 ESM，**零外部依赖**，不用 `npm install`；
  只用 `node:` 内置模块——DSH 核心包封在 `app.asar` 内，插件去 import `@deepseek-ai/*` 极易解析失败）
- 目标 profile：`C:\Users\<you>\.dsh\profiles\desktop\`
- 启动期依赖：`@deepseek-ai/cordis`（peerDependencies，标了 optional）——实际运行时由 DSH 提供
