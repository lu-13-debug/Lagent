import type { Task } from './types';

export function recentTasks<T extends { updatedAt: string }>(tasks: T[], limit = 5): T[] {
  return [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}

export function prepareGoal(value: string): string | undefined {
  return value.trim() || undefined;
}

export function taskStatusHint(task?: Pick<Task, 'status'> & Partial<Pick<Task, 'error' | 'steps'>>): string {
  if (!task) return '暂无当前分析';
  if (task.status === 'failed') return `分析失败：${task.error || '请打开执行详情查看原因'}`;
  if (task.status === 'awaiting_approval') return '等待你的确认，请打开执行详情审查后继续';
  if (task.status === 'completed') return '分析已完成，可查看完整报告';
  if (task.status === 'cancelled') return '分析已取消';
  const step = task.steps?.find(item => item.status === 'running');
  return step ? `正在执行：${step.name}` : '分析正在运行，请打开执行详情查看进度';
}
