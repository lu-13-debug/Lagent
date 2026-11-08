# 模型用量与费用中心 v1 验证记录

## 实现

- 新增server/model-usage.js/test：规范化逐调用用量、上海自然日范围、按模型/协议/阶段/日期/任务汇总；忽略未知任务，旧单模型仅无账本时回退，旧阶段任务单独计数。
- stage-agent.js/test、multi-workflow.js/test：每次供应商响应独立追加model-call；包括评审员、裁判、报告修订和复核；写入失败不影响分析，取消不删除已发生调用。
- app.js/test、cloud-app.test.js、task-monitor.js：范围白名单、账号隔离、modelUsage能力标记。
- src/model-usage.ts/test/css、ModelUsagePanel.tsx、Pages.tsx、types.ts、api.ts：用量页签、范围、统计与表格、任务名映射、参考单价及费用估算、本机账号/服务分区保存、旧服务隐藏页签。
- App.tsx：传入任务映射，报告列表只保留页头新建主入口；WorkflowSettings.tsx：无候选时禁用评审并说明，启用路径不生成空模型ID。
- 新增e2e/model-usage.spec.ts、usage-small-fixes.spec.ts；未修改保护文件，无新增依赖。

## 口径与限制

账本只追加，不从artifacts.calls、修订历史或panelTokens推断。成功响应无usage记录missingUsage；网络/HTTP失败无回调，无法推断调用数量，因此不伪造条目，已在协作信箱及界面说明。评审员完成/失败数量来自已加载任务，明确不按当前范围筛选，也不参与计费。

Token汇总为已返回字段之和；额外inputMissing/outputMissing记录部分缺失，避免total-only响应被当零输入收费。缺单价、缺用量或部分输入/输出缺失均不估算；多协议逐行调用estimateModelCost后相加（含现有Anthropic缓存输入口径）。不自动查询价格，不换算币种，估算不代表账单。

## 验证

- TDD：汇总纯函数、onCall/账本接入、小修和最近任务排序均观察RED后修复；最终定向50/50通过，本地接口与云端隔离2/2通过。
- 初轮相关浏览器11/11通过：用量中心2、小修2、评审4、目录/模型选择器/吸顶各1。
- 截图保存artifacts/model-usage-light.png、model-usage-dark.png、model-usage-390.png。窄屏截图增加等待侧栏收起，避免捕获响应式切换动画中间帧。
- 完整测试与最终构建/浏览器结果在完成后追加。

本轮不提交、不打包、不部署，保留工作区原有未提交修改。

## 最终结果
定向测试最终50/50（含最新调用排序、多协议费用算术），本地/云端接口2/2。完整npm test首轮3项旧能力精确断言未同步modelUsage，已更新cloud-app.test.js及task-control.test.js期望；重跑548/548通过，无ECONNRESET。最终npm run build（含tsc）通过，仅Vite既有chunk体积提示。
相关浏览器11/11；最后补范围请求断言、bootstrap桩、旧服务能力字段缺失、截图等待后，用量与小修4/4再次通过。截图已更新。未调用真实付费模型。
