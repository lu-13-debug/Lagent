# 多模型与 Skill 工作流实施计划

> For agentic workers: 使用 subagent-driven-development 执行独立任务，主代理负责共享文件与集成，逐项进行规格与质量检查。用户已于 2026-11-01 确认设计，连续实施，不重复请求许可。

**Goal:** 在云端账号版实现多凭据加密保存、逐阶段模型/Skill/强度、真实工具执行和 PDF 报告下载。

**Architecture:** 在现有每账号 Store 上注册模型中心，凭据使用部署主密钥加密。现有工作流保留节点 ID，增加 preprocess/charts/pdf，读取不可变阶段配置与 Skill。独立受控工具生成分析及图表产物，服务器渲染 PDF。

**Tech Stack:** Node crypto / SQLite / Express / React TS / Python named tools / Playwright Chromium。

## 公共契约

阶段顺序：quality, plan, preprocess, activity, retention, monetization, channel, seasonality, charts, insights, report, verify, pdf。pdf 是工具节点。旧任务及原单模型路径保持兼容。

模型中心 API：
```text
GET /api/model-hub -> {credentials, profiles, workflow, skills, vault}
POST /api/model-credentials -> {credential}
PUT /api/model-credentials/:id -> {credential}
DELETE /api/model-credentials/:id -> {ok:true}
POST /api/model-profiles -> {profile}
PUT /api/model-profiles/:id -> {profile}
DELETE /api/model-profiles/:id -> {ok:true}
POST /api/model-profiles/:id/test -> {ok,message}
POST /api/model-credentials/:id/models -> {models,baseUrl,partial}
PUT /api/workflow-config -> {workflow}
POST /api/workflow-skills -> {skill}
PUT /api/workflow-skills/:id -> {skill}
DELETE /api/workflow-skills/:id -> {ok:true}
GET /api/tasks/:id/report.pdf -> PDF attachment
```

凭据公开字段：id,name,provider,baseUrl,protocol,hasKey,keyHint,version。协议值 chat-completions / anthropic / responses。配置字段：id,name,credentialId,model,capabilities:{efforts:string[],tools:boolean}。工作流：{version:1,defaultProfileId:string|null,stages:Record<string,{profileId:string|null,skillId:string,effort:string,maxTokens:number,timeoutMs:number}>}。Skill：id,name,description,category,version,enabled,stageId,content,builtin。

模型中心注册函数：
```js
const hub = registerModelHub(app, { store, ownerId, masterKey, assertModelSettings, fetchImpl });
hub.publicState();
const snapshot = hub.captureWorkflow(); // 无 Key，含每阶段 Skill 原文与 profile/credential version
const context = hub.context(snapshot.stages[stageId]); // {settings,key,maxTokens,timeoutMs}
```

默认主密钥环境变量 LAGENT_CREDENTIAL_MASTER_KEY（32 字节 base64）。缺失时提供明确 vault 状态，保留旧会话 Key 模式，禁用持久凭据写入。云端由 workspace 的 userId 作为 ownerId；本地使用 local。新工作流仅在设置了 defaultProfileId 时启用，旧路径继续运行。

## 任务 1：加密凭据与模型中心（后端独立任务）

Files: server/credential-vault.js、server/model-hub.js、server/workflow-config.js、各自测试；server/model-protocol.js、server/gateway.js 仅此任务维护。

- [ ] 先写 Node test：保存/重启解密、多 Key、跨 owner/AAD 拒绝、缺密钥、删除和接口绑定、公开数据无秘密。运行 `node --test server/credential-vault.test.js` 观察失败。
- [ ] 实现 AES-256-GCM 与 Store config 密文保存，nonce 随机，认证失败不输出底层错误或明文。
- [ ] 写模型中心 API 测试，验证 profile credential 引用、非法强度、Skill 版本和 snapshot 不随修改而变化。实现上述 API 与注册接口。
- [ ] 能力表按已查官方完整模型 ID 判断；未知模型仅 default。协议适配注入实际 effort；Responses 支持解析与用量。保留旧协议测试。
- [ ] 运行定向测试及原 gateway/model-catalog 测试；报告改动文件和结果，不提交其他工作。

## 任务 2：模型中心与工作流界面（前端独立任务）

Files: src/workflow-types.ts、src/components/WorkflowSettings.tsx、src/components/CredentialManager.tsx、src/workflow-settings.css、src/components/ModelSettings.tsx。主代理负责 api.ts/types.ts/App/NewAnalysis/报告页。

- [ ] 编写配置纯函数测试（阶段覆盖、mid->medium、可选档位）；观察失败后实现。
- [ ] 新增可复用 ModelHubSettings 组件，直接封装 fetch 到 `/api`，使用既有同源会话。密钥 type=password，绝不写浏览器持久存储。
- [ ] 提供凭据 CRUD、模型配置 CRUD 与连接测试、默认模型、各阶段 Skill/模型/强度/预算、账号私人 Skill Markdown 编辑导入。
- [ ] 将组件嵌入现有模型设置，保留原单模型配置作为旧服务兼容入口。hub API 不存在时合理显示说明。
- [ ] 运行 `npm.cmd run build` 只在主代理通知集成后执行；本任务先用 TypeScript 报错定位组件自身问题。

## 任务 3：分析工具和 PDF（独立任务）

Files: server/analysis-tools.js、server/tools/analysis.py、server/report-pdf.js、server/report-document.js、各自测试；不改 app/workflow/package/deploy 文件。

工具接口：
```js
await runAnalysisTool(name, input, {dataset, report, signal});
await buildReportPdf(task, {signal}); // 返回 Buffer，PDF 内容来自已核验报告和 report.charts
```

- [ ] 先写实际小数据测试，验证描述统计、无原始 ID 外发、标准图表真实取数、取消/非法工具拒绝、PDF HTML 转义和内容范围。
- [ ] 命名工具提供 profile/clean/describe/group/statistics/chart，限制输入输出、超时、工作目录；不执行任意用户代码，不传 API Key。
- [ ] Python 提供固定 pandas/NumPy/SciPy/Matplotlib 操作；可检测运行环境，工具缺失明确报错。图表给报告返回可嵌入本地 SVG/PNG，模型只接收数据摘要和产物元信息。
- [ ] PDF 使用受控 HTML、中文字体、离线图表、A4、页码与分页，资源请求拦截。并发/超时可控、finally 关闭浏览器。
- [ ] 定向测试通过；主代理补充运行依赖、Docker 和报告接口后共同验证实际 PDF。

## 任务 4：工作流集成（主代理）

Files: server/app.js、server/cloud-app.js、server/workflow.js、server/stage-agent.js、server/stage-agent.test.js、src/types.ts、src/api.ts、src/components/ReportView.tsx、src/components/RunPanel.tsx。

- [ ] 写集成测试：不同阶段请求不同 mock 主机/模型，实际 Skill 内容存在，effort 正确，快照不泄露 Key，阶段结果依次持久化。先观察失败。
- [ ] 注册 hub，运行任务时冻结无秘密 snapshot 并提供 context resolver；useAI 且已选工作流默认模型时走新流程，否则保留原路径。
- [ ] 新 stage-agent 执行有界 JSON 工具计划循环：最多 4 轮，工具参数经白名单和 schema 校验，只返回安全聚合信息；调用 gateway.chat 并注入 Skill。
- [ ] 数据处理只自动执行不改变口径的标准化；需删行/填补则产出待确认计划，不自行修改原数据。保留分析内核与缺表/skip 掩码。
- [ ] 每节点记录 artifact（输入版本、摘要、工具结果、用量、模型/Skill/effort），新任务 PDF 成功才结算；失败保留产物并退款。
- [ ] PDF API 鉴权依托当前账号工作空间，完成/失败任务均可对已核验报告只重试导出，不触发模型或钱包 mutation。
- [ ] 前端呈现阶段真实用量/摘要、下载 PDF，增加新能力开关以兼容旧服务器。

## 任务 5：部署、验证与审查（主代理协调）

Files: package.json / package-lock.json、Dockerfile、compose.yaml、.env.example、README.md、docs/api-contract.md、docs/cloud-deployment.md、e2e/workflow.spec.ts。

- [ ] 补依赖：Playwright server runtime 和 Chromium 安装；Python 固定 requirements 与中文字体。主密钥只能来自部署配置，不生成后提交。
- [ ] 先以临时账号和虚构测试 Key 运行全链路：凭据保存、退出/重启、配置阶段、mock 多模型、工具、下载 PDF。
- [ ] 运行完整 `npm.cmd test` 与 `npm.cmd run build`；不能以历史测试结果代替。
- [ ] 渲染实际 PDF 到 PNG，检查中文、图表、分页和长表；记录工具/字体实际可用情况。
- [ ] 独立进行规格审查，再质量审查，修复确定问题并复验。保留其他会话改动，不提交/推送/部署未授权外部目标。

## 执行约束

用户确认原目录路线，本轮在 D:\lagent 工作，不另建 worktree、不重置现有修改。所有新代码先写能够证明行为的失败测试。Git 提交仅在能隔离本轮改动时进行，不混入他人工作。主代理集中修改共享文件。所有模拟模型使用虚构 Key，不调用用户付费模型。
