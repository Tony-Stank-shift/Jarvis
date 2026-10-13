/**
 * dsh-jarvis — 五闸门项目协议（R1 的引擎）。
 *
 * 用户的硬要求：拿到项目/任务时**不要单方面自主开工**。流程必须是
 *   用户给任务 → Jarvis 说明完成它需要哪些知识 → 用户说明自己已掌握什么
 *   → Jarvis 补讲缺的部分 → **用户同意后**才开始做 → 执行中随时可提问。
 *
 * 所以这里不是一个"任务管理器"，而是一个**闸门状态机**：每个闸门都有
 * "必须产出什么才算过"，且 ①→⑤ 不可跳跃；第 ③ 闸门必须显式拿到用户同意
 * （`consent: true`）才能进第 ⑤ 闸门。
 *
 * 盘上形态：
 *   ~/.dsh/jarvis/projects/<slug>/state.json   机器状态（闸门、WBS、进度、汇报）
 *   ~/.dsh/jarvis/projects/<slug>/PROJECT.md   人读文档（渲染出来的全过程）
 */

import { join } from 'node:path';
import { ensureDir, listDirs, localDate, nowIso, paths, readJson, readText, slugify, writeJson, writeText } from './store.js';

export const GATES = [
  {
    id: 1,
    key: 'restate',
    name: '题意还原',
    ask: [
      '在开始之前，先把我理解的任务复述给你，你确认或纠正：',
      '1. **任务是什么**（一句话）',
      '2. **边界**：包含什么 / 明确不包含什么',
      '3. **交付物**：最终要交出什么（文件？代码？报告？一个结论？）',
      '4. **成功判据**：怎样算做好了，怎样算没做好',
      '5. **时间与资源**：截止时间、可用时间、外部依赖',
    ].join('\n'),
    require: ['任务', '边界', '交付物', '成功判据'],
  },
  {
    id: 2,
    key: 'inventory',
    name: '知识盘点',
    ask: [
      '完成这个任务需要哪些知识/技能？我按"必须"和"加分"分两栏列出来。',
      '同时请你告诉我**你已经会什么**（哪怕只是"课上听过"），我据此只补你真正缺的部分。',
      '另外我会标出：哪些是你档案里已经有记录的（点集拓扑 / 抽象代数群论 / 实分析测度论 / 最优化理论 是已知缺口）。',
    ].join('\n'),
    require: ['必须知识', '加分知识'],
  },
  {
    id: 3,
    key: 'gap',
    name: '差距补课',
    ask: [
      '缺的知识我逐个讲，每个知识点讲完给三道自测题。',
      '规则：**你答对了才推进**；答不对我换一种讲法再讲一遍。',
      '全部讲完我会明确问你："讲清楚了吗？可以开始了吗？"——你说可以，我才进下一道闸门。',
    ].join('\n'),
    require: ['讲解要点', '自测三问', '用户确认'],
  },
  {
    id: 4,
    key: 'plan',
    name: '方案与创新度',
    ask: [
      '我把方案摆出来，你选：',
      '1. **1–3 条技术/执行路线**，每条给：做法、优点、代价、失败风险',
      '2. **创新档位**：适当创新（稳、快、可复现）还是极致创新（激进、可能失败但上限高）',
      '3. **WBS**：拆成每项 30–60 分钟能做完的小项，每项带验收判据',
      '4. **目标对齐**：这件事对你四条战线（A 课内 GPA / B 科研论文 / C 数学丘赛 / D AI 全栈）与四个硬截止的**边际贡献**是多少？有没有更高杠杆的替代做法？如果有，我会直说"这事不值当"。',
    ].join('\n'),
    require: ['路线', '创新档位', 'WBS', '边际贡献'],
  },
  {
    id: 5,
    key: 'execute',
    name: '执行',
    ask: [
      '开始执行。规则：',
      '- 每完成一个小项：自检（对照验收判据）→ 第三方检查（独立 reviewer，默认找茬）→ 一句汇报（做了什么 / 证据 / 剩余风险 / 下一步）',
      '- 执行中你随时可以插话提问，我不打断执行状态',
      '- 每个小项做完写盘 STATE.md + DECISIONS.md，这样压缩上下文后能无损接上',
      '- 全部完成后做**大检查**（整合一致性 / 可复现性 / 对你的价值），再呈现给你',
    ].join('\n'),
    require: [],
  },
];

export const GATE_INDEX = Object.fromEntries(GATES.map((g) => [g.key, g]));

function projectDir(slug) {
  return join(paths.projectsDir, slug);
}
function statePath(slug) {
  return join(projectDir(slug), 'state.json');
}
function docPath(slug) {
  return join(projectDir(slug), 'PROJECT.md');
}

export function open({ name, goal, deadline = '', deliverable = '', stakes = '' }) {
  const cleanName = String(name ?? '').trim();
  if (cleanName === '') throw new Error('jarvis_project(action="open") 需要 name。');
  const slug = slugify(cleanName, `project-${localDate()}`);
  const file = statePath(slug);
  const existing = readJson(file, null);
  if (existing) {
    return { created: false, slug, state: existing, next: currentGatePrompt(existing) };
  }
  const state = {
    slug,
    name: cleanName,
    goal: String(goal ?? ''),
    deadline: String(deadline ?? ''),
    deliverable: String(deliverable ?? ''),
    stakes: String(stakes ?? ''),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    gate: 1,
    gates: {},
    wbs: [],
    progress: [],
    reports: [],
    consent: false,
    innovation: '',
    closed: false,
  };
  ensureDir(projectDir(slug));
  save(state);
  return { created: true, slug, state, next: currentGatePrompt(state) };
}

function save(state) {
  state.updatedAt = nowIso();
  writeJson(statePath(state.slug), state);
  writeText(docPath(state.slug), renderDoc(state));
  return state;
}

/** 没写 name（或写成字符串 "undefined"）时的回落：只有一个未关闭项目就用它；有多个就要求写明。 */
export function resolveName(name) {
  const raw = String(name ?? '').trim();
  if (raw !== '' && raw !== 'undefined' && raw !== 'null') return raw;
  const openRows = list().filter((r) => !r.closed);
  if (openRows.length === 1) return openRows[0].slug;
  if (openRows.length === 0) {
    throw new Error('还没有未关闭的项目。用 jarvis_project(action="open", name="…", goal="…") 先立项。');
  }
  throw new Error(
    `有 ${openRows.length} 个未关闭的项目，必须写明 name：${openRows.map((r) => `${r.name}（${r.slug}）`).join('、')}。`,
  );
}

export function load(name) {
  const slug = slugify(resolveName(name));
  const state = readJson(statePath(slug), null);
  if (!state) throw new Error(`找不到项目 "${name}"。用 jarvis_project(action="list") 看现有项目，或 action="open" 新建。`);
  return state;
}

/** 记录一道闸门的产出。跳跃闸门会被拒绝。 */
export function record({ name, gate, content, userKnowledge = '', tools = [], consent = false, innovation = '' }) {
  const state = load(name);
  if (state.closed) throw new Error(`项目 "${state.name}" 已关闭，无法继续记录。`);
  const g = resolveGate(gate);
  if (g.id > state.gate + 1) {
    throw new Error(
      `闸门不可跳跃：当前在第 ${state.gate} 道（${gateName(state.gate)}），不能直接记录第 ${g.id} 道（${g.name}）。先完成中间闸门。`,
    );
  }
  const body = String(content ?? '').trim();
  if (body === '') throw new Error(`记录第 ${g.id} 道闸门需要 content。`);

  state.gates[g.key] = { at: nowIso(), content: body, userKnowledge: String(userKnowledge ?? ''), tools: arr(tools) };
  if (g.key === 'gap') {
    state.consent = consent === true;
    state.gates.gap.consent = state.consent;
  }
  if (g.key === 'plan') {
    state.innovation = String(innovation ?? state.innovation ?? '');
    state.gates.plan.innovation = state.innovation;
  }
  state.gate = Math.max(state.gate, Math.min(GATES.length, g.id + 1));
  if (g.id === GATES.length) state.gate = GATES.length;
  save(state);
  return { slug: state.slug, gate: state.gate, recorded: g.key, consent: state.consent, next: currentGatePrompt(state) };
}

function arr(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim() !== '') return v.split(/[,，;；\n]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

export function resolveGate(gate) {
  if (typeof gate === 'number') {
    const byId = GATES.find((g) => g.id === gate);
    if (byId) return byId;
  }
  const key = String(gate ?? '').trim();
  if (GATE_INDEX[key]) return GATE_INDEX[key];
  const byName = GATES.find((g) => g.name === key);
  if (byName) return byName;
  for (const g of GATES) {
    if (key !== '' && (g.name.includes(key) || key.includes(g.name))) return g;
  }
  throw new Error(`未知闸门 "${gate}"。可用：1 restate / 2 inventory / 3 gap / 4 plan / 5 execute（也可写中文名）。`);
}

export function gateName(id) {
  return GATES.find((g) => g.id === id)?.name ?? `#${id}`;
}

/** 下一件该做的事——这就是"一问一答"里 Jarvis 该说的话。 */
export function currentGatePrompt(state) {
  if (state.closed) return { gate: null, done: true, ask: `项目「${state.name}」已关闭。` };
  const g = GATES.find((x) => x.id === state.gate) ?? GATES[GATES.length - 1];
  const blockers = [];
  if (g.key === 'execute' && state.wbs.length === 0) {
    blockers.push('第 4 道闸门还没有给出 WBS（小项拆分 + 验收判据）。用 jarvis_project(action="wbs") 设置后再开工。');
  }
  if (g.key === 'execute' && !state.consent) {
    blockers.push('第 3 道闸门没有拿到用户同意（consent）。必须先问"讲清楚了吗？可以开始了吗？"并得到同意。');
  }
  return { gate: g.id, gateKey: g.key, gateName: g.name, ask: g.ask, require: g.require, blockers };
}

// --- WBS 与执行 ------------------------------------------------------------

export function setWbs({ name, items }) {
  const state = load(name);
  if (state.closed) throw new Error(`项目 "${state.name}" 已关闭，无法改 WBS。`);
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) throw new Error('jarvis_project(action="wbs") 需要非空的 items 数组。');
  state.wbs = list.map((it, i) => {
    const o = typeof it === 'string' ? { title: it } : (it ?? {});
    return {
      id: o.id || `w${i + 1}`,
      title: String(o.title ?? `小项 ${i + 1}`),
      acceptance: arr(o.acceptance),
      est: String(o.est ?? ''),
      status: o.status === 'done' ? 'done' : 'todo',
      evidence: String(o.evidence ?? ''),
    };
  });
  save(state);
  return { slug: state.slug, count: state.wbs.length, wbs: state.wbs };
}

/**
 * 推进一个小项。要求带证据：`done` 但没有 evidence 会被拒绝——
 * 这是"不许把'我做完了'当汇报"这条规则的代码化。
 */
export function progressItem({ name, item, status = 'done', evidence = '', report = '', selfCheck = '', thirdParty = '', risk = '', next = '' }) {
  const state = load(name);
  if (state.closed) throw new Error(`项目 "${state.name}" 已关闭，无法推进小项。`);
  const target = findItem(state, item);
  const st = String(status);
  if (st === 'done' && String(evidence).trim() === '') {
    throw new Error('把小项标记为 done 必须给 evidence（改了什么文件 / 跑了什么命令 / 得到什么结果）。没有证据的"完成"不算完成。');
  }
  target.status = st === 'done' ? 'done' : st === 'doing' ? 'doing' : 'todo';
  if (evidence) target.evidence = String(evidence);
  const entry = {
    at: nowIso(),
    item: target.id,
    title: target.title,
    status: target.status,
    evidence: String(evidence),
    selfCheck: String(selfCheck),
    thirdParty: String(thirdParty),
    risk: String(risk),
    next: String(next),
  };
  state.progress.push(entry);
  if (String(report).trim() !== '') state.reports.push({ at: entry.at, item: target.id, text: String(report) });

  // 反脆弱：把当前状态落成可恢复的 STATE.md（压缩上下文后靠它接上）。
  state.stateMd = renderStateMd(state);
  writeText(join(projectDir(state.slug), 'STATE.md'), state.stateMd);
  save(state);
  return { slug: state.slug, item: target.id, status: target.status, remaining: state.wbs.filter((w) => w.status !== 'done').length };
}

function findItem(state, item) {
  const key = String(item ?? '').trim();
  const found = state.wbs.find((w) => w.id === key) ?? state.wbs.find((w) => w.title === key) ?? state.wbs.find((w) => key !== '' && w.title.includes(key));
  if (!found) throw new Error(`项目里找不到小项 "${item}"。用 jarvis_project(action="status") 看 WBS 列表。`);
  return found;
}

export function status({ name }) {
  const state = load(name);
  const done = state.wbs.filter((w) => w.status === 'done').length;
  return {
    slug: state.slug,
    name: state.name,
    goal: state.goal,
    deadline: state.deadline,
    gate: state.gate,
    gateName: gateName(state.gate),
    consent: state.consent,
    innovation: state.innovation,
    wbsTotal: state.wbs.length,
    wbsDone: done,
    next: currentGatePrompt(state),
    openItems: state.wbs.filter((w) => w.status !== 'done').map((w) => ({ id: w.id, title: w.title, acceptance: w.acceptance })),
    lastReport: state.reports.at(-1) ?? null,
    docPath: docPath(state.slug),
    statePath: statePath(state.slug),
  };
}

export function list() {
  const out = [];
  for (const d of listDirs(paths.projectsDir)) {
    const st = readJson(join(d.path, 'state.json'), null);
    if (!st) continue;
    out.push({
      slug: st.slug ?? d.name,
      name: st.name ?? d.name,
      gate: st.gate,
      gateName: gateName(st.gate),
      wbsDone: (st.wbs ?? []).filter((w) => w.status === 'done').length,
      wbsTotal: (st.wbs ?? []).length,
      closed: st.closed === true,
      updatedAt: st.updatedAt ?? '',
    });
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function close({ name, outcome = '', followUp = '' }) {
  const state = load(name);
  state.closed = true;
  state.outcome = String(outcome);
  state.followUp = String(followUp);
  state.closedAt = nowIso();
  save(state);
  return { slug: state.slug, closed: true, outcome: state.outcome, docPath: docPath(state.slug) };
}

// --- 渲染 ------------------------------------------------------------------

function renderDoc(state) {
  const lines = [
    `# ${state.name}`,
    '',
    `- slug：\`${state.slug}\``,
    `- 目标：${state.goal || '（未填）'}`,
    `- 交付物：${state.deliverable || '（未填）'}`,
    `- 截止：${state.deadline || '（未填）'}`,
    `- 建立：${state.createdAt}`,
    `- 当前闸门：第 ${state.gate} 道 · ${gateName(state.gate)}`,
    '',
    '---',
    '',
  ];
  for (const g of GATES) {
    const rec = state.gates?.[g.key];
    lines.push(`## 闸门 ${g.id} · ${g.name}${rec ? ` ✅ ${rec.at}` : ' ⬜ 未完成'}`);
    lines.push('');
    if (rec) {
      lines.push(rec.content);
      if (rec.userKnowledge) lines.push('', `**用户已掌握**：${rec.userKnowledge}`);
      if (rec.tools?.length) lines.push('', `**技能/工具**：${rec.tools.join(' / ')}`);
      if (g.key === 'gap') lines.push('', `**用户同意开工**：${rec.consent ? '是' : '否'}`);
      if (g.key === 'plan' && state.innovation) lines.push('', `**创新档位**：${state.innovation}`);
    } else {
      lines.push('（待完成）');
    }
    lines.push('');
  }
  if (state.wbs?.length) {
    lines.push('## WBS 与进度');
    lines.push('');
    lines.push('| ID | 小项 | 验收判据 | 预估 | 状态 | 证据 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const w of state.wbs) {
      lines.push(`| ${w.id} | ${w.title} | ${(w.acceptance ?? []).join('；')} | ${w.est} | ${w.status} | ${w.evidence} |`);
    }
    lines.push('');
  }
  if (state.reports?.length) {
    lines.push('## 汇报时间线');
    lines.push('');
    for (const r of state.reports) lines.push(`- ${r.at} · ${r.item}：${r.text}`);
    lines.push('');
  }
  if (state.outcome) lines.push('## 结论', '', state.outcome, '');
  if (state.followUp) lines.push('## 后续', '', state.followUp, '');
  return lines.join('\n');
}

function renderStateMd(state) {
  const done = state.wbs.filter((w) => w.status === 'done');
  const todo = state.wbs.filter((w) => w.status !== 'done');
  return [
    `# STATE · ${state.name}`,
    '',
    `> 自动生成于 ${nowIso()}。用途：上下文被压缩后，靠这个文件无损恢复项目状态。`,
    '',
    `- 当前闸门：第 ${state.gate} 道 · ${gateName(state.gate)}`,
    `- 用户同意开工：${state.consent ? '是' : '否'}`,
    `- 创新档位：${state.innovation || '（未定）'}`,
    '',
    `## 已完成（${done.length}）`,
    ...done.map((w) => `- [x] ${w.id} ${w.title} — 证据：${w.evidence}`),
    '',
    `## 待完成（${todo.length}）`,
    ...todo.map((w) => `- [ ] ${w.id} ${w.title} — 验收：${(w.acceptance ?? []).join('；')}`),
    '',
    '## 最近一次汇报',
    state.reports.at(-1) ? `- ${state.reports.at(-1).at}：${state.reports.at(-1).text}` : '- （无）',
    '',
    '## 待决问题',
    ...(state.openQuestions ?? []).map((q) => `- ${q}`),
    (state.openQuestions ?? []).length === 0 ? '- （无）' : '',
    '',
  ].join('\n');
}

export function readDoc(name) {
  const state = load(name);
  return readText(docPath(state.slug), '(文档尚未生成)');
}
