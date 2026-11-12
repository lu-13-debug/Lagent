import { test, expect } from '@playwright/test';

const project = {
  id: 'p1', name: 'lagent', path: 'D:\\lagent', gitBranch: 'main', entryCount: 12, chatCount: 1,
  chats: [{ id: 'c1', projectId: 'p1', executorId: 'claude-code', title: '主对话', writable: true, permission: 'workspace', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z' }],
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
};
const brief = {
  projectId: 'p1', goal: '把 Lagent 改成任务优先的指挥台', summary: '完成导航、审批、派活模式与右栏改造。',
  keyPoints: ['审批去弹窗', '右栏三标签'], decisions: ['高频导航常驻，低频收进更多'], constraints: ['不重写主壳'],
  openQuestions: ['是否删掉旧分析工作台'], nextSteps: ['统一两套状态词'], verifyCommands: ['npm test'],
  sources: { nextSteps: 'mcp', openQuestions: 'ui' }, updatedAt: '2026-11-11T10:00:00.000Z',
};

test('项目简报能展示并保存未解问题、下一步与验收命令', async ({ page }) => {
  let saved: Record<string, unknown> | null = null;
  await page.request.post('/api/auth/register', { data: { username: `brief${Date.now()}`, displayName: '简报', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true, memory: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: { capabilities: { work: true }, tickets: [], attention: [], datasets: [], agents: [], tools: [], policy: { mode: 'personal', acceptMode: 'explicit', allowedExecutors: ['analysis', 'terminal'] } } }));
  await page.route('**/api/work/projects', route => route.fulfill({ json: { projects: [project] } }));
  await page.route('**/api/work/projects/p1/brief', async route => {
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { brief: { ...brief, ...saved } } });
    }
    return route.fulfill({ json: { brief } });
  });
  await page.route('**/api/work/projects/p1/changes', route => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/work/projects/p1/memory', route => route.fulfill({ json: { projectId: 'p1', entries: [], updatedAt: '2026-11-11T09:00:00.000Z' } }));
  await page.route('**/api/work/windows**', route => route.fulfill({ json: { windows: [] } }));
  await page.route('**/api/work/providers**', route => route.fulfill({ json: { providers: [] } }));

  await page.goto('/');
  await page.getByRole('button', { name: '项目', exact: true }).click();
  await page.getByRole('button', { name: /变更档案/ }).click();

  await expect(page.getByPlaceholder('等待确认的取舍、已知风险')).toHaveValue('是否删掉旧分析工作台');
  await expect(page.getByPlaceholder('接手的人先做什么')).toHaveValue('统一两套状态词');
  await expect(page.getByPlaceholder('npm test')).toHaveValue('npm test');
  await expect(page.getByText('含外部 Agent 写入')).toBeVisible();

  await page.getByPlaceholder('等待确认的取舍、已知风险').fill('是否删掉旧分析工作台\n是否需要成本页');
  await page.getByPlaceholder('接手的人先做什么').fill('统一两套状态词\n补 eval 集');
  await page.getByPlaceholder('npm test').fill('npm test\nnpm run build');
  await page.getByRole('button', { name: '保存简报' }).click();

  await expect.poll(() => saved).not.toBeNull();
  expect(saved?.openQuestions).toEqual(['是否删掉旧分析工作台', '是否需要成本页']);
  expect(saved?.nextSteps).toEqual(['统一两套状态词', '补 eval 集']);
  expect(saved?.verifyCommands).toEqual(['npm test', 'npm run build']);
});
