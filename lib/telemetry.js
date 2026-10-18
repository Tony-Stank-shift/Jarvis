/**
 * dsh-jarvis — 埋点（阶段 0）。
 *
 * 存在的唯一理由：把「Jarvis 什么时候在做长记忆调用」从**猜**变成**统计**。
 * 在装上它之前，任何关于频率、延迟、命中率的说法都是编的——这正是用户在
 * 第二点里追问的两个问题之一。
 *
 * 三条铁律：
 *
 * 1. **埋点失败绝不能影响主流程。** 全部 try/catch 吞掉；用户要的是记忆，
 *    不是监控。
 *
 * 2. **只记形状，不记原文。** 刻意不落 query 文本，只记字符数与命中数。
 *    记忆里可能有隐私（成绩、情绪、人际关系），埋点没有理由复制一份。
 *    需要原文的场合只有「纠错账本」——那是用户主动指出我错了，性质不同。
 *
 * 3. **「长记忆调用」必须先定义再统计。** 不定义就没法回答「什么时候」。
 *    这里同时记三个口径，事后按任一口径都能筛：
 *      scan  检索时扫描的候选条数 > 200（全库扫描）
 *      wide  返回条数 > 20（宽召回）
 *      slow  单次调用耗时 > 300ms（慢调用）
 *    三个口径都不理想，但都好过一句「我觉得有时候会变慢」。
 */

import { appendJsonl, paths, readJsonl } from './store.js';

/** 三个「长调用」口径的阈值。集中在这里，方便以后按真实分布调。 */
export const LONG_CALL = Object.freeze({ scan: 200, wide: 20, slow: 300 });

/** 一次记忆调用的埋点。永不抛错。 */
export function logMemory(e = {}) {
  try {
    const candidates = Number(e.candidates) || 0;
    const returned = Number(e.returned) || 0;
    const latencyMs = Math.round(Number(e.latencyMs) || 0);
    const long = {
      scan: candidates > LONG_CALL.scan,
      wide: returned > LONG_CALL.wide,
      slow: latencyMs > LONG_CALL.slow,
    };
    const topScore = Number(e.topScore);
    appendJsonl(paths.telemetry, {
      at: new Date().toISOString(),
      ev: 'memory',
      action: String(e.action ?? 'unknown'),
      kind: String(e.kind ?? 'all'),
      queryChars: String(e.query ?? '').length,
      candidates,
      returned,
      topScore: Number.isFinite(topScore) ? topScore : null,
      latencyMs,
      storeSize: Number(e.storeSize) || 0,
      long,
      longAny: long.scan || long.wide || long.slow,
      ...(e.extra && typeof e.extra === 'object' ? { extra: e.extra } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

/** 分位数（nearest-rank，不需要插值；样本量小的时候别装精确）。 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * 聚合最近 N 天。给 jarvis_status 用，也用来回答用户的「什么时候」。
 * 返回结构里的 `verdict` 是**给模型读的一句话**，不是给用户看的最终结论。
 */
export function summarize({ days = 14 } = {}) {
  const window = Math.max(1, Math.min(365, Number(days) || 14));
  const since = Date.now() - window * 86400000;
  let rows = [];
  try {
    rows = readJsonl(paths.telemetry).filter((r) => {
      const t = Date.parse(r?.at ?? '');
      return Number.isFinite(t) && t >= since;
    });
  } catch {
    rows = [];
  }

  const mem = rows.filter((r) => r?.ev === 'memory');
  const byAction = {};
  const byKind = {};
  let scan = 0;
  let wide = 0;
  let slow = 0;
  let any = 0;
  let returnedSum = 0;
  let maxCandidates = 0;
  const latencies = [];

  for (const r of mem) {
    byAction[r.action] = (byAction[r.action] ?? 0) + 1;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (r.long?.scan) scan += 1;
    if (r.long?.wide) wide += 1;
    if (r.long?.slow) slow += 1;
    if (r.longAny) any += 1;
    returnedSum += Number(r.returned) || 0;
    maxCandidates = Math.max(maxCandidates, Number(r.candidates) || 0);
    latencies.push(Number(r.latencyMs) || 0);
  }
  latencies.sort((a, b) => a - b);

  const calls = mem.length;
  const out = {
    windowDays: window,
    calls,
    byAction,
    byKind,
    long: { scan, wide, slow, any, ratio: calls > 0 ? Number((any / calls).toFixed(3)) : 0 },
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length ? latencies[latencies.length - 1] : null },
    avgReturned: calls > 0 ? Number((returnedSum / calls).toFixed(2)) : 0,
    maxCandidates,
    lastAt: mem.length ? mem[mem.length - 1].at : null,
    thresholds: LONG_CALL,
  };

  out.verdict =
    calls === 0
      ? `最近 ${window} 天没有任何记忆埋点（阶段 0 刚装上，属正常）。任何「Jarvis 什么时候做长记忆调用」的答案现在都还没有数据支撑。`
      : `最近 ${window} 天记忆调用 ${calls} 次，其中长调用 ${any} 次（${Math.round(out.long.ratio * 100)}%）：` +
        `全库扫描 ${scan} 次、宽召回 ${wide} 次、慢调用 ${slow} 次；` +
        `延迟 p50 ${out.latency.p50}ms / p95 ${out.latency.p95}ms；平均返回 ${out.avgReturned} 条。`;
  return out;
}

/** 清空埋点（调试用；不删文件，只截断）。 */
export function reset() {
  try {
    appendJsonl(paths.telemetry, { at: new Date().toISOString(), ev: 'reset' });
    return true;
  } catch {
    return false;
  }
}
