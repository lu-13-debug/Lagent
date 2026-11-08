# Phase5 确定性Critic

已修复legacy finding兼容：unverified=true或显式空/无效evidenceRefs阻断；缺字段按旧报告处理，不阻断。扫描report.metrics与findings/sections，period递归按键排序归一。

新增critic.js/test；修改multi-workflow.js/test、types.ts、ReportQuality.tsx；新增e2e/critic.spec.ts。Critic无模型调用，不修改insight-panel。report/insights/verify存critic，verify检查注入checks，blocking复用原最多两轮报告修订，revision携带code/message/fix。plan附critic并在审批提示必要确认。

先红后绿：legacy兼容新增断言先失败后通过；metrics矛盾/period键序、图表引用、覆盖披露、空建议、计划blocked/skip均通过。定向node --test --test-isolation=none server/critic.test.js server/multi-workflow.test.js，35/35通过，日志artifacts/agent-phase5-targeted.txt。原两轮修订、失败不结算与正常不增调用回归通过。

待外验：全量/build/e2e由Claude运行；e2e包含四种状态及缺失隐藏、390截图目标，尚未实跑。尚缺专门由critic blocking触发并修复成功的集成用例；相反方向结论尚无可靠确定性识别，未把词语猜测当事实；无法评审仅缺报告返回unreviewed，异常路径未统一降级。上述为未完成项，不声称完整验收。

未新增依赖，未调用付费模型，保留未提交改动，不提交/打包/部署。

## 2026-11-05 最后三项补齐
此前外验：用户提供npm test 605/605、build含tsc通过、e2e/critic 5/5通过，日志artifacts/claude-phase5-{full,build}.txt；此结果早于本次补充，不表述为本次改动后的外验。

本次定向：node --test --test-isolation=none server/critic.test.js server/multi-workflow.test.js，39/39通过；日志artifacts/agent-phase5-final-targeted.txt。不重跑全量/build/e2e。

补齐1：专项集成通过workflow.critiqueResult确定性测试接缝模拟连续blocking，真实运行verify与报告修订，确认恰好两轮修订后成功、指令含code/message/fix、activity不重跑。异常测试同样运行完整工作流，确认两轮上限后失败、不泄漏原始异常。测试接缝仅函数依赖替换，不新增模型调用或UI配置。

补齐2：方向规则要求claims显式metricId、period、comparisonPeriod、有限非零change；按指标、当前/比较期间、unit、denominator归一分组，change符号相反即CRITIC_DIRECTION_CONFLICT。仅关键词或不同比较期间不判冲突；没有结构化变化数据时不推测方向。period稳定键序保持。

补齐3：critiquePlan/critiqueResult对异常返回脱敏unreviewed；缺报告亦unreviewed。集成边界再次捕获替换评审器异常；新版verify将reject和unreviewed均纳入原有有界修订门禁，不能将模型approved伪装成确定性pass。旧版非strict仍保持原legacy路径，不把其标为确定性pass。

本条取代上文三项未完成说明；本次新增生产逻辑与回归一并实测通过，未声称所有新增回归均经历RED。未改insight-panel，未新增模型请求，未提交/打包/部署。

## 最终外验关闭（2026-11-05）
已核对artifacts/claude-phase5-final-full.txt：609/609通过；artifacts/claude-phase5-final-build.txt：含tsc构建成功。e2e/critic 5/5由用户确认。Phase5关闭，本条替代先前待外验状态。
