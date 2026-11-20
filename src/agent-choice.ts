// 简单任务建议：纯本地规则，不调模型、不阻断发送。
// 只有用户已经选了外部协作 Agent、任务看起来一句话就能答完时，才提示可以只用 Lagent。
export interface AgentChoiceInput {
  text: string;
  collaborators: string[];
  mode: 'auto' | 'plan' | 'review' | string;
  hasProject?: boolean;
  hasDataset?: boolean;
}

export interface AgentChoice {
  suggestLagentOnly: boolean;
  reason: string;
}

const MULTI_STEP = /(然后|接着|同时|分别|并行|首先|其次|最后|步骤|流程|逐个|依次|批量|所有|全部|整个|重构|迁移|实现|开发|部署|测试|修复|排查|审查|对比|分析|生成|创建|修改|删除|写入|读取|运行|执行|安装|配置)/;
const WORK_SIGNAL = /(```|`[^`]+`|[A-Za-z]:\\|\/[^\s]+\.[A-Za-z]{1,6}|\b(?:git|npm|pnpm|yarn|node|python|pip|docker|curl)\b|\.(?:tsx?|jsx?|py|json|md|css|html|sql)\b|代码|文件|目录|仓库|项目|接口|数据库|部署)/i;
const MULTI_SENTENCE = /[。！？!?；;\n]/;

export function lagentOnlySuggestion(input: AgentChoiceInput): AgentChoice {
  const text = (input.text || '').trim();
  const collaborators = Array.isArray(input.collaborators) ? input.collaborators.filter(Boolean) : [];
  if (!collaborators.length) return { suggestLagentOnly: false, reason: '' };
  if (input.mode !== 'auto') return { suggestLagentOnly: false, reason: '' };
  if (!text || text.length > 120) return { suggestLagentOnly: false, reason: '' };
  if (input.hasDataset) return { suggestLagentOnly: false, reason: '' };
  if (MULTI_SENTENCE.test(text)) return { suggestLagentOnly: false, reason: '' };
  if (MULTI_STEP.test(text)) return { suggestLagentOnly: false, reason: '' };
  if (WORK_SIGNAL.test(text)) return { suggestLagentOnly: false, reason: '' };
  return {
    suggestLagentOnly: true,
    reason: '这件事一句话就能说清，Lagent 自己回答更快，也不必多开外部 Agent。'
  };
}
