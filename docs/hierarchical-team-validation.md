# 分层团队当前实施记录

已接实际链路：仅新增team.enabled开关，默认关闭，原单层仍readOnly；开启后insights/report的主Agent和子角色共享team-runtime，子角色可再delegate，最多3层（含根）、12总节点（含根）、3并发模型请求、48次调用、65536 Token及10分钟。父节点等待委派时不占模型执行槽，避免树形死锁。API快照原样冻结team配置。

角色目前沿用现有子智能体的模型/职责，根沿用阶段Skill/effort，尚不支持每个角色单独选择Skill/effort。本记录不宣称已完成用户全部要求。

执行节点开放profile/describe/group/statistics受控分析；clean/chart拒绝，尚未完成带审批的数据处理与图表产物隔离提交，因此不是完整工具执行团队。numeric-transform仍走原局部报告副本，新增引用无法进入主证据集合；后续应收紧团队节点工具策略统一来源。

调用前共享Token预留，返回后实际结算；usage缺失按预留计，不声称供应商精确费用上限。根和子模型调用写现有账本，不重复添加费用。所有后代合并父signal和团队signal。运行中取消不会提交报告；任务树目前随阶段产物完成时保存，尚无实时节点事件流和父验收重试UI。

前端WorkflowSettings子智能体区增加团队开关；执行详情显示任务树与共享用量；类型与完成配置保留team。未扩展后台动态角色创建权限，子节点只能使用冻结角色模板。

测试：执行槽/取消先RED后GREEN；跨层委派专项因执行槽未释放实际失败，修复finally释放后GREEN，真实fixture断言3层3节点、子调用3次、团队总调用5次。定向结果artifacts/team-runtime-targeted.txt；tsc已通过（最近节点状态更新仅服务端）。无真实付费模型调用。

尚待：角色Skill/effort、任务依赖与逐层验收、写工具审批/图表隔离产物、主根不占12子任务配额、实时树、配置边界与多分支取消预算专项、e2e和外验。保留未提交改动，不提交/打包/部署。

## Batch A（2026-11-05）
仅完成A，不实施B/C/D。

配额：createNode仅计数parentId非null节点，默认12子任务，根单独计；snapshot.limits.maxSubtasks=12并保留maxNodes=12兼容别名。根仍为第1层，深度硬上限3。root+12允许、第13失败新增测试先RED后GREEN。

角色：subagents可选skillId/effort；Skill必须存在、enabled且与当前insights/report阶段匹配，角色effort按所选profile能力校验。未提供则继承父阶段。captureWorkflow冻结角色skill全文/version与effort/settings；childStage使用该Skill和effort。前端提供继承/独立Skill与强度选项；旧配置不添加角色字段。配置校验测试先RED后GREEN。

team配置仍仅insights/report且只允许enabled布尔，未知字段拒绝；team=true走团队，false走原单层。新增开关与旧无team回归。

本轮实测定向：node --test --test-isolation=none server/team-runtime.test.js server/subagents.test.js server/workflow-config.test.js server/stage-agent.test.js server/multi-workflow.test.js src/workflow-types.test.mjs，77/77通过；日志artifacts/team-batch-a-targeted.txt。tsc --noEmit通过。

冻结快照专项已写入server/model-hub.test.js，覆盖独立Skill/effort、继承与深冻结，但沙箱connect EACCES阻止HTTP测试，需Claude外跑；日志artifacts/team-batch-a-snapshot.txt。不声称该专项通过，不重跑全量/build/e2e。

文件：team-runtime.js/test、subagents.js/test、workflow-config.js/test、model-hub.js/test、multi-workflow.js、src/workflow-types.ts、WorkflowSettings.tsx及本记录/信箱。B的父验收依赖、C工具提案与D实时树等仍待后续批次，保留此前限制（本条取代根配额及角色字段尚缺说明）。未提交/打包/部署，保留所有原改动。

Batch A外验：用户确认全量node --test --test-concurrency=1 626/626、build含tsc通过、定向77/77，Batch A关闭。


## Batch B（2026-11-05）
节点依赖最多3项，允许同级或直属父子，拒绝循环。未就绪委派记录blocked并返回提示，父节点可在依赖完成后发出新委派。父节点通过delegate的resultId与decision验收，拒绝复用节点重试一次并消耗同一预算。分支Abort与团队停止区分，保留节点快照和已有账本。
定向68/68及tsc通过，另单分支Abort集成1/1通过；日志artifacts/team-batch-b-targeted.txt。全量/build/e2e由Claude外验；C/D仍未开展。

## Batch D（2026-11-05）
Batch C 已完成并保留：团队节点 chart/clean 仅生成隔离提案，clean 不改主数据、chart 不写主报告；角色 allowedTools 与递归 delegate 按冻结快照授权；失败/Abort 不落部分提案。

事件契约：团队运行只发布 `node.created`、`node.updated`、`node.reviewed`、`proposal.recorded`、`proposal.updated`。事件仅保留 `type/nodeId/status/seq/createdAt`，提案事件另保留 `{id,kind,status,summary}`；任意提示词、原始行、模型密钥和未知字段均被过滤。运行中实时事件经观察者异常隔离，单个订阅者失败不影响团队执行；Abort 后不再接受安全事件或提案。

持久化：`task.artifacts.team` 是完成状态的事实源，包含 `summary`、冻结 `team` 快照、最近 100 条脱敏事件、递增 `revision` 和 `updatedAt`。`task.artifacts.<stage>.team` 保留阶段快照兼容字段，但不替代任务级事实源。节点验收与提案决策在事务内重读任务后写回，避免覆盖并发更新。

Work 投影：`GET /api/work/tickets/:id` 增加 `team`；无团队任务返回 `team:null`。有团队时仅暴露 `limits/usage/cancelled/revision/updatedAt/events/nodes`，节点仅暴露 `id/parentId/depth/name/status/dependsOn/retries/proposals`，提案仅暴露 `id/kind/status/summary`。SSE 团队事件为 `{type:'team',ticketId,payload}`，按 ticket 的 `revision + updatedAt` 去重并在状态未变化但团队 revision 前进时发布。

API：`POST /api/work/tickets/:id/team/:nodeId/review` 与 `POST /api/work/tickets/:id/team/:nodeId/proposals/:proposalId`，请求体均为 `{decision:'accept'|'reject'}`，返回 `{team}`。非法 decision 为 400，根节点验收为 403，未知 ticket/node/proposal 为 404，节点未完成、拒绝重试超过一次或重复决策为 409。accept/reject 只更新团队审计状态与事件，不应用 chart/clean 提案，也不修改主数据或主报告。

定向测试覆盖 team-runtime 事件顺序/脱敏/回调隔离/上限/Abort、Work 投影/两条 API/SSE revision/重启恢复/跨 workspace 隔离，以及 multi-workflow 的 `task.artifacts.team` 持久化。未修改 UI，未开展 Batch E；全量测试、build 与 e2e 由 Claude 外跑。所有改动保持未提交，不打包、不部署。