/**
 * dsh-jarvis — 压缩实况（v0.3 · 3.1）。
 *
 * ## 为什么要有这个文件
 *
 * `config.json` 里曾经有一个 `contextPolicy: { soft: 50, hard: 30 }`，从命名到
 * 默认值都在暗示"Jarvis 会在 50%/30% 触发压缩"。**它不接任何东西。** 没有任何
 * 一行代码读它，DSH 也不认它。这就是一句伪装成配置的谎话。
 *
 * 真实情况（2026-10-18 本机实测）：
 *   - `billion-context` 装着但**不在 bundles 里** → 没挂载；
 *   - 真正在跑的是 DSH 内核的 `compaction-basic`（profile 的 cordis.patch.yml
 *     里 `auto: true` + `thresholdRatio: 0.5`）与 `dsh-context`；
 *   - 插件**改不了**这些（改要编辑 profile 的 cordis.patch.yml 并重启）。
 *
 * 所以这个模块只做一件事：**把真实阈值读出来告诉用户**。
 * 不写、不改、不试图接管压缩——假装能接管比不做更糟。
 *
 * ## 已知局限
 *
 * 1. 插件不知道自己跑在哪个 profile 里。这里的做法是扫 `~/.dsh/profiles/*`，
 *    把 bundles 里含 `dsh-jarvis` 的那个标成 `hasJarvis`——这是**推测**，
 *    如果多个 profile 都装了本插件，就都标上。
 * 2. `auto:` 行归属哪个插件靠"向上找最近的 `- id:`，否则向后找 `name:`"推断，
 *    对复杂嵌套 YAML 可能猜错。猜错时 `pluginGuess: true`，别当权威。
 * 3. 只认 YAML 里的字面值。如果有人用 `!!js` 表达式算阈值，这里读不到。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { listDirs, readJson, readText } from './store.js';

const PROFILES_DIR = join(homedir(), '.dsh', 'profiles');

/** 与本议题相关的插件名（用于判断"谁在管压缩"）。 */
const COMPACTION_PLUGINS = ['billion-context', 'dsh-context', 'compaction-basic', 'compaction-tool-result-pruner'];

function scanPatch(patchFile) {
  const text = readText(patchFile, '');
  if (text.trim() === '') return [];
  const lines = text.split(/\r?\n/);
  const rows = [];
  let lastId = '';
  for (let i = 0; i < lines.length; i += 1) {
    const idm = /^\s*-\s*id:\s*([\w.@/-]+)/.exec(lines[i]);
    if (idm) lastId = idm[1];
    const am = /^\s*auto:\s*(true|false)\s*$/.exec(lines[i].trim());
    if (!am) continue;

    const forward = lines.slice(i, Math.min(lines.length, i + 8)).join('\n');
    const nameMatch = /name:\s*['"]?([@\w./-]+)['"]?/.exec(forward);
    const guessed = nameMatch ? nameMatch[1] : '';
    const plugin = guessed || lastId || 'unknown';

    const ratioLine = lines
      .slice(i, Math.min(lines.length, i + 5))
      .find((l) => /thresholdRatio\s*:/.test(l));
    const rm = ratioLine ? /thresholdRatio\s*:\s*([\d.]+)/.exec(ratioLine) : null;
    const retainLine = lines
      .slice(i, Math.min(lines.length, i + 5))
      .find((l) => /retainRatio\s*:/.test(l));
    const rrm = retainLine ? /retainRatio\s*:\s*([\d.]+)/.exec(retainLine) : null;

    rows.push({
      line: i + 1,
      plugin,
      auto: am[1] === 'true',
      thresholdRatio: rm ? Number(rm[1]) : null,
      retainRatio: rrm ? Number(rrm[1]) : null,
    });
  }
  return rows;
}

/**
 * 读本机所有 profile 的压缩实况。
 *
 * @returns {{
 *   profiles: Array<{profile: string, hasJarvis: boolean, bundles: string[],
 *     mounted: string[], rows: Array<object>}>,
 *   effective: Array<{profile: string, plugin: string, auto: boolean,
 *     thresholdRatio: number|null, thresholdPercent: number|null}>,
 *   note: string,
 * }}
 */
export function contextReality({ profilesDir = PROFILES_DIR } = {}) {
  const profiles = [];

  for (const dir of listDirs(profilesDir)) {
    const patch = join(dir.path, 'cordis.patch.yml');
    const pkg = join(dir.path, 'package.json');
    const pkgJson = readJson(pkg, null);
    const bundles = Array.isArray(pkgJson?.dsh?.profile?.bundles)
      ? pkgJson.dsh.profile.bundles.map(String)
      : [];
    const rows = scanPatch(patch);
    if (bundles.length === 0 && rows.length === 0) continue;

    const mounted = COMPACTION_PLUGINS.filter((name) => bundles.some((b) => b.includes(name)));
    profiles.push({
      profile: dir.name,
      // 这是推测：bundles 里有本插件 ⇒ 这个 profile 会加载我们。
      hasJarvis: bundles.some((b) => b.includes('dsh-jarvis')),
      mounted,
      rows,
    });
  }

  const effective = [];
  for (const p of profiles) {
    for (const r of p.rows) {
      if (!/compaction/.test(r.plugin)) continue;
      effective.push({
        profile: p.profile,
        plugin: r.plugin,
        auto: r.auto,
        thresholdRatio: r.thresholdRatio,
        thresholdPercent: r.thresholdRatio === null ? null : Math.round(r.thresholdRatio * 100),
        retainRatio: r.retainRatio,
      });
    }
  }

  const ours = profiles.filter((p) => p.hasJarvis);
  const scope = ours.length > 0 ? ours : profiles;
  const parts = [];
  for (const p of scope) {
    const auto = effective.filter((e) => e.profile === p.profile);
    if (auto.length === 0) {
      parts.push(`${p.profile}：没读到 compaction 的 auto/thresholdRatio`);
      continue;
    }
    const desc = auto
      .map((e) => `${e.plugin} auto=${e.auto}${e.thresholdPercent === null ? '' : ` @ ${e.thresholdPercent}%`}${e.retainRatio ? ` 保留尾部 ${Math.round(e.retainRatio * 100)}%` : ''}`)
      .join('；');
    parts.push(`${p.profile}：${desc}`);
  }

  const anyAuto = effective.some((e) => e.auto);
  return {
    profiles,
    effective,
    /** 真值摘要。**这不是本插件能控制的东西，只是如实汇报。** */
    note:
      (parts.length > 0 ? parts.join(' ｜ ') : '没找到任何 profile 的压缩配置。') +
      `　｜　插件不可控：改这些要编辑 profile 的 cordis.patch.yml 并重启 DSH。` +
      (anyAuto ? '' : '　｜　当前没有任何自动压缩开启，上下文不会被自动压缩。'),
    /** 本插件曾经宣传过、但实际不存在的控制项。保留字段是为了让读者知道它被拆穿了。 */
    removedPromise: 'contextPolicy{soft,hard} 已从默认配置删除：它从来没接任何东西。',
  };
}
