# MODex优点落地实施计划

> For agentic workers: 使用 subagent-driven-development 独立任务分工，用户已要求按研究结论修改；不重复设计确认。

**Goal:** 统一指标口径、确认绑定产物版本、来源登记与独立质量回执，保留既有工作流。
**Architecture:** 指标目录由计算代码提供真实期间/分母；确认使用服务端内容指纹；来源与审查回执绑定数据和报告版本。旧任务兼容读取，新多阶段任务执行强校验。
**Tech Stack:** Node crypto/SQLite、React TypeScript、既有确定性分析内核。

## 1. 指标目录与来源（独立任务）
Files: server/metric-catalog.js/.test.js、server/provenance.js/.test.js、server/analytics.js、server/domain-analytics.js。
- [x] RED测试指标分母、末日/支付期间、缺表不冒确认、未知领域不套游戏口径。
- [x] 实现共用目录与真实计算期/分母元信息；已有数值与单位保持不变。
- [x] buildProvenance(dataset) 返回hash、源文件/表/行数/映射和演示标记，只公开元数据不公开原始ID。
- [x] 定向指标/领域/来源测试通过。

## 2. 版本确认（独立任务）
Files: server/approval-snapshot.js/.test.js、server/workflow.js、src/api.ts、src/components/RunPanel.tsx、src/use-task-actions.ts（必要时）。
- [x] RED测试旧hash、scope/背景/产物变化返回409且不运行下一步；相同确认重试幂等。
- [x] publicTask公开awaiting_approval时approvalSnapshot；approve(task,message,stepId,snapshot)对新版workflow强校验，旧路径保留stepId兼容。
- [x] 浏览器提交当前快照，409明确刷新而非自动重跑；root负责app.js转发参数。

## 3. 质量与数字变换回执（独立任务）
Files: server/quality-receipts.js/.test.js、server/numeric-transforms.js/.test.js、server/stage-contracts.js/.test.js。
- [x] RED测试pass/issue/unreviewed/disabled、内容hash和规则版本失效、空视觉响应不通过。
- [x] 质量决定有理由/规则版本/源定位，保留原状态不静默删行；人工确认只能影响允许的待复核项。
- [x] 单位换算、舍入、百分点差使用命名确定性变换，记录输入/参数/输出；严格claims可消费这些证据，不用放松校验换取可读性。
- [x] 提供buildQualityReceipts(task,report)供root接入；视觉没有调用时必须unreviewed或明确disabled。

## 4. 集成与验收（root）
- [x] app.js转发approvalSnapshot，报告PDF缓存绑定报告内容hash，来源和质量回执进入任务/报告。
- [x] API公开指标目录、质量回执，页面显示来源/演示/审查未完成状态。
- [x] 运行独立定向、API/旧客户端兼容、串行全量、build及浏览器。
- [x] 文档明确通过与未实现边界，不运行MODex、不付费模型、不覆盖现有工作、不自动部署/打包。

验证与未完成的扩展边界见docs/modex-quality-validation.md；人工决策仅基础模块，不宣称已有通用交互界面。
