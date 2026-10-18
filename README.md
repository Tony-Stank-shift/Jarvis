# dsh-jarvis

**用户专属的全能生活小助手**，作为 DSH（DeepSeek Harness）桌面版插件运行。

对标贾维斯/星期五，但落点是**可执行的机制**，不是"更聪明的模型"：
插件负责**记忆持久化、指令稳定注入、流程强制可执行、权限可控**，
知识广度交给**检索 + 沉淀 + 目标对齐**。

---

## 它到底做了什么

| 能力 | 实现 |
| --- | --- |
| 像最知心的兄弟 | 常驻人格卡（三种模式可切换）+ 个人档案 + 双轨记忆 |
| 有全球知识 | `jarvis_knowledge` 本地知识库 + 复用已装检索插件（modsearch / HF / GitHub / arXiv） |
| 自主学习、终身学习 | `jarvis_intel` 每日抓取 AI / AI4S / 具身智能，按兴趣向量排序并沉淀 |
| 一问一答，不单方面开工 | `jarvis_project` 五闸门状态机（代码级强制，不可跳跃） |
| 实时了解进度 | 每小项 自检 → 第三方检查 → 汇报卡（无证据不算完成） |
| 大格局、宏观视野 | 第 4 道闸门的**目标对齐器**：显式回答对四条战线的边际贡献，有权说"不值当" |
| 底线不可破 | `jarvis_preflight`（梯子）+ `lib/redline.js` 代码级审批闸门 |
| 掌管每个工作区 | 复用 DSH 的 workspace / task-board / agent-teams（v0.3 深化） |

---

## 数据目录

一切自行数据都在 `~/.dsh/jarvis/`（**唯一免审批写入区**）：

```
~/.dsh/jarvis/
├── config.json                  模式、人格浓度、压缩阈值、兴趣向量、红线开关
├── profile.md                   长期档案（用户可随时手改）
├── rules.md                     用户对 Jarvis 的硬约束（优先级最高）
├── jarvis.log
├── memory/
│   ├── facts.jsonl              事实记忆（长期有效）
│   └── episodes.jsonl           情节记忆（会过期）
├── projects/<slug>/
│   ├── state.json               五闸门机器状态
│   ├── PROJECT.md               人读全过程文档
│   └── STATE.md                 反脆弱快照（压缩上下文后靠它接上）
├── knowledge/
│   ├── <slug>.md                带解读的笔记
│   ├── index.jsonl
│   └── intel/YYYY-MM-DD.md      每日情报
└── journal/YYYY-MM-DD-weekly.md 每周复盘
```

---

## 工具（11 个）

| 工具 | 作用 |
| --- | --- |
| `jarvis_status` | 自检：模式/档案/记忆/项目/情报/硬截止倒计时/缺什么 |
| `jarvis_mode` | 切 `academic`（严肃学术）/ `bro`（兄弟闲聊）/ `hybrid`（结合，默认）+ 人格浓度 0–5 |
| `jarvis_profile` | 读写长期档案与运行规则 |
| `jarvis_memory` | 双轨记忆 + 记忆宫殿：remember / recall（三阶段）/ list / rooms / organize / review / reinforce / weaken / move / archive / cold / restore / forget / stats / **eval（检索基准）** |
| `jarvis_project` | 五闸门：open / record / wbs / progress / status / list / **review（可执行评审 + REVIEW.md）** / close |
| `jarvis_knowledge` | 本地知识库：search（带 文件:行号）/ add / list / stats |
| `jarvis_preflight` | 梯子探测：区分 DNS 失败 vs 超时/重置，直接给"要不要开梯子"的结论 |
| `jarvis_intel` | 抓 arXiv（2 路，间隔 ≥3s）+ OpenAlex + Crossref（+ HF，需梯子），按兴趣向量排序写日报；带「未覆盖」小节、源健康度、`ifMissing` 补跑 |
| `jarvis_weekly` | 周报骨架：四战线 + 四硬截止倒计时 + 待重审的旧判断 |
| `jarvis_verify` | 引用核验：`路径:行号` 是否越界、文件是否存在，并把**被引用行的原文**摘回来对照 |
| `jarvis_correction` | 纠错账本：record / list / stats / drop，按类别统计"我最爱编什么" |

## 命令（5 个）

`/jarvis` · `/jarvis-mode` · `/jarvis-project` · `/jarvis-intel` · `/jarvis-weekly`

## 技能（3 个，随插件自带，不写 `~/.dsh/skills/`）

`jarvis-project`（五闸门协议）· `jarvis-review`（第三方检查官）· `jarvis-intel`（情报与周报）

---

## 三种模式

| 模式 | 什么时候用 | 长什么样 |
| --- | --- | --- |
| `academic` | 要严谨产出：论文、证明、方案评审 | 术语精确、先结论后推导、必给出处、主动指漏洞 |
| `bro` | 闲聊、状态差、想吐槽 | 口语直接、先聊人再聊事、该劝就劝 |
| `hybrid` | 默认 | **骨架学术、温度兄弟**：数字/出处必须硬，表达与关心必须软 |

`/jarvis-mode academic 4` 切模式并把人格浓度调到 4。

---

## 红线（代码级，不是提示词）

| 类别 | 处理 |
| --- | --- |
| 外网 / 梯子 | 先跑 `jarvis_preflight`；不通就明确告诉用户"需要梯子"并停下等 |
| 下载 / 安装 | **永远**需要用户明确同意（`confirmed: true` 才放行） |
| 桌面 / 工作区文件 | 默认只读；写入前给出目标路径或 diff，等同意 |
| 模型训练 | 默认关闭；要先给资源评估 + 取得许可 |
| `~/.dsh/jarvis/` | 唯一免审批写入区 |

审批闸门不是"绕过 DSH"，而是**在其之上再加一道"必须先问用户"**。DSH 自身的
sandbox / approval 依然生效，两层叠加。

---

## 已知限制（诚实清单）

- 插件**不会让模型变聪明**，它提升的是记忆持久性、指令稳定性、流程可执行性、权限可控性。
- 常驻人格卡只有几百 token，完整档案按需检索——所以 Jarvis 不会"天生就懂你"，
  它靠 `jarvis_memory` / `jarvis_profile` 一点点攒。
- `jarvis_intel` 排序是**关键词兴趣向量**，不是语义理解；它会把好论文排前面，
  也会漏掉一些。**解读必须由模型补上**（见 `jarvis-intel` 技能第二节）。
- 本地知识库检索是**关键词重叠**，不是向量检索。v0.3 计划加本地嵌入 + 重排。
- DSH 升级可能带来 Host Service 变动。缓解：本插件只用稳定服务
  （`tools` / `systemPrompt` / `commands` / `skills`），且**不 import 任何 `@deepseek-ai/*` 包**。
- v0.1 **没有**实现：自动定时抓取（靠 `/jarvis-intel` 手动或 DSH 定时任务）、
  跨工作区治理、Web 侧边栏面板、本地训练。这些按路线图进 v0.2–v0.4。
- **幻觉无法被自动统计**。`jarvis_correction` 只能记下"被发现的错误"；没被发现的
  错误不在账本里。所以账本的数字是幻觉率的**下界**，不是估计值。
- `jarvis_verify` 只验「带行号」的引用，且相对路径需要显式传 `roots`（插件跑在
  Host 进程里，拿不到当前会话工作区）。它不判断"内容是否支持论点"。
- **记忆宫殿的三个真局限**：① 房间靠关键词判据，分类会错；② 分类错的记忆在房间
  视图里是隐形的（靠 `recall` 的全局兜底救，所以 `room` 是**硬过滤**时真的可能返回空）；
  ③ 每条 `remember` 都会全量重建 `ROOM.md`，记忆上千后需要改成增量。
- **情报的几个真局限**：① `isTopical` 是关键词判据不是语义判据，一条 AI 论文若标题
  摘要里没有任何兴趣词会被丢掉（宁可漏不可滥）；② Hugging Face 需要梯子，抓不到时
  日报会显式标「未覆盖」而不是假装没新论文；③ 源健康度只记"成没成"，不记"质量好不好"。
- **"定时"是补跑不是 cron**：DSH 桌面端不是常驻服务器，所以只能在启动/检查时补当天。

- **v0.3 的四个新局限**：① `resolveWorkspace` 的真实链路（`workingDirectory.ensure`）只在离线测试里验过降级路径，真实路径要等运行期；② 同义词表是手写 22 组，漏掉的不覆盖；③ CJK 停用字表是拍的，`地/得/着/过` 这类多义字被当停用字后单字查询会失效；④ 检索基准只有 7 题、且由当前 3 条记忆生成，100% 只说明"没崩"，不代表真实检索质量。

---

## 版本路线

- **v0.1** 人格注入 + 档案 + 双轨记忆 + 五闸门 + 红线保险丝 + 本地知识库 + 情报 + 周报 + 自带技能包
- **v0.1.1 阶段 0 · 仪表与硬约束**
  - `lib/telemetry.js` 记忆调用埋点（三个"长调用"口径：扫描 >200 条 / 返回 >20 条 / 耗时 >300ms）
  - `lib/verify.js` + `jarvis_verify` 引用核验（文件存在、行号越界、**摘出被引用行原文**、可选联网查死链）
  - `lib/claims.js` + `jarvis_correction` 纠错账本（按类别统计"我最爱编什么"）
  - 常驻人格卡新增 `【防幻觉纪律】` 段
  - 启动日志的 `tools=N/9` 改成「计划清单 vs 实际注册」差集
- **v0.1.2 · 记忆宫殿 + 强度模型**
  - `lib/palace.js`：7 个固定房间（A-课内 / B-科研 / D-AI全栈 / 升学 / 人 / 规则 / inbox）+ `项目-<名字>` 动态房间；`ROOM.md` / `INDEX.md` 是派生视图，可整份重建
  - 每条记忆带 `room` / `loci` / `strength` / `stability` / `due` / `reps` / `lapses`
  - `recall` 三阶段：选房间 → 房内按强度排序 → 串门一跳 → **全局兜底**（指定 `room` 时是硬过滤）
  - `reinforce` / `weaken`（遗忘曲线的施力点）、`review`（到期清单）、`archive` → `cold.jsonl`（**移动不是删除**，`restore` 可捞回）
  - `catchUpState()` 补跑检查（只报告，不自动抓）
- **v0.2.0（当前）· 多源情报**
  - 新增 **OpenAlex**（全学科 + 被引数）与 **Crossref**（已发表期刊会议），均无 key
  - `getJson` 指数退避：只重试 429 / 5xx / 网络错误 / 超时；**404 这类不重试**
  - 源健康度 `knowledge/intel/_sources.jsonl` + `sourceHealth()`
  - 日报新增「未覆盖」小节：抓不到的源会被点名，并声明"不保证全量"
  - `isTopical()` 噪声源相关性判据（CORE 命中或 ≥2 个正分项）
  - 修掉两个真 bug：① `freshness` 在负 `ageDays` 时无上界（脏数据曾拿下 4921.5 分，毁掉整份日报排序）；② `sourceHealth` 返回显式 `undefined` 导致工具报 `lossless JSON` 失败
- **v0.3.0（当前）· 让三处"看起来是真的"变成真**
  - `lib/context.js`：压缩实况改为**真读** profile 的 `cordis.patch.yml`（`auto` / `thresholdRatio` / `retainRatio`），`jarvis_status` 输出 `context`。**删掉**了 `contextPolicy{soft,hard}`——它从来没接任何东西
  - `lib/workspace.js`：`resolveWorkspace(ctx, exec)` 经 `workingDirectory.ensure(agent)` 取当前会话目录；记忆与项目加 `workspace` 标注。**默认不过滤**（只有显式传 `workspace` 才过滤），老记录保持 `untagged`
  - `lib/review.js`：评审判据从散文变成 **C1–C9 固定清单**（每条带 `failIf`），`jarvis_project(action="review")` 落盘 `REVIEW-<日期>-<时分秒>.md`，含逐条判定、产物 sha256 指纹、复现命令。漏判 → `incomplete`，不许当 pass
  - `lib/eval.js`：**检索基准**。题目从真实记忆生成（唯一词 → 正确答案），确定性可复现；`jarvis_memory(action="eval")` 出分数与逐题细节
  - 检索改进（零依赖）：`text.js` ① 查询含强词时单字不计分 ② CJK 停用字两条规则（`的是`/`不在` 不再成为检索词，但 `得分`/`有效` 保留）；`lib/synonyms.js` 22 组同义词（奖励封顶 0.3，永不越位）；tag 直命 +0.1；loci 邻近补充（上限 2 条）
  - **实测**：检索基准 6/7 → **8/8**，唯一失败项（stopword-noise）转绿
  - 基准上线第一天就抓出一个真 bug：房间"硬过滤"只作用在"选房间"那一步，末尾的强度兜底仍遍历全库，于是房内无命中时会**泄漏出别的房间的记录**。已修（过滤作用在候选池上），并留下 `room-empty` 题型与常驻断言 (k) 作永久守卫
  - 基准自己也修了三轮（负例混了虚词 / 期望写成"必须 0 条" / 判据用 else-if 串联会漏检），三条教训写进了 `lib/eval.js` 的文件头
- **v0.4** 第三方检查官走真 Agent Teams（烧配额）、30%/50% 压缩策略真正接管、本地嵌入检索（需下载，待批）
- **v0.5（可选）** Web 侧边栏面板（项目卡片 + 情报投递 + 模式开关）

---

## 安装

见 [INSTALL.md](./INSTALL.md)。
