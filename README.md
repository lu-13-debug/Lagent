# Lagent

面向个人与小团队的 **多 Agent 指挥台**：连接 Claude Code、Codex、DeepSeek Harness 等本机 Agent，接收一个项目和任务后拆解成步骤，把任务要点分派给不同 Agent 执行，并把每次修改沉淀为项目档案，让任何 Agent 只读这一处就能了解「项目改了什么、接下来做什么」。

Windows 桌面客户端既可连接可部署的云端账号服务，也可连接本机服务 `http://127.0.0.1:3001`；连接云端时注册登录后使用自己的项目、对话与审批记录，连接本机时直接使用本地工作台。

当前账号版：**1.2.0**。源码：[lu-13-debug/Lagent](https://github.com/lu-13-debug/Lagent)。1.0.0 为原本地单用户版，发布历史保留。

> **界面定位**：主界面只有 Agent 指挥与项目协作。原有的数据分析/报告/额度网页入口已移除；对应的服务端工作流与接口仍然保留，供 API 调用与测试使用。

## 账号服务与部署

账号版需要一个持续运行的服务。用户可注册、登录、退出和修改密码；同一服务内的每个账号拥有独立的数据、报告、非敏感模型配置和试用额度。用户名不区分大小写，显示名称支持中文。

先完成本机验证：

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run cloud
```

打开日志中的地址（默认 `http://127.0.0.1:3002`），或让桌面客户端连接它。对外服务请部署到有域名与 HTTPS 的服务器，详见 **[云端部署说明](docs/cloud-deployment.md)**。提供 Dockerfile、Compose、Caddy 与持久化/备份配置；当前代码交付不代表已在公网部署账号服务。

首次部署可直接跟随 **[服务器部署与 HTTPS 从零教程](docs/ubuntu-https-guide.md)**：Ubuntu 24.04 → Docker → 域名 A 记录 → `.env` → Caddy 自动证书 → Windows 客户端，附验证命令和排错。

云端密码使用随机盐散列，登录凭据使用 HttpOnly Cookie。旧会话模式的 API Key 只保留在内存，退出或服务重启后需重新填写；新版持久凭据库见文末配置说明。上传数据和报告保存在所连接的服务器。每次云端模型请求仅向用户指定且管理员已允许的供应商发送业务背景与聚合指标。

## Windows 桌面版

从 [发布页](https://github.com/lu-13-debug/Lagent/releases) 下载账号版 `Lagent-Setup-1.2.0-x64.exe`，或从源码构建到 `release/`。支持 Windows 10/11 的 x64 系统；双击安装，可选择目录，安装后从桌面或开始菜单打开 **Lagent**。桌面版内置运行时，无需安装 Node.js。它既能连接云端账号服务，也能连接本机 `http://127.0.0.1:3001`（需先启动本机服务，或在连接页填入该地址）。

首次打开连接管理员提供的 HTTPS 服务地址，随后注册或登录。可在打包前通过 `build/cloud-config.json` 预置服务地址。云端工作台需要联网，菜单支持切换服务并清理原服务会话。旧版 `%APPDATA%\Lagent\storage` 中的本地数据保留，不会自动归到任何云端账号。

从源码运行和打包桌面版：

```powershell
npm.cmd install
npm.cmd run desktop:dev
npm.cmd run desktop:build
```

`desktop:build` 生成完整 NSIS 安装包，安装本身不需要另行下载应用资源；连接云端服务时使用账号，连接本机服务（`http://127.0.0.1:3001`）时直接进入本地工作台。当前安装包未配置商业代码签名。生成安装包后可用 `powershell -ExecutionPolicy Bypass -File scripts/create-desktop-shortcut.ps1` 创建带「自动启动本机服务」的桌面快捷方式。

## 原单用户本地入口（开发与离线计算）

需要 Node.js 24 或更高版本。这个入口不提供注册登录，适合本机开发与原版数据查看，不应直接对外提供多用户访问：

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

打开 <http://127.0.0.1:3001>。Windows 也可以双击根目录 `启动 Lagent.cmd`，它会检查依赖、构建并启动服务。

开发模式：

```powershell
npm.cmd run dev
```

前端 <http://127.0.0.1:5173>，后端 <http://127.0.0.1:3001>。Ctrl+C 停止。

## 两种工作方式

- **协作模式**：在分析计划和报告生成前暂停。可补充业务背景，确认后继续；确认请求带步骤标识，防止延迟重试误批准下一阶段。
- **自动模式**：确认任务范围后，运行既定分析流程，产出报告。
- 右侧展示真实节点状态、调用能力、结果摘要和执行记录。
- 执行中可停止任务；已冻结的服务额度会释放。完整报告支持 Markdown 下载与打印/保存 PDF。

## 指挥台：接入外部 Agent（ACP / MCP）

指挥台（`/api/work/*`）默认启用；只有显式设置 `LAGENT_WORK_ENABLED=0` 才会关闭接口。接入外部 Agent 还需要 `LAGENT_ALLOW_EXTERNAL_EXECUTORS=1`，并在「设置 → 执行器策略」中勾选对应执行器。

**主界面**：左侧存放对话记录与功能入口（指挥台、项目、团队、运行、工具、记忆、设置），右侧上方是 Agent 的思考与执行流，输入框固定在底部。派活方式只有两种：**单 Agent** 只由内置 Lagent 理解、执行并交付；**多 Agent** 由 Lagent 先拆解并分发，协作 Agent 各自执行后按环状互相验收，最后由 Lagent 汇总。外部 Agent（含窗口 Agent）最多 3 个，不能绕过 Lagent 主控；未配置模型时发送会被阻断。任务明显简单时，界面会用本地规则提示「仅用 Lagent 完成」，不会额外调用模型。所有 Agent 的思考过程与结论默认要求使用简体中文。数据分析执行器作为内置工具保留，派活前需要先选择数据集。

**报告与工单**：工单页是执行记录与审批索引；报告页按会话聚合最近结论与产物，可预览并导出 Markdown，不再只是会话列表的另一个入口。项目文件夹里的旧对话在打开时会惰性并入同一条 Lagent 会话，原有 CLI session 与窗口绑定保留在隐藏执行对话里。

**项目文件与产物**：项目页的「文件」页签是文件树 + 预览，支持 Markdown、PDF、Word、PPT、HTML、CSV/Excel、图片与代码；「产物」页按变更档案聚合 Agent 写过的文件，点开即可查看或下载。文件访问限制在项目目录内，隐藏目录与 `.env`、密钥等敏感文件不返回内容，HTML 在沙箱 iframe 中打开。

**ACP（推荐）**：统一驱动 Claude Code、Codex、DeepSeek Harness。

```bash
npm i -g @agentclientprotocol/claude-agent-acp   # Claude Code
npm i -g @agentclientprotocol/codex-acp          # Codex（可选）
npm i -g dsh-acp                                 # DeepSeek Harness（需 DEEPSEEK_API_KEY）
```

安装后重启服务，Agent 页的「本机 Agent 探测」会显示版本与登录状态，执行器列表出现对应 ACP 执行器。DSH ACP 还需要在启动服务的环境里设置 `DEEPSEEK_API_KEY`。也可用 `LAGENT_CLAUDE_ACP`、`LAGENT_CODEX_ACP`、`LAGENT_DSH_ACP` 指定自定义命令。ACP 默认只读；项目工单在「可写入」模式下（`executorInput.write: true`）且策略允许时，文件读写被限制在项目目录内，每次文件权限请求仍需在活动流里确认，30 秒未处理自动拒绝；终端类请求始终拒绝。

**MCP（反向控制）**：让外部 Agent 读取和操作本机工作台。

```bash
claude mcp add --transport http lagent http://127.0.0.1:3001/api/mcp \
  --header "Authorization: Bearer <在设置页生成的令牌>"
```

令牌在「设置 → MCP 外部 Agent」生成，可在手机设备列表中撤销。可用工具：工单列表/详情、报告摘要、执行器列表、计划列表与创建、下达指令、审批、窗口列表与发送。

**窗口兜底**：没有协议入口的桌面 Agent，可用窗口 Agent 直接向白名单进程窗口键入指令并读取输出；窗口句柄变化时会按进程与标题自动刷新并重试一次。白名单默认包含 codex、ChatGPT、claude、WindowsTerminal、wt、opencode、DSH Desktop、DeepSeek Harness、DeepSeek，可用 `LAGENT_WINDOW_PROCESSES` 覆盖。运行中的 DeepSeek Harness 桌面版会被「本机 Agent 探测」识别为可用（不需要 `dsh` 命令或 ACP 适配器），直接选左下方的「窗口 · DeepSeek Harness」即可。窗口 Agent 会优先定位底部的会话输入框并排除搜索框；窗口不在会话页、或输入框里已有未发送草稿时明确拒绝，不会把指令打进搜索栏或覆盖草稿。发送后默认轮询 30 秒等待新输出，可用 `LAGENT_WINDOW_WAIT_MS` 调整。

**WorkBuddy 桌面端**：WorkBuddy 属于外部执行器，启动 Lagent 时需设置 `LAGENT_ALLOW_EXTERNAL_EXECUTORS=1`，再到「Agent」页打开 WorkBuddy 开关，之后新对话里就能像其它 CLI 一样给它派任务。执行器通过 Chromium 调试端口驱动 WorkBuddy 界面：新建任务、填入提示词、点击发送，再按消息帧状态等待完成并把回复写回工单摘要。WorkBuddy 未运行时 Lagent 会自动带调试端口拉起；已经在运行但没开端口时会提示先退出重启，不会强行结束正在使用的进程。端口与超时可用 `LAGENT_WORKBUDDY_PORT`、`LAGENT_WORKBUDDY_TIMEOUT_MS` 调整，安装路径用 `LAGENT_WORKBUDDY_EXE` 覆盖。

## 项目工作区：导入本地文件夹与已有会话

「项目」页把本地文件夹接入指挥台，让 Agent 在真实项目里干活：

- **导入文件夹**：桌面版点「导入文件夹」调用系统目录选择器；浏览器版打开内置文件夹选择器，可浏览盘符与子目录，也可手动输入绝对路径。拒绝相对路径、磁盘根目录与系统目录，只保存软件内记录，不复制、不移动文件。
- **接管已有会话**：扫描 `~/.claude/projects/<编码目录>/` 与 `~/.codex/sessions/`，只列出 `cwd` 匹配该项目的会话；导入后对话绑定原 `sessionId`，后续消息用 `--resume` / `exec resume` 在同一会话里续接。
- **新建项目对话**：选 Claude Code、Codex 或窗口 Agent。前两者以项目目录为工作目录、默认写入模式运行；窗口 Agent 绑定一个已打开的白名单窗口。
- **发送与拆解**：输入消息或点「拆解并执行」生成计划，都会先落到待确认工单；批准后才执行，完成后把 CLI 的 `sessionId` 与摘要回写到项目对话，成为下一条消息的续接点。
- **跨 Agent 分派**：一个计划里每一步可以指定不同 Agent——例如第一步 Claude Code 读代码，第二步 Codex 复核。项目中已有对应 Agent 的对话时直接复用；没有时在创建计划时自动补建项目对话。窗口 Agent 需要先在项目里创建并绑定窗口对话。规划模型不可用时，可用「手动编排计划」逐条填写步骤与 Agent，不依赖规划模型。
- **同一任务交叉验证**：不拆步骤时，在首页多选多个 Agent 并行建单，各自给出独立结论，再选一个 Agent 汇总一致点与分歧点。

### 项目变更档案

项目页的「档案」标签集中存放这个项目的修改记录与任务要点，新接入的 Agent 只读这一处就能接手：

- **项目简报**：目标、当前进展、任务要点、关键决定、约束，可直接在界面编辑保存。
- **变更时间线**：工单完成或失败时自动记录标题、摘要、执行器、会话 ID、状态；项目是 Git 仓库时还会附带 `git status --porcelain` 的改动文件列表（采集失败不影响工单）。也可以手动补充条目。
- **Markdown 导出**：`GET /api/work/projects/:id/brief.md` 返回完整文本；MCP 工具 `work_project_brief` 让外部 Agent 直接读取，`work_record_change` 用于回写修改。
- 删除项目时，简报、变更记录与项目对话一并清理，不影响 Agent 端的会话文件。

命令：`npm run dev` 会同时启动前端与后端，并默认设置 `LAGENT_ALLOW_EXTERNAL_EXECUTORS=1`（显式传 `=0` 可关闭）；正式部署仍按上一节设置环境变量。注意：CLI 执行器是一次性进程，不会在 Claude Code / Codex 桌面端自动打开该会话；软件内的项目对话只维护会话 ID 与消息记录。

### 协作与自动化（P1）

「设置 → 协作与自动化」集中管理以下能力，后端接口在 `/api/work/*`：

- **Library 同步**：把项目简报、约束、决定与项目记忆写入 `CLAUDE.md`、`AGENTS.md`、`.cursor/rules/lagent.mdc`，可选合并 `.mcp.json` 的 Lagent 服务。只替换 `<!-- lagent:begin -->` / `<!-- lagent:end -->` 托管块，保留用户内容；每次写入前备份到 `.lagent/library/backups/`，可一键回滚。路径被限制在项目目录内，拒绝 `.git`、`.ssh`、密钥与 `.env`。
- **例行任务**：固定间隔、每天定时、手动、签名 Webhook、Git 提交或项目内文件变化触发，默认只生成「待确认」建议工单；只有策略未要求审批时，`auto` 模式才会自动批准。Git 触发只比较 HEAD，文件触发只比较修改时间与大小，不读取内容；不能监视 `.git`、`.ssh`、密钥或 `.env`，并支持防抖。Webhook 令牌只在创建/轮换时显示一次，数据库只存哈希。定时调度可用 `LAGENT_WORK_ROUTINES=0` 关闭。
- **Key 池**：同一提供商、接口地址下的多把 Key 按优先级、加权轮询、最少失败或最低成本选择；429/5xx 自动换 Key，401/403 隔离当前 Key，支持每日配额、冷却与缓存亲和。成员只保存凭据 ID，不复制明文。
- **MCP 客户端**：内置模型 Agent 可连接你显式添加的 stdio MCP 服务器，工具以 `mcp__服务器__工具` 暴露；命令限制为 node/npx/python/uvx 等，环境变量只透传安全白名单。项目 `.mcp.json` 默认不读取，需 `LAGENT_MCP_PROJECT_CONFIG=1`；`LAGENT_MCP_CLIENT=0` 可整体关闭。
- **IM 通知与远程审批**：支持 Slack、Teams、飞书、企业微信、钉钉和通用 Webhook。审批链接格式 `v1.<ticketId>.<action>.<expiresAt>.<nonce>.<hmac>`，24 小时有效、只能使用一次，打开后还需在确认页再点一次；没有未签名审批入口。Webhook 地址与签名密钥不回显。审批链接需要设置 `LAGENT_PUBLIC_URL` 或用渠道的「外部访问地址」。
- **团队房间**：聚合计划步骤、工单状态、报告、消息、认领与决定日志；执行仍复用计划与工单，不另起调度。
- **实时观察与接管**：对白名单窗口每秒截取一帧（仅保留内存，不落盘）。标题出现支付、银行、密码、验证码、身份证、钱包、OTP 等敏感词时立即暂停并清空画面；点「我接管」立即停止截图。`LAGENT_LIVE_VIEW=0` 可关闭，`LAGENT_LIVE_INTERVAL_MS` 调整间隔（800–5000 毫秒）。

## 数据分析接口（无网页界面）

数据分析工作流、报告导出与额度接口仍完整保留在服务端与测试中，供 API 调用；网页界面已移除，仓库不再包含对应的前端组件。指挥台里的「数据分析」执行器仍可对已上传数据集派活。

首次运行生成一份清楚标注的演示数据和计算报告，方便无 Key 体验。演示数据不代表真实业务。

支持 UTF-8 CSV、XLSX；最多 3 个文件，合计不超过 20MB、200000 行。Excel 可使用多个工作表，或按标准表分别上传 CSV。应用内可下载模板。

| 标准表 | 字段 |
| --- | --- |
| users | user_id, registered_at, channel（可选） |
| activity | user_id, event_time |
| payments | order_id, user_id, paid_at, amount, currency, status |

支持常见中文别名。无时区时间和 Excel 原生日期单元格按 Asia/Shanghai 处理；显式 ISO 时区保持绝对时间语义。建议使用 `2026-10-01T10:00:00+08:00`。玩家 ID 应是同一口径的账号标识。金额非负、最多两位小数；币种使用 CNY/USD 等代码；支付状态使用 success/paid/completed 等成功状态。冲突订单、无效时间与混合币种会明确拒绝。

只上传部分表也可分析；缺表或观察窗口不足的指标显示无数据，不推断留存或收入。不同数据表的覆盖差异会进入质量提示。历史文件的覆盖边界依据首末事件推断，系统无法完全区分零事件日和漏传日，正式决策前应确认采集完整性。当前自然日不进入完整日指标。

## 模型与 Key

不装任何命令行 Agent 也能干活：在「设置 → 规划设置」里选好默认可用的模型后，列表里会多出一个内置的**模型 Agent**。它自己读文件、搜代码、跑只读的 git 命令，需要改文件时再申请写权限（执行器策略里的「模型 Agent 可写项目文件」，默认关闭），每一步的工具调用与结果都会像看 dsh 一样实时出现在对话里。

打开「模型与 API 设置」，先填写 API 地址和对应的 Key。输入停顿后自动读取供应商的模型列表，选择模型，再测试连接并保存。仅返回一个模型时自动选中；列表不支持或权限不足时，可以重新检测或手动填写完整模型 ID。检测只读取目录，不发起模型生成；测试连接会产生一次有上限的模型调用。

支持基础地址与完整 Chat Completions 地址，官方 OpenAI / Claude 根地址会补齐 `/v1`。DeepSeek Flash 的连接测试关闭思考模式，避免短测试只返回推理；其他推理模型若只返回推理，会提示“接口已连接，测试未生成最终答案”，正式报告仍要求完整最终文本，不把推理当作报告。更换 API 地址后需要重新填写对应的 Key，防止旧凭据被自动发送到新的接口。

账号服务默认允许以下三家的官方主机。模型名称填写你在对应供应商账户中有权限使用的完整模型 ID，Key 与供应商保持一致：

| 供应商 | API 地址 | 官方文档 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | [DeepSeek API](https://api-docs.deepseek.com/) |
| Claude（Anthropic） | `https://api.anthropic.com/v1` | [Chat Completions 兼容接口](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) |
| OpenAI | `https://api.openai.com/v1` | [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) |

允许的是供应商主机，不限制这些主机下的模型名称；模型是否可用取决于供应商支持和你的 API 账户权限。Claude 兼容接口使用 Anthropic 的 API Key；需要额外工作区请求头的非工作区密钥暂不支持。配置环境变量 `LAGENT_MODEL_HOSTS` 会替换默认列表，显式空值会关闭 AI；已有部署如果配置为空，需要改为上述主机列表并重启服务。本机 PowerShell 可执行：

```powershell
$env:LAGENT_MODEL_HOSTS='api.deepseek.com,api.anthropic.com,api.openai.com'
npm.cmd run cloud
```

在原服务终端先按 Ctrl+C 停止，再执行以上命令；重新打开客户端即可读取白名单。桌面端加载服务提供的页面，这项服务端更新无需重新安装 EXE。

### 供应商目录

「模型与 API 设置」顶部是供应商目录，预置 30 家，点击即填入名称、地址、协议和示例模型，只需要再补 Key：

- **国产模型（14）**：DeepSeek、月之暗面 Kimi、智谱 GLM、通义千问（DashScope 兼容模式）、腾讯混元、火山方舟豆包、百度文心千帆、MiniMax、讯飞星火、阶跃星辰、百川智能、零一万物 Yi、硅基流动、魔搭 ModelScope。
- **国外模型（13）**：OpenAI、Claude（Anthropic Messages）、Google Gemini（OpenAI 兼容端点）、xAI Grok、Mistral、Groq、OpenRouter、Together、Fireworks、Cerebras、DeepInfra、OpenCode Go / Zen 套餐。
- **本地服务（3）**：Ollama、LM Studio、vLLM 或自建 OpenAI 兼容服务（本机地址允许 http）。

目录只是「填表助手」，不限制你能填什么：任何 OpenAI 兼容地址都可以手动填写。示例模型名仅用于预填，实际可用的模型以「重新检测」结果为准；检测不到时会退回到目录里的常见型号供你挑选，也可以手动填写完整模型 ID。推理类模型（`deepseek-reasoner`、`gpt-5.x`、`o3`、`*-thinking` 等）会自动省略 `temperature` 等采样参数，避免第三方兼容接口报错。目录数据在 `src/model-providers.json`，新增供应商只需加一条。

保存凭据后会自动用这条 Key 读一次模型列表（只读 `/models`，不产生模型调用费用），结果直接显示在凭据卡片上；到「模型配置」里选中这条凭据时也会自动再识别一次，识别到的模型可以直接从下拉框选，不必手抄模型 ID。供应商没实现 `/models` 或 Key 权限不足时，会提示原因并列出目录里的常见型号。

云端账号版仍然受服务端主机白名单限制（`LAGENT_MODEL_HOSTS`）：目录里未被管理员允许的主机会显示「未开放」，此时需要先调整白名单再重启服务。本地单用户入口不受此限制。


- 旧会话模式的云端 API Key 只保留在当前登录会话的服务端内存，不写入数据库、浏览器存储或日志；退出或重启后需要重新填写。原单用户入口的 Key 保留在本机服务进程内存。
- 系统向用户指定的供应商发送分析目标、主动提供的业务背景和聚合指标，不发送原始玩家 ID 明细。
- 模型费用由供应商从你的 API 账户扣除，与服务额度独立。
- 模型失败会使任务明确失败并释放服务额度，不会静默换供应商或冒充 AI 成功。
- AI 解读属于辅助观察与待验证建议。代码核验的是计算指标和数值边界，无法保证所有自然语言判断正确，不据时间相关性认定因果。

## 额度、持久化与部署边界

云端账号版支持注册登录与个人空间隔离，尚未接入真实支付、邮箱找回或组织权限。每个新账号初始 500 试用额度，每次任务冻结 20；完成结算，失败/取消释放。示例历史报告不收费。账本由服务端持久化，客户端不能上报扣费结果。

云端账号库与各用户工作空间分开保存；可使用 `LAGENT_DATA_DIR` 指定持久化目录，容器中为 `/app/data`。原单用户入口仍使用根目录 `data/`。服务重启时，未完成任务标记中断并释放额度，已完成报告保留。不要将运行数据提交到 GitHub。

账号服务按单实例 SQLite 部署，内置认证、会话、同源检查与用户隔离；生产需配置 HTTPS 的 `PUBLIC_URL` 和可信模型主机白名单，并按部署说明备份数据。不要将原单用户入口暴露公网，也不要把本版作为多副本集群运行。正式收费仍需另外接入支付和运营流程。

## 云端手机号验证与加密备份

设置 `LAGENT_REQUIRE_PHONE=1` 后，云端注册必须使用手机号+短信验证码；存量账号登录后会被引导绑定手机号；密码登录在新设备上需要短信验证码，可信设备 30 天内免验证。验证码 6 位、5 分钟有效、一次性使用，按手机号/网络/设备限流；接口只返回掩码手机号，验证码与完整号码不写日志。短信供应商通过 `LAGENT_SMS_PROVIDER` 选择 `http` 或 `aliyun`，未配置时发送接口明确返回 503；`mock` 仅用于开发测试，生产默认禁用。本地单用户入口与桌面版不加载手机号验证。多实例部署必须配置同一 `LAGENT_PHONE_SECRET`。

「设置 → 加密备份与诊断」可一键导出 AES-256-GCM 加密的 SQLite 快照（可选排除凭据密文），使用同一口令恢复；诊断包只含版本、运行环境、数据统计、策略与环境变量名，不含密钥值。定时备份由 `LAGENT_BACKUP_INTERVAL_HOURS`、`LAGENT_BACKUP_DIR`、`LAGENT_BACKUP_PASSPHRASE` 控制，口令不写入数据库。备份口令遗失后无法恢复，请与主密钥分开保管。

同页的「作用域 MCP 令牌」支持绑定项目、只读/可写、工具白名单、调用与 Token 预算、并发上限、有效期与撤销；越权调用返回 403 并写入脱敏审计。成本中心可按项目/会话/执行器/天汇总 Token、缓存命中与费用，导出 CSV，并可扫描 `~/.claude/projects` 与 `~/.codex/sessions` 的历史会话用量（只读用量字段，不读取正文）。

## 验证

```powershell
npm.cmd test
npm.cmd run build
```

覆盖指标手算、订单去重、留存成熟度、CSV/XLSX、额度事务、协作确认、防重、取消/重启、模型成功/失败和凭据保护。真实付费供应商未使用用户 Key 联测；模型集成使用可控响应验证。

浏览器验收脚本位于 `scripts/browser-check.mjs`，需本机 Edge 和 Playwright。可将 Playwright 模块绝对路径作为第一个参数传入，不影响日常启动。

1.2.0 已通过全量单元测试与端到端验收、生产构建和安装包安装验证。容器部署配置已提供；公网服务器、DNS 与证书需要按部署教程自行验证（当前维护环境没有 Docker 引擎，未做公网实测）。显卡与付费模型供应商未联测，安装包未配置代码签名。可选复验命令：

```powershell
node scripts/desktop-smoke.mjs release/win-unpacked/Lagent.exe
node scripts/desktop-check.mjs <Playwright模块路径> release/win-unpacked/Lagent.exe
```

安装包的 SHA256 位于 `release/SHA256SUMS.txt`。首版提供 8 个内置 Skill 节点，按预定义工作流执行；新增领域、节点或分支可在源码注册。「技能与插件」页支持从推荐清单或 GitHub 仓库预览、安装、启停和更新 Skill，插件市场通过本机 Claude Code CLI 安装与更新；当前没有可视化工作流编辑器。

## 代码结构

```text
src/                  React 页面、报告、工作动态与弹窗
server/               数据解析、指标计算、工作流、账本、模型网关与测试
scripts/              开发启动与浏览器验收
desktop/              Windows 桌面主进程与运行验收
release/              Windows 安装包与校验文件（构建生成）
docs/api-contract.md  前后端接口
docs/orchestrator.md  内置 Agent 的深度编排（拆解、分派、验证、返工）
docs/superpowers/     设计与实施记录
data/                 本地运行数据（自动生成，不进入版本控制）
```

新增领域时，扩展领域注册信息、数据规范、指标实现和 Skill 工作流。当前仅开放游戏运营，其他领域入口明确标注尚未开放。


## 多模型与阶段 Skill 工作流（源码新增）

在「模型与 API 设置 → 模型中心与工作流」中依次保存凭据、添加模型配置、选择工作流默认模型，再为各阶段指定 Skill、模型、思考强度和预算。支持同供应商多组 Key，一个 Key 可供多个模型配置使用。原会话 Key 设置仍保留；关闭阶段工作流可使用旧模式。

云端管理员需配置 `LAGENT_CREDENTIAL_MASTER_KEY`（32 字节随机值的 base64），才能启用持久凭据库。密钥通过 AES-256-GCM 加密存储，绑定账号、接口、协议和版本；正常退出和服务重启后仍保留。主密钥缺失时明确禁用持久保存，绝不退回明文。主密钥应独立备份；掌握主密钥的服务管理员可以解密，这不是端到端加密。

本机单用户入口（`npm run dev`、桌面版）不需要手动配置：首次启动会在数据目录生成 `credential-master-key`（32 字节 base64，仅当前系统用户可读），用于启用凭据库和阶段模型。它和数据本身放在同一台机器上，防的是「误传、误备份」而不是拿到磁盘的人；要更强的隔离就显式设置 `LAGENT_CREDENTIAL_MASTER_KEY` 并自己保管。云端模式（`npm run cloud`）始终要求显式配置。


工作流包含质量、计划、处理、活跃、留存、商业化、渠道、周内规律、绘图、洞察、报告、核验和 PDF 共 13 阶段。AI 阶段实际加载 Skill 并使用相应模型；PDF 由排版工具执行。未知模型只开放默认强度，已核实型号显示其支持的原生强度；mid 对应 medium。运行中显示阶段摘要、模型、Skill 版本和供应商实际返回的用量，不显示模型私有思维链。

内置 Python 命名工具提供描述统计、分组、相关/检验和五类图表。仅开放受控操作，不运行任意模型代码或 Shell。当前清洗工具提供非破坏性标准化预览，原始数据保持不变；删行、填补或改变业务口径不会自动执行。输入仍遵循现有领域数据规范。

服务端依赖安装：

```powershell
python -m pip install -r server/tools/requirements.txt
npm.cmd ci
npx.cmd playwright install chromium
```

可通过 `LAGENT_PYTHON` 指定 Python、`LAGENT_CHROMIUM_EXECUTABLE_PATH` 指定 Chromium/Edge。Dockerfile 已包含 Python、Chromium 和中文字体。桌面端连接云服务，不需用户安装这些工具。

报告页提供「下载 PDF」，生成中文 A4、图表和分页。首次 PDF 成功才结算新工作流任务；失败保留已核验报告并释放冻结额度。只重试 PDF 不再调用模型或重复结算。供应商已产生的模型费用不随软件额度释放而退还。

源码修改后需重新构建并重启自己的服务才生效；已有发布安装包和公网服务不会自动更新。没有使用用户真实 Key 进行付费供应商联测。


## 指标目录、版本确认与独立审查记录

游戏指标共用服务端目录，计算器提供真实指标期间与分母；例如DAU使用头条活跃日、ARPPU使用同期去重付费人数、成熟留存使用实际加权分母。未知或尚未支持的领域口径继续标为未确认。`GET /api/metric-catalog?domain=game`可读取目录。

新版多阶段任务确认必须携带当前approvalSnapshot。范围、背景、数据版本或有效产物变化后，旧确认返回409，刷新后由用户重新确认，不自动执行下一步；旧单模型路径保留兼容。

新任务记录数据来源hash、源文件/表/行数和映射，以及演示标记。网页及PDF展示独立审查回执，区分通过、有问题、未审查和禁用。生成PDF不代表完成视觉检查；当前没有自动调用额外付费视觉模型。

报告内容hash与PDF缓存和核验状态绑定，正文变化会阻止旧核验PDF下载。单位换算、舍入和百分点差可通过numeric-transform命名操作生成确定性证据及回执，AI随后引用新证据ID；不允许随意跨币种转换。

质量决定的基础模块保留理由、规则版本和原状态，仅允许处理指定待复核项；本版尚未提供通用人工清洗决策页面、任意分析方法插件或自动视觉审查服务。
