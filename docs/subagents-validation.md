# 子智能体 v1 验收记录

状态：已实现主体，尚未完整验收。

文件：server/subagents.js/test、workflow-config.js、model-hub.js、agent-tools.js、stage-agent.js/test、multi-workflow.js；src/workflow-types.ts、WorkflowSettings.tsx、types.ts、ReportQuality.tsx。保留原未提交改动，无依赖新增，不提交/打包/部署。

默认关闭，仅insights/report最多3个子智能体；配置校验ID/名称/职责/profile/effort/预算，拒绝递归配置。冻结凭据与settings，subagentContext复用owner/凭据版本/接口/能力校验。

主Agent使用delegate operations；参数预校验，每阶段最多3条请求，计入原工具/轮次预算；使用原同轮allSettled机制保持观察顺序。子智能体readOnly执行器拒绝所有工具，包括numeric-transform和delegate；report/previous隔离副本，结果白名单投影只保留summary/findings/recommendations，非法引用丢弃。结果仅作为主Agent工具观察，原最终证据/claims校验保持。

子调用onCall账本kind=subagent；子异常返回通用失败原因，Abort冒泡；主产物delegations记录摘要/状态/token，报告仅显示计数和Token。未修改review/insight-panel。WorkflowSettings新增折叠配置和添加/删除；服务端是最终配置校验源。

先红后绿：首批配置/输出纯函数缺实现RED→GREEN；delegate运行时与递归拒绝新增现有行为回归通过。tsc --noEmit通过。当前定向日志artifacts/subagents-targeted.txt；全量/build/e2e由Claude外跑。

待完成专项回归：快照凭据改版、并行顺序、单/全失败、未知ID/3次预算、Abort、kind=subagent账本无重复的完整集成；前端校验预算镜像、保存回读与e2e。失败调用已写账本但delegation失败token暂记0，账本仍为费用事实源；委派数组按完成顺序保存，模型观察按请求顺序。不得以本记录声明完整交付。

## 最后一批专项回归（2026-11-05）
用户提供此前主体外验：定向74/74、全量615/615、含tsc构建通过，日志artifacts/claude-subagents-{full,build}.txt；结果早于本轮补测与账本修正，不声称本轮全量已通过。

本轮新增：两个delegate用同步门验证真正并行、主Agent观察按请求顺序；unknown ID失败；第四条委派触发tool_budget；单子调用失败降级后主阶段完成；子调用触发取消后insights不落产物；readOnly递归拒绝沿用专项；完整workflow账本断言kind=subagent、唯一ID、与成功调用数量一致。网络失败provider没有返回usage通知，因此不伪造该条账本/Token。凭据改版测试通过真实ModelHub配置与冻结快照再修改凭据，断言subagentContext拒绝旧版本。

发现并修复实际缺陷：modelCallEntry kind白名单此前缺subagent，专项集成先RED（0 !== 1）后最小添加subagent；不改变汇总计数、价格或reviewer统计，子调用仅追加一次。补充改动server/model-usage.js已回信箱声明。

本轮实测：node --test --test-isolation=none server/stage-agent.test.js server/multi-workflow.test.js server/subagents.test.js server/model-usage.test.js，71/71通过；日志artifacts/subagents-final-targeted.txt。凭据专项因沙箱回环EACCES无法验收，日志artifacts/subagents-credential-test.txt，需Claude外跑，未声称通过。

e2e/subagents.spec.ts已新增三例：配置添加/名称职责编辑/PUT保存及刷新回读、报告摘要计数、不配置不渲染；尚未运行，需Claude外验。按要求未重跑全量/build/e2e。

以上补齐此前列出的专项测试代码；前端配置预算镜像与失败delegation token记0等既有实现限制仍保留，不将网络受限测试当通过。未改insight-panel、未新增依赖、未调用真实付费模型，不提交/打包/部署。

## 最终外验关闭（2026-11-05）
已读取并核对Claude沙箱外日志：artifacts/claude-subagents-final-full.txt全量npm test 618/618通过；artifacts/claude-subagents-final-build.txt的npm run build（含tsc）成功，仅保留Vite chunk体积提示。
用户确认e2e/subagents 3/3通过，浏览器结果按外验反馈记录。子智能体v1本轮任务关闭；本条替代此前待外验、凭据专项受限及e2e未运行的验收状态说明，已记录的实现限制仍保留。
保留全部未提交改动，不提交、打包或部署。
