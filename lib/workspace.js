/**
 * dsh-jarvis — 工作区解析（v0.3 · 3.2b）。
 *
 * ## 为什么要这个文件
 *
 * 记忆与项目此前是**全局**的：在哪个工作区都看得见。多数时候这是对的
 * （"我微分方程那个项目"不该因为换了目录就消失），但它让"这条记忆是在哪个
 * 项目里产生的"完全丢失。
 *
 * ## 为什么不需要显式参数
 *
 * `ToolRunContext` 里**没有** cwd / workspaceId（2026-10-18 用 cordis_inspect_query
 * 查过权威类型声明，字段只有 callId / rootCallId / name / schema / arguments /
 * agent / parent / signal）。但 `exec.agent` 是 `{ id: SessionId }`，而 Host 的
 * `workingDirectory` 服务恰好提供 `ensure(agent, signal)` —— 这就是"当前会话在
 * 哪个目录"的权威来源。
 *
 * ## 三条设计约束
 *
 * 1. **默认不过滤。** 工作区只做**标注**；要过滤必须显式要求。把别的目录的记忆
 *    藏起来，是变笨不是变准。
 * 2. **失败就当未知。** `ensure` 名字暗示可能有副作用（确保目录存在），且是异步
 *    可选服务。任何失败都降级为 `unknown`，绝不让它挡住一次 remember。
 * 3. **短缓存。** `ensure` 是 async，每次记忆调用都等一次没有意义；按 session
 *    缓存 60 秒。工作区在一次会话里几乎不会变。
 */

import { basename } from 'node:path';

const CACHE_TTL_MS = 60_000;
/** sessionId → { value, at } */
const cache = new Map();

function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * 解析当前工作区。**永不抛错**——最差返回 source: 'unknown'。
 *
 * @param {object} ctx  Cordis 插件上下文（apply 时拿到的那一个）
 * @param {object} exec ToolRunContext（execute 的第二个参数）
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] 缓存有效期
 * @returns {Promise<{path: string|null, label: string|null, source: 'explicit'|'cache'|'session'|'unknown', error: string|null}>}
 */
export async function resolveWorkspace(ctx, exec, { ttlMs = CACHE_TTL_MS } = {}) {
  // 显式覆盖：脚本/测试用，也是 workingDirectory 不可用时的唯一退路。
  const override = String(process.env.JARVIS_WORKSPACE ?? '').trim();
  if (override !== '') return { path: override, label: basename(override), source: 'explicit', error: null };

  const agent = exec?.agent;
  const sessionId = agent?.id ? String(agent.id) : '';

  if (sessionId !== '') {
    const hit = cache.get(sessionId);
    if (hit && Date.now() - hit.at < ttlMs) return { ...hit.value, source: 'cache' };
  }

  const wd = safeGet(ctx, 'workingDirectory');
  if (!wd || typeof wd.ensure !== 'function' || !agent) {
    return { path: null, label: null, source: 'unknown', error: wd ? 'exec.agent 缺失' : 'workingDirectory 服务不可用' };
  }

  try {
    const raw = await wd.ensure(agent, exec?.signal);
    const path = raw ? String(raw) : '';
    const value = { path: path === '' ? null : path, label: path === '' ? null : basename(path), error: null };
    if (sessionId !== '') cache.set(sessionId, { value, at: Date.now() });
    return { ...value, source: 'session' };
  } catch (e) {
    // 失败不缓存：下次可能就好了。
    return { path: null, label: null, source: 'unknown', error: e?.message ?? String(e) };
  }
}

/** 测试用：清缓存。 */
export function clearWorkspaceCache() {
  cache.clear();
}

/**
 * 归一化外部传入的工作区值（args.workspace 或记录里的 workspace 字段）。
 * 空 → null（表示"没标注"），不是空字符串。空字符串会让 JSONL 里出现噪音。
 */
export function normalizeWorkspace(v) {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}
