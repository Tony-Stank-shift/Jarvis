/**
 * dsh-jarvis — 本地数据层。
 *
 * 设计红线：Jarvis 自有数据一律写在 `~/.dsh/jarvis/` 之下。这是唯一无需逐次
 * 审批的写入区；桌面、各工作区、以及任何其它路径的写入都必须先经用户同意
 * （见 lib/redline.js 与 index.js 中各工具的实现）。
 *
 * 依赖：只用 node: 内置模块，不 import 任何 @deepseek-ai/* 包，这样插件在
 * 任何 DSH 版本上都能加载，不会因为核心包结构调整而 import 失败。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/** Jarvis 自有数据根目录。 */
export const JARVIS_HOME = join(homedir(), '.dsh', 'jarvis');

export const paths = {
  home: JARVIS_HOME,
  config: join(JARVIS_HOME, 'config.json'),
  profile: join(JARVIS_HOME, 'profile.md'),
  rules: join(JARVIS_HOME, 'rules.md'),
  log: join(JARVIS_HOME, 'jarvis.log'),
  memoryDir: join(JARVIS_HOME, 'memory'),
  facts: join(JARVIS_HOME, 'memory', 'facts.jsonl'),
  episodes: join(JARVIS_HOME, 'memory', 'episodes.jsonl'),
  projectsDir: join(JARVIS_HOME, 'projects'),
  knowledgeDir: join(JARVIS_HOME, 'knowledge'),
  intelDir: join(JARVIS_HOME, 'knowledge', 'intel'),
  journalDir: join(JARVIS_HOME, 'journal'),
};

/** 默认配置。config.json 缺失或字段残缺时用它兜底。 */
export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  /** academic = 严肃学术模式 / bro = 兄弟闲聊模式 / hybrid = 结合模式（默认）。 */
  mode: 'hybrid',
  /** 人格浓度 0–5：越高越"贾维斯"，越低越工具化。 */
  personaIntensity: 3,
  /** 压缩策略：soft = 常规阈值(%)，hard = 极复杂任务阈值(%)。 */
  contextPolicy: { soft: 50, hard: 30 },
  intel: {
    enabled: true,
    interests: ['AI', 'AI4S', '具身智能'],
    arxivCats: ['cs.AI', 'cs.LG', 'cs.RO', 'cs.CL', 'stat.ML'],
    maxItems: 60,
    digestTop: 12,
  },
  redLines: {
    /**
     * 外网策略（用户底线原文是"需要梯子就跟我说 / 提醒我开梯子"——是提醒，不是禁止）：
     *   'remind'  默认：允许访问，但每次都会明确告诉用户"我用了外网、要不要开梯子"
     *   'approve' 每次外网访问都要先经用户同意
     *   'allow'   不管（用户明确表示不需要提醒时）
     * 注意：下载/安装软件**永远**要审批，与这一项无关。
     */
    networkPolicy: 'remind',
    requireApprovalForDownload: true,
    requireApprovalForDesktopWrite: true,
    requireApprovalForWorkspaceWrite: true,
    requireApprovalForTraining: true,
    jarvisHomeExempt: true,
  },
});

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function nowIso() {
  return new Date().toISOString();
}

/** 本地日期 YYYY-MM-DD（用本地时区，情报按"你的今天"归档）。 */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 文件名安全的 slug；中文会被保留（Windows/NTFS 支持），其余非法字符折叠为 '-'。 */
export function slugify(name, fallback = 'item') {
  const s = String(name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (s === '') return fallback;
  return s.length > 60 ? `${s.slice(0, 60)}-${shortHash(s)}` : s;
}

export function shortHash(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 8);
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// --- 文本 / JSON -----------------------------------------------------------

export function readText(file, fallback = '') {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

/** 原子写：先写 .tmp 再 rename，避免中途崩溃留下半个文件。 */
export function writeText(file, text) {
  ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
  return file;
}

export function readJson(file, fallback = null) {
  const raw = readText(file, '');
  if (raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  return writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** 浅合并读取配置：缺失字段用默认值补齐，且不写盘（只在真正 set 时写）。 */
export function loadConfig() {
  const raw = readJson(paths.config, null);
  return mergeConfig(DEFAULT_CONFIG, raw);
}

export function mergeConfig(base, override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(override)) {
    const b = base[k];
    out[k] =
      b !== null && typeof b === 'object' && !Array.isArray(b) && v !== null && typeof v === 'object' && !Array.isArray(v)
        ? mergeConfig(b, v)
        : v;
  }
  return out;
}

export function saveConfig(config) {
  writeJson(paths.config, config);
  return config;
}

// --- JSONL（记忆 / 事件流水） ----------------------------------------------

export function appendJsonl(file, record) {
  ensureDir(dirname(file));
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export function readJsonl(file, limit = 5000) {
  const raw = readText(file, '');
  if (raw.trim() === '') return [];
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 跳过坏行：一条损坏的记录不该让整个记忆库不可用 */
    }
  }
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/** 就地重写 JSONL（用于 forget / 更新）。 */
export function rewriteJsonl(file, records) {
  writeText(file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  return records.length;
}

// --- 目录列举 --------------------------------------------------------------

/** 列出目录下的普通文件，按修改时间倒序；目录不存在时返回 []。 */
export function listFiles(dir, filter = null) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (filter && !filter(name)) continue;
      out.push({ name, path: full, size: st.size, mtime: st.mtimeMs });
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function listDirs(dir) {
  try {
    return readdirSync(dir)
      .map((name) => ({ name, path: join(dir, name) }))
      .filter((e) => {
        try {
          return statSync(e.path).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

// --- 路径安全 --------------------------------------------------------------

/** 该路径是否落在 Jarvis 自有数据区内（唯一免审批写入区）。 */
export function isInsideJarvisHome(target) {
  const normalized = resolve(target).toLowerCase().replace(/[\\/]+$/, '');
  const home = resolve(JARVIS_HOME).toLowerCase().replace(/[\\/]+$/, '');
  return normalized === home || normalized.startsWith(`${home}\\`) || normalized.startsWith(`${home}/`);
}

export function removeFile(file) {
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

/** 追加一行到 jarvis.log（永不抛错：日志失败不该影响主流程）。 */
export function logLine(message) {
  try {
    ensureDir(JARVIS_HOME);
    appendFileSync(paths.log, `[${nowIso()}] ${message}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

export function relativeToHome(file) {
  const rel = resolve(file).slice(resolve(JARVIS_HOME).length).replace(/^[\\/]+/, '');
  return rel === '' ? basename(file) : rel;
}

export function fileIsFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
