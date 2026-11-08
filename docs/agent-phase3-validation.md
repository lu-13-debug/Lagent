# Phase 3 RAG 验收记录

状态：已完成本轮检索及集成测试补齐（2026-11-05）。

文件：server/retrieval.js、server/retrieval.test.js、server/stage-agent.js/test、server/multi-workflow.js/test及本记录。仅词法检索，无新增依赖，不做Memory/Critic/向量库。

语料仅从当前store读取；显式currentTaskId排除当前任务，严格筛选同domain且completed历史任务，按更新时间排序。指标来自领域目录，字段仅写已有白名单的名称与类型；不读取报告章节或原始值。历史文本仅作为不可信参考，未加入facts/evidenceRefs，不能作为当前数据证据。注意自由文本摘要可能包含用户自行输入的敏感内容，本轮未实现通用自由文本秘密识别。

检索使用NFKC、英文词和中文二元词，词频/逆文档频率评分，计划metricIds命中权威资料保留；按ID稳定排序去重，最多8条/4000 Unicode字符。阶段缓存复用；artifact.retrieval只有ids/count/omitted，omitted表示语料总量减返回量（含无关条目），trace.retrievalHits记录返回数。无命中明确说明。阶段条目stageIds非空时过滤；当前目录生成项stageIds为空，按查询与计划关联选择。

先红后绿：最初2项缺实现测试失败后通过；本轮补充现有行为回归，无新增生产修改。覆盖当前任务/跨domain/失败任务排除、字段白名单、历史日期排序、正文排除、metric权威保留、预算、无命中、分词、去重、注入文本不执行及消息兼容；真实工作流集成验证历史摘要输入、计划指标、审计字段与字符预算。

本轮实测：node --test --test-isolation=none server/retrieval.test.js server/stage-agent.test.js server/multi-workflow.test.js，51/51通过。日志artifacts/agent-phase3-targeted.txt。

外部验收：用户转述Claude在沙箱外npm test 589/589、npm run build（含tsc）通过，发生于本轮新增4项回归之前；本轮未重跑全量或构建，不将该结果表述为新增测试后的全量实测。此前本沙箱全量/构建遭spawn EPERM的记录保留。

限制：当前以字符预算近似控制上下文，不提供供应商精确token计数；语料和缓存按一次工作流执行构建，审批恢复会重新构建；无历史时仍可返回相关权威口径，只有完全无命中时documents为空。未新增前端与浏览器测试。Phase4建议：若实现Memory，先明确账号隔离、用户同意、删除与版本失效，避免把历史结论当当前证据。本轮未实施。

保留原未提交改动，不提交、打包或部署；不调用真实付费模型。
