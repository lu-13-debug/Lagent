/**
 * 提示词改写 + 关键改动判定。
 *
 * 两件事放在一起，是因为它们服务于同一个目标：内置 Agent 要把用户「说得不够细」的话
 * 变成别的 Agent 能直接照着做的任务，同时把「项目真正发生了什么」浓缩成能跨对话共享的记忆。
 *
 * 这里只做纯函数，不碰模型、不碰执行器：
 * - refineLocal：没有模型时的三版提示词兜底，保证界面永远有东西可选；
 * - isKeyChange：决定一次执行值不值得写进项目记忆。
 */

/** 明确写出结论的词：命中就说明这次执行留下了可复用的判断，不只是「跑了一遍」。 */
const CONCLUSION = /决定|改为|改用|统一|约定|约束|边界|不许|不要再|必须|结论|取舍|方案|原因|待办|还欠|下一步|遗留/;

/** 描述「真的动了手」的动词：完成但没留下文件（非 git 目录常见）时，靠它判断有没有产出。 */
const ACTION = /新建|创建|新增|添加|修改|删除|写入|实现|修好|修复|更新|重构|补上|补了|完成|生成|搬|移到/;

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * 一次执行值不值得写进项目记忆。
 * 用户的要求是「记忆里只保留项目的关键改动」，所以只有两种情况算：
 * 真的动了文件，或者留下了能复用的结论。纯问答、只读排查不写。
 */
export function isKeyChange({ summary = '', files = [], status = '' } = {}) {
  const changed = Array.isArray(files) && files.some(file => typeof file === 'string' && file.trim());
  if (changed) return true;
  const body = text(summary, 2000);
  if (!body) return false;
  if (CONCLUSION.test(body)) return true;
  // 没绑定 git 的项目拿不到文件清单，成功执行又写了「新建/修改/完成」这类话，
  // 也算一次改动——否则这类项目的记忆会一条都不剩。
  if (status === 'completed' && ACTION.test(body)) return true;
  // 失败但说清了「缺什么、下一步怎么办」也算结论；只报一句 HTTP 错误不算。
  if ((status === 'failed' || status === 'blocked') && /缺少|需要|先|改为|建议|无法/.test(body)) return true;
  return false;
}

const SCOPE_HINT = '范围只写在项目工作目录内；不要动 .git、依赖目录和密钥文件。';

const join = (...lines) => lines.filter(item => typeof item === 'string' && item.trim()).join('\n');

/**
 * 任务书里只放记忆的「干货」：去掉表头和说明行，压到一小段。
 * 整段 digest 塞进去会让三条版本都变成论文，谁也不想读。
 */
function memoryExcerpt(memory, max = 420) {
  const body = text(memory, 4000)
    .split('\n')
    .filter(line => line.trim() && !/^项目记忆（/.test(line) && !/^只记项目的关键改动/.test(line))
    .join('\n');
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

/**
 * 三版提示词，侧重不同：约束、步骤、验收。
 * 每一版都要能独立交给一个 Agent 执行，所以都带上原目标，不改写用户意图。
 */
export function refineLocal({ goal = '', agents = [], memory = '' } = {}) {
  const target = text(goal, 2000);
  if (!target) return [];
  const who = Array.isArray(agents) && agents.length ? agents.join('、') : '指定的 Agent';
  const memoryBlock = memoryExcerpt(memory);
  const shared = memoryBlock ? `项目现状（别人已经做过的，别重复）：\n${memoryBlock}` : '';

  return [
    {
      id: 'constraints',
      label: '补齐约束版',
      focus: '把边界、禁止项、技术限制写清楚',
      prompt: join(
        target,
        '',
        '要求：',
        `- 由 ${who} 负责；${SCOPE_HINT}`,
        '- 先说明你打算怎么做，再动手；不确定的地方按最小改动实现，不要引入新依赖。',
        '- 不要改动与本任务无关的文件；发现必须改动时先说明原因。',
        '- 做完后列出你实际修改/新增的文件，以及为什么这么改。',
        shared,
      ),
    },
    {
      id: 'steps',
      label: '拆步骤版',
      focus: '把交付拆成有序的小步，每步都能验证',
      prompt: join(
        target,
        '',
        '按下面的顺序推进，每一步做完写一句「这一步完成了什么」：',
        '1) 先摸清现状：读相关文件/目录，确认现有实现和约定，不要凭想象写。',
        '2) 再动手改：小步提交，一次只解决一个点，改完立刻确认语法/结构没问题。',
        '3) 最后自检：把成果跑起来或检查一遍，确认真的生效，而不是「写完就算」。',
        `执行者：${who}。${SCOPE_HINT}`,
        shared,
      ),
    },
    {
      id: 'acceptance',
      label: '验收标准版',
      focus: '先说清「怎样算做完」，再反推实现',
      prompt: join(
        target,
        '',
        '先写下这个任务的验收标准（3–5 条，可验证），再按标准实现：',
        '- 完成的标准要能被外部检查：文件存在、命令能跑通、页面能看到、测试能过。',
        '- 每完成一条就在回复里打勾，并给出证据（文件路径、命令输出、关键代码位置）。',
        '- 如果某条做不到，明确说「这条没做到，因为……」，不要笼统说「完成了」。',
        `执行者：${who}。${SCOPE_HINT}`,
        shared,
      ),
    },
  ];
}

/** 模型返回的三版提示词也要过一遍这里：裁长度、补 id、丢掉空项、最多三版。 */
export function normalizePrompts(raw, { goal = '', agents = [] } = {}) {
  const fallback = refineLocal({ goal, agents });
  const source = Array.isArray(raw) ? raw : [];
  const prompts = [];
  for (const item of source.slice(0, 3)) {
    const prompt = text(item?.prompt, 4000);
    if (!prompt) continue;
    prompts.push({
      id: text(item?.id, 40) || `v${prompts.length + 1}`,
      label: text(item?.label, 40) || `版本 ${prompts.length + 1}`,
      focus: text(item?.focus, 120),
      prompt,
    });
  }
  if (prompts.length >= 2) return prompts;
  return fallback;
}