/**
 * dsh-jarvis — Host 插件入口（v0.1）。
 *
 * Cordis 插件契约（与已装插件 dsh-context / dsh-cost-meter / dsh-btw / dsh-secure-audit
 * 完全一致）：模块导出 `name`、`inject`、`apply(ctx, config)`。
 *
 * 本插件刻意**不 import 任何 @deepseek-ai/* 包**：只用 node: 内置模块 + ctx 上的服务。
 * 理由是 DSH 核心包都封在 app.asar 里，本地 link 安装的插件去解析它们很容易失败；
 * 而工具注册用的是 `ctx.tools.register(rawDefinition)` 这个 modsearch 也在用的裸形式，
 * 不依赖 `defineTool` 辅助函数。
 *
 * 一切都在 try/catch 里：任何一个工具注册失败都不该让 DSH 起不来。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDir, loadConfig, localDate, logLine, paths, readText, saveConfig, writeText, listFiles } from './lib/store.js';
import { buildPersonaCard, ensureProfile, ensureRules, MODE_LABELS, normalizeMode, MODES } from './lib/persona.js';
import { gate } from './lib/redline.js';
import * as memory from './lib/memory.js';
import * as knowledge from './lib/knowledge.js';
import * as project from './lib/project.js';
import * as intel from './lib/intel.js';
import * as telemetry from './lib/telemetry.js';
import * as claims from './lib/claims.js';
import * as palace from './lib/palace.js';
import { verify as verifyCitations } from './lib/verify.js';
import { contextReality } from './lib/context.js';
import { resolveWorkspace, normalizeWorkspace } from './lib/workspace.js';
import * as review from './lib/review.js';
import { buildCases, runEval, renderReport } from './lib/eval.js';
import { probe as preflightProbe } from './lib/preflight.js';

export const name = 'jarvis';
/**
 * 只把 `tools` 列为硬依赖：没有它这个插件什么都做不了。
 * `systemPrompt` / `commands` / `skills` 全部走 ctx.get 软获取 —— 这样即使某个
 * 服务在本版本 DSH 里改名或不存在，插件也能挂上，只是少一部分能力，而不是整个不加载。
 */
export const inject = ['tools'];

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(HERE, 'skills');

const RUNTIME_SKILLS = [
  { name: 'jarvis-project', description: '五闸门项目协议：题意还原→知识盘点→差距补课→方案与创新度→执行（含小项自检、第三方检查、汇报卡）' },
  { name: 'jarvis-review', description: '第三方检查官：以独立、对抗性的立场复核 Jarvis 自己的产出，默认找茬，必须给出可复现的判据' },
  { name: 'jarvis-intel', description: '每日情报与周报：AI/AI4S/具身智能 的抓取、排序、沉淀，以及挂钩四条战线的周复盘' },
];

/**
 * 计划注册的工具名清单。
 *
 * 存在理由是一条实战教训：之前启动日志里硬编码 `tools=N/9`，结果改名/新增工具后
 * 数字对不上，反而误导排查（第 9 行代码旁边就写着"绝不再写死数字"，然后违反了）。
 * 现在改成"计划清单 vs 实际注册"做差集，少一个就点名。
 */
const PLANNED_TOOLS = [
  'jarvis_status',
  'jarvis_mode',
  'jarvis_profile',
  'jarvis_memory',
  'jarvis_project',
  'jarvis_knowledge',
  'jarvis_preflight',
  'jarvis_intel',
  'jarvis_weekly',
  'jarvis_verify',
  'jarvis_correction',
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const TEXT_OUT = (props = {}) => ({
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: '是否成功' },
    message: { type: 'string', description: '给模型/用户看的摘要' },
    ...props,
  },
});

const txt = (text) => [{ type: 'text', text: String(text ?? '') }];

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * 工具结果的渲染器。
 *
 * 教训（2026-10-11 实战）：DSH 的 tools 服务**强制**要求 output 同时给出
 * `schema` 与 `render`。只给 schema 会在注册时抛
 *   TypeError: tool "xxx" must declare output { schema, render, presentationMeta? }
 * —— 注册发生在 apply() 里，异常被 register() 的 catch 吞掉，于是 9 个工具
 * 一个都进不了工具目录，而插件看起来"加载成功"。render 返回的才是模型真正
 * 看到的内容，所以必须把整个返回值都带上，不能只丢一个 message 出去。
 */
function renderResult(_args, value) {
  if (value === null || value === undefined) return txt('');
  if (typeof value === 'string') return txt(value);
  if (typeof value !== 'object') return txt(String(value));
  const { message, ...rest } = value;
  let body = '';
  try {
    body = JSON.stringify(rest, null, 2);
  } catch {
    body = String(rest);
  }
  const head = message ? `${message}\n\n` : '';
  return txt(head + (body && body !== '{}' ? body : ''));
}

// 注意：下面 9 个工具的 output 只写 { schema }，render 由 apply() 里的 register()
// 统一补齐（原因见 renderResult 上方的教训说明）。这样以后新增工具不会再漏掉 render。

function cfgOrThrow() {
  ensureDir(paths.home);
  return loadConfig();
}

/** 把审批闸门的结果折进工具返回值：模型据此停下来问用户。 */
function approvalPayload(g) {
  return {
    ok: false,
    needsApproval: true,
    reason: g.reason,
    ask: g.ask,
    code: 'JARVIS_NEEDS_APPROVAL',
    message: `${g.ask}\n\n（拿到同意后，用同样的参数加 \`confirmed: true\` 重试。）`,
  };
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  if (!ctx?.tools?.register) {
    // 没有 tools 服务就没有任何可做的事；静默退出而不是抛错，避免拖垮 loader。
    try {
      ctx?.logger?.warn?.('[jarvis] tools 服务不可用，插件未挂载。');
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    ensureDir(paths.home);
    const boot = { profile: ensureProfile(), rules: ensureRules() };
    logLine(`jarvis v0.3.0 apply(); home=${paths.home}; profileCreated=${boot.profile.created}`);
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[jarvis] 初始化数据目录失败：${e?.message ?? e}`);
    } catch {
      /* ignore */
    }
  }

  // 补跑检查（2.2）：每次启动看一眼今天的情报抓没抓。
  // 只报告、不自动抓——抓外网要过红线闸门，不能在这里偷偷跑。
  try {
    const cu = intel.catchUpState();
    if (cu.due) {
      logLine(`[catchup] 今日 ${cu.today} 情报缺失；lastDate=${cu.lastDate ?? '从未'}；gapDays=${cu.gapDays ?? 'n/a'}`);
    }
  } catch {
    /* ignore */
  }

  // warn/info 一律**同时**写 jarvis.log。教训：只写 ctx.logger 时，注册失败之类
  // 的关键异常在外部完全看不见（2026-10-11 就是因此把"9 个工具全没注册"漏掉了）。
  const warn = (msg) => {
    logLine(`warn: ${msg}`);
    try {
      ctx.logger?.warn?.(`[jarvis] ${msg}`);
    } catch {
      /* ignore */
    }
  };
  const info = (msg) => {
    try {
      ctx.logger?.info?.(`[jarvis] ${msg}`);
    } catch {
      /* ignore */
    }
  };

  /** 每个工具都用它包一层，保证异常变成可读的返回值而不是崩掉一轮对话。 */
  const safe = (fn) => async (args, exec) => {
    try {
      return await fn(args ?? {}, exec);
    } catch (e) {
      logLine(`tool error: ${e?.stack ?? e?.message ?? e}`);
      return { ok: false, code: 'JARVIS_TOOL_ERROR', message: `Jarvis 工具执行出错：${e?.message ?? String(e)}` };
    }
  };

  /** 真正注册成功的工具名/命令名。用于启动日志——绝不再写死数字（曾写过 tools=9 误导排查）。 */
  const registeredNames = [];
  const registeredCommands = [];

  const register = (def) => {
    try {
      // DSH 的 tools 服务强制要求 output = { schema, render, presentationMeta? }。
      // 只给 schema 会在注册时抛 TypeError，这里统一补 render（幂等）。
      const normalized =
        def?.output && typeof def.output === 'object' && typeof def.output.render !== 'function'
          ? { ...def, output: { ...def.output, render: renderResult } }
          : def;
      ctx.tools.register(normalized);
      registeredNames.push(normalized?.name);
      return true;
    } catch (e) {
      warn(`注册工具 ${def?.name} 失败：${e?.stack ?? e?.message ?? e}`);
      return false;
    }
  };

  // -------------------------------------------------------------------------
  // 1. jarvis_status
  // -------------------------------------------------------------------------
  register({
    name: 'jarvis_status',
    description:
      'Jarvis 自检：当前模式、档案/规则是否存在、记忆条数、项目清单、本地知识库规模、最近情报日期，以及四个硬截止的剩余天数。对话里想确认"我现在是什么状态、还差什么"时调用它。只读。',
    parameters: schema({}),
    output: { schema: TEXT_OUT({}) },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    execute: safe(async () => {
      const cfg = cfgOrThrow();
      const ms = memory.stats();
      const ks = knowledge.stats();
      const projects = project.list().filter((p) => !p.closed);
      const today = localDate();
      const intelToday = Boolean(ks.lastIntelDate && ks.lastIntelDate === today);
      const gaps = [];
      if (!intelToday) gaps.push('今天还没有情报日报 → 跑 jarvis_intel');
      if (projects.length === 0) gaps.push('没有进行中的项目 → 用户给任务时用 jarvis_project(action="open") 立项');
      if (ms.facts === 0) gaps.push('事实记忆为空 → 对话中了解到的稳定事实用 jarvis_memory 记住');
      const tele = telemetry.summarize({ days: 14 });
      const corr = claims.stats();
      const catchUp = intel.catchUpState();
      const ctxInfo = contextReality();
      return {
        ok: true,
        mode: cfg.mode,
        modeLabel: MODE_LABELS[cfg.mode] ?? cfg.mode,
        personaIntensity: cfg.personaIntensity,
        home: paths.home,
        files: { profile: paths.profile, rules: paths.rules, config: paths.config, log: paths.log },
        profileChars: readText(paths.profile, '').length,
        memory: ms,
        knowledge: ks,
        projects,
        deadlines: intel.countdown(),
        telemetry: tele,
        corrections: corr,
        catchUp,
        context: ctxInfo,
        gaps,
        message:
          `模式：${MODE_LABELS[cfg.mode] ?? cfg.mode}｜记忆 ${ms.facts} 事实 / ${ms.episodes} 情节｜` +
          `知识库 ${ks.notes} 笔记 + ${ks.intelDays} 天情报｜进行中项目 ${projects.length}｜` +
          `最近情报 ${ks.lastIntelDate ?? '无'}\n` +
          `埋点：${tele.verdict}\n` +
          `纠错账本：${corr.note}\n` +
          `压缩实况：${ctxInfo.note}`,
      };
    }),
  });

  // -------------------------------------------------------------------------
  // 2. jarvis_mode —— 三种人格模式切换
  // -------------------------------------------------------------------------
  register({
    name: 'jarvis_mode',
    description:
      '切换 Jarvis 的人格模式：academic（严肃学术模式）/ bro（兄弟闲聊模式）/ hybrid（结合模式，默认）。hybrid = 学术的骨架 + 兄弟的温度。可同时调整人格浓度 personaIntensity(0–5)。无参数时返回当前模式说明。',
    parameters: schema({
      mode: { type: 'string', enum: [...MODES, '学术', '兄弟', '闲聊', '结合', '严肃学术', '兄弟闲聊'], description: '目标模式；留空则只读当前状态' },
      personaIntensity: { type: 'number', description: '人格浓度 0–5；0 = 只交付信息，5 = 最像贾维斯' },
    }),
    output: { schema: TEXT_OUT({ mode: { type: 'string' } }) },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    execute: safe(async (args) => {
      const cfg = cfgOrThrow();
      const next = typeof args.mode === 'string' && args.mode.trim() !== '' ? normalizeMode(args.mode) : null;
      if (typeof args.mode === 'string' && args.mode.trim() !== '' && !next) {
        return { ok: false, mode: cfg.mode, message: `无法识别模式 "${args.mode}"。可用：academic / bro / hybrid（也可写"学术 / 兄弟 / 结合"）。` };
      }
      if (next) cfg.mode = next;
      if (Number.isFinite(Number(args.personaIntensity))) {
        cfg.personaIntensity = Math.max(0, Math.min(5, Math.round(Number(args.personaIntensity))));
      }
      saveConfig(cfg);
      return {
        ok: true,
        mode: cfg.mode,
        modeLabel: MODE_LABELS[cfg.mode],
        personaIntensity: cfg.personaIntensity,
        message: `已切到【${MODE_LABELS[cfg.mode]}】，人格浓度 ${cfg.personaIntensity}/5。下一轮对话即刻生效（常驻人格卡每个模型步重新组装）。`,
      };
    }),
  });

  // -------------------------------------------------------------------------
  // 3. jarvis_profile
  // -------------------------------------------------------------------------
  register({
    name: 'jarvis_profile',
    description:
      '读/写 Jarvis 长期档案（~/.dsh/jarvis/profile.md）与运行规则（rules.md）。用户会随时修改这些文件，所以**先读再断言**，不要凭记忆复述用户背景。action=read 读全文；action=update 追加一段（会自动带日期）；action=read_rules / update_rules 对应规则文件。写入只发生在 ~/.dsh/jarvis/ 内，无需审批。',
    parameters: schema(
      {
        action: { type: 'string', enum: ['read', 'update', 'read_rules', 'update_rules'], description: '要做什么' },
        content: { type: 'string', description: 'action=update/update_rules 时要写入的 Markdown 片段' },
        note: { type: 'string', description: '这次修改的原因（会一起写入修订记录）' },
      },
      ['action'],
    ),
    output: { schema: TEXT_OUT({ content: { type: 'string' } }) },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    execute: safe(async (args) => {
      ensureProfile();
      ensureRules();
      const action = String(args.action ?? 'read');
      const file = action.endsWith('rules') ? paths.rules : paths.profile;
      if (action === 'read' || action === 'read_rules') {
        const content = readText(file, '(空)');
        return { ok: true, file, chars: content.length, content, message: `已读出 ${file}（${content.length} 字）。` };
      }
      const body = String(args.content ?? '').trim();
      if (body === '') return { ok: false, file, message: 'action=update 需要 content。' };
      const stamp = `\n\n<!-- ${new Date().toISOString()}${args.note ? ` · ${args.note}` : ''} -->\n${body}\n`;
      writeText(file, `${readText(file, '')}${stamp}`);
      const content = readText(file, '');
      return { ok: true, file, chars: content.length, content, message: `已追加到 ${file}（现在 ${content.length} 字）。` };
    }),
  });

  // -------------------------------------------------------------------------
  // 4. jarvis_memory —— 双轨记忆
  // -------------------------------------------------------------------------
  register({
    name: 'jarvis_memory',
    description:
      '双轨长期记忆 + 记忆宫殿。kind=fact 存稳定事实；kind=episode 存情节。每条记忆归入一个**房间**并按 loci 顺序占一个**位置**，并带强度模型（strength/stability/due）。action：remember 写入（可指定 room）；recall 三阶段检索（选房间 → 房间内 → 串门一跳 → 全局兜底）；list 列出；rooms 看房间清单；organize 迁移旧记录+重建 ROOM.md/INDEX.md+顺带冷归档（支持 room+doorplate 写门牌）；review 看到期该确认的记忆；reinforce/weaken 加固或削弱（**这就是遗忘曲线的施力点**）；move 迁房；archive 冷归档；cold 看冷档；restore 从冷档捞回；forget 彻底删除；stats 统计。冷归档是移动不是删除。写入只发生在 ~/.dsh/jarvis/ 内，无需审批。',
    parameters: schema(
      {
        action: {
          type: 'string',
          enum: ['remember', 'recall', 'list', 'rooms', 'organize', 'review', 'reinforce', 'weaken', 'move', 'archive', 'cold', 'restore', 'forget', 'stats', 'eval'],
          description: '要做什么',
        },
        kind: { type: 'string', enum: ['fact', 'episode', 'all'], description: '记忆轨道；默认 fact（remember 时）/' + 'all（检索时）' },
        text: { type: 'string', description: 'remember 时的记忆正文' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，便于分类检索' },
        room: {
          type: 'string',
          description:
            '房间。recall 时＝**硬过滤**（只在这个房间里搜，不走门、不做全局兜底——所以可能返回空）；remember/move/organize(doorplate) 时＝目标房间。可用 A-课内 / B-科研 / D-AI全栈 / 升学 / 人 / 规则 / inbox，或 `项目-<项目名>`（简写「课内」「科研」「AI全栈」也认）。不给就自动归房。给了但不认识会报错并列可选项——不猜。',
        },
        loci: { type: 'number', description: 'remember 时房间内的位置序号；不给就排在队尾' },
        workspace: {
          type: 'string',
          description:
            '工作区路径。remember 时不给则自动取当前会话目录（失败则为未标注）；recall/list 时**只有给了才会过滤**——默认不过滤，因为在 A 目录问 B 目录的事不该变哑巴。',
        },
        ids: { type: 'array', items: { type: 'string' }, description: 'move / reinforce / weaken / restore 时的记录 id 列表' },
        assignments: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'organize 时：`{ "记录id": "房间名" }`。没给的旧记录进 inbox（不猜）。',
        },
        doorplate: { type: 'string', description: 'organize 时（需同时给 room）：房门的一句话描述，写进 room.json 并渲染到 ROOM.md', },
        dryRun: { type: 'boolean', description: 'organize/archive 时：只报告会归档哪些，不实际移动' },
        query: { type: 'string', description: 'recall/forget 的检索词' },
        id: { type: 'string', description: 'forget 时按 id 精确删除' },
        source: { type: 'string', description: '来源标记（默认 conversation）' },
        confidence: { type: 'number', description: 'remember 时的置信度 0–1（默认 0.8）' },
        limit: { type: 'number', description: '返回条数上限' },
      },
      ['action'],
    ),
    output: { schema: TEXT_OUT({}) },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    execute: safe(async (args, exec) => {
      const t0 = Date.now();
      const action = String(args.action ?? 'recall');
      // 当前工作区。resolveWorkspace 永不抛错，最差返回 source:'unknown'。
      // 它只用于**标注**；过滤必须显式给 workspace 参数才生效（v0.3 · 3.2b）。
      const ws = await resolveWorkspace(ctx, exec);
      const wsExplicit = normalizeWorkspace(args.workspace);
      const kind = ['fact', 'episode', 'all'].includes(args.kind) ? args.kind : action === 'remember' ? 'fact' : 'all';
      if (action === 'rooms') {
        const r = palace.listRooms();
        const empty = r.rooms.filter((x) => x.facts + x.episodes === 0).map((x) => x.slug);
        return {
          ok: true,
          ...r,
          emptyRooms: empty,
          indexFile: join(paths.palaceDir, 'INDEX.md'),
          message:
            `共 ${r.rooms.length} 个房间。` +
            (r.legacyCount > 0 ? `**有 ${r.legacyCount} 条旧记录还没归房**，跑 action="organize" 迁移。` : '') +
            (empty.length ? `\n空房间（0 条）：${empty.join(' / ')}——空着不建目录，只在 INDEX.md 里记 0 条。` : ''),
        };
      }
      if (action === 'organize') {
        // 顺序很重要：门牌必须**先**写，再重建视图。
        // 第一版顺序反了，结果 room.json 写对了、ROOM.md 里却还是「未填写」——
        // 视图是派生的，它只能反映"写之前"的磁盘状态。
        if (args.room && typeof args.doorplate === 'string') {
          palace.setDoorplate({ room: args.room, doorplate: args.doorplate });
        }
        const r = palace.organize({ assignments: args.assignments ?? {} });
        const cold = memory.archiveCold({ dryRun: args.dryRun === true });
        return {
          ok: true,
          indexFile: r.indexFile,
          written: r.written,
          rooms: r.rooms,
          migrated: r.migrated,
          cold,
          message:
            `已重建 ${r.written.length} 个房间视图 + INDEX.md：${r.indexFile}\n` +
            `迁移旧记录 ${r.migrated.migrated} 条（显式指派 ${r.migrated.assigned}，进 inbox ${r.migrated.toInbox}）。\n` +
            `冷归档 ${cold.archived} 条${cold.dryRun ? '（dryRun，未移动）' : ''}` +
            (cold.archived > 0 && !cold.dryRun ? `，已移入 ${cold.file}（可 restore 捞回）` : '') +
            (r.migrated.toInbox > 0
              ? '\n\n进 inbox 的那几条**刻意没猜**——房间分错的记忆在房间视图里是隐形的。看完清单用 action="move" 归位。'
              : ''),
        };
      }
      if (action === 'review') {
        const rows = memory.dueList({ limit: args.limit ?? 10 });
        return {
          ok: true,
          count: rows.length,
          results: rows,
          message:
            rows.length === 0
              ? '没有到期的记忆。这不等于"记忆都没问题"，只说明按当前 stability 还没有一条走到 due。'
              : `${rows.length} 条到期待确认（按到期先后排）。对每条问一句"现在还成立吗"：成立 → reinforce；不成立 → weaken。**别跳过**，跳过等于让它按旧强度继续影响判断。`,
        };
      }
      if (action === 'reinforce' || action === 'weaken') {
        const changed = action === 'reinforce' ? memory.reinforce({ ids: args.ids ?? [] }) : memory.weaken({ ids: args.ids ?? [] });
        if (changed.length > 0) palace.rebuildViews();
        return {
          ok: true,
          changed,
          message:
            changed.length === 0
              ? '没有匹配的 id（可能已归档）。'
              : `${action === 'reinforce' ? '加固' : '削弱'} ${changed.length} 条。` +
                changed.map((c) => `\n- ${c.id}｜强度 ${c.strength}｜稳定度 ${c.stability} 天｜下次到期 ${String(c.due).slice(0, 10)}`).join(''),
        };
      }
      if (action === 'archive') {
        const r = memory.archiveCold({ dryRun: args.dryRun === true });
        if (r.archived > 0 && !r.dryRun) palace.rebuildViews();
        return {
          ok: true,
          ...r,
          message:
            r.archived === 0
              ? `没有需要冷归档的条目（判据：可回想概率 < ${memory.COLD_THRESHOLD} 且年龄 > 一个 stability）。`
              : `${r.dryRun ? '（dryRun）' : ''}冷归档 ${r.archived} 条 → ${r.file}。这是**移动不是删除**，restore 可捞回。`,
        };
      }
      if (action === 'cold') {
        const rows = memory.coldList({ limit: args.limit ?? 20 });
        return {
          ok: true,
          count: rows.length,
          results: rows,
          message: rows.length === 0 ? '冷档是空的。' : `冷档 ${rows.length} 条。捞回用 action="restore" + ids。`,
        };
      }
      if (action === 'restore') {
        const r = memory.restoreCold({ ids: args.ids ?? [] });
        if (r.restored > 0) palace.rebuildViews();
        return {
          ok: true,
          ...r,
          message: r.restored > 0 ? `已捞回 ${r.restored} 条（强度重置 0.4，7 天后到期）。` : r.note ?? '没有捞回任何条目。',
        };
      }
      if (action === 'move') {
        const r = memory.move({ ids: args.ids ?? [], room: args.room, kind });
        palace.rebuildViews();
        return { ok: true, ...r, message: `已迁移 ${r.moved} 条到「${r.room}」，视图已重建。` };
      }
      if (action === 'remember') {
        const rec = memory.remember({
          kind: kind === 'all' ? 'fact' : kind,
          text: args.text,
          tags: args.tags,
          source: args.source ?? 'conversation',
          confidence: args.confidence,
          room: args.room ?? null,
          loci: args.loci ?? null,
          workspace: wsExplicit ?? ws.path,
        });
        palace.rebuildViews();
        return {
          ok: true,
          record: rec,
          stats: memory.stats(),
          message:
            `已记住（${rec.kind}｜房间 \`${rec.room}\` 位置 ${rec.loci}${rec.routed === 'auto' ? '｜自动归房' : '｜指定房间'}｜工作区 ${rec.workspace ?? '未标注'}）：` +
            `${rec.text.slice(0, 80)}${rec.text.length > 80 ? '…' : ''}`,
        };
      }
      if (action === 'recall') {
        const candidates = memory.countAll(kind);
        const rows = memory.recall({ query: args.query ?? '', kind, limit: args.limit ?? 8, tags: args.tags, room: args.room ?? null, workspace: wsExplicit });
        const meta = rows.meta ?? {};
        telemetry.logMemory({
          action,
          kind,
          query: args.query ?? '',
          candidates,
          returned: rows.length,
          topScore: rows[0]?.score ?? null,
          latencyMs: Date.now() - t0,
          storeSize: candidates,
          extra: {
            stage: meta.stage ?? null,
            roomsUsed: meta.roomsUsed ?? [],
            doors: (meta.doorsUsed ?? []).length,
            fallback: meta.fallback ?? 0,
          },
        });
        return {
          ok: true,
          count: rows.length,
          stage: meta.stage ?? null,
          roomsUsed: meta.roomsUsed ?? [],
          doorsUsed: meta.doorsUsed ?? [],
          fallback: meta.fallback ?? 0,
          currentWorkspace: ws,
          workspaceFilter: wsExplicit,
          results: rows,
          message:
            rows.length === 0
              ? meta.stage === 'room'
                ? `房间 ${(meta.roomsUsed ?? []).join(' / ')} 里没有匹配的条目。这是**硬过滤**的结果——换成不指定 room 再搜一次，别房间或全局可能就有。`
                : '记忆里没有相关条目。'
              : `找到 ${rows.length} 条相关记忆` +
                (meta.stage === 'room'
                  ? `（限定在房间 ${meta.roomsUsed.join(' / ')} 内，不走门、不做全局兜底）`
                  : meta.stage === 'palace'
                    ? `（走了房间 ${meta.roomsUsed.join(' / ')}${
                        (meta.doorsUsed ?? []).length ? `，串门 ${meta.doorsUsed.map((d) => `${d.from}→${d.to}`).join('、')}` : ''
                      }，全局兜底补 ${meta.fallback} 条）`
                    : meta.stage === 'strength'
                      ? '（按可回想强度兜底：没命中关键词，端上最鲜活的）'
                      : '（没命中任何房间关键词，走全局检索）') +
                '。',
        };
      }
      if (action === 'list') {
        const rows = memory.list({ kind, limit: args.limit ?? 50, workspace: wsExplicit });
        telemetry.logMemory({ action, kind, candidates: rows.length, returned: rows.length, latencyMs: Date.now() - t0 });
        return { ok: true, count: rows.length, results: rows, message: `共 ${rows.length} 条。` };
      }
      if (action === 'forget') {
        if (!args.id && !args.query) return { ok: false, message: 'forget 需要 id 或 query。' };
        const r = memory.forget({ id: args.id ?? '', query: args.query ?? '', kind });
        return { ok: true, ...r, stats: memory.stats(), message: `已删除 ${r.removed} 条。` };
      }
      if (action === 'eval') {
        // 检索基准（v0.3 · 3.5）：题目从当前真实记忆里生成，所以成绩只对这台机器有意义。
        const records = memory.list({ kind: 'all', limit: 500 });
        const { cases, coverage } = buildCases({ records, limit: Math.max(4, Math.min(30, Number(args.limit) || 20)) });
        const result = runEval({ recall: memory.recall, cases });
        const report = renderReport(result, { title: `检索基准 · ${localDate()}`, coverage });
        const file = join(paths.home, 'journal', `eval-${localDate()}.md`);
        writeText(file, report);
        return {
          ok: true,
          ...result,
          coverage,
          file,
          message:
            `检索基准：**${result.passed}/${result.total}**（${(result.score * 100).toFixed(1)}%）→ ${file}\n` +
            `覆盖：${coverage.note}` +
            (result.failed > 0
              ? `\n失败 ${result.failed} 条：` + result.details.filter((d) => !d.pass).map((d) => `${d.id}「${d.query}」${d.reasons.join('；')}`).join(' ｜ ')
              : '') +
            '\n\n这个分数是 3.4 的验收基线：改检索之后重跑，分数必须上升或不降。',
        };
      }
      const s = memory.stats();
      return { ok: true, stats: s, message: `事实 ${s.facts} 条 / 情节 ${s.episodes} 条。` };
    }),
  });

  // -------------------------------------------------------------------------
  // 5. jarvis_project —— 五闸门
  // -------------------------------------------------------------------------
  register({
    name: 'jarvis_project',
    description:
      '五闸门项目协议（R1 的引擎）。action=open 立项（**只建状态、绝不开工**）；action=record 记录某道闸门的产出（不可跳跃；第 3 道闸门要带 consent=true 才算拿到用户同意开工）；action=wbs 设置小项拆分（每项 30–60 分钟 + 验收判据）；action=progress 推进小项（标记 done 必须给 evidence）；action=status 看单个项目；action=list 列全部；action=close 关闭。文档落在 ~/.dsh/jarvis/projects/<slug>/。写入无需审批。',
    parameters: schema(
      {
        action: { type: 'string', enum: ['open', 'record', 'wbs', 'progress', 'status', 'list', 'review', 'close'], description: '要做什么' },
        name: {
          type: 'string',
          description:
            '项目名（也是 slug 来源）。open 时必填；record/wbs/progress/status/close 时可省略 —— 省略就自动用"唯一那个未关闭的项目"，有多个则会报错并在错误里列出，让你写明。',
        },
        goal: { type: 'string', description: 'open 时：一句话目标' },
        deliverable: { type: 'string', description: 'open 时：交付物' },
        deadline: { type: 'string', description: 'open 时：截止时间' },
        stakes: { type: 'string', description: 'open 时：为什么值得做 / 对四条战线的意义' },
        workspace: { type: 'string', description: 'open 时：工作区路径标注。不给就自动取当前会话目录；取不到就留空（不编默认值）' },
        gate: { type: 'string', description: 'record 时：闸门（1/2/3/4/5，或 restate/inventory/gap/plan/execute，或中文名）' },
        content: { type: 'string', description: 'record 时：该闸门的产出（Markdown）' },
        userKnowledge: { type: 'string', description: 'record 第 2 道闸门时：用户自述已掌握的知识' },
        tools: { type: 'array', items: { type: 'string' }, description: 'record 时：需要/会用到的技能或工具' },
        consent: { type: 'boolean', description: 'record 第 3 道闸门时：用户是否已同意开工（必须真实取得，不许代填）' },
        innovation: { type: 'string', enum: ['适度创新', '极致创新', '不创新'], description: 'record 第 4 道闸门时：创新档位' },
        items: { type: 'array', description: 'wbs 时：小项数组，元素可为字符串或 {id,title,acceptance,est}' },
        item: { type: 'string', description: 'progress 时：小项 id 或标题' },
        status: { type: 'string', enum: ['todo', 'doing', 'done'], description: 'progress 时：目标状态' },
        evidence: { type: 'string', description: 'progress 时：证据（改了哪个文件/跑了什么命令/结果如何）。标记 done 必填。' },
        selfCheck: { type: 'string', description: 'progress 时：自检结论（对照验收判据）' },
        thirdParty: { type: 'string', description: 'progress 时：第三方检查结论' },
        risk: { type: 'string', description: 'progress 时：剩余风险' },
        next: { type: 'string', description: 'progress 时：下一步' },
        report: { type: 'string', description: 'progress 时：给用户的一句汇报' },
        outcome: { type: 'string', description: 'close 时：结论' },
        followUp: { type: 'string', description: 'close 时：后续可做的事' },
        target: { type: 'string', description: 'review 时：本次评审的对象（例："小项 1.4 rcs.py + Mie 对比"）' },
        items: {
          type: 'array',
          description: 'review 时：逐条判定。清单没走完 → 判为 incomplete，不算通过。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'C1…C9' },
              verdict: { type: 'string', enum: ['pass', 'fail', 'na'] },
              evidence: { type: 'string', description: '可复现依据：命令+退出码 / 文件:行号 / 返回值片段' },
            },
            required: ['id', 'verdict'],
          },
        },
        reproduce: { type: 'array', items: { type: 'string' }, description: 'review 时：复现命令（写进 REVIEW.md）' },
        artifacts: { type: 'array', items: { type: 'string' }, description: 'review 时：计入指纹的文件绝对路径（sha256 前 16 位）' },
        summary: { type: 'string', description: 'review 时：总裁决说明' },
      },
      ['action'],
    ),
    output: { schema: TEXT_OUT({ next: { type: 'object' } }) },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    execute: safe(async (args, exec) => {
      const action = String(args.action ?? 'status');
      switch (action) {
        case 'open': {
          // 立项时标注工作区（v0.3 · 3.2b）。取不到就留空，不编一个默认路径。
          const ws = await resolveWorkspace(ctx, exec);
          const r = project.open({
            name: args.name,
            goal: args.goal,
            deadline: args.deadline,
            deliverable: args.deliverable,
            stakes: args.stakes,
            workspace: String(args.workspace ?? '').trim() || ws.path || '',
          });
          return {
            ok: true,
            slug: r.slug,
            created: r.created,
            next: r.next,
            message:
              `项目「${r.state.name}」${r.created ? '已建立' : '已存在'}（${r.slug}）。**现在不要开工**，先按下面的问题走第 1 道闸门。\n\n${r.next.ask}`,
          };
        }
        case 'record': {
          const r = project.record({
            name: args.name,
            gate: args.gate,
            content: args.content,
            userKnowledge: args.userKnowledge,
            tools: args.tools,
            consent: args.consent === true,
            innovation: args.innovation,
          });
          return { ok: true, ...r, message: `已记录第 ${r.recorded} 道闸门。${describeNext(r)}` };
        }
        case 'wbs': {
          const r = project.setWbs({ name: args.name, items: args.items });
          return { ok: true, ...r, message: `WBS 已设置，共 ${r.count} 个小项。` };
        }
        case 'progress': {
          const r = project.progressItem({
            name: args.name,
            item: args.item,
            status: args.status ?? 'done',
            evidence: args.evidence,
            report: args.report,
            selfCheck: args.selfCheck,
            thirdParty: args.thirdParty,
            risk: args.risk,
            next: args.next,
          });
          return { ok: true, ...r, message: `小项 ${r.item} → ${r.status}；还剩 ${r.remaining} 项。` };
        }
        case 'list': {
          const rows = project.list();
          return { ok: true, projects: rows, count: rows.length, message: rows.length === 0 ? '目前没有项目。' : `共 ${rows.length} 个项目。` };
        }
        case 'review': {
          const checks = review.listChecks();
          if (!Array.isArray(args.items) || args.items.length === 0) {
            return {
              ok: true,
              checks,
              message:
                '评审必须逐条判定，不许跳过。清单如下，把每条填成 pass/fail/na 并给**可复现依据**，\n' +
                '再用 items:[{id,verdict,evidence}] 传回来。\n\n' +
                checks.map((c) => `${c.id}. ${c.q}\n    怎么做：${c.how}\n    判不合格：${c.failIf}`).join('\n\n') +
                '\n\n注意：这不是独立第三方——评审者还是我。抬头会写死这句话，不许含糊。',
            };
          }
          const st = project.status({ name: args.name });
          const r = review.writeReview({
            slug: st.slug,
            name: st.name,
            target: args.target ?? '',
            items: args.items,
            reproduce: Array.isArray(args.reproduce) ? args.reproduce : [],
            artifacts: Array.isArray(args.artifacts) ? args.artifacts : [],
            summary: args.summary ?? '',
          });
          return {
            ok: true,
            verdict: r.overall,
            ...r,
            message:
              `评审已落盘：${r.file}\n**总裁决：${r.overall}**` +
              (r.fails.length ? `\n不合格：${r.fails.join(' / ')}` : '') +
              (r.missing.length ? `\n**漏判（清单没走完，不算通过）：${r.missing.join(' / ')}**` : '') +
              (r.noEvidence.length ? `\n缺依据：${r.noEvidence.join(' / ')}` : '') +
              (r.overall === 'pass' ? '' : '\n\n总裁决不是 pass → 不许把这个小项标 done。'),
          };
        }
        case 'close': {
          const r = project.close({ name: args.name, outcome: args.outcome, followUp: args.followUp });
          return { ok: true, ...r, message: `项目已关闭，文档在 ${r.docPath}。` };
        }
        default: {
          const s = project.status({ name: args.name });
          return { ok: true, ...s, message: `「${s.name}」在第 ${s.gate} 道闸门（${s.gateName}）；WBS ${s.wbsDone}/${s.wbsTotal} 完成。` };
        }
      }
    }),
  });

  function describeNext(r) {
    if (!r.next) return '';
    if (r.next.blockers?.length) return `目前有阻塞：\n- ${r.next.blockers.join('\n- ')}`;
    return `下一道闸门是第 ${r.next.gate} 道 · ${r.next.gateName}。请把下面这段问给用户：\n\n${r.next.ask}`;
  }

  // -------------------------------------------------------------------------
  // 6. jarvis_knowledge
  // -------------------------------------------------------------------------
  register({
    name: 'jarvis_knowledge',
    description:
      '本地知识库（~/.dsh/jarvis/knowledge/，Markdown）。action=search 关键词检索（返回文件路径+行号，引用时必须带上，用户要能自己点进去核对）；action=add 写入一条带解读的笔记（不是复述摘要，要写"这对用户意味着什么"）；action=list 列文件；action=stats 统计。写入无需审批。',
    parameters: schema(
      {
        action: { type: 'string', enum: ['search', 'add', 'list', 'stats'], description: '要做什么' },
        query: { type: 'string', description: 'search 的检索词' },
        title: { type: 'string', description: 'add 时的标题' },
        text: { type: 'string', description: 'add 时的正文（Markdown）' },
        tags: { type: 'array', items: { type: 'string' }, description: 'add 时的标签' },
        source: { type: 'string', description: 'add 时的来源（论文链接、对话、工具等）' },
        kind: { type: 'string', description: 'add 时的类型：note / paper / theorem / pitfall / intel' },
        days: { type: 'number', description: 'search 时只搜最近 N 天' },
        limit: { type: 'number', description: '返回条数上限' },
      },
      ['action'],
    ),
    output: { schema: TEXT_OUT({ results: { type: 'array' } }) },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    execute: safe(async (args) => {
      knowledge.ensureDirs();
      const action = String(args.action ?? 'search');
      if (action === 'add') {
        const r = knowledge.add({ title: args.title, text: args.text, tags: args.tags, source: args.source ?? 'jarvis', kind: args.kind ?? 'note' });
        return { ok: true, ...r, message: `已写入 ${r.file}` };
      }
      if (action === 'list') {
        const files = knowledge.list({ limit: args.limit ?? 30 });
        return { ok: true, count: files.length, files, message: `共 ${files.length} 个文件。` };
      }
      if (action === 'stats') {
        const s = knowledge.stats();
        return { ok: true, stats: s, message: `${s.notes} 条笔记 + ${s.intelDays} 天情报，共 ${(s.bytes / 1024).toFixed(1)} KB。` };
      }
      const rows = knowledge.search({ query: args.query ?? '', limit: args.limit ?? 6, days: args.days ?? 0 });
      return {
        ok: true,
        count: rows.length,
        results: rows,
        message:
          rows.length === 0
            ? `知识库里没有匹配 "${args.query ?? ''}" 的内容。可以先用 jarvis_intel / read_page / web_search 去取，再用 jarvis_knowledge(action="add") 沉淀。`
            : `找到 ${rows.length} 条。引用时请写清 文件路径:行号。`,
      };
    }),
  });

  // -------------------------------------------------------------------------
  // 7. jarvis_preflight —— 梯子探测
  // -------------------------------------------------------------------------
  register({
    name: 'jarvis_preflight',
    description:
      '外网可达性预检（梯子探测）。对 arXiv / Hugging Face / GitHub / Google Scholar / Google 各做一次 6 秒 GET 并立即丢弃响应体，把失败分成"DNS 失败（本地网络/代理问题）"与"超时/重置（大概率需要梯子）"。**它本身就是用来判断要不要提醒用户开梯子的**，所以它不需要审批。任何要抓外网内容之前先跑它。',
    parameters: schema({
      targets: { type: 'array', items: { type: 'string' }, description: '可选：自定义探测 URL 列表；留空用默认五源' },
      timeoutMs: { type: 'number', description: '单个目标超时（毫秒，默认 6000）' },
    }),
    output: { schema: TEXT_OUT({ verdict: { type: 'string' } }) },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    execute: safe(async (args) => {
      const r = await preflightProbe({ targets: args.targets ?? null, timeoutMs: args.timeoutMs ?? 6000 });
      const lines = r.results.map(
        (x) =>
          `- ${x.reachable ? '✅' : '❌'} ${x.label}${x.reachable ? `（HTTP ${x.status}，${x.latencyMs}ms）` : `（${x.error || '失败'}${x.dnsOk === false ? ' · DNS 也失败' : ''}）`}`,
      );
      return {
        ok: true,
        ...r,
        message: `${lines.join('\n')}\n\n**结论**：${r.advice}`,
        nextStep:
          r.verdict === 'ok'
            ? '外网可用，可以继续抓取。'
            : '先把上面这段结论原样告诉用户（明确说"需要梯子"），然后停下来等用户开梯子，不要反复重试。',
      };
    }),
  });

  // -------------------------------------------------------------------------
  // 8. jarvis_intel —— 每日情报
  // -------------------------------------------------------------------------
  register({
    name: 'jarvis_intel',
    description:
      '抓取并排序 AI / AI4S / 具身智能 的每日情报：arXiv（cs.AI/cs.LG/cs.CL/cs.RO + AI-for-Science 关键词）+ Hugging Face Daily Papers，按兴趣向量排序（偏好理论/定理/数学结构，对刷榜与调参降权），写进 ~/.dsh/jarvis/knowledge/intel/YYYY-MM-DD.md，并返回 top 列表供 Jarvis 写解读。会访问境外网络——抓取前先跑 jarvis_preflight 判断是否需要梯子。',
    parameters: schema({
      top: { type: 'number', description: '精选条数（默认取配置里的 digestTop，12）' },
      includeHf: { type: 'boolean', description: '是否包含 Hugging Face Daily Papers（默认 true）' },
      timeoutMs: { type: 'number', description: '单个请求超时（毫秒，默认 20000）' },
      ifMissing: { type: 'boolean', description: '今天已经抓过就跳过（补跑场景用：只在缺的时候抓）' },
    }),
    output: { schema: TEXT_OUT({ top: { type: 'array' } }) },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    execute: safe(async (args) => {
      const cfg = cfgOrThrow();
      const g = gate(cfg, {
        action: 'network',
        summary: '抓取 arXiv 与 Hugging Face 的每日论文情报',
        detail: '只读取公开 API，不下载附件，不写除 ~/.dsh/jarvis/ 之外的任何路径。',
      });
      if (!g.allowed) return approvalPayload(g);
      const r = await intel.run({ config: cfg, top: args.top ?? null, includeHf: args.includeHf !== false, timeoutMs: args.timeoutMs ?? 20000, ifMissing: args.ifMissing === true });
      if (!r.ok) return { ok: false, needsApproval: false, networkNote: g.remind ?? '', ...r, message: r.message };
      return {
        ok: true,
        networkNote: g.remind ?? '',
        ...r,
        message:
          `今日情报已生成：${r.file}\n候选 ${r.counts.raw} 条 → 去重 ${r.counts.deduped} 条 → 精选 ${r.counts.picked} 条。` +
          (r.sources?.length ? `\n源状态：${r.sources.map((s) => `${s.source}${s.ok ? `✅${s.count}` : '❌'}`).join(' / ')}` : '') +
          (r.notes?.length ? `\n注记：${r.notes.join('；')}` : '') +
          `\n\n${r.nextStep}`,
      };
    }),
  });

  // -------------------------------------------------------------------------
  // 9. jarvis_weekly —— 周复盘
  // -------------------------------------------------------------------------
  register({
    name: 'jarvis_weekly',
    description:
      '生成周报骨架：四个硬截止的倒计时 + 四条战线（A 课内 GPA / B 科研与论文 / C 数学丘赛 / D AI 全栈）各自的实况栏 + 本周情报文件清单 + 待重新审视的旧判断 + 需要用户拍板的问题。写进 ~/.dsh/jarvis/journal/YYYY-MM-DD-weekly.md。纯本地，无网络。',
    parameters: schema({
      date: { type: 'string', description: '可选：指定日期 YYYY-MM-DD（默认今天，用于补写）' },
    }),
    output: { schema: TEXT_OUT({ file: { type: 'string' } }) },
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    execute: safe(async (args) => {
      const cfg = cfgOrThrow();
      const when = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? new Date(`${args.date}T12:00:00`) : new Date();
      const r = intel.writeWeekly({ config: cfg, date: when });
      const cd = r.deadlines.map((d) => `${d.date}（还剩 ${d.days} 天）`).join('｜');
      return {
        ok: true,
        ...r,
        message:
          `周报骨架已生成：${r.file}\n倒计时：${cd}\n\n请**用真实内容填满它**（不许留空、不许写"这周很忙"），` +
          `填不出来的地方要明确写"缺数据"，然后向用户提问。填完用 jarvis_knowledge(action="add") 沉淀要点。`,
      };
    }),
  });

  // -------------------------------------------------------------------------
  // 10. jarvis_verify —— 引用核验（防幻觉的硬约束）
  // -------------------------------------------------------------------------
  register({
    name: 'jarvis_verify',
    description:
      '引用核验：把一段文本里所有 `路径:行号` 与 URL 抽出来逐个核验（文件在不在、行号越界没、那一行到底写了什么），返回**每个引用的实际内容**。行号越界是确定性编造，一抓一个准；摘出原文则能让人一眼看出引用是否支持论点。写事实性回答之前或之后调用它，能让"编造"变成"当场被抓"。注意：只验「带行号」的引用；含空格的路径要用反引号包起来；相对路径要靠 roots 传根目录，否则只会去 Jarvis 数据目录下找。',
    parameters: schema(
      {
        text: { type: 'string', description: '要核验的文本（通常是刚写好、准备发出的那段回答）' },
        roots: {
          type: 'array',
          items: { type: 'string' },
          description: '相对路径的解析根目录。**引用工作区里的文件时必须传**（例如当前工作区绝对路径），否则找不到会被判成 missing。',
        },
        checkUrls: {
          type: 'boolean',
          description: '是否联网核验 URL（每个链接一次 HEAD）。默认关；开了会走外网审批闸门（红线 R3）。',
        },
        max: { type: 'number', description: '最多核验多少条引用（默认 60）' },
      },
      ['text'],
    ),
    output: { schema: TEXT_OUT({ summary: { type: 'object' } }) },
    timeoutMs: 90_000,
    isConcurrencySafe: () => true,
    execute: safe(async (args) => {
      const text = String(args.text ?? '');
      if (text.trim() === '') return { ok: false, message: '需要 text：把要核验的那段回答原样贴进来。' };

      let fetcher = null;
      let networkNote = '';
      if (args.checkUrls === true) {
        const cfg = cfgOrThrow();
        const g = gate(cfg, {
          action: 'network',
          summary: `为核验链接是否失效，逐个访问外网（最多 12 个 URL，每个一次 HEAD）`,
          detail: '只发 HEAD 请求，不下载任何内容，不写除 ~/.dsh/jarvis/ 之外的路径。',
        });
        if (!g.allowed) return approvalPayload(g);
        networkNote = g.remind ?? '';
        fetcher = async (url) => {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), 8000);
          try {
            const res = await fetch(url, {
              method: 'HEAD',
              redirect: 'follow',
              signal: ac.signal,
              headers: { 'user-agent': 'dsh-jarvis-verify/0.1 (+local citation check)' },
            });
            return { status: res.status };
          } catch (e) {
            return { status: null, error: e?.name === 'AbortError' ? '超时（8s）' : e?.message ?? String(e) };
          } finally {
            clearTimeout(timer);
          }
        };
      }

      const r = await verifyCitations({ text, roots: args.roots ?? [], fetcher, max: args.max });
      return {
        ...r,
        ...(networkNote ? { networkNote } : {}),
        ...(fetcher ? {} : { urlNote: 'URL 未联网核验（checkUrls=false）。引用网页时要么开它，要么明确标"链接未验证"。' }),
      };
    }),
  });

  // -------------------------------------------------------------------------
  // 11. jarvis_correction —— 纠错账本（幻觉统计）
  // -------------------------------------------------------------------------
  register({
    name: 'jarvis_correction',
    description:
      '纠错账本：每当用户指出 Jarvis 说错了（"不对 / 不是这样 / 你编的 / 我查了不是这个"），立刻记一条——我原本的说法、正确说法、证据、类别、严重度。这是回答"幻觉什么时候发生、最容易发生在哪类事上"的**唯一可靠数据源**（幻觉本身无法自动统计）。action=record 记账；list 看最近条目；stats 出「最常出错类型」排行榜；drop 删错记的一条。写入只在 ~/.dsh/jarvis/ 内，无需审批。',
    parameters: schema(
      {
        action: { type: 'string', enum: ['record', 'list', 'stats', 'drop'], description: '要做什么' },
        claim: { type: 'string', description: 'record：我原本说错了什么（原话或忠实转述）' },
        truth: { type: 'string', description: 'record：正确的说法是什么' },
        evidence: { type: 'string', description: 'record：证据（文件路径:行号 / URL / 用户原话）' },
        kind: {
          type: 'string',
          enum: [...claims.CLAIM_KINDS],
          description: 'record：错在哪一类。path=路径行号 / api=API签名 / number=数字指标 / literature=文献作者年份 / date=日期 / fact=一般事实 / logic=推理 / other',
        },
        severity: { type: 'number', description: 'record：严重度 1=无害 2=会误导决策 3=会造成实际损失（默认 2）' },
        id: { type: 'string', description: 'drop：要删除的记录 id' },
        limit: { type: 'number', description: 'list：返回条数（默认 30）' },
        days: { type: 'number', description: 'stats：只看最近 N 天（默认全部）' },
      },
      ['action'],
    ),
    output: { schema: TEXT_OUT({}) },
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    execute: safe(async (args) => {
      const action = String(args.action ?? 'stats');
      if (action === 'record') {
        const rec = claims.record({
          claim: args.claim,
          truth: args.truth ?? '',
          evidence: args.evidence ?? '',
          kind: args.kind ?? 'fact',
          severity: args.severity ?? 2,
        });
        const s = claims.stats();
        return {
          ok: true,
          record: rec,
          stats: s,
          message: `已记账（${claims.CLAIM_LABELS[rec.kind] ?? rec.kind}｜严重度 ${rec.severity}）。${s.note}`,
        };
      }
      if (action === 'list') {
        const rows = claims.list({ limit: args.limit ?? 30 });
        return { ok: true, count: rows.length, results: rows, message: rows.length === 0 ? '账本还是空的。' : `最近 ${rows.length} 条。` };
      }
      if (action === 'drop') {
        if (!args.id) return { ok: false, message: 'drop 需要 id（先用 action="list" 看到 id）。' };
        const r = claims.drop({ id: args.id });
        return { ok: true, ...r, message: `已删除 ${r.removed} 条。` };
      }
      const s = claims.stats({ days: args.days ?? 0 });
      return { ok: true, stats: s, message: s.note };
    }),
  });

  // -------------------------------------------------------------------------
  // 常驻人格卡
  // -------------------------------------------------------------------------
  try {
    const sp = ctx.get?.('systemPrompt') ?? ctx.systemPrompt;
    if (!sp?.section) throw new Error('systemPrompt 服务不可用');
    const section = sp.section({
      name: 'plugin:jarvis',
      // 116：紧跟在核心身份之后、具体工具说明之前。数字越大越靠后。
      order: 116,
      text: () => buildPersonaCard(loadConfig()),
    });
    if (typeof section === 'function') ctx.on('dispose', () => section());
  } catch (e) {
    warn(`注册人格卡失败：${e?.message ?? e}`);
  }

  // -------------------------------------------------------------------------
  // 斜杠命令
  // -------------------------------------------------------------------------
  const commands = [
    {
      name: 'jarvis',
      description: 'Jarvis 自检：模式 / 档案 / 记忆 / 项目 / 情报 / 倒计时',
      hint: '',
      say: '先跑 jarvis_status 看状态，再把 gaps 里列出的缺项补上（缺情报就跑 jarvis_intel，缺记忆就从本轮对话里沉淀）。',
    },
    {
      name: 'jarvis-mode',
      description: '切换人格模式：academic / bro / hybrid，可带浓度 0-5',
      hint: '<academic|bro|hybrid> [0-5]',
      say: '把用户输入的模式与浓度解析出来，调用 jarvis_mode。没给参数就先用 jarvis_mode 读当前模式再问用户想切哪个。',
    },
    {
      name: 'jarvis-project',
      description: '立项：进入五闸门协议（不会自动开工）',
      hint: '<项目名>',
      say: '调用 jarvis_project(action="open", name=<项目名>) 建立项目，然后把返回的 next.ask 原文问给用户。**不要开工。**',
    },
    {
      name: 'jarvis-intel',
      description: '抓取并排序今日 AI / AI4S / 具身智能 情报',
      hint: '[精选条数]',
      say: '先跑 jarvis_preflight 判断是否需要梯子；需要就先提醒用户。然后跑 jarvis_intel，最后用 jarvis_knowledge(action="add") 把与四条战线相关的条目写成带解读的笔记。',
    },
    {
      name: 'jarvis-weekly',
      description: '生成并填写本周复盘（挂钩四条战线）',
      hint: '',
      say: '跑 jarvis_weekly 拿骨架，然后用本轮对话与记忆里的真实内容填满它；填不出的地方向用户提问。',
    },
  ];

  try {
    const cmdSvc = ctx.get?.('commands') ?? ctx.commands;
    if (!cmdSvc?.register) {
      warn('commands 服务不可用，斜杠命令未注册（工具与人格卡仍然可用）。');
    } else
      ctx.effect(
        () => {
          const disposers = [];
          for (const c of commands) {
            try {
              disposers.push(
                cmdSvc.register({
                  name: c.name,
                  description: c.description,
                  input: c.hint ? { hint: c.hint } : undefined,
                  recordInput: false,
                  handler: (invocation) => {
                    const raw = String(invocation?.rawInput ?? '').trim();
                    return {
                      kind: 'success',
                      text:
                        `【Jarvis】/${c.name}${raw ? ` ${raw}` : ''}\n` +
                        `${c.say}\n` +
                        (raw ? `用户给的参数：\`${raw}\`\n` : ''),
                    };
                  },
                }),
              );
              registeredCommands.push(c.name);
            } catch (e) {
              warn(`注册命令 /${c.name} 失败：${e?.message ?? e}`);
            }
          }
          return () => {
            for (const d of disposers.reverse()) {
              try {
                d();
              } catch {
                /* ignore */
              }
            }
          };
        },
        'jarvis: slash commands',
      );
  } catch (e) {
    warn(`注册斜杠命令失败：${e?.message ?? e}`);
  }

  // -------------------------------------------------------------------------
  // 技能包（随插件自带，不写 ~/.dsh/skills/）
  // -------------------------------------------------------------------------
  try {
    const skills = ctx.get?.('skills');
    if (!skills?.register) {
      warn('skills 服务不可用，技能包未注册（工具仍然可用）。');
    } else {
      for (const s of RUNTIME_SKILLS) {
        try {
          const content = readFileSync(join(SKILL_DIR, s.name, 'SKILL.md'), 'utf8');
          skills.register({ name: s.name, description: s.description, content, source: 'runtime' });
        } catch (e) {
          warn(`注册技能 ${s.name} 失败：${e?.message ?? e}`);
        }
      }
    }
  } catch (e) {
    warn(`技能包注册流程失败：${e?.message ?? e}`);
  }

  // -------------------------------------------------------------------------
  // 启动横幅（写入 jarvis.log，方便排查）
  // -------------------------------------------------------------------------
  try {
    const cfg = loadConfig();
    const missing = PLANNED_TOOLS.filter((n) => !registeredNames.includes(n));
    logLine(
      `jarvis v0.3.0 ready; mode=${cfg.mode}; tools=${registeredNames.length}/${PLANNED_TOOLS.length}; commands=${registeredCommands.length}/5; names=${registeredNames.join(',')}${
        missing.length ? `; MISSING=${missing.join(',')}（见上面的 warn 行）` : ''
      }`,
    );
    info(
      `v0.3.0 ready — 模式 ${MODE_LABELS[cfg.mode] ?? cfg.mode}，${registeredNames.length} 个工具 + ${registeredCommands.length} 个命令 + 3 个技能，数据目录 ${paths.home}` +
        (missing.length ? `；缺 ${missing.length} 个：${missing.join(',')}` : ''),
    );
  } catch (e) {
    warn(`启动横幅失败：${e?.message ?? e}`);
  }
}

export { MODES, MODE_LABELS };
// 注意：**不要**再写 `export default apply`。
// Cordis 装载时若存在 default 导出，会把 default（一个裸函数）当作插件本体，
// 于是模块命名空间上的 `name` / `inject` 全部丢失，apply 里访问 ctx.tools 会得到
// `Error: cannot get property "tools" without inject`（2026-xx 实测踩过）。
