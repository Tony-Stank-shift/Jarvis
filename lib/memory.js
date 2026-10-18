/**
 * dsh-jarvis — 双轨记忆。
 *
 * 事实记忆（facts）：稳定、可复用、会被反复引用 → 长期有效，带置信度与来源。
 * 情节记忆（episodes）：某次对话/某天发生了什么 → 时间线，会过期。
 *
 * 分开的理由：把"用户不喜欢写作业"和"今天他说有点累"混在一个池子里，
 * 检索时会互相污染——前者该常驻影响判断，后者只该在恰当的时候被翻出来。
 */

import { join } from 'node:path';
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
import * as palace from './palace.js';
import { normalizeWorkspace } from './workspace.js';
import { synonymBonus } from './synonyms.js';

export const KINDS = ['fact', 'episode'];

// --- 强度模型（1.2）-------------------------------------------------------
//
// 为什么不用真·艾宾浩斯：那条曲线是**群体平均**，对单条记忆没有预测力。
// 逐条可用的是 SM-2 / FSRS 这一支，核心就两个量：
//   stability  —— 稳定度（天）：记忆衰减到一半特征时间所需的时间尺度
//   strength   —— 强度（0–1）：上次加固之后的初始可回想概率
// 当前可回想概率（retrievability）：
//   R = strength · 2^(-Δt / stability)      Δt = 距上次触碰的天数
//
// 加固一次 → strength 回升、stability 变长（间隔效应）；被否定一次 →
// stability 腰斩、strength 下掉（这才是"遗忘曲线"该有的行为）。
//
// 底线：**永不自动删除。** R 低到阈值以下的记录移入 cold.jsonl，
// 随时可 restore。衰减模型一定会在某些条目上判错，静默丢数据不可逆。

/** 初始稳定度（天）。情节记忆过期快，事实记忆长期有效。 */
const INITIAL_STABILITY = { fact: 900, episode: 45 };
/** 归档阈值：可回想概率低于它、且年龄已超过一个 stability，才考虑冷归档。 */
export const COLD_THRESHOLD = 0.05;
const DAY = 86400000;

function stabilityOf(r) {
  const s = Number(r?.stability);
  if (Number.isFinite(s) && s > 0) return s;
  return INITIAL_STABILITY[r?.kind === 'episode' ? 'episode' : 'fact'];
}

function strengthOf(r) {
  const s = Number(r?.strength);
  if (Number.isFinite(s) && s >= 0) return Math.max(0, Math.min(1, s));
  return 1;
}

function lastTouchMs(r) {
  const t = Date.parse(r?.lastUsedAt ?? r?.at ?? '');
  return Number.isFinite(t) ? t : Date.now();
}

/** 当前可回想概率（0–1）。纯函数，不写盘。 */
export function retrievabilityOf(r, now = Date.now()) {
  const ageDays = Math.max(0, (now - lastTouchMs(r)) / DAY);
  const rv = strengthOf(r) * 0.5 ** (ageDays / stabilityOf(r));
  return Math.max(0, Math.min(1, rv));
}

/** 初始强度字段集合（remember 时用）。 */
function initialStrength(kind, atIso) {
  const stability = INITIAL_STABILITY[kind === 'episode' ? 'episode' : 'fact'];
  const atMs = Date.parse(atIso);
  const base = Number.isFinite(atMs) ? atMs : Date.now();
  return {
    strength: 1,
    stability,
    due: new Date(base + stability * DAY).toISOString(),
    reps: 0,
    lapses: 0,
    lastUsedAt: atIso,
    archived: false,
  };
}

function fileFor(kind) {
  return kind === 'episode' ? paths.episodes : paths.facts;
}

/**
 * 写入一条记忆。
 *
 * v0.2 起每条记忆都带 `room`（记忆宫殿的房间）与 `loci`（房间内的位置序号）。
 * 归房策略：
 *   - 显式给了 `room` 且能识别（固定房间 / `项目-xxx`）→ 就用它；
 *   - 显式给了但**不认识** → 抛错，不猜。猜错的后果是这条记忆在房间视图里
 *     隐形，比直接报错难查得多；
 *   - 没给 → `palace.autoRoom` 按关键词打分，一个都没命中就进 `inbox`。
 */
export function remember({ kind = 'fact', text, tags = [], source = 'conversation', confidence = 0.8, at = null, room = null, loci = null, workspace = null }) {
  const k = KINDS.includes(kind) ? kind : 'fact';
  const body = String(text ?? '').trim();
  if (body === '') throw new Error('jarvis_memory(action="remember") 需要非空的 text。');

  const nt = normalizeTags(tags);
  const want = String(room ?? '').trim();
  let roomSlug;
  let routed = 'auto';
  if (want !== '') {
    const meta = palace.metaOf(want);
    if (!meta) {
      const names = palace.ROOMS.map((r) => r.slug).join(' / ');
      throw new Error(`不认识的房间 "${want}"。可用：${names}，或以 \`${palace.PROJECT_PREFIX}\` 开头的项目房间。`);
    }
    roomSlug = meta.slug;
    routed = 'explicit';
  } else {
    roomSlug = palace.autoRoom({ text: body, tags: nt }).slug;
  }

  const wantLoci = Number(loci);
  const atIso = at ?? nowIso();
  const record = {
    id: `${localDate()}-${shortHash(`${body}${nowIso()}`)}`,
    at: atIso,
    kind: k,
    text: body,
    tags: nt,
    source,
    confidence: clamp01(confidence),
    room: roomSlug,
    loci: Number.isFinite(wantLoci) && wantLoci > 0 ? Math.round(wantLoci) : palace.nextLoci(roomSlug),
    routed,
    // 工作区标注（v0.3 · 3.2b）：只记录"在哪产生的"，不用于默认过滤。
    // 老记录没有这个字段 → 读的时候当作 null（"未标注"），而不是编一个默认值。
    workspace: normalizeWorkspace(workspace),
    ...initialStrength(k, atIso),
  };
  appendJsonl(fileFor(k), record);
  return record;
}

/**
 * 把已有记录迁到另一个房间（保留原文与置信度，只改 room / loci 并记下迁移时间）。
 * 用途：将来真开了 `C-数学` 房间，一条命令把 `A-课内` 里的数学笔记整批迁过去。
 */
export function move({ ids = [], room, kind = 'all' } = {}) {
  const want = String(room ?? '').trim();
  const meta = palace.metaOf(want);
  if (!meta) throw new Error(`不认识的房间 "${want}"。先用 jarvis_memory(action="rooms") 看有哪些。`);
  const idSet = new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? '').trim()).filter(Boolean));
  if (idSet.size === 0) throw new Error('move 需要 ids（数组）。先用 action="list" 看 id。');

  const kinds = kind === 'all' || !KINDS.includes(kind) ? KINDS : [kind];
  const moved = [];
  for (const k of kinds) {
    const rows = readJsonl(fileFor(k));
    let changed = false;
    const next = rows.map((r) => {
      if (!idSet.has(r.id)) return r;
      changed = true;
      moved.push({ id: r.id, from: r.room ?? null, to: meta.slug });
      return { ...r, room: meta.slug, loci: palace.nextLoci(meta.slug), movedAt: nowIso() };
    });
    if (changed) rewriteJsonl(fileFor(k), next);
  }
  return { moved: moved.length, room: meta.slug, details: moved };
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

export function list({ kind = 'all', limit = 50, workspace = null } = {}) {
  const kinds = kind === 'all' || !KINDS.includes(kind) ? KINDS : [kind];
  const want = normalizeWorkspace(workspace);
  const out = [];
  for (const k of kinds) {
    for (const r of readJsonl(fileFor(k))) {
      const row = { ...r, kind: r.kind ?? k };
      // 过滤是**显式要求**才生效：want 为 null 时不过滤，老数据照样看得见。
      if (want !== null && normalizeWorkspace(row.workspace) !== want) continue;
      out.push(row);
    }
  }
  out.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return out.slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
}

/** 冷档文件：低强度记忆移到这里，永不删除。 */
const COLD_FILE = join(paths.memoryDir, 'cold.jsonl');

/** 给数组挂一份非枚举的 meta——保持 recall 返回"数组"的向后兼容。 */
function withMeta(arr, meta) {
  try {
    Object.defineProperty(arr, 'meta', { value: meta, enumerable: false });
  } catch {
    /* 拿不到就算了，不能因为挂 meta 让检索失败 */
  }
  return arr;
}

/**
 * 选房间（阶段 1）。
 *
 * 固定房间靠 `lib/palace.js` 的关键词（对原始词面最准）；项目房间是动态的、
 * 没有关键词，所以靠"查询词与房间标签的二元组重叠"来打分。
 * 一个都不命中就返回空数组——此时检索直接走全局，**不是失败**。
 */
function pickRooms({ queryText, tokens, prepared, limit = 2 }) {
  const hay = String(queryText ?? '').toLowerCase();
  const scored = new Map();
  for (const room of palace.ROOMS) {
    let s = 0;
    for (const kw of room.keywords) if (kw && hay.includes(String(kw).toLowerCase())) s += Math.min(8, String(kw).length);
    if (s > 0) scored.set(room.slug, s);
  }
  const seen = new Set();
  for (const p of prepared) {
    const slug = p.rec.room;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const meta = palace.metaOf(slug);
    if (!meta?.dynamic) continue;
    let s = 0;
    for (const t of tokens.keys()) if (t.length >= 2 && meta.label.includes(t)) s += 2;
    if (s > 0) scored.set(slug, s);
  }
  return [...scored.entries()]
    .map(([slug, score]) => ({ slug, score }))
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, Math.max(1, limit));
}

/**
 * 检索（1.3）——三阶段"走宫殿"。
 *
 * 有了房间之后，检索不再是"全库 top-k"，而是：
 *
 *   1. **选房间**：查询词先跟房间定义匹配，取最多 2 个；
 *   2. **走 loci**：在房间内按「文本重叠 × 当前可回想概率」排序取前几条；
 *   3. **串门**：沿房间的门一跳（上限 3 条），这是跨域联想的来源；
 *   4. **全局兜底**：**永远保留**。房间分类错误时记忆不会隐形——这是整套设计
 *      里最重要的一条保险，宁可多扫一遍全库，也不接受"按分类找不到就等于没有"。
 *
 * 打分（v0.2）：`文本重叠 × (0.55 + 0.45·R) × (0.6 + 0.4·置信度)`，
 * R 是这条记忆自己的可回想概率（见 retrievabilityOf），不再按类型一刀切。
 *
 * 返回值仍是**数组**（向后兼容），额外信息挂在不枚举的 `.meta` 上：
 * `{ stage, roomsUsed, doorsUsed, fallback, explicitRoom }`。
 */
export function recall({ query = '', kind = 'all', limit = 8, tags = [], room = null, workspace = null } = {}) {
  const now = Date.now();
  const cap = Math.max(1, Math.min(50, Number(limit) || 8));
  const queryText = [query, ...normalizeTags(tags)].join(' ');
  const q = termSet(queryText);
  // 工作区过滤是**显式要求**才生效（v0.3 · 3.2b 的设计决定：默认不过滤，
  // 否则"在 A 目录问 B 目录的事"会凭空变哑巴）。
  const wantWs = normalizeWorkspace(workspace);
  // 显式指定房间时，**整个检索池**都必须先限定在该房间内。
  //
  // 2026-10-18 活的基准抓到过这个 bug：房间"硬过滤"当时只作用在"选房间"那一步，
  // 而最后的强度兜底仍然遍历全库，于是房内没有命中时它把别房间的记录端了上来
  // ——直接违背 schema 里"只在这个房间里搜"的承诺。
  // 教训：过滤器必须作用在**候选池**上，而不是作用在"选择过程"上。
  const explicitRoom = room ? palace.metaOf(room)?.slug ?? null : null;
  const rows = listAll(kind).filter(
    (r) =>
      r.archived !== true &&
      (wantWs === null || normalizeWorkspace(r.workspace) === wantWs) &&
      (explicitRoom === null || r.room === explicitRoom),
  );

  const prep = rows.map((rec) => {
    const doc = termSet(`${rec.text} ${(rec.tags ?? []).join(' ')}`);
    // 打分的三个来源（v0.3 · 3.4）：
    //   score       —— 文本重叠（有强词时单字不计分，见 text.js）
    //   synonymBonus —— 同义词奖励（上限 0.3，永不超过直接命中）
    //   tagHit      —— 查询词正好是这条的标签（标签是人工分类，比正文匹配更可信）
    const tagHit = (rec.tags ?? []).some((t) => q.has(String(t).toLowerCase()));
    const base = Math.min(1, score(q, doc) + synonymBonus(q, doc) + (tagHit ? 0.1 : 0));
    return { rec, doc, base, tagHit, retr: retrievabilityOf(rec, now) };
  });

  const confOf = (rec) => (Number.isFinite(Number(rec.confidence)) ? Number(rec.confidence) : 0.8);
  const merit = (p) => p.base * (0.55 + 0.45 * p.retr) * (0.6 + 0.4 * confOf(p.rec));
  const shape = (p, extra = {}) => ({
    ...p.rec,
    score: Number(merit(p).toFixed(4)),
    retrievability: Number(p.retr.toFixed(4)),
    matched: matchedTerms(q, p.doc),
    excerpt: excerpt(p.rec.text, q, 160),
    ...extra,
  });

  // 空查询：把"最鲜活"的端上来（按可回想概率），而不是按时间倒序。
  // prep 已经被 explicitRoom / workspace 限定过，这里不用再过滤。
  if (q.size === 0) {
    const out = [...prep]
      .sort((a, b) => b.retr - a.retr || String(b.rec.at).localeCompare(String(a.rec.at)))
      .slice(0, cap)
      .map((p) => shape(p));
    return withMeta(out, {
      stage: 'strength',
      roomsUsed: explicitRoom ? [explicitRoom] : [],
      doorsUsed: [],
      fallback: 0,
      explicitRoom,
      workspace: wantWs,
    });
  }

  const roomPicks = explicitRoom
    ? [{ slug: explicitRoom, score: null }]
    : pickRooms({ queryText, tokens: q, prepared: prep, limit: 2 });

  const taken = new Set();
  const results = [];
  const push = (p, extra) => {
    if (taken.has(p.rec.id)) return false;
    taken.add(p.rec.id);
    results.push(shape(p, extra));
    return true;
  };
  const ranked = (list) => [...list].sort((a, b) => merit(b) - merit(a) || String(b.rec.at).localeCompare(String(a.rec.at)));

  // 阶段 2：房间内按 loci 顺序（同分时 loci 小的在前——"房间里先看到的那几件"）
  const perRoom = Math.max(1, Math.ceil(cap / Math.max(1, roomPicks.length)) + 1);
  for (const pick of roomPicks) {
    const inRoom = ranked(prep.filter((p) => p.rec.room === pick.slug && p.base > 0));
    for (const p of inRoom.slice(0, perRoom)) push(p, { foundVia: 'room', roomScore: pick.score });
  }

  // 阶段 2b：loci 邻近（v0.3 · 3.4）
  //
  // 记忆宫殿的直觉：站在一个位置，隔壁的东西会自然浮出来。实现上就是——房间内
  // 某条被命中后，把它前后 2 个位置内的记录各补最多 1 条，标 foundVia='loci'。
  //
  // 为什么值得做：loci 顺序近似"事情发生的顺序"，相邻条目常是同一件事的上下文
  // （"选题"旁边就是"方向清单"）。为什么必须限量：它是**推测性**补充，不是命中；
  // 不限量就会把精确命中挤出结果集。总量上限 2 条。
  let lociBudget = 2;
  for (const pick of roomPicks) {
    if (lociBudget <= 0) break;
    const anchors = results.filter((r) => r.room === pick.slug && r.foundVia === 'room');
    for (const anchor of anchors) {
      if (lociBudget <= 0) break;
      const al = Number(anchor.loci);
      if (!Number.isFinite(al) || al <= 0) continue;
      const neighbors = ranked(
        prep.filter((p) => {
          const l = Number(p.rec.loci);
          return p.rec.room === pick.slug && Number.isFinite(l) && l > 0 && Math.abs(l - al) <= 2;
        }),
      );
      for (const nb of neighbors) {
        if (lociBudget <= 0) break;
        if (push(nb, { foundVia: 'loci', viaLoci: al })) lociBudget -= 1;
      }
    }
  }

  // 阶段 3：串门，一跳，上限 3 条。
  // 显式指定了 room 就**不串门**——那是个过滤器，不是个锚点。
  const doorsUsed = [];
  let doorBudget = explicitRoom ? 0 : 3;
  for (const pick of roomPicks) {
    if (doorBudget <= 0) break;
    const meta = palace.metaOf(pick.slug);
    for (const doorSlug of meta?.doors ?? []) {
      if (doorBudget <= 0) break;
      if (roomPicks.some((r) => r.slug === doorSlug)) continue;
      const inDoor = ranked(prep.filter((p) => p.rec.room === doorSlug && p.base > 0));
      if (inDoor.length === 0) continue;
      if (push(inDoor[0], { foundVia: 'door', viaDoorFrom: pick.slug })) {
        doorsUsed.push({ from: pick.slug, to: doorSlug });
        doorBudget -= 1;
      }
    }
  }

  // 阶段 4：全局兜底。同样只在**没有显式指定房间**时才跑——
  // 否则 `room` 就不是过滤器了（第一版正是如此：明明说"只在这个房间里搜"，
  // 却又把别房间的条目补了进来，schema 的承诺和代码行为对不上）。
  let fallback = 0;
  if (!explicitRoom && results.length < cap) {
    for (const p of ranked(prep.filter((p) => p.base > 0))) {
      if (results.length >= cap) break;
      if (push(p, { foundVia: 'global' })) fallback += 1;
    }
  }

  // 全 0 分：端上强度最高的，比空手强（但要标清楚是"没命中，按强度兜底"）
  if (results.length === 0) {
    for (const p of [...prep].sort((a, b) => b.retr - a.retr).slice(0, cap)) push(p, { foundVia: 'strength' });
  }

  return withMeta(results.slice(0, cap), {
    stage: explicitRoom ? 'room' : roomPicks.length > 0 ? 'palace' : 'global',
    roomsUsed: roomPicks.map((r) => r.slug),
    doorsUsed,
    fallback,
    explicitRoom,
    workspace: wantWs,
  });
}

/**
 * 加固：被召回**且确实用上了**之后调用。
 * 间隔效应：stability 变长 → 下次衰减更慢；strength 回升 → 当下更可信。
 */
export function reinforce({ ids = [] } = {}) {
  return touch(ids, (r) => {
    const st = strengthOf(r);
    const ease = Math.max(0.3, Math.min(1, st));
    const stability = stabilityOf(r) * (1 + 0.6 * ease);
    const now = Date.now();
    return {
      ...r,
      strength: Math.min(1, st + 0.15),
      stability,
      reps: (Number(r.reps) || 0) + 1,
      lastUsedAt: new Date(now).toISOString(),
      due: new Date(now + stability * DAY).toISOString(),
    };
  });
}

/** 削弱：被用户否定或证据推翻。stability 腰斩、strength 下掉、lapses+1。 */
export function weaken({ ids = [] } = {}) {
  return touch(ids, (r) => {
    const now = Date.now();
    const stability = Math.max(1, stabilityOf(r) * 0.4);
    return {
      ...r,
      strength: Math.max(0, strengthOf(r) - 0.25),
      stability,
      lapses: (Number(r.lapses) || 0) + 1,
      lastUsedAt: new Date(now).toISOString(),
      due: new Date(now + Math.max(1, stability * 0.5) * DAY).toISOString(),
    };
  });
}

function touch(ids, fn) {
  const want = new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? '').trim()).filter(Boolean));
  if (want.size === 0) throw new Error('需要 ids（数组）。先用 action="recall" 或 "list" 看 id。');
  const changed = [];
  for (const kind of KINDS) {
    const rows = readJsonl(fileFor(kind));
    let dirty = false;
    const next = rows.map((r) => {
      if (!want.has(r.id)) return r;
      dirty = true;
      const updated = fn(r);
      changed.push({
        id: r.id,
        strength: Number(Number(updated.strength).toFixed(3)),
        stability: Math.round(Number(updated.stability)),
        due: updated.due,
        reps: Number(updated.reps) || 0,
        lapses: Number(updated.lapses) || 0,
      });
      return updated;
    });
    if (dirty) rewriteJsonl(fileFor(kind), next);
  }
  return changed;
}

/** 到期清单：该复习/该重新确认的记忆。按逾期天数降序无关，按到期先后排。 */
export function dueList({ limit = 10 } = {}) {
  const now = Date.now();
  return listAll('all')
    .filter((r) => r.archived !== true)
    .map((r) => {
      const dueMs = Date.parse(r.due ?? '');
      const due = Number.isFinite(dueMs) ? dueMs : lastTouchMs(r) + stabilityOf(r) * DAY;
      return {
        ...r,
        due: new Date(due).toISOString(),
        _dueMs: due,
        retrievability: Number(retrievabilityOf(r, now).toFixed(3)),
        overdueDays: Math.round((now - due) / DAY),
      };
    })
    .filter((r) => r._dueMs <= now)
    .sort((a, b) => a._dueMs - b._dueMs)
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 10)))
    .map(({ _dueMs, ...rest }) => rest);
}

/**
 * 冷归档：把"已经想不起来、且确实很久没碰"的记录移进 cold.jsonl。
 *
 * **这是移动，不是删除。** 判据同时要求两条（R 很低 **且** 年龄超过一个
 * stability），因为只卡 R 会把"刚建但撞上长 stability"的条目误伤。
 * 任何一次判错都可以用 restore 捞回来。
 */
export function archiveCold({ threshold = COLD_THRESHOLD, dryRun = false } = {}) {
  const now = Date.now();
  const details = [];
  for (const kind of KINDS) {
    const rows = readJsonl(fileFor(kind));
    const keep = [];
    const cold = [];
    for (const r of rows) {
      const ageDays = (now - lastTouchMs(r)) / DAY;
      const rv = retrievabilityOf(r, now);
      const eligible = r.archived !== true && rv < threshold && ageDays > stabilityOf(r);
      if (eligible) {
        cold.push({
          ...r,
          archived: true,
          archivedAt: new Date(now).toISOString(),
          archivedFrom: kind,
          retrievabilityAtArchive: Number(rv.toFixed(4)),
        });
      } else {
        keep.push(r);
      }
    }
    if (cold.length === 0) continue;
    details.push(...cold.map((r) => ({ id: r.id, kind, retrievability: r.retrievabilityAtArchive })));
    if (!dryRun) {
      for (const r of cold) appendJsonl(COLD_FILE, r);
      rewriteJsonl(fileFor(kind), keep);
    }
  }
  return { archived: details.length, details, dryRun, file: COLD_FILE };
}

/** 冷档清单。 */
export function coldList({ limit = 20 } = {}) {
  let rows = [];
  try {
    rows = readJsonl(COLD_FILE);
  } catch {
    rows = [];
  }
  return rows
    .sort((a, b) => String(b.archivedAt ?? '').localeCompare(String(a.archivedAt ?? '')))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 20)));
}

/** 从冷档捞回（可逆性验证的唯一手段）。 */
export function restoreCold({ ids = [] } = {}) {
  const want = new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x ?? '').trim()).filter(Boolean));
  if (want.size === 0) return { restored: 0, note: '需要 ids。先用 action="cold" 看冷档里有什么。' };
  let all = [];
  try {
    all = readJsonl(COLD_FILE);
  } catch {
    return { restored: 0, note: '冷档文件读不到。' };
  }
  const keep = [];
  const back = [];
  for (const r of all) (want.has(r.id) ? back : keep).push(r);
  if (back.length === 0) return { restored: 0, note: '冷档里没有这些 id。' };

  const nowIsoStr = new Date().toISOString();
  for (const r of back) {
    const kind = KINDS.includes(r.archivedFrom) ? r.archivedFrom : 'fact';
    const revived = {
      ...r,
      archived: false,
      strength: 0.4,
      stability: stabilityOf({ ...r, kind }),
      lastUsedAt: nowIsoStr,
      due: new Date(Date.now() + 7 * DAY).toISOString(),
      restoredAt: nowIsoStr,
    };
    delete revived.archivedAt;
    delete revived.archivedFrom;
    delete revived.retrievabilityAtArchive;
    appendJsonl(fileFor(kind), revived);
  }
  rewriteJsonl(COLD_FILE, keep);
  return { restored: back.length, ids: back.map((r) => r.id), file: COLD_FILE };
}

function listAll(kind) {
  const kinds = kind === 'all' || !KINDS.includes(kind) ? KINDS : [kind];
  const out = [];
  for (const k of kinds) for (const r of readJsonl(fileFor(k))) out.push({ ...r, kind: r.kind ?? k });
  return out;
}

/**
 * 候选池大小。给埋点用：recall 内部自己扫全库，但不对外报"扫了多少条"，
 * 而"扫描 > 200 条算长记忆调用"这个口径需要它。单独读一次文件，
 * 代价可接受（几千行 JSONL 的量级）。
 */
export function countAll(kind = 'all') {
  try {
    return listAll(kind).length;
  } catch {
    return 0;
  }
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
  const all = [...facts, ...episodes];
  const last = all.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] ?? null;
  const now = Date.now();
  const due = all.filter((r) => {
    const d = Date.parse(r.due ?? '');
    return Number.isFinite(d) && d <= now;
  }).length;
  let cold = 0;
  try {
    cold = readJsonl(COLD_FILE).length;
  } catch {
    cold = 0;
  }
  const rooms = new Map();
  for (const r of all) if (r.room) rooms.set(r.room, (rooms.get(r.room) ?? 0) + 1);
  // 工作区标注统计（v0.3 · 3.2b）。`null` 单独计数：它们是"迁移前的旧记录"，
  // 不能悄悄算进某个工作区，否则会让人以为旧数据已经归好类了。
  const workspaces = new Map();
  let untagged = 0;
  for (const r of all) {
    const w = normalizeWorkspace(r.workspace);
    if (w === null) untagged += 1;
    else workspaces.set(w, (workspaces.get(w) ?? 0) + 1);
  }
  const avgR = all.length === 0 ? null : Number((all.reduce((s, r) => s + retrievabilityOf(r, now), 0) / all.length).toFixed(3));
  return {
    facts: facts.length,
    episodes: episodes.length,
    lastAt: last?.at ?? null,
    due,
    cold,
    avgRetrievability: avgR,
    rooms: [...rooms.entries()].sort((a, b) => b[1] - a[1]).map(([room, count]) => ({ room, count })),
    workspaces: [...workspaces.entries()].sort((a, b) => b[1] - a[1]).map(([workspace, count]) => ({ workspace, count })),
    untagged,
    tags: topTags(all),
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
