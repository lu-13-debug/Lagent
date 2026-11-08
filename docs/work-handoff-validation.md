# Work 跨执行器交接（Batch E8）

日期：2026-11-06。范围：`server/work/store.js`、`server/work/engine.js`、`server/work/routes.js`、`server/work.test.js`、`server/mobile-gateway.js`、`server/mobile-gateway.test.js` 与本文件。只改服务端 Work 与文档，未改 UI，未新增依赖，未开放自动执行。

## 手动交接语义

- 只有来源工单为 `completed` 时才能执行交接；其他状态返回 409。
- 调用 `POST /api/work/tickets/:id/actions`，body 为：

```json
{
  "action": "handoff",
  "input": {
    "executorId": "terminal",
    "text": "可选的新工单标题",
    "executorInput": {},
    "datasetId": "可选的数据集 ID"
  }
}
```

- `executorId` 必须显式提供，且目标执行器必须存在、可用并满足现有 Work policy guard；错误沿用现有执行器、授权与输入校验语义。
- 新工单初始状态为 `awaiting_review`，`source` 为 `handoff`，不会自动启动或自动批准。
- `title` 优先取 `input.text`，否则继承来源工单标题，最长 100 字。
- `handoffSummary` 继承来源工单的脱敏 `summary`，最长 400 字；不会自动拼接到目标提示词或 `executorInput`。
- analysis 目标继承来源 `datasetId`；不允许通过交接切换数据集。目标 `executorInput` 在创建阶段完成冻结校验，敏感原文只保存在内部 `work-control`，不进入普通公开投影。
- 交接是明确的单步动作，不会自动规划、不会自动执行、不会产生隐含的子任务树；目标执行器仍需人工审批。

## 深度与链标识

- 普通 command 工单的 `handoffDepth` 为 0，`chainRootId` 为空。
- 交接创建的子工单记录 `parentTicketId`、`chainRootId`、`handoffDepth`；来源工单记录 `handoffChildId`。
- 链深度硬上限为 3；允许创建深度 1 至 3，创建深度 4 返回 409。
- 所有字段只作为服务端存储与白名单投影，公开投影不增加命令原文、`executorInput`、凭据或 artifacts。

## 幂等、事务与事件

- 来源工单已有 `handoffChildId` 时，重复 handoff 返回同一子工单。首次创建返回 201，重复请求返回 200，并通过 `created:true/false` 区分。
- 创建和重复检查在同一事务内重新读取来源工单；并发 handoff 最多创建一个子工单。
- 来源工单和新工单的更新在同一事务内提交；事务提交后只发布新工单的普通 `ticket` 事件，不发布额外的自动执行事件。
- 审计记录 `action:'handoff'`、目标执行器和结果摘要；不记录命令、prompt、`executorInput`、凭据或原始输出。
- 跨 workspace 或跨账号的工单不可见，也不可交接；父/子工单遵循现有租户隔离。

## 公开与移动投影

- Work bootstrap/detail、`publicTicket` 和 SSE 只增加以下白名单字段：`parentTicketId`、`chainRootId`、`handoffDepth`、`handoffSummary`、`handoffChildId`。
- 移动投影只允许 `parentTicketId`、`handoffDepth`、`handoffSummary`（summary 最长 400 字），继续不返回 `executorInput`、命令、凭据或 artifacts。
- 公开 projection 只提供协作链标识、深度和脱敏摘要，不提供目标执行参数。

## v1 限制

- 交接必须由用户或上层明确发起，不会自动选择执行器、自动规划步骤或自动执行。
- `handoffSummary` 仅作为脱敏上下文展示，不自动注入目标提示词。
- v1 未实现自动规划、多分支团队编排、自动审批、跨执行器结果回注或分布式事务所有权；并发保护依赖当前 Store 的事务语义。
- durable outbox 与既有 policy 仍独立生效；本轮未开放自动执行、策略写、凭据或推送操作。
- 定向测试命令：`node --test server/work.test.js server/mobile-gateway.test.js`。全量测试、build 与 UI e2e 由 Claude 外跑；本轮不提交、不打包、不部署。

## 外部验收

2026-11-06：Claude 修正数据集切换状态码（400→409）与 handoff 事务未落库 child ticket 的问题，并为移动 actions 路由补 handoff 分支后，`work + mobile + app + cloud` 定向 71/71，全量 694/694，`npm run build` 通过，mobile/superagent/concise/handoff e2e 5/5。桌面与手机交接入口已接入，当前 UI 仅开放 analysis/Codex/Claude 目标。
