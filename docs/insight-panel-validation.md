# 洞察多模型评审验证（2026-11-03）

范围：server/insight-panel.js及测试、workflow-config.js及测试、model-hub.js及测试、multi-workflow.js及测试；src/workflow-types.ts及测试、types.ts、workflow-artifacts.ts及测试、components/WorkflowSettings.tsx、components/ReportQuality.tsx、workflow-settings.css；e2e/workflow-panel.spec.ts。

仅insights可选最多3个独立模型配置，默认关闭，旧快照无reviewers走原路径。冻结评审设置、账号和凭据版本；评审独立报告副本，不可执行数据工具；numeric-transform即便在代理内部运行也只影响副本，相关证据不进入裁判。裁判保持原合同校验，受限摘要经deliverable进入原投影，合法证据过滤、去重并记录共识/分歧。单个失败降级，全失败走原单模型裁判；Abort传播，原scope失效、审批与指纹行为不变。

先红后绿覆盖配置校验、并行执行、恶意结构、不可用评审员、过期摘要。最终定向48/48通过；完整npm test 517/517通过（最终两项前端一致性修复之前），修复后重跑定向、构建及评审浏览器。生产构建通过，含tsc --noEmit；保留Vite大文件提示。

浏览器：workflow-panel 2项 + report-toc/model-picker/sticky-header 3项共5/5通过。评审配置使用route桩保存两位并核对PUT；报告使用bootstrap fixture验证参与/共识/分歧及无原始错误，截图artifacts/workflow-panel-report.png已目检。服务端使用模拟模型集成测试，未调用真实付费模型。

关键集成覆盖：全成功/单失败/全失败，合法引用匹配，评审派生证据不污染主报告，评审期间取消不应用结论、不写insights artifact、不调用裁判。失败调用无可用usage时不臆造Token量，panelTokens只汇总已返回的评审用量；失败原因固定脱敏中文。

未改App、图表、目录或模型选择器保护文件；未提交、打包、部署；保留既有未提交改动。日志：artifacts/insight-panel-targeted-tests.txt、insight-panel-full-tests.txt。

## 18:05复核修正
全评审失败时summarizePanel返回空共识/分歧，报告兼容旧错误分歧元数据仅提示单模型降级；失败人数仅大于零展示。cleanFindings丢弃空白/非字符串标题，matches仅非空归一标题可按标题匹配，证据交集独立有效。panelPrevious明确PanelReview/lens且findings/recommendations位于deliverable，无需修改stage-agent投影。
先红后绿：纯函数2项失败及全失败报告断言失败后修复；最终定向50/50，浏览器4/4，构建(含tsc)通过；未重跑全量；可选无候选禁用开关未实施。未提交/打包/部署。
