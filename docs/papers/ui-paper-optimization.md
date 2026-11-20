# 界面论文筛选与 Lagent UI 改版建议（2023-11 → 2026-11）

> 检索与撰写日期：2026-11-18
> 时间窗：近三年（2023 年 11 月 – 2026 年 11 月），不含更早的奠基文献（只作背景，不进改造清单）。
> 覆盖：中文核心期刊（包装工程、情报理论与实践、图书情报知识、北京林业大学学报、交通与运输、人类工效学）与国内团队在 arXiv / ACL / CHI 的成果；国外 CHI / IUI / CSCW / EMNLP / ACL / arXiv cs.HC。
> 边界：**只讨论界面（UI/UX）。不改功能、不改接口、不改状态机、不新增依赖、不新增页面路由**。所有建议都要求能用现有数据与现有组件实现，并以「只读展示 / 排版 / 令牌 / 文案」为限。

---

## 0. 结论先行

读完近三年 22 篇直接相关论文（国内 10、国外 12）并对照 `ui-ux-pro-max` 的 99 条 UX 规则后，对 Lagent 最重要的判断有五条：

1. **Lagent 的界面本质是「控制台」，不是「聊天框」，信息结构应当纵向分层。**
   牛佳然等（包装工程，2023）的眼动实验给出直接证据：在复杂显控界面中，**纵向任务栏型布局**的视觉搜索绩效整体优于横向主图型布局（作战任务下纵向三分最优，导航任务下纵向二分最优）。Lagent 现在是「左侧栏 264px + 中间单列 772px + 右栏 308px」的横向三段结构，中间列把「任务、计划、执行流、结论」压进同一条竖向消息流里，缺少"任务 → 步骤 → 证据"的纵向分层。

2. **透明度的有效成分是「证据」，不是「分数」。**
   Tatasciore 等（2024）的结论很干脆：透明度能提升人对自动化的正确使用，但**再给出"自动化置信度"反而没有帮助**。Magentic-UI（2025）把可介入点做成 co-planning、co-tasking、action guards 这类**可核对的动作**。Lagent 已有 `verify` / `acceptance` / `preview.action` 这些真证据，但它们在批准卡片里排在末尾、字号最小——这是把最强的信任素材放在了最弱的位置。

3. **长流程图（trace）必须"可总览、可定位"，而不是"可滚动"。**
   AgentLens（2024）、DiLLS（2026）、AGDebugger（CHI'25）、Graph of Trace（ACL 2026）四篇独立工作指向同一件事：分层摘要 + 时间轴总览 + 可点击定位。Lagent 的 `sa-live-steps` 只保留最近 8 条（`steps.slice(-8)`），没有总览、没有序号、失败步骤只能靠滚动找——30 步以上的任务已经不可用。

4. **界面要主动收住「拟人化」的边际收益。**
   张妍等（情报理论与实践，2024）基于 1275 条用户与 ChatGPT 的真实互动帖子证明：用户会把生成式 AI 当作社会行动者，产生"主体性感知 / 感受性感知"，并由此产生情感唤醒与持续使用。这对产品的含义是双向的：**可以借"责任归属清晰"获得信任，但过度人格化会制造无法兑现的期待**。Lagent 的执行器命名（Codex CLI、Claude Code、窗口 · DeepSeek Harness）是对的，应继续"叫工具的名字"，不要给 Agent 起人名、加头像表情。

5. **当前最大的问题不是"不好看"，而是"两套设计系统并存"。**
   实查：`--sa-*` 令牌被引用 1664 次（`superagent.css`），旧的 `--surface/--text/--accent` 仍被引用 405 次（`styles.css`）等；`styles.css` 有 332 处裸十六进制色值，`projects.css` 117 处，`concise-theme.css` 76 处，`appearance.css` 58 处。同时 `--accent`（#242422）与 `--sa-accent`（#3b46d6）**在同屏并存**。这不是审美问题，是"改一处、另一处不跟着变"的维护问题，也是界面在不同页面之间"手感不一致"的根因。

> 反直觉提示：**不要给 Lagent 加"AI 置信度百分比 / 智能评分"。** 上面 F8、F9 两篇（2024、2025）都指向自动化偏误与置信度信息失效；加了会让用户把"模型自述的把握"当成"可验证的事实"，而 Lagent 的真正资产恰恰是 `verify` 执行出来的退出码。

---

## 1. 检索与筛选口径

### 1.1 检索式

| 语言 | 检索式（节选） | 库 |
|---|---|---|
| 中文 | (`生成式人工智能` OR `大模型` OR `智能体` OR `人机协同`) AND (`界面` OR `交互范式` OR `可视化` OR `认知负荷` OR `信任` OR `显控`) | CNKI / 万方 / 维普 / 期刊官网 |
| 中文 | `多智能体` AND (`界面` OR `交互`) AND (`诊断` OR `可视化` OR `调试`) | 同上 + arXiv 中文团队 |
| 英文 | (`multi-agent` OR `agentic` OR `LLM agent`) AND (`interface` OR `UI` OR `visualization` OR `human-in-the-loop` OR `sensemaking` OR `debugging`) | CHI / IUI / CSCW / EMNLP / ACL / arXiv cs.HC |
| 英文 | (`trust calibration` OR `automation bias`) AND (`interface` OR `explanation`) | CHI / AI & Society / Cognitive Research |

### 1.2 三条硬门槛（全过才进第 4 节精读）

1. **可映射**：能落到 Lagent 的真实符号（组件名、CSS 变量、类名），不接受"泛泛而谈的体验提升"。
2. **可验收**：能写出可测指标（同屏信息量、定位步数、字号/对比度、键盘操作次数、截图对比）。
3. **不动功能**：结论能用"排版、令牌、文案、只读展示"实现；需要新增接口或状态的一律降级为背景。

### 1.3 排除与降级

| 情况 | 处理 |
|---|---|
| 面向具身机器人 / 无人机 / 车载的界面研究 | 只取"信息结构 / 认知负荷 / 中文行宽"的方法学，不外推操作结论 |
| 生成式 UI（模型直接画界面） | 只进背景；Lagent 是确定性控制台，不适合运行时生成布局 |
| 纯视觉风格论文（无实验、无指标） | 不进正文 |
| 依赖重训模型 / 大规模标注的界面研究 | 只取交互结论 |
| 2026 年新预印本、无同行评审 | 进正文，标注「预印本 / 待核」，不写进验收标准 |

### 1.4 纳入结果

- **国内 10 篇**（中文核心 6 + 国内团队国际发表 4）
- **国外 12 篇**（CHI 2023–2026、EMNLP、ACL、AI & Society、arXiv）
- **背景文献 4 篇**（仅用于概念定义，不进清单）

### 1.5 规范来源

`ui-ux-pro-max` 技能包在本机仅安装了 `SKILL.md`（`scripts/`、`data/` 目录为空，CLI 检索不可用），因此本次以 SKILL.md 的 Quick Reference 十条优先级规则表为准，引用时标注「§N / rule-id」。关键条目：`color-not-only`、`nav-label-icon`、`touch-target-size`、`font-scale`、`text-styles-system`、`line-height`、`progressive-disclosure`、`state-clarity`、`empty-states`、`loading-states`、`prefers-reduced-motion`。

---

## 2. 现状基线（2026-11-18 实查）

所有条目都来自仓库文件实查，不是印象判断。

### 2.1 骨架与尺寸

| 项 | 实测 | 位置 |
|---|---|---|
| 侧栏宽度 | `264px`（折叠态 64px） | `superagent.css` `--sa-sidebar` |
| 右栏（执行面板） | `308px` | `--sa-rail` |
| 落地页栅格 | `max-width: 1116px`，`1fr + 308px`，列间距 44px | `.sa-landing` |
| 会话列宽 | `772px` | `.sa-thread-inner` |
| 输入框宽度 | `728px` | `.sa-composer` |
| 顶栏高度 | `52px` | `--sa-topbar` |
| 间距节奏 | 4/8/12/16/20/24/32/40/56 | `--sa-1` … `--sa-9` |
| 断点 | 1180 / 980 / 760 / 720 / 560 | `superagent.css` |

**判断**：列宽控制是合格的（772px 在中文约 35–40 字/行，符合 `line-length-control`）。真正的问题在 **1366px 笔记本上的水平预算**：1366 − 264（侧栏）= 1102，落地页要 1116 + 两侧 gutter，主列会被压到约 640px，此时右栏 308px 与主列 640px 的视觉权重接近 1:2，读者第一眼看到的是"两块面板"，而不是"一条任务主线"。

### 2.2 字号阶梯（问题最集中处）

```css
--sa-fs-2xs: 12px;  --sa-fs-xs: 12px;  --sa-fs-sm: 12px;
--sa-fs-base: 13px; --sa-fs-md: 14px; --sa-fs-lg: 15px;
--sa-fs-xl: 17px;   --sa-fs-2xl: 20px; --sa-fs-3xl: 26px;
```

三档小字号**合并成同一个值 12px**，阶梯实际只剩 12 / 13 / 14 / 15 / 17 / 20 / 26 七档，且 13 与 14、14 与 15 之间只差 1px——层级主要靠字重和颜色撑，而不是字号。

出现次数：`superagent.css` 里 `font-size: 12px` 22 处、`mobile.css` 25 处、`projects.css` 8 处。

对照 `font-scale`（应有 12/14/16/18/24/32 这类可辨识落差）与 `text-styles-system`（应有 display/headline/title/body/label 角色），当前系统**缺角色定义，只有尺寸**。

### 2.3 对比度（结论：合格，不要再当问题讲）

实测 WCAG 比值（脚本计算）：

| 组合 | 比值 | 判定 |
|---|---:|---|
| 浅色 `--sa-text-3` #667085 / canvas #f7f8fa | 4.68:1 | AA |
| 浅色 `--sa-text-3` / surface #ffffff | 4.97:1 | AA |
| 深色 `--sa-text-3` #98a2b3 / #14171d | 6.97:1 | AA |
| 深色 `--sa-text-2` / surface | 8.04:1 | AA |
| warning 文字 / warning-soft | 4.66:1 | AA（刚过线） |
| success / danger / on-accent | 4.81 / 5.11 / 6.92 | AA |

**判断**：`color-accessible-pairs` 已满足，颜色本身不是短板。短板在**语义压缩**（见 2.4）与**字号/字重**。

### 2.4 状态表达：20+ 状态挤进 4 个色族，且最近任务列表只有 7px 圆点

| 事实 | 位置 |
|---|---|
| `.sa-status-completed / accepted / ready / available / connected` 共用一个色 | `superagent.css` 2748 起 |
| `.sa-status-working / running` 共用 accent 色 | 2757 起 |
| `.sa-status-awaiting_review / waiting / needs_setup / needs_auth / proposed / needsApproval` 共用 warning 色 | 2768 起 |
| `.sa-status-failed / blocked / unavailable / rejected / not_installed` 共用 danger 色 | 2778 起 |
| 最近任务列表：`<span className="sa-recent-dot" data-status=…>` + 标题 + 时间，**无状态文字** | `SuperAgentShell.tsx` 1677 起 |
| 圆点直径 `7px`，仅靠 `background` 区分 | `.sa-recent-dot`、`.sa-card2-dot` |

这同时踩了两条规则：`color-not-only`（信息只由颜色承载）与 `state-clarity`（"需授权"和"待确认"在视觉上完全一样，但用户要做的事完全不同）。

### 2.5 设计令牌：两套系统并存

| 文件 | `--sa-*` 引用 | 旧令牌引用 | 裸 hex |
|---|---:|---:|---:|
| `superagent.css` | 1664 | 0 | 53 |
| `projects.css` | 540 | 0 | 117 |
| `styles.css` | 0 | 405 | 332 |
| `readability.css` | 0 | 203 | 31 |
| `appearance-overrides.css` | 0 | 131 | 43 |
| `mobile.css` | 0 | 118 | 1 |
| `concise-theme.css` | 0 | 39 | 76 |
| `appearance.css` | 0 | 11 | 58 |

并且 `appearance.ts` 已把 `view` 强行固定为 `'concise'`（第 13 行注释："The product now has a single concise shell"），于是 `html[data-view="concise"]` 会同时注入 `--accent: #242422`（近黑）与 `--sa-accent: #3b46d6`（靛蓝）。**同屏两个"主色"**：壳层按钮靛蓝，旧页面按钮近黑。

### 2.6 可达性（现有基础比预期好，缺口明确）

| 项 | 实测 |
|---|---|
| Skip link | 有：`<a className="skip-link" href="#sa-main">跳到主内容</a>`（`SuperAgentShell.tsx:2099`） |
| 流式步骤播报 | 有：`<ol className="sa-live-steps" aria-live="polite">`（1762） |
| 弹窗焦点陷阱 / Esc / 焦点还原 | 有（`ui.tsx` `Modal`） |
| Toast | `role="status|alert"`，4.2s 自动关闭 |
| 减弱动画 | 6 处 `prefers-reduced-motion` |
| focus-visible | `superagent.css` 11 处、`projects.css` 12 处 |
| 图标按钮 aria-label | 弹窗关闭、Toast 关闭有；其余需抽查 |
| 骨架屏 | **0 处**（`skeleton|shimmer` 无命中），慢加载只有 spinner |
| 44px 触控下限 | `html[data-view="concise"]` 全局强制 `min-height: 44px`（按钮/输入/导航项） |

**判断**：桌面端把 44px 无条件套在鼠标环境，直接牺牲了列表密度（`touch-target-size` 本意是触控下限，不是桌面行高）；而真正的加载态（列表首屏）又只有 spinner。

---

## 3. 论文总表

优先级：**P0** = 两周内可落且收益直接；**P1** = 一个迭代；**P2** = 需跨页面统一。

### 3.1 国内（近三年，10 篇）

| # | 文献 | 出处 / 年 | 与 Lagent 的关系 | 优先级 |
|---|---|---|---|---|
| D1 | 刘玉磊, 马艳阳. 面向生成式人工智能应用的意图驱动的界面交互范式探索 | 包装工程, 2024, 45(4): 58-66 | 提出 IDIM 范式（意图域 / 对话流 / 互动启示 / 多模态），给"意图→计划→执行"三段式提供中文理论依据 | P1 |
| D2 | 张妍, 赵宇翔, 吴大伟, 朱庆华. 人智交互情境中用户对生成式人工智能的心智感知及反应研究 | 情报理论与实践, 2024, 47(8): 140-149 | 主体性/感受性感知 → 认知加工、情感唤醒、行为强化；1275 条真实帖子；约束"拟人化"边界 | P1 |
| D3 | 宋小康, 赵宇翔, 宋士杰, 朱庆华. 社会技术系统范式下AI赋能的替代信息搜索 | 图书情报知识, 2023, 40(4): 111-121 | "信息需求者–AI 算法–信息资源"三元关系；把信任与信息可信度列为未来方向 | P1 |
| D4 | 牛佳然, 吴晓莉, 张蓝, 李泽华. 基于视觉认知特性的作战显控界面信息结构布局研究 | 包装工程, 2023, 44(22)（DOI 10.19554/j.cnki.1001-3563.2023.22.037） | 眼动实验：纵向任务栏型 > 横向主图型；作战任务纵向三分最优 | **P0** |
| D5 | 陈鹤元, 钟文博, 杨洪泽, 等. 基于认知负荷的人机界面综合评价方法——以森林消防指挥车显控台为例 | 北京林业大学学报, 2025 | 指挥台类界面的认知负荷评价方法学；给"密度分层"提供指标口径 | P0 |
| D6 | 陈佳雯, 王雪松, 周楚. 基于综合评估模型的车载界面单行中文字数评估 | 交通与运输, 2024(4): 19-25 | 中文短标签阈值（单行 5 字为下限）；支撑"元数据用短词 + tooltip" | P0 |
| D7 | Sheng R, Yang Y, Shi C, et al. DiLLS: Interactive Diagnosis of LLM-based Multi-agent Systems via Layered Summary of Agent Behaviors | arXiv:2602.05446, 2026（HKUST / 同济 / 东南） | 分层摘要做多智能体诊断；直接对应"执行流只有最近 8 条" | **P0** |
| D8 | Gao T, Li H, Li J, et al. Graph of Trace: Visualizing Execution Traces of Scientific Agents | ACL 2026 Demo（清华 / 人大 / 上海期智） | trace 图结构可视化；对应"步骤无法定位" | P1 |
| D9 | Lu J, Zhang Z, Yang F, et al. AXIS: Efficient Human-Agent-Computer Interaction with API-First LLM-Based Agents | ACL 2025（北大 + 微软） | 以 API-first 降低人机往返次数；对应"少让用户点确认，多点可核对证据" | P1 |
| D10 | Lu J, Pan B, Chen J, et al. AgentLens: Visual Analysis for Agent Behaviors in LLM-based Autonomous Systems | arXiv:2402.08995, 2024（浙大团队） | 层级时间可视化 + 行为摘要 + 因果追踪；有用户实验 | **P0** |

### 3.2 国外（近三年，12 篇）

| # | 文献 | 出处 / 年 | 与 Lagent 的关系 | 优先级 |
|---|---|---|---|---|
| F1 | Mozannar H, Bansal G, Tan C, et al. Magentic-UI: Towards Human-in-the-loop Agentic Systems | arXiv:2507.22358, 2025（Microsoft Research） | 六种介入机制：co-planning / co-tasking / multi-tasking / action guards / long-term memory；四维评测 | **P0** |
| F2 | Epperson W, Bansal G, Dibia V, et al. Interactive Debugging and Steering of Multi-Agent AI Systems（AGDebugger） | CHI 2025, DOI 10.1145/3706598.3713581 | 消息浏览与发送、**编辑/复位历史消息**、消息历史总览可视化；14 人实验 | **P0** |
| F3 | Dibia V, Chen J, Bansal G, et al. AutoGen Studio: A No-Code Developer Tool for Building and Debugging Multi-Agent Systems | EMNLP 2024 Demo | "构建 + 调试"同屏的开发者工具范式 | P1 |
| F4 | Schömbs S, Zhang Y, Goncalves J, Johal W. From Conversation to Orchestration: HCI Challenges and Opportunities in Interactive Multi-Agentic Systems | ACM, 2025, DOI 10.1145/3765766.3765795 | 从对话到编排的 HCI 挑战清单；给"指挥台"定位背书 | P1 |
| F5 | Pareek S, Govers J, Kollerup N K, et al. Sensemaking in Multi-Agent LLM Interfaces: How Users Interpret Transparency and Trustworthiness Cues | CHI 2026 | 用户如何解读透明性线索；直接指导"哪些线索值得画" | **P0** |
| F6 | Doro P, Drooff C, Chen J, Tighe J. ADEPTS: A Capability Framework for Human-Centered Agent Design | arXiv:2507.15885, 2025（Meta FAIR） | 以"能力"而非"角色"组织 Agent 呈现 | P1 |
| F7 | Wischnewski M, Krämer N, Müller E. Measuring and Understanding Trust Calibrations for Automated Systems | CHI 2023 | 信任校准的测量框架；给"别加置信度分数"提供依据 | P1 |
| F8 | Tatasciore M, Strickland L, Loft S. Transparency improves the accuracy of automation use, but automation confidence information does not | Cognitive Research: Principles and Implications, 2024 | **核心证据**：透明度有用，置信度信息无用 | **P0** |
| F9 | Romeo G, Conti D. Exploring automation bias in human–AI collaboration: a review and implications for explainable AI | AI & Society, 2025 | 自动化偏误综述；解释设计要防"照单全收" | P1 |
| F10 | Goyal N, Chang M, Terry M. Designing for Human-Agent Alignment: Understanding what humans want from their agents | CHI 2024 | 人对 Agent 的期待维度（控制感、可预期、可纠偏） | P1 |
| F11 | Ma S, Wang X, Lei Y, et al. "Are You Really Sure?" Understanding the Effects of Human Self-Confidence Calibration in AI-Assisted Decision Making | CHI 2024 | 人自身信心校准的影响；对应"确认按钮不该只有一种语气" | P1 |
| F12 | Feng K J K, Kim T S, Pang R Y, et al. On the Regulatory Potential of User Interfaces for AI Agent Governance | arXiv:2512.00742, 2025（UW / KAIST / CMU / UIUC） | 把界面当作治理手段：权限、范围、留痕要"看得见" | **P0** |

---

## 4. 分主题精读（机制 → 落点 → 验收）

### 4.1 控制台的信息结构：纵向分层优于横向并排（P0）

**机制**（D4）：眼动 + 视觉搜索任务，比较"纵向任务栏型 / 横向主图型 / 纵向二分 / 纵向三分"。结论：纵向任务栏型整体更优；任务越偏"连续处置"，纵向三分越好；偏"定位/浏览"，纵向二分更好。

**对 Lagent 的落点**：
1. 落地页（`.sa-landing`）目前是"主列 1fr + 右栏 308px"的左右并排；中间列内部又是"hero → 需要你确认 → 执行 Agent → 常见任务 → 最近任务"五段横向堆叠。
2. 建议改为**纵向三段**：① 顶部"今日任务带"（需确认 / 运行中 / 最近失败，横向 3 格，每格只放一条最高优先级）；② 中部"执行 Agent 选择"（保留现组件，但不与 starter 平铺）；③ 底部"最近任务"（折叠为 1 行 5 条）。
3. 右栏（rail）在宽度 <1180px 时默认收起（已有断点，改默认值即可，不动逻辑）。

**验收**：
- 1440/1280/1366 三档截图：主列宽度 ≥ 680px，rail 不再与主列"等权"。
- 同屏可扫读的"待办任务"数量 ≥ 3（现状约 1）。
- 不改 `ShellView` 与任何状态；仅 `superagent.css` + 落地页 JSX 顺序。

### 4.2 透明度的有效成分：只要证据，不要分数（P0）

**机制**（F8 + F9 + F7）：透明度（说明系统做了什么、依据什么）提升正确使用率；**追加"自动化置信度"信息不改善**判断，甚至诱发过度依赖。

**对 Lagent 的落点**：
- 批准卡片（`sa-attention`）现在顺序是：标题 → 追问 `question` → 动作 `preview.action` + `cwd` → 验收 `verify.command` → 验收结果。**最强的证据在最下面、最小字**。
- 建议卡片固定为三行式（全部只读、数据已有）：
  1. **会动什么**：`写入/删除/执行` + 路径（`accessMode` + `accessPath`）
  2. **会跑什么**：`verify.command` + `expect`
  3. **怎么算完成**：`acceptance.status` + 退出码
- 明确**不新增**"AI 置信度 / 建议采纳率"字段；不改 `verify` 语义。

**验收**：
- 批准前不点开详情即可看到"影响面 / 命令 / 通过标准"三项，且字号 ≥ 13px。
- 灰度截图（去色）仍能区分"待确认 / 已通过 / 未通过"。

### 4.3 人机接管点要显式，并且"可回退"要可见（P0）

**机制**（F1）：Magentic-UI 把人类介入拆成低成本动作（共同规划、共同执行、动作守卫、长期记忆），并用四维评测证明"低成本介入"能提升安全与效率。**机制**（F2）：AGDebugger 证明"编辑并复位历史消息"是最有效的纠偏手段——用户不是要"看着它跑"，而是要"从某一步重来"。

**对 Lagent 的落点**：
- 已有：计划 → 待确认工单 → 批准 → 执行 → 验收 → 变更时间线。这套"动作守卫"结构本身是对的。
- 缺的是**回退语气的可视化**：卡片上没有任何"这一步可以重跑 / 可以只改这一步"的提示；`canRetry` 存在但按钮叫"重跑"，语义模糊。
- 建议（不改后端）：`重跑` → `从这一步重来`（更明确）；在卡片底部加一行"影响范围：本步 / 后续步骤沿用原计划"（用现有 `planId` 与步骤序号渲染即可，纯文案 + 一行静态说明）。

**验收**：
- 文案评审：用户能在 5 秒内回答"我按了会发生什么、能不能撤回"。
- 不改任何 `act()` 调用参数与状态迁移。

### 4.4 长流程的可导航性：总览 + 摘要 + 明细（P0）

**机制**（D10）：层级时间可视化 + 行为摘要算法 + 因果追踪，让用户"交互式调查细节与原因"。**机制**（D7）：按层摘要 Agent 行为做诊断，解决"原始日志太长"。**机制**（F2）：消息历史总览可视化，解决"在长对话里定位错误"。三篇独立工作，同一结论。

**对 Lagent 的落点**（这是当前最硬的缺口）：
- `SuperAgentShell.tsx` 的紧凑卡片：`steps.slice(-8)` —— 只渲染最近 8 条，超过即丢失上下文。
- `sa-live-steps` 是一维 `<ol>`，无序号、无分组、无折叠。
- 建议（纯展示层）：
  1. **步骤索引条**：顶部一排 8–12 个小方块，颜色 = 类型（推理/工具/观察/错误），hover 显示序号 + 首 20 字；点击滚动到对应条目。数据来自已有 `steps` 数组，不改接口。
  2. **三段折叠**：`计划（plan）` / `最近动作（默认展开 8 条）` / `更早（点击展开全部，只读）`。
  3. **失败置顶**：`kind === 'error'` 的步骤始终在索引条上带红色描边（形状 + 颜色，双编码）。

**验收**：
- 30 步任务：定位到失败步骤的滚动次数 ≤ 1，操作 ≤ 2 次。
- 键盘：索引条可用 Tab 遍历，Enter 跳转。
- 不改 `WorkTrace` 类型、不改 trace 接口。

### 4.5 多智能体界面的"意义建构"：说清谁做了什么、边界在哪（P0）

**机制**（F5）：用户对多 Agent 界面的透明性与可信线索是**主动解读**的，不是被动接收；线索错位会被读成"推卸责任"。**机制**（F12）：界面本身就是治理工具——权限、范围、留痕必须画出来。**机制**（F4）：从"对话"到"编排"的范式迁移中，HCI 的核心挑战是**归属与协调**。

**对 Lagent 的落点**：
- 跨 Agent 交叉验证（多选 → 并行建单 → 选一个汇总）是 Lagent 的特色，但对比结果目前是文本混排，读者很难回答"这条结论是谁给的、依据是什么"。
- 建议（只读展示，数据已有）：
  1. 每条结论前加**执行器徽标 + 会话 ID 短码**（已有 `BRAND_MARKS` 与 `sessionId`）。
  2. 汇总区固定三栏：`一致点` / `分歧点` / `各自依据`（现文本可解析，或按现有字段分组渲染；不改汇总逻辑）。
  3. 明确的**责任文案**："汇总由 <Agent 名> 生成，仅供参考；以验收命令结果为准。"

**验收**：
- 任意一条结论，可在一次视线移动内看出"谁说的"。
- 文案不出现"AI 认为 / 模型判断"，只出现"某执行器输出 + 验收结果"。

### 4.6 意图驱动的三段式，而不是"一个万能聊天框"（P1）

**机制**（D1）：IDIM 范式把生成式 AI 界面拆为意图域、对话流、互动启示、多模态交互——**意图要先被"说出来"，再被"结构化"**。**机制**（F6）：ADEPTS 主张按"能力"而不是"角色"组织 Agent。**机制**（D9）：API-first 的 Agent 能显著减少人机往返次数，但前提是"意图 → 动作"的映射可核对。

**对 Lagent 的落点**：
- 输入框现在只有一个占位"描述目标"，`quickCommands` 三条写死在顶栏（`检查 GitHub 仓库状态 / 浏览网页并总结 / 运行终端命令`）。
- 建议：把输入区做成"意图 → 目标 → 边界"三段可折叠提示（只加标签与示例，不改提交逻辑）；starter 卡片（`sa-starter`）按"能力"分组（读代码 / 改代码 / 跑命令 / 查资料），而不是按产品线分组。

**验收**：
- 首屏可直接选择"我要它做什么能力"，不需要先想清楚用哪个执行器。
- 不改 `composeMode` 与 `selectedAgents` 逻辑。

### 4.7 拟人化的克制与责任归属（P1）

**机制**（D2）：用户会自发把 GAI 当社会行动者（主体性感知含创造力、可靠性、运行规则、客观性、有用性；感受性感知含共情、沟通责任、趣味、友善、文化适应），并产生持续使用与准社会互动。**机制**（F10）：人对 Agent 的真实期待是"可控、可预期、可纠偏"。**机制**（F11）：人的自信校准会影响其对 AI 建议的采纳。

**对 Lagent 的落点**：
- 现状是正确的：执行器用产品名（Codex CLI / Claude Code / 窗口 · DeepSeek Harness），没有花名与头像照片。
- 建议：保持"工具化命名"，**不引入** Agent 人格卡、情绪文案、拟人自称；状态文案统一为"可用 / 需授权 / 未安装"这类**可核对的事实词**，不用"它正在努力"。

**验收**：
- 全量文案扫描：无第一人称拟人表达；状态词全部可对照后端枚举。

### 4.8 中文排版与认知负荷：短标签 + 可读字号（P0）

**机制**（D6）：驾驶模拟 + 综合评估模型，中文单行 **5 字**是短时记忆容量的下限阈值，能传达核心信息并降低负荷（注意：结论来自车载场景，只借"短标签"的方法学，不外推操作结论）。**机制**（D5）：指挥台类界面应以认知负荷为综合评价口径，而不只是主观满意度。

**对 Lagent 的落点**：
- 元数据（时间、执行器、状态、计数）大量使用 12px + 长串中文（如"等待你确认后开始。"）。
- 建议：
  1. 元数据改**短标签**：`待确认` / `运行中` / `已验证` / `已失败`（4 字以内），完整解释放 tooltip 或详情。
  2. 字号阶梯恢复落差：`13（元数据）/ 14（正文）/ 16（小标题）/ 20（页面标题）/ 26（hero）`；12px 仅用于徽标角标。
  3. 中文正文行高保持 1.7–1.75（已有），标题 1.3–1.4。

**验收**：
- `superagent.css` 中 `font-size: 12px` 出现次数显著下降（目标 ≤ 6 处且仅限 badge）。
- 1440 宽度下正文 14px 时，单行 35–45 字；对比度全部 ≥ 4.5:1（不因放大字号而失效）。

---

## 5. 对照 ui-ux-pro-max 的规范诊断

| 规则（§ / id） | 现状 | 结论 |
|---|---|---|
| §1 `color-not-only` | 最近任务/卡片头部只有 7px 圆点携带状态 | **不合规**，P0 修 |
| §1 `keyboard-nav` / `focus-states` | focus-visible 有 11 处；Modal 焦点陷阱完备 | 基本合规，需抽查图标按钮 |
| §2 `touch-target-size` | 44px **全局强制**（含鼠标环境） | 过度应用，P0 改为按 `pointer: coarse` |
| §3 `progressive-loading` / `loading-states` | 无骨架屏，只有 spinner | 不合规，P1 |
| §4 `state-clarity` | 20+ 状态映射到 4 色族 | **不合规**，P0 |
| §4 `consistency` / `color-semantic` | 双令牌体系 + 合计 700+ 处裸 hex（styles 332 / projects 117 / concise 76 / appearance 58 / 其余 50+） | **不合规**，P0 |
| §4 `no-emoji-icons` / `icon-style-consistent` | 统一 lucide-react + 品牌 SVG | 合规 |
| §5 `line-length-control` | 772 / 728px 限宽 | 合规 |
| §5 `spacing-scale` | 4/8 节奏 | 合规 |
| §5 `z-index-management` | 存在 30/44/45 等散落值 | 待收口（P2） |
| §6 `font-scale` / `text-styles-system` | 12/12/12 三档合并，无角色定义 | **不合规**，P0 |
| §6 `line-height` | 中文正文 1.7–1.75 | 合规 |
| §6 `contrast-readability` | 全部 ≥ 4.66:1 | 合规（无需再优化） |
| §7 `duration-timing` | `--sa-fast: 120ms` 低于 150ms 下限 | 微调（P1） |
| §7 `reduce-motion` | 6 处 media query | 合规 |
| §8 `empty-states` / `error-clarity` | 有空态；错误信息较简 | 基本合规，P1 补"恢复路径" |
| §9 `nav-label-icon` / `nav-hierarchy` | 主导航 3 项 + 「更多」5 项，均 icon+label | 合规；但 5 项被折叠，需补"当前页"提示 |
| §9 `deep-linking` | 桌面端无 URL 状态（`ShellView` 内存态） | 不适用/受限（P2 讨论） |
| §10 `chart-*` | recharts 存在，灰阶 chart token | 待补图例与表格替代（P2） |

---

## 6. 改版建议清单

每条格式统一：**问题 → 依据 → 改法（不改功能）→ 验收 → 影响文件**。

### P0（两周，互不依赖，可并行）

**P0-1 令牌收口：一套语义层，一个主色**

- 问题：`--sa-*`（1664 次）与旧 `--surface/--text/--accent`（405 次）并存；`--accent #242422` 与 `--sa-accent #3b46d6` 同屏。
- 依据：F12（界面即治理，视觉不一致会削弱"可控感"）；`ui-ux-pro-max` §4 `consistency` / `color-semantic`。
- 改法：以 `--sa-*` 为唯一来源；旧变量做成**别名映射**（`--surface-0: var(--sa-canvas)` 等），不改任何组件；保留 `--accent` 作为别名指向 `--sa-accent`，结束"近黑 / 靛蓝"双主色。
- 验收：`grep` 裸 hex 数量下降 ≥ 60%（`styles.css` 332 → ≤ 120）；设置页与指挥台同屏取样，主色一致；`npm test` 现有 typography / appearance 测试全绿。
- 影响：`superagent.css`、`concise-theme.css`、`appearance.css`、`styles.css`（仅变量映射段）。

**P0-2 字号阶梯与中文可读性**

- 问题：`--sa-fs-2xs/xs/sm` 全为 12px；13/14/15 三档只差 1px；12px 出现 55 处（三文件合计）。
- 依据：D6（中文短标签阈值）、D5（认知负荷口径）、`font-scale` / `text-styles-system`。
- 改法：重建阶梯 `12(badge)/13(meta)/14(body)/15(body-lg)/17(section)/20(page)/26(hero)`，并定义四个角色 token（`--sa-type-meta/body/title/page`）；正文统一 14px，中文行高 1.7。
- 验收：1440 截图正文可读性主观评分 ≥ 4/5（3 人）；`font-size: 12px` ≤ 6 处；对比度复测 ≥ 4.5:1。
- 影响：`superagent.css` 的 `1. Tokens` 段 + 各组件字号引用；`mobile.css` 同步。

**P0-3 状态双编码：文字 + 形状 + 颜色**

- 问题：`.sa-recent-dot` / `.sa-card2-dot` 7px、纯色；20+ 状态挤进 4 色族；"需授权"与"待确认"同色。
- 依据：`color-not-only`、`state-clarity`；F5（线索错位会被读成责任不清）。
- 改法：圆点保留（作辅助），左侧加 **3–4 字状态词**（`待确认`/`运行中`/`已验证`/`受阻`/`失败`/`未安装`）；用**形状**区分大类（实心圆=完成、方=待办、三=运行中、三角=受阻），文字承载语义，颜色只做加速。
- 验收：灰度截图仍可区分 6 类；对比度不变；状态词与后端枚举一一映射（写一张映射表进文档）。
- 影响：`SuperAgentShell.tsx` 的 recent/card 两处渲染 + `superagent.css` 状态选择器。

**P0-4 密度分层，按指针能力解耦 44px**

- 问题：`html[data-view="concise"]` 全局 `min-height: 44px`；桌面列表行高被拉高，同屏工单数少。
- 依据：`touch-target-size`（应为触控下限）、`spacing-scale`；D5（密度是认知负荷变量，不是审美）。
- 改法：把 44px 移入 `@media (pointer: coarse)`；桌面默认 32px（紧凑）/ 36px（标准），新增 `density` 偏好的**展示层开关**（仅影响 CSS 类，不写入任务数据）。
- 验收：1440×900 下同屏工单可见数 +30%（截图计数）；触屏模拟仍 ≥ 44px；不新增设置项以外的逻辑。
- 影响：`concise-theme.css`、`superagent.css`。

**P0-5 执行流总览（见 4.4）**

- 问题：`steps.slice(-8)` 无总览、无序号、失败难定位。
- 依据：D7 / D10 / F2 三篇同结论。
- 改法：索引条 + 三段折叠 + 失败置顶描边（全只读，复用 `steps` 数组）。
- 验收：30 步任务定位失败 ≤ 2 次操作；键盘可达；不触发额外请求。
- 影响：`SuperAgentShell.tsx`（只加渲染与展开状态）、`superagent.css`。

### P1（一个迭代）

**P1-1 审批卡片三行式前置（见 4.2）** —— 影响面 / 命令 / 通过标准，字号 ≥ 13px；不新增字段。
**P1-2 交叉验证的归属标注** —— 结论前加执行器徽标 + 会话短码；汇总三栏化（一致/分歧/依据）；加"以验收为准"的责任文案。
**P1-3 导航与徽标** —— 主导航保持 3 项；在 topbar 给"待确认 / 运行中"加计数徽标（数据已有）；「更多」内按"工具类 / 记忆类 / 系统类"分组。
**P1-4 骨架与空态** —— 列表首屏骨架条（>300ms 才出现）；空态给"下一步动作"；错误态给"重试 + 复制诊断"（`copyDiagnostics` 已有）。
**P1-5 动效节奏** —— `--sa-fast 120ms → 150ms`，`--sa-base 180ms → 200ms`；新增 `--sa-slow 260ms` 用于面板展开；退出比进入快 30%（`exit-faster-than-enter`）。
**P1-6 输入区的意图提示（见 4.6）** —— 三段可折叠标签 + 按能力分组的 starter，不改提交逻辑。

### P2（跨页面统一）

**P2-1 多 Agent 对比矩阵** —— 复用交叉验证数据的三列只读矩阵（Tab 逐列可达、长文本折行）。
**P2-2 移动端令牌对齐** —— `mobile.css` 118 处旧令牌 + 25 处 12px 收敛到主壳阶梯。
**P2-3 图表可读性** —— 图例常显、单位、数据表替代、`--chart-1..3` 灰阶保证 3:1 线对比。
**P2-4 可达性收尾** —— 图标按钮 `aria-label` 全量抽查；`aria-live` 加 `aria-atomic`；Tab 顺序核对；z-index 收敛为 0/10/20/40/100 五档。

### 明确不建议（负清单）

| 不建议 | 原因 |
|---|---|
| 新增"AI 置信度 / 智能评分 / 采纳率" | F8/F9：置信度信息对正确使用无改善，反而诱发过度依赖 |
| Agent 人格卡、头像、情绪文案 | D2：拟人化会放大无法兑现的期待；F10：用户要的是可预期与可纠偏 |
| 让模型运行时生成界面（Generative UI） | 控制台需要确定性布局与可记忆位置；生成式布局破坏空间连续性 |
| 把「更多」里的页面全部提回一级导航 | `nav-hierarchy`：一级入口增多会稀释"指挥台"这一主任务 |
| 为对齐 4.5:1 再整体加深文字色 | 现状最低 4.66:1 已合规；继续加深会把层级压平（问题在字号与字重，不在色） |
| 引入新的组件库 / 图标库 | 现有 lucide-react + 令牌体系已自洽，换库的收益低于迁移成本 |

---

## 7. 建议的设计令牌（可直接落地的一份表）

```css
/* 类型（CJK 优先，保留 12px 仅给角标） */
--sa-fs-badge: 12px;   /* 仅徽标/角标，行高 1.4 */
--sa-fs-meta: 13px;    /* 时间、会话 ID、计数 */
--sa-fs-body: 14px;    /* 正文、步骤文本 */
--sa-fs-body-lg: 15px; /* 强调正文、摘要首段 */
--sa-fs-title: 17px;   /* 卡片/区块标题 */
--sa-fs-page: 20px;    /* 页面标题 */
--sa-fs-hero: 26px;    /* 落地页主标题 */
--sa-lh-body: 1.7;
--sa-lh-title: 1.35;

/* 字重角色 */
--sa-w-regular: 400; --sa-w-medium: 500; --sa-w-bold: 600;

/* 密度 */
--sa-row-compact: 32px; --sa-row-standard: 36px; --sa-row-touch: 44px;

/* 动效（150/200/260，退出 30% 更快） */
--sa-fast: 150ms var(--sa-ease);
--sa-base: 200ms var(--sa-ease);
--sa-slow: 260ms var(--sa-ease);

/* 状态（色 + 形 + 词，三编码） */
--sa-state-done: var(--sa-success);
--sa-state-running: var(--sa-accent);
--sa-state-attention: var(--sa-warning);
--sa-state-blocked: var(--sa-danger);
--sa-state-idle: var(--sa-text-3);
```

**状态映射表（建议写进代码注释，避免再压缩语义）**

| 后端枚举 | 短标签 | 形 | 色 |
|---|---|---|---|
| `awaiting_review` / `needsApproval` / `proposed` | 待确认 | 方块 | warning |
| `running` / `working` / `verifying` / `repairing` | 运行中 | 三条 | accent |
| `completed` / `accepted` / `verified` | 已验证 | 实心圆 | success |
| `blocked` / `needs_auth` / `needs_setup` | 受阻 | 三角 | warning→danger 渐变边界需固定一色 |
| `failed` / `unavailable` / `not_installed` | 失败 / 不可用 | 三角 | danger |
| `queued` / `pending` / `cancelled` | 排队 / 已取消 | 空心圆 | text-3 |

> 注意：`needs_auth`（需授权）应单独给 **钥匙图标**，不要与"失败"共用三角——用户对这两件事的动作完全不同。

---

## 8. 落地路线（只动界面）

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| 第 1 周 | P0-1 令牌收口（先做映射，不改组件）+ P0-2 字号阶梯 | `npm test` 绿；三种宽度截图；裸 hex 下降 ≥ 60% |
| 第 2 周 | P0-3 状态双编码 + P0-4 密度解耦 | 灰度截图可辨 6 类状态；1440 同屏条目 +30% |
| 第 3 周 | P0-5 执行流总览 + P1-1 审批三行式 | 30 步任务定位 ≤ 2 次操作；批准前可见三要素 |
| 第 4 周 | P1-2 归属标注 + P1-3 导航徽标 + P1-4 骨架/空态 | 交叉验证可辨来源；慢网无空白闪烁 |
| 后续 | P1-5 动效、P1-6 意图提示、P2-* | 逐项验收，不合并发布 |

**回归口径**：每阶段只跑现有 `npm test`、`npm run build` 与截图比对；不新增依赖、不改接口、不改 `WorkTicket` / `WorkPlan` / `WorkTrace` 类型。

---

## 9. 证据强度与边界

| 结论 | 证据类型 | 强度 |
|---|---|---|
| 纵向分层优于横向并排 | 眼动实验（D4，n 未披露于摘要） | 中—强（单一场景，需外推谨慎） |
| 透明度有用、置信度无用 | 实验（F8） | 强 |
| 长流程需总览 + 摘要 + 定位 | 4 篇独立系统 + 用户实验（D7/D8/D10/F2） | 强（跨团队复现） |
| 人机介入点要多且低门槛 | 系统 + 四维评测（F1） | 中—强（作者自评为主） |
| 中文短标签阈值 5 字 | 驾驶模拟（D6） | 中（场景迁移有限，只借方法） |
| 拟人化有社会后果 | 质性研究 1275 条（D2） | 中（平台样本偏豆瓣） |
| 双令牌体系是当前首要 UI 债务 | 仓库实查计数 | 强（可复核） |

**本次未覆盖**：真人可用性测试（无被试）、眼动/EEG 实测、跨文化（英文界面）验证、生产环境性能数据。上述结论如需升级为"已验证"，需按第 8 节出口条件补截图与计时测试。

---

## 10. 参考文献

**国内**

[1] 刘玉磊, 马艳阳. 面向生成式人工智能应用的意图驱动的界面交互范式探索[J]. 包装工程, 2024, 45(4): 58-66.
[2] 张妍, 赵宇翔, 吴大伟, 等. 人智交互情境中用户对生成式人工智能的心智感知及反应研究[J]. 情报理论与实践, 2024, 47(8): 140-149.
[3] 宋小康, 赵宇翔, 宋士杰, 等. 社会技术系统范式下AI赋能的替代信息搜索：特征、理论框架与研究展望[J]. 图书情报知识, 2023, 40(4): 111-121.
[4] 牛佳然, 吴晓莉, 张蓝, 等. 基于视觉认知特性的作战显控界面信息结构布局研究[J]. 包装工程, 2023, 44(22). DOI: 10.19554/j.cnki.1001-3563.2023.22.037.
[5] 陈鹤元, 钟文博, 杨洪泽, 等. 基于认知负荷的人机界面综合评价方法——以森林消防指挥车显控台为例[J]. 北京林业大学学报, 2025. DOI: 10.12171/j.1000-1522.20250070.
[6] 陈佳雯, 王雪松, 周楚. 基于综合评估模型的车载界面单行中文字数评估[J]. 交通与运输, 2024(4): 19-25.
[7] SHENG R, YANG Y, SHI C, et al. DiLLS: Interactive Diagnosis of LLM-based Multi-agent Systems via Layered Summary of Agent Behaviors[EB/OL]. arXiv:2602.05446, 2026.
[8] GAO T, LI H, LI J, et al. Graph of Trace: Visualizing Execution Traces of Scientific Agents[C]//ACL 2026 System Demonstrations. 2026.
[9] LU J, ZHANG Z, YANG F, et al. AXIS: Efficient Human-Agent-Computer Interaction with API-First LLM-Based Agents[C]//ACL 2025 (Long Papers). 2025.
[10] LU J, PAN B, CHEN J, et al. AgentLens: Visual Analysis for Agent Behaviors in LLM-based Autonomous Systems[EB/OL]. arXiv:2402.08995, 2024.

**国外**

[11] MOZANNAR H, BANSAL G, TAN C, et al. Magentic-UI: Towards Human-in-the-loop Agentic Systems[EB/OL]. arXiv:2507.22358, 2025.
[12] EPPERSON W, BANSAL G, DIBIA V, et al. Interactive Debugging and Steering of Multi-Agent AI Systems[C]//CHI '25. 2025. DOI: 10.1145/3706598.3713581.
[13] DIBIA V, CHEN J, BANSAL G, et al. AutoGen Studio: A No-Code Developer Tool for Building and Debugging Multi-Agent Systems[C]//EMNLP 2024 System Demonstrations. 2024.
[14] SCHÖMBS S, ZHANG Y, GONCALVES J, et al. From Conversation to Orchestration: HCI Challenges and Opportunities in Interactive Multi-Agentic Systems[C]//ACM, 2025. DOI: 10.1145/3765766.3765795.
[15] PAREEK S, GOVERS J, KOLLERUP N K, et al. Sensemaking in Multi-Agent LLM Interfaces: How Users Interpret Transparency and Trustworthiness Cues[C]//CHI '26. 2026.
[16] DORO P, DROOFF C, CHEN J, et al. ADEPTS: A Capability Framework for Human-Centered Agent Design[EB/OL]. arXiv:2507.15885, 2025.
[17] WISCHNEWSKI M, KRÄMER N, MÜLLER E. Measuring and Understanding Trust Calibrations for Automated Systems[C]//CHI '23. 2023. DOI: 10.1145/3544548.3581197.
[18] TATASCIORE M, STRICKLAND L, LOFT S. Transparency improves the accuracy of automation use, but automation confidence information does not[J]. Cognitive Research: Principles and Implications, 2024.
[19] ROMEO G, CONTI D. Exploring automation bias in human–AI collaboration: a review and implications for explainable AI[J]. AI & Society, 2025.
[20] GOYAL N, CHANG M, TERRY M. Designing for Human-Agent Alignment: Understanding what humans want from their agents[C]//CHI '24. 2024.
[21] MA S, WANG X, LEI Y, et al. "Are You Really Sure?" Understanding the Effects of Human Self-Confidence Calibration in AI-Assisted Decision Making[C]//CHI '24. 2024.
[22] FENG K J K, KIM T S, PANG R Y, et al. On the Regulatory Potential of User Interfaces for AI Agent Governance[EB/OL]. arXiv:2512.00742, 2025.

---

## 附录 A：实查证据快照

| 检查项 | 命令 / 位置 | 结果 |
|---|---|---|
| 字号令牌 | `superagent.css` §1 Tokens | `2xs/xs/sm` 均为 12px |
| 12px 使用次数 | 正则计数（`.css`） | superagent 22 / mobile 25 / projects 8 |
| 对比度 | WCAG 公式脚本 | 最低 4.66:1（warning-soft），全部 ≥ AA |
| 状态点 | `.sa-recent-dot` / `.sa-card2-dot` | 7px，仅 `background` |
| 状态色族 | `superagent.css` 2748–2789 | 20+ 枚举 → 4 色族 |
| 令牌双轨 | 逐文件 `var(--sa-*)` vs `var(--surface/text/…)` | 1664 vs 405+ |
| 裸 hex | 同上 | styles 332 / projects 117 / concise 76 / appearance 58 |
| 流式步骤 | `SuperAgentShell.tsx` `steps.slice(-8)` | 仅 8 条，无总览 |
| aria-live | `sa-live-steps`（1762） | 已有 polite |
| skip-link | `SuperAgentShell.tsx:2099` | 已有 |
| 骨架屏 | `skeleton` / `shimmer` | 0 命中 |
| 44px 强制 | `concise-theme.css` | `min-height: 44px` 全局 |

## 附录 B：不做的事（防止范围漂移）

1. 不改 `/api/work/*` 任何接口；不改 `WorkTicket` / `WorkPlan` / `WorkTrace` 类型。
2. 不改执行器派发、审批、验收、会话续接的判定逻辑。
3. 不新增运行时依赖（不引组件库、不引图表库替换）。
4. 不新增页面路由；「更多」内的页面结构保持不变。
5. 不引入 Agent 人格化元素；不新增 AI 自评分数。
6. 移动端 `MobileApp` 的配网/配对流程不在本次范围。
