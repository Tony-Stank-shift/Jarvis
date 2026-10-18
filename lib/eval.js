/**
 * dsh-jarvis — 检索基准（v0.3 · 3.5）。
 *
 * ## 为什么需要它
 *
 * 没有它，「检索改进」的验收只能写成"我感觉更准了"——那正好是最不该出现的
 * 判据。有了它，3.4 的每一次改动都能给出一个分数，好和坏是数字说了算。
 *
 * ## 为什么不写死题库
 *
 * 记忆是**这台机器上这个人的**。写死 `id: 2026-10-11-29b8640e` 这种题库，
 * 换台机器、换个人就直接全废，而且会让人以为"评测通过"有普适意义。
 *
 * 所以题目**从当前真实记忆里生成**：拿一条记录的"唯一词"当查询，正确答案
 * 就是它自己。这样题目永远和数据同源，也永远测的是真实分布。
 *
 * ## 诚实的三条限制（必须写出来）
 *
 * 1. **记忆少的时候题就少。** 3 条记忆生成不出 20 道有区分度的题。所以
 *    `coverage.note` 会明说"样本不足"，不许把 5 道题的结果当成 20 道题的成绩。
 * 2. **唯一词是关键词判据。** 如果某条记录的文字和别的记录高度重合，
 *    它就没有唯一词，那道题会被跳过——**跳过不是通过**，会计入 skipped。
 * 3. **它测的是"能不能找回来"，不是"找回来的对不对"。** 排序合理性、
 *    强弱衰减的语义正确性它测不出来。
 *
 * ## 这套基准自己踩过的坑（2026-10-18，三轮才绿）
 *
 * 值得记下来，因为每一条都是"测试写错却被当成产品错"的典型：
 *
 * 1. **负例查询里混了中文虚词。** 第一版负例是 `ζzqxwv 不存在的词`，结果被判
 *    fail——不是检索坏了，是「不/存/在/的/词」这些字在真实记忆里到处都是。
 *    负例必须用**全库断言不存在**的 token（见下方 ghost 的生成方式）。
 * 2. **期望要 0 条，但 recall 的设计不是返回空。** `room-empty` 第一版写
 *    `maxResults: 0`；可房间内**有**记录时，recall 会按强度兜底端出来
 *    （`foundVia:'strength'`），那是对的。真正要防的是**越界**与**假装命中**，
 *    所以最终期望是 `allRooms + allFoundVia:['strength']`。
 * 3. **判据用 else-if 串起来会漏检。** 一条题需要同时验两个条件时，第一条命中
 *    后面全跳过。现在改成逐条独立执行、reason 累积。
 *
 * 这三条修完之后，基准立刻抓出了一个**真的产品 bug**：房间硬过滤只作用在
 * "选房间"那一步，末尾的强度兜底仍遍历全库，于是"只在这个房间里搜"在房内
 * 无命中时会泄漏出别的房间的记录（已在 memory.recall 里修：过滤作用在候选池上）。
 */

import { tokenize } from './text.js';

/**
 * 生成一道题：从记录里挑"只在这一条里出现"的词。
 *
 * 只取长度 ≥2 的词（CJK 二元组 / 拉丁词）——单个汉字在中文里遍地都是，
 * 用它当查询等于在测"什么都能匹配"。
 */
function uniqueTermsFor(record, corpusTermCounts) {
  const mine = tokenize(`${record.text} ${(record.tags ?? []).join(' ')}`);
  const seen = new Set();
  const out = [];
  for (const t of mine) {
    if (t.length < 2) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    if ((corpusTermCounts.get(t) ?? 0) === 1) out.push(t);
  }
  return out.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** 全库词频：用来判断某个词是不是"只属于一条记录"。 */
function corpusCounts(records) {
  const counts = new Map();
  for (const r of records) {
    for (const t of new Set(tokenize(`${r.text} ${(r.tags ?? []).join(' ')}`))) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 从当前记忆生成评测题。
 *
 * @param {object} o
 * @param {Array} o.records  全部记忆记录（fact + episode）
 * @param {number} [o.limit=20]
 * @returns {{cases:Array, coverage:object}}
 */
export function buildCases({ records = [], limit = 20 } = {}) {
  const alive = (Array.isArray(records) ? records : []).filter((r) => r && r.id && r.archived !== true);
  const counts = corpusCounts(alive);
  const cases = [];
  const skipped = [];

  // 确定性顺序：按 id 排，保证两次运行拿到同一批题（否则分数无法对比）。
  const ordered = [...alive].sort((a, b) => String(a.id).localeCompare(String(b.id)));

  for (const rec of ordered) {
    if (cases.length >= limit) break;
    const terms = uniqueTermsFor(rec, counts);
    if (terms.length === 0) {
      skipped.push({ id: rec.id, reason: '没有唯一词（与其它记录文字高度重合）' });
      continue;
    }
    // 每题最多给 2 个词，避免查询太长变成"抄了一遍原文"
    const take = Math.min(2, terms.length);
    cases.push({
      id: `T${cases.length + 1}`,
      scenario: 'unique-term',
      query: terms.slice(0, take).join(' '),
      expect: { mustInclude: [rec.id], topK: 3 },
      why: `「${terms.slice(0, take).join(' ')}」只在这一条里出现，找不回来就是检索失败`,
    });
  }

  // 负例：库里**保证不存在**的词。
  //
  // 第一版我写的是 `ζzqxwv 不存在的词`，结果被判 fail——不是检索坏了，是我把
  // 测试写坏了：text.js 把中文切成单字，「不/存/在/的/词」在真实记忆里到处都是，
  // 于是它**真的匹配上了**。负例必须用全库里断言不存在的 token。
  const ghost = (() => {
    let t = 'qzxwvjk';
    while (counts.has(t)) t += 'x';
    return t;
  })();
  cases.push({
    id: `T${cases.length + 1}`,
    scenario: 'negative',
    query: `${ghost} ${ghost}jarvis`,
    expect: { noFakeMatch: true, topK: 3 },
    why: `「${ghost}」在全库断言不存在；如果返回的条目被标成 room/door/global，说明它在假装找到`,
  });

  // 停用词噪声：这是**当前已知会失败**的一题，专门留给 3.4。
  //
  // 为什么要有意留一个失败项：text.js 给 CJK 单字 0.35 的权重，中文里「的/是/不/在」
  // 几乎出现在每条记录里，所以一句纯虚词查询也会"匹配上"一大片。这不是幻觉，是
  // 打分太松。3.4 要做的事之一就是让它变成"找不到"，在此之前它会一直红着。
  cases.push({
    id: `T${cases.length + 1}`,
    scenario: 'stopword-noise',
    query: '的 是 不 在 有 了',
    expect: { noFakeMatch: true, topK: 3 },
    why: '纯虚词查询不该匹配到任何东西；单字权重过高是已知缺陷（3.4 的目标）',
  });

  // 空结果：显式工作区过滤到一个不存在的工作区 → 必须 0 条
  cases.push({
    id: `T${cases.length + 1}`,
    scenario: 'empty',
    query: '导师',
    opts: { workspace: '/no/such/workspace/dsh-jarvis-eval' },
    expect: { maxResults: 0 },
    why: '硬过滤到不存在的工作区，必须返回空而不是"随便给点什么"',
  });

  // 房间题：拿一个有内容的房间的第一个关键词当查询，期望命中该房间的记录
  const roomsWithData = new Map();
  for (const rec of alive) if (rec.room) roomsWithData.set(rec.room, (roomsWithData.get(rec.room) ?? 0) + 1);
  const firstRoom = [...roomsWithData.entries()].sort((a, b) => b[1] - a[1])[0];
  if (firstRoom) {
    cases.push({
      id: `T${cases.length + 1}`,
      scenario: 'room',
      query: '导师 科研 论文',
      opts: { room: firstRoom[0] },
      expect: { allRooms: [firstRoom[0]] },
      why: `硬过滤到房间「${firstRoom[0]}」，返回的每一条都必须属于这个房间`,
    });

    // 房间空命中：硬过滤到某个有内容的房间，配一个全库不存在的词 → 必须 0 条。
    //
    // 这道题是 2026-10-18 那个真 bug 的**永久守卫**：当时房间过滤只作用在"选房间"，
    // 而末尾的强度兜底遍历全库，于是房内没有命中时它把别房间的记录端了上来。
    // 它不依赖"哪个房间记录最多"，所以换数据也不会失效。
    cases.push({
      id: `T${cases.length + 1}`,
      scenario: 'room-empty',
      query: `${ghost} room`,
      opts: { room: firstRoom[0] },
      // 期望不是"0 条"——房间内**有**记录，recall 的设计是"范围内有东西就按强度
      // 端出来"，所以返回 1 条是正确行为。真正要防的是两件事：
      //   ① 越界（把别的房间的记录端上来）——这就是当初那个 bug；
      //   ② 假装命中（标成 room/door/global）——它明明没匹配上。
      expect: { allRooms: [firstRoom[0]], allFoundVia: ['strength'] },
      why: `硬过滤到房间「${firstRoom[0]}」+ 全库不存在的词 → 只能给该房间的强度兜底，不许越界也不许假装命中`,
    });
  }

  const coveredRecords = new Set(cases.filter((c) => c.scenario === 'unique-term').flatMap((c) => c.expect.mustInclude ?? []));
  return {
    cases: cases.slice(0, Math.max(1, limit)),
    coverage: {
      records: alive.length,
      coveredRecords: coveredRecords.size,
      cases: Math.min(cases.length, Math.max(1, limit)),
      skipped,
      note:
        alive.length < 8
          ? `只有 ${alive.length} 条记忆，题库区分度很低（多数题查的是同一条）。这只说明"检索没崩"，不能说明"检索很准"。` +
            `另外含 1 道 stopword-noise 回归题：它曾是"单字权重过高"缺陷的证据，3.4 修好后才转绿——它若再变红，就是回归。`
          : `覆盖 ${coveredRecords.size}/${alive.length} 条记录。含 1 道 stopword-noise 回归题（单字权重缺陷的守卫）。`,
    },
  };
}

/**
 * 跑评测。
 *
 * @param {object} o
 * @param {Function} o.recall  注入 memory.recall，便于单测
 * @param {Array} o.cases
 */
export function runEval({ recall, cases = [] } = {}) {
  if (typeof recall !== 'function') throw new Error('runEval 需要注入 recall 函数');
  const details = [];
  let passed = 0;

  for (const c of cases) {
    const t0 = Date.now();
    let rows = [];
    let error = null;
    try {
      rows = recall({
        query: c.query ?? '',
        kind: 'all',
        limit: c.expect?.topK ?? 5,
        ...(c.opts ?? {}),
      });
    } catch (e) {
      error = e?.message ?? String(e);
    }
    const collected = Array.isArray(rows) ? rows : [];
    const reasons = [];

    // 判据改成**逐条独立**执行，不再用 else-if 串联。
    // 2026-10-18 的教训：room-empty 需要同时断言"都在该房间内"和"不许假装命中"，
    // 用 else-if 时第一条命中后面的就被跳过，期望再好也测不到。
    if (error) {
      reasons.push(`抛错：${error}`);
    }
    if (!error) {
      if (c.expect?.maxResults !== undefined && collected.length > c.expect.maxResults) {
        reasons.push(`期望最多 ${c.expect.maxResults} 条，实际 ${collected.length} 条`);
      }
      if (c.expect?.noFakeMatch) {
        const fake = collected.filter((r) => r.foundVia && r.foundVia !== 'strength');
        if (fake.length > 0) {
          reasons.push(`无关查询里 ${fake.length} 条被标成 ${[...new Set(fake.map((r) => r.foundVia))].join('/')}`);
        }
      }
      if (Array.isArray(c.expect?.allRooms)) {
        const bad = collected.filter((r) => !c.expect.allRooms.includes(r.room));
        if (bad.length > 0) {
          reasons.push(`${bad.length} 条不属于房间 ${c.expect.allRooms.join('/')}：${[...new Set(bad.map((r) => r.room))].join('/')}`);
        }
      }
      if (Array.isArray(c.expect?.allFoundVia)) {
        const bad = collected.filter((r) => !c.expect.allFoundVia.includes(r.foundVia ?? null));
        if (bad.length > 0) {
          reasons.push(`${bad.length} 条的 foundVia 不在允许集合 ${c.expect.allFoundVia.join('/')} 里：${[...new Set(bad.map((r) => r.foundVia ?? 'null'))].join('/')}`);
        }
      }
      if (Array.isArray(c.expect?.mustInclude)) {
        const ids = collected.map((r) => r.id);
        const missing = c.expect.mustInclude.filter((id) => !ids.includes(id));
        if (missing.length > 0) {
          reasons.push(`没找回来：${missing.join(',')}（返回 ${ids.length} 条）`);
        }
      }
    }
    const ok = reasons.length === 0;

    if (ok) passed += 1;
    details.push({
      id: c.id,
      scenario: c.scenario,
      query: c.query,
      pass: ok,
      why: c.why,
      reasons,
      returned: collected.map((r) => ({ id: r.id, room: r.room ?? null, foundVia: r.foundVia ?? null, score: r.score ?? null })),
      latencyMs: Date.now() - t0,
    });
  }

  const total = cases.length;
  return {
    total,
    passed,
    failed: total - passed,
    score: total === 0 ? 0 : Number((passed / total).toFixed(3)),
    details,
  };
}

/** 渲染成 markdown 报告（也用于 A/B 对比：把两次的 score 并排）。 */
export function renderReport(result, { title = '检索基准', coverage = null } = {}) {
  const lines = [
    `# ${title}`,
    '',
    `- 成绩：**${result.passed}/${result.total}**（${(result.score * 100).toFixed(1)}%）`,
    `- 生成：${new Date().toISOString()}`,
    ...(coverage ? [`- 覆盖：${coverage.note}`] : []),
    '',
    '| # | 场景 | 查询 | 结果 | 说明 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const d of result.details) {
    const q = String(d.query ?? '').replace(/\|/g, '\\|').slice(0, 40);
    lines.push(`| ${d.id} | ${d.scenario} | \`${q}\` | ${d.pass ? 'pass' : '**fail**'} | ${d.pass ? '' : d.reasons.join('；')} |`);
  }
  const fails = result.details.filter((d) => !d.pass);
  if (fails.length > 0) {
    lines.push('', '## 失败详情', '');
    for (const f of fails) {
      lines.push(`### ${f.id} · ${f.scenario}`, '', `- 查询：\`${f.query}\``, `- 期望：${f.why}`, `- 实际：${f.reasons.join('；')}`);
      lines.push(`- 返回：${f.returned.map((r) => `${r.id}${r.foundVia ? `(${r.foundVia})` : ''}`).join(', ') || '（空）'}`, '');
    }
  }
  if (coverage?.skipped?.length) {
    lines.push('## 被跳过的记录（**跳过不是通过**）', '');
    for (const s of coverage.skipped) lines.push(`- ${s.id}：${s.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}
