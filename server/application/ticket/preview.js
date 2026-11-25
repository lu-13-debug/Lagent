// 审批前的安全投影：告诉界面“将要执行什么”，但不暴露原始 argv、凭据或完整提示词。
// 风险等级是业务规则：high 会在建单时强制进入待确认，不受 requireApproval 默认值影响。
import path from 'node:path';
import { redactPreview } from '../../platform/redact.js';

const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const list = (value, max, chars) => Array.isArray(value)
  ? [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, chars)))].slice(0, max)
  : [];

const safePath = value => {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(value);
};

function terminalPreview(executorInput) {
  const program = text(executorInput?.program, 40) || 'command';
  const args = Array.isArray(executorInput?.args) ? executorInput.args.map(item => text(item, 120)).filter(Boolean) : [];
  // 审批卡只露程序与子命令；终端参数里可能带用户粘贴的凭据/提示词，不能回显。
  const sub = args[0] ? ` ${redactPreview(args[0], 80)}` : '';
  const rest = args.length > 1 ? `（另有 ${args.length - 1} 个参数）` : '';
  return {
    kind: 'command',
    action: `${program}${sub}${rest}`,
    risk: 'low',
    reversible: true
  };
}

function browserPreview(executorInput) {
  let host = '';
  let action = '';
  try {
    const url = new URL(String(executorInput?.url || ''));
    host = url.hostname;
    // 审批卡只展示 origin + path，不把查询串/锚点里的临时令牌带出来。
    action = `${url.origin}${url.pathname}`;
  } catch { /* 无效 URL 交给执行器校验。 */ }
  return {
    kind: 'network',
    action: redactPreview(action || executorInput?.url, 500),
    hosts: host ? [host] : [],
    risk: 'low',
    reversible: true
  };
}

function githubPreview(executorInput) {
  const action = text(executorInput?.action, 40);
  const target = action === 'search'
    ? `搜索 ${redactPreview(executorInput?.query, 120)}`
    : [text(executorInput?.owner, 80), text(executorInput?.repo, 120)].filter(Boolean).join('/');
  return {
    kind: 'network',
    action: redactPreview(`GitHub ${action || '查询'} ${target}`, 500),
    hosts: ['api.github.com'],
    risk: 'low',
    reversible: true
  };
}

function windowPreview() {
  return {
    kind: 'window-input',
    action: '向目标窗口发送指令',
    risk: 'high',
    reversible: false
  };
}

function cliPreview(executor, executorInput, project) {
  const writable = executorInput?.write === true;
  const name = text(executor?.name, 60) || 'Agent';
  return {
    kind: writable ? 'file-write' : 'model',
    action: writable ? `${name} 将读取并修改项目文件` : `${name} 将读取项目文件`,
    ...(executorInput?.workspace ? { cwd: safePath(executorInput.workspace) } : project?.path ? { cwd: safePath(project.path) } : {}),
    ...(writable && project?.path ? { paths: [safePath(project.path)] } : {}),
    risk: writable ? 'medium' : 'low',
    reversible: !writable
  };
}

export function buildPreview({ executor, executorInput, project, fallbackText } = {}) {
  const id = executor?.id || '';
  let preview;
  if (id === 'terminal') preview = terminalPreview(executorInput);
  else if (id === 'browser') preview = browserPreview(executorInput);
  else if (id === 'github') preview = githubPreview(executorInput);
  else if (id === 'window') preview = windowPreview(executorInput);
  else if (id === 'model' || ['cli', 'model'].includes(executor?.kind)) {
    preview = cliPreview(executor, executorInput, project);
  } else {
    preview = {
      kind: 'model',
      action: redactPreview(fallbackText, 500),
      risk: 'medium',
      reversible: false
    };
  }
  const tier = preview.risk === 'high' ? 'autopilot' : preview.risk === 'medium' ? 'draft' : 'investigate';
  return {
    ...preview,
    ...(preview.paths ? { paths: list(preview.paths, 20, 500) } : {}),
    ...(preview.hosts ? { hosts: list(preview.hosts, 20, 200) } : {}),
    tier
  };
}

export function previewQuestion(executorName, preview) {
  const name = text(executorName, 60) || 'Agent';
  if (!preview) return `请确认让 ${name} 执行这次任务`;
  if (preview.kind === 'command') return `${name} 将执行命令：${redactPreview(preview.action, 160)}`;
  if (preview.kind === 'window-input') return `${name} 将向窗口发送指令：${redactPreview(preview.action, 120)}`;
  if (preview.kind === 'network') return `${name} 将访问网络：${redactPreview(preview.action, 160)}`;
  if (preview.kind === 'file-write') return `${name} 将读取并修改项目文件`;
  return `${name} 将执行任务：${redactPreview(preview.action, 160)}`;
}
