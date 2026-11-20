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
  },
  {
    id: 'create-nested',
    name: '创建嵌套目录文件',
    goal: '在多层目录里写文件',
    actions: [{ write: { path: 'src/deep/nested/file.txt', content: 'nested\n' } }],
    expect: ctx => fs.readFileSync(path.join(ctx.dir, 'src/deep/nested/file.txt'), 'utf8') === 'nested\n'
  },
  {
    id: 'empty-file',
    name: '创建空文件',
    goal: '写一个空文件',
    actions: [{ write: { path: 'empty.txt', content: '' } }],
    expect: ctx => fs.readFileSync(path.join(ctx.dir, 'empty.txt'), 'utf8') === ''
  },
  {
    id: 'unicode-content',
    name: '写入中文与 emoji',
    goal: '写中文内容',
    actions: [{ write: { path: 'notes.md', content: '你好，世界 🚀\n' } }],
    expect: ctx => fs.readFileSync(path.join(ctx.dir, 'notes.md'), 'utf8').includes('🚀')
  },
  {
    id: 'large-file',
    name: '写入较大文件',
    goal: '写 200KB 文件',
    actions: [{ write: { path: 'big.txt', content: 'x'.repeat(200 * 1024) } }],
    expect: ctx => fs.statSync(path.join(ctx.dir, 'big.txt')).size === 200 * 1024
  },
  {
    id: 'many-files',
    name: '一次写 12 个文件',
    goal: '批量写文件',
    actions: Array.from({ length: 12 }, (_, index) => ({ write: { path: `batch/${index}.txt`, content: `${index}` } })),
    expect: ctx => Array.from({ length: 12 }, (_, index) => fs.readFileSync(path.join(ctx.dir, `batch/${index}.txt`), 'utf8')).join(',') === Array.from({ length: 12 }, (_, index) => String(index)).join(',')
  },
  {
    id: 'overwrite-file',
    name: '后写覆盖前写',
    goal: '同一个文件写两次',
    actions: [{ write: { path: 'same.txt', content: 'first' } }, { write: { path: 'same.txt', content: 'second' } }],
    expect: ctx => fs.readFileSync(path.join(ctx.dir, 'same.txt'), 'utf8') === 'second'
  },
  {
    id: 'fail-action',
    name: '执行器报错落为失败',
    goal: '主动失败',
    actions: [{ fail: '模拟执行器失败' }],
    expect: ctx => ctx.ticket.status === 'failed'
  },
  {
    id: 'reject-absolute',
    name: '拒绝绝对路径写入',
    goal: '写绝对路径',
    actions: [{ write: { path: 'C:/tmp/lagent-eval.txt', content: 'x' } }],
    expect: ctx => ctx.ticket.status === 'failed'
  },
  {
    id: 'reject-empty-path',
    name: '拒绝空路径写入',
    goal: '写空路径',
    actions: [{ write: { path: '', content: 'x' } }],
    expect: ctx => ctx.ticket.status === 'failed'
  },
  {
    id: 'plan-three-steps',
    name: '三步依赖计划',
    goal: '依次写三个文件',
    plan: [
      { actions: [{ write: { path: 'p1.txt', content: '1' } }] },
      { actions: [{ write: { path: 'p2.txt', content: '2' } }] },
      { actions: [{ write: { path: 'p3.txt', content: '3' } }] }
    ],
    expect: ctx => ['p1.txt', 'p2.txt', 'p3.txt'].every(file => fs.existsSync(path.join(ctx.dir, file)))
  },
  {
    id: 'plan-parallel',
    name: '两条独立分支汇合',
    goal: '并行写再汇合',
    plan: [
      { actions: [{ write: { path: 'left.txt', content: 'l' } }] },
      { actions: [{ write: { path: 'right.txt', content: 'r' } }], dependsOn: [] },
      { actions: [{ write: { path: 'merged.txt', content: 'm' } }], dependsOn: [0, 1] }
    ],
    expect: ctx => ['left.txt', 'right.txt', 'merged.txt'].every(file => fs.existsSync(path.join(ctx.dir, file)))
  },
  {
    id: 'plan-single-dependency',
    name: '两步单依赖计划',
    goal: '只有一条链',
    plan: [
      { actions: [{ write: { path: 'only.txt', content: '1' } }] },
      { actions: [{ write: { path: 'only-2.txt', content: '2' } }] }
    ],
    expect: ctx => fs.existsSync(path.join(ctx.dir, 'only.txt')) && fs.existsSync(path.join(ctx.dir, 'only-2.txt'))
  },
  {
    id: 'verify-contains',
    name: '验收按输出内容匹配',
    goal: '验收输出包含版本号',
    actions: [{ write: { path: 'marker.txt', content: 'ok' } }],
    verify: { command: 'node --version', expect: 'contains:v' },
    expect: ctx => ctx.acceptance?.status === 'passed'
  },
  {
    id: 'verify-reads-output',
    name: '验收读取上一步产出',
    goal: '验收检查文件内容',
    actions: [
      { write: { path: 'data.txt', content: '42\n' } },
      {
        write: {
          path: 'data.test.mjs',
          content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('data', () => assert.equal(readFileSync('data.txt', 'utf8').trim(), '42'));\n"
        }
      }
    ],
    verify: { command: 'node --test data.test.mjs' },
    expect: ctx => ctx.acceptance?.status === 'passed'
  },
  {
    id: 'verify-blocked',
    name: '验收失败阻塞工单',
    goal: '验收必须失败',
    actions: [{
      write: {
        path: 'blocked.test.mjs',
        content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('bad', () => assert.equal(1, 3));\n"
      }
    }],
    verify: { command: 'node --test blocked.test.mjs' },
    expect: ctx => ctx.acceptance?.status === 'failed' && ctx.ticket.status === 'blocked'
  },
  {
    id: 'goal-multiline',
    name: '多行目标任务',
    goal: '第一行\n第二行\n第三行',
    actions: [{ write: { path: 'multi.txt', content: 'ok' } }],
    expect: ctx => fs.existsSync(path.join(ctx.dir, 'multi.txt'))
  },
  {
    id: 'no-actions',
    name: '空动作仍算完成',
    goal: '什么都不做',
    actions: [],
    expect: ctx => ctx.ticket.status === 'completed'
  },
  {
    id: 'write-json',
    name: '写入 JSON 文件',
    goal: '写 package.json',
    actions: [{ write: { path: 'package.json', content: '{"name":"eval","version":"1.0.0"}\n' } }],
    expect: ctx => JSON.parse(fs.readFileSync(path.join(ctx.dir, 'package.json'), 'utf8')).name === 'eval'
  },
  {
    id: 'spaced-name',
    name: '文件名带空格',
    goal: '写带空格的文件名',
    actions: [{ write: { path: 'my notes.txt', content: 'space' } }],
    expect: ctx => fs.readFileSync(path.join(ctx.dir, 'my notes.txt'), 'utf8') === 'space'
  },
  {
    id: 'deep-nested-delete-safe',
    name: '深层路径不误删',
    goal: '写深层文件并保留邻文件',
    actions: [
      { write: { path: 'keep/a.txt', content: 'a' } },
      { write: { path: 'keep/deep/b.txt', content: 'b' } }
    ],
    expect: ctx => fs.existsSync(path.join(ctx.dir, 'keep/a.txt')) && fs.existsSync(path.join(ctx.dir, 'keep/deep/b.txt'))
  },
  {
    id: 'reject-dotdot-nested',
    name: '拒绝嵌套越界',
    goal: '从子目录跳出',
    actions: [{ write: { path: 'sub/../../escape.txt', content: 'x' } }],
    expect: ctx => ctx.ticket.status === 'failed'
  },
  {
    id: 'ten-small-files',
    name: '十个小编号文件',
    goal: '写 10 个文件',
    actions: Array.from({ length: 10 }, (_, index) => ({ write: { path: `n/${index}.txt`, content: String(index) } })),
    expect: ctx => fs.readdirSync(path.join(ctx.dir, 'n')).length === 10
  },
  {
    id: 'verify-exit-zero',
    name: '验收退出码为零',
    goal: '验收通过',
    actions: [{
      write: {
        path: 'exit.test.mjs',
        content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.ok(true));\n"
      }
    }],
    verify: { command: 'node --test exit.test.mjs', expect: 'exit=0' },
    expect: ctx => ctx.acceptance?.status === 'passed'
  },
  {
    id: 'dotfile',
    name: '写入点文件',
    goal: '写 .gitignore',
    actions: [{ write: { path: '.gitignore', content: 'node_modules/\n' } }],
    expect: ctx => fs.readFileSync(path.join(ctx.dir, '.gitignore'), 'utf8').includes('node_modules')
  },
  {
    id: 'write-then-verify-blocked-dir',
    name: '越界写入不产生验收',
    goal: '越界后不跑验收',
    actions: [{ write: { path: '../outside.txt', content: 'x' } }],
    verify: { command: 'node --version' },
    expect: ctx => ctx.ticket.status === 'failed' && !ctx.acceptance
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
