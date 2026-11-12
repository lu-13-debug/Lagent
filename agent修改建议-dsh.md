# Agent 修改建议（DSH 版）

> 日期：2026-11-11　　基线：Lagent 1.1.0（`D:\lagent` 当前代码）
> 输入：`agent-dev.md`、`docs/agent-research.md`、`docs/orchestrator.md`、`docs/*-validation.md`
> DSH：DeepSeek Harness，本篇建议由该 agent 在仓库内核查后生成
> 核查方式：读代码与契约文档，不采信文档里的自述；凡标「建议」的均为未实现项
> 配套阅读：`ui-dsh.md`（界面细节，本文不重复）、`docs/api-contract.md`（接口契约）

---

## 0. 一页结论

**不建议重塑产品形态，建议重塑「控制面」。**

Lagent 的形态（对话入口 + 项目档案 + 工单执行 + 多 Agent）已经成立，问题不在少一个功能，而在**三个承诺没有落到运行时**：

1. **批准承诺**：产品叙事是「先确认再执行」，当前默认是 `requireApproval:false`，直接开跑（`server/work/policy.js:32`、`server/work/engine.js:1487`、`:1499`）；批准弹窗又看不到将执行的命令（`server/work/engine.js:24-35`、`src/superagent.ts:4`、`src/components/SuperAgentShell.tsx:1609-1614`）。
2. **完成承诺**：编排器的「验证」只检查文本里点名的文件是否存在（`server/work/orchestrator/index.js:199`、`:384`、`server/work/artifacts.js:53-55`），不跑测试、不跑构建；CLI 以「退出码 0 且解析无 error」算成功。
3. **恢复承诺**：崩溃后只把 run 标成 `interrupted`（`server/work/orchestrator/runs.js:97`），没有从最后一步续跑；durable outbox 只覆盖 `launch` 一个动作，且生产未启用（`server/work/routes.js:31`、`server/work/outbox.js:3`）。

**建议顺序**：先把这三处补成可验收的闭环（P0），再把队列/成本/记忆做成基础设施（P1），最后才扩多 Agent 与评估（P2）。在 P0 完成前，不建议增加任何新的 Agent 类型或协作形态。

如果只做三件事：

| # | 动作 | 直接收益 |
|---|---|---|
| 1 | 审批卡展示「将执行的动作 + 路径 + diff 预览 + 影响面」，并按动作风险分级 | 批准从「点标题」变成「看证据」 |
| 2 | 每个工单带 `verify`（命令 + 期望），失败即回退到 `needs_review` | 「完成」有客观判据 |
| 3 | 文档/默认策略/MCP 三处对齐，封堵 MCP 自批与 brief 直写 | 消除「说一套做一套」的安全债 |

---

## 1. 这个软件在开发时的地位

`README.md:3` 的自我定义是准确的：

> 面向个人与小团队的多 Agent 指挥台：连接 Claude Code、Codex、DeepSeek Harness 等本机 Agent，接收一个项目和任务后拆解成步骤，把任务要点分派给不同 Agent 执行，并把每次修改沉淀为项目档案。

把它放回开发流程里，它的位置是**「人」与「多个本机 Agent」之间的那层控制台**：

```
开发者 ── 意图/验收 ──► Lagent（项目上下文 + 工单 + 证据）
                           ├─ Claude Code / Codex / DSH（本机 CLI；可读可写，取决于权限档；ACP 只读）
                           ├─ 受控终端（只读 git/npm/ls）
                           ├─ 受控浏览器 / GitHub（只读）
                           └─ 项目档案（brief / 变更 / 决定 / 未解问题）
```

它**不是**：IDE、CI、云沙箱、聊天产品、模型供应商。它**是**：本机 Agent 的项目级记忆与审计层。

这个定位决定了两条设计约束：

- **约束 A（本地优先）**：Agent 在本机跑，密钥、代码、窗口都在用户机器上；因此「权限边界」比「模型能力」更能定义产品。
- **约束 B（项目优先）**：用户真正要接手的是「这个项目改了什么、为什么、下一步是什么」，不是「哪次对话说了什么」。所以 `brief` 必须是唯一交接面，聊天只是入口。

对照两份调研，Lagent 的差异化不在「多 Agent」（编码任务并行度低，`agent-dev.md` 明确不建议默认多 Agent），而在**把本机 Agent 的产出沉淀成可交接的项目状态**。这一点当前做得比多数同类工具好（`server/work/projects.js:519`、`:631` 的 brief 与变更时间线），应当放大，而不是稀释。

---

## 2. 现状核查：会改架构的七个缺口

以下只列「不修就会限制后续所有功能」的问题，按影响排序。

### D1　批准链已与现实脱节（最高优先）

| 事实 | 证据 |
|---|---|
| 默认不要求批准，直接执行 | `server/work/policy.js:31-32` 注释「默认不再『先批准再执行』」；`requireApproval:false` |
| 直跑判定与建单 | `server/work/engine.js:1487` `auto=direct&&policy.requireApproval!==true`；`:1493` `status:auto?'queued':'awaiting_review'`；`:1499` 直接 `start(record)` |
| 计划路径同样默认跑完 | `server/work/engine.js:839` `autoRun` 默认 `!==true` |
| 公开工单剥掉了动作细节 | `server/work/engine.js:24-35` 剥掉 `command / executorInput / approvalSnapshot / prompt / artifacts` |
| UI 拿不到动作，只能显示标题 | `src/superagent.ts:4` attention 只有 `{question,options,createdAt}`；`src/components/SuperAgentShell.tsx:1609-1614` 只渲染标题/问题/执行器/项目/时间 |
| 只有 analysis 与 model 提供审批快照 | `server/work/executors/analysis.js:20`、`server/work/executors/model.js:1149`；CLI/terminal/browser/github/window 没有 |
| 文档仍在承诺旧行为 | `README.md:106`「先落到待确认工单；批准后才执行」；`docs/work-policy-validation.md:7` 写 `requireApproval:true`；`docs/api-contract.md:179` 已改为默认 false——同一仓库三种说法 |

**后果**：默认路径下没有「批准」这一步；需要批准时，用户看到的也只是一个标题。批准从「风险控制」退化为「确认弹窗」。更具体地说，项目对话里的 CLI 默认就是写入模式（`README.md:105`），一旦执行器被勾选并设置了 `LAGENT_ALLOW_EXTERNAL_EXECUTORS=1`，一条「改这个文件」的消息会直接进入可写 CLI，中间没有任何动作前确认。这是产品最核心的信任承诺，必须先修。

### D2　「完成」没有客观判据

- 编排器只检查「文本里点名的文件是否存在」：`server/work/orchestrator/index.js:199`、`:384` 调用 `artifactGap`；`server/work/artifacts.js:53-55` 只做 `fs.existsSync`。
- 不跑测试、不跑构建、不校验页面可打开；CLI 以「退出码 0 且解析结果无 error」视为成功（`server/work/executors/cli.js:274`），不校验它声称的改动是否真的发生。
- 确定性 critic 只审 13 阶段数据分析的计划/报告（`server/critic.js:2`、`:34`），**不审 Work 工单**。
- 结果：Codex 进程 0 退出、工单报完成、但 `input.js` 没落盘的事故，只靠 `artifacts.js` 注释里那次教训兜底，无法系统性避免。

### D3　中断只能「标记」，不能「续跑」

- `server/work/orchestrator/runs.js:97` 的 `markInterrupted()` 把 running/verifying/repairing/awaiting_approval 全部改为 `interrupted`，错误文案是「服务重启，这次运行中断了」，没有 resume/replay。
- 懒加载时触发：`server/work/routes.js:96`；所以**每次重启都会丢正在跑的 run**。
- durable outbox 只实现 `launch`（`server/work/outbox.js:3`），payload 只含 `{assignmentId,datasetId,useAI}`；重启只恢复 `attempts<=1` 的 effect，`attempts>1` 直接 failed（`docs/work-outbox-validation.md:55-59`）；无查询/管理 API、无 UI。
- 生产未启用：`server/work/routes.js:31` 调 `createWorkEngine` 时没传 `outboxEnabled`，`server/work/engine.js:51` 默认 `false`。
- CLI 只回写 `sessionId`（`server/work/executors/cli.js:242`），没有可重放的步骤记录。

**后果**：用户感知是「一重启就白干」；对长任务（CLI 写代码、浏览器操作）尤其致命。

### D4　协作形态的成本与收益倒挂

- 主界面推「多选 Agent → 并行交叉验证 → 手选汇总」（`README.md:76`、`src/components/SuperAgentShell.tsx:831-892`），但汇总者由用户手选（`:1211`），没有自动仲裁。
- 团队树只挂在 analysis 执行器（`server/work/engine.js:1729`），Work 工单用不上；`teamwork.js` 是固定分片写骨架再拼 `index.html`，不是通用协作。
- 分层团队默认关闭，开启后限 3 层/12 节点/3 并发/48 次调用/65536 Token/10 分钟（`server/work/team.js` 的 `LIMIT_KEYS`），但 UI 没有实时树，提案不落主数据（`docs/hierarchical-team-validation.md`）。
- 交叉验证的 token 成本是单 Agent 的数倍（`agent-dev.md`：研究型任务约 15 倍），而编码任务的并行收益通常不足以抵消。

**后果**：默认路径把最贵的形态放在最显眼的位置，最便宜的形态（单 Agent + 工单）反而要用户自己克制。

### D5　记忆是「结论仓库」，不是「交接单」

- brief 只有 `goal / summary / keyPoints / decisions / constraints`（`server/work/projects.js:519`），`briefMarkdown` 只渲染这五节（`:631-646`）；**没有「未解问题 / 下一步 / 验收命令 / 证据链接」**。
- 记忆条目类型里其实有 `openQuestions / improvements`（`src/superagent.ts:57-60`），但没进 brief 的写入口径，MCP 的 `work_update_project_brief` 也只覆盖五节（`server/work/mcp.js:40-55`）。
- 写入没有来源与置信度：MCP 可以直接改 brief（`:40-55`），外部内容（issue 正文、网页）与用户结论混在一起，无法区分。
- 读取没有 digest 层级：brief 全量进上下文，项目一大就挤占执行预算。

**后果**：换一个 Agent 接手时，仍然要重新问一遍「现在卡在哪、下一步做什么」——这正是产品声称解决的问题。

### D6　成本不可见，预算不硬

- 只有 `maxCallsPerTicket` 与 `maxRuntimeMs` 在执行前拦截（`server/work/engine.js:783`、`:785`）；`maxTokensPerTicket` 只在策略校验里存在，执行器没有统一计量，也不拦截。
- `/api/model-usage` 只管模型调用（`server/app.js:233`）；Work 没有成本/用量聚合端点。
- CLI 的 usage 塞在 artifact 里（`server/work/executors/cli.js:231`），没有汇总到工单/项目/天。
- 13 阶段分析的轨迹与预算展示（`docs/agent-phase6-validation.md`）只覆盖数据分析 Task，不覆盖 Work 工单。

**后果**：用户无法回答「这个项目上周花了多少、哪个 Agent 最贵、哪类工单在漏钱」；预算形同虚设。

### D7　规模债：三个文件扛着整个控制面

- `server/work/engine.js` 1907 行；`src/components/SuperAgentShell.tsx` 1820 行 / 约 156KB；`server/work/orchestrator/index.js` 单文件承担 planner、dispatcher、waiter、artifact check。
- `e2e` 只有 23 个 spec；批准相关断言只零散出现在 `plans.spec.ts`、`handoff.spec.ts`、`mobile-command.spec.ts`、`superagent-shell.spec.ts` 四个文件里，审批卡内容、崩溃恢复、verify 失败路径都没有专门用例。
- 结果：任何控制面改动都要在三个大文件里同时改，回归靠人肉。

> 另有若干文档漂移（`README.md:76` 说左侧有「收件箱」，实际已并入对话，`SuperAgentShell.tsx:17`；`acceptMode` 类型允许 `observe`，校验只接受 `auto|explicit`，`src/superagent.ts:15` vs `server/work/policy.js:98`）。这类漂移单看是小事，叠加起来会让「以文档为准」的接手者做出错误判断。

---

## 3. 方案 A（推荐）：对话做入口，工单做控制面

**一句话**：保留现有聊天入口与项目档案，把「工单」升级为唯一的决策与证据对象；UI 从「对话流 + 弹窗」改成「对话 + 决策收件箱 + 运行详情」三块；运行时补上审批分级、验证门、步骤持久化。

改造而非重塑的理由：

- 引擎已经以工单为事实源（`docs/orchestrator.md`），改造成本远低于重写；
- 对话入口是低摩擦优势，砍掉会让产品变成又一个「填表派活」工具；
- 真正缺的是控制面，不是形态。

### 3.1 领域模型：让工单携带「决策所需的一切」

**现状**：`WorkTicket` 只有标题/状态/执行器/摘要/attention（`src/superagent.ts:5-10`），动作细节被投影层剥掉（`server/work/engine.js:24-35`）。

**建议**：给工单增加只读投影字段（不是把原始输入全量暴露）：

```ts
// src/superagent.ts（建议）
interface WorkPreview {
  kind: 'command' | 'file-write' | 'window-input' | 'network' | 'model';
  command?: string;        // 已脱敏、截断到 500 字
  cwd?: string;
  paths?: string[];        // 将写入/读取的路径
  diffStat?: string;       // 例如 "3 files, +42 -7"
  diff?: string;           // 仅 UI 展开时按需拉取，默认不下发
  hosts?: string[];        // 外联域名
  risk: 'low' | 'medium' | 'high';
  reversible: boolean;
}

interface WorkTicket {
  // ...现有字段
  preview?: WorkPreview;   // 新增
  verify?: { command: string; expect: string; timeoutMs?: number }; // 新增
  evidence?: { kind: string; ref: string; at: string }[];           // 新增
}
```

`publicTicket` 继续剥掉 `command/executorInput`，但保留 `preview`（由执行器在创建时生成、脱敏、截断）。这样 UI 不需要拿到原始 argv，也能显示「将执行什么」。

**风险**：`preview` 可能泄露密钥/路径。生成时必须过现有的脱敏函数（`cli.js` 的 `sanitizeUsage` 同类逻辑），并限制长度；diff 只在用户展开时通过独立端点读取（带权限校验），不塞进列表响应。

**验收**：任意 CLI/terminal/browser/github 工单，在批准前都能看到 `kind/cwd/paths/risk`；`preview.diff` 端点对未授权用户返回 403。

### 3.2 审批分级：按爆炸半径，而不是一刀切

**现状**：只有全局 `requireApproval` 布尔（`server/work/policy.js:32`），没有按执行器/动作分级；默认直跑。

**建议**：引入三档，挂在「执行器 × 动作」上，默认值写进策略并可在设置页改：

| 档位 | 适用 | 行为 |
|---|---|---|
| `investigate` | 只读查询、读文件、`git status/diff/log`、只读 ACP | 不打断，直接跑，事后可查 |
| `draft` | 写文件、可写 CLI、模型写操作、窗口键入 | 首次弹一次「本会话允许」，之后同执行器同项目不再逐条问；可在策略里改为逐条 |
| `autopilot` | 外联（GitHub 写、浏览器提交）、发布、删除、跨目录写 | 每次都要批准，且批准卡必须展示命令/路径/diff/影响面 |

落地方式：

- `policy.js` 增加 `tiers: { [executorId]: { read: 'investigate', write: 'draft', publish: 'autopilot' } }`，保留 `requireApproval` 作为总开关（兼容旧配置）。
- `engine.js:1487` 的 `auto` 判定改为 `tierFor(executor, action) === 'investigate'`；`draft` 首条工单进 `awaiting_review`，批准后写一个 `sessionGrant`（项目 + 执行器 + 权限档），后续直接跑；`autopilot` 永不自批。
- 批准卡展示 `preview` + `verify`，并给「批准并运行 / 退回 / 本会话都允许」三个动作；「本会话都允许」必须显式勾选，且只对 `draft` 生效。
- 设置页已有策略编辑器（`src/components/SuperAgentShell.tsx:1415-1431`），在其上增加三档矩阵，不新开页面。

**兼容性**：默认 `requireApproval:false` 的行为保留为「investigate 直跑」；`draft` 的默认值建议设为「首次询问」，这会改变现有 CLI 项目对话的体验——属于有意变更，需要在更新日志里写明。

**回滚**：tier 配置整块可置空，回退到 `requireApproval` 布尔逻辑；无数据迁移。

### 3.3 验证门：从「文件存在」到「命令通过」

**现状**：`artifactGap` 只查文件存在（`server/work/artifacts.js:53-55`）；编排器在 implement 后调用（`orchestrator/index.js:199`）；没有测试/构建/页面检查。

**建议**：每个 implement/verify step 必须带一个可执行的 `verify`：

```json
{
  "command": "npm test -- --runInBand",
  "cwd": ".",
  "expect": "exit=0",
  "timeoutMs": 600000
}
```

- planner 在生成步骤时同时生成 `verify`；无法生成时标 `verify: { command: "artifact", expect: "exists" }`，并在 UI 标黄「仅检查文件存在」。
- 新增 `server/work/verify.js`：执行命令、收集退出码/stdout 摘要、超时 kill、输出脱敏；只允许项目 `package.json` 里声明过的脚本与白名单命令（`npm test/build/lint`、`pytest`、`go test`），不允许任意 shell。
- `orchestrator` 在 implement 后先跑 `verify`，失败则工单进 `needs_review` 并把 `stdout` 尾部 4KB 写进 `evidence`；连续失败 2 次停止并交人（复用现有 `maxRounds=2`）。
- 确定性 critic 扩展到 Work 工单：检查「有 verify」「有 evidence」「改动文件在 preview 声明范围内」「没有把密钥写进 artifact」四条，`rubricVersion:'critic-2'`。

**为什么不直接让 CLI 自己跑测试**：CLI 的「我跑过了」不可验证；验证必须在 Lagent 侧执行并留证，才能进入 brief 与审计。

**验收**：故意让一次实现漏写文件、一次测试失败、一次构建失败，三种情况都能停在 `needs_review`，且 brief 里有失败命令与输出摘要。

### 3.4 持久化与中断：step checkpoint + 通用 effect

**现状**：run 只能标中断（`runs.js:97`）；outbox 只有 launch 且未启用（`routes.js:31`、`outbox.js:3`）。

**建议**（按依赖顺序）：

1. **先启用 outbox**：`routes.js:31` 传入 `outboxEnabled: process.env.LAGENT_WORK_OUTBOX === '1'`，默认仍关，但让它在测试与灰度环境可开；补 `GET /api/work/effects` 与 `POST /api/work/effects/:id/retry`，UI 在运行详情里显示「待重试的启动」。
2. **扩展 effect 类型**：`launch`、`verify`、`notify`、`publish` 四种；每种 effect 的 payload 带 `ticketId/stepId/attempt`；`claimDue` 按 `nextAt` 取，保持现有 2s/4s/8s 退避。
3. **step checkpoint**：每个 step 开始/结束写 `work-run-step`（`status/startedAt/finishedAt/evidence/error`）；`markInterrupted` 改为「把未完成 step 标 `interrupted`，run 标 `paused`」，新增 `POST /api/work/runs/:id/resume`：从第一个非 completed step 继续，已完成的 step 不重跑。
4. **队列语义分层**（对齐 `agent-dev.md` 与 `docs/agent-research.md`）：
   - 用户在当前对话直发的消息 → 可打断当前 turn（cancel 当前 step，保留已完成 step）；
   - 系统回报（子 Agent、定时任务、MCP 回调）→ 只入队，不打断；
   - 连发消息合并为一个 turn（同一 `clientRequestId` 幂等，已在 `engine.js:1837` 做 lastAction 去重，可复用）。
5. **CLI 续接**：保留 `sessionId`，但把「本 step 的 prompt + 输出摘要 + 改动文件」写入 step 记录；resume 时优先 `--resume`，失败则用摘要重建上下文（不重放全量历史）。

**风险**：resume 可能重复执行副作用（如重复 `git push`）。因此 `publish` 类 effect 必须幂等键 + 人工确认；`verify` 可重跑；`launch` 重跑前检查 `ticket.status`。

**回滚**：`resume` 端点可下线，run 仍可读；effect 表新增列用可空字段，旧数据不受影响。

### 3.5 记忆：把 brief 变成「交接单」

**建议**（字段扩展，不新建存储）：

```ts
interface WorkProjectBrief {
  goal: string;
  summary: string;            // 当前进展
  keyPoints: string[];
  decisions: { text: string; reason?: string; at: string }[]; // 现在是字符串数组
  constraints: string[];
  openQuestions: string[];    // 新增：未解问题
  nextSteps: string[];        // 新增：下一步（带 owner/截止）
  verifyCommands: string[];   // 新增：接手后先跑什么
  evidence: { label: string; ref: string }[]; // 新增：报告/工单/变更链接
}
```

- 写入口径统一到 `projects.js` 的 `updateBrief`，MCP 与 UI 走同一个校验；`decisions` 从字符串数组升级为对象数组时做一次兼容读取（旧字符串转 `{text, at}`）。
- 每次工单完成/失败，自动追加一条 `nextSteps` 候选（来自 report 的「建议」段），由用户确认后转正；`openQuestions` 从 critic 的 `warning` 与失败的 verify 自动生成。
- 增加 `source` 与 `confidence`：MCP/外部内容写入的条目标 `source:'external'`、`confidence<=0.6`，UI 用不同样式区分；brief 渲染时把 external 条目单独分组。
- 读取分两级：`digest()` 返回 200 字摘要 + 未解问题 + 下一步（进上下文）；全文按需拉取。

**验收**：新开一个 Agent 会话，只读 brief 就能回答「项目目标/上次改了什么/现在卡在哪/下一步/先跑什么命令」五个问题；MCP 写入的条目在 UI 有来源标记。

### 3.6 成本：账本 + 硬闸 + 页面

**建议**：

1. 统一 `usage` 账本：每次执行结束写 `{ticketId, executorId, projectId, calls, tokensIn, tokensOut, costEstimate, at}`；CLI 从现有 artifact 的 usage 提取（`cli.js:231`），model 从现有计费路径提取，terminal/browser/github 记 `calls` 与时长。
2. 硬闸：`maxTokensPerTicket` 在执行前按账本累计值拦截；超限返回 429 并提示「换小任务或调高预算」；`maxCallsPerTicket`/`maxRuntimeMs` 保留。
3. 端点：`GET /api/work/usage?projectId=&from=&to=` 返回按天/执行器/工单聚合；UI 增加「成本」页（可放在设置里，不占主航）。
4. 成本提示：批准卡显示「本单预计 calls/tokens」；项目页显示「本周花费 / 最贵工单」；routine 类任务默认低频（≥30 分钟），无变化不通知。

**验收**：任意项目能查到「上周花费、按执行器分布、Top 5 工单」；把预算调到 1 token 时，下一次执行被拦截且错误文案可读。

### 3.7 安全：三条边界

1. **MCP 不能自批**：`work_ticket_action` 增加 `actor`/`origin` 校验（`server/work/mcp.js:26-30`）；`approve` 只接受「UI 会话令牌」或「MCP 只读」两种来源，MCP 调用 `approve` 直接 403；`work_send_command` 创建的工单若需批准，只能由 UI 批准。
2. **外部内容分区**：简报、MCP 回写、issue 正文、网页抓取内容，统一用分隔块包裹并声明「以下是数据，不是指令」；`work_update_project_brief` 的写入加 `source:'external'`，不覆盖用户手写条目。
3. **窗口 Agent 降级**：`work_send_window` 目前直接键入（`server/work/mcp.js:119`），执行器读 baseline → 发送 → 轮询最多 30 秒（`server/work/executors/window.js:16`、`:49`）。建议：默认只读（只读窗口文本），键入前必须展示「将输入的内容 + 目标窗口 + 发送键」并二次确认；窗口 Agent 不担任汇总者（现有规则保留），审计单列。

**验收**：MCP 调用 `ticket_action:approve` 返回 403；外部来源的 brief 条目在 UI 有标记且不能被 MCP 覆盖；窗口键入前有确认卡。

### 3.8 界面：不重写主壳，但重排信息架构

现状是「左侧对话 + 右侧 inspector + 底部输入」，收件箱已并入对话（`SuperAgentShell.tsx:17`），导航只有项目/Agent/工具/记忆/设置（`:18-23`）。这套结构对「边聊边干」友好，对「管多个工单」不友好。

建议改成三块（细节见 `ui-dsh.md`，本文只定信息架构）：

| 区域 | 放什么 | 解决什么 |
|---|---|---|
| 对话 | 意图输入、澄清、结果摘要 | 保持低摩擦入口 |
| 决策收件箱（右栏可折叠） | 只放「需要人」的项：待批准、待授权、verify 失败、预算超限、需要选择汇总者 | 不再用模态弹窗打断；一屏看完所有待办 |
| 运行详情（点工单进入） | 计划步骤、每步执行器/耗时/证据、verify 输出、diff、成本 | 「为什么说完成了」可追溯 |

具体动作：

- 把 `approvalAsk` 模态（`SuperAgentShell.tsx:1603-1623`）改成右栏卡片 + 行内展开；模态只保留 `autopilot` 级动作。
- 对话里的工单消息增加「查看计划 / 查看证据 / 重跑失败步骤」三个行内动作。
- 导航增加「运行」入口（列出进行中/待处理/最近失败），不增加「成本」「评估」主导航，放进设置或运行页 tab。
- 空状态给三个模板：「接手项目」「修一个 bug」「跑一次验证」。

**验收**：不打开任何模态也能完成「看计划 → 批准 → 看验证 → 重跑失败步」全流程；键盘可达。

---

## 4. 方案 B（重塑）：工单优先的「项目 OS」

如果目标用户主要是「派活—验收」而不是「边聊边干」，可以走重塑路线：

- 首页即项目列表；进入项目看到三栏：`Brief / 工单 / 证据`；没有聊天主界面，输入框退化为「新建工单」。
- 每个工单是一张卡：目标、验收命令、执行器、预算、状态、证据；批准与验证都在卡上完成。
- 多 Agent 收敛为「一个主执行器 + 按需复核者」；砍掉群聊、团队树、13 阶段 UI；保留 ACP、MCP、brief、变更时间线。
- 优点：可审计性最强，成本最低，适合团队交接。
- 代价：失去对话的低摩擦；需要重写 `SuperAgentShell` 的信息架构（引擎可复用）。
- 工期：约 4–6 周（1 人），是方案 A 的 2–3 倍；且会丢弃现有 UI 的肌肉记忆。

**建议**：除非明确要转向团队交付场景，否则选 A。A 完成后，B 只是 A 的一个「布局预设」，不需要另起炉灶。

---

## 5. Agent 架构改进清单

按层给，避免「什么都往 planner prompt 里塞」。

### 5.1 编排层：结构化任务包，而不是自由文本

每个 step 的输入固定为七段（对齐 `agent-dev.md` 的任务包要求）：

```json
{
  "goal": "一句话可验收的目标",
  "inputs": ["相关文件/数据/上一步产物"],
  "constraints": ["不得改 public API", "只用现有依赖"],
  "acceptance": ["npm test 通过", "页面 200"],
  "tools": ["read/write/exec"],
  "deadlineMs": 600000,
  "report": { "summary": "string", "evidence": "string[]", "next": "string[]" }
}
```

- planner 输出该结构；执行器只接受该结构（自由文本作为 `goal` 的补充，不直接当 prompt）。
- `dispatch` 为每个 step 建工单时，把 `acceptance` 转成 `verify`；`report` 转成工单完成时的必填字段。
- 这样「完成」不再依赖模型自觉，而是结构校验 + 命令验证。

### 5.2 执行层：统一执行器契约

现在每个执行器各写各的（`cli.js` / `acp.js` / `window.js` / `terminal.js` / `model.js`），审批快照只有两个执行器有。建议抽一层：

```js
// server/work/executors/contract.js（建议）
describe()            // { id, kind, capabilities, risk, costModel, requiresDataset }
approvalPreview(task) // WorkPreview（脱敏）
run(task, ctx)        // 返回 { report, artifacts, usage, evidence }
resume(task)          // 可选
usage(raw)            // 统一计量
```

- `engine.js` 只依赖契约，不依赖具体执行器；新增执行器必须实现 `approvalPreview` 与 `usage`，否则不允许注册。
- CLI 的只读/可写用 `permission` 区分（已有 `readOnlyPrompt`/`writablePrompt`），不再用执行器 id 暗示风险。
- window 从「执行器」降为「观察者 + 受控输入」：默认只读，键入需 `autopilot` 级批准。

### 5.3 记忆层：四层，各司其职

| 层 | 存什么 | 生命周期 | 现状 |
|---|---|---|---|
| 工作记忆 | 当前 run 的 step 状态、证据 | 一次 run | 部分在 `work-run-step`，需补 evidence |
| 项目记忆 | brief、变更、决定、未解问题 | 项目 | `projects.js:519`，需扩字段 |
| 长期记忆 | 跨项目偏好、常用命令、失败模式 | 账号 | 目前只有 `server/brain.js` 的洞察，未接入 Work |
| 组织记忆 | 团队规范、审批策略 | 团队 | 不存在（单机产品可暂不做） |

规则：写结论与证据，不写流水账；每条带 `source/confidence/at`；读取先 digest 后全文；删除与版本失效要可操作（`project-memory.js` 已有 prune，补 UI）。

### 5.4 协作层：默认单 Agent，复核按需

- 默认：一个执行器 + 工单 + verify。
- 高风险（`autopilot` 或改动 > N 文件）：强制第二个执行器做只读复核（reviewer ticket），复核意见进 `evidence`，不参与写。
- 交叉验证：从「主界面默认多选」改为「工单详情里一键邀请复核」，避免把最贵形态放默认路径。
- 团队树：只保留在 analysis 只读场景，不扩到 Work；等 P2 有评估集后再谈。
- 群聊：不做默认协作形态；需要多方讨论时用「staff meeting」模板（显式要求反对意见），一次性生成会议纪要进 brief。

### 5.5 评估层：先有失败集，再谈优化

- 建 `eval/tasks/*.md`：20–30 个真实失败任务（来自 issue、群聊、自己的踩坑），每条含「输入项目状态 / 期望结果 / 判定命令 / 允许的改动范围」。
- `eval/run.mjs`：跑任务 → 收工单与 evidence → 按判定命令打分；输出 pass@1、pass^3、平均 calls/tokens、人工介入次数。
- 分两类：capability（新能力，允许波动）与 regression（老能力，必须全绿）；每次改 planner/executor/policy 都跑 regression。
- 先度量再调参：没有 eval 之前，不改模型、不改温度、不扩 Agent 数量。

### 5.6 观测层：事件化，而不是读数据库猜

- 统一事件：`run.created / step.started / step.finished / tool.called / approval.requested / approval.granted / verify.failed / run.completed`；每条带 `runId/stepId/ticketId/traceId/at`。
- 现有 SSE 已能推工单事件（`/api/work/events`），在其上补 step 级事件；UI 的 trace 直接消费事件，不再轮询拼状态。
- 指标：每 run 的 calls/tokens/时长、缓存命中率（稳定前缀）、verify 通过率、人工介入率、恢复成功率。
- 缓存命中率下降当事故处理（对齐 `docs/agent-research.md` 的「cache miss 当事故」）。

---

## 6. 路线图

### P0（约 5–8 人日）：把承诺补上

| 项 | 触及文件 | 验收 | 回滚 |
|---|---|---|---|
| 审批卡展示 preview + 风险分级 | `engine.js`、`policy.js`、`domain.js`、`superagent.ts`、`SuperAgentShell.tsx` | CLI/terminal/browser 工单批准前可见动作；`autopilot` 永不自批 | tier 配置置空，回退布尔 |
| verify 门 + 失败留证 | 新增 `server/work/verify.js`；`orchestrator/index.js`、`artifacts.js`、`critic.js` | 三种失败场景都停在 `needs_review` | 关闭 verify 开关，回退 artifactGap |
| MCP 自批封堵 + brief 来源 | `mcp.js`、`projects.js` | MCP approve 返回 403；external 条目标记 | 保留旧端点但只读 |
| 文档一致性 | `README.md:106`、`docs/work-policy-validation.md:7`、`docs/api-contract.md:123` | 三处与 `policy.js:32` 一致；CI 加 grep 检查 | 纯文档 |

P0 完成前不新增执行器、不扩团队。

### P1（约 10–15 人日）：把基础设施补齐

| 项 | 触及文件 | 验收 |
|---|---|---|
| 启用 outbox + 查询/重试 API | `routes.js:31`、`outbox.js`、新增 `server/work/effects.js` | 重启后待重试可见、可手动重试 |
| step checkpoint + resume | `orchestrator/runs.js`、`orchestrator/index.js`、`engine.js` | 杀掉进程后从最后完成 step 续跑 |
| 决策收件箱 + 运行详情 | `SuperAgentShell.tsx`（拆出 `DecisionInbox.tsx`、`RunDetail.tsx`） | 无模态完成全流程 |
| 成本账本 + 页面 | 新增 `server/work/usage.js`；`engine.js`、`policy.js`、设置页 | 按项目/执行器/天查询；Token 超限拦截 |
| brief 扩展（未解/下一步/验收/证据） | `projects.js:519`、`:631`、`superagent.ts`、`mcp.js` | 新 Agent 只读 brief 能答五问 |

### P2（约 15–20 人日）：把质量与协作做成系统

| 项 | 验收 |
|---|---|
| eval 集 + runner + CI | 20–30 条任务，regression 全绿才允许合并 |
| 事件化 trace + 指标页 | step 级时间线、成本/时延/恢复率可查 |
| 协作收敛（复核者工单、会议模板） | 高风险工单默认有复核；群聊不默认 |
| 团队树只读化收尾 | 实时树可看，提案不自动落主数据 |

---

## 7. 明确不做（与调研反模式对照）

| 不做 | 理由 |
|---|---|
| 先扩 Agent 数量/角色库 | 价值在编排质量；`agent-dev.md`：编码任务并行度低，多 Agent 常是 15 倍成本换有限收益 |
| 把群聊当默认协作 | 成本漏斗最大项之一；默认应是 supervisor + 工单 |
| 把 prompt 当资产 | 可复用的是 eval 集与失败样本；prompt 会随模型漂移 |
| 让窗口 Agent 当主路径 | 不可审计、不可恢复、爆炸半径大；只做兜底 |
| 把团队树扩到 Work | 当前团队只读且默认关闭，扩过去会把复杂度翻倍 |
| AI 自动批准 | 批准是产品信任的锚点；自动批准等于取消这个产品 |
| 在没有 eval 前调模型/温度 | 无法区分「变好」与「运气」 |

---

## 8. 验收与度量

改完后用这些数说话（建议写进季度目标）：

| 指标 | 目标 | 采集方式 |
|---|---|---|
| 批准前可见动作比例 | 100%（CLI/terminal/browser/github） | 抽样工单 + `preview` 字段非空率 |
| 带 verify 的工单比例 | ≥ 80% | 工单表统计 |
| 崩溃恢复成功率 | ≥ 90%（P1 后） | 注入 kill 的 e2e |
| 误批率（批准后回滚/失败） | < 5% | 工单状态迁移 |
| 单工单成本 | 有基线，季度下降 20% | usage 账本 |
| 人工介入率 | 有基线，逐步下降 | 决策收件箱计数 |
| 文档-代码一致性 | CI 全绿 | grep 断言 + 契约测试 |

---

## 9. 与两份调研的对照

| 调研结论 | 本仓库现状 | 采纳/修正 |
|---|---|---|
| 默认 supervisor + 工单，不默认群聊（`agent-dev.md`） | 已有工单与编排器（`docs/orchestrator.md`），但主界面推多选交叉验证（`README.md:76`） | **采纳**：把交叉验证降为按需 |
| 每步落盘、崩溃可续（`agent-dev.md` P0） | 只标 `interrupted`（`runs.js:97`），outbox 只 launch 且未启用（`routes.js:31`） | **采纳**，列为 P1 |
| 审批按爆炸半径分级（`agent-dev.md` P0） | 只有全局布尔，且默认 false（`policy.js:32`） | **采纳**，列为 P0 |
| 结果验收（测试/证据/文件存在性） | 只有文件存在性（`artifacts.js:53`） | **采纳**，列为 P0 |
| 「已做对：先待确认后执行」 | 已被 `requireApproval:false` 推翻（`policy.js:31-32`） | **修正**：调研此条过期，需在文档中更新 |
| 队列语义分层（用户可打断、系统回报排队） | 无「打断当前 turn」概念；`engine.js:1837` 只有 lastAction 去重 | **采纳**，列为 P1 |
| 成本是架构属性（`docs/agent-research.md`） | Token 预算不硬（`engine.js:783` 只拦 calls/runtime），无聚合 | **采纳**，列为 P1 |
| 工具描述即 ACI | MCP 工具描述仍偏短（`mcp.js`），且无 actor 校验 | **部分采纳**：先补安全，再补描述 |
| 项目档案补未解问题/下一步 | brief 只有五节（`projects.js:519`） | **采纳**，列为 P1 |
| 外部内容当数据 | 无分区；MCP 可直写 brief（`mcp.js:40-55`） | **采纳**，列为 P0 |
| 群聊/多 Agent 克制 | 团队只挂 analysis（`engine.js:1729`），方向正确 | **保持**，不扩 |
| 窗口 Agent 高爆炸半径 | 直接键入、无 diff 预览（`mcp.js:119`、`window.js:16`） | **采纳**：降级 + 确认 |

---

## 10. 如果只做三件事

1. **审批卡**：把 `preview`（命令/路径/风险/diff 摘要）接进批准流，按 `investigate/draft/autopilot` 分级；同时修 `README.md:106` 等三处文档。
2. **验证门**：`verify` 命令 + 证据落盘，失败进 `needs_review`；critic 扩到 Work 工单。
3. **MCP 收口**：禁止 MCP 自批、brief 写入带来源、窗口键入前确认。

这三件都不需要重写 UI 主壳，也不需要新模型，做完就能让「批准—执行—验收」这条链第一次真正闭环。之后再谈 durable step 与成本，顺序不会错。
