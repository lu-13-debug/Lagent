# MODEX启发的工作流优化实施计划

> For agentic workers: 使用 subagent-driven-development 分工；用户已批准设计并要求实施，连续完成，不重复确认。

**Goal:** 让现有阶段消费结构化合同/证据，并支持按需检查、定向修订、派生数据和有效产物复用。
**Architecture:** 增加纯函数合同与生命周期模块，现有节点ID和模型配置保持兼容；旧Skill输出标记legacy，新版Skill按运行时合同验证。主代理负责跨模块/API/UI接入与验证。
**Tech Stack:** Node/SQLite/React/现有受控Python工具。

## 共享接口

```js
// server/stage-contracts.js，合同代理负责
buildAnalysisContract(task,dataset,report) // {version:1,...}
buildStageDeliverable(stageId,result,{task,dataset,report,contract,previous})
validateStageDeliverable(stageId,deliverable) // throws，返回校验后的产物
buildEvidence(report,context) // 结构化facts，兼容id/text
buildContextProjection(report) // 聚合数据及显式coverage
// server/artifact-lifecycle.js，生命周期代理负责
artifactFingerprint({stageId,dataset,contract,stage,upstream,toolVersion})
canReuseArtifact(artifact,fingerprint)
deriveDataset(dataset,operations) // {dataset,receipt}，只允许trim_strings/normalize_newlines
restoreReusableArtifacts(source,candidate,dataset) // 返回candidate；按依赖/hash重用
```

## 任务1：阶段合同、证据与Skill（独立）
- Files: server/stage-contracts.js/.test.js、server/workflow-config.js/.test.js。
- [ ] 先写错误单位/期间/分母引用、缺字段、阶段产物不同结构、截断披露测试，运行node --test看RED。
- [ ] 实现AnalysisContract、分阶段deliverable、运行时校验、结构化证据及上下文coverage。
- [ ] 升级内置Skill版本2，含职责/输入/步骤/工具/输出/成败标准/正反例/领域约束。私人版本保持冻结兼容。
- [ ] 定向回归通过，向runtime代理明确字段形状。

## 任务2：生命周期与派生数据（独立）
- Files: server/artifact-lifecycle.js/.test.js。
- [ ] 先测试变数据/Skill/范围/参数/工具/上游均失效，未知状态不复用，原数据不变。
- [ ] 实现稳定hash、阶段依赖、非破坏标准化派生版本与处理回执。
- [ ] 恢复只复用完成且合同已校验且指纹匹配的前缀或依赖完整产物；旧无指纹不复用AI调用。
- [ ] 定向通过，提供API给runtime及root接入。

## 任务3：执行器与按需检查/修订（独立）
- Files: server/stage-agent.js/.test.js、server/multi-workflow.js/.test.js、可新增server/analysis-checks.js/.test.js。
- [ ] 先写实际下游读取计划/证据、上下文覆盖、比较不适用、核验两轮修订和不重跑无关模型测试。
- [ ] 使用任务1/2接口，持久化deliverable、fingerprint、validation；明确legacy状态。
- [ ] 按数据条件做比较/异常/敏感性检查与图表规则核验，不增加默认付费节点；不把观察性比较写成因果。
- [ ] preprocess应用受支持标准化产生派生dataset；后续计算使用新版本、原数据仍保留。
- [ ] verify可定位report产物进行最多2轮修订，保存每轮结果/用量，超限明确失败；不能变口径或借修订执行破坏操作。
- [ ] 保留协作确认、skip排除、取消、PDF与额度行为，定向通过。

## 任务4：集成与验收（root）
- Files: server/app.js、src/types.ts、src/components/RunPanel.tsx、README及验证记录。
- [ ] retry/resume接入restoreReusableArtifacts，保留来源及账本幂等；启动新快照必须验证匹配。
- [ ] 页面可读展示结构化产物、覆盖与修订记录，不直接向用户暴露内部schema。
- [ ] 运行定向mock集成、完整串行测试、build、必要浏览器回归。先完成冻结再全量，不并发重资源任务。
- [ ] 记录实际通过/失败和限制，不以旧结果替代。保留既有未提交工作，不提交/推送/部署参考项目。
