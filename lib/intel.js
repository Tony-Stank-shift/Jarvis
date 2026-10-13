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
import { ensureDir, localDate, nowIso, paths, writeText, readJsonl, readText, listFiles } from './store.js';
import { paths as P } from './store.js';

export const INTERESTS = ['AI', 'AI4S', '具身智能'];

const UA = { 'user-agent': 'dsh-jarvis-intel/0.1 (+local research digest)' };

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
  const ageDays = item.publishedAt ? (Date.now() - Date.parse(item.publishedAt)) / 86400000 : 1;
  const freshness = Math.max(0, 1.5 - ageDays / 7);
  score += freshness;
  if (Number.isFinite(item.upvotes)) score += Math.min(2, item.upvotes / 25);
  return { score: Number(score.toFixed(2)), reasons };
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

export function renderDigest({ date, ranked, top, counts, notes = [] }) {
  const picked = ranked.slice(0, top);
  const byInterest = (re) => picked.filter((i) => re.test(`${i.title} ${i.summary}`));
  const groups = [
    { name: '具身智能', items: byInterest(/embodied|robot|manipulat|vla|locomotion|world model/i) },
    { name: 'AI4S', items: byInterest(/ai for science|protein|material|weather|climate|pde|molecul|biolog|physics|chem/i) },
    { name: 'AI 理论/方法', items: picked.filter((i) => !byInterest(/embodied|robot|manipulat|vla|locomotion|world model/i).includes(i) && !byInterest(/ai for science|protein|material|weather|climate|pde|molecul|biolog|physics|chem/i).includes(i)) },
  ];
  const lines = [
    `# 情报日报 · ${date}`,
    '',
    `> 生成时间：${nowIso()}｜候选 ${counts.raw} 条 → 去重 ${counts.deduped} 条 → 精选 ${picked.length} 条`,
    `> 来源：arXiv cs.AI/cs.LG/cs.CL/cs.RO + AI-for-Science 关键词、Hugging Face Daily Papers`,
    `> 排序依据：兴趣向量（偏好理论/定理主线与数学结构；对"刷榜/调参"降权）。**这是机器排序，不是结论。**`,
    '',
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
      lines.push(`   - 来源：${it.source}${it.alsoOn?.length ? ` · 同步出现于 ${[...new Set(it.alsoOn)].join('/')}` : ''}｜发布：${(it.publishedAt ?? '').slice(0, 10)}${it.upvotes ? `｜HF 赞 ${it.upvotes}` : ''}`);
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
export async function run({ config, date = null, top = null, timeoutMs = 20000, includeHf = true } = {}) {
  const cfg = config?.intel ?? {};
  const day = date ?? localDate();
  const take = Math.max(1, Math.min(40, Number(top ?? cfg.digestTop ?? 12)));
  const notes = [];
  const items = [];

  const jobs = [
    { name: 'arXiv cs.AI/cs.LG/cs.RO', fn: () => fetchArxiv({ cats: cfg.arxivCats ?? ['cs.AI', 'cs.LG', 'cs.RO'], maxResults: cfg.maxItems ?? 60, timeoutMs }) },
    { name: 'arXiv AI4S', fn: () => fetchArxivAi4s({ maxResults: 30, timeoutMs }) },
  ];
  if (includeHf !== false) jobs.push({ name: 'Hugging Face Daily Papers', fn: () => fetchHfDaily({ limit: 30, timeoutMs }) });

  const settled = await Promise.allSettled(jobs.map((j) => j.fn()));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else notes.push(`${jobs[i].name} 抓取失败：${r.reason?.message ?? r.reason}`);
  });

  if (items.length === 0) {
    return {
      ok: false,
      date: day,
      notes,
      message: '所有来源都抓取失败。先跑 jarvis_preflight 看是不是需要开梯子；网络正常时也可能是 arXiv/HF 临时限流，过几分钟重试。',
    };
  }

  const deduped = dedupe(items);
  const ranked = rank(deduped).slice(0, Math.max(take, 25));
  ensureDir(paths.intelDir);
  const file = join(paths.intelDir, `${day}.md`);
  const markdown = renderDigest({ date: day, ranked, top: take, counts: { raw: items.length, deduped: deduped.length }, notes });
  writeText(file, markdown);

  return {
    ok: true,
    date: day,
    file,
    counts: { raw: items.length, deduped: deduped.length, picked: take },
    notes,
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

export { P };
