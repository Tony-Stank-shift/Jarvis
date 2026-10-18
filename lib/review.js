/**
 * dsh-jarvis — 第三方评审的可执行版（v0.3 · 3.3）。
 *
 * ## 这个文件要解决的真正问题
 *
 * 之前"第三方检查"只写在技能文档里，是一段散文：「以独立、对抗性的立场复核，
 * 默认找茬」。这种话**无法判定**——我可以说我找过茬了，你无法反驳。
 *
 * 这里把它换成：一份固定的检查清单（每条都有明确的 fail 条件）+ 一份落盘的
 * REVIEW.md（含产物指纹与复现命令）。判不了"对不对"，但判得了"有没有按清单做、
 * 依据是不是可复现的"。
 *
 * ## 诚实的边界
 *
 * **这不是独立的第三方。** 评审者还是我，同一个模型、同一个上下文。真正的独立
 * 评审需要另一个会话/模型（Agent Teams 或任务看板），那要花配额，不在本项范围内。
 * 所以每份 REVIEW.md 的抬头都写死这句话，不许含糊。
 *
 * 它有价值的部分是：清单是固定的（不能临时改标准）、依据必须是可复现的
 * （命令/文件:行号/退出码）、产物指纹是哈希（改了就对不上）。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, localDate, nowIso, paths, readText, sha256, writeText } from './store.js';

/**
 * 固定检查清单。**故意不提供"自定义检查项"接口**：能改标准就等于没有标准。
 *
 * 每条都有 `failIf`——什么情况算不合格。没有 fail 条件的检查项只是口号。
 */
export const CHECKS = [
  {
    id: 'C1',
    q: '验收判据是否逐条对照，而不是一句"完成了"',
    how: '回看 WBS 里该小项的 acceptance 列表，逐条给 pass/fail/na',
    failIf: '有判据没出现在判定里，或用"基本完成""应该没问题"代替',
  },
  {
    id: 'C2',
    q: '每条依据是否可复现',
    how: '依据必须是：命令+退出码 / 文件路径:行号 / 工具返回值片段 / URL',
    failIf: '依据是"我看了一下""逻辑上应该"这类无法复现的说法',
  },
  {
    id: 'C3',
    q: '标注为"真"的引用是否被机器核验过',
    how: '跑 jarvis_verify；行号越界与文件缺失必须为零',
    failIf: '存在 out-of-range 或 missing，或有引用从未被核验',
  },
  {
    id: 'C4',
    q: '有没有"结论先行、出处缺失"的断言',
    how: '逐句问：这句话如果错了，怎么发现？',
    failIf: '有事实性断言给不出处，却也没标 [未核实]',
  },
  {
    id: 'C5',
    q: '有没有未验证的副作用或依赖',
    how: '列出所有写盘、外网、后台进程、新依赖，逐个问"验过没有"',
    failIf: '存在副作用/依赖却既没验证也没写进"未验证的部分"',
  },
  {
    id: 'C6',
    q: '是否触及四条红线，且是否取得同意',
    how: '外网 / 下载安装 / 工作区写入 / 训练，逐项核对',
    failIf: '触及了却没拿到当次同意，或"上次同意过"被当作本次同意',
  },
  {
    id: 'C7',
    q: '有没有反退化征兆',
    how: '同一文件连续 ±1 行微调 >2 次 / 同一工具同一文件失败 ≥2 次 / 思考里重复同一说法 ≥3 次',
    failIf: '出现上述任一，却没有停下来换方法',
  },
  {
    id: 'C8',
    q: '剩余风险是否写明，包括"没验证的部分"',
    how: '读 risk 字段：里面有没有具体到"哪个文件/哪个场景"',
    failIf: 'risk 是空的，或只有"暂无"这种敷衍',
  },
  {
    id: 'C9',
    q: '有没有留下可回滚的痕迹',
    how: '覆盖/迁移/归档/删改前是否有备份、冷档、旧值记录',
    failIf: '改了数据却没有回滚路径',
  },
];

const VERDICTS = new Set(['pass', 'fail', 'na']);

export function listChecks() {
  return CHECKS.map((c) => ({ ...c }));
}

function shortHashOfFile(file) {
  try {
    const text = readText(file, '');
    return { sha256: sha256(text).slice(0, 16), bytes: Buffer.byteLength(text, 'utf8') };
  } catch {
    return { sha256: null, bytes: null };
  }
}

/**
 * 落盘一份评审记录。
 *
 * @param {object} o
 * @param {string} o.slug     项目 slug（决定目录）
 * @param {string} o.name     项目名
 * @param {string} [o.target] 本次评审的对象（例："小项 1.4 rcs.py + Mie 对比"）
 * @param {Array<{id:string, verdict:string, evidence?:string}>} o.items
 * @param {string[]} [o.reproduce] 复现命令
 * @param {string} [o.summary]    总裁决说明
 * @param {string[]} [o.artifacts] 要计入指纹的文件（绝对路径）
 */
export function writeReview({ slug, name = '', target = '', items = [], reproduce = [], summary = '', artifacts = [] } = {}) {
  const cleanSlug = String(slug ?? '').trim();
  if (cleanSlug === '') throw new Error('writeReview 需要 slug（项目标识）');
  // slug 会被直接拼进路径。不校验就能 `../x` 写穿 projects 目录
  // （自审 2026-10-18 发现的 F1：虽然还落在 ~/.dsh/jarvis 内，但仍是缺陷）。
  if (/[\\/]/.test(cleanSlug) || cleanSlug.includes('..') || cleanSlug === '.') {
    throw new Error(`slug 不能含路径分隔符或 ..：${JSON.stringify(cleanSlug)}`);
  }
  const dir = join(paths.projectsDir, cleanSlug);
  ensureDir(dir);

  const byId = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const id = String(it?.id ?? '').trim().toUpperCase();
    const verdict = String(it?.verdict ?? '').trim().toLowerCase();
    if (!/^C\d+$/.test(id)) throw new Error(`检查项 id 必须形如 C1：收到 ${JSON.stringify(it?.id)}`);
    if (!VERDICTS.has(verdict)) throw new Error(`检查项 ${id} 的 verdict 必须是 pass/fail/na：收到 ${JSON.stringify(it?.verdict)}`);
    byId.set(id, { verdict, evidence: String(it?.evidence ?? '').trim() });
  }

  const missing = CHECKS.filter((c) => !byId.has(c.id)).map((c) => c.id);
  const fails = CHECKS.filter((c) => byId.get(c.id)?.verdict === 'fail').map((c) => c.id);
  const noEvidence = CHECKS.filter((c) => {
    const v = byId.get(c.id);
    return v && v.verdict !== 'na' && v.evidence === '';
  }).map((c) => c.id);

  const overall = fails.length > 0 ? 'fail' : missing.length > 0 ? 'incomplete' : 'pass';

  const fps = (Array.isArray(artifacts) ? artifacts : [])
    .filter((f) => typeof f === 'string' && f.trim() !== '')
    .map((f) => {
      const abs = f.trim();
      const exists = existsSync(abs);
      const { sha256: h, bytes } = exists ? shortHashOfFile(abs) : { sha256: null, bytes: null };
      return { path: abs, exists, sha256: h, bytes };
    });

  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stampStr = `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  // 自审 F2（2026-10-18）：原来只精确到分钟，同一分钟内第二次评审会**静默覆盖**
  // 第一次的结论——评审记录被覆盖是最不该发生的一种数据丢失。现在精确到秒并加序号。
  let file = join(dir, `REVIEW-${localDate(stamp)}-${stampStr}.md`);
  let seq = 2;
  while (existsSync(file)) {
    file = join(dir, `REVIEW-${localDate(stamp)}-${stampStr}-${seq}.md`);
    seq += 1;
  }

  const lines = [
    `# 第三方评审 · ${target || name || cleanSlug}`,
    '',
    `- 项目：${name || cleanSlug}（\`${cleanSlug}\`）`,
    `- 时间：${nowIso()}`,
    `- **评审者：Jarvis 自己——不是独立会话、不是另一个模型。**`,
    `  真正的独立评审需要另起会话（Agent Teams / 任务看板），那会消耗配额，本项未做。`,
    `  所以这份文件的效力只在于：清单固定、依据可复现、指纹可对账。`,
    '',
    `## 总裁决：**${overall}**`,
    '',
    fails.length > 0 ? `- 不合格项：${fails.join(' / ')}` : '- 无不合格项',
    missing.length > 0 ? `- **漏判项：${missing.join(' / ')}（清单没走完，不算通过）**` : '- 清单已走完',
    noEvidence.length > 0 ? `- 缺依据项：${noEvidence.join(' / ')}` : '- 每条非 na 项都有依据',
    summary ? `- 说明：${summary}` : '',
    '',
    '## 逐条判定',
    '',
    '| # | 检查项 | 结论 | 依据 |',
    '| --- | --- | --- | --- |',
  ];
  for (const c of CHECKS) {
    const v = byId.get(c.id);
    const verdict = v ? v.verdict : '**漏判**';
    const evidence = v && v.evidence ? v.evidence.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ') : (v ? '（空）' : '—');
    lines.push(`| ${c.id} | ${c.q.replace(/\|/g, '\\|')} | ${verdict} | ${evidence} |`);
  }
  lines.push('');
  if (fps.length > 0) {
    lines.push('## 产物指纹', '', '| 文件 | 存在 | 字节 | sha256(前16) |', '| --- | --- | --- | --- |');
    for (const f of fps) lines.push(`| \`${f.path}\` | ${f.exists ? '是' : '**否**'} | ${f.bytes ?? '—'} | ${f.sha256 ?? '—'} |`);
    lines.push('', '_指纹对不上 = 评审之后产物被改过，本次结论不再适用于新版本。_', '');
  }
  if (reproduce.length > 0) {
    lines.push('## 复现命令', '', '```');
    for (const cmd of reproduce) lines.push(String(cmd));
    lines.push('```', '');
  }
  lines.push('## 未验证的部分', '', '_（评审者也可能是错的。这里列出本次没有验证、或验证不充分的东西。）_', '');
  lines.push(`- 清单本身是关键词判据，不能发现"清单以外"的问题。`);
  lines.push(`- 未做独立会话复评（见抬头）。`);
  lines.push('');

  const text = lines.filter((l) => l !== undefined).join('\n');
  writeText(file, text);
  return { file, overall, fails, missing, noEvidence, artifacts: fps, bytes: Buffer.byteLength(text, 'utf8') };
}
