# Work durable launch outbox（Batch E5）

日期：2026-11-06。范围：`server/work/outbox.js`、`server/work/outbox.test.js`、`server/work/engine.js` 与本文件；只改服务端和文档，未改 UI，未新增依赖，未开放写操作。

## 开关与兼容性

- durable launch outbox **默认关闭**。`createWorkEngine(..., options)` 仅在 `options.outboxEnabled === true` 时启用。
- 关闭时 approve/retry 保持原有同步启动路径，不创建 `work-effect`，现有 analysis、terminal、CLI、browser、github 行为不变。
- 当前未增加 HTTP 开关；v1 通过程序化引擎选项开启，例如 `createWorkEngine(store, executor, publish, { outboxEnabled: true, outboxPollMs: 200 })`。`outboxPollMs` 最小 10ms，默认 200ms。
- 处理器由内部 `unref` 定时器或显式 `engine.drainOutbox({ now?, limit? })` 驱动。

## 持久实体与状态机

`work-effect` 实体字段为 `{id,kind:'launch',key,ticketId,payload,status,attempts,nextAt,lastError,createdAt,updatedAt}`。

- `pending`：等待到期启动。
- `running`：已被 claim，正在尝试启动。
- `done`：启动成功，或工单/assignment 已失效、停止取消。
- `failed`：永久错误或恢复/重试次数耗尽。

`enqueue` 以 `kind + key` 去重；重复入队覆盖白名单 payload，并恢复为 `pending`、`nextAt=now`。`claimDue` 只 claim `pending && nextAt<=now` 的记录，按 `nextAt/createdAt/id` 稳定排序，设置 `running` 且 `attempts += 1`。所有 outbox 写操作通过 Store 事务执行。

launch payload 只保留 `{assignmentId,datasetId,useAI}`；prompt、URL、命令参数、token、executorInput 与原始输出不进入 effect。

## 启动、预算与重试

- 开启后 approve/retry 只把 ticket/assignment 置为 `queued` 并写入 launch effect，不同步调用 `executor.start`。
- 实际启动前重新检查执行器可用性、policy allowlist/环境开关、每 ticket 调用次数与运行时长预算。
- `drainOutbox` 在 claim 前按 `policy.budgets.maxConcurrent` 限制本批数量；已有 `working` assignment 计入并发。
- 启动成功写回 `working`，effect 置 `done`，再进入既有 task sync/report/SSE 流程。
- transient 失败按 2s、4s、8s 退避；`OUTBOX_MAX_RETRIES=3` 表示首次尝试后可再重试 3 次，即最多 4 次启动尝试，之后 effect 与 ticket 收口为 `failed`。
- 400/401/403/404/409/422 视为永久失败，立即收口；400 对应 blocked，其余为 failed。
- 错误只保存稳定 code/status 生成的中文摘要，不记录异常原文。

## 恢复与停止

- 服务重启后，`running` 且 `attempts<=1` 的 effect 重新置为 `pending`，ticket/assignment 回到 `queued` 并继续处理。
- `running` 且 `attempts>1` 的 effect 标为 `failed`，同时收口 ticket、assignment 和 failed report，避免重复启动副作用。
- pending effect 直接由 `recover()` 继续 drain。
- stop 会把该 ticket 的 pending/running effect 取消为 `done`；若任务已经创建，继续调用执行器 stop。
- `close()` 清理定时器与订阅，不删除持久 effect。

## 审计与测试

- `work-audit` 记录 enqueue、launch、launch-retry、drain 故障和最终状态；reason 仅使用脱敏摘要，并沿用最近 2000 条保留策略。
- 定向测试：

```text
node --test server/work/outbox.test.js server/work.test.js
# 24/24 通过（E5 8 项 + Work/既有执行器回归 16 项）
```

覆盖 enqueue 去重、claim 顺序、成功、2s/4s/8s 退避与重试耗尽、重启一次恢复、二次崩后失败、stop/Abort 取消、并发上限、默认关闭零回归，以及 effect/audit/detail 不含敏感原文。

## 未实现与限制

- 未实现 `reply`、`deliver`、`notice` effect，不接任何写操作；本轮仅有 `launch`。
- 未增加 outbox 查询/管理 API，也未改 UI；默认应用接线保持关闭。
- 恢复与 claim 依赖单进程内的事务和定时器，不包含跨进程租约或分布式锁；多实例部署需要额外所有权机制。
- 全量测试、build 与 UI e2e 由 Claude 外跑；本轮未提交、打包或部署。