# DataAgent

面向个人与小团队的 **多 Agent 指挥台**：连接 Claude Code、Codex、DeepSeek Harness 等本机 Agent，接收一个项目和任务后拆解成步骤，把任务要点分派给不同 Agent 执行，并把每次修改沉淀为项目档案，让任何 Agent 只读这一处就能了解「项目改了什么、接下来做什么」。

Windows 桌面客户端连接可部署的云端账号服务，用户注册登录后使用自己的项目、对话与审批记录。

当前账号版：**1.1.0**。源码：[lu-13-debug/DataAgent](https://github.com/lu-13-debug/DataAgent)。1.0.0 为原本地单用户版，发布历史保留。

> **界面定位调整**：主界面现在聚焦 Agent 指挥与项目协作。原有的数据分析/报告/额度页面、快捷命令与执行器选项已从界面隐藏，服务端代码与测试完整保留；未启用指挥台（`DATAAGENT_WORK_ENABLED`）时仍会进入原数据分析界面。

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

从 [发布页](https://github.com/lu-13-debug/DataAgent/releases) 下载账号版 `DataAgent-Setup-1.1.0-x64.exe`，或从源码构建到 `release/`。支持 Windows 10/11 的 x64 系统；双击安装，可选择目录，安装后从桌面或开始菜单打开 **DataAgent**。桌面版内置运行时，无需安装 Node.js。

首次打开连接管理员提供的 HTTPS 服务地址，随后注册或登录。可在打包前通过 `build/cloud-config.json` 预置服务地址。云端工作台需要联网，菜单支持切换服务并清理原服务会话。旧版 `%APPDATA%\DataAgent\storage` 中的本地数据保留，不会自动归到任何云端账号。

从源码运行和打包桌面版：

```powershell
npm.cmd install
npm.cmd run desktop:dev
npm.cmd run desktop:build
```

`desktop:build` 生成完整 NSIS 安装包，安装本身不需要另行下载应用资源；账号、数据分析和模型调用需要连接云端服务。当前安装包未配置商业代码签名。

## 原单用户本地入口（开发与离线计算）

需要 Node.js 24 或更高版本。这个入口不提供注册登录，适合本机开发与原版数据查看，不应直接对外提供多用户访问：

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

打开 <http://127.0.0.1:3001>。Windows 也可以双击根目录 `启动 DataAgent.cmd`，它会检查依赖、构建并启动服务。

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

指挥台（`/api/work/*`）需要设置 `DATAAGENT_WORK_ENABLED=1`；接入外部 Agent 还需要 `DATAAGENT_ALLOW_EXTERNAL_EXECUTORS=1`，并在「设置 → 执行器策略」中勾选对应执行器。

**主界面**：左侧存放对话记录与功能入口（收件箱、项目、Agent、工具、记忆、设置），右侧上方是 Agent 的思考与执行流，输入框固定在底部。选中多个 Agent 后发送，会并行创建工单做交叉验证；任一方完成后可选一个 Agent 汇总，比较一致点、分歧点与各自依据。交叉验证也可选运行中的窗口 Agent（如未装 ACP 的 DeepSeek Harness）；窗口输出同样进入对比与汇总，但窗口不作为汇总者。数据分析执行器已从界面选项移除，主界面只保留外部 Agent 与受控终端类执行器。

**ACP（推荐）**：统一驱动 Claude Code、Codex、DeepSeek Harness。

```bash
npm i -g @agentclientprotocol/claude-agent-acp   # Claude Code
npm i -g @agentclientprotocol/codex-acp          # Codex（可选）
npm i -g dsh-acp                                 # DeepSeek Harness（需 DEEPSEEK_API_KEY）
```

安装后重启服务，Agent 页的「本机 Agent 探测」会显示版本与登录状态，执行器列表出现对应 ACP 执行器。DSH ACP 还需要在启动服务的环境里设置 `DEEPSEEK_API_KEY`。也可用 `DATAAGENT_CLAUDE_ACP`、`DATAAGENT_CODEX_ACP`、`DATAAGENT_DSH_ACP` 指定自定义命令。ACP 目前是只读 v1：指令文本作为提示词发送，文件写入、终端与权限请求一律拒绝。

**MCP（反向控制）**：让外部 Agent 读取和操作本机工作台。

```bash
claude mcp add --transport http dataagent http://127.0.0.1:3001/api/mcp \
  --header "Authorization: Bearer <在设置页生成的令牌>"
```

令牌在「设置 → MCP 外部 Agent」生成，可在手机设备列表中撤销。可用工具：工单列表/详情、报告摘要、执行器列表、计划列表与创建、下达指令、审批、窗口列表与发送。

**窗口兜底**：没有协议入口的桌面 Agent，可用窗口 Agent 直接向白名单进程窗口键入指令并读取输出；窗口句柄变化时会按进程与标题自动刷新并重试一次。白名单默认包含 codex、ChatGPT、claude、WindowsTerminal、wt、opencode、DSH Desktop、DeepSeek Harness、DeepSeek，可用 `DATAAGENT_WINDOW_PROCESSES` 覆盖。运行中的 DeepSeek Harness 桌面版会被「本机 Agent 探测」识别为可用（不需要 `dsh` 命令或 ACP 适配器），直接选左下方的「窗口 · DeepSeek Harness」即可。窗口 Agent 会优先定位底部的会话输入框并排除搜索框；窗口不在会话页、或输入框里已有未发送草稿时明确拒绝，不会把指令打进搜索栏或覆盖草稿。发送后默认轮询 30 秒等待新输出，可用 `DATAAGENT_WINDOW_WAIT_MS` 调整。

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

命令：`npm run dev`（前端）配合启用了 `DATAAGENT_WORK_ENABLED=1 DATAAGENT_ALLOW_EXTERNAL_EXECUTORS=1` 的服务。注意：CLI 执行器是一次性进程，不会在 Claude Code / Codex 桌面端自动打开该会话；软件内的项目对话只维护会话 ID 与消息记录。

## 数据（指挥台模式下界面隐藏）

以下数据分析能力仍完整保留在服务端与测试中，供原数据分析界面和接口使用；指挥台模式下不展示相关导航、快捷命令与执行器选项。需要恢复时，关闭 `DATAAGENT_WORK_ENABLED` 即回到原数据分析界面，或重新把对应入口加回 `src/components/SuperAgentShell.tsx`。

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

打开「模型与 API 设置」，先填写 API 地址和对应的 Key。输入停顿后自动读取供应商的模型列表，选择模型，再测试连接并保存。仅返回一个模型时自动选中；列表不支持或权限不足时，可以重新检测或手动填写完整模型 ID。检测只读取目录，不发起模型生成；测试连接会产生一次有上限的模型调用。

支持基础地址与完整 Chat Completions 地址，官方 OpenAI / Claude 根地址会补齐 `/v1`。DeepSeek Flash 的连接测试关闭思考模式，避免短测试只返回推理；其他推理模型若只返回推理，会提示“接口已连接，测试未生成最终答案”，正式报告仍要求完整最终文本，不把推理当作报告。更换 API 地址后需要重新填写对应的 Key，防止旧凭据被自动发送到新的接口。

账号服务默认允许以下三家的官方主机。模型名称填写你在对应供应商账户中有权限使用的完整模型 ID，Key 与供应商保持一致：

| 供应商 | API 地址 | 官方文档 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | [DeepSeek API](https://api-docs.deepseek.com/) |
| Claude（Anthropic） | `https://api.anthropic.com/v1` | [Chat Completions 兼容接口](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) |
| OpenAI | `https://api.openai.com/v1` | [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) |

允许的是供应商主机，不限制这些主机下的模型名称；模型是否可用取决于供应商支持和你的 API 账户权限。Claude 兼容接口使用 Anthropic 的 API Key；需要额外工作区请求头的非工作区密钥暂不支持。配置环境变量 `DATAAGENT_MODEL_HOSTS` 会替换默认列表，显式空值会关闭 AI；已有部署如果配置为空，需要改为上述主机列表并重启服务。本机 PowerShell 可执行：

```powershell
$env:DATAAGENT_MODEL_HOSTS='api.deepseek.com,api.anthropic.com,api.openai.com'
npm.cmd run cloud
```

在原服务终端先按 Ctrl+C 停止，再执行以上命令；重新打开客户端即可读取白名单。桌面端加载服务提供的页面，这项服务端更新无需重新安装 EXE。

- 旧会话模式的云端 API Key 只保留在当前登录会话的服务端内存，不写入数据库、浏览器存储或日志；退出或重启后需要重新填写。原单用户入口的 Key 保留在本机服务进程内存。
- 系统向用户指定的供应商发送分析目标、主动提供的业务背景和聚合指标，不发送原始玩家 ID 明细。
- 模型费用由供应商从你的 API 账户扣除，与服务额度独立。
- 模型失败会使任务明确失败并释放服务额度，不会静默换供应商或冒充 AI 成功。
- AI 解读属于辅助观察与待验证建议。代码核验的是计算指标和数值边界，无法保证所有自然语言判断正确，不据时间相关性认定因果。

## 额度、持久化与部署边界

云端账号版支持注册登录与个人空间隔离，尚未接入真实支付、邮箱找回或组织权限。每个新账号初始 500 试用额度，每次任务冻结 20；完成结算，失败/取消释放。示例历史报告不收费。账本由服务端持久化，客户端不能上报扣费结果。

云端账号库与各用户工作空间分开保存；可使用 `DATAAGENT_DATA_DIR` 指定持久化目录，容器中为 `/app/data`。原单用户入口仍使用根目录 `data/`。服务重启时，未完成任务标记中断并释放额度，已完成报告保留。不要将运行数据提交到 GitHub。

账号服务按单实例 SQLite 部署，内置认证、会话、同源检查与用户隔离；生产需配置 HTTPS 的 `PUBLIC_URL` 和可信模型主机白名单，并按部署说明备份数据。不要将原单用户入口暴露公网，也不要把本版作为多副本集群运行。正式收费仍需另外接入支付和运营流程。

## 验证

```powershell
npm.cmd test
npm.cmd run build
```

覆盖指标手算、订单去重、留存成熟度、CSV/XLSX、额度事务、协作确认、防重、取消/重启、模型成功/失败和凭据保护。真实付费供应商未使用用户 Key 联测；模型集成使用可控响应验证。

浏览器验收脚本位于 `scripts/browser-check.mjs`，需本机 Edge 和 Playwright。可将 Playwright 模块绝对路径作为第一个参数传入，不影响日常启动。

1.1.0 已通过 65 项自动化测试、生产构建、浏览器双账号验收，以及真正打包后的 `win-unpacked/DataAgent.exe` 注册、双账号隔离、上传 CSV、协作/自动分析、报告和切换服务验收。规格与质量审查通过。Docker 引擎和公网服务器在当前环境不可用，容器部署与公网访问未实测。可选复验命令：

```powershell
node scripts/desktop-smoke.mjs release/win-unpacked/DataAgent.exe
node scripts/desktop-check.mjs <Playwright模块路径> release/win-unpacked/DataAgent.exe
```

安装包的 SHA256 位于 `release/SHA256SUMS.txt`。首版提供 8 个内置 Skill 节点，按预定义工作流执行；新增领域、节点或分支可在源码注册，当前没有可视化工作流编辑器或任意第三方 Skill 导入。

## 代码结构

```text
src/                  React 页面、报告、工作动态与弹窗
server/               数据解析、指标计算、工作流、账本、模型网关与测试
scripts/              开发启动与浏览器验收
desktop/              Windows 桌面主进程与运行验收
release/              Windows 安装包与校验文件（构建生成）
docs/api-contract.md  前后端接口
docs/superpowers/     设计与实施记录
data/                 本地运行数据（自动生成，不进入版本控制）
```

新增领域时，扩展领域注册信息、数据规范、指标实现和 Skill 工作流。当前仅开放游戏运营，其他领域入口明确标注尚未开放。


## 多模型与阶段 Skill 工作流（源码新增）

在「模型与 API 设置 → 模型中心与工作流」中依次保存凭据、添加模型配置、选择工作流默认模型，再为各阶段指定 Skill、模型、思考强度和预算。支持同供应商多组 Key，一个 Key 可供多个模型配置使用。原会话 Key 设置仍保留；关闭阶段工作流可使用旧模式。

云端管理员需配置 `DATAAGENT_CREDENTIAL_MASTER_KEY`（32 字节随机值的 base64），才能启用持久凭据库。密钥通过 AES-256-GCM 加密存储，绑定账号、接口、协议和版本；正常退出和服务重启后仍保留。主密钥缺失时明确禁用持久保存，绝不退回明文。主密钥应独立备份；掌握主密钥的服务管理员可以解密，这不是端到端加密。

工作流包含质量、计划、处理、活跃、留存、商业化、渠道、周内规律、绘图、洞察、报告、核验和 PDF 共 13 阶段。AI 阶段实际加载 Skill 并使用相应模型；PDF 由排版工具执行。未知模型只开放默认强度，已核实型号显示其支持的原生强度；mid 对应 medium。运行中显示阶段摘要、模型、Skill 版本和供应商实际返回的用量，不显示模型私有思维链。

内置 Python 命名工具提供描述统计、分组、相关/检验和五类图表。仅开放受控操作，不运行任意模型代码或 Shell。当前清洗工具提供非破坏性标准化预览，原始数据保持不变；删行、填补或改变业务口径不会自动执行。输入仍遵循现有领域数据规范。

服务端依赖安装：

```powershell
python -m pip install -r server/tools/requirements.txt
npm.cmd ci
npx.cmd playwright install chromium
```

可通过 `DATAAGENT_PYTHON` 指定 Python、`DATAAGENT_CHROMIUM_EXECUTABLE_PATH` 指定 Chromium/Edge。Dockerfile 已包含 Python、Chromium 和中文字体。桌面端连接云服务，不需用户安装这些工具。

报告页提供「下载 PDF」，生成中文 A4、图表和分页。首次 PDF 成功才结算新工作流任务；失败保留已核验报告并释放冻结额度。只重试 PDF 不再调用模型或重复结算。供应商已产生的模型费用不随软件额度释放而退还。

源码修改后需重新构建并重启自己的服务才生效；已有发布安装包和公网服务不会自动更新。没有使用用户真实 Key 进行付费供应商联测。


## MODEX启发的阶段合同升级

新版内置Skill升级为v2，按阶段使用独立结构：数据概况、分析计划、处理回执、指标结果、图表记录、发现账本、报告、核验及导出回执。任务保存分析契约，下游实际读取结构化产物；大表上下文明确展示提供行数与总行数，不把部分数据说成全量。私人旧版Skill保留兼容读取，其旧输出标为legacy，不作为新合同已核验缓存。

数值证据绑定指标、值、单位、明确期间、分母与数据版本。未知口径明确保留未确认，不猜测分母或将末日指标标成全期。报告和洞察的数字叙述采用保守规则：必须引用完整口径claims及对应证据原文，定性解释另写，防止同值错单位/错期间也被当作通过。

支持trim_strings和normalize_newlines标准化生成内部派生数据版本，保留原始数据，记录变更单元数和输入输出版本；不支持的清洗不执行。恢复只复用已完成、已核验且语义指纹一致的前缀，数据、Skill、参数、上游产物或工具版本变化均使结果失效。为保证图文一致，图表、报告、核验及PDF目前在恢复时重跑。

核验发现可修订的报告问题时最多定向修订2轮，不重新执行活跃等分析，保存审阅、修订和实际模型用量；超限失败仍按原规则释放试用额度，供应商实际费用无法撤销。执行动态展示产物、校验、复用及修订摘要。

异常与稳健性目前是满足样本条件的描述性检查，不输出虚构显著性。工作流中的指定期间/分组比较目前明确显示不适用，未以首末日差冒充用户指定比较；原报告探索功能不受此限制。参考MODEX仅借鉴可读模板中的契约、证据和日志组织，没有修改或执行参考项目。


## 指标目录、版本确认与独立审查记录

游戏指标共用服务端目录，计算器提供真实指标期间与分母；例如DAU使用头条活跃日、ARPPU使用同期去重付费人数、成熟留存使用实际加权分母。未知或尚未支持的领域口径继续标为未确认。`GET /api/metric-catalog?domain=game`可读取目录。

新版多阶段任务确认必须携带当前approvalSnapshot。范围、背景、数据版本或有效产物变化后，旧确认返回409，刷新后由用户重新确认，不自动执行下一步；旧单模型路径保留兼容。

新任务记录数据来源hash、源文件/表/行数和映射，以及演示标记。网页及PDF展示独立审查回执，区分通过、有问题、未审查和禁用。生成PDF不代表完成视觉检查；当前没有自动调用额外付费视觉模型。

报告内容hash与PDF缓存和核验状态绑定，正文变化会阻止旧核验PDF下载。单位换算、舍入和百分点差可通过numeric-transform命名操作生成确定性证据及回执，AI随后引用新证据ID；不允许随意跨币种转换。

质量决定的基础模块保留理由、规则版本和原状态，仅允许处理指定待复核项；本版尚未提供通用人工清洗决策页面、任意分析方法插件或自动视觉审查服务。
