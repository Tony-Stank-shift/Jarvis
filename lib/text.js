/**
 * dsh-jarvis — 文本检索原语。
 *
 * 中文没有空格分词，所以这里用"拉丁词 + CJK 单字 + CJK 二元组"的混合切分，
 * 再做重叠打分。它不是向量检索，但对"翻自己的笔记找一段话"这个场景足够准，
 * 而且零依赖、可解释、离线可跑。v0.3 会在此之上加本地嵌入 + 重排。
 */

const LATIN_RE = /[a-z0-9][a-z0-9_+.#-]*/g;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/** 停用词：只对拉丁词生效。 */
const STOP = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'is', 'are', 'was',
  'for', 'with', 'that', 'this', 'it', 'be', 'as', 'by', 'at', 'from',
]);

export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  for (const m of s.matchAll(LATIN_RE)) {
    if (m[0].length >= 2 && !STOP.has(m[0])) out.push(m[0]);
  }
  const cjk = s.match(CJK_RE) ?? [];
  for (const ch of cjk) out.push(ch);
  for (let i = 0; i + 1 < cjk.length; i += 1) out.push(`${cjk[i]}${cjk[i + 1]}`);
  return out;
}

export function termSet(text) {
  const set = new Map();
  for (const t of tokenize(text)) set.set(t, (set.get(t) ?? 0) + 1);
  return set;
}

/**
 * 重叠打分。
 * - CJK 单字权重低（噪声大），二元组与拉丁词权重高。
 * - 归一化到 0..1（除以查询词数），便于跨条目比较。
 */
export function score(queryTerms, docTerms) {
  if (queryTerms.size === 0 || docTerms.size === 0) return 0;
  let hit = 0;
  let total = 0;
  for (const [term, qn] of queryTerms) {
    const weight = term.length >= 2 ? 1 : 0.35;
    total += weight * qn;
    if (docTerms.has(term)) {
      const dn = docTerms.get(term);
      hit += weight * Math.min(qn, dn);
    }
  }
  return total === 0 ? 0 : hit / total;
}

/** 命中词列表（用于在 excerpt 里高亮 / 展示依据）。 */
export function matchedTerms(queryTerms, docTerms) {
  const out = [];
  for (const term of queryTerms.keys()) {
    if (docTerms.has(term) && term.length >= 2) out.push(term);
  }
  return out.slice(0, 12);
}

export function excerpt(text, queryTerms, radius = 220) {
  const s = String(text ?? '');
  if (s.length <= radius * 2) return s.trim();
  const lower = s.toLowerCase();
  let best = -1;
  for (const term of queryTerms.keys()) {
    if (term.length < 2) continue;
    const idx = lower.indexOf(term);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  if (best < 0) return `${s.slice(0, radius * 2).trim()}…`;
  const start = Math.max(0, best - radius);
  const end = Math.min(s.length, best + radius);
  return `${start > 0 ? '…' : ''}${s.slice(start, end).trim()}${end < s.length ? '…' : ''}`;
}

/** 粗估 token 数（CJK 约 1 token/字，拉丁约 1 token/4 字符）。用于压缩阈值判断。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  const cjk = (s.match(CJK_RE) ?? []).length;
  const rest = s.length - cjk;
  return Math.round(cjk + rest / 4);
}
