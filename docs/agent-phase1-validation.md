# Agent Phase 1：ReAct 与 Tool Calling 加固

范围仅Phase1，不引入Planner/RAG/Memory/Critic，不改前端或目标/模型/计费接口，不提交、打包、部署；保留既有工作区修改。

实施分工：agent-tools注册表复用analysis-tools唯一校验与投影字段；stage-agent显式循环、预算、并行/串行、去重、安全Observation和trace；multi-workflow集成取消、结果产物与用量回归。

兼容性决策已回信箱：numeric-transform原本独立于skill.allowedTools的受限命名数值修订特例保持，以免改变claims/评审副本隔离；其他工具严格阶段白名单。旧测试mock中的describe.column不是合法生产schema，改为columns而不放宽校验。循环参数只放stage内部agentLoop可选结构，不新增API。

验收清单：
- [x] 注册表/共享校验/错误分类/安全投影定向测试。
- [x] 循环默认4轮/12次工具、硬6轮/18次工具、超时硬上限；无私有思维链。
- [x] 可修复Observation、不可修复立即失败、Abort向上传播。
- [x] 只读并行按请求排序；clean/numeric串行；重复调用去重。
- [x] 结果行/字节上限、truncated/totalRows/scope与隐私字段过滤。
- [x] trace仅轮数、动作状态、耗时、字节、用量和停止原因。
- [x] 普通/评审/verify修订及只追加用量账本集成回归。
- [x] 全量npm test、tsc与build；模拟模型，无真实付费调用。

最终结果见下方。

## 最终验收（2026-11-04）
文件：新增agent-tools.js/test；修改analysis-tools.js、stage-agent.js/test、multi-workflow.js/test。未修改前端、用量中心文件、目标/模型/计费接口或保护文件，无新增依赖。
先红后绿：注册表缺实现、trace缺失、逐工具超时导致阶段失败、预算失败未存轨迹、numeric-transform缺参数/额外参数未分类均实测RED后修复。默认4轮/12次工具，maxRounds硬6、maxToolCalls硬18；stage.agentLoop内部可覆盖（无效值回默认，超限截到硬上限），timeoutMs硬600000、toolTimeoutMs硬60000。每轮最多3操作，末轮仍有工具请求即停止，保留原默认轮次语义。
只读分批allSettled并行且Observation按请求顺序；clean/numeric为串行屏障。canonical参数成功调用缓存去重，recoverable错误不缓存以允许重试；不生成规划/检索/长期记忆。工具结果保持原产物，模型安全投影100行/原1MB硬限/投影及每轮观察80KB，附truncated/totalRows/scope，剥二进制与非登记字段。
trace只保存round/actions(tool,status,durationMs,resultBytes)/usage/stopReason；无prompt、原始数据、输入参数或思维链。失败error.trace仅在仍running且未关闭/取消/变范围时最小附到artifact；诊断保存失败不覆盖原错误。工具超时signal传到底层并在返回后再核对，防迟到图表写回；真正任务Abort原样抛。
独立审查发现numeric缺参数分类遗漏，新增RED并修复顶层schema；数值变换原规则仍由applyNumericTransform处理。最终定向66/66、完整npm test564/564、npm run build(含tsc)通过；Vite既有chunk体积提示保留。日志artifacts/agent-phase1-targeted-tests.txt与agent-phase1-full-tests.txt。模型全部模拟，真实Python工具回归通过，未调用付费模型。本轮无前端展示，未新增浏览器测试。
未提交、打包、部署；只完成Phase1。
