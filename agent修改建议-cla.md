# Agent 修改建议（cla）

> 日期：2026-11-11
> 依据：`agent-dev.md`（Agent 开发知识要点）、`docs/agent-research.md`（GrokBot 类团队型 Agent 调研）、`ui.md`（界面建议），以及当前代码、README、`docs/orchestrator.md` 与相关验证记录。
> 结论：建议做**渐进重塑**——保留执行器适配、项目档案、审批与桌面壳，统一「任务内核 + 对象模型 + 事件流」；把数据分析降为一个垂直能力，把无入口的 teamwork 遗留代码移出主仓库或改为示例。不建议现在推倒重写，也不建议继续在多套编排上叠加功能。

---

## 0. 一页结论

### 推荐定位

> **Lagent = 本地多 Agent 的项目指挥部。**
> 它不生产模型，也不只是一层 CLI 启动器；它提供**任务契约、执行审计、项目记忆和风险审批**，让任意本机 Agent 可以被编排、被替换、被接手。

一句话卖点：

> 不用记每个 Agent 怎么用。把项目交给 Lagent，任意 Agent 都能接着干。

### 三个判断

1. **产品身份已经漂移**：对外是「多 Agent 指挥台」，实际代码里还并列着数据分析工作台、深度编排器、分析子智能体团队，以及一段没有前端入口、硬编码的 teamwork 遗留代码。三套活跃编排 + 一套遗留、两个产品面，用户看到的是一个，维护者要维护四个。
2. **真正的护城河不是「能启动 Claude Code / Codex」**：这是商品能力，厂商自己会做。护城河是**跨厂商的任务契约 + 项目记忆 + 审批审计 + 验收证据**，以及任何 Agent 只读一处就能接手的项目档案。
3. **最成熟的资产在分析侧，最弱的基础在指挥侧**：分析工作流已经有阶段合同、证据引用、独立审查、质量回执、恢复与产物生命周期；指挥台还停留在「工单 + 一次性 CLI 进程 + 摘要」。应该把分析侧的合同/证据机制**上提为通用内核**，而不是把分析当历史包袱。

### 五个改造

1. **统一对象模型**：Project → Task → Run → Step → Artifact；Approval / Memory / Event 横切。把 ticket、plan、orchestrator run、teamwork 全部映射进来。
2. **统一执行内核**：一个持久化运行引擎，负责队列、幂等、步骤落盘、心跳、超时、断点续跑、取消与恢复；替换现有的「启动即忘」。
3. **统一契约与验收**：每个任务有结构化契约（目标/输入/约束/验收/工具/预算/截止/回报），每个「完成」必须有证据；把分析侧的 evidence refs、critic、quality receipts 泛化。
4. **统一团队与审批**：Agent 档案（能力/权限/成本/可靠性）+ 项目团队模板；审批按爆炸半径分级，支持批量、会话内记住、拒绝理由。
5. **统一界面与事件**：指挥台/项目/团队三个主界面；运行详情按「任务 → 运行 → 步骤」展开；SSE 推增量事件而不是每次全量 bootstrap。

### 三个不做

- 不做**万能聊天框**，也不做**工作流画布**作为主界面。
- 不默认**群聊式多 Agent**；默认委派 + 工单，高风险才交叉验证。
- 不在可靠性补齐前继续**扩执行器数量**、扩 bot 市场、扩分析模板。

### 如果只能做三件事

1. **给每个「完成」加验收证据**：先把「Agent 说完成」变成「有测试/文件/diff/引用才算完成」。
2. **把工单/计划/编排收敛成一个 run kernel**：至少做到步骤落盘、心跳、失败可定位、能续跑。
3. **把项目档案做成真正的交接面**：简报补「未解问题 / 下一步」，记忆可按任务检索，换 Agent 不用重述背景。

这三件事做完，产品就会从「会派单的壳」变成「可托付的指挥台」；其余改造都可以在此之上迭代。

### 预期收益

- 用户从「发出任务后盯着看」变成「发任务、看证据、批异常」。
- 同一项目换 Agent 不用重新交代背景；新 Agent 读项目档案即可接手。
- 失败可定位到步骤，可重试/跳过/换人，而不是整单重来。
- 每个任务的时间、token、费用、审批、产物可审计。
- 维护者只维护一套内核，垂直能力以插件/模板接入。

---

## 1. 现状：它现在是什么

### 1.1 对外定位

README 的定位是准确的：

> 面向个人与小团队的**多 Agent 指挥台**：连接 Claude Code、Codex、DeepSeek Harness 等本机 Agent，接收一个项目和任务后拆解成步骤，把任务要点分派给不同 Agent 执行，并把每次修改沉淀为项目档案，让任何 Agent 只读这一处就能了解「项目改了什么、接下来做什么」。

这个定位有三个关键词：**多 Agent、项目、指挥**。问题不在文案，而在代码与界面是否只服务这三件事。

### 1.2 实际功能地图

| 能力 | 入口 | 实际实现 | 与定位的关系 |
| --- | --- | --- | --- |
| 指挥台 | 首页 / 对话 | `work/engine.js` 工单 + 计划；多 Agent 交叉验证；窗口/终端/浏览器/GitHub | 核心 |
| 项目工作区 | 项目页 | 导入目录、接管 Claude/Codex 会话、项目对话、项目简报、变更时间线、记忆 | 核心 |
| 深度编排 | 会话里的「深度编排」开关 | `work/orchestrator/*`（Mastra）四套模板、审批、文件存在性校验、返工、黑板 | 与「计划」重叠 |
| 分析子智能体团队 | 分析阶段设置 | `team-runtime.js` + `subagents.js`，最多 3 层/12 节点 | 仅分析侧，和指挥台团队不通用 |
| 数据分析工作流 | 隐藏的旧界面 | `workflow.js` / `multi-workflow.js` 13 阶段、合同、证据、审查、PDF | 独立产品面 |
| teamwork 遗留 | 仅 API/状态（前端无可见入口） | `work/teamwork.js` 固定 rules/view/hud 三份文件 + 组装 | 遗留代码，不在主路径 |
| 手机指挥 | `/m` | 配对、收件箱、审批、任务 | 核心的远程延伸 |
| 云端账号 | 云端服务 | 多账号隔离、凭据库、分享 | 分发与远程 |

### 1.3 架构现状：三套活跃编排 + 一套遗留，两个产品面

```
                        ┌────────────── 前端 SuperAgentShell ──────────────┐
                        │ 首页/对话   项目页   分析页(隐藏)   设置/Agent/工具  │
                        └───────────────┬──────────────────┬────────────────┘
                                        │                  │
                      ┌─────────────────▼──┐        ┌──────▼──────────────────┐
                      │ 指挥台 work/*       │        │ 分析 workflow/*          │
                      │ engine.js           │        │ multi-workflow.js       │
                      │  ├─ ticket 工单      │        │  ├─ 13 阶段              │
                      │  ├─ plan 计划        │        │  ├─ stage-contracts 合同  │
                      │  ├─ outbox（未启用） │        │  ├─ evidence refs 证据    │
                      │  └─ project-memory  │        │  ├─ critic 独立审查       │
                      │ orchestrator/*      │        │  └─ quality receipts     │
                      │  └─ Mastra 深度编排  │        │                          │
                      │ teamwork.js（遗留）  │        │ team-runtime.js          │
                      │  └─ 固定小游戏组装   │        │  └─ 分析子智能体团队      │
                      └────────────────────┘        └──────────────────────────┘
```

编排职责重叠：

| 编排 | 入口 | 状态机 | 步骤依赖 | 审批 | 验证/返工 | 持久化 |
| --- | --- | --- | --- | --- | --- | --- |
| 工单 | 首页/对话 | queued/working/waiting/awaiting_review/blocked/failed/completed/cancelled | 无（单步） | 有 | 无 | 工单 + assignment + report |
| 计划 | 多步计划 | 由工单状态推导 | 有（最多 3 依赖） | 有 | 无 | plan + ticket |
| 深度编排 | 会话开关 | drafting/awaiting_approval/running/verifying/repairing/completed | 模板步骤 | 有 | 有（仅检查文本点名文件是否存在，最多 2 轮） | Mastra SQLite + run |
| 分析团队 | 分析阶段 | 节点 pending/running/completed/failed/accepted/blocked/cancelled | 有（最多 3 依赖） | 提案审批 | 父节点验收 | task artifacts |
| teamwork（遗留） | 仅 API/状态 | 由工单推导 + 组装 | 固定三部分 | 有 | 文件存在性检查 | teamwork 记录 |

结果：

- 同一个「拆任务、派人、等结果、验收」的逻辑至少写了四遍（其中一套已是遗留），行为不一致。
- 前端需要同时理解 ticket、plan、run、teamwork、task 五种对象。
- 用户不知道「多步计划」「深度编排」「协作」有什么区别，也不知道该用哪个。
- 任何底层改造（断点续跑、成本、审计）都要改四处。

### 1.4 真正的优势（不要丢）

1. **跨厂商执行器适配**：Claude Code、Codex、DSH、ACP、OpenCode、Gemini、Qwen、Cursor、窗口 Agent、终端、浏览器、GitHub。这是很多单厂商产品没有的。
2. **项目档案 + MCP**：项目简报、变更时间线、项目记忆，且外部 Agent 可通过 MCP 读写。这是「任何 Agent 都能接手」的基础。
3. **审批与策略**：read/workspace/full 三档、额外目录、危险确认、并发/调用/时长/token 预算、审计。注意：默认 `requireApproval:false`，直发任务会直接执行；叙事与默认值需要对齐。
4. **本地优先 + 桌面/移动**：本机执行、云端账号、手机审批，适合个人与小团队。
5. **分析侧的合同/证据机制**：阶段合同、证据引用、独立审查、质量回执、产物生命周期、恢复复用。这套东西比指挥台成熟得多，应该复用而不是丢弃。

### 1.5 结构性问题

| 问题 | 证据 | 后果 |
| --- | --- | --- |
| 产品身份漂移 | 隐藏的分析页、无入口的 teamwork 遗留代码、多套编排 | 新用户不知道产品到底是什么； roadmap 被旧能力拖住 |
| 对象模型不统一 | ticket / plan / run / assignment / report / teamwork / task | 前端与 API 复杂；跨对象查询困难；迁移成本高 |
| 执行不可恢复 | CLI 执行器是一次性进程；只有计划重启后继续推进，没有步骤级检查点 | 长任务崩溃即丢；用户不敢离开 |
| 完成没有验收 | 工单完成只记 summary；深度编排只检查目标文本点名的文件是否存在，不跑测试/构建 | 假完成、返工、信任流失 |
| 团队能力只服务分析 | `team-runtime` 只接受 analysis 执行器 | 指挥台没有真正的 roster/角色/团队模板 |
| 审批没有风险分级 | 统一 review 文案；审批卡只有标题/问题，没有命令/路径/diff；访问请求单独弹窗 | 审批疲劳；用户无法判断将执行什么，只能盲批 |
| 默认策略与叙事不一致 | `policy.js` 默认 `requireApproval:false`，直发任务直接执行；只有显式开启才先批准 | 用户以为「先确认再执行」，实际直接开跑 |
| MCP 可自批/直写 | `mcp.js` 暴露 `work_ticket_action`（含 approve）与 `work_update_project_brief` | 外部 Agent 可批准自己发起的动作、改写项目档案 |
| 事件流粒度粗 | SSE 存在，但每条消息都触发全量 `bootstrap` | 长任务抖动、流量浪费、滚动被抢 |
| 记忆没有分层检索 | 项目简报 + 变更 + 项目记忆 + 聊天记录四份 | 上下文要么不足，要么污染；新 Agent 仍要重读 |
| 缺乏评估 | 有测试，但没有任务级 eval | 改 prompt/路由/模型无法判断变好还是变坏 |
| 成本不可见 | 有 token 预算，但没有按任务/步骤/Agent 的成本账 | 钱漏在 routine、群聊、长任务 |

---

## 2. 和研究结论对照

### 2.1 已经做对的（保持）

| 现状 | 对应研究结论 |
| --- | --- |
| 工单可落「待确认」、批准后执行，带步骤标识防误批（需开启 `requireApproval`；默认策略见下方缺口） | 不可逆动作先草稿、再批准；幂等键防重复 |
| 执行器显式开启 + 策略勾选 | 能力层最小权限、按爆炸半径授权 |
| 项目档案 + 变更时间线 + MCP 可读 | structured note-taking：给下一个 Agent 一份可读的 `NOTES.md` |
| 多 Agent 交叉验证 + 汇总 | parallelization 的 voting 模式 |
| ACP 只读 v1 | 自主度阶梯的 Investigate 档 |
| 窗口 Agent 拒绝不在会话页/有草稿的发送 | 失败显式、不静默降级 |
| 并发、调用数、时长、token 预算 | 资源上限与停止条件 |

### 2.2 关键缺口

| 研究结论 | 现状 | 后果 | 优先级 |
| --- | --- | --- | --- |
| **durable step / 断点续跑**：每个模型/工具调用都是 durable step，崩溃后从最后一个完成点续跑（`docs/agent-research.md` §2.1） | 工单是一次性 CLI 进程；只有计划在重启后继续推进；没有步骤级检查点 | 长任务崩溃即丢，用户不敢离开 | P0 |
| **任务包结构化**：objective/output/inputs/constraints/acceptance/tools/budget/deadline/report（`agent-dev.md` §3.9） | 计划步骤只有 text + executorId + dependsOn；验收靠文件存在检查或人看 | 交接丢失、重复劳动、结果不可判 | P0 |
| **完成 = 证据**：测试、文件、命令、diff、引用（`agent-dev.md` §6） | 工单完成只记 summary；分析侧有证据引用，指挥侧没有；编排器只查目标文本点名的文件是否存在 | 假完成、返工、信任流失 | P0 |
| **默认 supervisor + 工单，不默认群聊**（`agent-dev.md` §3.7/§3.13） | 有交叉验证与深度编排，但没有统一 supervisor；团队能力只在分析侧 | 用户不知道何时该用哪种协作；成本不可控 | P0 |
| **审批按爆炸半径分级**（`docs/agent-research.md` §8.2） | 三档权限 + 统一 review 文案；没有按动作类型的 allow/ask/block | 审批疲劳或误批 | P0 |
| **稳定的 roster / 一 Agent 一职责**（`docs/agent-research.md` §3.3/§3.4） | Agent 页是「探测到的程序列表」，不是角色/能力/成本/可靠性档案 | 路由只能按静态能力表，不能按历史表现 | P1 |
| **上下文工程**：最小高信号、压缩、笔记、子 Agent（`agent-dev.md` §4） | 项目简报 + 记忆 + 变更注入，但没有 context budget、manifest、压缩策略 | 上下文污染或不足；新 Agent 仍要重读 | P1 |
| **评估 20–50 个真实任务**（`agent-dev.md` §6.4） | 只有单元/集成测试，没有任务级 eval | 改动无法判断好坏 | P1 |
| **成本是架构属性**：按任务/Agent/routine 审计（`agent-dev.md` §8） | 有预算，没有成本账与告警 | 钱漏在长任务、交叉验证、routine | P1 |
| **安全：lethal trifecta + 沙箱 + 审计**（`docs/agent-research.md` §7） | 有策略/审计/凭据库；但 AI 输出与外部内容边界、命令风险分类、窗口 Agent 审计仍弱 | 注入、越权、误操作 | P1 |
| **可观测：Thread → Trace → Run 三层**（`ui.md` §2.1） | 有工单事件与审计，但没有统一 trace/步骤 span/成本 | 长任务难定位、难优化 | P2 |
| **产品聚焦**：一个主形态，垂直能力插件化 | 两个产品面 + 多套编排 | 维护成本高、定位模糊 | P0 |

### 2.3 定位风险

1. **变成薄启动器**：如果核心只是「把命令发给 Claude Code / Codex」，厂商自己的 Agent 视图、后台任务、审批会覆盖它。必须把价值放在**跨厂商契约、项目记忆、验收审计**上。
2. **被旧能力拖住**：数据分析与无入口的 teamwork 遗留代码占用界面/文档/测试注意力，但不在「多 Agent 指挥台」的主航道上。
3. **规模扩张先于可靠性**：执行器从 3 个扩到 15 个，但长任务恢复、验收、成本、权限没有跟上；每多一个执行器就多一份不可控。
4. **演示驱动**：交叉验证演示很亮眼，但没有 eval 与验收，无法证明真实任务变好。
5. **信任事故**：窗口 Agent 直接键入、命令无风险分类、项目档案可被 MCP 回写；一次误操作就会摧毁信任。

---

## 3. 目标定位与产品形态

### 3.1 一句话定位

> **给个人和小团队的本地 Agent 指挥台：把项目交给它，任意 Agent 都能接着干。**

三层价值，从外到内：

1. **指挥**：一个目标 → 拆解 → 分派给最合适的本机 Agent → 看进度 → 审批 → 验收。
2. **记忆**：项目档案 + 决策 + 未解问题 + 变更，任何 Agent 只读一处就能接手。
3. **治理**：权限、预算、审计、可回滚；知道谁在什么时候改了什么。

### 3.2 三个主界面

| 界面 | 回答的问题 | 核心内容 |
| --- | --- | --- |
| **指挥台** | 「现在有什么在跑？需要我做什么？」 | 任务列表、运行详情、待审批、最近结果、发起新任务 |
| **项目** | 「这个项目现在是什么状态？谁改了什么？」 | 简报、记忆、变更时间线、产物、团队、会话 |
| **团队** | 「我有哪些 Agent？它们能做什么？谁可靠？」 | Agent 档案、角色模板、能力/权限/成本/成功率、健康状态 |

设置、工具、记忆管理收进「更多/设置」，不再和三个主界面并列。

### 3.3 核心对象模型

```
Project
 ├─ Task（一个目标）
 │   ├─ Contract（目标/输入/约束/验收/工具/预算/截止/回报）
 │   ├─ Run（一次尝试；可有多次）
 │   │   ├─ Step（一步；角色/执行器/契约/依赖/状态）
 │   │   │   ├─ Execution（执行实例：session/pid/心跳/日志）
 │   │   │   └─ Artifact（文件/diff/日志/报告/截图/引用）
 │   │   └─ Approval（风险/动作/范围/决定/理由）
 │   └─ Event（append-only，按 run 递增 seq）
 ├─ Brief（目标/进展/决定/约束/未解问题/下一步）
 ├─ Memory（change/note，来源/置信度/时间/标签）
 └─ Team（项目级 Agent 名单与角色）
```

映射现有对象：

| 现有 | 目标 | 处理 |
| --- | --- | --- |
| ticket | Step | 保留 ID 与状态，增加 `runId`、`contract`、`acceptance` |
| plan | Run + Steps | planId 作为 runId 的兼容别名 |
| orchestrator run | Run | 合并进同一 run 表；模板作为 `run.template` |
| teamwork | Run（模板 `teamwork`） | 通用化或移出主路径 |
| assignment | Execution | 保留，增加 heartbeat/checkpoint |
| report | Artifact | 保留 kind，增加 evidence/acceptance |
| project-brief | Brief | 增加 openQuestions/nextSteps |
| project-memory | Memory | 增加 scope/confidence/tags/retrieval |

### 3.4 与竞品的差异

- 对比 **Claude Code / Codex 自带 Agent 视图**：Lagent 跨厂商、跨会话、项目级记忆、统一审批。
- 对比 **OpenHands / Cline / Cursor**：它们绑定自己的 Agent/IDE；Lagent 是「Bring your own agent」的指挥层。
- 对比 **Dify / n8n**：Lagent 不是工作流画布，而是任务指挥与项目记忆；不要求用户先搭图。
- 对比 **Vibe Kanban**：Lagent 不止看板，还有审批、验收、项目档案、MCP 互操作。

一句话：**别人做 Agent，Lagent 做 Agent 之间的工作交接与治理。**

### 3.5 三条路线与取舍

| 路线 | 形态 | 优势 | 为什么不选/何时选 |
| --- | --- | --- | --- |
| **A. Agent 指挥台**（推荐） | 任务 + 运行 + 审批 + 项目记忆 | 贴合现有执行器/项目档案/审批资产；个人与小团队刚需；跨厂商差异明显 | 需要补齐可靠性与验收；增长天花板取决于用户是否同时用多个 Agent |
| **B. Agent 工作流平台** | 画布 + 节点 + 发布 | 可视化、易演示、企业采购熟悉 | 与 Dify/n8n/Flowise 正面竞争；会丢掉「指挥台」的轻量与跨厂商优势；用户要先学搭图 |
| **C. Agent 团队市场** | 角色/bot 市场 + 订阅 | 生态故事好、可抽成 | 需要生态、审核、计费、安全；在可靠性与评估没做好前是空中楼阁 |
| **D. 数据分析工作台** | 上传数据 → 报告 | 已有成熟实现与证据机制 | 赛道拥挤、模型厂商向下覆盖；不是「多 Agent」的差异点；保留为垂直能力即可 |

选择 A 不代表永远不做 B/C：先把 A 的「任务契约 + 验收 + 记忆」做扎实，B 可以作为团队模板的可视化编辑，C 可以作为模板分享，而不是另起一套产品。

### 3.6 用户旅程

1. **接入**：打开桌面端，探测本机 Agent，勾选可用执行器；导入一个项目文件夹。
2. **发起**：描述目标，选择「单 Agent / 计划 / 交叉验证 / 团队模板」；看到初步拆解与预算。
3. **批准**：高风险步骤出现审批卡，展示命令/路径/影响；低风险自动放行。
4. **执行**：运行详情显示步骤、当前动作、最后活动时间、成本；可停止/重试/跳过。
5. **验收**：完成必须附证据（测试/文件/diff/引用）；不通过进入返工或人工。
6. **沉淀**：项目简报与记忆自动更新（决定、变更、未解问题、下一步）。
7. **接手**：换一个 Agent 或隔天回来，读项目档案即可继续；不需要重述背景。

---

## 4. 目标 Agent 架构

### 4.1 总览

```
┌────────────────────────────────────────────────────────────────────┐
│ 界面：指挥台 / 项目 / 团队                                          │
│  - 任务列表、运行详情、审批收件箱、项目档案、Agent 档案             │
└───────────────┬────────────────────────────────────────────────────┘
                │ SSE 增量事件（run/step/approval/artifact）
┌───────────────▼────────────────────────────────────────────────────┐
│ 运行内核 Run Kernel                                                │
│  - 队列 / 调度 / 幂等 / 预算 / 取消 / 心跳 / 检查点 / 恢复          │
│  - 事件日志（append-only，seq） / 投影（列表、详情、成本）           │
└───────┬──────────────────────────────┬─────────────────────────────┘
        │                              │
┌───────▼────────────┐        ┌────────▼────────────────────────────┐
│ 编排层              │        │ 执行层                               │
│ Planner             │        │ Executor Adapters                    │
│ Router              │        │  - Claude Code / Codex / ACP / CLI   │
│ Supervisor          │        │  - 内置模型 / 分析 / 终端 / 浏览器     │
│ Verifier            │        │  - 窗口 Agent / GitHub               │
│ Team Templates      │        │ 统一接口：start/progress/stop/resume  │
└───────┬─────────────┘        └────────┬────────────────────────────┘
        │                              │
┌───────▼──────────────────────────────▼─────────────────────────────┐
│ 横切能力                                                           │
│ Contract / Acceptance / Approval-Risk / Memory / Context / Audit   │
│ Cost / Eval / Security / MCP                                       │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 执行内核

目标：把「启动即忘」改成「可恢复、可审计、可取消」。

**必须有的能力**

1. **Run / Step 持久化**：每个 step 在启动前写入 `started` 事件与幂等键；执行器回报 `progress`；结束时写 `completed/failed/cancelled` 与产物引用。
2. **心跳与超时**：执行器每 N 秒心跳；超过阈值标记 `stalled`；区分「在跑」与「卡死」。
3. **断点续跑**：
   - 有 sessionId 的 CLI：用 `--resume` 续接；
   - 无 sessionId：重试 step（有界），不重做已验收的前置步骤；
   - 内置模型/分析：复用已完成且语义指纹一致的前缀（分析侧已有 `artifact-lifecycle` 可借鉴）。
4. **幂等副作用**：启动、写文件、发通知、写记忆、开 PR 都要有幂等键；重试不重复。
5. **队列与调度**：
   - 优先级：用户交互 > 系统回报 > routine；
   - 并发：按项目/执行器/全局三层预算；
   - 公平：同一项目不饿死其他项目；
   - 合并：短时间连续消息合并成一个 turn（研究建议）。
6. **取消语义**：区分「可中断」与「不可中断」；取消后写清楚哪些步骤已产生副作用。
7. **恢复策略**：重启时扫描 `running/stalled`，标记孤儿；由人决定续跑/重跑/放弃，不自动重复收费调用。

**实现建议**

- 现有 `store` 是 JSON/SQLite 抽象，继续用；新增 `work-run`、`work-step`、`work-event` 表，事件按 run 递增 `seq`。
- 现有 `outbox` 只负责 launch，且默认未启用；扩展为 `work-queue`，承载 launch/resume/notify/memory-write 等副作用。
- 现有 `work-event` 保留（每 ticket 500 条、总 5000 条），升级为事件日志 + 投影，不要只做通知。
- 不要急着引入 Temporal；当前规模用 SQLite + 事件日志足够。等并发/跨机需求出现再换。

### 4.3 编排层

**四个角色，职责单一**

| 角色 | 做什么 | 不做什么 |
| --- | --- | --- |
| **Planner** | 目标 → 契约 → 2–5 步；标注依赖/范围/验收 | 不执行工具、不写文件 |
| **Router** | 按能力/权限/成本/健康/历史表现选执行器；解释理由 | 不改变任务目标 |
| **Supervisor** | 持有 run；决定下一步；处理交接/失败/返工 | 不直接调用工具 |
| **Verifier** | 先跑确定性检查，再做模型评审；产出验收记录 | 不修改产物 |

**四种协作模式，明确入口**

| 模式 | 何时用 | 行为 |
| --- | --- | --- |
| **单 Agent 委派**（默认） | 大多数任务 | 一个 Agent 执行，Supervisor 验收 |
| **计划分派** | 任务可拆成 2–5 步 | Planner 拆步，不同执行器按依赖顺序执行 |
| **交叉验证** | 结论不确定、高风险 | N 个 Agent 独立作答，比较一致点/分歧点，再汇总 |
| **团队模板** | 需要固定角色分工 | 文件所有权 + 接口契约 + 组装/验收（如前端/后端/测试） |

不建议把「群聊」做成默认模式：研究里群聊成本高、容易抢话、同质化投票不可靠（`agent-dev.md` §3.7/§3.8）。

**交接契约**

每次 step 完成或交接，写入固定结构：

```
Handoff {
  taskId, runId, stepId,
  status: completed | failed | blocked,
  summary,            // 做了什么
  artifacts: [...],   // 文件/diff/日志/报告
  evidence: [...],    // 命令/测试/引用/截图
  decisions: [...],   // 关键决定
  openQuestions: [...],
  nextSteps: [...],
  budgetUsed: { tokens, cost, wallMs }
}
```

这个结构同时用于：下一步的提示词、项目记忆、MCP 读取、UI 详情。

### 4.4 团队与角色

**Agent 档案（Roster）**

当前 Agent 页只有「探测到的程序 + 开关」。建议增加持久档案：

| 字段 | 用途 |
| --- | --- |
| id / name / kind | 标识 |
| capabilities | reads/writes/commands/browser/github/summarize/parallelSafe |
| permissions | 当前策略下的读写/命令/网络边界 |
| costProfile | 计价方式、平均 token、平均时长 |
| reliability | 最近 N 次成功率、返工率、失败类型 |
| bestFor | 适合的任务类型（从历史统计） |
| health | 可用/需登录/需安装/版本 |
| lastUsedAt | 最近使用 |

路由不再只看静态能力表，而是「能力硬过滤 + 权限 + 成本 + 健康 + 历史表现」打分。用户在界面上能看到「为什么选它」。

**项目团队模板**

允许项目保存一份团队配置：

```json
{
  "name": "默认开发团队",
  "roles": [
    {"role": "调研", "agent": "claude-code", "permissions": "read"},
    {"role": "实现", "agent": "codex", "permissions": "workspace"},
    {"role": "验证", "agent": "claude-code", "permissions": "read"}
  ],
  "defaultMode": "plan"
}
```

模板不是新的编排器，只是 Router 的偏好与权限预设。

**团队协作的硬约束**

- 文件所有权：每个写步骤声明 `scope`（目录/文件前缀），重叠时串行或拆分。
- 接口契约：跨文件/跨 Agent 的接口先写契约，再各自实现（参考 `teamwork.js` 的 WORLD_SHAPE 思路，但通用化）。
- 组装与验收：软件负责骨架、接口校验、组装和验收，Agent 只填自己那份。
- 返工上限：同一失败最多 2 轮；连续两轮结论一致即停，不重复烧钱。

### 4.5 记忆与上下文

**四层记忆**

| 层 | 内容 | 存储 | 写入 |
| --- | --- | --- | --- |
| 工作记忆 | 当前 run 的上下文、工具输出 | 内存/临时 | 执行器 |
| 项目记忆 | 目标、进展、决定、约束、未解问题、下一步 | `project-brief` + `project-memory` | Agent + 人 |
| 长期记忆 | 用户偏好、术语、稳定事实 | 记忆库 | 人确认 |
| 组织记忆 | 团队规范、模板、角色表 | 文档/配置 | 人 |

**建议改动**

1. 项目简报增加 `openQuestions` 与 `nextSteps` 两个字段（当前只有目标/进展/要点/决定/约束）。研究明确指出这两项是交接时最贵的上下文（`docs/agent-research.md` §8.2）。
2. 项目记忆增加 `scope`（目录/模块）、`confidence`、`tags`、`source`（用户确认/Agent 推断/模型总结），支持按任务检索 top-k。
3. 新增 **Context Manifest**：每次执行前记录「注入了哪些简报/记忆/文件/工具」，执行后可审计，避免上下文污染。
4. 新增 **上下文预算**：为 system/contract/memory/history/tool results 分配 token 上限；接近上限时压缩工具输出，保留决定与未解问题。
5. 记忆写入去重/合并：同一文件、同一决定多次出现时合并，不堆积流水账。
6. 继续通过 MCP 暴露 `project_brief_read` / `memory_write` / `artifact_read`，但增加权限与审计。

### 4.6 验收与证据

**问题**

- 工单完成只看执行器摘要；深度编排的 verify 是模型判断；没有确定性验收。
- 用户看到的「完成」可能只是「Agent 说完成了」。

**建议**

每个任务在契约里定义验收，Verifier 按顺序执行：

1. **确定性检查**：命令退出码、测试通过、构建通过、文件存在、diff 范围、行数/格式、截图存在。
2. **证据检查**：每个结论有文件/命令/链接/测试结果引用；没有证据的结论标为「未验证」。
3. **模型评审**（可选）：按 rubric 检查完整性、一致性、风险；输出建议，不替代确定性检查。
4. **人工验收**：高风险或模型不确定时，进入「需要你」队列。

**关键原则：验证命令必须在 Lagent 侧执行并留证，不能只听 CLI 说「我跑过了」。**

- 每个 implement/verify step 带 `verify`：`{ command, cwd, expect, timeoutMs }`。
- 只允许项目脚本与白名单命令（`npm test/build/lint`、`pytest`、`go test` 等），不允许任意 shell。
- 失败时把退出码与 stdout 尾部写进 evidence，工单进入 `needs_review`，而不是直接 failed。
- 无法生成命令时，退化为「文件存在」检查，并在 UI 标黄「仅检查文件存在」，不假装是完整验证。

**完成语义**

- `completed` 只在验收通过时写入；否则 `needs_review` 或 `failed`。
- 人工可以「强制完成」，但必须填理由，并记录在审计里。
- 失败保留已完成步骤与产物，支持「从此步重试」「跳过」「换 Agent」。

**可复用现有资产**

分析侧的 `stage-contracts.js`、`stage-agent.js`、`critic.js`、`quality-receipts.js`、`artifact-lifecycle.js` 已经实现了合同、证据、审查、回执、指纹复用。建议提取为 `server/contracts/` 与 `server/evidence/`，供 work run 调用。

### 4.7 审批与风险

**风险分类**

| 风险 | 例子 | 默认行为 |
| --- | --- | --- |
| R0 只读 | 读文件、搜索、只读命令 | 自动放行，记日志 |
| R1 工作区写入 | 改项目内文件、装依赖 | 内联确认，可批量/会话内记住 |
| R2 高风险 | 删除、递归、工作区外写入、推送、网络外发 | 阻断确认，展示命令/路径/影响/回滚 |
| R3 禁区 | 系统目录、`.git`、`.ssh`、密钥、支付 | 默认拒绝，需显式解锁并审计 |

**交互**

- 审批卡三态：允许一次 / 本会话允许该执行器 / 拒绝并说明理由。
- 批量只限同风险级别；高风险逐条。
- 顶部「需要你」徽标 + 抽屉；不在用户输入时抢焦点。
- 「本项目内记住」有到期与撤销入口。
- 所有决定写入审计：谁、何时、看了什么、批了什么、结果如何。

**窗口 Agent**

- 单独标记为 R2/R3，默认只读；键入前展示窗口标题/进程/PID，并要求确认。
- 记录键入内容与读取输出；窗口句柄变化时重新确认，不自动重试。

### 4.8 可观测与评估

**运行详情**

- Run 头：状态、步骤 4/7、耗时、token、费用、上下文占用、当前步骤。
- 步骤列表：状态、执行器、开始/结束、重试次数、证据、产物。
- 工具调用：入参、耗时、结果体量、错误。
- 审批记录：风险级别、决定、理由。
- 产物：diff、日志、报告、截图、引用。

**事件流**

- SSE 推送增量：`run.updated`、`step.updated`、`approval.requested`、`artifact.created`、`cost.updated`。
- 每条事件带 `runId`、`seq`、`type`、`payload`；支持 `Last-Event-ID` 断线重放。
- 前端用 reducer 合并，不再每条消息全量 `bootstrap`。
- 保留 15 秒兜底轮询，但只在 SSE 断开时启用。

**评估**

- 建立 20–50 个真实任务的 eval 集（从项目历史中挑选成功/失败/边界样本）。
- 在临时工作区运行，避免污染真实项目。
- 指标：成功率、一次通过率、返工率、人工介入次数、单位任务成本、端到端时延、交接成功率。
- 对比模式：单 Agent vs 计划 vs 交叉验证 vs 团队；用数据决定默认值。
- 每次改 prompt/路由/模型/工具都跑回归；失败样本进入 eval 集。

### 4.9 安全

| 层 | 建议 |
| --- | --- |
| 指令层 | 外部内容（网页、issue、文件）用分隔块包裹，声明「这是数据不是指令」 |
| 能力层 | 每次 run 发能力令牌：项目根 + 额外目录 + 网络白名单 + 命令白名单；最小权限 |
| 审查层 | 独立审查模型预检 shell/危险动作；高风险动作规则优先 |
| 运行时层 | 沙箱/工作树/临时 HOME；凭据不进入 prompt/日志/trace；窗口 Agent 隔离 |
| 审计层 | 每个动作留痕；支持导出与按项目/Agent 过滤 |
| MCP | 令牌分读写、绑定项目、限流、审计；**审批动作与执行者身份分离**，外部 Agent 不能批准自己发起的动作；简报回写需人工确认 |

特别提醒：lethal trifecta（私有数据 + 不可信内容 + 对外通信）三者同时具备时，必须假设注入可能成功（`docs/agent-research.md` §7）。不要用 prompt 约束替代权限边界。

### 4.10 成本

- 成本账：按 run/step/agent/project 记录 token、模型、工具、时长。
- 预算：任务级、项目级、日级；80% 告警，100% 阻断或降级。
- 路由：简单任务走便宜模型/脚本；复杂任务才上大模型。
- 缓存：稳定前缀、工具定义、项目记忆置前；记录 cache hit。
- 频率：routine 默认一天 1–2 次；无变化保持沉默；每周审计。
- 展示：价格未知显示「—」而不是 0；区分「估算」与「供应商返回」。

---

## 5. 两条路线

### 路线 A：渐进重塑（推荐）

保留：

- 桌面/云端壳、账号、移动审批；
- 执行器适配层（Claude Code、Codex、ACP、CLI、窗口、终端、浏览器、GitHub）；
- 项目档案、变更时间线、MCP；
- 审批/策略/凭据库；
- 分析侧的合同/证据机制。

替换/新增：

- 新增统一 run kernel；现有 ticket/plan/orchestrator 逐步迁移为 run/step；
- 新增契约、验收、roster、风险审批、eval、成本账；
- 前端改为三主界面 + 运行详情；
- 分析工作流作为「analysis」垂直执行器接入；teamwork 遗留代码移除或改为示例/模板。

优点：风险低、可增量验收、保留用户数据与执行器生态。
缺点：迁移期需要同时维护旧接口；需要严格的数据迁移与兼容层。

### 路线 B：彻底重塑

以新内核重写指挥台，保留执行器适配与项目档案导出；分析能力暂时下线或独立仓库。

优点：模型干净、概念统一、没有历史包袱。
缺点：周期长、迁移风险高、现有用户与测试需要重建；在可靠性问题尚未解决时重写，容易把旧问题带进新架构。

### 选择建议

- 如果目标是**继续运营现有产品、逐步提升留存**：选 A。
- 如果目标是**换一个品类、重新融资/开源发布**：可以先做 A 的内核，再在外层做 B 的界面与品牌；不要同时重写内核和界面。
- 当前阶段建议 A：先把「可靠完成一个真实任务」做成，再谈品类叙事。

---

## 6. 分阶段改造计划

### P0：止血与聚焦（约 2 周）

目标：让产品只有一个身份，让「完成」开始有意义。

| 事项 | 具体动作 | 验收 |
| --- | --- | --- |
| 统一叙事 | README/首页/设置统一为「多 Agent 指挥台」；分析页标注为「数据分析（可选）」；清理 teamwork 遗留入口 | 新用户 30 秒内能说出产品是做什么的 |
| 统一对象命名 | UI/API 统一 Task/Run/Step；保留 ticket/plan 作为兼容字段 | 前端不再同时出现「工单/计划/运行」三种主词 |
| 工单验收 | 每个 step 增加 acceptance（至少：命令/文件/测试之一）；完成必须附证据 | 「已完成」的工单都能看到证据；没有证据的标「待验收」 |
| 审批风险 | 增加 R0–R3 分类；高风险展示命令/路径/影响；支持「本会话允许」；对齐默认 `requireApproval` 与叙事 | 高风险动作必须二次确认；用户明确知道当前是「先批准」还是「直接执行」 |
| 项目简报补字段 | 增加 openQuestions / nextSteps | 新 Agent 接手时能看到未解问题与下一步 |
| SSE 增量 | 前端不再每条事件全量 bootstrap；按 run/step 合并 | 长任务 UI 不抖动；事件流量下降 |
| 清理遗留代码 | 删除 teamwork 的前端状态/API 调用，或整体移到 `examples/`；主流程不保留 | 代码中不再有不可达的 teamwork 状态 |

### P1：统一内核（约 4–6 周）

目标：长任务可恢复、可审计、可取消。

| 事项 | 具体动作 | 验收 |
| --- | --- | --- |
| Run/Step 表 | 新增 work-run/work-step/work-event；迁移 ticket/plan | 旧数据可读；新 run 有 seq 事件 |
| 心跳/超时 | 执行器回报心跳；stalled 标记 | 能区分在跑与卡死 |
| 断点续跑 | sessionId 续接；无 session 的有界重试；已完成步骤不重跑 | 杀掉进程后能续跑，不重复收费 |
| 统一队列 | outbox 扩展为 work-queue；优先级/并发/公平 | 多项目并发不互相饿死 |
| 迁移计划/编排 | plan 映射为 run；orchestrator 模板作为 run.template | 现有计划与深度编排仍可用 |
| 事件重放 | SSE Last-Event-ID；断线补发 | 断线 30 秒后恢复不丢状态 |

### P2：契约、验收、团队（约 6–8 周）

目标：任务可交接、完成可验证、团队可配置。

| 事项 | 具体动作 | 验收 |
| --- | --- | --- |
| Contract | 每个 task/step 结构化契约 | Planner/Executor/Verifier 共用同一契约 |
| Verifier | 确定性检查 + 证据 + 模型评审 | 完成必须通过验收或有理由的人工覆盖 |
| Roster | Agent 档案（能力/权限/成本/可靠性） | 路由能解释「为什么选它」 |
| 团队模板 | 项目级角色/权限/模式预设 | 一键套用团队；文件所有权冲突可检测 |
| Handoff | 结构化交接 + MCP 读写 | 换 Agent 后不重读全项目 |
| 记忆 v2 | scope/confidence/tags/检索/去重 | 新任务能取到相关记忆，而不是全量注入 |

### P3：观测、评估、安全、成本（约 8–12 周）

目标：用数据证明系统在变好，并把风险关进笼子。

| 事项 | 具体动作 | 验收 |
| --- | --- | --- |
| Trace | run/step/tool span、耗时、token、费用 | 任意失败可定位到步骤与证据 |
| Cost | 按 run/agent/project 成本账 + 预算告警 | 能看到每个任务花了多少 |
| Eval | 20–50 个真实任务；回归与对比 | 改动前后有数字对比 |
| 安全 | 能力令牌、沙箱、命令风险、注入边界 | 高风险动作无法绕过；审计可导出 |
| MCP v2 | 契约/验收/记忆/产物工具；读写分离 | 外部 Agent 可安全接手任务 |
| 移动/云端 | 审批、状态、通知；多端一致 | 手机能完成「看状态 + 批准」闭环 |

---

## 7. 代码落点

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 拆分巨型引擎 | `server/work/engine.js`（约 1900 行） | 拆为 ticket-service / plan-service / execution-service / project-service / bootstrap |
| 统一运行内核 | 新增 `server/work/runs/` | run-store、event-store、queue、scheduler、recovery |
| 契约与验收 | 新增 `server/work/contracts.js`、`verification.js` | 从 `stage-contracts.js`、`critic.js`、`quality-receipts.js` 提取通用逻辑 |
| 风险审批 | 新增 `server/work/risk.js` | 动作分类、R0–R3、批量/记住/到期 |
| Agent 档案 | 新增 `server/work/roster.js` | 能力/权限/成本/可靠性；替代静态 `CAPABILITY_TABLE` 的单一来源 |
| 队列 | `server/work/outbox.js` | 从 launch-only 扩展为通用 work-queue |
| 编排收敛 | `server/work/orchestrator/*` | 模板保留，运行状态并入 run kernel；避免两套状态机 |
| 团队通用化 | `server/work/teamwork.js` | 固定小游戏改为通用「文件所有权 + 接口契约 + 组装」模板，或移到 `examples/` |
| 分析垂直化 | `server/multi-workflow.js`、`server/stage-*` | 作为 `analysis` executor 保留；合同/证据上提为通用模块 |
| 团队运行时复用 | `server/team-runtime.js` | 允许 work run 复用节点/依赖/预算/事件，而不只分析阶段 |
| 事件流 | `server/work/routes.js`、`src/api.ts` | `/api/work/events` 推增量；`Last-Event-ID`；前端 reducer |
| 前端运行详情 | `src/components/SuperAgentShell.tsx`、`ProjectsPanel.tsx` | 按 Task/Run/Step 渲染；参考 `ui.md` §3 |
| 项目页 | `src/components/ProjectsPanel.tsx` | 简报增加未解问题/下一步；记忆检索/过滤 |
| API 契约 | `docs/api-contract.md` | 新增 v2 run/step/approval/evidence；保留 v1 兼容 |
| 评估 | 新增 `server/eval/`、`scripts/eval.mjs` | 20–50 个真实任务；临时工作区；回归对比 |

---

## 8. 产品/UI 调整

界面细节见 `ui.md`，这里只列与定位直接相关的结构变化：

1. **三个主入口**：指挥台 / 项目 / 团队。设置、工具、记忆管理收进「更多」。
2. **运行详情取代聊天气泡**：Run 头（状态、步骤、耗时、成本、上下文）+ Step 列表 + 产物/证据 + 审批记录。
3. **「需要你」收件箱**：待审批、待验收、失败待处理；按风险排序。
4. **项目页成为记忆主页**：简报（含未解问题/下一步）、决策、变更、记忆、产物、团队。
5. **团队页成为 Agent 档案**：能力、权限、成本、成功率、最近任务；项目团队模板。
6. **清理无入口的遗留代码**：teamwork 从主流程移除；固定示例保留为「模板/示例」。
7. **首页任务优先**：回访用户先看到「在跑什么、需要你什么、上次结果」，新用户才看引导。
8. **移动端只做三件事**：看状态、批审批、发指令；不试图复刻桌面全功能。

---

## 9. 指标与验收

### 北极星

> **每周完成并通过验收的任务数（按活跃项目去重）。**

不是「派发了多少任务」，也不是「调用了多少模型」。

### 护栏指标

| 指标 | 目标 |
| --- | --- |
| 一次通过率 | 逐步提升；按任务类型分桶 |
| 返工率 | 下降 |
| 人工介入次数/任务 | 下降，但高风险任务允许上升 |
| 审批等待时长 | 下降 |
| 单位任务成本 | 可控；按类型分桶 |
| 交接成功率 | 提升 |
| 失败可定位率 | 100% 失败有步骤与证据 |
| 安全事件 | 0 起越权/泄密/误删 |

### 评估方法

- 20–50 个真实任务；两个专家能独立判定同一结果。
- 每个任务有参考解或可验证状态。
- 确定性检查优先，模型评审补充，人工校准。
- capability eval 与 regression eval 分开。
- 每次改动跑回归；失败样本进入 eval 集。

---

## 10. 风险与反模式

| 风险 | 表现 | 对策 |
| --- | --- | --- |
| 继续加执行器 | 每多一个就多一份不可控 | 先补齐恢复/验收/权限，再扩 |
| 群聊默认化 | 多个 Agent 抢话、成本爆炸 | 默认委派；高风险才交叉验证 |
| 演示驱动 | 小游戏/交叉验证好看但不可评估 | 用 eval 与验收说话 |
| 假完成 | Agent 说完成，没有证据 | 完成必须附证据；人工覆盖要理由 |
| 审批疲劳 | 每个动作弹窗，用户盲批 | 风险分级 + 批量 + 会话内记住 |
| 记忆污染 | 聊天记录/错误结论反复注入 | 只存决定/产物/证据；来源/置信度/去重 |
| 上下文爆炸 | 全量历史注入 | 预算 + 压缩 + 检索 top-k + manifest |
| 厂商吸收 | 单厂商 Agent 自带编排 | 跨厂商 + 项目记忆 + 治理 |
| 迁移中断 | 新旧两套状态并存 | 兼容层 + 双写/投影 + 一次性切换 |
| 安全事件 | 窗口键入/越权/注入 | 沙箱 + 能力令牌 + 风险审批 + 审计 |

---

## 11. 需要你拍板的五件事

1. **产品身份**：确认「多 Agent 指挥台」为主，数据分析降为垂直能力？还是反过来？
2. **路线**：选渐进重塑（推荐）还是彻底重塑？
3. **协作默认**：默认单 Agent 委派，交叉验证作为高风险选项？还是保留多选即并行？
4. **团队边界**：先做「项目团队模板 + 角色/权限」，还是先做「通用 teamwork 契约」？
5. **商业化/部署**：本地免费 + 云端同步/远程审批，还是云端优先？这会影响队列、多租户与数据隔离设计。

---

## 附录 A：数据模型草案

### A.1 审批预览（WorkPreview）

审批卡不应该只显示标题，而应显示「将执行什么」。建议给工单增加只读投影字段（不暴露原始 argv）：

```ts
interface WorkPreview {
  kind: 'command' | 'file-write' | 'window-input' | 'network' | 'model';
  command?: string;   // 已脱敏、截断到 500 字
  cwd?: string;
  paths?: string[];   // 将读写/修改的路径
  diffStat?: string;  // 例如 "3 files, +42 -7"
  hosts?: string[];   // 外联域名
  risk: 'low' | 'medium' | 'high' | 'blocked';
  reversible: boolean;
}
```

生成时必须过脱敏与长度限制；diff 原文按需通过独立端点读取，带权限校验，不塞进列表响应。

### A.2 验证（Verify）

```ts
interface Verify {
  command: string;    // npm test / pytest / go test / 自定义白名单命令
  cwd?: string;
  expect: 'exit=0' | 'contains:<text>' | 'exists';
  timeoutMs?: number;
}
```

验证在 Lagent 侧执行，输出脱敏后写入 evidence；没有 verify 的步骤必须显式标注「仅检查文件存在」。

### A.3 风险档位（Executor × Action）

```ts
type Tier = 'investigate' | 'draft' | 'autopilot';
interface PolicyTiers {
  [executorId: string]: {
    read?: Tier;     // 默认 investigate
    write?: Tier;    // 默认 draft
    publish?: Tier;  // 默认 autopilot
  };
}
```

- `investigate`：自动放行，留审计。
- `draft`：首次询问，批准后本会话/本项目记住；可配置为逐条。
- `autopilot`：每次批准，且审批卡必须展示 preview/verify/影响面。
- 保留 `requireApproval` 作为总开关，兼容旧配置。

### A.4 副作用类型（Effect）

扩展 outbox 的 effect 类型，每种带幂等键与重试上限：

| 类型 | 用途 | 幂等策略 |
| --- | --- | --- |
| `launch` | 启动执行器 | `ticketId + assignmentId`；重跑前检查状态 |
| `verify` | 运行验证命令 | 可重跑；结果写 evidence |
| `notify` | 通知用户/手机 | `runId + eventSeq` 去重 |
| `publish` | 推送/发布/外部写 | 必须人工确认 + 幂等键；不可自动重试 |
| `memory` | 写项目记忆 | `stepId + memoryHash` 去重 |

### A.5 SQL 草案

```sql
-- 项目
project(id, name, path, git_branch, created_at, updated_at)
project_brief(project_id, goal, summary, key_points, decisions, constraints,
              open_questions, next_steps, updated_at)
project_memory(id, project_id, kind, title, summary, files, scope, tags,
               confidence, source, created_at)

-- 任务与运行
task(id, project_id, goal, contract_json, status, created_by, created_at)
run(id, task_id, mode, template, status, budget_json, started_at, ended_at)
step(id, run_id, index, role, executor_id, contract_json, status,
     depends_on, scope, attempt, started_at, ended_at)
execution(id, step_id, executor_id, session_id, pid, heartbeat_at,
          status, error_code, started_at, ended_at)

-- 产物与证据
artifact(id, step_id, kind, path, bytes, hash, meta_json, created_at)
evidence(id, step_id, artifact_id, kind, ref, summary, created_at)
acceptance(id, step_id, verdict, checks_json, evidence_json, reviewer,
           reason, created_at)

-- 审批
approval(id, run_id, step_id, risk, action, scope, command, paths,
         decision, reason, decided_by, decided_at)

-- 事件
event(id, run_id, seq, type, payload_json, created_at)
```

## 附录 B：API / MCP 草案

**REST**

```
GET  /api/v2/projects
GET  /api/v2/projects/:id/brief
GET  /api/v2/projects/:id/memory?query=
GET  /api/v2/tasks
POST /api/v2/tasks
GET  /api/v2/runs/:id
GET  /api/v2/runs/:id/events        (SSE, Last-Event-ID)
POST /api/v2/runs/:id/cancel
POST /api/v2/runs/:id/approve
GET  /api/v2/approvals?status=pending
GET  /api/v2/agents                 (roster)
GET  /api/v2/evals
```

**MCP 工具**

| 工具 | 用途 |
| --- | --- |
| `project_brief_read` | 读取项目目标/进展/决定/约束/未解问题/下一步 |
| `project_memory_search` | 按关键词/范围检索项目记忆 |
| `task_contract_read` | 读取当前任务契约与验收标准 |
| `run_status` | 读取运行/步骤状态、成本、阻塞 |
| `approval_request` | 请求人工审批（带风险与影响） |
| `artifact_read` | 读取产物/证据 |
| `memory_write` | 回写决定/产物（需权限与审计） |

工具描述按 ACI 写清「何时用、何时别用、返回结构、失败情况」（`agent-dev.md` §5.1）。

## 附录 C：现状模块清单

| 模块 | 行数/位置 | 角色 | 建议 |
| --- | --- | --- | --- |
| `server/work/engine.js` | ~1900 | 工单/计划/项目/审计/队列 | 拆分 |
| `server/work/orchestrator/*` | ~800 | Mastra 深度编排 | 模板保留，状态并入 run kernel |
| `server/work/teamwork.js` | 264 | 固定小游戏组装（前端无入口） | 通用化或移到 examples |
| `server/team-runtime.js` | 67（长行） | 分析子智能体团队 | 泛化为 run team runtime |
| `server/subagents.js` | 24（长行） | 分析角色校验 | 保留，扩展为 roster 校验 |
| `server/multi-workflow.js` | 404 | 分析 13 阶段 | 垂直能力；合同/证据上提 |
| `server/stage-contracts.js` | 111 | 阶段合同/证据 | 提取通用契约模块 |
| `server/critic.js` | 35 | 独立审查 | 提取为 verifier 的一种 |
| `server/quality-receipts.js` | 23 | 质量回执 | 提取为验收证据 |
| `server/work/store.js` | ~70 | 工作事件存储 | 升级为事件日志 + 投影 |
| `server/work/outbox.js` | ~170 | 启动副作用重试 | 扩展为 work-queue |
| `server/work/project-memory.js` | ~138 | 项目记忆 | 增加 scope/confidence/tags/检索 |
| `src/components/SuperAgentShell.tsx` | ~1820 | 主界面 | 按 run/step 重构；参考 ui.md |
| `src/components/ProjectsPanel.tsx` | ~1363 | 项目/会话 | 项目档案/记忆/产物 |
| `docs/api-contract.md` | — | API 契约 | 增加 v2；保留 v1 兼容 |

---

> 这份文档是提案，不是实施记录。建议先拍板第 11 节的五个问题，再把 P0 拆成可验收的工程任务；P1 之后每一项都应带测试、兼容层与回滚方案。
