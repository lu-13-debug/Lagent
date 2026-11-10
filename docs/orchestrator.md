# 任务编排器（orchestrator）

一次「深度编排」把一句话目标变成一条可追踪的执行链：

```
分析任务 → 拆解步骤 → 等你批准 → 逐步分发给合适的 Agent → 验证结果 →（不过就返工，最多 2 轮）→ 汇总
```

## 边界原则

**工单是执行与审计的唯一真相，编排器只决定「下一步做什么」。** 编排器不保存执行输出、不做审批、
不自己写文件——它建工单、等工单到终态、把结果写进自己的运行记录。这样：

- 审批、权限、改动快照、执行记录都沿用既有那套，没有第二份状态；
- 关掉编排器（`DATAAGENT_ORCHESTRATOR=legacy`）时，旧流程完全不受影响；
- 运行记录丢了也不影响项目历史，反过来也不会有「编排器说成功、工单说失败」的分裂。

## 模块

| 文件 | 职责 |
| --- | --- |
| `server/work/orchestrator/index.js` | Mastra 工作流、分发、等待工单、返工循环、汇总 |
| `server/work/orchestrator/templates.js` | 四套任务模板与关键词识别、返工步骤 |
| `server/work/orchestrator/capabilities.js` | 每个执行器能做什么，据此分配步骤 |
| `server/work/orchestrator/runs.js` | 运行记录的读写（kind `work-run`） |

Mastra 只负责「步骤顺序 + 挂起/恢复」，状态落在自己的 SQLite（`data/orchestrator.db`，可用
`DATAAGENT_RUN_DB` 改），不写 Mastra 的 memory，也不依赖它的 agent。

## 状态机

```
drafting ──→ awaiting_approval ──→ running ──→ verifying ──→ completed
                    │                   ↑           │
                    │                   └── repairing ┘
                    ├──→ cancelled       （验证不过，最多 2 轮）
                    └──→ failed / interrupted
```

`interrupted` 只出现在进程重启后：没人会继续推进那些运行，启动时统一标掉，由人决定重跑。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/work/orchestrator` | `{ enabled }`，前端据此决定是否显示开关 |
| GET | `/api/work/runs?limit=20` | 最近的运行（含步骤与黑板） |
| POST | `/api/work/runs` | `{ goal, projectId?, chatId?, templateId? }` → 起一次运行 |
| GET | `/api/work/runs/:id` | 单次运行 |
| POST | `/api/work/runs/:id/approve` | `{ decision: 'approve' \| 'reject' }` |
| POST | `/api/work/runs/:id/cancel` | 取消（已经派出去的工单不回收） |

目标长度 1–300 字；`projectId` 给了就在该项目的目录里干活，每个执行器各有一条子对话。

`templateId` 可选：给了就按这套模板拆（`code-change` / `data-analysis` / `research` / `ops`），不再按
关键词猜；给了不存在的模板直接 400，不会悄悄退回自动识别。运行记录里 `templateChoice` 记下这次是手选
还是自动识别。

## 能力路由

每个执行器声明 `reads / writes / commands / browser / github / summarize / parallelSafe / weight`，
模板步骤用 `need` 声明要求，`pickExecutor` 先按 `need` 过滤，再按偏好序与权重挑一个。挑不到就退回
`model`（内置 Agent）；连它都不可用时该步骤失败并如实记录，不会假装成功。

## 黑板

运行期间的关键决策（模板判定、分配理由、验证结论）写进 `run.board`（上限 200 条），前端只显示最近
3 条。成功结束时 `run.digest` 是这次运行的总结；项目记忆仍由 `project-memory` 在执行完成后写入，
两者不重复。

派发每一步时，会把黑板里最近的「上一步做完了什么」和「验证发现了什么」拼在**提示词末尾**发给执行器，
后面几步因此知道前面做过什么，不会把同一件事再做一遍。拼接只带这两类，模板判定之类决策对执行没帮助。
摘要放在末尾是为了工单标题仍取这一步的任务本身——标题走 `command({ title })`，不从整段提示词里截。

## 返工

验证不过就插一条「修掉问题」步骤重跑验证，最多 2 轮。如果返工后验证结论和上一轮**一字不差**，说明
这条路走不通，直接停下并记「返工后结果没有变化」，不做重复的失败。

## 打开与关闭

- 默认开启。
- `DATAAGENT_ORCHESTRATOR=legacy` → 关闭（`POST /api/work/runs` 返回 503，前端隐藏「深度编排」开关）。
- 前端开关状态存在 `localStorage['dataagent.orchestrate.v1']`，按人而不是按对话。