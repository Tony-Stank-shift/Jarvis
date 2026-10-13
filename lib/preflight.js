/**
 * dsh-jarvis — 外网预检（梯子探测）。
 *
 * 用户底线原文（m00001 第 3 条）：
 *   "如果需要梯子和我说 我windows里有 如果需要外网搜索什么的提醒我开梯子"
 * → 所以这里的职责是**尽早发现"需要梯子"并明确告诉用户**，而不是偷偷重试。
 *
 * 探针纪律：只做一次 GET 并立刻丢弃响应体，6 秒超时，不打日志，不落盘。
 * 判别逻辑把三类失败分开：
 *   DNS 解析失败        → 大概率本地网络/代理未开
 *   连接超时/被重置      → 大概率被墙，需要梯子
 *   拿到任意 HTTP 状态码 → 视为可达（403/429 也是"通了"）
 */

import { lookup } from 'node:dns/promises';

export const DEFAULT_TARGETS = [
  {
    id: 'arxiv',
    label: 'arXiv API',
    url: 'https://export.arxiv.org/api/query?search_query=all:electron&max_results=1',
    why: '每日情报的主来源（AI / AI4S / 具身智能 预印本）',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face Daily Papers',
    url: 'https://huggingface.co/api/daily_papers?limit=1',
    why: '社区热度排序的当日论文',
  },
  {
    id: 'github',
    label: 'GitHub API',
    url: 'https://api.github.com/rate_limit',
    why: '开源实现 / 仓库动态 / 作者主页',
  },
  {
    id: 'scholar',
    label: 'Google Scholar',
    url: 'https://scholar.google.com/',
    why: '参考文献与引用检索（你指定的优先来源）',
  },
  {
    id: 'google',
    label: 'Google 连通性',
    url: 'https://www.google.com/generate_204',
    why: '通用外网可达性基线',
  },
];

const TIMEOUT_MS = 6000;

export async function probe({ targets = null, timeoutMs = TIMEOUT_MS } = {}) {
  const list = (Array.isArray(targets) && targets.length > 0 ? targets : DEFAULT_TARGETS).map((t) =>
    typeof t === 'string' ? { id: t, label: t, url: t, why: '' } : t,
  );
  const results = await Promise.all(list.map((t) => probeOne(t, timeoutMs)));
  const reachable = results.filter((r) => r.reachable);
  const needVpn = results.filter((r) => r.needsVpn);
  const verdict =
    reachable.length === results.length
      ? 'ok'
      : reachable.length === 0
        ? 'offline'
        : needVpn.length > 0
          ? 'partial'
          : 'partial';
  return {
    verdict,
    checkedAt: new Date().toISOString(),
    reachableCount: reachable.length,
    total: results.length,
    needVpn: needVpn.map((r) => r.label),
    advice: adviceFor(verdict, results),
    results,
  };
}

async function probeOne(target, timeoutMs) {
  const started = Date.now();
  let host = '';
  try {
    host = new URL(target.url).host;
  } catch {
    return { ...target, reachable: false, needsVpn: false, error: 'invalid url', latencyMs: 0 };
  }

  // 1) DNS 先行：能解析 = 至少域名没被本地 DNS 拦死。
  let dnsOk = true;
  let dnsError = '';
  try {
    await lookup(host);
  } catch (e) {
    dnsOk = false;
    dnsError = code(e);
  }

  // 2) HTTP 探针。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(target.url, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
      headers: { 'user-agent': 'dsh-jarvis-preflight/0.1' },
    });
    const latencyMs = Date.now() - started;
    try {
      await res.body?.cancel();
    } catch {
      /* 丢弃响应体失败不影响判定 */
    }
    return {
      id: target.id,
      label: target.label,
      why: target.why,
      url: target.url,
      reachable: true,
      status: res.status,
      latencyMs,
      dnsOk,
      dnsError,
      error: '',
      needsVpn: false,
    };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const c = code(e);
    return {
      id: target.id,
      label: target.label,
      why: target.why,
      url: target.url,
      reachable: false,
      status: null,
      latencyMs,
      dnsOk,
      dnsError,
      error: c,
      needsVpn: needsVpnFor(c, dnsOk),
    };
  } finally {
    clearTimeout(timer);
  }
}

function code(e) {
  const name = e?.name ?? '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'TIMEOUT';
  const nested = e?.cause?.code ?? e?.code ?? '';
  if (nested) return String(nested);
  return String(e?.message ?? e ?? 'UNKNOWN');
}

function needsVpnFor(c, dnsOk) {
  if (c === 'TIMEOUT') return true;
  if (c === 'ETIMEDOUT' || c === 'ECONNRESET' || c === 'ECONNREFUSED' || c === 'EAI_AGAIN' || c === 'EPROTO') return true;
  if (c === 'ENOTFOUND' || c === 'EAI_FAIL') return !dnsOk ? false : true;
  return !dnsOk;
}

function adviceFor(verdict, results) {
  if (verdict === 'ok') return '外网可达，不需要梯子，可以直接开始检索。';
  if (verdict === 'offline') {
    return '所有目标都不通。先确认本机网络是否正常；如果国内站点正常而这里全挂，请**打开梯子**后让我重跑 jarvis_preflight。';
  }
  const dead = results.filter((r) => !r.reachable).map((r) => r.label);
  return `部分目标不通：${dead.join('、')}。请**打开梯子**后让我重跑 jarvis_preflight；在此之前我只用可用的来源，并会明确标注"未覆盖"。`;
}
