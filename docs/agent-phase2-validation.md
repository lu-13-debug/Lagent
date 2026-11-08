# Agent Phase 2：Planner

仅实施Planner，不提前实现RAG/Memory/Critic；保留未提交改动，不提交/打包/部署。

文件范围：新增server/plan.js、server/plan.test.js、server/stage-definitions.js；修改server/stage-contracts.js/test、server/stage-agent.js/test、server/multi-workflow.js/test、server/workflow-config.js、server/stage-reply-fixture.js；本验收文档与协作信箱。

- [x] 纯函数验证四字段、合法阶段/指标/表、DAG依赖、稳定错误码和旧空计划兼容。
- [x] 可选planVersion/successCriteria/outOfScope/estimatedCalls与阻塞审计。
- [x] 无效计划只修复一次，仍无效失败且不写产物。
- [x] 按阶段投影，包括previous中的计划，其他合同与证据路径不变。
- [x] 协同审批复用，无额外调用，不自动改用户skippedSteps。
- [x] 有界重规划及范围失效，符合模式/报告阶段/用户范围限制。
- [x] stage-agent仅传入plan时加入消息；Planner系统消息补齐条目结构、枚举、上限与当前领域指标。
- [x] 定向/全量测试与生产构建，独立审查，回信箱。

兼容决策已说明：旧非strict Skill且四字段完全缺失时补空数组并标legacy；strict/部分缺失不放宽。可选字段旧计划不要求提供。

## 实现与边界

- STAGE_DEFINITIONS原样抽到无依赖的stage-definitions.js，workflow-config原名再导出，解决plan与合同初始化环；阶段、Skill、配置值不变。计划按真实阶段注册表校验，包含pdf。
- validatePlan不修改输入，错误包含稳定PLAN_*代码与结构化path/message，不回显非法值。合法新版本状态为verified，兼容现有canReuseArtifact门禁；未提供planVersion的独立旧计划为legacy。
- planForStage过滤questions/steps/evidenceRequirements并深拷贝。confirmations的规定结构不含阶段字段，因此作为全局待确认项保留；successCriteria/outOfScope也是全局字段。previous.plan摘要改为固定“本阶段相关计划”，防止全量摘要旁路；裁判、评审员、报告定向修订均沿用投影。产物指纹仍使用原始上游。
- 多领域校验使用task.domain指标目录。独立调用validateStageDeliverable校验非game计划时，需传第三参数{task:{domain}}；默认game。合同本身未新增domain，不改变原指纹字段。
- 结构修复最多一次，通过revision.planValidationErrors反馈；有效计划才写入deliverable。修复后的两次调用均保留calls与账本。重规划与结构修复各有一次预算，组合不重置。
- 重规划v1仅在初始有效计划存在must阻塞、automatic模式、尚无report/verify产物且未进入这些步骤、用户范围未变时触发一次。新planVersion递增，以scopeInvalidated标记已有下游；不自动改skippedSteps。冻结数据v1未实现动态数据变化驱动的重规划。
- collaborative只停在原计划approval，文案带阻塞原因；批准复用原产物，不再次调用。每次额外调用前检查Abort、最新状态、关闭与范围；用户改范围后重新执行当前阶段，不用旧范围做修复。

## 先红后绿记录

纯函数缺实现、合同元数据丢失、stage-agent缺plan消息、Planner缺条目提示、未知工具名均实测失败后通过。集成测试先编写，首轮遇初始化环（不将此声称为功能断言失败）；后续独立复核新增“停止后额外修复”“报告已存在仍重规划”“复用门禁不兼容”“投影改变上游指纹”均实测RED后修正GREEN。合法pdf回归首次即通过，没有伪称RED。

## 最终验收

定向命令：`node --test server/plan.test.js server/stage-contracts.test.js server/stage-agent.test.js server/multi-workflow.test.js server/model-hub.test.js server/workflow-config.test.js server/approval-snapshot.test.js server/artifact-lifecycle.test.js`，96/96通过。日志：artifacts/agent-phase2-targeted-tests.txt。

最终`npm test` 587/587通过（2026-11-05），日志artifacts/agent-phase2-full-tests.txt；`npm run build`成功（含tsc --noEmit），日志artifacts/agent-phase2-build.txt。Vite仅保留已有大于500kB的chunk提示。模型调用全部使用模拟provider/fixture，不调用真实付费模型；本轮无前端变更，不新增浏览器验收。未新增依赖，未提交、打包、部署，原工作区改动保留。

首轮全量586/587；唯一失败multi-api的共享模拟夹具仍返回字符串计划条目，已改为合法结构，原API断言未修改。修正后独立`node --test server/multi-api.test.js` 1/1通过，日志artifacts/agent-phase2-api-tests.txt。

Phase 3建议（仅建议，未实施）：优先按合同/领域/证据ID做受控检索，明确来源、版本、范围与截断，沿用当前聚合数据边界、取消及调用预算，不检索原始身份列。
