/**
 * dsh-jarvis — 同义词 / 简称 / 别称扩展（v0.3 · 3.4）。
 *
 * ## 为什么需要
 *
 * 关键词检索的硬伤：你问「保研」而某条记忆写的是「推免」，两边的字一个都不重
 * ——按重叠打分就是零分，可它明明相关。同义词表修的就是这个。
 *
 * ## 三条克制
 *
 * 1. **只给奖励分，不改主干。** 上限 0.3（见 synonymBonus），所以同义词命中
 *    永远排在直接命中之后。反过来做（把同义词当等价查询）会让"最像的"输给
 *    "沾边的"，那更糟。
 * 2. **不放人名。** 这条教训在记忆宫殿那次已经付过学费（把导师的名字当房间关键词，
 *    3 个字压过「推免」「报备」）。人名天然跨主题，用它做检索键永远会错。
 * 3. **表是人写的，就一定会漏。** 它不是语义理解；漏掉的同义词就是漏掉的，
 *    不许假装覆盖完整。真要好用得上嵌入模型——那需要下载，还没批。
 */

/**
 * 同义词组。组内任意两词视为同义。
 * 拉丁词一律小写，因为 `tokenize` 会转小写。
 */
export const GROUPS = [
  ['保研', '推免', '直博', '预推免'],
  ['绩点', 'gpa', '排名', '成绩'],
  ['丘赛', '丘成桐', '数学竞赛'],
  ['课程论文', '课设', '课程报告', '大作业'],
  ['数值分析', '数值方法', '计算方法'],
  ['微分方程', 'ode', 'pde', '偏微分', '常微分', '矩阵分解'],
  ['具身智能', 'embodied', '机器人', '机械臂', 'manipulation', '操控'],
  ['强化学习', 'reinforcement', 'rlhf', '奖励模型', '奖励'],
  ['大语言模型', 'llm', '语言模型', 'gpt', 'transformer'],
  ['神经网络', '深度学习', 'deep', 'dl'],
  ['数据集', 'benchmark', '评测集', '基准'],
  ['论文', 'paper', '预印本', 'arxiv', '综述'],
  ['导师', '老板', '课题组', 'pi'],
  ['实验', '复现', 'reproduce', '跑通', '实验'],
  ['报错', '错误', '异常', 'error', 'traceback', '失败'],
  ['环境', '依赖', 'package', '库', '版本'],
  ['夏令营', '暑期学校', '开放日'],
  ['材料', '申请', '文书', 'cv', '简历', '推荐信'],
  ['时间', '截止', 'ddl', 'deadline', '到期'],
  ['会议', '期刊', '投稿', '接收'],
  ['记忆', 'memory', '记住', '笔记'],
  ['压缩', 'compaction', '上下文', 'context'],
];

const GROUP_OF = new Map();
for (const group of GROUPS) {
  const norm = [...new Set(group.map((w) => String(w).toLowerCase()))];
  for (const w of norm) {
    if (!GROUP_OF.has(w)) GROUP_OF.set(w, norm);
  }
}

/** 这个词有没有同义词组（测试用）。 */
export function hasGroup(term) {
  return GROUP_OF.has(String(term ?? '').toLowerCase());
}

/**
 * 同义词奖励分：查询词没直接命中、但它的同义词出现在文档里，就给一点分。
 *
 * 为什么是"奖励"而不是"改写查询"：如果把同义词直接塞进查询词表，归一化分母
 * 会被稀释，直接命中的条目分数反而下降——那等于为了照顾边角情况牺牲主干。
 *
 * @returns {number} 0 到 0.3
 */
export function synonymBonus(queryTerms, docTerms) {
  if (!queryTerms || !docTerms || queryTerms.size === 0 || docTerms.size === 0) return 0;
  let counted = 0;
  let hit = 0;
  for (const term of queryTerms.keys()) {
    if (term.length < 2) continue;
    counted += 1;
    if (docTerms.has(term)) continue; // 直接命中已经有分，不重复奖励
    const group = GROUP_OF.get(term);
    if (!group) continue;
    if (group.some((m) => m !== term && docTerms.has(m))) hit += 1;
  }
  if (counted === 0 || hit === 0) return 0;
  return Math.min(0.3, (hit / counted) * 0.3);
}
