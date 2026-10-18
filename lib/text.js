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

/**
 * CJK 停用字（v0.3 · 3.4）。
 *
 * 为什么需要：中文里「的/是/不/在/有/了」这六个字几乎出现在每一句里。只把
 * 单字权重调低还不够——二元组会把这些字拼起来，于是「的是」「不在」「有了」
 * 成了检索词。实测证据：memory/facts.jsonl 里一句「用户关注的是」，让纯虚词
 * 查询 `的 是 不 在 有 了` 真的匹配上了一条无关记录。
 *
 * 两条规则：
 *   1. 停用字**不单独作为词**（单字直接丢）；
 *   2. 二元组**只在两个字都是停用字时**才丢。
 *
 * 规则 2 的边界很重要：`得分`（得=停用，分≠）保留、`有效`（有=停用，效≠）保留，
 * 只有 `的是`/`不在`/`有了` 这种纯功能字组合才丢。宁可留噪声，不可误杀实词。
 */
const STOP_CJK = new Set(
  '的了是不在有和与或这那么就也都很更最我你他她它吗呢吧啊把被让给对从到及并且但着过地得之其'.split(''),
);

export function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  for (const m of s.matchAll(LATIN_RE)) {
    if (m[0].length >= 2 && !STOP.has(m[0])) out.push(m[0]);
  }
  const cjk = s.match(CJK_RE) ?? [];
  for (const ch of cjk) {
    if (!STOP_CJK.has(ch)) out.push(ch);
  }
  for (let i = 0; i + 1 < cjk.length; i += 1) {
    const a = cjk[i];
    const b = cjk[i + 1];
    if (STOP_CJK.has(a) && STOP_CJK.has(b)) continue;
    out.push(`${a}${b}`);
  }
  return out;
}

export function termSet(text) {
  const set = new Map();
  for (const t of tokenize(text)) set.set(t, (set.get(t) ?? 0) + 1);
  return set;
}

/**
 * 重叠打分。
 *
 * 规则一：CJK 单字权重低（噪声大），二元组与拉丁词权重高。
 * 规则二（v0.3 · 3.4）：**查询里有"强词"（长度 ≥2）时，单字一律不计分。**
 *
 * 规则二修的是一个真缺陷（2026-10-18 由检索基准抓出来）：中文里「的/是/不/在」
 * 几乎出现在每条记录里，而单字权重 0.35 不算小，于是一句毫无意义的虚词查询
 * 也能"匹配上"一大片，并被标成 global。这不是幻觉，是打分太松。
 *
 * 保留单字的唯一理由：单字查询（如「累」）本身没有二元组可用。所以只有在
 * 整个查询都没有强词时才启用单字计分——那时它至少不会把噪声放大到全体。
 *
 * 归一化到 0..1（除以参与计分的查询权重和）。
 */
export function score(queryTerms, docTerms) {
  if (queryTerms.size === 0 || docTerms.size === 0) return 0;
  const hasStrong = [...queryTerms.keys()].some((t) => t.length >= 2);
  let hit = 0;
  let total = 0;
  for (const [term, qn] of queryTerms) {
    const isStrong = term.length >= 2;
    if (hasStrong && !isStrong) continue;
    const weight = isStrong ? 1 : 0.35;
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
