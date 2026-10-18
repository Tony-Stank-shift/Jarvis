/**
 * dsh-jarvis — 记忆宫殿：房间 / 位置 / 门。
 *
 * ## 为什么是"宫殿"，不是"标签云"
 *
 * 用户提的记忆宫殿（method of loci）对人有效，靠的是"编码时被迫生成鲜明图像"。
 * AI 拿不到那个收益。能迁移过来的是它的**结构**：
 *
 *   1. 层次分类（房间）——先把候选池从"全库"缩到"一个房间"；
 *   2. 固定顺序遍历（loci）——按顺序读一整个房间，得到的是一份**连贯的领域
 *      上下文**，而不是 top-k 碎片，这比多召回几条有用得多；
 *   3. 跨房间的门（doors）——"顺带一提"的跨域联想，是宫殿法真正的价值。
 *
 * 所以本文件只做结构，不做语义：它不知道哪条记忆"更重要"，那是强度模型
 * （strength/stability）的事，属于 v0.2 的下一小项。
 *
 * ## 三条硬约束
 *
 * 1. **facts.jsonl / episodes.jsonl 是唯一真相源。** `palace/<房间>/ROOM.md`
 *    全是派生视图，随时可整份重建，手改会被覆盖（文件头也这么写）。
 * 2. **分类错了不能变成隐形。** 所以检索在 v0.2 里永远保留"全局兜底"；
 *    房间只是加权，不是过滤器。
 * 3. **空房间要能容忍。** 不预先创建 8 个空目录；只给有内容的房间生成视图，
 *    没有内容的房间只出现在 INDEX.md 里，标 0 条。
 *
 * ## 已知局限
 *
 * - `autoRoom` 是关键词打分，不是语义理解。它一定会分错一些，所以
 *   `remember` 允许显式 `room`；迁移旧记录时不猜，直接进 `inbox` 等人拍板。
 * - 房间名改了会导致老记录的房间字段悬空。`organize` 会把找不到定义的房间
 *   当独立房间保留（不静默改写），并在 INDEX.md 里标成「未定义」。
 */

import { join } from 'node:path';
import { ensureDir, nowIso, paths, readJson, readJsonl, rewriteJsonl, slugify, writeJson, writeText } from './store.js';

/**
 * 固定房间。
 *
 * 取舍记录：**没有给丘赛单开房间**（用户 2026-10-17 决定"暂时不需要"）。
 * 丘赛相关的记忆先归 `A-课内`（点集拓扑、抽象代数目前都是课内数学的延伸）。
 * 将来要开 `C-数学` 时，只需在这里加一条，再用 `jarvis_memory(action="move")`
 * 批量迁移即可——所以下面的 keywords 里保留了数学相关词。
 *
 * `人` 房间被用户明确保留：它存情绪和状态，**永远不和学术房间混**。
 */
export const ROOMS = [
  {
    slug: 'A-课内',
    label: 'A 课内（GPA / 排名）',
    desc: '课程、绩点、作业、考试、选课、成绩；数学类（含丘赛基础：点集拓扑、抽象代数）暂放这里',
    keywords: ['课程', '课内', 'GPA', '绩点', '学分', '作业', '期中', '期末', '考试', '成绩', '选课', '分数', '高数', '线代', '线性代数', '概率', '数值分析', '大物', '离散', '点集拓扑', '抽象代数', '群论', '实分析', '测度'],
    doors: ['B-科研', '升学'],
  },
  {
    slug: 'B-科研',
    label: 'B 科研与论文',
    desc: '导师、论文、课题、组会、实验、投稿、复现',
    keywords: ['导师', '科研', '论文', '课题', '组会', '实验室', '投稿', '审稿', '复现', '综述', 'arxiv', 'AI4S', '方向清单'],
    doors: ['升学', 'D-AI全栈'],
  },
  {
    slug: 'D-AI全栈',
    label: 'D AI 全栈',
    desc: '技术栈、代码、工具、环境、报错、部署、插件',
    keywords: ['代码', 'python', '报错', '部署', 'git', '环境', '依赖', 'pip', 'npm', '模型', '训练', '推理', 'API', '插件', 'DSH', '调试', '脚本'],
    doors: ['B-科研'],
  },
  {
    slug: '升学',
    label: '升学（创智 / 保研 / 夏令营）',
    desc: '创智直博、保研、推免、夏令营、预推免、材料、推荐信、面试',
    keywords: ['创智', '保研', '推免', '夏令营', '预推免', '直博', '申请', '简历', '推荐信', '面试', '<名校A>', '<名校B>', '报备', '回避', '细则', '通知'],
    doors: ['B-科研', 'A-课内'],
  },
  {
    slug: '人',
    label: '人与状态（私密）',
    desc: '情绪、状态、作息、身体、家人朋友。刻意与学术分开：把"今天很烦"和"GPA 在下滑"混一个池子，检索会互相污染',
    keywords: ['累', '烦', '焦虑', '压力', '开心', '难过', '睡', '作息', '身体', '生病', '家人', '朋友', '情绪', '状态', '心情'],
    doors: [],
  },
  {
    slug: '规则',
    label: '规则与红线',
    desc: '协议、红线、偏好、习惯。内容以 profile.md / rules.md 为准，本房间只存"什么时候该去看它们"',
    keywords: ['红线', '协议', '规则', '偏好', '习惯', '不许', '必须', '禁止', '审批'],
    doors: [],
  },
  {
    slug: 'inbox',
    label: '收件箱',
    desc: '放不进任何房间的记忆。每周整理一次：要么归位，要么承认它不重要',
    keywords: [],
    doors: [],
  },
];

/** 项目房间的固定前缀；`项目-<名字>` 是唯一的动态房间形态。 */
export const PROJECT_PREFIX = '项目-';
const INBOX = 'inbox';

const BY_SLUG = new Map(ROOMS.map((r) => [r.slug, r]));

function norm(s) {
  return String(s ?? '').trim();
}

/** 房间定义（固定房间或项目房间）。返回 null 表示这个名字既不是固定房间也不像项目房间。 */
export function metaOf(name) {
  const key = norm(name);
  if (key === '') return null;
  const hit = BY_SLUG.get(key);
  if (hit) return hit;
  // 允许简写：`A-课内` 可写 `课内`，`B 科研与论文` 可写 `科研`、`B 科研与论文`。
  // 只做确定性匹配，不做模糊搜索——匹配不上就报错并列出可选项，
  // 而不是猜一个"相近"的房间（猜错会让记忆在房间视图里隐形）。
  for (const room of ROOMS) {
    const short = room.slug.includes('-') ? room.slug.slice(room.slug.indexOf('-') + 1) : room.slug;
    if (key === room.label || key === short) return room;
  }
  if (key.startsWith(PROJECT_PREFIX) && key.length > PROJECT_PREFIX.length) {
    return {
      slug: key,
      label: key.slice(PROJECT_PREFIX.length),
      desc: '某个进行中项目的专属房间（动态生成，不属于固定房间）',
      keywords: [],
      doors: [],
      dynamic: true,
    };
  }
  return null;
}

export function resolveRoom(name) {
  return metaOf(name);
}

/**
 * 自动归房：关键词打分。
 *
 * 打分 = 命中关键词长度之和（越长越具体，"点集拓扑" 应该压过 "课"）。
 * 平手时按 ROOMS 顺序取靠前的——确定性行为，便于复现，不是"智能"。
 * 一个房间都没命中 → inbox。**宁可进收件箱，也不硬塞一个错的房间。**
 *
 * 踩过的坑（2026-10-17，冒烟测试抓到）：第一版把**导师的名字**写进了
 * B-科研 的关键词，结果"推免 + 导师名字 + 回避报备"这条升学记忆被判进
 * 科研——因为人名有 3 个字，权重压过了「推免」「报备」这两个真正的领域词。
 * 教训写在这里：**房间关键词只放领域词，不放人名**。人名天然跨房间
 * （她既是导师，也是推荐信/报备关系里的当事人），那正是"门"该表达的。
 *
 * `margin` 是第一名与第二名的分差。分差很小时（例如 5 : 4）这次归房
 * 基本是抛硬币——`confident` 会为 false，调用方应把它当"待确认"而不是结论。
 */
export function autoRoom({ text = '', tags = [], hint = '' } = {}) {
  const hay = `${text} ${(Array.isArray(tags) ? tags : []).join(' ')} ${hint}`.toLowerCase();
  let best = { slug: INBOX, score: 0, matched: [] };
  let second = 0;
  for (const room of ROOMS) {
    let s = 0;
    const matched = [];
    for (const kw of room.keywords) {
      if (kw && hay.includes(String(kw).toLowerCase())) {
        s += Math.min(8, String(kw).length);
        matched.push(kw);
      }
    }
    if (s > best.score) {
      second = best.score;
      best = { slug: room.slug, score: s, matched };
    } else if (s > second) {
      second = s;
    }
  }
  const margin = best.score - second;
  return {
    slug: best.slug,
    score: best.score,
    second,
    margin,
    matched: best.matched,
    confident: best.score >= 4 && margin >= 2,
  };
}

/** 读某条轨道的全部记录（facts 或 episodes），统一带上 kind。 */
function trackRows(kind) {
  const file = kind === 'episode' ? paths.episodes : paths.facts;
  return readJsonl(file).map((r) => ({ ...r, kind: r.kind ?? kind }));
}

export function allRecords() {
  return [...trackRows('fact'), ...trackRows('episode')];
}

/** 某个房间的下一个位置编号（append 即"把新东西放在队尾"）。 */
export function nextLoci(roomSlug) {
  let max = 0;
  for (const r of allRecords()) {
    if (r.room !== roomSlug) continue;
    const n = Number(r.loci);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** 按房间分组；没有 room 字段的（迁移前的旧记录）算作 inbox 待分。 */
export function groupByRoom() {
  const byRoom = new Map();
  const legacy = [];
  for (const r of allRecords()) {
    const room = norm(r.room);
    if (room === '') {
      legacy.push(r);
      continue;
    }
    if (!byRoom.has(room)) byRoom.set(room, []);
    byRoom.get(room).push(r);
  }
  for (const arr of byRoom.values()) {
    arr.sort((a, b) => (Number(a.loci) || 0) - (Number(b.loci) || 0) || String(a.at).localeCompare(String(b.at)));
  }
  return { byRoom, legacy };
}

function roomDir(slug) {
  return join(paths.palaceDir, slugify(slug, 'room'));
}

function readDoorplate(slug) {
  const j = readJson(join(roomDir(slug), 'room.json'), null);
  return typeof j?.doorplate === 'string' ? j.doorplate : '';
}

/** 写一扇房门的一句话描述。 */
export function setDoorplate({ room, doorplate = '' } = {}) {
  const meta = metaOf(room);
  if (!meta) throw new Error(`不认识这个房间："${room}"。先用 jarvis_memory(action="rooms") 看有哪些。`);
  ensureDir(roomDir(meta.slug));
  writeJson(join(roomDir(meta.slug), 'room.json'), { slug: meta.slug, doorplate: String(doorplate ?? ''), updatedAt: nowIso() });
  return { slug: meta.slug, doorplate: String(doorplate ?? '') };
}

function oneLine(text, n = 260) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function renderRoom(meta, rows) {
  const facts = rows.filter((r) => r.kind === 'fact');
  const episodes = rows.filter((r) => r.kind === 'episode');
  const doors = (meta.doors ?? []).map((d) => {
    const m = BY_SLUG.get(d);
    return m ? `- → \`${m.slug}\` ${m.label}` : `- → \`${d}\``;
  });
  const plate = readDoorplate(meta.slug);
  const lines = [
    `# 房间 · ${meta.label}`,
    '',
    `> ${meta.desc}`,
    `> 门牌：${plate === '' ? '（未填写）' : plate}`,
    '',
    `本文件由 \`jarvis_memory(action="organize")\` 从 \`memory/facts.jsonl\` + \`memory/episodes.jsonl\` 重建。`,
    `**手改会被覆盖**——要改内容请改那两份 JSONL，要改房间定义请改 \`lib/palace.js\`。`,
    '',
    `生成时间：${nowIso()}　｜　位置 ${rows.length} 个（事实 ${facts.length} / 情节 ${episodes.length}）`,
    '',
    '## 位置（loci，按顺序）',
    '',
  ];
  if (rows.length === 0) lines.push('_（空房间。空着不是坏事，说明这块本来就没什么要记。）_', '');
  const push = (list, title) => {
    if (list.length === 0) return;
    lines.push(`### ${title}`, '');
    for (const r of list.slice(0, 200)) {
      lines.push(`${Number(r.loci) || 0}. \`${r.id}\`｜${String(r.at ?? '').slice(0, 10)}｜${oneLine(r.text)}`);
    }
    if (list.length > 200) lines.push('', `_（还有 ${list.length - 200} 条未列出，用检索取。）_`);
    lines.push('');
  };
  push(facts, '事实（长期有效）');
  push(episodes, '情节（会过期）');
  lines.push('## 门（通往相邻房间）', '');
  lines.push(...(doors.length ? doors : ['_（这扇门单独存在，不连别的房间。）_']));
  lines.push('');
  return lines.join('\n');
}

function renderIndex(list) {
  const lines = [
    '# 记忆宫殿 · 房间索引',
    '',
    `> 生成：${nowIso()}　｜　由 \`jarvis_memory(action="organize")\` 重建，手改会被覆盖。`,
    '',
    '| 房间 | 事实 | 情节 | 门 | 门牌 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of list) {
    const plate = readDoorplate(r.slug) || '—';
    lines.push(`| \`${r.slug}\` ${r.label} | ${r.facts} | ${r.episodes} | ${(r.doors ?? []).join(' / ') || '—'} | ${oneLine(plate, 60)} |`);
  }
  if (list.some((r) => r.undefinedRoom)) {
    lines.push('', '> 标「未定义」的房间：`lib/palace.js` 里已经没有对应定义了，但记忆里还有条目。');
    lines.push('> 不会静默改写——要么在 ROOMS 里补回定义，要么用 `jarvis_memory(action="move")` 迁走。');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 重建所有房间视图。
 *
 * 只给**有内容**的房间写 ROOM.md（空房间不建目录，否则三个月后就是 30 个空目录）；
 * 所有已知房间都进 INDEX.md，空的就是 0 条——"空"本身是信息。
 */
export function rebuildViews() {
  ensureDir(paths.palaceDir);
  const { byRoom, legacy } = groupByRoom();
  const list = [];
  const written = [];

  for (const room of ROOMS) {
    const rows = byRoom.get(room.slug) ?? [];
    list.push({ ...room, facts: rows.filter((r) => r.kind === 'fact').length, episodes: rows.filter((r) => r.kind === 'episode').length });
    if (rows.length > 0) {
      const file = join(roomDir(room.slug), 'ROOM.md');
      writeText(file, renderRoom(room, rows));
      written.push(file);
    }
  }

  for (const [slug, rows] of byRoom.entries()) {
    if (BY_SLUG.has(slug)) continue;
    const meta = metaOf(slug) ?? { slug, label: slug, desc: '（未定义房间）', doors: [], keywords: [], undefinedRoom: true };
    list.push({ ...meta, facts: rows.filter((r) => r.kind === 'fact').length, episodes: rows.filter((r) => r.kind === 'episode').length });
    const file = join(roomDir(slug), 'ROOM.md');
    writeText(file, renderRoom(meta, rows));
    written.push(file);
  }

  const indexFile = join(paths.palaceDir, 'INDEX.md');
  writeText(indexFile, renderIndex(list));
  return { indexFile, written, rooms: list, legacyCount: legacy.length, total: allRecords().length };
}

/**
 * 迁移：给没有 room 字段的旧记录定房间并编号。
 *
 * **刻意不猜。** `assignments` 里给了就按给的；没给的进 `inbox`。
 * 理由：分错房间的记忆在房间视图里是隐形的，比留在 inbox 更危险；
 * 而 inbox 的语义是"我知道这条没归位"，是可以被每周整理消耗掉的债务。
 *
 * @param {object} o
 * @param {Record<string,string>} [o.assignments] id → 房间名
 */
export function migrateLegacy({ assignments = {} } = {}) {
  const { legacy } = groupByRoom();
  if (legacy.length === 0) return { migrated: 0, toInbox: 0, assigned: 0, details: [] };

  const details = [];
  const patched = new Map();
  // 按时间正序分配 loci，保证"位置顺序"等于"记忆发生顺序"
  const sorted = [...legacy].sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  for (const r of sorted) {
    const want = norm(assignments[r.id]);
    const meta = want !== '' ? metaOf(want) : null;
    const room = meta ? meta.slug : INBOX;
    const entry = { id: r.id, room, explicit: Boolean(meta) };
    details.push(entry);
    patched.set(r.id, room);
  }

  for (const kind of ['fact', 'episode']) {
    const file = kind === 'episode' ? paths.episodes : paths.facts;
    const rows = readJsonl(file);
    let changed = false;
    // 注意：必须基于**已处理过的** next 来算下一个空位，否则同一房间的多条
    // 旧记录会全部拿到同一个 loci（第一版就是这个 bug）。
    const next = [];
    for (const r of rows) {
      if (norm(r.room) !== '') {
        next.push(r);
        continue;
      }
      const room = patched.get(r.id) ?? INBOX;
      changed = true;
      next.push({ ...r, room, loci: nextLociWithin(next, room) });
    }
    if (changed) rewriteJsonl(file, next);
  }

  return {
    migrated: details.length,
    assigned: details.filter((d) => d.explicit).length,
    toInbox: details.filter((d) => !d.explicit).length,
    details,
  };
}

/** 在给定记录集内部算某房间下一个空位（迁移时用，避免反复读盘）。 */
function nextLociWithin(rows, room) {
  let max = 0;
  for (const r of rows) {
    if (r.room !== room) continue;
    const n = Number(r.loci);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** 房间清单（含计数与内容健康度）。 */
export function listRooms() {
  const { byRoom, legacy } = groupByRoom();
  const out = ROOMS.map((room) => {
    const rows = byRoom.get(room.slug) ?? [];
    return {
      slug: room.slug,
      label: room.label,
      desc: room.desc,
      doors: room.doors ?? [],
      facts: rows.filter((r) => r.kind === 'fact').length,
      episodes: rows.filter((r) => r.kind === 'episode').length,
      doorplate: readDoorplate(room.slug),
    };
  });
  for (const [slug, rows] of byRoom.entries()) {
    if (BY_SLUG.has(slug)) continue;
    out.push({
      slug,
      label: metaOf(slug)?.label ?? slug,
      desc: metaOf(slug)?.desc ?? '（未定义房间）',
      doors: [],
      facts: rows.filter((r) => r.kind === 'fact').length,
      episodes: rows.filter((r) => r.kind === 'episode').length,
      undefinedRoom: !metaOf(slug),
    });
  }
  return { rooms: out, legacyCount: legacy.length };
}

/**
 * organize：迁移 + 重建视图。这是唯一会写 ROOM.md 的入口。
 *
 * @param {object} o
 * @param {Record<string,string>} [o.assignments]
 */
export function organize({ assignments = {} } = {}) {
  const migrated = migrateLegacy({ assignments });
  const rebuilt = rebuildViews();
  return { ...rebuilt, migrated };
}
