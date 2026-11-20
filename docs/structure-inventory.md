# Lagent 结构盘点与迁移方案

> 依据：`structuring-project`（用目录结构管项目）  
> 盘点日期：2026-11-16；文中的文件数、行数与测试数是当日快照，后续新增功能会使其过时。  
> 本文只做盘点与定界，**不移动、不改写任何代码**。迁移按第五节的批次逐步执行，每批以测试全绿为验收。

## 0. 范围与现状

- 本次作用于 `server/`（后端）与 `src/`（前端）中的**业务概念归属**；前端不在 skill 的内外分层范围内，只在必要时调整目录。
- 当前规模（2026-11-19 复核）：`server/` 顶层 182 个 `.js`（其中 121 个测试），`server/work/` 69 个 `.js`，前端 38 个 `.ts/.tsx`。
- 关键文件：`server/work/engine.js` 3249 行、`server/work/routes.js` 408 行、`server/app.js` 485 行。
- 结构现状：按技术/功能平铺在 `server/` 根目录，配 `server/work/` 一个“工作台”子域；HTTP 路由、领域规则、SQLite 读写、外部 CLI 调用混在同一批文件里。

## 1. 用例盘点（先盘点，再建目录）

名词是实体，动词是用例；最后一列是当前实现位置。

| 业务概念 | 实体 | 用例 | 当前实现位置 |
|---|---|---|---|
| 项目 | Project / ProjectBrief / ProjectChange | ImportProject、RenameProject、DeleteProject、SaveBrief、RecordChange、ApplyLibrary | `work/projects.js`、`engine.js`、`work/library-sync.js` |
| 项目对话 | ProjectChat / ChatTicket | CreateChat、SendMessage、UpdateChat、DeleteChat、ListChatTickets | `engine.js`（`projectChatMessage` 等）、`work/routes.js` |
| 工单 | Ticket / Assignment / Report / Attention | CreateTicket、TicketDetail、Trace、Approve / Reject / Stop / Retry / Resume / Skip、Verify | `work/engine.js`、`work/domain.js`、`work/verify.js` |
| 多步计划 | Plan / PlanStep | CreatePlan、SuggestPlan、GetPlan、Advance、Cancel、Sheet、Skip/Retry | `work/engine.js`、`work/sheet.js`、`work/run-projection.js` |
| 执行与派发 | Execution / Effect / Outbox | Enqueue、Drain、Launch、Settle、Reconcile、Recover、CancelEffect | `work/engine.js`、`work/effects.js`、`work/outbox.js` |
| 权限与预算 | Policy / Budget / PermissionProfile | GetPolicy、UpdatePolicy、CheckPermission、Profiles CRUD/Apply/Reset | `work/policy.js`、`work/profiles.js`、`work/command-risk.js`、`work/risk.js` |
| 项目记忆 | Memory | SaveMemory、SearchMemory、ForgetMemory、SyncToAgents | `work/project-memory.js`、`memory.js`、`memory-api.js`、`work/library-sync.js` |
| 技能与插件 | Skill / Plugin / Marketplace | List、Preview、Install、Update、Enable、Disable、Remove | `work/skills/`（`service.js`、`installer.js`、`plugins.js`、`sources.js`） |
| 团队协作 | Team / TeamRoom / Teamwork / TeamTemplate | CreateRoom、PostMessage、Claim、Decide、TeamworkStart/Assemble/Retry | `work/team.js`、`work/team-room.js`、`work/teamwork.js`、`work/team-templates.js`、`team-runtime.js` |
| 例行任务 | Routine / Hook | List、Create、Update、Delete、Run、WebhookTrigger | `work/routines.js`、`work/routes.js` |
| 编排运行 | Run / Orchestrator | StartRun、GetRun、Approve、Cancel、Resume、ListRuns | `work/orchestrator/`、`work/routes.js` |
| 实时会话 | LiveSession | List、Create、Get、Frame、Pause、Resume、Takeover、Stop | `work/live-session.js`、`work/routes.js` |
| MCP 集成 | McpServer / McpToken | ListServers、SaveServer、DeleteServer、Test、Tokens | `work/mcp.js`、`work/mcp-client.js`、`work/mcp-tokens.js` |
| 交接与度量 | Handoff / Usage / Roster | SaveHandoff、BuildSheet、UsageSummary、UsageCsv、Roster | `work/handoff.js`、`work/usage.js`、`work/session-usage.js`、`work/agent-context.js` |
| 数据集（旧产品线） | Dataset | Upload、Demo、Metadata、Timezone、Completeness、Delete | `app.js`、`datasets.js`、`completeness.js`、`timezone.js` |
| 分析任务（旧产品线） | Task / Workflow / Stage | CreateTask、Retry、Skip、Approve、Message、Cancel、Summary、Events | `app.js`、`workflow.js`、`task-monitor.js`、`stage-*.js`、`workflow-config.js` |
| 报告与分享 | Report / ReportAsset / Share | GeneratePdf、ExportMd、Explore、Version、Share | `report-pdf.js`、`report-assets.js`、`report-explore.js`、`report-document.js`、`report-sharing.js`、`report-version.js` |
| 账户与凭据 | Account / Credential / Phone | Register、Login、ChangePassword、PhoneBind、Vault CRUD | `accounts.js`、`phone-auth.js`、`credential-vault.js`、`cloud-app.js`、`mobile-gateway.js` |
| 模型与供应商 | Model / Provider / Usage | Settings、Catalog、Hub、ProviderPool、Usage | `model-hub.js`、`model-catalog.js`、`model-protocol.js`、`providers.js`、`provider-pool.js`、`model-usage.js` |
| 外部工具 | Tool / Executor | Terminal、Browser、GitHub、Window、MCP、CLI 执行器 | `work/executors/`、`agent-tools.js`、`tools/`、`window-bridge.js` |
| 通知与远程批准 | Channel / ApprovalToken | SaveChannel、TestChannel、HandleAction、IM Notify | `work/im-notify.js`、`work/routes.js` |
| 备份与诊断 | Backup / Diagnostics | Export、Restore、Status、Diagnostics | `work/backup.js`、`work/routes.js` |

跨多个用例的规则（应进 `model`，不能塞进某个 use case）：

- 工单状态机与合法动作：`work/domain.js` 的 `transitions` / `assertWorkAction`。
- 并发、预算与执行器白名单：`work/policy.js`（`normalizePolicy`、`EXTERNAL_EXECUTORS`）。
- 计划推进/依赖判定：`work/engine.js` 内的 `advancePlan` / `recoverPlans`。
- 命令风险分级与密钥脱敏：`work/command-risk.js`、`work/risk.js`。

## 2. 目标结构

按 skill 的“内 `application/`、外 `adapter/`”，映射到 Node/ESM：

```
server/
  application/                 # 内层：只允许标准库 + 本层；禁止 express / node:sqlite / child_process / http / fs
    project/                   # 一个业务概念一个包
      model.js                 # Project、Brief、Change 与不变式
      service.js               # ImportProject / RenameProject / DeleteProject ...
      repository.js            # 端口接口：只声明方法
    chat/    {model,service,repository}.js
    ticket/  {model,service,repository}.js
    plan/    {model,service,repository}.js
    execution/{model,service,repository}.js
    policy/  {model,service,repository}.js
    memory/  {model,service,repository}.js
    skill/   {model,service,repository}.js
    team/    {model,service,repository}.js
    routine/ {model,service,repository}.js
    dataset/ {model,service,repository}.js
    task/    {model,service,repository}.js
    report/  {model,service,repository}.js
    account/ {model,service,repository}.js
    model/   {model,service,repository}.js
  adapter/                     # 外层：可以 import application，反向不行
    http/
      work-routes.js           # 现在 work/routes.js 的拆分结果
      app-routes.js            # 现在 server/app.js 的路由部分
      mobile-gateway.js
    persistence/
      store.js                 # 现在是 server/store.js
      work-store.js            # 现在是 work/store.js
      backup.js
    executors/                 # 现在是 work/executors/
      cli.js  claude-code.js  codex.js  acp.js  model.js
      terminal.js  browser.js  github.js  window.js  workbuddy.js
    tools/                     # MCP、agent-tools、window-bridge
    report/                    # pdf / assets / explore / sharing
    notify/
  platform/                    # 纯技术：env、timezone、version、脱敏、不可信内容包装
  main.js                      # 装配：把 adapter 注入 application
```

说明：

- 不建 `shared/` 垃圾桶。`workError` 这类跨概念错误应放到被依赖的概念（`ticket/model.js`）或 `platform/errors.js`。
- 执行器是**出站适配器**，放 `adapter/executors/`；`cli.js` 是驱动多个 CLI 的通用实现，也归外层。
- `work/store.js` 与 `server/store.js` 是通用 KV 存储，现阶段归 `adapter/persistence/`；等 repository 端口建立后再收窄为 SQLite 实现。
- 前端 `src/` 保持现状；若后续整理，只按页面/组件分目录，不套 `application/adapter`。

## 3. 放置规则（Node 版）

| 手上这段代码 | 放哪 |
|---|---|
| 工单状态、计划依赖、金额/预算不变式 | `application/<概念>/model.js` |
| 一次 HTTP 请求对应的编排（创建计划、派发工单） | `application/<概念>/service.js` |
| 要读写数据但不想知道 SQLite/KV | `application/<概念>/repository.js`（接口） |
| 出现 `express` / `node:sqlite` / `child_process` / `fs` / `fetch` 的 import | `adapter/` |
| 纯技术工具（脱敏、时间、env、JSON 读写） | `platform/` |
| 两个概念都要用 | 放被依赖的一方，或提成第三个概念包 |
| 前端只做协议转换与展示 | `src/`，不进入后端分层 |

一句话判据：**看它 import 什么**。import 了框架、数据库、子进程、文件系统 → 外层；只 import 标准库和本概念 → 内层。

## 4. 现状诊断（对应 skill 的三种症状）

| 症状 | 证据 |
|---|---|
| **找不到** | `server/` 根目录 178 个文件平铺，命名按技术后缀（`-hub`、`-catalog`、`-panel`、`-usage`），`work/` 下也没有二级域目录 |
| **读太多** | `engine.js` 2488 行同时承载项目、对话、工单、计划、执行、策略、记忆、技能、团队、备份；改一个概念要读整文件 |
| **一改牵连三处** | `engine.js` 直接调用 `db.list/get/put`，换存储要改 engine；`routes.js` 直接调 `engine.*` 与 `imNotifier`，协议转换与用例耦合；`team-room.js` 在 engine 构造后反向注入 |
| 已有好苗头 | `work/domain.js`（状态机）、`work/policy.js`（预算/白名单）、`work/projects.js`（项目仓储）已经接近概念包；`work/executors/` 已经是清晰的外层 |

## 5. 分批迁移计划（风险从低到高）

每批完成都必须跑：`npm test`（全量）；涉及 HTTP 的再加 `npx playwright test`。

### Phase 0：盘点与定界（本文，已完成）

- 产出本文件；不改代码。
- 确认目标概念包清单与边界。

### Phase 1：建边界与依赖闸门（不改现有代码）

- 建 `server/application/` 与 `server/adapter/` 空目录（只放 `.gitkeep` 与 README 说明边界）。
- 新增 `scripts/check-architecture.mjs`：扫描 `server/application/**`，若出现 `express`、`node:sqlite`、`child_process`、`node:fs`、`node:http` 的 import 则退出码 1。
- 写入 `package.json` 的 `lint:arch` 脚本；先不接 CI。
- 验收：`node scripts/check-architecture.mjs` 通过（空目录无违规）。

### Phase 2：搬纯规则（低风险）

- `work/domain.js` → `application/ticket/model.js`（状态机、`workError`）。
- `work/policy.js` 的规则部分 → `application/policy/model.js`；读取 env 的部分留在 `platform/env.js`。
- `work/command-risk.js` → `application/policy/command-risk.js`。
- `work/risk.js` 的脱敏 → `platform/redact.js`。
- 原文件改为 re-export，保证现有 import 不断。
- 验收：`npm test` 全绿；`lint:arch` 仍通过。

### Phase 3：拆 `engine.js`（最大改动，按概念分 4 小批）

1. 计划 + 工单动作：`plan/service.js`、`ticket/service.js`。
2. 项目 + 对话：`project/service.js`、`chat/service.js`。
3. 执行/派发/回收：`execution/service.js`（outbox、effects、reconcile）。
4. 策略/配置档/记忆/技能/团队：各自 `service.js`。

做法：

- 每小批只搬一个概念的函数与私有辅助函数，`engine.js` 保留同名方法转发。
- 先搬纯计算函数，再搬带 `db` 访问的函数；跨概念调用改为显式依赖注入（`createXxxService({repo, policy, now})`）。
- 每小批跑一次 `npm test`，失败就回退该小批。

### Phase 4：repository 端口

- 为 `project`、`chat`、`ticket`、`plan`、`policy`、`memory` 定义 `repository.js` 接口。
- 在 `adapter/persistence/` 写实现，engine 只依赖接口。
- 验收：新增一个内存版 repository，让至少 1 个概念的单测不再碰 SQLite。

### Phase 5：路由外移

- `work/routes.js` 按概念拆成 `adapter/http/work/{projects,chats,tickets,plans,rooms,skills,plugins,routines,im,usage,backup}.js`。
- `server/app.js` 的路由部分移到 `adapter/http/app-routes.js`，`app.js` 只保留装配。
- 验收：`npx playwright test` + 现有 `app.test.js` / `work-*.test.js` 全绿。

### Phase 6：执行器与工具外移

- `work/executors/` → `adapter/executors/`。
- `work/mcp*.js`、`work/skills/installer.js` 的文件系统部分 → `adapter/tools/`。
- 验收：`server/cli-executors.test.js`、`server/acp-*`、`server/mcp*`、`server/work-skills.test.js` 全绿。

### Phase 7：收尾

- `lint:arch` 接入 `prepublish` 或 CI；在 `README` 与 `docs/` 写明“新文件放哪”。
- 用三个验收问题复核（见第 6 节）。

## 6. 三个验收问题（当前答案 vs 目标）

1. **工单为什么不能从 failed 直接 approve？**  
   当前：`work/domain.js` 能答，但 `engine.js` 的 `ticketAction` 还有一份隐含状态判断。  
   目标：只在 `application/ticket/model.js` 一处。
2. **系统对外提供哪些用例？**  
   当前：`routes.js` 能列全，但用例实现散在 `engine.js`。  
   目标：`application/*/service.js` 一眼列全。
3. **换一种存储要改哪里？**  
   当前：`store.js` 之外，`engine.js`、`project-memory.js` 等多处直接调 `db`。  
   目标：只改 `adapter/persistence/`，一小时内换完。

## 7. 前置条件与风险

- 当前工作区有**大量未提交改动**（`server/work/engine.js`、`routes.js`、前端组件等）。迁移前必须先提交或建分支，并备份 `D:\lagent\data`。
- 迁移期间不要同时跑多 Agent 计划；`engine.js` 拆分后运行中的工单可能找不到方法。
- 测试大量使用相对路径 import；每次移动都要同步改测试 import，否则会出现“测试全红但代码没错”的假象。
- `engine.js` 拆分要保留 `engine` 门面，避免一次改掉 60+ 个路由调用点。
- 本方案不处理 `backups/`、`build/`、`dist/`、`release/`、`prototype/`、`artifacts/` 等产物目录；那些属于清理项，不是结构分层。

## 8. 迁移进度

- [x] Phase 0 盘点与定界（本文）
- [x] Phase 1 边界与依赖闸门：`server/application/README.md`、`server/adapter/README.md`、`scripts/check-architecture.mjs`、`npm run lint:arch`
- [x] Phase 2 搬纯规则：
  - `work/domain.js` → `application/ticket/model.js`（原文件 re-export）
  - `work/policy.js` 规则 → `application/policy/model.js`（env 判定留在原文件）
  - `work/command-risk.js` → `application/policy/command-risk.js`（原文件 re-export）
  - `work/risk.js` 拆为 `application/ticket/preview.js` + `platform/redact.js`（原文件 re-export）
  - 验收：`npm run lint:arch` 通过；`npm test` 全绿
- [x] 附带修复（多 Agent 计划实测发现，均补了单测）：
  - 并发满而退回 `waiting` 的计划步骤，在一名额释放后自动推进（`engine.js` + 跨计划唤醒）
  - 重试时可通过 `maxTurns` 补充回合预算，避免大任务再次 `error_max_turns`
  - `launchStep` 失败回写改用 `privateTicket`，不再抹掉 `command` / `executorInput`
  - 策略里的并发数下发给 CLI 执行器（`setConcurrency`），不再固定为 2
- [ ] Phase 3 拆 `engine.js`（已开始：工单/计划投影移到 `application/{ticket,plan}/projection.js`；其余函数仍留在 engine 门面）
- [ ] Phase 4 repository 端口
- [ ] Phase 5 路由外移
- [ ] Phase 6 执行器与工具外移
- [ ] Phase 7 收尾

## 9. 结论

Lagent 的问题不是“文件多”，而是**业务概念没有落到目录**：核心用例挤在 `engine.js`，协议、持久化、外部进程混在一起。按本文 Phase 1–7 迁移后，`application/<概念>/` 回答“规则在哪、用例有哪些”，`adapter/` 回答“换 Web/换库/换执行器改哪里”，`engine.js` 退化为装配门面。
