/**
 * dsh-jarvis — 红线保险丝。
 *
 * 用户底线（m00001 第 3 条 + m00030 第 3 条回答）：
 *   外网/梯子、下载安装、桌面与工作区文件写入、模型训练 —— 全部需要用户同意。
 *
 * 这里的实现原则：**保险丝做成代码，不做成提示词**。
 *   - 需要审批的动作，工具返回 `needsApproval` 而不是直接执行；
 *   - 只有用户在同一轮里明确确认（`confirmed: true`）之后，工具才真的写盘；
 *   - `~/.dsh/jarvis/` 是唯一免审批写入区。
 *
 * 注意：这不是"绕过 DSH 审批"。DSH 自己的 sandbox / approval 仍然生效，
 * 这一层是在其之上再加一道"Jarvis 自己必须先问"的闸门，两者叠加而不是替代。
 */

import { isInsideJarvisHome } from './store.js';

export const APPROVAL_ACTIONS = Object.freeze({
  network: '访问境外网络（可能需要梯子）',
  download: '下载或安装软件 / 依赖',
  desktopWrite: '写入 / 修改 / 删除桌面或工作区文件',
  outsideWrite: '写入 ~/.dsh/jarvis/ 之外的路径',
  training: '运行模型训练（ML / RL / DL）',
  destructive: '不可逆操作（删除、覆盖、批量改名）',
});

/**
 * 统一的审批闸门。
 *
 * @param {object} cfg         jarvis 配置（含 redLines 开关）
 * @param {object} p
 * @param {string} p.action    APPROVAL_ACTIONS 的键
 * @param {string} p.summary   一句话说明"我要做什么"
 * @param {string} [p.detail]  具体参数 / 目标路径 / 体积 / 风险
 * @param {boolean} [p.confirmed] 用户是否已在对话中明确同意
 * @param {string} [p.target]  目标路径（用于判断是否落在免审批区）
 * @param {boolean} [p.alwaysAllowed] 该动作本身是否永远免审批
 * @returns {{allowed:boolean, needsApproval:boolean, reason:string, ask:string}}
 */
export function gate(cfg, p) {
  const red = cfg?.redLines ?? {};
  const target = p.target ?? '';

  // 免审批区：Jarvis 自有数据。
  if (p.action !== 'network' && p.action !== 'download' && p.action !== 'training' && target) {
    if (isInsideJarvisHome(target)) {
      return {
        allowed: true,
        needsApproval: false,
        reason: '目标位于 ~/.dsh/jarvis/（Jarvis 自有数据区，免审批）',
        ask: '',
      };
    }
  }

  if (p.alwaysAllowed === true) {
    return { allowed: true, needsApproval: false, reason: '该动作被显式标记为免审批', ask: '' };
  }

  if (p.confirmed === true) {
    return {
      allowed: true,
      needsApproval: false,
      reason: '用户本轮已明确同意',
      ask: '',
    };
  }

  // 外网：用户底线原文是"提醒我开梯子"，所以默认放行 + 强制提醒（而不是拦死）。
  // 想改成拦死，把 config.json 里 redLines.networkPolicy 设成 'approve'。
  if (p.action === 'network') {
    const policy = red.networkPolicy ?? 'remind';
    if (policy === 'allow' || policy === 'remind') {
      return {
        allowed: true,
        needsApproval: false,
        reason: policy === 'allow' ? '外网策略：allow（不提醒）' : '外网策略：remind（放行但必须告知）',
        ask: '',
        remind:
          policy === 'remind'
            ? '⚠️ 本次动作会访问境外网络。如果抓取失败，请打开梯子后让我重跑；我会先跑 jarvis_preflight 判断是否真的需要梯子。'
            : '',
      };
    }
  }

  const label = APPROVAL_ACTIONS[p.action] ?? '高危操作';
  const detail = p.detail ? `\n细节：${p.detail}` : '';
  const targetLine = target ? `\n目标：${target}` : '';
  return {
    allowed: false,
    needsApproval: true,
    reason: `红线：${label}`,
    ask:
      `我需要先取得你的同意。\n**要做什么**：${p.summary}\n**类别**：${label}${targetLine}${detail}\n` +
      `同意的话回一句"可以"或"同意"，我就继续；需要改条件就直接说。`,
  };
}

/** 给模型的统一话术：遇到审批闸门时该怎么把话说清楚。 */
export const APPROVAL_INSTRUCTION = [
  '当任何工具返回 needsApproval=true 时：',
  '1. 立刻停止该动作，不要尝试别的绕路写法（换路径、换工具、拆分步骤都算绕路）。',
  '2. 用工具返回的 `ask` 原文转告用户，并说明"为什么需要"。',
  '3. 只有用户在本轮明确同意后，才带 `confirmed: true` 重试同一个动作。',
  '4. 用户拒绝或不回应时，改成不需要审批的替代方案（例如让用户自己执行、或只输出方案不落盘）。',
].join('\n');
