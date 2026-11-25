# Lagent 手机端对话式指挥台设计

日期：2026-11-25

## 背景

手机端 `/m` 目前是独立的「工单遥控」界面（`src/mobile/MobileApp.tsx`），只有四个 tab：指挥 / 收件箱 / 任务 / 设置。它不是桌面指挥台的移动版，原因有三层：

- UI 层：手机「指挥」页只是一个单条指令表单，执行者下拉框之外没有单/多 Agent 切换、消息流、会话历史、工作文件夹和思考过程。
- API 层：移动网关只暴露工单级接口。`/api/mobile/bootstrap` 裁掉了项目与会话，`/api/mobile/tickets/:id` 裁掉了 `activity`，`/api/mobile/command` 不接受 `mode`、`agentIds`、`projectId`。
- 安全层：`server/app.js` 明确禁止设备 token 访问 `/api/work/*`，移动端被刻意限制为工单级能力。

本设计把手机端改造成 ChatGPT / 豆包式会话界面，同时保留移动端的安全边界。

## 目标

- 手机端以「对话」为主入口：消息流、底部输入区、会话历史抽屉。
- 支持单 Agent / 多 Agent 切换，多 Agent 时手动勾选最多 3 个协作 Agent。
- 实时查看思考过程：思考正文、工具调用、观察结果、报错、权限确认。
- 新建会话时可从电脑端已导入的项目中选择工作文件夹。
- 复用桌面端已有的会话引擎（Lagent 主控、ticket 挂会话、多 Agent 拆解/验收/汇总），不另造一套执行模型。
- 旧版 Android 外壳和旧 APK 继续可用，新接口只做增量。

## 非目标

- 不做图片、文件、语音等非文本消息；后端没有附件上传管线。
- 不做每个协作 Agent 的模型选择；协作 Agent 只开放思考强度，模型保持电脑端默认。
- 不做系统推送；切后台断开 SSE，回前台重连刷新。
- 不做会话搜索、置顶、归档。
- 不做「重新生成」「编辑重发」；只提供复制。
- 不允许手机导入/删除项目，不允许修改权限、策略、凭据、模型凭据。
- 不改造桌面端 `SuperAgentShell` 的主界面。
- 不修改 Android 外壳代码；它仍加载 `/m`。

## 决策记录

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 导航与旧功能 | 底部导航改为「对话 / 收件箱 / 任务 / 设置」；进入会话隐藏底部导航；旧工具直连移到会话抽屉「工具指令」 |
| Q2 | 工作文件夹 | 只在新会话创建时从已导入项目中选择；创建后只读显示，不中途切换 |
| Q3 | 会话管理 | 允许重命名、删除；删除前二次确认，只删会话壳，工单保留；不做搜索/置顶/归档 |
| Q4 | 消息输入 | v1 只支持纯文本 |
| Q5 | 模型切换 | 允许在手机切换 Lagent 的模型配置档；Lagent 与每个协作 Agent 都可单独调思考强度 |
| Q6 | 思考与权限 | 运行中自动展开、完成后收起；多 Agent 分 tab；权限步骤内联允许/拒绝，同时保留收件箱 |
| Q7 | 思考内容 | 展示全部步骤；工具调用压成一行，不把大段输出灌进正文 |
| Q8 | 新建与重试 | 首条消息发送时才创建会话；失败保留草稿；同一 `clientRequestId` 幂等重试；超时先刷新确认 |
| Q9 | 可切换对象 | Lagent 可选模型配置档；Lagent 与每个协作 Agent 都可单独调思考强度；协作 Agent 的模型仍用各自默认 |
| Q10 | 选择作用域 | 按会话存在手机本地；跨设备不同步 |
| Q11 | 模型来源 | 只下发 `id/name/model/efforts/available`；列出全部配置档，不可用置灰；默认项标记桌面默认 |
| Q12 | 设置白名单 | 只接受 `profileId`、`effort`、`efforts`（按 Agent 的强度映射）；显式丢弃 `permission`、`model`、凭据、策略 |
| Q13 | 思考强度 | Lagent 按模型声明过滤档位；协作 Agent 显示全部档位并标「未验证」；被拒自动回落默认 |
| Q14 | 选择入口 | 顶部标题旁模型 chip，点开底部弹层 |
| Q15 | 新会话默认 | 记住手机上次选择；首次使用桌面工作流默认 |
| Q16 | 消息标注 | 顶部 chip 显示 Lagent 模型/强度；协作方强度只在 Agent 弹层显示；助手气泡和思考块不重复标注 |
| Q17 | 多 Agent 默认 | 切到多 Agent 不自动勾选；必须手动勾至少一个 |
| Q18 | 新会话文件夹默认 | 记住上次选择；首次默认「不绑定项目」 |
| Q19 | 会话列表分组 | 今天 / 昨天 / 更早；组内按更新时间倒序 |
| Q20 | 长会话加载 | 默认最近 30 轮；顶部「加载更早」按需分页 |
| Q21 | 消息操作 | 只做复制 |
| Q22 | 运行中切换 | 模型与各 Agent 强度随时可切，标注「下一轮生效」，不停止当前轮 |
| Q23 | 发送失败与离线 | 保留草稿并显示错误；不做离线队列；手动重试继续用同一 `clientRequestId` |
| Q24 | 协作方信息展示 | 思考块只显示 Agent 名称、状态、过程，不显示各自模型；强度在「协作 Agent」弹层里展示和调整 |
| Q25 | 权限失效 | 提示「这次确认已失效」并刷新，保留收件箱入口 |
| Q26 | 后台与通知 | 不做推送；切后台断开 SSE，回前台重连刷新 |
| Q27 | 可按 Agent 调整的范围 | Lagent = 模型 + 强度；每个协作 Agent = 只调强度，模型保持默认 |
| Q28 | 协作方强度档位 | CLI 无能力声明，显示全部档位并标「未验证」；Lagent 按配置档声明过滤 |
| Q29 | 协作方强度入口 | 放在「协作 Agent」弹层，每个勾选行右侧带强度下拉 |
| Q30 | 报告全文策略 | 随详情返回 20,000 字预览；超出用「展开全文」按需加载，完整正文上限 200,000 字 |
| Q31 | 强度持久化 | 按会话保存 `profileId / effort / efforts`；新会话默认强度；Agent 暂不可用时保留其强度值 |

## 用户界面

### 导航结构

- 底部导航：`对话 / 收件箱 / 任务 / 设置`。
- 「对话」tab 是默认入口；从对话列表进入某条会话后，隐藏底部导航，用顶部返回键回到会话列表。
- 收件箱、任务、设置保持现有能力。
- 会话抽屉底部增加「工具指令」入口，打开原「指挥」表单的工具部分（受控终端、浏览器、GitHub），不再提供 Agent 选项。

### 对话页结构

```text
┌──────────────────────────────┐
│ ☰   会话标题            ⋯    │  顶部：抽屉 / 标题 / 模型 chip / 会话菜单
├──────────────────────────────┤
│  你：检查仓库 CI，修复失败项   │
│                              │
│  ┌ 已思考 12s · 8 步      ▾ ┐ │  可折叠思考块
│  │ Lagent · 拆解分发          │ │  ├ 多 Agent 时按 Agent 分 tab
│  │ Claude Code · 已完成       │ │  ├ 权限步骤内联「允许 / 拒绝」
│  │ Codex · 执行中…            │ │  └ 实时追加，完成后自动收起
│  └──────────────────────────┘ │
│                              │
│  Lagent：结论 / 汇总回答…     │  助手气泡（Markdown + 复制）
│  [查看文件] [任务详情]        │
├──────────────────────────────┤
│ 单Agent · 多Agent · 协作(2)   │  模式 / 协作 Agent
│ ┌──────────────────────────┐ │
│ │ 输入消息…              ➤ │ │  底部输入区
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

### 会话抽屉

- 顶部「新对话」按钮。
- 按「今天 / 昨天 / 更早」分组；组内按 `updatedAt` 倒序。
- 每条显示：标题、项目名（有绑定时）、状态圆点、时间、当前选中高亮。
- 右侧 `⋯` 打开操作菜单：重命名、删除。
- 删除当前会话后回到空白新会话页。
- 删除正在执行的会话时，确认文案明确「只删除会话记录，已派出的任务会继续在电脑端执行」。
- 底部「工具指令」入口。

### 输入区

- 单 Agent / 多 Agent 分段控件；多 Agent 时显示「协作 Agent (n)」chip。
- 新会话显示「工作文件夹」chip；已有会话只读显示绑定的项目名。
- 发送按钮：文本为空、正在发送、Lagent 未就绪、或多 Agent 未选协作方时禁用。
- 文本上限 3000 字；超出时在输入区下方提示，不截断用户输入。
- 键盘弹起时输入区吸附在底部；`Enter` 发送、`Shift + Enter` 换行（移动端软键盘通常只有换行，发送仍以按钮为准）。
- 助手气泡提供「复制」；复制内容为纯文本结论。

### 思考块

- 按「轮次」聚合，一轮一个思考块；块内按 Agent 分 tab。
- 运行中：默认展开，自动跟随正在执行的 Agent，显示已用时间和步骤数。
- 完成后：默认收起；用户手动展开后保持展开。
- 步骤类型：
  - `thought`：正文段落。
  - `tool` / `observation`：一行紧凑展示，命令或工具名用等宽字体。
  - `error`：红色高亮。
  - `permission`：显示问题与「允许一次 / 拒绝」；已处理时显示结果。
- 数据合并：详情里的 `activity` 与 SSE 实时步骤按 `at + kind + text` 去重；过滤 `kind=result`，避免与助手结论重复。
- 工具调用只显示命令/工具摘要与短结果，不展开完整输出。

### 模型选择

- 顶部模型 chip 显示 Lagent 当前模型名或「默认模型」+ 当前思考强度。
- 点开底部弹层：
  - 模型列表：默认项 + 全部已配置的模型配置档；不可用的置灰并说明「当前不可用」。模型选择只作用于 Lagent。
  - Lagent 思考强度：优先显示该配置档声明支持的档位；没有声明时显示全部并标「未验证」。
  - 弹层底部提示：运行中切换时显示「下一轮生效」。
- 选择结果按会话写入 `localStorage`，同时写入「上次选择」供新会话使用。
- 协作 Agent 的思考强度在「协作 Agent」弹层里逐个设置；它们的模型仍使用各自默认值。
- 工单详情没有记录每轮实际使用的模型名，v1 不在历史消息或思考块里展示逐轮模型；顶部 chip 只表示「下一轮将使用」的选择。
- 重新打开会话时，如果保存的配置档已被删除或不可用，自动回落到默认模型并显示提示「原模型不可用，已改用默认模型」。

### 多 Agent 选择

- 切到「多 Agent」后不自动勾选。
- 底部弹层列出可用的 `model` / `cli` 类 Agent（排除工具和窗口 Agent，排除 Lagent 自身）。
- 每个 Agent 行包含：名称、可用状态、勾选框、思考强度下拉。未勾选时强度下拉禁用；勾选后默认 `default`，可选择全部档位并标「未验证」。
- 取消勾选时移除该 Agent 的强度；Agent 暂时不可用时保留其强度值，重新可用后恢复。
- 最多勾选 3 个；不可用或不在策略白名单内的置灰。
- 未勾选时发送按钮禁用，并提示「多 Agent 模式至少选择一个协作 Agent」。
- 历史 `plan/review` 模式的会话打开时按参与者恢复；手机只提供单 Agent / 多 Agent 两种新回合模式，不暴露旧模式开关。

### 工作文件夹

- 只在新会话选择；弹层列出电脑端已导入的项目，显示名称和路径尾部。
- 另有「不绑定项目」选项，使用默认工作区。
- 记住上次选择，下次新会话自动带出；首次默认不绑定。
- 会话创建后，文件夹固定；输入区只读显示项目名，不提供切换。

### 空状态与错误

- 无会话：问候语「今天想让我做什么？」+ 输入区。
- Lagent 未配置模型：顶部横幅「Lagent 尚未配置模型，请到电脑端设置」；输入区可编辑但发送禁用。
- 加载失败：显示错误原因和「重试」按钮，不清空已有草稿。
- 发送失败：用户气泡旁显示失败状态和「重试」；草稿恢复。
- 权限失效：提示「这次确认已失效」并刷新工单；收件箱入口保留。
- 会话在电脑端被删除：接口返回 404 时提示「会话已不存在」并退回会话列表。
- 设置页底部说明改为：「可为会话选择 Lagent 模型与各 Agent 思考强度；仍不能管理凭据、策略或项目。」

## 后端设计

### 路由总览

全部挂载在 `/api/mobile`，沿用现有设备 token 鉴权与 owner 隔离。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mobile/models` | 可选模型配置档与桌面默认项 |
| GET | `/api/mobile/conversations?limit=60` | 会话摘要列表 |
| POST | `/api/mobile/conversations` | 新建会话 |
| GET | `/api/mobile/conversations/:id?limit=30&before=<index>` | 会话详情 + 分页轮次 + 关联工单 |
| PATCH | `/api/mobile/conversations/:id` | 重命名 |
| DELETE | `/api/mobile/conversations/:id` | 删除会话 |
| POST | `/api/mobile/conversations/:id/messages` | 发消息 |
| GET | `/api/mobile/reports/:id/text` | 报告完整正文（按需加载） |
| POST | `/api/mobile/tickets/:id/permissions/:requestId` | 权限允许/拒绝 |

保留现有：

- `GET /api/mobile/bootstrap`
- `POST /api/mobile/command`（旧 APK 与「工具指令」）
- `GET /api/mobile/tickets/:id`
- `GET /api/mobile/tickets/:id/files`
- `POST /api/mobile/tickets/:id/actions`
- `GET /api/mobile/events`

### bootstrap 增量

`sanitizeMobileBootstrap` 增加：

```ts
projects: { id, name, path, gitBranch }[]        // 最多 100
conversations: MobileConversationSummary[]       // 最近 30
lagent: { name, executorId, ready, configured, reason } // reason 供未就绪提示
```

不下发：凭据、Base URL、Key、策略内部限制、执行器私有字段。

### 会话摘要裁剪

```ts
type MobileConversationSummary = {
  id: string;
  title: string;
  goal: string;
  projectId: string | null;
  participants: string[];
  status: 'waiting' | 'working' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled';
  turnCount: number;
  lastPrompt: string;
  lastMode: 'auto' | 'multi' | 'plan' | 'review';
  createdAt: string;
  updatedAt: string;
};
```

字段长度：`title` 200、`goal` 4000、`lastPrompt` 4000、`participants` 最多 4。

### 会话详情与分页

`GET /api/mobile/conversations/:id`：

- 复用 `engine.getConversation(id)`。
- `limit`：默认 30，范围 1–50。
- `before`：可选轮次索引，必须是非负整数；非法值返回 400。返回 `turn.index < before` 的轮次。
- 首次请求无 `before`：返回最后 `limit` 轮。
- 响应：

```ts
{
  conversation: MobileConversationSummary & {
    turns: MobileConversationTurn[];
    hasMore: boolean;
    nextBefore: number | null;
  };
  tickets: MobileTicket[];
}
```

- `MobileConversationTurn`：`id / index / prompt / mode / agentIds / runs / synthesisTicketId? / synthesisAgentId? / createdAt`。
- `runs`：`ticketId / agentId / role`，最多 8。
- `tickets`：只返回当前可见轮次与合成工单关联的 ticket，使用现有 `sanitizeMobileTicket`。
- `hasMore`：可见轮次之前是否还有更早轮次。
- `nextBefore`：当前最早已加载轮次的 `index`，用于下一次加载。

### 工单详情增量

`sanitizeMobileDetail` 增加：

```ts
activity?: { kind, text, detail?, at?, requestId?, decided? }[]  // 最多 40
project?: { id, name, gitBranch }
reports?: (MobileReport & { text?: string; truncated?: boolean })[] // text ≤ 20,000
```

- 报告增加 `text` 字段：使用服务端共享的 `report-text.js` 优先级（`artifacts.acp.text → cli.summary → window.text → report.summary → summary`）提取结论，默认上限 20,000 字，并返回 `truncated` 标记；`summary` 仍保留 400 字用于列表。
- 助手气泡优先使用 `text`，没有时才用 `summary` 或 `ticket.summary`；`truncated: true` 时显示「展开全文」，调用 `GET /api/mobile/reports/:id/text` 取完整正文（上限 200,000 字）。
- 字段白名单 + 长度上限：`text` 1200、`detail` 600、`at` 40、`requestId` 120。
- 不新增任何凭据、命令环境变量、绝对路径字段。

### 报告全文

`GET /api/mobile/reports/:id/text`：

- 只接受当前 owner 下、且通过工单可见性校验的报告 id；不存在或跨 owner 返回 404。
- 复用引擎新增的 `reportText(id)`：直接读取 report 行，与 `conversationRunReport` 使用同一套 artifacts 优先级；不走只含 summary 的报告中心投影。
- 返回 `{ text, truncated }`，上限 200,000 字；超出时 `truncated: true`。
- 不返回 artifacts 原始结构、凭据、文件路径列表。

### 消息发送

`POST /api/mobile/conversations/:id/messages`：

请求体只接受：

```ts
{
  text: string;                 // 1–3000
  mode: 'auto' | 'multi';       // 单 Agent = auto，多 Agent = multi
  agentIds?: string[];          // 最多 4，自动补 Lagent
  settings?: { profileId?: string; effort?: string };       // Lagent 的模型与强度
  efforts?: Record<string, string>;                          // 按 Agent 的强度映射
  clientRequestId?: string;     // ≤120
}
```

处理规则：

- `text` 去首尾空白后校验 1–3000 字。
- `mode === 'auto'`：强制 `agentIds = ['model']`，忽略协作方与协作方的 `efforts` 项，避免误派。
- `mode === 'multi'`：至少一个协作方，否则 400；协作方必须是已注册、可用、`kind` 为 `model`/`cli` 的执行器，且不在 `allowedExecutors` 之外；最多 3 个。
- `settings` 只保留 `profileId`、`effort`；显式丢弃 `permission`、`model`、`executorInputs`、`models`、`autoRun`。
- `profileId` 必须存在且可用，否则 400「所选模型不可用」。
- `effort` 与 `efforts[*]` 必须是 `default/low/medium/high/xhigh/max` 之一；非法值 400。
- `efforts` 只保留键属于当前 `agentIds` 的项；未提供的协作方按 `default` 处理；`mode auto` 下只使用 `model` 的强度。
- `clientRequestId` 做轮次级幂等：`startManagedTurn` 在建轮次前先查同一会话里是否已有相同 `clientRequestId` 的轮次，有则直接返回该轮次与工单，不再重复派活。
- 固定 `autoRun: true`；移动端不能暂停任务。
- 客户端对发消息请求使用 60s 超时；超时后重新拉会话确认是否已建轮次，不直接判失败。
- 调用 `engine.conversationMessage(id, { text, mode, agentIds, settings, efforts, clientRequestId, autoRun: true })`。
- 返回 `{ conversation, turn, tickets }`，`tickets` 使用 `sanitizeMobileTicket`。
- 请求超时按 Q8 处理：客户端重新拉会话确认是否已建轮次。

### 新建、重命名、删除

- `POST /api/mobile/conversations`：只接受 `title / goal / projectId / agentIds`；忽略客户端传入的 `id`；`agentIds` 按消息接口同样规则校验（仅 `model`/`cli`、可用、白名单内、最多 3 个协作方）。
- `PATCH /api/mobile/conversations/:id`：只接受 `title`，1–200 字。
- `DELETE /api/mobile/conversations/:id`：调用 `engine.deleteConversation`，只删会话壳，工单保留。

### 模型选项

`GET /api/mobile/models`：

- 从 `app.locals.modelHub?.publicState()` 读取。
- 只返回：

```ts
{
  profiles: { id, name, model, available, efforts: string[] }[];
  defaultProfileId: string | null;
}
```

- `efforts` 来自 `profile.capabilities.efforts`，过滤为合法档位；这些只用于 Lagent。
- 协作 Agent 的强度档位由客户端固定使用 `default/low/medium/high/xhigh/max`，不需要额外接口。
- 不返回 `credentials / pools / vault / baseUrl / apiKey / workflow.stages`。
- 模型中心未配置时返回 `{ profiles: [], defaultProfileId: null }`。

### 权限决定

`POST /api/mobile/tickets/:id/permissions/:requestId`：

- 请求体：`{ decision: 'allow' | 'deny' }`。
- 调用 `engine.permissionDecision(ticketId, requestId, decision)`。
- 返回 `{ ticket: MobileTicket }`。
- 成功后客户端本地把该步骤标为已允许/已拒绝，并刷新该 ticket 详情确认状态。
- 失败时按引擎错误原样返回 404/409，客户端提示「这次确认已失效」。

### SSE

现有 `GET /api/mobile/events` 不变；扩展 `mobileWorkEvent`：

```ts
{
  type: string;
  ticketId: string | null;
  payload: {
    status?: string;
    reportId?: string;
    activity?: { kind, text, detail?, at?, requestId?, decided? }[]; // 最近 40
  };
}
```

- 只透出白名单字段。
- 客户端收到 `activity` 时按 ticketId 追加到实时步骤；收到 `ticket/report` 时防抖刷新会话详情与列表。
- 每个 ticket 的实时步骤在手机内存中最多保留最近 200 条，避免长时间任务无限增长。
- 不对每个 activity 触发整页重载。

### 限流与性能

- 沿用每设备每分钟 60 次请求的限流。
- 不使用轮询；实时性由 SSE 承担。
- 会话详情默认 30 轮、最多 50 轮；按需加载更早。
- 初始只拉取最近 12 个 run 的 ticket 详情；其余 run 在滚动到该轮或展开思考块时按需拉取，每次最多 12 个，避免一次打满限流。
- 模型列表只在打开模型弹层或首次进入对话时拉取，之后缓存。

## 安全

- 所有新接口继续使用设备 token；owner 隔离与设备撤销逻辑不变。
- 设备 token 仍不能访问 `/api/work/*`。
- 手机不能导入/删除项目、不能修改策略/权限/凭据。
- 消息接口显式丢弃 `permission`；模型选择与按 Agent 的强度只影响「用哪个模型、用多强的思考」，不影响权限。
- `efforts` 只接受合法档位，键必须属于当前选中的 Agent；不属于本轮参与者的键被丢弃。
- 模型列表不下发凭据、Base URL、Key。
- 思考内容沿用桌面端可见范围，但做字段白名单与长度上限。
- 项目路径只来自电脑端已导入项目，不开放磁盘浏览。
- 发送使用 `clientRequestId` 幂等，避免弱网重复派活。

## 数据流

1. 手机打开 `/m`，读取设备凭证；无凭证进入配对页。
2. 拉取 `/api/mobile/bootstrap`，得到 agents、projects、conversations、lagent 就绪状态、未读数。
3. 打开「对话」tab：若有会话显示列表；点开某条会话，拉取 `/api/mobile/conversations/:id`。
4. 对可见轮次的每个 ticket 拉取 `/api/mobile/tickets/:id`，得到报告与 `activity`。
5. 用户输入并发送：
   - 新会话先 `POST /conversations`（带 projectId），再 `POST /messages`。
   - 已有会话直接 `POST /messages`。
6. 服务端启动受管回合，SSE 推送 activity 与状态。
7. 手机合并实时步骤，刷新受影响 ticket 详情与会话摘要。
8. 完成后显示助手结论；用户可查看文件、任务详情或继续追问。
9. 切到后台时 SSE 断开；回到前台重新建立连接，并刷新当前会话、会话列表与未读数。

## 代码落点

### 后端

- `server/mobile-gateway.js`
  - 新增 `sanitizeMobileProject`、`sanitizeMobileConversationSummary`、`sanitizeMobileConversation`、`sanitizeMobileTurn`、`sanitizeMobileActivity`、`sanitizeMobileSettings`、`sanitizeMobileModels`。
  - 扩展 `sanitizeMobileBootstrap` 与 `sanitizeMobileDetail`。
  - 扩展 `mobileWorkEvent`。
  - 在 `registerMobileWorkRoutes` 注册新路由；增加 `executors` 参数用于协作方校验。
- `server/work/routes.js`
  - 调用 `registerMobileWorkRoutes` 时传入执行器注册表。
- `server/app.js`
  - 不改鉴权；新增路由自动继承 `/api` 的 no-store 与来源校验。
- `server/work/report-text.js`（新增）
  - 抽出服务端报告正文优先级：`acp.text → cli.summary → window.text → report.summary → summary`。
  - `engine`、移动裁剪函数与 `reportText(id)` 共用同一套逻辑，避免移动端和桌面端结论不一致。
- `server/work/conversations.js` / `server/work/engine.js`
  - 轮次保存 `clientRequestId`（仅内部，不对外投影）。
  - `startManagedTurn` 建轮次前按 `clientRequestId` 查重，命中则返回已有轮次与工单。
  - `conversationMessage / startManagedTurn / buildManagedSteps / managedExecutorInput` 增加可选 `efforts` 映射：没有映射时保持现有全局 `effort` 行为，桌面端不受影响；有映射时按 Agent 取值，缺失的协作方用 `default`。
  - 新增 `reportText(id)`：与 `conversationRunReport` 使用同一 artifacts 优先级返回完整报告正文。
  - 这是本设计需要触碰会话核心的全部改动，其余全部复用现有方法。

### 前端

- `src/mobile/MobileApp.tsx`
  - 保留配对、bootstrap、SSE、tab 外壳、设置页。
  - 新增「对话」tab；进入会话时隐藏底部导航。
  - 设置页底部说明改为「可为会话选择 Lagent 模型与各 Agent 思考强度；仍不能管理凭据、策略或项目」。
- `src/mobile/MobileChat.tsx`（新增）
  - 会话抽屉、消息流、输入区、模型弹层、协作 Agent 弹层、项目弹层、重命名/删除菜单。
- `src/mobile/MobileThinking.tsx`（新增）
  - 思考块、步骤渲染、Agent tab、权限操作、实时合并。
- `src/mobile/MobileTickets.tsx`（新增）
  - 从现有 `MobileApp.tsx` 抽出 `TicketDetail / TicketFiles / FilePreviewSheet / PdfPages` 等，保持行为不变。
- `src/mobile/MobileCommand.tsx`（新增）
  - 从现有 `CommandView` 抽出工具直连表单，去掉 Agent 选项。
- `src/mobile/mobile-api.ts`（新增）
  - 抽出 `mobileRequest`，补齐会话、模型、权限接口类型。
- `src/mobile/types.ts`（新增）
  - 移动端数据类型。
- `src/mobile/mobile-chat-model.ts`（新增）
  - 纯函数：会话分组、活动合并去重、设置白名单、分页游标、模型选项过滤。便于单测。
- `src/mobile/mobile.css`
  - 新增抽屉、消息气泡、思考块、输入区、模型/Agent/项目弹层样式；沿用现有 `--surface-* / --text-* / --line` 变量。

### Android

- 不改 `mobile/android`。
- `window.LagentDownload` 桥接保持。

## 本地存储键

| 键 | 用途 |
|---|---|
| `lagent:mobile:device:v1` | 设备凭证（现有） |
| `lagent:mobile:chatmodel:v1:<conversationId>` | 每个会话的 `{ profileId, effort, efforts }` |
| `lagent:mobile:chatmodel:last:v1` | 新会话默认 `{ profileId, effort, efforts }` |
| `lagent:mobile:newproject:v1` | 新会话默认项目 |
| `lagent:appearance:boot:v1` | 主题（现有） |

## 测试计划

### 服务端

在 `server/mobile-gateway.test.js` 或新增 `server/mobile-conversations.test.js`：

1. 未带设备 token 访问新接口返回 401；设备 token 访问 `/api/work/*` 仍返回 401。
2. owner 隔离：A 设备看不到 B 的会话；跨 owner 操作返回 404/401。
3. `sanitizeMobileBootstrap` 下发 projects/conversations/lagent，且不含凭据、API Key、Base URL。
4. 会话列表、创建、详情、重命名、删除的完整链路。
5. 会话详情分页：`limit`、`before`、`hasMore`、`nextBefore` 正确；tickets 只包含可见轮次。
6. 单 Agent：`mode:auto` + 任意 agentIds 都会被强制为 `['model']`。
7. 多 Agent：必须至少一个协作方；拒绝工具类执行器；最多 3 个协作方。
8. 设置白名单：`permission:'full'` 与 `model` 被丢弃；非法 `profileId` 返回 400；`effort` / `efforts[*]` 非法返回 400。
9. 工单详情包含裁剪后的 `activity`；`requestId`、`decided` 保留；报告 `text` 使用 artifacts 优先级、默认不超过 20,000 字并带 `truncated` 标记。
10. SSE `mobileWorkEvent` 包含裁剪后的 activity，不泄漏额外字段。
11. 权限决定：allow/deny 生效；过期 requestId 返回 404。
12. 模型接口不返回 credentials/pools/vault/baseUrl；不可用配置档标记 `available:false`。
13. 现有 `/api/mobile/command`、文件预览、通知、配对、撤销测试保持通过。
14. 访问不存在的会话返回 404；删除后再访问也返回 404。
15. 相同 `clientRequestId` 重复发消息只产生一轮、不重复建工单；单 Agent 与多 Agent 各测一次。
16. 按 Agent 的 `efforts` 映射生效：Lagent 与每个协作方拿到各自的 effort；未提供条目的协作方用 `default`；不属于当前 agentIds 的键被丢弃；没有 `efforts` 时保持旧的全局 effort 行为。
17. 报告全文接口：20,000 字预览截断时 `truncated:true`；`/reports/:id/text` 返回完整正文且不超过 200,000 字；跨 owner/不存在返回 404。

### 前端

- `src/mobile/mobile-chat-model.test.mjs`：
  - 会话按今天/昨天/更早分组。
  - activity 合并去重。
  - 设置白名单过滤 `permission` / `model`。
  - 按 Agent 的 `efforts` 映射合并与清理（取消勾选时移除该 Agent 的强度）。
  - 分页游标计算。
  - 模型/强度选项过滤：Lagent 按 capabilities，协作方全档位。
- `npm run build`（tsc + vite）通过。
- `npm test` 全绿。

### E2E

在 `e2e/mobile-command.spec.ts` 基础上新增 `e2e/mobile-chat.spec.ts`，mock 移动接口：

1. 配对 → 打开对话 → 新会话选择项目 → 发送单 Agent 消息。
2. 思考块展开、实时步骤追加、完成后收起。
3. 切多 Agent → 未选协作方时发送禁用 → 勾选两个 Agent 并分别设置不同强度 → 发送后请求体包含 `efforts` 映射。
4. 打开历史会话、加载更早、重命名、删除。
5. 模型弹层选择 Lagent 配置档与强度，发送后请求体包含 `settings` 且不含 `permission`。
6. 权限步骤点「允许一次」，调用正确接口。
7. 报告被标记 `truncated` 时，点「展开全文」请求 `/reports/:id/text` 并替换气泡正文。

同时更新既有移动端 E2E：

- `e2e/mobile-command.spec.ts` 改为：从抽屉进入「工具指令」，执行终端命令并打开任务详情。
- `e2e/handoff.spec.ts` 保持从底部导航进入「任务」；确认默认 tab 变为「对话」后导航仍可点击。

## 验收清单

- [ ] 手机 `/m` 默认进入「对话」，能看到会话列表与消息流。
- [ ] 新建会话可选工作文件夹；创建后只读显示。
- [ ] 单 Agent 发送后能看到用户气泡、思考块、助手结论。
- [ ] 多 Agent 必须手动勾选协作方；最多 3 个；每个勾选的 Agent 可单独设置思考强度。
- [ ] 思考过程实时追加；完成后自动收起；可手动展开。
- [ ] 多 Agent 思考块可按 Agent 切换。
- [ ] 权限步骤可在思考块内允许/拒绝；失效时提示并刷新。
- [ ] 顶部模型 chip 可切换 Lagent 的模型与强度；运行中切换提示「下一轮生效」。
- [ ] 模型列表不显示不可用项为可选；不出现凭据/Key/Base URL。
- [ ] 报告超过 20,000 字时显示「展开全文」，能加载到完整正文（最多 200,000 字）。
- [ ] 会话列表按今天/昨天/更早分组；可重命名、删除。
- [ ] 长会话默认 30 轮，可加载更早。
- [ ] 发送失败保留草稿，可幂等重试。
- [ ] 旧 APK 的 `/api/mobile/command`、收件箱、任务、设置、文件预览下载不回归。
- [ ] `npm run build`、`npm test`、新增 E2E 通过。

## 兼容与回滚

- 新接口全部是增量，旧 APK 不调用即不受影响。
- `bootstrap` 只增加字段，旧前端忽略未知字段。
- 不改数据库结构；会话与工单仍使用现有实体。
- 若需回滚，只需恢复 `src/mobile/MobileApp.tsx` 并停止使用新路由；服务端新增路由可保留。

## 实施顺序

1. 服务端裁剪函数 + 新路由 + SSE 扩展；引擎增加 `efforts` 映射、轮次幂等与 `reportText`；补单元测试。
2. 前端抽出 `MobileTickets / MobileCommand / mobile-api`，保持旧界面行为。
3. 新增 `MobileChat / MobileThinking`，接入会话列表、消息流、思考、发送。
4. 模型/Agent/项目弹层与会话管理。
5. E2E 与手工验收。
6. CHANGELOG 更新。
