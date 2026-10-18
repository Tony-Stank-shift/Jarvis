/**
 * dsh-jarvis — 引用核验（阶段 0）。
 *
 * 这是四项要求里**唯一能自动化**的防幻觉机制，也是我在讨论时给用户的承诺里
 * 最实的一条：把「编」变成「编了会被当场抓住」。
 *
 * 它只做三件确定性的事，不做语义判断：
 *
 * 1. **文件存在吗**：把回复里所有 `路径:行号` 抽出来，逐个在给定的根目录下
 *    找。找不到 → missing。
 * 2. **行号在范围内吗**：文件找到了，但只有 40 行而引用写 `:87` → out-of-range。
 *    这是最硬的信号：行号越界 = 100% 编的，没有任何解释空间。
 * 3. **那一行到底写了什么**：把被引用行的**原文**摘出来还给模型。
 *    这一招比前两条都狠——引用是否支持论点，模型/用户一眼就能判，
 *    而编造的行号一定会摘出一段驴唇不对马嘴的内容。
 *
 * 刻意不做的事（以及为什么）：
 * - 不做「符号是否存在于文件里」的模糊匹配：误报率高，会把真引用判成假的，
 *   比不判更糟。
 * - 不默认联网验 URL：那是外网访问，按红线要先提醒用户（jarvis_verify 的
 *   checkUrls=true 会走审批闸门）。
 * - 不判断"这句话对不对"：那需要语义理解，判错了反而给人虚假的安心感。
 *
 * 已知局限（必须写出来，否则用户会以为它是完备的）：
 * - 相对路径需要调用方传 `roots`；不传就只认 Jarvis 自有数据目录。
 *   插件跑在 Host 进程里，拿不到当前会话工作区，这是环境限制不是设计选择。
 * - 路径里**含空格**时必须用反引号或引号包起来，否则抽不出来。
 * - 只抽「带行号」的引用。裸路径（没有 `:行号`）不验——太容易误伤正文里的
 *   文件名提及。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { paths } from './store.js';

/** 最多核验多少条引用；防止一篇长文把工具跑爆。 */
const MAX_CITATIONS = 60;
/** 每行摘录上限。 */
const EXCERPT_CHARS = 220;

// 先把 URL 挖出来并遮蔽，否则 `http://x.com:8080` 会被误当成 `x.com:8080` 引用。
const URL_RE = /https?:\/\/[^\s)\]}"'<>，。；、）】]+/g;

// 不带空格的引用：lib/memory.js:79-80、README.md:121、C:\a\b.py:12
const BARE_CITE_RE = /([^\s:：,，()（）"'`<>|[\]{}。；、]+?\.[A-Za-z0-9]{1,8}):(\d+)(?:\s*[-–~]\s*(\d+))?/g;
// 被引号/反引号包住的引用：支持含空格路径
const QUOTED_CITE_RE = /[`"「']([^`"」'\n]{1,300}?\.[A-Za-z0-9]{1,8}):(\d+)(?:\s*[-–~]\s*(\d+))?[`"」']/g;

function clip(s, n = EXCERPT_CHARS) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 把指定区间替换成等长空格（保持下标不变，后续正则可以继续用原坐标）。 */
function maskSpans(src, spans) {
  let out = src;
  for (const [s, e] of [...spans].sort((a, b) => b[0] - a[0])) {
    out = `${out.slice(0, s)}${' '.repeat(Math.max(0, e - s))}${out.slice(e)}`;
  }
  return out;
}

/** 从一段文本里抽出所有引用与 URL。纯函数，不碰文件系统。 */
export function extractCitations(text) {
  const src = String(text ?? '');
  const urls = [];
  const urlSpans = [];
  for (const m of src.matchAll(URL_RE)) {
    urls.push(m[0]);
    urlSpans.push([m.index, m.index + m[0].length]);
  }
  // 先挖掉 URL：否则 `https://x.com:8443/` 会被当成 `x.com:8443` 引用。
  const masked = maskSpans(src, urlSpans);

  const files = [];
  const seen = new Set();
  const push = (raw, file, start, end, quoted) => {
    const key = `${file}:${start}:${end ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push({ raw: raw.trim(), path: file, lineStart: Number(start), lineEnd: end ? Number(end) : null, quoted: Boolean(quoted) });
  };

  // 引号版本先跑，再把它占用的区间也挖掉，否则同一条引用会被裸版本再抽一次
  // ——而且裸版本不允许空格，会抽出 `Huang/jarvis/package.json:3` 这种半截路径。
  const quotedSpans = [];
  for (const m of masked.matchAll(QUOTED_CITE_RE)) {
    push(m[0], m[1].trim(), m[2], m[3], true);
    quotedSpans.push([m.index, m.index + m[0].length]);
  }
  const masked2 = maskSpans(masked, quotedSpans);
  for (const m of masked2.matchAll(BARE_CITE_RE)) push(m[0], m[1].trim(), m[2], m[3], false);
  return { files, urls: [...new Set(urls)] };
}

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * 核验。
 *
 * @param {object} o
 * @param {string} o.text          要核验的文本（通常是 Jarvis 刚写出的回答）
 * @param {string[]} [o.roots]     相对路径的解析根目录；默认 [JarvisHome]
 * @param {function} [o.fetcher]   注入的 URL 检查器（有它才联网）；签名 (url) => Promise<{status:number|null, error?:string}>
 * @param {number} [o.max]         最多核验多少条
 * @returns {Promise<object>}
 */
export async function verify({ text = '', roots = [], fetcher = null, max = MAX_CITATIONS } = {}) {
  const extracted = extractCitations(text);
  const bases = (Array.isArray(roots) && roots.length ? roots : [paths.home])
    .map((r) => String(r ?? '').trim())
    .filter(Boolean);

  const files = [];
  for (const c of extracted.files.slice(0, Math.max(1, Number(max) || MAX_CITATIONS))) {
    const candidates = isAbsolute(c.path) ? [c.path] : bases.map((b) => resolve(b, c.path));
    let resolved = null;
    for (const cand of candidates) {
      try {
        if (existsSync(cand) && statSync(cand).isFile()) {
          resolved = cand;
          break;
        }
      } catch {
        /* 单个路径异常跳过 */
      }
    }

    if (!resolved) {
      files.push({ ...c, resolved: null, status: 'missing', tried: candidates.slice(0, 6) });
      continue;
    }

    const lines = readLines(resolved);
    if (!lines) {
      files.push({ ...c, resolved, status: 'unreadable' });
      continue;
    }
    const total = lines.length;
    const end = c.lineEnd ?? c.lineStart;
    if (c.lineStart < 1 || c.lineStart > total || end > total) {
      files.push({ ...c, resolved, status: 'out-of-range', fileLines: total });
      continue;
    }
    const span = lines.slice(c.lineStart - 1, Math.min(end, c.lineStart + 2));
    files.push({
      ...c,
      resolved,
      status: 'ok',
      fileLines: total,
      excerpt: span.map((l, i) => `${c.lineStart + i}: ${clip(l, 120)}`).join('\n'),
    });
  }

  const urlResults = [];
  if (Array.isArray(extracted.urls) && extracted.urls.length > 0) {
    for (const u of extracted.urls.slice(0, 12)) {
      if (typeof fetcher !== 'function') {
        urlResults.push({ url: u, status: 'unchecked', note: '未联网核验（checkUrls 未开）' });
        continue;
      }
      try {
        const r = await fetcher(u);
        const st = Number(r?.status);
        const ok = Number.isFinite(st) && ((st >= 200 && st < 400) || st === 403 || st === 405 || st === 429);
        urlResults.push({
          url: u,
          status: ok ? 'ok' : Number.isFinite(st) ? 'dead' : 'unknown',
          httpStatus: Number.isFinite(st) ? st : null,
          ...(r?.error ? { error: clip(r.error, 160) } : {}),
        });
      } catch (e) {
        urlResults.push({ url: u, status: 'unknown', error: clip(e?.message ?? e, 160) });
      }
    }
  }

  const count = (s) => files.filter((f) => f.status === s).length + urlResults.filter((u) => u.status === s).length;
  const summary = {
    files: files.length,
    urls: urlResults.length,
    ok: count('ok'),
    missing: count('missing'),
    outOfRange: count('out-of-range'),
    deadUrls: count('dead'),
    unchecked: count('unchecked') + count('unknown') + count('unreadable'),
  };
  const failed = summary.missing + summary.outOfRange + summary.deadUrls;

  const lines = [];
  if (files.length === 0 && urlResults.length === 0) {
    lines.push('这段文本里没有抽到「带行号的引用」或 URL。');
    lines.push('→ 如果它包含事实性断言却一个引用都没有，那它**不可核验**，按纪律应标 [未核实]。');
  }
  for (const f of files) {
    if (f.status === 'ok') {
      lines.push(`✅ ${f.path}:${f.lineStart}${f.lineEnd ? `-${f.lineEnd}` : ''}（文件共 ${f.fileLines} 行）`);
      if (f.excerpt) lines.push(`   实际内容：${f.excerpt.replace(/\n/g, ' ⏎ ')}`);
    } else if (f.status === 'out-of-range') {
      lines.push(`❌ ${f.path}:${f.lineStart}${f.lineEnd ? `-${f.lineEnd}` : ''} — 行号越界：文件只有 ${f.fileLines} 行。**这是确定性的编造。**`);
    } else if (f.status === 'missing') {
      lines.push(`❌ ${f.path} — 找不到文件。试过：${(f.tried ?? []).join(' | ')}`);
    } else {
      lines.push(`⚠️ ${f.path}:${f.lineStart} — 文件存在但读不出来（${f.status}）。`);
    }
  }
  for (const u of urlResults) {
    if (u.status === 'ok') lines.push(`✅ ${u.url}（HTTP ${u.httpStatus}）`);
    else if (u.status === 'dead') lines.push(`❌ ${u.url}（HTTP ${u.httpStatus}）`);
    else lines.push(`⚠️ ${u.url} — ${u.note ?? u.error ?? u.status}`);
  }

  return {
    ok: failed === 0,
    summary,
    files,
    urls: urlResults,
    rootsUsed: bases,
    message:
      `${lines.join('\n')}\n\n` +
      `**核验结果**：引用 ${summary.files} 个文件 + ${summary.urls} 个链接；` +
      `通过 ${summary.ok}，找不到文件 ${summary.missing}，行号越界 ${summary.outOfRange}，死链 ${summary.deadUrls}，未核验 ${summary.unchecked}。` +
      (failed > 0
        ? `\n\n有 ${failed} 条**确定性错误**。按纪律：这条回答不许原样发出，先改正引用，改不掉的删掉该断言。`
        : '\n\n没有确定性错误。注意：这只说明引用指向真实存在的位置，**不证明引用的内容支持你的论点**——摘录要自己看一眼。'),
  };
}
