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

## 工具（9 个）

| 工具 | 作用 |
| --- | --- |
| `jarvis_status` | 自检：模式/档案/记忆/项目/情报/硬截止倒计时/缺什么 |
| `jarvis_mode` | 切 `academic`（严肃学术）/ `bro`（兄弟闲聊）/ `hybrid`（结合，默认）+ 人格浓度 0–5 |
| `jarvis_profile` | 读写长期档案与运行规则 |
| `jarvis_memory` | 双轨记忆：remember / recall / list / forget / stats |
| `jarvis_project` | 五闸门：open / record / wbs / progress / status / list / close |
| `jarvis_knowledge` | 本地知识库：search（带 文件:行号）/ add / list / stats |
| `jarvis_preflight` | 梯子探测：区分 DNS 失败 vs 超时/重置，直接给"要不要开梯子"的结论 |
| `jarvis_intel` | 抓 arXiv + HF Daily Papers，按兴趣向量排序，写日报 |
| `jarvis_weekly` | 周报骨架：四战线 + 四硬截止倒计时 + 待重审的旧判断 |

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

---

## 版本路线

- **v0.1（当前）** 人格注入 + 档案 + 双轨记忆 + 五闸门 + 红线保险丝 + 本地知识库 + 情报 + 周报 + 自带技能包
- **v0.2** 定时情报（DSH 定时任务/任务看板投递）、自建搜索 provider（摆脱 Firecrawl 429）、情报→笔记自动化
- **v0.3** 第三方检查官走 Agent Teams、30%/50% 压缩策略接 `billion-context`/`dsh-context`、跨工作区治理、本地嵌入检索
- **v0.4（可选）** Web 侧边栏面板（项目卡片 + 情报投递 + 模式开关）

---

## 安装

见 [INSTALL.md](./INSTALL.md)。
