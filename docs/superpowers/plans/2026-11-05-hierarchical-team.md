# 有界分层团队模式实施计划

用户已批准：主Agent协调，子Agent可继续拆分，默认3层、3并发、12子任务，模型/Skill/effort独立，跨层共享调用/Token/时间与取消，旧单层模式保留。

技术：现有Node/React/TypeScript，无新增依赖。所有工作保留未提交，不提交/打包/部署。

- [ ] server/team-runtime.js/test：纯预算/任务树与调度，先RED，检查深度/数量/并发、预算预留、取消、失败回收和父子ID。
- [ ] server/workflow-config.js/model-hub.js及测试：新增默认关闭team配置，固定角色模板/Skill/effort及授权工具，快照不可变，账号和凭据实时复核。
- [ ] stage-agent.js/multi-workflow.js及测试：团队delegate、父节点逐层验收、共享调用预留、等待子节点时释放执行槽以免树形死锁；工具仅受控授权并隔离数据产物，最终经过原证据/claims/Critic。
- [ ] workflow-types/WorkflowSettings/types/执行详情：团队开关、角色、预算和任务树、状态/摘要/费用，不展示私有思维链。
- [ ] 定向、tsc、外验脚本及e2e，旧单层调用不变；回信箱报告真实结果和限制。

执行顺序先控制器，再快照与运行时，再UI，不先开放任意递归或任意工具。当前只开始基础模块，尚无团队功能上线。
