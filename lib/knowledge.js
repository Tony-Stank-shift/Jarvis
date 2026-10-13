/**
 * dsh-jarvis — 本地知识库。
 *
 * 存的是"Jarvis 自己攒下来的东西"：读过的论文要点、搞懂的定理、踩过的坑、
 * 每日情报摘要。一律 Markdown，因为用户要能直接打开读、直接改。
 *
 * 目录结构：
 *   ~/.dsh/jarvis/knowledge/<slug>.md          人工/半自动条目
 *   ~/.dsh/jarvis/knowledge/intel/YYYY-MM-DD.md 每日情报（由 lib/intel.js 写）
 *
 * 检索是关键词重叠（lib/text.js），不是向量检索；引用时**必须带文件路径 + 行号**，
 * 这样用户可以自己点进去核对。
 */

import { join } from 'node:path';
import {
  appendJsonl,
  ensureDir,
  listFiles,
  localDate,
  nowIso,
  paths,
  readText,
  slugify,
  writeText,
} from './store.js';
import { excerpt, matchedTerms, score, termSet } from './text.js';

const INDEX = join(paths.knowledgeDir, 'index.jsonl');

/** 写入一条知识。重复标题会覆盖（同 slug），并在索引里留一行记录。 */
export function add({ title, text, tags = [], source = 'manual', kind = 'note' }) {
  const body = String(text ?? '').trim();
  if (body === '') throw new Error('jarvis_knowledge(action="add") 需要非空的 text。');
  const cleanTitle = String(title ?? '').trim() || body.split(/\r?\n/)[0].slice(0, 40);
  const slug = slugify(cleanTitle, `note-${localDate()}`);
  const file = join(paths.knowledgeDir, `${slug}.md`);
  const tagList = Array.isArray(tags) ? tags.map(String) : String(tags ?? '').split(/[,，;；\s]+/).filter(Boolean);
  const front = [
    `# ${cleanTitle}`,
    '',
    `- 写入时间：${nowIso()}`,
    `- 类型：${kind}`,
    `- 来源：${source}`,
    tagList.length ? `- 标签：${tagList.join(' / ')}` : null,
    '',
    '---',
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
  writeText(file, `${front}${body}\n`);
  appendJsonl(INDEX, { at: nowIso(), title: cleanTitle, slug, file, tags: tagList, source, kind, chars: body.length });
  return { file, title: cleanTitle, slug, tags: tagList };
}

function allFiles() {
  const top = listFiles(paths.knowledgeDir, (n) => n.endsWith('.md'));
  const intel = listFiles(paths.intelDir, (n) => n.endsWith('.md'));
  return [...top, ...intel];
}

/** 关键词检索。返回带 line 的引用锚点，便于用户自己核对。 */
export function search({ query = '', limit = 6, days = 0 } = {}) {
  const q = termSet(query);
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0;
  const hits = [];
  for (const f of allFiles()) {
    if (cutoff > 0 && f.mtime < cutoff) continue;
    const text = readText(f.path, '');
    if (text.trim() === '') continue;
    const doc = termSet(text);
    const s = q.size === 0 ? 0.01 : score(q, doc);
    if (s <= 0) continue;
    const firstHit = firstHitLine(text, q);
    hits.push({
      file: f.path,
      name: f.name,
      mtime: new Date(f.mtime).toISOString(),
      score: Number(s.toFixed(4)),
      matched: matchedTerms(q, doc),
      line: firstHit,
      excerpt: excerpt(text, q, 260),
    });
  }
  hits.sort((a, b) => b.score - a.score || b.mtime.localeCompare(a.mtime));
  return hits.slice(0, Math.max(1, Math.min(50, Number(limit) || 6)));
}

function firstHitLine(text, queryTerms) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const t = termSet(lines[i]);
    for (const term of queryTerms.keys()) {
      if (term.length >= 2 && t.has(term)) return i + 1;
    }
  }
  return 1;
}

export function list({ limit = 30 } = {}) {
  const files = allFiles();
  return files.slice(0, Math.max(1, Math.min(200, Number(limit) || 30))).map((f) => ({
    file: f.path,
    name: f.name,
    bytes: f.size,
    mtime: new Date(f.mtime).toISOString(),
  }));
}

export function stats() {
  const files = allFiles();
  const intel = listFiles(paths.intelDir, (n) => n.endsWith('.md'));
  let bytes = 0;
  for (const f of files) bytes += f.size;
  const lastIntel = intel.sort((a, b) => b.mtime - a.mtime)[0] ?? null;
  return {
    notes: files.length - intel.length,
    intelDays: intel.length,
    bytes,
    lastIntelFile: lastIntel?.path ?? null,
    lastIntelDate: lastIntel ? lastIntel.name.replace(/\.md$/, '') : null,
  };
}

export function ensureDirs() {
  ensureDir(paths.knowledgeDir);
  ensureDir(paths.intelDir);
  ensureDir(paths.journalDir);
  ensureDir(paths.memoryDir);
  ensureDir(paths.projectsDir);
  return paths.home;
}
