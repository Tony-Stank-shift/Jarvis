/**
 * dsh-jarvis — 双轨记忆。
 *
 * 事实记忆（facts）：稳定、可复用、会被反复引用 → 长期有效，带置信度与来源。
 * 情节记忆（episodes）：某次对话/某天发生了什么 → 时间线，会过期。
 *
 * 分开的理由：把"用户不喜欢写作业"和"今天他说有点累"混在一个池子里，
 * 检索时会互相污染——前者该常驻影响判断，后者只该在恰当的时候被翻出来。
 */

import {
  appendJsonl,
  nowIso,
  paths,
  readJsonl,
  rewriteJsonl,
  shortHash,
  localDate,
} from './store.js';
import { excerpt, matchedTerms, score, termSet } from './text.js';

export const KINDS = ['fact', 'episode'];

function fileFor(kind) {
  return kind === 'episode' ? paths.episodes : paths.facts;
}

export function remember({ kind = 'fact', text, tags = [], source = 'conversation', confidence = 0.8, at = null }) {
  const k = KINDS.includes(kind) ? kind : 'fact';
  const body = String(text ?? '').trim();
  if (body === '') throw new Error('jarvis_memory(action="remember") 需要非空的 text。');
  const record = {
    id: `${localDate()}-${shortHash(`${body}${nowIso()}`)}`,
    at: at ?? nowIso(),
    kind: k,
    text: body,
    tags: normalizeTags(tags),
    source,
    confidence: clamp01(confidence),
  };
  appendJsonl(fileFor(k), record);
  return record;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.8;
  return Math.max(0, Math.min(1, n));
}

function normalizeTags(tags) {
  const arr = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,，;；\s]+/) : [];
  return [...new Set(arr.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
}

export function list({ kind = 'all', limit = 50 } = {}) {
  const kinds = kind === 'all' || !KINDS.includes(kind) ? KINDS : [kind];
  const out = [];
  for (const k of kinds) {
    for (const r of readJsonl(fileFor(k))) out.push({ ...r, kind: r.kind ?? k });
  }
  out.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return out.slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
}

/**
 * 检索。打分 = 文本重叠 × 时间衰减 × 置信度。
 * 时间衰减对 episode 更狠（情节记忆过期快），对 fact 很轻（事实长期有效）。
 */
export function recall({ query = '', kind = 'all', limit = 8, tags = [] } = {}) {
  const rows = listAll(kind);
  const q = termSet([query, ...normalizeTags(tags)].join(' '));
  if (q.size === 0) return rows.slice(0, limit).map((r) => ({ ...r, score: 0, matched: [] }));
  const now = Date.now();
  const scored = rows.map((r) => {
    const doc = termSet(`${r.text} ${(r.tags ?? []).join(' ')}`);
    const base = score(q, doc);
    const ageDays = Math.max(0, (now - Date.parse(r.at ?? nowIso())) / 86400000);
    const halfLife = r.kind === 'episode' ? 45 : 900;
    const decay = 0.5 ** (ageDays / halfLife);
    const conf = Number.isFinite(r.confidence) ? r.confidence : 0.8;
    return {
      ...r,
      score: Number((base * (0.55 + 0.45 * decay) * (0.6 + 0.4 * conf)).toFixed(4)),
      matched: matchedTerms(q, doc),
      excerpt: excerpt(r.text, q, 160),
    };
  });
  scored.sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)));
  const kept = scored.filter((r) => r.score > 0);
  return (kept.length > 0 ? kept : scored).slice(0, Math.max(1, Math.min(50, Number(limit) || 8)));
}

function listAll(kind) {
  const kinds = kind === 'all' || !KINDS.includes(kind) ? KINDS : [kind];
  const out = [];
  for (const k of kinds) for (const r of readJsonl(fileFor(k))) out.push({ ...r, kind: r.kind ?? k });
  return out;
}

/** 按 id 或子串删除；返回被删条数。 */
export function forget({ id = '', query = '', kind = 'all' } = {}) {
  const kinds = kind === 'all' || !KINDS.includes(kind) ? KINDS : [kind];
  let removed = 0;
  const removedIds = [];
  for (const k of kinds) {
    const rows = readJsonl(fileFor(k));
    const keep = [];
    for (const r of rows) {
      const hitById = id !== '' && r.id === id;
      const hitByQuery = id === '' && query !== '' && String(r.text ?? '').includes(query);
      if (hitById || hitByQuery) {
        removed += 1;
        removedIds.push(r.id);
      } else {
        keep.push(r);
      }
    }
    if (keep.length !== rows.length) rewriteJsonl(fileFor(k), keep);
  }
  return { removed, removedIds };
}

export function stats() {
  const facts = readJsonl(paths.facts);
  const episodes = readJsonl(paths.episodes);
  const last = [...facts, ...episodes].sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] ?? null;
  return {
    facts: facts.length,
    episodes: episodes.length,
    lastAt: last?.at ?? null,
    tags: topTags([...facts, ...episodes]),
  };
}

function topTags(rows) {
  const counts = new Map();
  for (const r of rows) for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag, count]) => ({ tag, count }));
}
