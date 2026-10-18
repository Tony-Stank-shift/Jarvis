/**
 * dsh-jarvis — 每日情报流水线（R4 的一半）。
 *
 * 目标：每天尽可能多地了解 **AI / AI4S / 具身智能** 三个大领域的近期进展，
 * 按用户的兴趣向量排序，落到本地知识库，周报强制挂钩四条战线。
 *
 * 三个判断，都写死在代码里而不是靠提示词：
 * 1. **有目的性地搜**：只抓 arXiv 的 cs.AI / cs.LG / cs.CL / cs.RO + AI-for-Science
 *    关键词，以及 HF Daily Papers。不做"泛泛浏览"。
 * 2. **按兴趣向量打分**：用户偏好数学直觉与定理主线，不是工程调参。所以
 *    "theorem / convergence / generalization bound / 几何拓扑" 加权，
 *    "我们又刷了 SOTA / 调参技巧" 降权。
 * 3. **绝不无源引用**：每条情报都带 arXiv id / HF 链接，写进 Markdown，
 *    引用时给出文件路径 + 行号。
 */

import { join } from 'node:path';
import { appendJsonl, ensureDir, fileIsFile, localDate, nowIso, paths, writeText, readJsonl, readText, listFiles } from './store.js';
import { paths as P } from './store.js';

export const INTERESTS = ['AI', 'AI4S', '具身智能'];

const UA = { 'user-agent': 'dsh-jarvis-intel/0.1 (+local research digest)' };

// ---------------------------------------------------------------------------
// 源与退避（v0.2 · 2.1）
// ---------------------------------------------------------------------------
//
// 选择依据不是"哪个源最强"，而是**2026-10-17 实测哪个源能用**：
//   OpenAlex  api.openalex.org   200 / 1229ms   → 主力新增（全学科 + 被引数 + 无 key）
//   Crossref  api.crossref.org   200 / 1362ms   → 补已发表期刊会议（无 key）
//   S2        api.semanticscholar.org  429（第一次请求就限流）→ **不用**
//   DBLP      dblp.org/search    202（语义不明，非正常 200）→ **不用**
//
// "摆脱 429"的正确解法不是把会 429 的源硬扛进来，而是只接稳定的源；
// 然后把退避做到位，让偶发限流变成"慢一点"而不是"整次失败"。
//
// polite pool：OpenAlex / Crossref 都支持带 mailto 进更快的一档配额。
// **邮箱从 config.json 读，绝不写死在代码里**——本插件要推到公开仓库，
// 硬编码邮箱等于把个人信息发到公网（这个坑之前踩过，见 scrubbing 脚本）。

/** 源健康度流水。每次抓取一条，用来回答"是我不行还是源不行"。 */
const HEALTH_FILE = join(paths.intelDir, '_sources.jsonl');

export function logSource(entry = {}) {
  try {
    ensureDir(paths.intelDir);
    appendJsonl(HEALTH_FILE, { at: nowIso(), ...entry });
  } catch {
    /* 健康度记录失败绝不能影响抓取 */
  }
}

/**
 * 按源聚合最近 N 天健康度。
 * 输出里的 `verdict` 是给人看的一句话——"哪个源该放弃了"要能一眼看出来。
 */
export function sourceHealth({ days = 14 } = {}) {
  const window = Math.max(1, Math.min(365, Number(days) || 14));
  const since = Date.now() - window * 86400000;
  let rows = [];
  try {
    rows = readJsonl(HEALTH_FILE).filter((r) => {
      const t = Date.parse(r?.at ?? '');
      return Number.isFinite(t) && t >= since;
    });
  } catch {
    rows = [];
  }
  const bySource = new Map();
  for (const r of rows) {
    const k = String(r.source ?? 'unknown');
    if (!bySource.has(k)) bySource.set(k, { source: k, runs: 0, ok: 0, fail: 0, items: 0, latencySum: 0, latencyN: 0, lastAt: null, lastStatus: null, lastError: null });
    const s = bySource.get(k);
    s.runs += 1;
    if (r.ok) s.ok += 1;
    else s.fail += 1;
    s.items += Number(r.count) || 0;
    // 必须用 typeof 判类型：Number(null) === 0 且 Number.isFinite(0) 为真，
    // 于是"源挂掉了、根本没有延迟"会被算成"0ms、最快"。这种指标比没有指标更坏。
    if (typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs)) {
      s.latencySum += r.latencyMs;
      s.latencyN += 1;
    }
    if (!s.lastAt || String(r.at) > s.lastAt) {
      s.lastAt = r.at;
      s.lastStatus = r.status ?? null;
      s.lastError = r.error ?? null;
    }
  }
  const list = [...bySource.values()].map((s) => {
    // 不能用 `latencySum: undefined` 来"删字段"：DSH 要求工具返回值可无损
    // 转成 JSON（lossless JSON），显式 undefined 属性会让整次调用报
    // `returned invalid output: value is not lossless JSON`。
    // 2026-10-17 实测踩过：日报文件已经写好了，工具却返回失败，白跑一整轮抓取。
    const { latencySum, latencyN, ...rest } = s;
    return {
      ...rest,
      okRate: s.runs > 0 ? Number((s.ok / s.runs).toFixed(2)) : null,
      avgLatencyMs: latencyN > 0 ? Math.round(latencySum / latencyN) : null,
    };
  });
  const dead = list.filter((s) => s.runs >= 3 && s.okRate === 0);
  return {
    windowDays: window,
    sources: list,
    verdict:
      list.length === 0
        ? '还没有任何源健康度记录（第一次抓取之后才会有）。'
        : dead.length > 0
          ? `这些源最近 ${window} 天连续失败，考虑去掉：${dead.map((s) => `${s.source}（${s.lastStatus ?? s.lastError ?? '失败'}）`).join('、')}`
          : `最近 ${window} 天各源都有成功记录；最慢的是 ${[...list].sort((a, b) => (b.avgLatencyMs ?? 0) - (a.avgLatencyMs ?? 0))[0]?.source ?? 'n/a'}。`,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * 带指数退避的 JSON 抓取。
 *
 * 只对**值得重试**的失败重试：429（限流）、5xx、网络错误/超时。
 * 404 / 400 这类重试一百次也一样，直接返回失败——重试不是万能的，
 * 对确定性失败重试只是浪费用户的时间。
 *
 * `fetchImpl` 可注入，这样冒烟测试能在完全离线的环境里验证退避逻辑
 * （不用假装网络可用，也不用真的打网络）。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=20000]
 * @param {number} [opts.retries=2]        最多重试次数（总请求数 = retries + 1）
 * @param {number} [opts.baseBackoffMs=800] 退避基数：800 → 1600 → 3200
 * @param {object} [opts.headers]
 * @param {function} [opts.fetchImpl]
 */
export async function getJson(url, opts = {}) {
  const {
    timeoutMs = 20000,
    retries = 2,
    baseBackoffMs = 800,
    headers = {},
    fetchImpl = globalThis.fetch,
  } = opts;
  const startedAll = Date.now();
  let last = { ok: false, status: null, error: '未执行', attempts: 0, latencyMs: 0 };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { headers: { ...UA, ...headers }, signal: ac.signal, redirect: 'follow' });
    } catch (e) {
      clearTimeout(timer);
      const timedOut = e?.name === 'AbortError';
      last = {
        ok: false,
        status: null,
        error: timedOut ? `超时（${timeoutMs}ms）` : `网络错误：${e?.message ?? e}`,
        attempts: attempt + 1,
        latencyMs: Date.now() - t0,
        retryable: true,
      };
      if (attempt < retries) {
        await sleep(baseBackoffMs * 2 ** attempt);
        continue;
      }
      break;
    }
    clearTimeout(timer);

    // 限流与 5xx 值得重试
    if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseBackoffMs * 2 ** attempt;
      last = {
        ok: false,
        status: res.status,
        error: res.status === 429 ? `HTTP 429 限流（第 ${attempt + 1} 次）` : `HTTP ${res.status} 服务端错误`,
        attempts: attempt + 1,
        latencyMs: Date.now() - t0,
        retryable: true,
        waitedMs: waitMs,
      };
      if (attempt < retries) {
        await sleep(waitMs);
        continue;
      }
      break;
    }

    if (!res.ok) {
      last = { ok: false, status: res.status, error: `HTTP ${res.status}`, attempts: attempt + 1, latencyMs: Date.now() - t0, retryable: false };
      break;
    }

    let text;
    try {
      text = await res.text();
    } catch (e) {
      last = { ok: false, status: res.status, error: `读响应失败：${e?.message ?? e}`, attempts: attempt + 1, latencyMs: Date.now() - t0, retryable: true };
      if (attempt < retries) {
        await sleep(baseBackoffMs * 2 ** attempt);
        continue;
      }
      break;
    }
    if (!res.ok) return last;
    last = { ok: true, status: res.status, error: null, attempts: attempt + 1, latencyMs: Date.now() - t0, text };
    break;
  }

  // 收尾：把 JSON 解析留在成功路径上，解析失败也算失败（源返回了 HTML 错误页这类）
  if (last.ok) {
    try {
      last.json = JSON.parse(last.text);
    } catch {
      return { ...last, ok: false, error: '响应不是合法 JSON' };
    }
  }
  last.totalLatencyMs = Date.now() - startedAll;
  return last;
}

/** OpenAlex 的摘要用倒排索引（word → 位置列表）存，得拼回正常顺序。 */
export function openAlexAbstract(inverted) {
  if (!inverted || typeof inverted !== 'object') return '';
  const pairs = [];
  for (const [word, positions] of Object.entries(inverted)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) if (Number.isFinite(p)) pairs.push([p, word]);
  }
  return pairs.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(' ');
}

function pickDate(s) {
  const t = String(s ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
}

/**
 * 日期合理性检查。格式对不代表内容对。
 *
 * 实测：Crossref 给出 2121-02-01，OpenAlex 给出 2031-01-01 / 2045-12-10，
 * 全是元数据错误。这类值进排序会直接毁掉整份日报，所以**宁可丢掉日期**
 * （当作"未知"，freshness 走中性值）也不接受明显不合理的值。
 */
function saneDate(s) {
  const t = pickDate(s);
  if (t === '') return '';
  const y = Number(t.slice(0, 4));
  const nowY = new Date().getFullYear();
  if (!Number.isFinite(y) || y < 1900 || y > nowY + 1) return '';
  return t;
}

/** OpenAlex：全学科、带被引数。用于补 arXiv 覆盖不到的期刊/会议。 */
export async function fetchOpenAlex({ queries = ['machine learning', 'embodied intelligence'], sinceDays = 7, perQuery = 25, timeoutMs = 20000, mailto = '', fetchImpl } = {}) {
  const since = localDate(new Date(Date.now() - Math.max(1, sinceDays) * 86400000));
  const items = [];
  const meta = { source: 'openalex', status: null, error: null, count: 0, requests: 0 };
  for (const q of queries) {
    const params = new URLSearchParams({
      search: q,
      filter: `from_publication_date:${since}`,
      sort: 'publication_date:desc',
      'per-page': String(Math.min(50, Math.max(1, perQuery))),
    });
    if (mailto) params.set('mailto', mailto);
    const url = `https://api.openalex.org/works?${params.toString()}`;
    const r = await getJson(url, { timeoutMs, fetchImpl });
    meta.requests += 1;
    if (!r.ok) {
      meta.status = r.status;
      meta.error = r.error;
      continue;
    }
    meta.status = r.status;
    const results = Array.isArray(r.json?.results) ? r.json.results : [];
    for (const w of results) {
      const doi = String(w.doi ?? '').replace(/^https?:\/\/doi\.org\//, '');
      items.push({
        source: 'openalex',
        id: String(w.id ?? '').replace(/^https?:\/\/openalex\.org\//, '') || doi,
        url: doi ? `https://doi.org/${doi}` : String(w.id ?? ''),
        title: String(w.display_name ?? '').trim(),
        summary: openAlexAbstract(w.abstract_inverted_index),
        publishedAt: saneDate(w.publication_date),
        authors: (w.authorships ?? []).map((a) => a?.author?.display_name).filter(Boolean).slice(0, 6),
        authorCount: (w.authorships ?? []).length,
        categories: [w?.primary_topic?.display_name].filter(Boolean),
        upvotes: Number(w.cited_by_count) || 0,
        query: q,
      });
    }
  }
  meta.count = items.length;
  return { items, meta };
}

/** Crossref：已发表的期刊/会议元数据。摘要常缺失，缺就不编。 */
export async function fetchCrossref({ queries = ['artificial intelligence'], sinceDays = 7, rows = 20, timeoutMs = 20000, mailto = '', fetchImpl } = {}) {
  const since = localDate(new Date(Date.now() - Math.max(1, sinceDays) * 86400000));
  const items = [];
  const meta = { source: 'crossref', status: null, error: null, count: 0, requests: 0 };
  for (const q of queries) {
    const params = new URLSearchParams({
      'query.bibliographic': q,
      filter: `from-pub-date:${since}`,
      rows: String(Math.min(50, Math.max(1, rows))),
      sort: 'published',
      order: 'desc',
    });
    if (mailto) params.set('mailto', mailto);
    const url = `https://api.crossref.org/works?${params.toString()}`;
    const r = await getJson(url, { timeoutMs, fetchImpl });
    meta.requests += 1;
    if (!r.ok) {
      meta.status = r.status;
      meta.error = r.error;
      continue;
    }
    meta.status = r.status;
    const results = Array.isArray(r.json?.message?.items) ? r.json.message.items : [];
    for (const w of results) {
      const title = Array.isArray(w.title) ? w.title[0] : w.title;
      const abstract = String(w.abstract ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const dateParts = w?.published?.['date-parts']?.[0] ?? w?.issued?.['date-parts']?.[0] ?? [];
      const iso = dateParts.length >= 3 ? `${dateParts[0]}-${String(dateParts[1]).padStart(2, '0')}-${String(dateParts[2]).padStart(2, '0')}` : '';
      items.push({
        source: 'crossref',
        id: String(w.DOI ?? ''),
        url: w.DOI ? `https://doi.org/${w.DOI}` : String(w.URL ?? ''),
        title: String(title ?? '').trim(),
        summary: abstract,
        publishedAt: saneDate(iso),
        authors: (w.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).slice(0, 6),
        authorCount: (w.author ?? []).length,
        categories: [w?.['container-title']?.[0]].filter(Boolean),
        upvotes: Number(w['is-referenced-by-count']) || 0,
        query: q,
      });
    }
  }
  meta.count = items.length;
  return { items, meta };
}

/** 兴趣向量：命中即加分。权重是我对"用户会觉得这条重要"的先验。 */
const POSITIVE = [
  { re: /theorem|lemma|proof|provabl|guarantee|convergence|bound\b|regret|identifiab/i, w: 3, tag: '理论/定理主线' },
  { re: /geometr|topolog|manifold|algebra|category theor|representation theor|spectral/i, w: 3, tag: '数学结构' },
  { re: /generaliz|scaling law|emergence|phase transition|information theor|entropy/i, w: 2.5, tag: '泛化/规模律' },
  { re: /foundation model|world model|pre-?train/i, w: 1.8, tag: '基座/世界模型' },
  { re: /embodied|robot|manipulat|locomotion|vla\b|vision-language-action|dexterous/i, w: 1.6, tag: '具身智能' },
  { re: /ai for science|scientific (discovery|machine learning)|protein|material|weather|climate|pde\b|molecul|quantum chem|biolog/i, w: 2, tag: 'AI4S' },
  { re: /survey|review|position paper|open problem/i, w: 1.4, tag: '综述/开放问题' },
  { re: /reinforcement learning|rlhf|reasoning|chain-?of-?thought|verifier/i, w: 1.2, tag: 'RL/推理' },
];
const NEGATIVE = [
  { re: /we (achieve|obtain|set) (new )?state[- ]of[- ]the[- ]art|outperform(s)? (all|previous|existing) baselines|sota on/i, w: -1.2, tag: '刷榜' },
  { re: /hyper-?parameter (tuning|search)|ablation stud(y|ies)|tuning tips|engineering trick/i, w: -1.0, tag: '调参/工程' },
  { re: /we (fine-?tune|finetune) .{0,40}(on|with) .{0,20}(our|a) (dataset|benchmark)/i, w: -0.8, tag: '单纯微调' },
];

const CORE = [
  { re: /\bai4s\b|ai for science/i, w: 1.5, tag: 'AI4S' },
  { re: /embodied|robot/i, w: 1.2, tag: '具身智能' },
  { re: /\bllm\b|large language model|agent/i, w: 0.6, tag: 'AI' },
];

export function scoreItem(item) {
  const hay = `${item.title ?? ''}\n${item.summary ?? ''}`;
  let score = 0;
  const reasons = [];
  for (const r of POSITIVE) if (r.re.test(hay)) { score += r.w; reasons.push(`+${r.w} ${r.tag}`); }
  for (const r of NEGATIVE) if (r.re.test(hay)) { score += r.w; reasons.push(`${r.w} ${r.tag}`); }
  for (const r of CORE) if (r.re.test(hay)) { score += r.w; reasons.push(`+${r.w} ${r.tag}`); }
  // 时间新鲜度。
  //
  // 踩过的坑（2026-10-17 实测，代价是一份完全错乱的日报）：
  // OpenAlex / Crossref 会返回**未来日期**的脏数据（2121-02-01 这种），
  // 而 `1.5 - ageDays/7` 在 ageDays 为负时是**无上界**的——那条记录拿了
  // 4921.5 分，把整份日报的排序彻底毁掉，而且"打分理由"是空的，
  // 说明它跟 AI 一个关键词都不沾，全靠这一个无界项刷上去。
  //
  // 现在：未来日期按"刚发布"处理；freshness 硬夹在 [0, 1.5]。
  // 教训：**任何进排序的项都必须有上界**，否则脏数据一定会找到它。
  const parsed = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
  const ageDays = Number.isFinite(parsed) ? Math.max(0, (Date.now() - parsed) / 86400000) : 1;
  const freshness = Math.max(0, Math.min(1.5, 1.5 - ageDays / 7));
  score += freshness;
  // 被引数当热度用（OpenAlex / Crossref 没有 upvote）。同样必须有上界。
  if (Number.isFinite(item.upvotes)) score += Math.max(0, Math.min(2, item.upvotes / 25));
  return { score: Number(score.toFixed(2)), reasons };
}

/**
 * 噪声源（OpenAlex / Crossref）的相关性判据。
 *
 * 为什么不是"有一个正分项就算"：实测 2026-10-17，一条《全球疼痛与创伤七域框架》
 * 靠**单个正则误命中**（+3 理论主线）混进了 top-5。正则噪声是常态，
 * 判据必须能容忍一次误命中，否则等于没有判据。
 *
 * 现在的判据：命中 CORE（AI4S / 具身智能 / LLM·agent）**或** ≥2 个正分项。
 * 选这个组合的理由：数学结构的论文通常同时命中「数学结构 + 理论主线」两项，
 * 所以不会被误伤；而纯人文社科条目最多误命中一处。
 *
 * 局限（要认）：这是关键词判据，不是语义判据。一条 AI 论文如果标题摘要里
 * 一个兴趣词都没出现，仍然会被丢掉——宁可漏，不可让日报变成噪声集合。
 */
export function isTopical(item) {
  const { reasons } = scoreItem(item);
  const positives = reasons.filter((r) => r.startsWith('+'));
  if (positives.length >= 2) return true;
  const hay = `${item.title ?? ''}\n${item.summary ?? ''}`;
  return CORE.some((r) => r.re.test(hay));
}

// --- 抓取 ------------------------------------------------------------------

function firstMatch(text, re) {
  const m = re.exec(text);
  return m ? m[1] : '';
}

function decodeXml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function arxivIdOf(url) {
  const m = /abs\/([^v\s]+)(v\d+)?/.exec(url ?? '');
  return m ? m[1] : String(url ?? '');
}

export async function fetchArxiv({ cats = ['cs.AI', 'cs.LG', 'cs.RO'], maxResults = 40, timeoutMs = 20000 } = {}) {
  const query = cats.map((c) => `cat:${c}`).join('+OR+');
  const url =
    `https://export.arxiv.org/api/query?search_query=${query}` +
    `&sortBy=submittedDate&sortOrder=descending&max_results=${Math.min(100, maxResults)}`;
  const xml = await getText(url, timeoutMs);
  const items = [];
  for (const block of xml.split('<entry>').slice(1)) {
    const id = decodeXml(firstMatch(block, /<id>([\s\S]*?)<\/id>/));
    const authors = [...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) => decodeXml(m[1]));
    const categories = [...block.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]);
    items.push({
      source: 'arxiv',
      id: arxivIdOf(id),
      url: id,
      title: decodeXml(firstMatch(block, /<title>([\s\S]*?)<\/title>/)),
      summary: decodeXml(firstMatch(block, /<summary>([\s\S]*?)<\/summary>/)),
      publishedAt: decodeXml(firstMatch(block, /<published>([\s\S]*?)<\/published>/)),
      authors: authors.slice(0, 6),
      authorCount: authors.length,
      categories,
    });
  }
  return items;
}

/** AI4S 专用查询：关键词比分类准（AI for science 散落在物理/生物/材料里）。 */
export async function fetchArxivAi4s({ maxResults = 30, timeoutMs = 20000 } = {}) {
  const q =
    'all:%22AI+for+science%22+OR+all:%22machine+learning%22+AND+cat:physics.comp-ph' +
    '+OR+all:%22scientific+discovery%22+OR+cat:q-bio.BM+AND+all:%22deep+learning%22';
  const url =
    `https://export.arxiv.org/api/query?search_query=${q}` +
    `&sortBy=submittedDate&sortOrder=descending&max_results=${Math.min(100, maxResults)}`;
  const xml = await getText(url, timeoutMs);
  const items = [];
  for (const block of xml.split('<entry>').slice(1)) {
    const id = decodeXml(firstMatch(block, /<id>([\s\S]*?)<\/id>/));
    items.push({
      source: 'arxiv:ai4s',
      id: arxivIdOf(id),
      url: id,
      title: decodeXml(firstMatch(block, /<title>([\s\S]*?)<\/title>/)),
      summary: decodeXml(firstMatch(block, /<summary>([\s\S]*?)<\/summary>/)),
      publishedAt: decodeXml(firstMatch(block, /<published>([\s\S]*?)<\/published>/)),
      authors: [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => decodeXml(m[1])).slice(0, 6),
      categories: [...block.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]),
    });
  }
  return items;
}

export async function fetchHfDaily({ limit = 30, timeoutMs = 20000 } = {}) {
  const url = `https://huggingface.co/api/daily_papers?limit=${Math.min(100, limit)}`;
  const json = JSON.parse(await getText(url, timeoutMs));
  const arr = Array.isArray(json) ? json : [];
  return arr.map((e) => {
    const p = e.paper ?? {};
    return {
      source: 'hf-daily',
      id: p.id ?? e.paper?.id ?? '',
      url: p.id ? `https://huggingface.co/papers/${p.id}` : 'https://huggingface.co/papers',
      title: decodeXml(p.title ?? e.title ?? ''),
      summary: decodeXml(p.summary ?? ''),
      publishedAt: p.publishedAt ?? e.publishedAt ?? '',
      authors: (p.authors ?? []).map((a) => a.name ?? a).slice(0, 6),
      upvotes: p.upvotes ?? e.upvotes ?? 0,
      numComments: e.numComments ?? 0,
      categories: [],
    };
  });
}

async function getText(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`抓取超时（${timeoutMs}ms）：${url}。可能需要梯子，或稍后重试。`);
    throw new Error(`抓取失败：${e?.message ?? e}（${url}）。若国内站点正常而这里全挂，请打开梯子后重试。`);
  } finally {
    clearTimeout(timer);
  }
}

// --- 汇总 ------------------------------------------------------------------

export function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const key = (it.id || it.title || '').toLowerCase().replace(/v\d+$/, '').trim();
    if (key === '') continue;
    const prev = seen.get(key);
    if (!prev || (it.upvotes ?? 0) > (prev.upvotes ?? 0)) {
      seen.set(key, prev ? { ...it, alsoOn: [...(prev.alsoOn ?? []), prev.source] } : it);
    } else {
      prev.alsoOn = [...(prev.alsoOn ?? []), it.source];
    }
  }
  return [...seen.values()];
}

export function rank(items) {
  return items
    .map((it) => ({ ...it, ...scoreItem(it) }))
    .sort((a, b) => b.score - a.score);
}

export function renderDigest({ date, ranked, top, counts, notes = [], sources = [] }) {
  const picked = ranked.slice(0, top);
  const byInterest = (re) => picked.filter((i) => re.test(`${i.title} ${i.summary}`));
  const groups = [
    { name: '具身智能', items: byInterest(/embodied|robot|manipulat|vla|locomotion|world model/i) },
    { name: 'AI4S', items: byInterest(/ai for science|protein|material|weather|climate|pde|molecul|biolog|physics|chem/i) },
    { name: 'AI 理论/方法', items: picked.filter((i) => !byInterest(/embodied|robot|manipulat|vla|locomotion|world model/i).includes(i) && !byInterest(/ai for science|protein|material|weather|climate|pde|molecul|biolog|physics|chem/i).includes(i)) },
  ];
  const sourceLine =
    sources.length === 0
      ? '未知（没有源状态记录）'
      : sources.map((s) => `${s.source}${s.ok ? `✅${s.count}` : `❌${s.status ?? s.error ?? '失败'}`}`).join(' / ');
  const failed = sources.filter((s) => !s.ok);
  const lines = [
    `# 情报日报 · ${date}`,
    '',
    `> 生成时间：${nowIso()}｜候选 ${counts.raw} 条 → 去重 ${counts.deduped} 条 → 精选 ${picked.length} 条`,
    `> 本次源状态：${sourceLine}`,
    `> 覆盖范围：**不保证全量**。上面标 ❌ 的源今天没抓到，那部分内容就是缺的——不是"没有新论文"。`,
    `> 排序依据：兴趣向量（偏好理论/定理主线与数学结构；对"刷榜/调参"降权）。**这是机器排序，不是结论。**`,
    '',
    ...(failed.length ? ['## 未覆盖', '', ...failed.map((s) => `- ${s.name ?? s.source}：${s.error ?? s.status ?? '失败'}`), ''] : []),
    ...(notes.length ? ['## 运行注记', '', ...notes.map((n) => `- ${n}`), ''] : []),
    '## 今日精选',
    '',
  ];
  let n = 0;
  for (const g of groups) {
    if (g.items.length === 0) continue;
    lines.push(`### ${g.name}`);
    lines.push('');
    for (const it of g.items) {
      n += 1;
      lines.push(`${n}. **[${it.title}](${it.url})**　得分 ${it.score}`);
      // 热度标签必须按源区分：OpenAlex/Crossref 的 upvotes 是**被引数**，
      // 标成"HF 赞"就是误导（2026-10-17 实测踩过，一条 Crossref 记录被标了 HF 赞）。
      const heat = it.upvotes
        ? it.source === 'hf-daily'
          ? `｜HF 赞 ${it.upvotes}`
          : `｜被引 ${it.upvotes}`
        : '';
      lines.push(`   - 来源：${it.source}${it.alsoOn?.length ? ` · 同步出现于 ${[...new Set(it.alsoOn)].join('/')}` : ''}｜发布：${(it.publishedAt ?? '').slice(0, 10)}${heat}`);
      lines.push(`   - 打分理由：${it.reasons.join('；')}`);
      if (it.authors?.length) lines.push(`   - 作者：${it.authors.slice(0, 4).join(', ')}${it.authorCount > 4 ? ' 等' : ''}`);
      lines.push(`   - 摘要节选：${(it.summary ?? '').slice(0, 420)}${(it.summary ?? '').length > 420 ? '…' : ''}`);
      lines.push('');
    }
  }
  lines.push('## 未被选中的高分候选（备查）');
  lines.push('');
  for (const it of ranked.slice(top, top + 15)) {
    lines.push(`- [${it.title}](${it.url})　得分 ${it.score}　${it.source}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 跑一次日报并落盘。返回结构化结果，交给模型写"为什么重要"的解读。
 */
export async function run({ config, date = null, top = null, timeoutMs = 20000, includeHf = true, ifMissing = false } = {}) {
  const cfg = config?.intel ?? {};
  const day = date ?? localDate();
  const take = Math.max(1, Math.min(40, Number(top ?? cfg.digestTop ?? 12)));
  if (ifMissing === true) {
    const existing = join(paths.intelDir, `${day}.md`);
    if (fileIsFile(existing)) {
      return { ok: true, skipped: true, date: day, file: existing, message: `今天（${day}）的情报已经抓过，跳过（ifMissing）。` };
    }
  }
  const notes = [];
  const items = [];
  // polite pool 的邮箱只从 config.json 读（默认空）。绝不写死在源码里。
  const mailto = String(cfg.mailto ?? '').trim();
  const sinceDays = Math.max(1, Math.min(60, Number(cfg.sinceDays) || 7));

  const jobs = [
    { source: 'arxiv', name: 'arXiv cs.AI/cs.LG/cs.RO', fn: async () => ({ items: await fetchArxiv({ cats: cfg.arxivCats ?? ['cs.AI', 'cs.LG', 'cs.RO'], maxResults: cfg.maxItems ?? 60, timeoutMs }) }) },
    {
      source: 'arxiv-ai4s',
      name: 'arXiv AI4S',
      // arXiv 官方要求相邻请求间隔 ≥3 秒。两个 arXiv 请求并发时实测第二个
      // 直接 `fetch failed`（连接被拒，不是 429），所以必须错开，不能并发打同一 host。
      fn: async () => {
        await sleep(3500);
        return { items: await fetchArxivAi4s({ maxResults: 30, timeoutMs }) };
      },
    },
  ];
  if (includeHf !== false) {
    jobs.push({ source: 'hf-daily', name: 'Hugging Face Daily Papers', fn: async () => ({ items: await fetchHfDaily({ limit: 30, timeoutMs }) }) });
  }
  if (cfg.openalex !== false) {
    jobs.push({
      source: 'openalex',
      name: 'OpenAlex',
      fn: () =>
        fetchOpenAlex({
          queries: Array.isArray(cfg.openalexQueries) && cfg.openalexQueries.length ? cfg.openalexQueries : ['machine learning', 'embodied intelligence'],
          sinceDays,
          perQuery: 25,
          timeoutMs,
          mailto,
        }),
    });
  }
  if (cfg.crossref !== false) {
    jobs.push({
      source: 'crossref',
      name: 'Crossref',
      fn: () =>
        fetchCrossref({
          queries: Array.isArray(cfg.crossrefQueries) && cfg.crossrefQueries.length ? cfg.crossrefQueries : ['artificial intelligence'],
          sinceDays,
          rows: 20,
          timeoutMs,
          mailto,
        }),
    });
  }

  // 每个 job 单独计时：总耗时算到每个源头上会互相污染，健康度就失去意义。
  const settled = await Promise.allSettled(
    jobs.map(async (j) => {
      const t0 = Date.now();
      const value = await j.fn();
      return { value, ms: Date.now() - t0 };
    }),
  );

  const sources = [];
  settled.forEach((r, i) => {
    const j = jobs[i];
    if (r.status === 'fulfilled') {
      const payload = r.value?.value ?? {};
      const arr = Array.isArray(payload) ? payload : payload.items ?? [];
      const meta = payload.meta ?? null;
      items.push(...arr);
      sources.push({ source: j.source, name: j.name, ok: arr.length > 0, status: meta?.status ?? 200, count: arr.length, latencyMs: r.value?.ms ?? null, error: meta?.error ?? null });
      if (arr.length === 0) notes.push(`${j.name} 返回 0 条${meta?.error ? `（${meta.error}）` : ''}`);
      else if (meta?.error) notes.push(`${j.name} 部分成功（${arr.length} 条），但有一次请求失败：${meta.error}`);
    } else {
      const msg = r.reason?.message ?? String(r.reason);
      notes.push(`${j.name} 抓取失败：${msg}`);
      sources.push({ source: j.source, name: j.name, ok: false, status: null, count: 0, latencyMs: null, error: msg });
    }
  });

  // 落一份源健康度：以后"是我不行还是源不行"有据可查
  for (const s of sources) logSource({ date: day, source: s.source, ok: s.ok, status: s.status, count: s.count, latencyMs: s.latencyMs, error: s.error });

  // 相关性 / 脏数据过滤。
  //
  // 只作用于 OpenAlex 与 Crossref：它们的 search 是"宽匹配"，实测会给回
  // 《婚姻情感与灵性智力》和《游离 DNA 癌症诊断》这种跟 AI 毫不相干的条目，
  // 还有 Crossref 的 "Title Pending 94702" 占位记录（标题都没有，更没有摘要）。
  //
  // arXiv 与 HF 不参与过滤：前者按分类抓、后者按社区投票，本身已经筛过一层，
  // 再按关键词筛只会误伤（数学结构的论文经常不提 "AI" 三个字）。
  //
  // 判据见 isTopical()：单个正则误命中兜不住，要求 CORE 命中或 ≥2 个正分项。
  const NOISY = new Set(['openalex', 'crossref']);
  let droppedOffTopic = 0;
  let droppedJunkTitle = 0;
  const kept = [];
  for (const it of items) {
    if (NOISY.has(it.source)) {
      const title = String(it.title ?? '').trim();
      if (title === '' || title.length < 8 || /^title pending/i.test(title)) {
        droppedJunkTitle += 1;
        continue;
      }
      if (!isTopical(it)) {
        droppedOffTopic += 1;
        continue;
      }
    }
    kept.push(it);
  }
  items.length = 0;
  items.push(...kept);
  if (droppedOffTopic + droppedJunkTitle > 0) {
    notes.push(
      `过滤掉 ${droppedOffTopic + droppedJunkTitle} 条 OpenAlex/Crossref 的宽匹配结果` +
        `（与 AI 无关 ${droppedOffTopic} 条、占位/无标题 ${droppedJunkTitle} 条）`,
    );
  }

  if (items.length === 0) {
    return {
      ok: false,
      date: day,
      notes,
      sources,
      message: '所有来源都抓取失败。先跑 jarvis_preflight 看是不是需要开梯子；网络正常时也可能是临时限流，过几分钟重试。',
    };
  }

  const deduped = dedupe(items);
  const ranked = rank(deduped).slice(0, Math.max(take, 25));
  ensureDir(paths.intelDir);
  const file = join(paths.intelDir, `${day}.md`);
  const markdown = renderDigest({ date: day, ranked, top: take, counts: { raw: items.length, deduped: deduped.length }, notes, sources });
  writeText(file, markdown);

  return {
    ok: true,
    date: day,
    file,
    counts: { raw: items.length, deduped: deduped.length, picked: take },
    notes,
    sources,
    sourceHealth: sourceHealth({ days: 14 }),
    top: ranked.slice(0, take).map((it) => ({
      score: it.score,
      title: it.title,
      url: it.url,
      source: it.source,
      publishedAt: (it.publishedAt ?? '').slice(0, 10),
      upvotes: it.upvotes ?? null,
      reasons: it.reasons,
      abstractExcerpt: (it.summary ?? '').slice(0, 600),
    })),
    nextStep:
      '现在请你（Jarvis）读这份 top 列表，用 jarvis_knowledge(action="add") 把其中与用户四条战线（A 课内 GPA / B 科研论文 / C 数学丘赛 / D AI 全栈）相关的条目写成带解读的笔记，并明确标注哪些与丘赛几何拓扑、AI4S 理论、具身智能保结构理论有关。不要只复述摘要，要给"这对你意味着什么"。',
  };
}

// --- 周报 ------------------------------------------------------------------

export const HARD_DEADLINES = [
  { date: '2027-03-01', label: '丘成桐大学生数学竞赛（几何与拓扑备赛进入冲刺）' },
  { date: '2027-09-10', label: '暑期小课题初稿' },
  { date: '2028-04-30', label: '夏令营材料定稿' },
  { date: '2028-06-01', label: '夏令营与预推免开始' },
];

export function countdown(from = new Date()) {
  return HARD_DEADLINES.map((d) => {
    const days = Math.ceil((Date.parse(d.date) - from.getTime()) / 86400000);
    return { ...d, days, urgent: days <= 30 };
  });
}

export function weeklyScaffold({ config, date = new Date() } = {}) {
  const day = localDate(date);
  const cd = countdown(date);
  const intelFiles = listFiles(paths.intelDir, (n) => n.endsWith('.md')).slice(0, 7).map((f) => f.path);
  const facts = readJsonl(paths.facts).slice(-20);
  const episodes = readJsonl(paths.episodes).slice(-20);
  return {
    day,
    deadlines: cd,
    intelFiles,
    recentFacts: facts,
    recentEpisodes: episodes,
    render() {
      return [
        `# 周报 · ${day}`,
        '',
        '> 这份周报**必须**挂钩四条战线与四个硬截止。不许写成"这周很忙"这种空话。',
        '',
        '## 倒计时',
        '',
        ...cd.map((d) => `- ${d.urgent ? '🔴' : '⚪'} **${d.date}**（还剩 ${d.days} 天）：${d.label}`),
        '',
        '## A 课内 GPA / 排名',
        '- 本周课程与作业实况：',
        '- 风险（哪门课在下滑）：',
        '- 下周动作（可验收）：',
        '',
        '## B 科研与论文',
        '- 本周读的论文 / 复现 / 与导师的接触：',
        '- 有没有产生可积累的产物（笔记/代码/问题清单）：',
        '- 下周动作：',
        '',
        '## C 数学（丘赛几何与拓扑）',
        '- 本周推进的章节（点集拓扑 / 代数拓扑 / 微分流形）：',
        '- 做过的题量与错题：',
        '- 下周动作：',
        '',
        '## D AI 全栈',
        '- 本周掌握的能力点：',
        '- 缺口：',
        '- 下周动作：',
        '',
        '## 本周情报里的信号（来自本地情报库）',
        ...(intelFiles.length ? intelFiles.map((f) => `- ${f}`) : ['- （本周没有情报文件；先跑 /jarvis-intel）']),
        '',
        '## 记忆里需要重新审视的判断',
        ...(facts.length ? facts.map((f) => `- [${f.at.slice(0, 10)}] ${f.text}`) : ['- （无）']),
        '',
        '## 下周唯一最重要的一件事',
        '- ',
        '',
        '## 需要用户拍板的问题',
        '- ',
        '',
      ].join('\n');
    },
  };
}

export function writeWeekly({ config, date = new Date() } = {}) {
  const scaffold = weeklyScaffold({ config, date });
  const file = join(paths.journalDir, `${scaffold.day}-weekly.md`);
  writeText(file, scaffold.render());
  return { file, day: scaffold.day, deadlines: scaffold.deadlines };
}

export function latestIntel() {
  const files = listFiles(paths.intelDir, (n) => n.endsWith('.md'));
  if (files.length === 0) return null;
  return { file: files[0].path, date: files[0].name.replace(/\.md$/, ''), text: readText(files[0].path, '') };
}

/**
 * 补跑状态（2.2）。
 *
 * 先把话说清：**DSH 桌面端不是常驻服务器。**"每天早上 8 点自动抓"在工程上
 * 只能是"每次启动 / 每次检查时补当天"。把它包装成 cron 只会让人以为它在你
 * 关机的时候干了活——那是假的能力。
 *
 * 补跑的触发点一共三处，写在这里以便核对：
 *   1. 插件 apply() 时（每次启动 DSH 查一次，缺就写 jarvis.log 与 info）；
 *   2. jarvis_status 的 gaps 里（"今天还没有情报日报"）；
 *   3. jarvis_intel 带 ifMissing=true（已在别处抓过就不重复抓）。
 */
export function catchUpState({ date = null } = {}) {
  const today = date ?? localDate();
  const todayFile = join(paths.intelDir, `${today}.md`);
  const hasToday = fileIsFile(todayFile);
  const last = latestIntel();
  return {
    today,
    hasToday,
    todayFile,
    lastDate: last?.date ?? null,
    /** 距上一个情报文件过了几天；从未抓过则为 null。 */
    gapDays: last?.date
      ? Math.max(0, Math.round((Date.parse(`${today}T12:00:00`) - Date.parse(`${last.date}T12:00:00`)) / 86400000))
      : null,
    due: !hasToday,
  };
}

export { P };
