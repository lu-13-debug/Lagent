# 洞察多模型评审团实施计划

用户已授权按协作信箱17:38及17:42规格实施，使用subagent-driven-development和TDD。不提交、打包或部署，保留全部既有修改。

1. 配置与快照：后端workflow-config/model-hub、测试；只允许insights 1–3不同profile评审，冻结参数，凭据版本与owner校验，旧快照保持原路径。
2. 评审执行：新增insight-panel纯函数与allSettled编排测试；multi-workflow只在insights启用，独立report副本、无工具、不校验评审claims，裁判原合同校验；合法证据过滤、共识/分歧、降级、脱敏与tokens；Abort/scope/审批/指纹行为不变。
3. 前端：workflow-types镜像验证、WorkflowSettings可选评审区；types、workflow-artifacts、ReportQuality简明展示。无panel不展示。route桩E2E验证保存并回读。
4. 根代理复核接口、取消/范围语义、证据边界与失败降级；运行定向测试、tsc/build、评审E2E及目录/模型选择器/吸顶回归，必要时完整测试。独立审查后回信箱最多5行报告数量与限制。

禁止修改App、图表、目录导航及模型选择器文件；若快照/取消语义冲突，先通知协作信箱。
