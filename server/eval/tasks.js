// 确定性 eval 任务：不调用真实模型，用脚本化执行器验证「派单 → 执行 → 验收」链路。
// 任务都在临时工作区运行，失败不会污染真实项目。
import fs from 'node:fs';
import path from 'node:path';

const inside = (root, relative) => {
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(root + path.sep);
};

export const EVAL_TASKS = Object.freeze([
  {
    id: 'create-file',
    name: '写一个文件',
    goal: '创建 hello.txt',
    actions: [{ write: { path: 'hello.txt', content: 'hello\n' } }],
    expect: ctx => fs.readFileSync(path.join(ctx.dir, 'hello.txt'), 'utf8') === 'hello\n'
  },
  {
    id: 'plan-two-steps',
    name: '两步计划',
    goal: '先写 a 再写 b',
    plan: [
      { actions: [{ write: { path: 'a.txt', content: 'a\n' } }] },
      { actions: [{ write: { path: 'b.txt', content: 'b\n' } }] }
    ],
    expect: ctx => fs.existsSync(path.join(ctx.dir, 'a.txt')) && fs.existsSync(path.join(ctx.dir, 'b.txt'))
  },
  {
    id: 'verify-pass',
    name: '带验收通过',
    goal: '写测试并通过',
    actions: [{
      write: {
        path: 'ok.test.mjs',
        content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n"
      }
    }],
    verify: { command: 'node --test ok.test.mjs' },
    expect: ctx => ctx.acceptance?.status === 'passed'
  },
  {
    id: 'verify-fail',
    name: '验收失败',
    goal: '验收必须失败',
    actions: [{
      write: {
        path: 'bad.test.mjs',
        content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('bad', () => assert.equal(1, 2));\n"
      }
    }],
    verify: { command: 'node --test bad.test.mjs' },
    expect: ctx => ctx.acceptance?.status === 'failed' && ctx.ticket.status === 'blocked'
  },
  {
    id: 'reject-escape',
    name: '拒绝越界写入',
    goal: '写到工作区外',
    actions: [{ write: { path: '../escape.txt', content: 'x' } }],
    expect: ctx => ctx.ticket.status === 'failed' && ['failed', 'blocked'].includes(ctx.ticket.status)
  }
]);

/** 脚本化执行器：把 actions 变成真实的文件操作，用于可重复的 eval。 */
export function scriptedExecutor({ workspace, id = 'terminal' } = {}) {
  return {
    id,
    name: 'Eval 脚本执行器',
    kind: 'tool',
    available: true,
    requiresDataset: false,
    capabilities: ['commands'],
    validateInput(input) {
      if (!input || typeof input !== 'object' || !Array.isArray(input.actions)) throw Object.assign(new Error('eval 输入需要 actions'), { status: 400 });
      return input;
    },
    start(ticket, assignment, input) {
      const actions = Array.isArray(input?.actions) ? input.actions
        : Array.isArray(input?.executorInput?.actions) ? input.executorInput.actions
          : [];
      const root = typeof input?.workspace === 'string' && input.workspace ? path.resolve(input.workspace) : path.resolve(workspace);
      try {
        for (const action of actions) {
          if (action?.write) {
            const relative = String(action.write.path || '');
            if (!relative || path.isAbsolute(relative) || !inside(root, relative)) {
              return { id: assignment.id, status: 'failed', error: `拒绝越界写入：${relative}`, artifacts: {} };
            }
            const target = path.resolve(root, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, String(action.write.content ?? ''), 'utf8');
          }
          if (action?.fail) throw new Error(action.fail);
        }
        return { id: assignment.id, status: 'completed', report: { summary: '脚本执行完成' }, artifacts: { terminal: { command: 'eval', exitCode: 0 } } };
      } catch (error) {
        return { id: assignment.id, status: 'failed', error: error?.message || '脚本执行失败', artifacts: {} };
      }
    },
    get() { return null; }
  };
}
