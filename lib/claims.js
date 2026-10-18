/**
 * dsh-jarvis — 纠错账本（幻觉账本）。
 *
 * 用户问的第二个统计问题：「什么时候发生幻觉」。
 *
 * 诚实的现状：**幻觉无法被自动统计。** 我只能在事后知道我说错了一句话，
 * 而且只有两种情况能知道——用户指出了，或者后续证据推翻了。没有第三种。
 * 所以这个账本故意做得很土：每次用户说「不对 / 不是这样 / 你编的」，
 * 就落一条记录。两周之后才有资格画一张「我最爱编什么」的表。
 *
 * 为什么值得记：人（和模型）对自己犯错类型的判断极不可靠。我若凭印象说
 * 「我很少编路径」，那本身就可能是编的；账本上的计数不会撒谎。
 *
 * 隐私：这里会存**原文**（用户的说法与我的原话），因为「我编了什么」
 * 脱离原文毫无价值。这跟埋点（telemetry.js）刻意不记原文是两件事，
 * 理由不同，别混。
 */

import { appendJsonl, localDate, nowIso, paths, readJsonl, rewriteJsonl, shortHash } from './store.js';

/** 幻觉分类。分类的价值在于：不同类的治法是不同的。 */
export const CLAIM_KINDS = ['path', 'api', 'number', 'literature', 'date', 'fact', 'logic', 'other'];

export const CLAIM_LABELS = {
  path: '文件路径 / 行号',
  api: 'API / 函数签名',
  number: '数字 / 指标',
  literature: '文献 / 作者 / 年份',
  date: '日期 / 时间',
  fact: '一般事实',
  logic: '推理步骤',
  other: '其他',
};

/** 严重度：1 = 无害（措辞/无关紧要），2 = 会误导决策，3 = 会造成实际损失。 */
const MAX_TEXT = 2000;

function clip(s) {
  const t = String(s ?? '').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

export function record({ claim, truth = '', evidence = '', kind = 'fact', severity = 2, source = 'user-correction' } = {}) {
  const body = clip(claim);
  if (body === '') throw new Error('jarvis_correction(action="record") 需要 claim：我原本说错了什么。');
  const k = CLAIM_KINDS.includes(kind) ? kind : 'other';
  const sev = Math.max(1, Math.min(3, Math.round(Number(severity) || 2)));
  const at = nowIso();
  const rec = {
    id: `${localDate()}-${shortHash(`${body}${at}`)}`,
    at,
    kind: k,
    severity: sev,
    claim: body,
    truth: clip(truth),
    evidence: clip(evidence),
    source: String(source ?? 'user-correction'),
    /** 待核实 / 已确认 / 已推翻——不加这个字段，账本会变成谣言汇总。 */
    status: 'confirmed',
  };
  appendJsonl(paths.claims, rec);
  return rec;
}

export function list({ limit = 30, kind = 'all', severity = 0 } = {}) {
  let rows = [];
  try {
    rows = readJsonl(paths.claims);
  } catch {
    rows = [];
  }
  if (CLAIM_KINDS.includes(kind)) rows = rows.filter((r) => r.kind === kind);
  if (Number(severity) > 0) rows = rows.filter((r) => Number(r.severity) >= Number(severity));
  return rows
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 30)));
}

/**
 * 统计。`leaderboard` 才是真正的 deliverables——一张「我最容易在哪类事上编」的表。
 */
export function stats({ days = 0 } = {}) {
  let rows = [];
  try {
    rows = readJsonl(paths.claims);
  } catch {
    rows = [];
  }
  const window = Number(days) || 0;
  if (window > 0) {
    const since = Date.now() - window * 86400000;
    rows = rows.filter((r) => Number.isFinite(Date.parse(r?.at ?? '')) && Date.parse(r.at) >= since);
  }

  const byKind = {};
  const bySeverity = { 1: 0, 2: 0, 3: 0 };
  for (const r of rows) {
    byKind[r.kind ?? 'other'] = (byKind[r.kind ?? 'other'] ?? 0) + 1;
    const s = Math.max(1, Math.min(3, Number(r.severity) || 2));
    bySeverity[s] += 1;
  }
  const leaderboard = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => ({ kind, label: CLAIM_LABELS[kind] ?? kind, count }));

  const total = rows.length;
  const top = leaderboard[0];
  return {
    total,
    windowDays: window || null,
    byKind,
    bySeverity,
    leaderboard,
    lastAt: total ? rows.reduce((m, r) => (String(r.at) > String(m) ? r.at : m), '') : null,
    note:
      total === 0
        ? '纠错账本还是空的。这不代表我没编过——只代表我编了但没被你发现，或者你发现了但我没记。前者比后者严重。'
        : `共 ${total} 条。最常出错的是「${top.label}」${top.count} 次，占 ${Math.round((top.count / total) * 100)}%。` +
          `严重度 3（会造成实际损失）${bySeverity[3]} 条——这几条单独看，值得回看原文。`,
  };
}

/** 删除一条（记错了/重复记账）。同步重写，store.writeText 已是原子写。 */
export function drop({ id = '' } = {}) {
  const target = String(id ?? '');
  if (target === '') return { removed: 0, note: '需要 id。' };
  let rows = [];
  try {
    rows = readJsonl(paths.claims);
  } catch {
    return { removed: 0, note: '读不到账本文件。' };
  }
  const keep = rows.filter((r) => r.id !== target);
  const removed = rows.length - keep.length;
  if (removed > 0) rewriteJsonl(paths.claims, keep);
  return { removed };
}
