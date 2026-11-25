# 手机端对话式指挥台实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/m` 从工单遥控界面改造成 ChatGPT 式对话界面，支持单/多 Agent、实时思考、会话历史、工作文件夹、按 Agent 思考强度与报告全文。

**Architecture:** 复用桌面端 Work 会话引擎（Lagent 主控 + ticket 挂会话）。服务端在 `server/mobile-gateway.js` 增加会话/模型/报告/权限路由与裁剪函数，引擎只做三处小改动（轮次幂等、`efforts` 映射、`reportText`）。前端把 `MobileApp.tsx` 拆成 `MobileChat / MobileThinking / MobileTickets / MobileCommand`，纯逻辑放进 `mobile-chat-model.ts` 便于单测。

**Tech Stack:** Express 5（ESM）、React 19 + TypeScript、Vite、node:test、Playwright。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `server/work/report-text.js`（新增） | 报告正文优先级与截断，服务端唯一实现 |
| `server/work/efforts.js`（新增） | 强度档位校验与按 Agent 取值 |
| `server/work/conversations.js` | 轮次保存 `clientRequestId`，提供查重 |
| `server/work/engine.js` | 幂等返回、`efforts` 穿透、`reportText(id)` |
| `server/mobile-gateway.js` | 裁剪函数、分页、新路由、SSE activity |
| `server/work/routes.js` | 把执行器注册表传给移动路由 |
| `src/mobile/types.ts`（新增） | 移动端类型 |
| `src/mobile/mobile-api.ts`（新增） | 请求封装与接口函数 |
| `src/mobile/mobile-chat-model.ts`（新增） | 分组、去重、白名单、分页、强度合并等纯函数 |
| `src/mobile/MobileThinking.tsx`（新增） | 思考块与权限步骤 |
| `src/mobile/MobileTickets.tsx`（新增） | 从 `MobileApp.tsx` 抽出的工单详情与文件预览 |
| `src/mobile/MobileCommand.tsx`（新增） | 从 `MobileApp.tsx` 抽出的工具指令表单 |
| `src/mobile/MobileChat.tsx`（新增） | 对话页、抽屉、输入区、三个弹层 |
| `src/mobile/MobileApp.tsx` | 外壳、tab、bootstrap、SSE、设置 |
| `src/mobile/mobile.css` | 对话相关样式 |
| `server/mobile-conversations.test.js`（新增） | 纯函数与轮次幂等单测 |
| `src/mobile/mobile-chat-model.test.mjs`（新增） | 前端纯函数单测 |
| `e2e/mobile-chat.spec.ts`（新增） | 对话主流程 E2E |

约定：移动端 `mode:auto` 表示单 Agent（Lagent），`mode:multi` 表示多 Agent；`efforts` 只按 `agentIds` 过滤，非法档位 400。

---

### Task 1: 报告正文共享模块

**Files:**
- Create: `server/work/report-text.js`
- Test: `server/mobile-conversations.test.js`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { clipReportText, reportTextOfReport } from './work/report-text.js';

test('报告正文按 acp → cli → window → report → summary 取值', () => {
  assert.equal(reportTextOfReport({ artifacts: { acp: { text: ' A ' }, cli: { summary: 'B' }, summary: 'S' } }), 'A');
  assert.equal(reportTextOfReport({ artifacts: { cli: { summary: 'B' } }, summary: 'S' }), 'B');
  assert.equal(reportTextOfReport({ artifacts: { window: { text: 'W' } } }), 'W');
  assert.equal(reportTextOfReport({ artifacts: { report: { summary: 'R' } }, summary: 'S' }), 'R');
  assert.equal(reportTextOfReport({ summary: ' S ' }), 'S');
  assert.equal(reportTextOfReport(null), '');
});

test('正文截断返回 truncated 标记，未超出时原样返回', () => {
  assert.deepEqual(clipReportText('abc', 10), { text: 'abc', truncated: false });
  assert.deepEqual(clipReportText('abcdef', 3), { text: 'abc', truncated: true });
  assert.deepEqual(clipReportText(null, 3), { text: '', truncated: false });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/mobile-conversations.test.js`
Expected: FAIL，`Cannot find module ... report-text.js`

- [ ] **Step 3: 实现**

```js
// 报告正文的唯一提取实现：桌面详情、移动裁剪、报告全文路由都走这里，避免三处不一致。
const textOf = value => (typeof value === 'string' ? value.trim() : '');

export function reportTextOfReport(report) {
  const source = report && typeof report === 'object' && !Array.isArray(report) ? report : {};
  const artifacts = source.artifacts && typeof source.artifacts === 'object' ? source.artifacts : {};
  return textOf(artifacts?.acp?.text)
    || textOf(artifacts?.cli?.summary)
    || textOf(artifacts?.window?.text)
    || textOf(artifacts?.report?.summary)
    || textOf(source.summary);
}

export function clipReportText(value, max) {
  const text = typeof value === 'string' ? value : '';
  const limit = Number.isSafeInteger(max) && max > 0 ? max : 20000;
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}
```

- [ ] **Step 4: 运行通过**

Run: `node --test server/mobile-conversations.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/work/report-text.js server/mobile-conversations.test.js
git commit -m "feat(mobile): share report text extraction"
```

---

### Task 2: 轮次保存与查询 clientRequestId

**Files:**
- Modify: `server/work/conversations.js:99-115`（投影不暴露）、`143-171`（保存）
- Test: `server/mobile-conversations.test.js`

- [ ] **Step 1: 追加失败测试**

```js
import { createConversationService } from './work/conversations.js';

function fakeDb() {
  const rows = new Map();
  return {
    get: (kind, id) => rows.get(`${kind}:${id}`) || null,
    put: (kind, row) => { rows.set(`${kind}:${row.id}`, JSON.parse(JSON.stringify(row))); return row; },
    delete: (kind, id) => rows.delete(`${kind}:${id}`),
    list: kind => [...rows].filter(([key]) => key.startsWith(`${kind}:`)).map(([, row]) => row)
  };
}

test('轮次保存 clientRequestId 但不对外投影，可按它查到已有轮次', () => {
  const service = createConversationService(fakeDb(), { now: () => '2026-11-25T00:00:00.000Z' });
  const created = service.create({ goal: '测试幂等' });
  const { turn } = service.addTurn(created.id, {
    prompt: '测试幂等',
    mode: 'auto',
    agentIds: ['model'],
    runs: [{ ticketId: 't-1', agentId: 'model', role: 'answer' }],
    clientRequestId: 'mobile-once'
  });
  assert.equal(turn.clientRequestId, 'mobile-once');
  assert.equal(service.get(created.id).turns[0].clientRequestId, undefined);
  assert.equal(service.turnByClientRequestId(created.id, 'mobile-once').id, turn.id);
  assert.equal(service.turnByClientRequestId(created.id, 'mobile-other'), null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/mobile-conversations.test.js`
Expected: FAIL，`service.turnByClientRequestId is not a function`

- [ ] **Step 3: 实现**

在 `addTurn` 的 `turn` 对象加入：

```js
      ...(identifier(input.clientRequestId, 'clientRequestId') ? { clientRequestId: identifier(input.clientRequestId, 'clientRequestId') } : {}),
```

在 `createConversationService` 内新增函数（放在 `addTurn` 后）：

```js
  function turnByClientRequestId(id, clientRequestId) {
    const clean = identifier(clientRequestId, 'clientRequestId');
    if (!clean) return null;
    const row = find(id);
    return turnIdsOf(row).find(turn => turn.clientRequestId === clean) || null;
  }
```

在返回值中导出 `turnByClientRequestId`。`publicConversation` 保持现有显式字段列表，不加入该字段。

- [ ] **Step 4: 运行通过**

Run: `node --test server/mobile-conversations.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/work/conversations.js server/mobile-conversations.test.js
git commit -m "feat(mobile): persist turn clientRequestId"
```

---

### Task 3: 强度取值模块与引擎 efforts 穿透

**Files:**
- Create: `server/work/efforts.js`
- Modify: `server/work/engine.js:55-74`（导入）、`1884-1910`（managedExecutorInput）、`1918-2066`（buildManagedSteps）、`2068-2115`（startManagedTurn）、`3014-3037`（conversationMessage）
- Test: `server/mobile-conversations.test.js`

- [ ] **Step 1: 追加失败测试**

```js
import { agentEffort, normalizeEfforts } from './work/efforts.js';

test('按 Agent 的强度：没有映射沿用全局，有映射缺失协作用 default', () => {
  assert.equal(agentEffort(null, 'model', 'high'), 'high');
  assert.equal(agentEffort({ model: 'max', codex: 'low' }, 'model', 'high'), 'max');
  assert.equal(agentEffort({ model: 'max' }, 'codex', 'default'), 'default');
  assert.equal(agentEffort({ model: 'bogus' }, 'model', 'high'), 'high');
  assert.deepEqual(normalizeEfforts({ model: 'high', codex: 'low', terminal: 'max' }, ['model', 'codex']), { model: 'high', codex: 'low' });
  assert.equal(normalizeEfforts(undefined, ['model']), null);
  assert.throws(() => normalizeEfforts({ model: 'nope' }, ['model']), /思考强度/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/mobile-conversations.test.js`
Expected: FAIL，`Cannot find module ... efforts.js`

- [ ] **Step 3: 实现 efforts.js**

```js
import { workError } from './domain.js';

export const EFFORTS = Object.freeze(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
const allowed = new Set(EFFORTS);
export const isEffort = value => typeof value === 'string' && allowed.has(value);

// 没有映射（桌面旧调用）→ 全局 effort；有映射 → 该 Agent 的档位，缺失则 default。
export function agentEffort(efforts, agentId, fallback = 'default') {
  if (!efforts || typeof efforts !== 'object' || Array.isArray(efforts)) return isEffort(fallback) ? fallback : '';
  return isEffort(efforts[agentId]) ? efforts[agentId] : (isEffort(fallback) ? fallback : 'default');
}

export function normalizeEfforts(value, agentIds = []) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workError('efforts 必须是对象', 400);
  const wanted = new Set(Array.isArray(agentIds) ? agentIds.filter(id => typeof id === 'string' && id) : []);
  const result = {};
  for (const [key, effort] of Object.entries(value)) {
    if (wanted.size && !wanted.has(key)) continue;
    if (!isEffort(effort)) throw workError(`思考强度无效：${String(key).slice(0, 60)}`, 400);
    result[key] = effort;
  }
  return Object.keys(result).length ? result : null;
}
```

- [ ] **Step 4: 引擎接线**

顶部导入：

```js
import { agentEffort, normalizeEfforts } from './efforts.js';
import { reportTextOfReport } from './report-text.js';
```

`conversationRunReport` 改为复用：

```js
  function conversationRunReport(ticketId) {
    try {
      const detail = api.detail(ticketId);
      const reports = detail.reports || [];
      for (let index = 0; index < reports.length; index += 1) {
        const value = reportTextOfReport(reports[index]);
        if (value) return value;
      }
      return String(reports[0]?.summary || detail.ticket.summary || '').trim();
    } catch { return ''; }
  }
```

`managedExecutorInput` 增加 `efforts` 参数并替换两处 effort：

```js
  function managedExecutorInput(executorId, { settings, models, efforts, executorInputs, prompt, maxSteps = 6, role = '' }) {
    const mapped = efforts && typeof efforts === 'object' && !Array.isArray(efforts);
    const effort = mapped
      ? agentEffort(efforts, executorId, executorId === LAGENT_EXECUTOR_ID ? (settings?.effort || 'default') : 'default')
      : (settings?.effort || '');
```

Lagent 分支保持 `...(effort ? { effort } : {})`；CLI 分支保持 `...(effort && effort !== 'default' ? { effort } : {})`。

`buildManagedSteps` 签名增加 `efforts`，并把所有 `managedExecutorInput(x, { settings, models,` 调用补成 `settings, models, efforts,`。`plan` 与兜底分支同样补上。

`startManagedTurn` 签名增加 `efforts = null`；入口查重：

```js
    const replay = clientRequestId ? conversations.turnByClientRequestId(conversation.id, clientRequestId) : null;
    if (replay) {
      const row = conversations.getRaw(conversation.id);
      const tickets = (replay.runs || []).map(run => { try { return get(run.ticketId); } catch { return { id: run.ticketId }; } });
      return { conversation: conversationSummary(row), turn: replay, tickets, replayed: true };
    }
```

单 Agent 分支的 `dispatchConversationRun` 调用补 `...(efforts ? { efforts } : {})` 不需要——Lagent 的强度已在 `settings.effort`；但为了让「只传 efforts.model」也生效，改成：

```js
    const lagentSettings = efforts && typeof efforts === 'object' && isEffort(efforts[LAGENT_EXECUTOR_ID])
      ? { ...(settings || {}), effort: efforts[LAGENT_EXECUTOR_ID] }
      : settings;
```

并在单 Agent 分支使用 `lagentSettings`。`buildManagedSteps` 调用补 `efforts`。两次 `conversations.addTurn(...)` 都补 `clientRequestId`。

`conversationMessage` 增加：

```js
      const efforts = normalizeEfforts(input?.efforts, agentIds);
```

并传给 `startManagedTurn`。

- [ ] **Step 5: 运行通过**

Run: `node --test server/mobile-conversations.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add server/work/efforts.js server/work/engine.js server/mobile-conversations.test.js
git commit -m "feat(mobile): per-agent effort and turn idempotency"
```

---

### Task 4: 引擎报告全文与 mobile 裁剪函数

**Files:**
- Modify: `server/mobile-gateway.js:144-299`
- Modify: `server/work/engine.js:2997` 附近新增 `reportText`
- Test: `server/mobile-conversations.test.js`

- [ ] **Step 1: 追加失败测试**

```js
import { mobileWorkEvent, sanitizeMobileBootstrap, sanitizeMobileDetail, sanitizeMobileEfforts, sanitizeMobileSettings } from './mobile-gateway.js';

test('移动设置只保留 profileId/effort，efforts 只保留本次 Agent 的键', () => {
  assert.deepEqual(sanitizeMobileSettings({ profileId: 'p1', effort: 'high', permission: 'full', model: 'x' }), { profileId: 'p1', effort: 'high' });
  assert.deepEqual(sanitizeMobileEfforts({ model: 'high', codex: 'low', terminal: 'max' }, ['model', 'codex']), { model: 'high', codex: 'low' });
  assert.throws(() => sanitizeMobileEfforts({ model: 'nope' }, ['model']), /思考强度/);
});

test('bootstrap 只下发白名单字段，详情带裁剪后的 activity 与报告正文', () => {
  const bootstrap = sanitizeMobileBootstrap({
    tickets: [], attention: [], agents: [], plans: [],
    projects: [{ id: 'p1', name: '仓库', path: 'C:/repo', gitBranch: 'main', apiKey: 'secret' }],
    conversations: [{ id: 'c1', title: '会话', status: 'working', turns: [{ prompt: 'x' }], secret: 's' }],
    lagent: { name: 'Lagent', executorId: 'model', ready: true, configured: true, reason: 'ok', token: 'secret' }
  });
  assert.deepEqual(bootstrap.projects, [{ id: 'p1', name: '仓库', path: 'C:/repo', gitBranch: 'main' }]);
  assert.equal(bootstrap.conversations[0].secret, undefined);
  assert.equal(bootstrap.lagent.token, undefined);

  const artifact = 'A'.repeat(20005);
  const detail = sanitizeMobileDetail({
    ticket: { id: 't1', status: 'working', secret: 's' },
    activity: [{ kind: 'thought', text: '思考', detail: '细节', secret: 's', decided: true }],
    reports: [{ id: 'r1', ticketId: 't1', summary: '摘要', artifacts: { acp: { text: artifact } } }]
  });
  assert.deepEqual(detail.activity, [{ kind: 'thought', text: '思考', detail: '细节', decided: true }]);
  assert.equal(detail.reports[0].text.length, 20000);
  assert.equal(detail.reports[0].truncated, true);
});

test('SSE 事件带裁剪后的 activity', () => {
  const event = mobileWorkEvent({ type: 'activity', ticketId: 't1', payload: { status: 'working', activity: [{ kind: 'tool', text: 'ls', secret: 's' }] } });
  assert.deepEqual(event.payload.activity, [{ kind: 'tool', text: 'ls' }]);
  assert.equal(event.payload.secret, undefined);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test server/mobile-conversations.test.js`
Expected: FAIL，裁剪函数未导出/未包含字段

- [ ] **Step 3: 实现裁剪**

在 `mobile-gateway.js` 顶部导入：

```js
import { reportTextOfReport, clipReportText } from './work/report-text.js';
import { isEffort, normalizeEfforts } from './work/efforts.js';
```

新增（放在 `sanitizeMobilePolicy` 前）：

```js
const CONVERSATION_STATUS = new Set(['waiting', 'working', 'awaiting_review', 'completed', 'failed', 'cancelled']);
const activityKinds = new Set(['thought', 'tool', 'observation', 'error', 'permission']);

export const sanitizeMobileSettings = value => {
  const source = object(value);
  if (!source) return null;
  const result = {};
  const profileId = text(source.profileId, 100);
  if (profileId && /^[A-Za-z0-9._:-]{1,100}$/.test(profileId)) result.profileId = profileId;
  if (isEffort(source.effort)) result.effort = source.effort;
  return Object.keys(result).length ? result : null;
};

export const sanitizeMobileEfforts = (value, agentIds = []) => {
  if (value === undefined || value === null) return undefined;
  if (!object(value)) throw mobileError('efforts 必须是对象', 400);
  const allowed = new Set(Array.isArray(agentIds) ? agentIds : []);
  const result = {};
  for (const [key, effort] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    if (!isEffort(effort)) throw mobileError('思考强度无效', 400);
    result[key] = effort;
  }
  return Object.keys(result).length ? result : undefined;
};

export function sanitizeMobileProject(value) {
  const source = object(value);
  const project = pick(source, ['id', 'name', 'gitBranch']);
  if (!project?.id) return null;
  const projectPath = text(source.path, 500);
  if (projectPath !== undefined) project.path = projectPath;
  return project;
}

export function sanitizeMobileConversationSummary(value) {
  const source = object(value);
  const conversation = pick(source, ['id', 'title', 'goal', 'projectId', 'createdAt', 'updatedAt']);
  if (!conversation?.id) return null;
  conversation.status = CONVERSATION_STATUS.has(source.status) ? source.status : 'waiting';
  conversation.turnCount = Math.max(0, integer(source.turnCount) || 0);
  const lastPrompt = text(source.lastPrompt, 4000);
  if (lastPrompt !== undefined) conversation.lastPrompt = lastPrompt;
  if (['auto', 'multi', 'plan', 'review'].includes(source.lastMode)) conversation.lastMode = source.lastMode;
  conversation.participants = Array.isArray(source.participants)
    ? source.participants.filter(item => typeof item === 'string').slice(0, 4).map(item => item.slice(0, 60))
    : [];
  return conversation;
}

export function sanitizeMobileTurn(value) {
  const source = object(value);
  const turn = pick(source, ['id', 'index', 'prompt', 'mode', 'createdAt']);
  if (!turn?.id) return null;
  if (!['auto', 'multi', 'plan', 'review'].includes(source.mode)) turn.mode = 'auto';
  turn.agentIds = Array.isArray(source.agentIds) ? source.agentIds.filter(item => typeof item === 'string').slice(0, 4).map(item => item.slice(0, 60)) : [];
  turn.runs = Array.isArray(source.runs) ? source.runs.slice(0, 8).map(run => pick(run, ['ticketId', 'agentId', 'role'])).filter(run => run?.ticketId) : [];
  if (typeof source.synthesisTicketId === 'string') turn.synthesisTicketId = source.synthesisTicketId.slice(0, 100);
  return turn;
}

export function sanitizeMobileActivity(value) {
  const source = object(value);
  if (!source || !activityKinds.has(source.kind)) return null;
  const result = { kind: source.kind };
  const body = text(source.text, 1200);
  if (body !== undefined) result.text = body;
  const detail = text(source.detail, 600);
  if (detail !== undefined) result.detail = detail;
  if (typeof source.at === 'string') result.at = source.at.slice(0, 40);
  if (typeof source.requestId === 'string') result.requestId = source.requestId.slice(0, 120);
  if (typeof source.decided === 'boolean') result.decided = source.decided;
  return result;
}

export function pageMobileTurns(turns, { limit = 30, before = null } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const size = Math.max(1, Math.min(50, Number(limit) || 30));
  const visible = before === null || before === undefined
    ? list.slice(-size)
    : list.filter(turn => (integer(turn.index) || 0) < before).slice(-size);
  const first = visible[0];
  const hasMore = Boolean(first) && list.some(turn => (integer(turn.index) || 0) < first.index);
  return { turns: visible, hasMore, nextBefore: hasMore ? first.index : null };
}
```

`sanitizeReport` 改为：

```js
const sanitizeReport = value => {
  const source = object(value);
  const report = pick(source, ['id', 'ticketId', 'assignmentId', 'kind', 'createdAt']);
  if (!report) return null;
  const summary = text(source?.summary, 400);
  if (summary !== undefined) report.summary = summary;
  const { text: body, truncated } = clipReportText(reportTextOfReport(source), 20000);
  if (body) report.text = body;
  if (truncated) report.truncated = true;
  return report;
};
```

`sanitizeMobileBootstrap` 增加：

```js
    projects: Array.isArray(source.projects) ? source.projects.slice(0, 100).map(sanitizeMobileProject).filter(Boolean) : [],
    conversations: Array.isArray(source.conversations) ? source.conversations.slice(0, 30).map(sanitizeMobileConversationSummary).filter(Boolean) : [],
    lagent: (() => {
      const sourceLagent = object(source.lagent);
      if (!sourceLagent) return null;
      return {
        name: text(sourceLagent.name, 60) || 'Lagent',
        executorId: text(sourceLagent.executorId, 60) || 'model',
        ready: sourceLagent.ready === true,
        configured: sourceLagent.configured === true,
        ...(text(sourceLagent.reason, 300) ? { reason: text(sourceLagent.reason, 300) } : {})
      };
    })(),
```

`sanitizeMobileDetail` 增加：

```js
  if (Array.isArray(source.activity)) result.activity = source.activity.slice(-40).map(sanitizeMobileActivity).filter(Boolean);
  const project = sanitizeMobileProject(source.project);
  if (project) result.project = project;
```

`mobileWorkEvent` 增加：

```js
  if (Array.isArray(payload.activity)) {
    const activity = payload.activity.slice(-40).map(sanitizeMobileActivity).filter(Boolean);
    if (activity.length) safe.activity = activity;
  }
```

引擎新增 `reportText(id)`（放在 `reportMarkdown` 后）：

```js
    reportText(id){
      const report=db.get('report',id);
      if(!report)throw workError('报告不存在',404);
      return {ticketId:report.ticketId||null,text:reportTextOfReport(report)};
    },
```

- [ ] **Step 4: 运行通过**

Run: `node --test server/mobile-conversations.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/mobile-gateway.js server/work/engine.js server/mobile-conversations.test.js
git commit -m "feat(mobile): sanitizers for conversations and activity"
```

---

### Task 5: 移动会话与模型路由

**Files:**
- Modify: `server/mobile-gateway.js:817-852`（路由注册签名与新增路由）
- Modify: `server/work/routes.js:430`
- Test: 手工 + Task 16 E2E（HTTP 层由 E2E mock 覆盖；服务端纯函数已被 Task 4 覆盖）

- [ ] **Step 1: 路由签名增加 executors**

```js
export function registerMobileWorkRoutes(app, gateway, { engine, executors, ownerId, onConnect } = {}) {
```

`routes.js` 改为：

```js
if(mobileGateway)registerMobileWorkRoutes(app,mobileGateway,{engine,executors:executor,ownerId:mobileOwnerId,onConnect:onMobileEventConnect});
```

- [ ] **Step 2: 新增校验与路由**

在 `registerMobileWorkRoutes` 内、`bootstrap` 路由前加入：

```js
  const MOBILE_AGENT_KINDS = new Set(['model', 'cli']);
  const LAGENT_ID = 'model';
  const readText = (value, max, message) => {
    const result = typeof value === 'string' ? value.trim() : '';
    if (!result || result.length > max) throw mobileError(message, 400);
    return result;
  };
  const mobileProfile = id => (app.locals.modelHub?.publicState?.()?.profiles || []).find(item => item.id === id);
  const collaboratorIds = value => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw mobileError('agentIds 必须是数组', 400);
    const ids = [...new Set(value.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean))];
    if (ids.length > 3) throw mobileError('多 Agent 模式最多选择 3 个协作 Agent', 400);
    const list = executors?.list?.() || [];
    const policy = engine.policy?.() || {};
    const allowed = new Set(Array.isArray(policy.allowedExecutors) ? policy.allowedExecutors : []);
    for (const id of ids) {
      if (id === LAGENT_ID) throw mobileError('Lagent 由主控自动加入', 400);
      const agent = list.find(item => item.id === id);
      if (!agent || !MOBILE_AGENT_KINDS.has(agent.kind)) throw mobileError(`「${id}」不是可协作的 Agent`, 400);
      if (!agent.available) throw mobileError(`「${agent.name || id}」当前不可用`, 400);
      if (allowed.size && !allowed.has(id)) throw mobileError(`「${agent.name || id}」不在允许的执行器范围内`, 403);
    }
    return ids;
  };
  const settingsOf = value => {
    const settings = sanitizeMobileSettings(value);
    if (settings?.profileId) {
      const profile = mobileProfile(settings.profileId);
      if (!profile || profile.unavailable) throw mobileError('所选模型不可用', 400);
    }
    return settings;
  };
```

在 `bootstrap` 后新增：

```js
  app.get('/api/mobile/models', (req, res) => {
    auth(req);
    const state = app.locals.modelHub?.publicState?.() || {};
    const efforts = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
    res.json({
      profiles: (Array.isArray(state.profiles) ? state.profiles : []).map(profile => ({
        id: String(profile.id),
        name: String(profile.name || profile.id).slice(0, 80),
        model: String(profile.model || '').slice(0, 120),
        available: profile.unavailable !== true,
        efforts: ['default', ...new Set((Array.isArray(profile.capabilities?.efforts) ? profile.capabilities.efforts : []).filter(item => efforts.includes(item)))]
      })),
      defaultProfileId: state.workflow?.defaultProfileId || null
    });
  });
  app.get('/api/mobile/conversations', (req, res) => {
    auth(req);
    let limit = 60;
    if (req.query.limit !== undefined) {
      if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) throw mobileError('会话数量参数无效');
      limit = Number(req.query.limit);
      if (limit < 1 || limit > 100) throw mobileError('会话数量参数无效');
    }
    const result = engine.listConversations(limit);
    res.json({ conversations: (result?.conversations || []).map(sanitizeMobileConversationSummary).filter(Boolean) });
  });
  app.post('/api/mobile/conversations', (req, res) => {
    auth(req);
    const goal = typeof req.body?.goal === 'string' ? req.body.goal.trim() : '';
    if (goal.length > 4000) throw mobileError('会话目标不能超过 4000 字', 400);
    const title = req.body?.title === undefined ? '' : readText(req.body.title, 200, '会话标题须为 1–200 字');
    const collaborators = collaboratorIds(req.body?.agentIds);
    let projectId;
    if (req.body?.projectId !== undefined) {
      if (typeof req.body.projectId !== 'string' || !req.body.projectId.trim()) throw mobileError('项目 id 无效', 400);
      projectId = req.body.projectId.trim();
    }
    const result = engine.createConversation({
      title: title || (goal ? goal.split('\n')[0].slice(0, 60) : undefined),
      goal,
      ...(projectId ? { projectId } : {}),
      agentIds: [LAGENT_ID, ...collaborators]
    });
    res.status(201).json({ conversation: sanitizeMobileConversationSummary(result?.conversation) });
  });
  app.get('/api/mobile/conversations/:id', (req, res) => {
    auth(req);
    let limit = 30;
    if (req.query.limit !== undefined) {
      if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) throw mobileError('分页参数无效');
      limit = Number(req.query.limit);
      if (limit < 1 || limit > 50) throw mobileError('分页参数无效');
    }
    let before = null;
    if (req.query.before !== undefined) {
      if (typeof req.query.before !== 'string' || !/^\d+$/.test(req.query.before)) throw mobileError('分页参数无效');
      before = Number(req.query.before);
    }
    const result = engine.getConversation(req.params.id);
    const page = pageMobileTurns(result?.conversation?.turns, { limit, before });
    const ticketIds = new Set();
    for (const turn of page.turns) {
      for (const run of Array.isArray(turn.runs) ? turn.runs : []) if (run.ticketId) ticketIds.add(run.ticketId);
      if (turn.synthesisTicketId) ticketIds.add(turn.synthesisTicketId);
    }
    res.json({
      conversation: {
        ...sanitizeMobileConversationSummary(result?.conversation),
        turns: page.turns.map(sanitizeMobileTurn).filter(Boolean),
        hasMore: page.hasMore,
        nextBefore: page.nextBefore
      },
      tickets: (result?.tickets || []).filter(ticket => ticketIds.has(ticket.id)).map(sanitizeMobileTicket).filter(Boolean)
    });
  });
  app.patch('/api/mobile/conversations/:id', (req, res) => {
    auth(req);
    const title = readText(req.body?.title, 200, '会话标题须为 1–200 字');
    res.json({ conversation: sanitizeMobileConversationSummary(engine.renameConversation(req.params.id, { title })?.conversation) });
  });
  app.delete('/api/mobile/conversations/:id', (req, res) => {
    auth(req);
    res.json({ ok: true, ...engine.deleteConversation(req.params.id) });
  });
```

- [ ] **Step 3: 静态检查**

Run: `node --check server/mobile-gateway.js && node --check server/work/routes.js`
Expected: 无输出

- [ ] **Step 4: 提交**

```bash
git add server/mobile-gateway.js server/work/routes.js
git commit -m "feat(mobile): conversation and model routes"
```

---

### Task 6: 发消息、报告全文、权限路由

**Files:**
- Modify: `server/mobile-gateway.js`（Task 5 路由块之后）

- [ ] **Step 1: 实现消息路由**

```js
  app.post('/api/mobile/conversations/:id/messages', async (req, res) => {
    auth(req);
    const text = readText(req.body?.text, 3000, '消息须为 1–3000 字');
    const mode = req.body?.mode === 'multi' ? 'multi' : 'auto';
    let agentIds = [LAGENT_ID];
    if (mode === 'multi') {
      const collaborators = collaboratorIds(req.body?.agentIds);
      if (!collaborators.length) throw mobileError('多 Agent 模式至少选择一个协作 Agent', 400);
      agentIds = [LAGENT_ID, ...collaborators];
    }
    const settings = settingsOf(req.body?.settings);
    const efforts = sanitizeMobileEfforts(req.body?.efforts, agentIds);
    let clientRequestId = '';
    if (req.body?.clientRequestId !== undefined) {
      if (typeof req.body.clientRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(req.body.clientRequestId.trim())) {
        throw mobileError('clientRequestId 无效', 400);
      }
      clientRequestId = req.body.clientRequestId.trim();
    }
    const result = await engine.conversationMessage(req.params.id, { text, mode, agentIds, settings, efforts, clientRequestId, autoRun: true });
    res.status(201).json({
      conversation: sanitizeMobileConversationSummary(result?.conversation),
      turn: sanitizeMobileTurn(result?.turn),
      tickets: (result?.tickets || []).map(sanitizeMobileTicket).filter(Boolean)
    });
  });
```

- [ ] **Step 2: 报告全文与权限**

```js
  app.get('/api/mobile/reports/:id/text', (req, res) => {
    auth(req);
    const result = engine.reportText(req.params.id);
    res.json(clipReportText(result?.text, 200000));
  });
  app.post('/api/mobile/tickets/:id/permissions/:requestId', (req, res) => {
    auth(req);
    const decision = req.body?.decision;
    if (decision !== 'allow' && decision !== 'deny') throw mobileError('授权决定只能是 allow 或 deny', 400);
    const result = engine.permissionDecision(req.params.id, req.params.requestId, decision);
    res.json({ ticket: sanitizeMobileTicket(result?.ticket) });
  });
```

- [ ] **Step 3: 静态检查**

Run: `node --check server/mobile-gateway.js`
Expected: 无输出

- [ ] **Step 4: 提交**

```bash
git add server/mobile-gateway.js
git commit -m "feat(mobile): message, report text and permission routes"
```

---

### Task 7: 前端类型与 API 封装

**Files:**
- Create: `src/mobile/types.ts`
- Create: `src/mobile/mobile-api.ts`

- [ ] **Step 1: 写 types.ts**

```ts
export type MobileDevice = { deviceId: string; deviceToken: string; expiresAt: string; name?: string };
export type MobileOption = { id?: string; label?: string; action?: string };
export type MobileAttention = { question?: string; createdAt?: string; options?: MobileOption[] };
export type MobileTicket = {
  id: string; title?: string; summary?: string; status: string; stage?: string; source?: string;
  executor?: string; createdAt?: string; updatedAt?: string; attention?: MobileAttention;
  parentTicketId?: string | null; handoffDepth?: number; handoffSummary?: string; handoffChildId?: string | null;
  planId?: string | null; planStep?: number | null; planTotal?: number | null;
};
export type MobileReport = { id: string; ticketId?: string; assignmentId?: string; kind?: string; summary?: string; text?: string; truncated?: boolean; createdAt?: string };
export type MobileActivityStep = { kind: 'thought' | 'tool' | 'observation' | 'error' | 'permission'; text?: string; detail?: string; at?: string; requestId?: string; decided?: boolean };
export type MobileThinkingStep = MobileActivityStep & { ticketId?: string };
export type MobileTeamNode = { id: string; parentId?: string | null; depth?: number; status?: string; proposals?: { id: string; kind: string; status: string }[] };
export type MobileDetail = { ticket: MobileTicket; assignments: { id: string; executor?: string; status?: string }[]; reports: MobileReport[]; activity?: MobileActivityStep[]; team?: { nodes: MobileTeamNode[]; cancelled?: boolean } };
export type MobileFile = { name: string; path: string; ext?: string; kind: string; size?: number; modifiedAt?: string; previewable?: boolean };
export type MobileFileTable = { name?: string; headers: string[]; rows: string[][]; truncated?: boolean };
export type MobileFilePreview = {
  path: string; name: string; kind: string; ext?: string; mime?: string; size?: number;
  text?: string; html?: string; truncated?: boolean; message?: string;
  headers?: string[]; rows?: string[][];
  slides?: { index: number; title: string; text: string }[];
  sheets?: MobileFileTable[];
};
export type MobileFileLink = { url: string; name: string; mime?: string; size?: number; expiresAt?: string };
export type MobileAgent = { id: string; name: string; kind?: string; status?: string; capabilities?: string[] };
export type MobileProject = { id: string; name: string; path?: string; gitBranch?: string };
export type MobileNotification = { id: string; ticketId?: string; title: string; status: string; summary: string; createdAt: string; unread: boolean };
export type MobileConversationSummary = {
  id: string; title: string; goal: string; projectId: string | null; participants: string[];
  status: 'waiting' | 'working' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled';
  turnCount: number; lastPrompt?: string; lastMode?: 'auto' | 'multi' | 'plan' | 'review'; createdAt: string; updatedAt: string;
};
export type MobileTurn = { id: string; index: number; prompt: string; mode: string; agentIds: string[]; runs: { ticketId: string; agentId: string; role: string }[]; synthesisTicketId?: string; createdAt: string };
export type MobileConversation = MobileConversationSummary & { turns: MobileTurn[]; hasMore: boolean; nextBefore: number | null };
export type MobileLagent = { name: string; executorId: string; ready: boolean; configured: boolean; reason?: string };
export type MobileBootstrap = {
  tickets: MobileTicket[]; attention: { ticketId: string; title?: string; question?: string; createdAt?: string; options?: MobileOption[] }[];
  agents: MobileAgent[]; projects?: MobileProject[]; conversations?: MobileConversationSummary[]; lagent?: MobileLagent | null;
  policy?: { allowedExecutors?: string[] }; notifications?: { unread?: number };
  plans?: { id: string; goal: string; status: string; currentStep: number; totalSteps: number; updatedAt?: string }[];
};
export type MobileModelProfile = { id: string; name: string; model: string; available: boolean; efforts: string[] };
export type MobileChatSettings = { profileId?: string; effort?: string };
export type MobileEfforts = Record<string, string>;
export type MobileEvent = { type: string; ticketId: string | null; payload: { status?: string; reportId?: string; activity?: MobileActivityStep[] } };
```

- [ ] **Step 2: 写 mobile-api.ts**

```ts
import type { MobileBootstrap, MobileChatSettings, MobileConversation, MobileConversationSummary, MobileDetail, MobileEfforts, MobileModelProfile, MobileTicket, MobileTurn } from './types';

export class MobileApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function mobileRequest<T>(path: string, token: string, options: RequestInit = {}, timeoutMs = 30000): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(`/api/mobile${path}`, {
    ...options, signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    credentials: 'same-origin', cache: 'no-store'
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new MobileApiError(body?.error || `请求失败（${response.status}）`, response.status);
  return body as T;
}

export const mobileApi = {
  bootstrap: (token: string) => mobileRequest<MobileBootstrap>('/bootstrap', token),
  models: (token: string) => mobileRequest<{ profiles: MobileModelProfile[]; defaultProfileId: string | null }>('/models', token),
  conversations: (token: string, limit = 60) => mobileRequest<{ conversations: MobileConversationSummary[] }>(`/conversations?limit=${limit}`, token),
  conversation: (token: string, id: string, options: { limit?: number; before?: number | null } = {}) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 30) });
    if (options.before !== null && options.before !== undefined) query.set('before', String(options.before));
    return mobileRequest<{ conversation: MobileConversation; tickets: MobileTicket[] }>(`/conversations/${encodeURIComponent(id)}?${query}`, token);
  },
  createConversation: (token: string, input: { title?: string; goal?: string; projectId?: string; agentIds?: string[] }) =>
    mobileRequest<{ conversation: MobileConversationSummary }>('/conversations', token, { method: 'POST', body: JSON.stringify(input) }),
  renameConversation: (token: string, id: string, title: string) =>
    mobileRequest<{ conversation: MobileConversationSummary }>(`/conversations/${encodeURIComponent(id)}`, token, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteConversation: (token: string, id: string) =>
    mobileRequest<{ ok: boolean }>(`/conversations/${encodeURIComponent(id)}`, token, { method: 'DELETE' }),
  sendMessage: (token: string, id: string, input: { text: string; mode: 'auto' | 'multi'; agentIds?: string[]; settings?: MobileChatSettings | null; efforts?: MobileEfforts; clientRequestId?: string }) =>
    mobileRequest<{ conversation: MobileConversationSummary; turn: MobileTurn; tickets: MobileTicket[] }>(`/conversations/${encodeURIComponent(id)}/messages`, token, { method: 'POST', body: JSON.stringify(input) }, 60000),
  ticket: (token: string, id: string) => mobileRequest<MobileDetail>(`/tickets/${encodeURIComponent(id)}`, token),
  reportText: (token: string, id: string) => mobileRequest<{ text: string; truncated: boolean }>(`/reports/${encodeURIComponent(id)}/text`, token),
  permission: (token: string, ticketId: string, requestId: string, decision: 'allow' | 'deny') =>
    mobileRequest<{ ticket: MobileTicket }>(`/tickets/${encodeURIComponent(ticketId)}/permissions/${encodeURIComponent(requestId)}`, token, { method: 'POST', body: JSON.stringify({ decision }) }),
  command: (token: string, body: Record<string, unknown>) => mobileRequest<{ ticket: MobileTicket }>('/command', token, { method: 'POST', body: JSON.stringify(body) }),
  action: (token: string, ticketId: string, body: Record<string, unknown>) =>
    mobileRequest<{ ticket: MobileTicket }>(`/tickets/${encodeURIComponent(ticketId)}/actions`, token, { method: 'POST', body: JSON.stringify(body) })
};
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过（此时 MobileApp 尚未引用，不应报错）

- [ ] **Step 4: 提交**

```bash
git add src/mobile/types.ts src/mobile/mobile-api.ts
git commit -m "feat(mobile): typed mobile API"
```

---

### Task 8: 前端纯函数与单测

**Files:**
- Create: `src/mobile/mobile-chat-model.ts`
- Test: `src/mobile/mobile-chat-model.test.mjs`

- [ ] **Step 1: 写测试**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const model = await import('./mobile-chat-model.ts');

test('会话按今天/昨天/更早分组，组内按更新时间倒序', () => {
  const now = new Date('2026-11-25T12:00:00.000Z');
  const groups = model.groupConversations([
    { id: 'a', updatedAt: '2026-11-25T10:00:00.000Z' },
    { id: 'b', updatedAt: '2026-11-24T10:00:00.000Z' },
    { id: 'c', updatedAt: '2026-11-01T10:00:00.000Z' }
  ], now);
  assert.deepEqual(groups.map(group => group.label), ['今天', '昨天', '更早']);
  assert.deepEqual(groups[0].items.map(item => item.id), ['a']);
});

test('活动合并去重并过滤 result，最多保留 200 条', () => {
  const merged = model.mergeActivity(
    [{ kind: 'thought', text: 'a', at: 't1' }],
    [{ kind: 'thought', text: 'a', at: 't1' }, { kind: 'result', text: 'r' }, { kind: 'tool', text: 'ls', at: 't2' }]
  );
  assert.deepEqual(merged.map(step => step.text), ['a', 'ls']);
  const many = Array.from({ length: 250 }, (_, index) => ({ kind: 'thought', text: String(index) }));
  assert.equal(model.mergeActivity([], many).length, 200);
  assert.equal(model.mergeActivity([], many)[0].text, '50');
});

test('设置白名单丢弃 permission/model，强度映射只保留已选 Agent', () => {
  assert.deepEqual(model.sanitizeSettings({ profileId: 'p1', effort: 'high', permission: 'full', model: 'x' }), { profileId: 'p1', effort: 'high' });
  assert.deepEqual(model.sanitizeEfforts(['model', 'codex'], { model: 'high', codex: 'low', terminal: 'max' }), { model: 'high', codex: 'low' });
  assert.deepEqual(model.removeEffort({ model: 'high', codex: 'low' }, 'codex'), { model: 'high' });
  assert.deepEqual(model.setEffort({ model: 'high' }, 'codex', 'max'), { model: 'high', codex: 'max' });
});

test('分页游标只返回更早轮次', () => {
  const turns = Array.from({ length: 40 }, (_, index) => ({ index }));
  const first = model.visibleTurns(turns, { limit: 30 });
  assert.equal(first.turns[0].index, 10);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextBefore, 10);
  const second = model.visibleTurns(turns, { limit: 30, before: first.nextBefore });
  assert.equal(second.turns.length, 10);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextBefore, null);
});

test('模型选项：Lagent 按能力过滤，协作方全档位', () => {
  assert.deepEqual(model.lagentEfforts({ efforts: ['low', 'high', 'bogus'] }), ['default', 'low', 'high']);
  assert.deepEqual(model.collaboratorEfforts(), ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- --test-name-pattern="会话按"` 或 `node --test src/mobile/mobile-chat-model.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 mobile-chat-model.ts**

```ts
import type { MobileActivityStep, MobileChatSettings, MobileConversationSummary, MobileEfforts, MobileThinkingStep, MobileTurn } from './types';

export const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];
const effortSet = new Set<string>(EFFORTS);
export const isEffort = (value: unknown): value is Effort => typeof value === 'string' && effortSet.has(value);

export function groupConversations<T extends { updatedAt: string }>(items: T[], now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const groups: { label: string; items: T[] }[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '更早', items: [] }
  ];
  for (const item of [...items].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))) {
    const stamp = Date.parse(item.updatedAt);
    const index = !Number.isFinite(stamp) || stamp < startOfYesterday ? 2 : stamp < startOfToday ? 1 : 0;
    groups[index].items.push(item);
  }
  return groups.filter(group => group.items.length > 0);
}

const stepKey = (step: MobileActivityStep) => `${step.at || ''}|${step.kind}|${step.text || ''}`;

export function mergeActivity(existing: MobileThinkingStep[], incoming: MobileThinkingStep[], limit = 200): MobileThinkingStep[] {
  const seen = new Set(existing.map(stepKey));
  const result = [...existing];
  for (const step of incoming) {
    if (step.kind === 'result') continue;
    const key = stepKey(step);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(step);
  }
  return result.slice(-limit);
}

export function sanitizeSettings(value: { profileId?: unknown; effort?: unknown; permission?: unknown; model?: unknown } | null | undefined): MobileChatSettings | null {
  if (!value || typeof value !== 'object') return null;
  const result: MobileChatSettings = {};
  if (typeof value.profileId === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value.profileId.trim())) result.profileId = value.profileId.trim();
  if (isEffort(value.effort)) result.effort = value.effort;
  return Object.keys(result).length ? result : null;
}

export function sanitizeEfforts(agentIds: string[], efforts: MobileEfforts | null | undefined): MobileEfforts | undefined {
  if (!efforts) return undefined;
  const allowed = new Set(agentIds);
  const result: MobileEfforts = {};
  for (const [key, value] of Object.entries(efforts)) if (allowed.has(key) && isEffort(value)) result[key] = value;
  return Object.keys(result).length ? result : undefined;
}

export function setEffort(efforts: MobileEfforts, agentId: string, effort: string): MobileEfforts {
  return { ...efforts, [agentId]: isEffort(effort) ? effort : 'default' };
}
export function removeEffort(efforts: MobileEfforts, agentId: string): MobileEfforts {
  const { [agentId]: _removed, ...rest } = efforts;
  return rest;
}

export function visibleTurns(turns: MobileTurn[], { limit = 30, before = null }: { limit?: number; before?: number | null } = {}) {
  const list = [...turns].sort((left, right) => left.index - right.index);
  const visible = before === null ? list.slice(-limit) : list.filter(turn => turn.index < before).slice(-limit);
  const hasMore = visible.length > 0 && list.some(turn => turn.index < visible[0].index);
  return { turns: visible, hasMore, nextBefore: hasMore ? visible[0].index : null };
}

export function lagentEfforts(profile?: { efforts?: string[] } | null): string[] {
  const supported = new Set((Array.isArray(profile?.efforts) ? profile!.efforts! : []).filter(isEffort));
  return ['default', ...EFFORTS.filter(effort => effort !== 'default' && supported.has(effort))];
}
export function collaboratorEfforts(): string[] {
  return [...EFFORTS];
}

export function conversationTitle(conversation: MobileConversationSummary): string {
  return conversation.title?.trim() || conversation.lastPrompt?.trim().slice(0, 60) || '新对话';
}

export function ticketIdsOfTurn(turn: MobileTurn): string[] {
  const ids = turn.runs.map(run => run.ticketId).filter(Boolean);
  if (turn.synthesisTicketId && !ids.includes(turn.synthesisTicketId)) ids.push(turn.synthesisTicketId);
  return ids;
}
```

- [ ] **Step 4: 运行通过**

Run: `node --test src/mobile/mobile-chat-model.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/mobile/mobile-chat-model.ts src/mobile/mobile-chat-model.test.mjs
git commit -m "feat(mobile): chat model helpers"
```

---

### Task 9: 抽出 MobileTickets 与 MobileCommand

**Files:**
- Create: `src/mobile/MobileTickets.tsx`
- Create: `src/mobile/MobileCommand.tsx`
- Modify: `src/mobile/MobileApp.tsx`

- [ ] **Step 1: 迁移 TickerDetail 整块**

把 `MobileApp.tsx` 第 492-534 行的 `TicketDetail` 与第 536-761 行的 `DOC_STYLE/docDocument/requestFileLink/downloadTicketFile/TicketFiles/FileTable/PdfPages/FilePreviewBody/FilePreviewSheet` 原样剪切到 `MobileTickets.tsx`。文件头部：

```tsx
import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, ChevronRight, Download, FileText, RefreshCw, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { STATUS_LABELS } from '../status';
import { mobileRequest } from './mobile-api';
import type { MobileAgent, MobileDetail, MobileFile, MobileFileLink, MobileFilePreview, MobileFileTable, MobileTicket } from './types';
```

导出两个组件：

```tsx
export function TicketDetail(props: { detail: MobileDetail | null; ticket?: MobileTicket; token: string; busy: boolean; agents: MobileAgent[]; allowed: string[]; onBack: () => void; onOpen: (id: string) => void; onAct: (ticketId: string, action: string, input?: Record<string, unknown>) => Promise<void>; onHandoff: (ticketId: string, executorId: string, text?: string) => Promise<void> }) { /* 原实现 */ }
export function TicketFiles({ ticketId, token }: { ticketId: string; token: string }) { /* 原实现 */ }
```

`FILE_KIND_LABELS`、`fileSize`、`time`、`statusNames`、`isAgentKind` 从 `MobileApp.tsx` 移到 `src/mobile/display.ts`（新建），两个文件都从那里导入，避免重复。`display.ts` 内容即原 `MobileApp.tsx:44-69` 的工具常量（去掉 React 依赖）。

- [ ] **Step 2: 抽出 MobileCommand**

把 `CommandView` 改名为 `MobileCommand` 放进 `src/mobile/MobileCommand.tsx`，删除执行者下拉框中的 Agent 分支：`available` 只保留 `!isAgentKind(agent.kind)` 的工具；去掉 `useEffect` 默认执行者逻辑，初始 `executorId` 取第一个工具 id。`onSent` 保持 `(ticket: MobileTicket) => void`。

- [ ] **Step 3: MobileApp 改为导入**

```tsx
import { MobileCommand } from './MobileCommand';
import { TicketDetail } from './MobileTickets';
```

删除原实现。原「指挥」tab 暂时仍渲染 `MobileCommand`，保证此任务行为不变。

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: tsc 与 vite 均通过

- [ ] **Step 5: 提交**

```bash
git add src/mobile/MobileTickets.tsx src/mobile/MobileCommand.tsx src/mobile/display.ts src/mobile/MobileApp.tsx
git commit -m "refactor(mobile): extract tickets and command views"
```

---

### Task 10: MobileThinking

**Files:**
- Create: `src/mobile/MobileThinking.tsx`

- [ ] **Step 1: 实现**

```tsx
import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Loader2, ShieldCheck, X } from 'lucide-react';
import type { MobileThinkingStep } from './types';

export type ThinkingGroup = {
  agentId: string;
  name: string;
  ticketId: string;
  status: string;
  steps: MobileThinkingStep[];
};

const stepText = (step: MobileThinkingStep) => step.text || step.detail || '';

function PermissionStep({ step, busy, onDecide }: { step: MobileThinkingStep; busy: boolean; onDecide: (requestId: string, decision: 'allow' | 'deny') => void }) {
  if (step.decided === true) return <div className="mob-step is-permission"><Check size={13} /><span>{stepText(step) || '已确认'}</span></div>;
  if (!step.requestId) return <div className="mob-step is-permission"><ShieldCheck size={13} /><span>{stepText(step)}</span></div>;
  return <div className="mob-step is-permission">
    <ShieldCheck size={13} />
    <span>{stepText(step) || '需要确认才能继续'}</span>
    <div className="mob-step-actions">
      <button type="button" className="mob-tiny" disabled={busy} onClick={() => onDecide(step.requestId!, 'allow')}>允许一次</button>
      <button type="button" className="mob-tiny ghost" disabled={busy} onClick={() => onDecide(step.requestId!, 'deny')}>拒绝</button>
    </div>
  </div>;
}

export function MobileThinking({ groups, running, open, onToggle, busy, onDecide }: {
  groups: ThinkingGroup[]; running: boolean; open: boolean; onToggle: () => void;
  busy: boolean; onDecide: (ticketId: string, requestId: string, decision: 'allow' | 'deny') => void;
}) {
  const [tab, setTab] = useState(0);
  const list = groups.filter(group => group.steps.length > 0 || group.status !== 'completed');
  if (!list.length) return null;
  const active = list[Math.min(tab, list.length - 1)];
  const total = list.reduce((sum, group) => sum + group.steps.length, 0);
  const label = running ? `正在思考 · ${total} 步` : `已思考 · ${total} 步`;
  return <section className={`mob-think ${open ? 'is-open' : ''}`}>
    <button type="button" className="mob-think-head" onClick={onToggle} aria-expanded={open}>
      {running ? <Loader2 size={14} className="mob-spin" /> : <Check size={14} />}
      <span>{label}</span>
      <ChevronDown size={15} className={open ? 'rotate' : ''} />
    </button>
    {open && <>
      {list.length > 1 && <div className="mob-think-tabs" role="tablist">
        {list.map((group, index) => <button type="button" role="tab" key={group.agentId} aria-selected={index === (tab >= list.length ? 0 : tab)} className={index === (tab >= list.length ? 0 : tab) ? 'active' : ''} onClick={() => setTab(index)}>{group.name}</button>)}
      </div>}
      <div className="mob-think-body">
        {active.steps.length === 0 && <p className="mob-hint">{active.status === 'failed' ? '这一步没有留下过程记录。' : '正在等待执行…'}</p>}
        {active.steps.map((step, index) => step.kind === 'permission'
          ? <PermissionStep key={`${step.at || ''}-${index}`} step={step} busy={busy} onDecide={(requestId, decision) => onDecide(active.ticketId, requestId, decision)} />
          : <div key={`${step.at || ''}-${index}`} className={`mob-step is-${step.kind}`}>
            {step.kind === 'error' ? <AlertTriangle size={13} /> : <span className="mob-step-dot" />}
            <span>{stepText(step)}</span>
          </div>)}
      </div>
    </>}
  </section>;
}
```

`import { X }` 不要保留未使用；最终只导入实际用到的图标。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过（组件未使用也允许）

- [ ] **Step 3: 提交**

```bash
git add src/mobile/MobileThinking.tsx
git commit -m "feat(mobile): thinking panel"
```

---

### Task 11: MobileChat 主界面（抽屉 + 消息流 + 输入区）

**Files:**
- Create: `src/mobile/MobileChat.tsx`

- [ ] **Step 1: 实现主体**

组件签名：

```tsx
export function MobileChat({ token, bootstrap, event, refreshKey, onOpenTicket, onToast, onUnauthorized, onReload }: {
  token: string;
  bootstrap: MobileBootstrap | null;
  event: MobileEvent | null;
  refreshKey: number;
  onOpenTicket: (id: string) => void;
  onToast: (message: string) => void;
  onUnauthorized: () => void;
  onReload: () => void;
})
```

内部状态与流程：

```tsx
const [activeId, setActiveId] = useState('');
const [conversation, setConversation] = useState<MobileConversation | null>(null);
const [detailTickets, setDetailTickets] = useState<Record<string, { ticket: MobileTicket; activity: MobileThinkingStep[]; reports: MobileReport[] }>>({});
const [liveSteps, setLiveSteps] = useState<Record<string, MobileThinkingStep[]>>({});
const [drawer, setDrawer] = useState(false);
const [sheet, setSheet] = useState<'' | 'model' | 'agents' | 'project'>('');
const [draft, setDraft] = useState('');
const [mode, setMode] = useState<'auto' | 'multi'>('auto');
const [collaborators, setCollaborators] = useState<string[]>([]);
const [efforts, setEfforts] = useState<MobileEfforts>({});
const [settings, setSettings] = useState<MobileChatSettings | null>(null);
const [projectId, setProjectId] = useState('');
const [busy, setBusy] = useState(false);
const [error, setError] = useState('');
const [modelNotice, setModelNotice] = useState('');
const [expanded, setExpanded] = useState<Record<string, boolean>>({});
const [fullText, setFullText] = useState<Record<string, string>>({});
const [loadingMore, setLoadingMore] = useState(false);
const [models, setModels] = useState<MobileModelProfile[]>([]);
const clientRequestId = useRef('');
```

关键行为：

1. `useEffect` 监听 `activeId`：为空则清空详情；否则 `mobileApi.conversation(token, activeId)`，写 `conversation`，拉最近 12 个 ticket 的详情。
2. `useEffect` 监听 `event`：`event.ticketId` 属于当前可见 ticket 时，`setLiveSteps` 合并 `event.payload.activity`；`event.type` 为 `ticket`/`report` 时 `onReload()`（父级防抖刷新 bootstrap）。
3. 发送：

```tsx
const send = async () => {
  const text = draft.trim();
  if (!text || busy || text.length > 3000) return;
  if (mode === 'multi' && collaborators.length === 0) { setError('多 Agent 模式至少选择一个协作 Agent'); return; }
  if (bootstrap?.lagent && !bootstrap.lagent.ready) { setError('Lagent 尚未配置模型，请到电脑端设置'); return; }
  if (!clientRequestId.current) clientRequestId.current = `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  setBusy(true); setError('');
  try {
    let id = activeId;
    if (!id) {
      const created = await mobileApi.createConversation(token, { goal: text, ...(mode === 'multi' ? { agentIds: collaborators } : {}), ...(projectId ? { projectId } : {}) });
      id = created.conversation.id;
      setActiveId(id);
    }
    const agentIds = mode === 'multi' ? ['model', ...collaborators] : ['model'];
    const effortMap = mode === 'multi'
      ? sanitizeEfforts(agentIds, { ...efforts, ...(settings?.effort ? { model: settings.effort } : {}) })
      : sanitizeEfforts(['model'], settings?.effort ? { model: settings.effort } : undefined);
    const result = await mobileApi.sendMessage(token, id, {
      text, mode,
      ...(mode === 'multi' ? { agentIds: collaborators } : {}),
      ...(settings ? { settings } : {}),
      ...(effortMap ? { efforts: effortMap } : {}),
      clientRequestId: clientRequestId.current
    });
    setDraft(''); clientRequestId.current = '';
    setConversation(previous => previous && previous.id === id
      ? { ...previous, turns: [...previous.turns, result.turn], updatedAt: new Date().toISOString() }
      : previous);
    onReload();
  } catch (cause) {
    setError((cause as Error).message);
  } finally { setBusy(false); }
};
```

4. 父级 `onBack`（从会话回到列表）由 MobileChat 内部的「☰ + 标题」承担：顶部左侧按钮打开抽屉，抽屉里切换会话；不设独立页面。`MobileApp` 直接渲染 `<MobileChat />` 于「对话」tab。

5. 会话切换时读取/写入本地设置：

```ts
const settingsKey = (id: string) => `lagent:mobile:chatmodel:v1:${id}`;
const LAST_KEY = 'lagent:mobile:chatmodel:last:v1';
```

`readStored(key)` 用 try/catch 解析；会话切换时 `setSettings`、`setEfforts`；首次进入新会话使用 LAST_KEY；模型不可用时 `setModelNotice('原模型不可用，已改用默认模型')` 并把 `profileId` 去掉。

6. 渲染结构：

```tsx
<div className="mob-chat">
  <header className="mob-chat-head">
    <button type="button" className="mob-icon" aria-label="会话列表" onClick={() => setDrawer(true)}><Menu /></button>
    <button type="button" className="mob-chat-title" onClick={() => setSheet('model')}>
      <strong>{conversation ? conversationTitle(conversation) : '新对话'}</strong>
      <span className="mob-chip">{modelLabel}{settings?.effort && settings.effort !== 'default' ? ` · ${effortLabel(settings.effort)}` : ''}</span>
    </button>
    <button type="button" className="mob-icon" aria-label="会话操作" onClick={() => setDrawer(true)}><MoreHorizontal /></button>
  </header>
  {modelNotice && <p className="mob-banner">{modelNotice}</p>}
  {!bootstrap?.lagent?.ready && <p className="mob-banner">Lagent 尚未配置模型，请到电脑端设置</p>}
  <main className="mob-chat-body">
    {(conversation?.hasMore) && <button type="button" className="mob-load-more" disabled={loadingMore} onClick={loadEarlier}>{loadingMore ? '正在加载…' : '加载更早'}</button>}
    {!conversation && <div className="mob-chat-empty"><h1>今天想让我做什么？</h1><p>选一个工作文件夹，或直接开始。</p></div>}
    {conversation?.turns.map(turn => <TurnBlock key={turn.id} ... />)}
  </main>
  <Composer ... />
  {drawer && <Drawer ... />}
  {sheet === 'model' && <ModelSheet ... />}
  {sheet === 'agents' && <AgentsSheet ... />}
  {sheet === 'project' && <ProjectSheet ... />}
</div>
```

`TurnBlock` 内：

- 用户气泡 `<p className="mob-msg user">{turn.prompt}</p>`；
- `groups` 来自 `turn.runs` + `detailTickets` + `liveSteps`；
- `running` = 任一 group status 在 `working/queued`；
- `<MobileThinking ... />`；
- 助手结论：`assistantReport(turn, detailTickets)` 取合成 ticket 或最后一个 run 的最新报告；`text` 用 `fullText[report.id] || report.text || report.summary`；`truncated` 时按钮「展开全文」调用 `mobileApi.reportText`。

纯函数 `assistantReport` 与 `thinkingGroups` 放进 `mobile-chat-model.ts` 并补测试：

```ts
export function assistantReport(turn: MobileTurn, tickets: Record<string, { reports: MobileReport[] }>) {
  const ids = turn.synthesisTicketId ? [turn.synthesisTicketId, ...turn.runs.map(run => run.ticketId)] : turn.runs.map(run => run.ticketId);
  for (const id of ids) {
    const report = (tickets[id]?.reports || [])[0];
    if (report?.text || report?.summary) return report;
  }
  return null;
}
```

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add src/mobile/MobileChat.tsx src/mobile/mobile-chat-model.ts src/mobile/mobile-chat-model.test.mjs
git commit -m "feat(mobile): conversation UI"
```

---

### Task 12: 三个弹层与抽屉细节

**Files:**
- Modify: `src/mobile/MobileChat.tsx`

- [ ] **Step 1: 抽屉**

- 顶部「新对话」按钮：`setActiveId(''); setConversation(null); setDraft(''); setDrawer(false)`。
- 分组渲染 `groupConversations(bootstrap.conversations || [])`；条目显示标题、项目名（`bootstrap.projects` 查找）、`statusNames`、时间。
- 每条右侧 `⋯`：`setMenuId(id)`，展开「重命名 / 删除」。重命名用 `window.prompt('重命名会话', title)`；删除用 `window.confirm('只删除会话记录，已派出的任务会继续在电脑端执行。确定删除？')`，成功后若删除的是当前会话则清空当前会话。
- 底部「工具指令」：`setTools(true)`，以全屏 sheet 渲染 `<MobileCommand token={token} bootstrap={bootstrap} loading={false} error="" allowed={...} agents={...} onSent={ticket => { setTools(false); onOpenTicket(ticket.id); onReload(); }} />`。

- [ ] **Step 2: 模型弹层**

- 打开时若 `models` 为空则 `mobileApi.models(token)`，按 `id` 缓存。
- 列表：默认项（`defaultProfileId` 标记「桌面默认」）+ 全部 profiles；`available === false` 置灰并显示「当前不可用」。
- 底部 Lagent 思考强度：`lagentEfforts(selectedProfile)`。
- 选择后立即写入 `settings` 与本地存储；弹层保持打开显示「已选择」。
- 运行中（`conversation.status === 'working'`）显示「下一轮生效」。

- [ ] **Step 3: 协作 Agent 弹层**

- 列表来自 `bootstrap.agents.filter(agent => ['model','cli'].includes(agent.kind || '') && agent.id !== 'model')`，再按 `allowedExecutors` 过滤（allowed 为空表示不限制）。
- 每行：`<input type="checkbox">` + 名称 + `<select>`（`collaboratorEfforts()`，未勾选禁用）。
- 勾选：最多 3 个，`setCollaborators` + `setEfforts(setEffort(efforts, id, 'default'))`。
- 取消：`removeEffort`。
- 不可用 Agent 置灰；若它已有强度（从本地恢复），保留在 `efforts` 里但不参与发送。
- 底部提示「未勾选时不能发送」。

- [ ] **Step 4: 项目弹层**

- 列表 `bootstrap.projects || []`，显示 `name` 与 `path` 尾两段；另有「不绑定项目」。
- 选择写入 `projectId` 与 `localStorage['lagent:mobile:newproject:v1']`。
- 已有会话时 chip 只读显示项目名，不打开弹层。

- [ ] **Step 5: 构建**

Run: `npm run build`
Expected: 通过

- [ ] **Step 6: 提交**

```bash
git add src/mobile/MobileChat.tsx
git commit -m "feat(mobile): chat drawer and sheets"
```

---

### Task 13: 外壳接入、SSE 与设置文案

**Files:**
- Modify: `src/mobile/MobileApp.tsx`
- Modify: `src/mobile/mobile.css`

- [ ] **Step 1: tab 与导航**

- `tab` 类型改为 `'chat' | 'inbox' | 'tickets' | 'settings'`，默认 `'chat'`。
- 导航第一项改为「对话」（`MessageSquare` 图标），顺序对话/收件箱/任务/设置。
- 「对话」tab 渲染 `<MobileChat token={...} bootstrap={bootstrap} event={lastEvent} refreshKey={refreshKey} onOpenTicket={id => { setDetailId(id); }} onToast={setNotice} onUnauthorized={onSignOut} onReload={reload} />`。
- 点击 `onOpenTicket` 时设置 `detailId`，现有 `TicketDetail` 分支优先渲染，行为不变。

- [ ] **Step 2: SSE 透传事件**

`useServerEvents` 签名改为：

```tsx
function useServerEvents(token: string, onEvent: (event: MobileEvent | null) => void, onUnauthorized: () => void)
```

解析处：

```tsx
if (data) {
  let parsed: MobileEvent | null = null;
  try { parsed = JSON.parse(data) as MobileEvent; } catch { /* 非 JSON 心跳 */ }
  handler.current(parsed);
}
```

`MobileHome` 中：

```tsx
const [lastEvent, setLastEvent] = useState<MobileEvent | null>(null);
const reloadTimer = useRef<number | null>(null);
const onEvent = useCallback((event: MobileEvent | null) => {
  if (!event) return;
  setLastEvent(event);
  if (event.type === 'ticket' || event.type === 'report') {
    if (reloadTimer.current !== null) return;
    reloadTimer.current = window.setTimeout(() => { reloadTimer.current = null; reload(); }, 1500);
  }
}, [reload]);
const online = useServerEvents(device.deviceToken, onEvent, unauthorized);
```

清理定时器。

- [ ] **Step 3: 15 秒轮询改为仅在非对话 tab**

现有 `setInterval` 每 15 秒刷新 bootstrap 会让对话页滚动跳动。改为仅当 `tab !== 'chat'` 时启动；对话页依赖 SSE + 发送后刷新。

- [ ] **Step 4: 设置页文案**

```tsx
<p className="mob-note"><ShieldCheck size={13} />可为会话选择 Lagent 模型与各 Agent 思考强度；仍不能管理凭据、策略或项目。</p>
```

- [ ] **Step 5: CSS**

在 `mobile.css` 末尾新增（沿用现有变量）：

```css
.mob-chat { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.mob-chat-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); background: var(--surface-0); position: sticky; top: 0; z-index: 5; }
.mob-chat-title { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; background: none; border: 0; color: var(--text-1); text-align: left; }
.mob-chat-title strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.mob-chip { font-size: 11px; color: var(--text-2); background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.mob-chat-body { flex: 1; overflow-y: auto; padding: 14px 12px 8px; display: flex; flex-direction: column; gap: 14px; }
.mob-chat-empty { margin: auto 0; padding: 40px 8px; text-align: center; color: var(--text-2); }
.mob-chat-empty h1 { font-size: 22px; color: var(--text-1); margin: 0 0 8px; }
.mob-msg { max-width: 86%; margin: 0; padding: 10px 12px; border-radius: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.mob-msg.user { align-self: flex-end; background: var(--accent-soft); color: var(--text-1); }
.mob-msg.assistant { align-self: flex-start; background: var(--surface-1); border: 1px solid var(--line); }
.mob-think { border: 1px solid var(--line); border-radius: 12px; background: var(--surface-1); overflow: hidden; }
.mob-think-head { width: 100%; display: flex; align-items: center; gap: 8px; padding: 9px 11px; background: none; border: 0; color: var(--text-2); font-size: 12px; }
.mob-think-head .rotate { transform: rotate(180deg); }
.mob-think-tabs { display: flex; gap: 4px; padding: 0 10px 8px; overflow-x: auto; }
.mob-think-tabs button { border: 0; background: var(--surface-2); color: var(--text-2); font-size: 12px; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
.mob-think-tabs button.active { background: var(--accent-soft); color: var(--text-1); }
.mob-think-body { padding: 0 11px 10px; display: flex; flex-direction: column; gap: 7px; }
.mob-step { display: flex; gap: 7px; font-size: 12.5px; line-height: 1.55; color: var(--text-2); }
.mob-step.is-tool, .mob-step.is-observation { font-family: var(--font-mono, "IBM Plex Mono", Consolas, monospace); font-size: 12px; }
.mob-step.is-error { color: #c0392b; }
.mob-step-dot { width: 5px; height: 5px; margin-top: 7px; border-radius: 50%; background: var(--text-3, var(--line)); flex: none; }
.mob-step-actions { display: flex; gap: 6px; margin-left: auto; }
.mob-tiny { border: 1px solid var(--line); background: var(--surface-0); color: var(--text-1); font-size: 11px; border-radius: 7px; padding: 2px 8px; }
.mob-tiny.ghost { color: var(--text-2); }
.mob-composer-bar { border-top: 1px solid var(--line); background: var(--surface-0); padding: 8px 12px calc(8px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: 8px; }
.mob-mode-tabs { display: flex; gap: 6px; align-items: center; }
.mob-mode-tabs button { border: 1px solid var(--line); background: var(--surface-1); color: var(--text-2); font-size: 12px; border-radius: 999px; padding: 3px 10px; }
.mob-mode-tabs button.active { background: var(--accent-soft); color: var(--text-1); }
.mob-composer-input { display: flex; gap: 8px; align-items: flex-end; }
.mob-composer-input textarea { flex: 1; resize: none; max-height: 140px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-1); color: var(--text-1); padding: 9px 11px; font: inherit; }
.mob-send { width: 38px; height: 38px; border-radius: 50%; border: 0; background: var(--accent, #111); color: #fff; display: grid; place-items: center; }
.mob-send:disabled { opacity: .45; }
.mob-drawer-layer, .mob-sheet-layer { position: fixed; inset: 0; z-index: 40; }
.mob-drawer-backdrop, .mob-sheet-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.32); border: 0; }
.mob-drawer { position: absolute; inset: 0 auto 0 0; width: min(86vw, 340px); background: var(--surface-0); display: flex; flex-direction: column; }
.mob-drawer-body { flex: 1; overflow-y: auto; padding: 8px; }
.mob-drawer-group { font-size: 11px; color: var(--text-3, var(--text-2)); padding: 10px 8px 4px; }
.mob-drawer-item { width: 100%; display: flex; gap: 8px; align-items: center; padding: 9px 8px; border: 0; border-radius: 9px; background: none; color: var(--text-1); text-align: left; }
.mob-drawer-item.active { background: var(--surface-2); }
.mob-drawer-item span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.mob-drawer-actions { display: flex; gap: 4px; border-top: 1px solid var(--line); padding: 8px; }
.mob-sheet-option { width: 100%; display: flex; gap: 10px; align-items: center; padding: 10px 12px; border: 0; border-bottom: 1px solid var(--line); background: none; color: var(--text-1); text-align: left; }
.mob-sheet-option:disabled { opacity: .45; }
.mob-sheet-option small { display: block; color: var(--text-2); font-size: 11px; }
.mob-banner { margin: 0; padding: 8px 12px; background: var(--accent-soft); color: var(--text-1); font-size: 12px; }
.mob-load-more { align-self: center; border: 1px solid var(--line); background: var(--surface-1); color: var(--text-2); border-radius: 999px; padding: 4px 14px; font-size: 12px; }
@media (max-width: 420px) { .mob-chat-title strong { font-size: 14px; } }
```

若变量名不存在（`--accent`、`--text-3`、`--font-mono`），优先改用 `mobile.css` 顶部已定义的变量，全部替换后再提交。

- [ ] **Step 6: 构建**

Run: `npm run build`
Expected: 通过

- [ ] **Step 7: 提交**

```bash
git add src/mobile/MobileApp.tsx src/mobile/mobile.css
git commit -m "feat(mobile): chat tab, SSE events and styles"
```

---

### Task 14: 旧 E2E 更新与新 E2E

**Files:**
- Modify: `e2e/mobile-command.spec.ts`
- Create: `e2e/mobile-chat.spec.ts`
- Modify: `e2e/handoff.spec.ts` 仅在默认 tab 影响导航时

- [ ] **Step 1: 更新 mobile-command**

- 配对后进入「对话」，打开抽屉点「工具指令」。
- 原断言「今天想让我做什么？」改为对话空状态。
- 工具指令里执行者只剩工具，选择终端、填参数、发送，然后进入任务详情。

- [ ] **Step 2: 新 mobile-chat.spec.ts**

Mock 这些接口：`/api/runtime`、`pair/claim`、`events`（abort）、`bootstrap`（含 projects/conversations/lagent/agents）、`conversations`、`conversations/:id/messages`、`tickets/:id`、`reports/:id/text`。

核心断言：

1. 新会话选项目 → 发送单 Agent → 请求体 `mode:auto`、`agentIds` 不含协作方、`settings` 含 profileId/effort。
2. 切多 Agent → 未勾选时发送禁用 → 勾两个 Agent 并设不同强度 → 请求体 `efforts` 为 `{ model, codex, claude-code }`。
3. 思考块默认展开，SSE 推送 activity 后追加步骤；完成后收起。
4. 报告 `truncated:true` 时点「展开全文」请求 `/reports/r1/text` 并替换正文。
5. 权限步骤点「允许一次」命中 `POST /tickets/t1/permissions/req-1`。

- [ ] **Step 3: 运行**

Run: `npm run test:e2e -- mobile-chat.spec.ts mobile-command.spec.ts handoff.spec.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add e2e/mobile-chat.spec.ts e2e/mobile-command.spec.ts e2e/handoff.spec.ts
git commit -m "test(mobile): conversation e2e"
```

---

### Task 15: 全量验证与 CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 运行全部检查**

Run:
```bash
npm test
npm run build
```
Expected: 全部通过

- [ ] **Step 2: 手工验收**

按设计文档「验收清单」逐项走一遍，重点：真机窄屏、软键盘、SSE 断线重连、长会话分页、报告展开全文。

- [ ] **Step 3: 更新 CHANGELOG**

在 `[Unreleased]` 下新增：

```md
### Added
- 手机端 `/m` 改为对话式指挥台：单/多 Agent、会话历史、工作文件夹、实时思考与报告全文。
- 手机端可按 Agent 单独调整思考强度；Lagent 可切换模型配置档。
### Changed
- 手机端默认 tab 从「指挥」改为「对话」；工具直连移到会话抽屉的「工具指令」。
```

- [ ] **Step 4: 提交**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for mobile chat"
```
