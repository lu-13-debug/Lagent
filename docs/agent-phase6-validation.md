# Phase6 Agent轨迹与预算展示

文件：新增src/agent-trace.ts/test.mjs、src/components/AgentTrace.tsx、e2e/agent-trace.spec.ts；修改RunPanel.tsx、types.ts、server/task-monitor.js及cloud-app/task-control能力期望。仅显示和capability，不改变Agent、模型请求、计费、审批或critic规则。

执行详情activity页增加默认折叠details。按阶段显示轮次、工具动作状态/耗时/结果字节、调用数与Token、检索ID和数量、critic状态与阻断/警告数。旧阶段显示“该阶段未记录”；旧服务agentTrace!==true隐藏。投影仅选定字段，工具名/状态按白名单，未知状态显示未知，检索ID过滤格式，不显示检索正文、提示词或critic错误。

budgetView支持显式limits的用量/上限及超限判断；当前Task产物未提供可靠实际limits，UI上限显示“未记录”，不把默认值伪装实际预算。工具数量为trace.actions记录数（可能含重试/去重动作），不是供应商计费调用数，调用数另列。结果大小为字节原值。

先红后绿：首批2项缺函数RED，实现后GREEN；新增损坏字段、四种critic状态、检索ID安全回归。定向node --test --test-isolation=none src/agent-trace.test.mjs，3/3通过，日志artifacts/agent-phase6-targeted.txt；node node_modules/typescript/bin/tsc --noEmit通过（新增e2e前）。

e2e/agent-trace.spec.ts提供route桩轨迹、展开折叠、停止原因、旧能力隐藏及390明暗截图目标。尚未执行，截图未生成；可能需依据浏览器实际执行详情入口调整展开步骤。全量/build/e2e由Claude外验，本轮未重跑。

保留全部未提交改动，无新增依赖，不提交/打包/部署。Phase5最终609/609、build、e2e5/5已记录关闭。

## 最终外验与关闭（2026-11-05）
已读取并核对Claude沙箱外日志：artifacts/claude-phase6-full.txt全量npm test 612/612通过；artifacts/claude-phase6-build.txt的npm run build（含tsc）成功，仅保留Vite chunk体积提示。
用户确认e2e/agent-trace 2/2通过，critic+memory回归8/8通过；此处浏览器结果依据用户提供的外验反馈记录。
Phase6关闭，六阶段升级计划完成；本条取代上文待外验及e2e尚未执行的状态说明，功能限制仍保留。不再启动新任务，保留全部未提交改动，不提交、打包或部署。
