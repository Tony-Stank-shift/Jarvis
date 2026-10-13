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
    logLine(`jarvis v0.1 apply(); home=${paths.home}; profileCreated=${boot.profile.created}`);
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[jarvis] 初始化数据目录失败：${e?.message ?? e}`);
    } catch {
      /* ignore */
    }
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
        gaps,
        message:
          `模式：${MODE_LABELS[cfg.mode] ?? cfg.mode}｜记忆 ${ms.facts} 事实 / ${ms.episodes} 情节｜` +
          `知识库 ${ks.notes} 笔记 + ${ks.intelDays} 天情报｜进行中项目 ${projects.length}｜` +
          `最近情报 ${ks.lastIntelDate ?? '无'}`,
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
      '双轨长期记忆。kind=fact 存稳定事实（性格、习惯、偏好、长期约束、已掌握的知识点）；kind=episode 存情节（某天发生了什么、某次对话的结论、情绪状态）。action=remember 写入；action=recall 按关键词+时间衰减检索（事实衰减轻、情节衰减快）；action=list 按时间倒序列出；action=forget 删除；action=stats 统计。写入只发生在 ~/.dsh/jarvis/ 内，无需审批。',
    parameters: schema(
      {
        action: { type: 'string', enum: ['remember', 'recall', 'list', 'forget', 'stats'], description: '要做什么' },
        kind: { type: 'string', enum: ['fact', 'episode', 'all'], description: '记忆轨道；默认 fact（remember 时）/' + 'all（检索时）' },
        text: { type: 'string', description: 'remember 时的记忆正文' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，便于分类检索' },
        query: { type: 'string', description: 'recall/forget 的检索词' },
        id: { type: 'string', description: 'forget 时按 id 精确删除' },
        source: { type: 'string', description: '来源标记（默认 conversation）' },
        confidence: { type: 'number', description: 'remember 时的置信度 0–1（默认 0.8）' },
        limit: { type: 'number', description: '返回条数上限' },
      },
      ['action'],
    ),
    output: { schema: TEXT_OUT({}) },
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    execute: safe(async (args) => {
      const action = String(args.action ?? 'recall');
      const kind = ['fact', 'episode', 'all'].includes(args.kind) ? args.kind : action === 'remember' ? 'fact' : 'all';
      if (action === 'remember') {
        const rec = memory.remember({
          kind: kind === 'all' ? 'fact' : kind,
          text: args.text,
          tags: args.tags,
          source: args.source ?? 'conversation',
          confidence: args.confidence,
        });
        return { ok: true, record: rec, stats: memory.stats(), message: `已记住（${rec.kind}）：${rec.text.slice(0, 80)}${rec.text.length > 80 ? '…' : ''}` };
      }
      if (action === 'recall') {
        const rows = memory.recall({ query: args.query ?? '', kind, limit: args.limit ?? 8, tags: args.tags });
        return {
          ok: true,
          count: rows.length,
          results: rows,
          message: rows.length === 0 ? '记忆里没有相关条目。' : `找到 ${rows.length} 条相关记忆。`,
        };
      }
      if (action === 'list') {
        const rows = memory.list({ kind, limit: args.limit ?? 50 });
        return { ok: true, count: rows.length, results: rows, message: `共 ${rows.length} 条。` };
      }
      if (action === 'forget') {
        if (!args.id && !args.query) return { ok: false, message: 'forget 需要 id 或 query。' };
        const r = memory.forget({ id: args.id ?? '', query: args.query ?? '', kind });
        return { ok: true, ...r, stats: memory.stats(), message: `已删除 ${r.removed} 条。` };
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
        action: { type: 'string', enum: ['open', 'record', 'wbs', 'progress', 'status', 'list', 'close'], description: '要做什么' },
        name: {
          type: 'string',
          description:
            '项目名（也是 slug 来源）。open 时必填；record/wbs/progress/status/close 时可省略 —— 省略就自动用"唯一那个未关闭的项目"，有多个则会报错并在错误里列出，让你写明。',
        },
        goal: { type: 'string', description: 'open 时：一句话目标' },
        deliverable: { type: 'string', description: 'open 时：交付物' },
        deadline: { type: 'string', description: 'open 时：截止时间' },
        stakes: { type: 'string', description: 'open 时：为什么值得做 / 对四条战线的意义' },
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
      },
      ['action'],
    ),
    output: { schema: TEXT_OUT({ next: { type: 'object' } }) },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    execute: safe(async (args) => {
      const action = String(args.action ?? 'status');
      switch (action) {
        case 'open': {
          const r = project.open({
            name: args.name,
            goal: args.goal,
            deadline: args.deadline,
            deliverable: args.deliverable,
            stakes: args.stakes,
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
      const r = await intel.run({ config: cfg, top: args.top ?? null, includeHf: args.includeHf !== false, timeoutMs: args.timeoutMs ?? 20000 });
      if (!r.ok) return { ok: false, needsApproval: false, networkNote: g.remind ?? '', ...r, message: r.message };
      return {
        ok: true,
        networkNote: g.remind ?? '',
        ...r,
        message:
          `今日情报已生成：${r.file}\n候选 ${r.counts.raw} 条 → 去重 ${r.counts.deduped} 条 → 精选 ${r.counts.picked} 条。` +
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
    const failed = registeredNames.length !== 9;
    logLine(
      `jarvis v0.1 ready; mode=${cfg.mode}; tools=${registeredNames.length}/9; commands=${registeredCommands.length}/5; names=${registeredNames.join(',')}${
        failed ? '; WARNING=有工具没注册上（见上面的 warn 行）' : ''
      }`,
    );
    info(
      `v0.1 ready — 模式 ${MODE_LABELS[cfg.mode] ?? cfg.mode}，${registeredNames.length} 个工具 + ${registeredCommands.length} 个命令 + 3 个技能，数据目录 ${paths.home}`,
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
