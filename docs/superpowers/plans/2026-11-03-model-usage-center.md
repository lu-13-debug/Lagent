# 模型用量与费用中心 v1 实施计划（2026-11-03）

用户要求继续完善软件。本轮目标：让「自带 Key」的模型花费可核对——按模型、阶段、日期和任务汇总供应商实际返回的 Token 用量，并由用户自行填写单价做明确标注的估算。不造假、不推断、不展示提示词或报告正文。

保留全部未提交改动；不提交、不打包、不部署。

## 一、现状与问题

1. 当前只有单份报告的「模型用量与估算费用」手动区块（`src/components/ModelUsage.tsx`），没有跨任务的汇总入口。
2. 阶段用量保存在 `task.artifacts[stage].calls[]`，但该结构存在重复与丢失：
   - 核验修订时 `task.artifacts.report` 被修订结果覆盖，原始报告阶段调用丢失；
   - 修订调用同时出现在 `artifacts.report.calls`、`artifacts.verify.calls` 和 `revisions[].result.calls`，按产物求和会重复计费。
3. 多模型评审员的调用只聚合成 `panel.reviewers[].tokens`（仅 total），没有逐次记录。
4. 旧单模型路径只有 `report.aiUsage`（一次调用）。

因此本轮必须先补一条**只追加、不覆盖的逐次调用账本**，再做汇总；不得用产物结构估算金额。

## 二、口径（必须遵守）

- 只统计**供应商实际返回用量**的调用。失败调用、未返回 `usage` 的调用不估算 Token，只计入「未返回用量的调用」数量。
- 账本在每次模型调用完成时写入，来源为 `runStageAgent` 的 `onUsage` 回调，与账单发生点一致。
- 连接测试、模型目录检测、本地确定性计算、报告探索、PDF 生成不计入。
- 多模型评审员计入，并标明 `kind: 'reviewer'` 与视角；裁判按普通阶段计入。不得重复计入 `panelTokens`。
- 旧单模型任务：仅在**没有账本记录**时使用 `task.report.aiUsage`，并标明 `source: 'legacy'`。
- 升级前已完成的阶段工作流任务没有逐次账本：**不按产物反推**，在接口返回中单独计数 `unledgeredTasks`，界面注明「升级前的任务未逐次记录，不计入合计」。
- 日期按任务调用的记录时间归入 `Asia/Shanghai` 自然日；不接受客户端传入时区。
- 接口不返回目标、消息、提示词、报告正文或数据明细；按任务行只返回 `taskId` 和计数，标题由前端用已有 bootstrap 数据映射。

## 三、服务端

### 1. 账本（新增 `server/model-usage.js`）

- 实体：`store.put('model-call', entry)`，`id` 使用 `randomUUID()`，只追加。
- `entry` 字段：
  ```js
  {
    id, taskId, stageId, stageName,
    kind: 'stage' | 'reviewer' | 'legacy',
    lens: string | null,              // 评审员视角
    provider, model, effort, protocol,
    inputTokens, outputTokens, totalTokens,
    cacheReadInputTokens, cacheCreationInputTokens, reasoningTokens, // 允许 null
    recordedAt: ISO 字符串
  }
  ```
- `modelCallEntry({ call, taskId, stage, kind, lens, now })` 纯函数：
  - 只接受安全非负整数；非法值写 `null`，不抛错。
  - `provider` / `model` / `effort` / `protocol` 截断到 200 字符并去掉换行。
  - `usage` 为 null 时仍写一条（用于统计「未返回用量」的调用）。
- `summarizeModelUsage({ calls, tasks, days, now })` 纯函数：
  - `days` 为 `7 | 30 | 90 | 'all'`；`all` 不限；其余按上海自然日向前取整段。
  - 忽略 `calls` 中 `taskId` 不存在于 `tasks` 的记录（防止脏数据）。
  - 输出：
    ```js
    {
      range: { days, from, to, timeZone: 'Asia/Shanghai' },
      totals: { calls, tasks, withUsage, missingUsage, inputTokens, outputTokens, totalTokens,
                cacheReadInputTokens, cacheCreationInputTokens, reasoningTokens },
      byModel: [{ provider, model, protocol, calls, tasks, withUsage, missingUsage,
                  inputTokens, outputTokens, totalTokens }],
      byStage: [{ stageId, stageName, calls, withUsage, missingUsage, inputTokens, outputTokens, totalTokens }],
      byDay: [{ date, calls, withUsage, missingUsage, inputTokens, outputTokens, totalTokens }],
      byTask: [{ taskId, calls, withUsage, missingUsage, inputTokens, outputTokens, totalTokens }],
      review: { calls, withUsage, missingUsage, tokens },
      unledgeredTasks: 0
    }
    ```
  - `byModel` 按 `provider + model + protocol` 分组；同模型不同协议分行，便于按协议估算。
  - 所有分组求和必须与 `totals` 一致（测试断言）。
- `legacyUsageEntry(task)`：无账本时把 `task.report.aiUsage` 转成一条 `kind:'legacy'` 记录。

### 2. 写入账本

- `server/stage-agent.js`：`runStageAgent` 新增可选 `onCall`；在 `onUsage` 中 `calls.push(call)` 后调用 `onCall?.(call)`。不得改变现有返回结构。
- `server/multi-workflow.js`：
  - 任务开始时创建 `recordCall = (call, meta) => { try { store.put('model-call', modelCallEntry({...})) } catch { /* 用量记录尽力而为，不影响任务 */ } }`。
  - 普通阶段与裁判传 `{ kind: 'stage', stageId: stage.id, stageName }`。
  - 评审员传 `{ kind: 'reviewer', lens: PANEL_LENSES[i].id, stageId: 'insights' }`。
  - 已有 `task.panelTokens` 与 `panel.reviewers[].tokens` 保持不变，但汇总接口只读账本，不再二次累加。
- 旧单模型路径不改：汇总时按 `report.aiUsage` 回退。

### 3. 路由与能力

- `server/app.js`：`GET /api/model-usage?days=30`
  - `days` 只接受 `7|30|90|all`，否则 400。
  - 读取 `store.list('task')` 与 `store.list('model-call')`，返回 `summarizeModelUsage(...)`。
  - 本地模式不需要认证；云端由 `createApp` 的每用户工作区天然隔离。
- `server/task-monitor.js`：`TASK_CAPABILITIES` 增加 `modelUsage: true`。
- 前端旧服务降级：`runtime.capabilities?.modelUsage !== true` 时不显示「模型用量」页签。

## 四、前端

### 1. 类型与 API

- `src/types.ts`：新增 `ModelUsageReport`（与接口一致）；`Runtime.capabilities` 允许 `modelUsage?: boolean`。
- `src/api.ts`：`modelUsage: (days: number | 'all') => request<ModelUsageReport>(`/model-usage?days=${days}`)`。

### 2. 纯函数（新增 `src/model-usage.ts` + `src/model-usage.test.mjs`）

- `modelRateKey(runtime, userId, origin)`：`lagent:model-rates:v1:${runtime}:${encodeURIComponent(origin)}:${cloud ? encodeURIComponent(userId || 'anonymous') : 'local'}`。
- `readModelRates(storage, key)` / `writeModelRates(storage, key, rates)`：
  - `rates` 形如 `{ [provider + '\u0000' + model]: { input: number, output: number } }`；
  - 只接受有限非负数；损坏数据返回空对象，不抛错。
- `mergeUsageRows(report)`：把 `byModel` 中同 provider+model 但不同协议的行按显示合并、费用按协议分别计算再相加，返回展示行（供表格与费用列）。
- `estimateUsageCost(row, rates)`：复用 `estimateModelCost`；无单价或缺用量返回 `null`；结果保留 6 位小数（仅展示，不四舍五入成账单）。
- `formatTokens(value)` / `formatUsageMissing(value)`：`null` 显示「未返回」，`0` 显示 `0`。

### 3. 界面（修改 `src/components/Pages.tsx`，新增 `src/components/ModelUsagePanel.tsx`、`src/model-usage.css`）

- `WalletPage` 增加页签：「服务额度」（现有内容原样）与「模型用量」。页签使用 `role="tablist"`、`aria-selected`、键盘左右切换。
- 模型用量面板：
  - 时间范围：近 7 / 30 / 90 天 / 全部，默认 30；切换即重新请求。
  - 四张统计卡：调用次数、覆盖任务数、输入 Token、输出 Token；副行显示「未返回用量的调用 N 次」。
  - 按模型表：供应商、模型、协议、调用、输入、输出、合计、估算费用、单价设置。
  - 按阶段表、按日表（窄屏可横向滚动）；按日可用简单 CSS 条形，必须有可访问表格替代。
  - 多模型评审块：参与评审调用、已完成/失败评审员、评审 Token（仅合计）。
  - 最近任务表：前端用 bootstrap 的 `tasks` 映射 `byTask.taskId` → 标题（缺失显示「已删除/不可用」），最多 20 行。
  - 单价设置：每个模型行旁的「设置单价」打开内联编辑；输入每百万 Token 单价（CNY/USD 仅作为展示币种，不换算）。
  - 空状态：「还没有模型用量。使用阶段工作流完成一次 AI 分析后，这里会显示供应商返回的 Token 用量。」
  - 固定说明：
    1. 仅统计供应商返回的用量；未返回或失败调用不估算。
    2. 连接测试、模型目录检测不计入。
    3. 估算费用仅按你填写的参考单价计算，不含缓存差价、分层价格、工具调用和税费，以供应商账单为准。
    4. 升级前完成的阶段任务没有逐次记录，不计入合计（`unledgeredTasks > 0` 时显示具体数量）。
- 不显示提示词、目标、业务背景或报告正文。
- 390px 下卡片单列、表格横向滚动、页签可点按；明暗主题都检查。

### 4. 可选入口

- 在报告页 `ModelUsage` 区块加一句「全部任务用量见 额度与使用记录 → 模型用量」的静态说明即可；不强制跳转，避免改 `ReportView` 结构。

## 五、测试与验收

### 服务端

- 新增 `server/model-usage.test.js`（≥12 项）：
  1. 普通阶段调用逐条入账并汇总；
  2. `usage` 为 null 计入 `missingUsage` 且不产生 Token；
  3. 非法/负数 Token 记为 null；
  4. 评审员 `kind:'reviewer'` 与 lens 正确；
  5. 评审员与裁判不重复计数；
  6. 旧 `aiUsage` 仅在无账本时回退；
  7. 有账本时忽略旧 `aiUsage`；
  8. 日期边界：上海 23:30 与次日 00:30 分属两天；
  9. 范围 7/30/90/all 过滤；
  10. 不存在的 taskId 被忽略；
  11. 各分组求和与 totals 一致；
  12. 输出不含目标、消息、报告正文（序列化字符串断言）。
- 扩展 `server/stage-agent.test.js`：每次 `chat` 成功回调都触发 `onCall`，失败不触发。
- 扩展 `server/multi-workflow.test.js`：
  - 一次启用评审的运行产生「阶段调用 + 评审员调用」数量的 `model-call` 实体；
  - 核验修订后账本包含原始报告、修订与复核调用，且无重复；
  - 取消/失败不影响已发生的账本条目。
- 扩展 `server/app.test.js` 与 `server/cloud-app.test.js`：
  - 本地 `GET /api/model-usage?days=30` 返回结构；非法 `days` 400；
  - 云端未登录 401；A 账号看不到 B 账号调用；
  - `runtime.capabilities.modelUsage === true`。

### 前端

- `src/model-usage.test.mjs`（≥6 项）：存储键分区、单价校验、损坏数据、合并同模型多协议、缺用量/缺单价返回 null、格式化。
- 新增 `e2e/model-usage.spec.ts`（route 桩 `/api/runtime`、`/api/bootstrap`、`/api/model-usage`）：
  - 页签切换、统计卡、按模型表、未返回用量提示、`unledgeredTasks` 提示、单价保存后估算费用出现；
  - 390px 截图与明暗主题各一张，存 `artifacts/`；
  - 旧服务 `capabilities.modelUsage` 缺失时不出现「模型用量」页签。

### 通过标准

- 定向 node 测试全绿；`npm test` 全量通过；`npm run build`（含 `tsc --noEmit`）通过。
- 新增 e2e 与既有 `workflow-panel`、`report-toc`、`model-picker`、`sticky-header` 通过。
- 完成后在协作信箱 5 行内回报：改动文件、测试命令与数量、截图路径、限制。

## 六、附带小修（低风险，独立验证）

1. **报告页重复「新建分析」**：`App.tsx` 的吸顶工具栏与 `ReportsPage` 页头各有一个同名主按钮。要求：报告视图在 1440 / 1024 / 390 宽度下，同一屏内只出现一个可见的「新建分析」主入口（侧栏「新建分析」不计）。新增 e2e 断言。
2. **评审开关无候选模型**：`WorkflowSettings` 在无其他可用模型配置时，勾选会写入 `''` 再触发校验错误。要求：无候选时禁用复选框并显示「没有可用的其他模型配置」；任何路径都不得产生空 reviewerProfileIds。补纯函数或 e2e 回归。

## 七、边界

- 不新增第三方依赖。
- 不改 `src/report-toc.*`、`src/components/ReportToc.tsx`、`src/components/ModelPicker.tsx`、`src/model-picker.*`、`src/components/ModelSettings.tsx`、`src/components/model-settings.css`、`e2e/report-toc.spec.ts`、`e2e/model-picker.spec.ts`、`OperationCharts/OperationChartControls/OperationChartVisual`、`src/operation-chart-*`。
- 本轮 `App.tsx`、`src/components/Pages.tsx`、`src/components/WorkflowSettings.tsx` 由 Codex 修改；Claude 不碰。
- 保留全部未提交改动；不提交、不打包、不部署。若发现账本写入与任务写入存在竞态或快照语义冲突，先回信箱说明。
