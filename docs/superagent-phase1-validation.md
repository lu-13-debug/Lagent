# Super-agent Phase 0/1 后端验证

日期：2026-11-05
范围：Work 控制面后端、分析 executor 适配、Phase 1b 数据集选择与事件保留收尾。未修改 `src/superagent.ts`、`src/components/SuperAgentShell.tsx`、`src/superagent.css` 或 `App.tsx` 指挥台分支。

## 结论

Phase 0/1 后端已按 15:18 API 契约接通，并完成 Phase 1b 的数据集选择与 `work-event` 保留上限。Work 默认关闭；关闭时不注册 `/api/work/*`，旧 `/api/tasks*` 仍可用，运行能力中不出现 `superagent`。显式开启后 `capabilities.superagent:true`，五个 Work 路由可用，云服务未登录访问返回 401，并按账号工作区隔离 ticket、attention、assignment、report、dataset 元数据和 SSE。

启用方式：

```powershell
$env:DATAAGENT_WORK_ENABLED='1'
```

未设置或设为其他值时保持关闭。

## API 契约对齐

| 路由 | 实现结果 |
| --- | --- |
| `GET /api/work/bootstrap` | 返回 `{capabilities:{work:true}, tickets, attention, datasets, agents, tools, policy}`；attention 含 `ticketId/title`, 并保留契约中的 `question/options/createdAt`。 |
| `POST /api/work/command` | body `{text, clientRequestId?, datasetId?}`；`datasetId` 可选但一旦提供必须属于当前工作区；创建 manual Ticket，成功返回 `{ticket}`。 |
| `GET /api/work/tickets/:id` | 返回 `{ticket, assignments, reports}`；公开 Ticket 含 `datasetId`，不存在或跨账号返回 404。 |
| `POST /api/work/tickets/:id/actions` | 支持 `approve/reject/stop/retry/resume`；`approve` 的 `input.datasetId` 按下方契约解析，返回 `{ticket}`，未知或非法状态转换返回 400/409。 |
| `GET /api/work/events` | SSE 事件为 `{type:'ticket'|'assignment'|'report', ticketId, payload}`；空闲默认每 15 秒发送注释心跳，连接关闭时清理。 |

Ticket、Assignment、Report 的公开字段与契约一致。内部 `clientRequestId`、原始 command、useAI、lastAction 和 approvalSnapshot 不进入公开 projection；`datasetId` 属于公开 Ticket 字段，便于客户端恢复已选数据集。

## 数据集选择契约

`GET /api/work/bootstrap` 的 `datasets` 最多返回 50 项，每项只含只读元数据：

```json
{"id":"dataset-id","name":"上传数据","rowCount":1200,"source":"upload"}
```

响应不包含 `records`、预览行、文件内容或其他私有字段。

`POST /api/work/command` 可带 `datasetId`。不存在、类型非法或跨工作区时返回 400。相同 `clientRequestId` 只有在归一化指令和 `datasetId` 都一致时才幂等返回原 Ticket；修改任一项返回 409。

`approve` 的数据集解析顺序如下：

1. `input.datasetId` 显式选择，且必须是当前工作区现有数据集。
2. 否则使用当前 Ticket 已保存的 `datasetId`。分析或计划确认开始后不得改成另一数据集。
3. Ticket 尚未选择时，若工作区恰好 1 个数据集，自动选择该数据集。
4. 若工作区有多个数据集且 Ticket 尚未选择，返回 400，明确要求传 `datasetId`，不静默使用任意首个数据集。
5. 若工作区没有数据集，Ticket 转为 `blocked`，生成 blocked assignment 和 report，摘要提示先上传数据集。

静默使用 `store.list('dataset')[0]` 的旧回退已删除。`retry` 同样复用 Ticket 已冻结的数据集选择；数据集已不存在时返回 400。

## 事件保留

`work-event` 在每次写入的同一 SQLite 事务内裁剪：

- 每个 Ticket 最多保留最近 500 条事件。
- 每个 workspace 全局最多保留最近 5000 条事件。
- 先按全局最新顺序保留每个 Ticket 的 500 条，再截断到全局 5000 条；超出的最旧事件在同一事务中删除。
- 提交后照常向 SSE 订阅者发布本次新写入的事件，不因历史裁剪影响实时事件格式。

## 审计与修复

1. `clientRequestId` 按归一化指令和数据集选择幂等；相同编号但指令或数据集不同返回 409。
2. bootstrap attention 补齐 UI 契约需要的 `title`，同时保留 ticket 关联字段。
3. 失败同步沿用 executor task 的实际 `error`（截断到 400 字），不再丢失具体中断原因。
4. SSE 心跳周期可配置，生产默认仍为 15 秒；测试使用短周期验证心跳与关闭。
5. `analysis` executor 复用现有 `Workflow`/`runMultiWorkflow`、计划审批、取消和报告链路，仅负责 Ticket 与 assignment 的适配，没有复制分析业务逻辑；完成的报告写入 `artifacts.taskId` 和报告快照。
6. 重启后恢复持久化 Ticket/Assignment/Report；被现有 Workflow 标记为中断的 task 会同步为 failed，生成 failed report，之后可 `retry`。中断分析不会自动续跑。
7. 审批、退回、恢复、停止、重试均有状态校验和幂等返回；已有 assignment 的停止会更新 assignment 并生成 dropped report；重试会使用同一 analysis executor 创建新的 assignment。
8. Phase 1b 长事件测试覆盖每 Ticket 500 条与全局 5000 条上限，同时保留原 SSE 三类事件、心跳与关闭回归。

## 测试结果

本轮真实执行并通过：

```powershell
node --test --test-isolation=none server/work.test.js
# 10/10 通过

node --test --test-isolation=none server/cloud-app.test.js
# 22/22 通过

node --test --test-isolation=none server/app.test.js
# 21/21 通过

npx tsc --noEmit
# 通过
```

覆盖点包括契约字段与严格 projection、bootstrap 数据集元数据上限与脱敏、command/approve 的显式、单数据集自动、多数据集拒绝缺失、跨工作区拒绝、无数据集 blocked、数据集冻结、命令幂等/冲突、状态机、approve/reject/resume/stop/retry、报告 artifacts、事件 500/5000 保留、SSE 三类事件与心跳、工作区重启恢复、失败后重试、默认关闭、开启后能力暴露、旧 `/api/tasks` 仍存在，以及真实 `createCloudApp` 云账号 A/B 隔离。SQLite 仅打印 Node experimental warning，不影响结果。

## 限制与后续

- 中断的分析不会续跑；Ticket 收口为 failed，用户可通过 `retry` 重新派发。此边界避免恢复不完整的模型上下文。
- 本轮按要求只完成后端与文档；Super-agent UI 的数据集选择展示和交互由 Claude 侧另行处理。
- Policy 当前只有个人模式与 explicit 审批，不包含团队/自动审批策略。
- bootstrap 当前暴露一个 `analysis` agent，`tools` 为空。
- **Batch C/D 尚未开展**；工具面、团队策略及其他后续阶段留待下一轮。
- 本轮未执行全量 `npm test`、`npm run build` 或 e2e，也未调用真实付费模型；这些由 Claude 在沙箱外复跑。定向结果不代表全量验收。
- 保留全部既有未提交改动；本轮不提交、不打包、不部署。
