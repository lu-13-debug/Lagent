// 兼容门面：策略规则已移到 server/application/policy/model.js。
// 这一层只保留与环境变量相关的判定（是否启用工作台、外部执行器总开关）。
import { EXTERNAL_EXECUTORS } from '../application/policy/model.js';

export * from '../application/policy/model.js';

// 指挥台是唯一的前端界面，默认启用；显式设置 LAGENT_WORK_ENABLED=0 仍可关闭接口。
export const workEnabled = options => options?.workEnabled === true || (options?.workEnabled === undefined && process.env.LAGENT_WORK_ENABLED !== '0');

export function externalExecutorsEnabled(env = process.env) {
  return env.LAGENT_ALLOW_EXTERNAL_EXECUTORS === '1';
}

export function externalExecutorAllowed(id, policy, env = process.env) {
  if (!EXTERNAL_EXECUTORS.includes(id)) return true;
  return externalExecutorsEnabled(env) && policy.allowedExecutors.includes(id);
}
