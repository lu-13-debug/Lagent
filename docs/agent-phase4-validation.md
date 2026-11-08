# Phase 4 Memory 验收记录

本轮仅Memory；保留已有未提交改动，不提交/打包/部署，无新增依赖，不实现Critic，不从模型输出自动写入。

文件：server/memory.js/test、server/memory-api.js、server/app.js/test、server/cloud-app.test.js、server/task-control.test.js、server/task-monitor.js、server/retrieval.js/test、server/multi-workflow.js；src/memory.ts/test.mjs、src/components/MemoryPanel.tsx、src/memory.css、src/types.ts、src/App.tsx、src/components/Sidebar.tsx；e2e/memory.spec.ts及本记录。独立memory-api模块为路由拆分，接口仍注册在app中。

实体：用户显式创建/编辑，默认candidate、180天TTL；同owner/scope/type/key更新版本，最多500条；枚举、长度、日期、置信度和引用校验；DELETE禁用，PATCH恢复。拒绝已识别原始标识、密钥、提示词及records/sections正文形态。自由文本敏感识别为规则匹配，并非能识别一切秘密或报告正文。版本号保留，尚无独立历史版本存储。

隔离：API由账号工作区挂载，owner使用服务端options.userId或local；读取不接受查询参数覆盖owner，跨owner编辑拒绝。检索owner来自冻结plan阶段ownerId，无快照owner的本地任务回退local。仅confirmed/enabled/未过期/同owner进入语料；每阶段最多3条preference优先保留，其余按词法。记忆仅检索参考，不添加facts/evidenceRefs；偏好不改变合同、工具与计费。

UI：capabilities.memory缺失隐藏侧栏与命令入口；可筛选scope/type、添加、编辑、禁用、删除/恢复，显示状态、来源、更新时间。当前表单保存即明确确认记忆；scope/type用于新建时取当前筛选值。删除为软禁用，卡片保留以恢复。没有单独过期记忆恢复UI，API支持includeExpired与编辑expiresAt。

先红后绿：实体最初缺实现2项RED，实施后GREEN。后续新增边界与集成回归均为现有行为验证；审查修正GET查询owner覆盖风险，仅允许scope/type/status参数。补齐cloud-app与task-control本地/云端三处memory:true capability期望。

本轮实测：node --test --test-isolation=none server/memory.test.js server/retrieval.test.js src/memory.test.mjs，9/9通过；日志artifacts/agent-phase4-targeted.txt。上轮tsc --noEmit通过。本轮API定向两项因沙箱回环connect EACCES失败，未声称API通过，日志artifacts/agent-phase4-api.txt。

待Claude沙箱外复跑：Memory API本地CRUD/非法输入、云端匿名401与A/B隔离；全量npm test、构建、e2e/memory.spec.ts。e2e提供添加→编辑→禁用→恢复→删除与旧能力隐藏用例，390明暗截图目标artifacts/memory-390-{light,dark}.png，尚未实际生成，不将其当实测。用户提供的此前595项592通过为补期望前基线，不作为本次全绿结果。

Phase5建议：Critic应复用确定性合同/证据检查，明确修订调用预算与审批停点；本轮不实施。

## 2026-11-05 外验关闭
Claude沙箱外全量npm test 600/600、npm run build（含tsc）通过，已核对artifacts/claude-phase4-final-full.txt与artifacts/claude-phase4-final-build.txt。e2e/memory 3/3通过由用户提供。Phase4关闭；此前待复跑说明以本条结果为准，已有功能限制仍保留。
