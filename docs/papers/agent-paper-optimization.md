# Agent 论文筛选与 Lagent 优化清单（2023-11 → 2026-11）

> 检索与撰写日期：2026-11-18
> 时间窗：近三年（2023 年 11 月 – 2026 年 11 月），经典奠基工作（ReAct 等）只作背景引用，不进改造清单。
> 覆盖：arXiv（cs.AI / cs.SE / cs.CL / cs.CR）、NeurIPS / ICML / ICLR / ACL / EMNLP / ICSE / VLDB，以及国内团队（清华、北大、阿里、上交、DeepWisdom / MetaGPT 社区、智谱）。
> 本文是 `docs/papers/` 下**唯一**的论文文档，合并并取代了 2026-11-18 第一版（旧版已移至 `backups/agent-paper-optimization-2026-11-18-v1.md`）。

---

## 0. 结论先行

读完近三年约 45 篇相关论文后，对 Lagent 最重要的判断有五条：

1. **多智能体不是默认答案，Lagent 的价值应落在"控制面"而不是"角色数"。**
   2026 年多篇独立研究在等预算下得到同一结论：单 Agent 常常追平甚至超过多 Agent 团队；多 Agent 的"收益"很大一部分只是多花 token 买到的重复计算（见第 3 节）。Lagent 真正稀缺的能力是**可靠派发、可验证交付、权限收敛、成本可控**——这四件事单 Agent 也需要，多 Agent 更需要。

2. **失败要先能被分类，才谈得上优化。**
   MAST（2503.13657）用 1,600+ 条标注轨迹证明：多 Agent 失败率 41%–86.7%，且多数是系统设计问题而非模型能力问题。Lagent 的 `critic.js` 目前只有 `pass/revise/reject/unreviewed` 四态，没有失败类型，导致所有干预都无法度量。

3. **上下文要分层 + 增量维护，绝不能"让模型重写整段记忆"。**
   ACE（2510.04618）的坍缩案例、MemGPT（2310.08560）的分页思路、Context Engineering 综述（2507.13334）的组件分类，指向同一件事：`buildLibraryContext` 现在的 `slice(0, 1200)` 式截断会**截掉结论、留下开头**，是最差的一种压缩。

4. **长链条的可靠性来自"事务语义"，不是更聪明的提示词。**
   SagaLLM（2503.11951，VLDB 2025）把补偿回滚、检查点、独立校验 Agent 引入多 Agent 规划。Lagent 已有 `outbox.js` / `effects.js` / 工单状态机，差的是**可回放的补偿动作**和**幂等键**。

5. **安全要分两层：模型层防不住，系统层才防得住。**
   CaMeL（2503.18813）证明控制流与数据流分离可以把注入变成"无法影响执行计划"；AgentSpec（2503.18666）证明毫秒级规则拦截可行。Lagent 的 `classifyCommand` 是四档硬编码，缺"规则 + 执行动作"的表达力。

---

## 1. 筛选口径

### 三条硬门槛（全过才进第 4 节精读）

1. **可映射**：能落到 Lagent 已有模块，且指向真实符号（第 4 节每一条都标了文件与函数）。
2. **可验收**：能写出量化指标（token 降幅、失败模式占比、误报率、判定耗时、成本）。
3. **不依赖重训**：不要求微调、不要求新建标注数据集；需要训练的方法只进对照表。

### 排除与降级规则

| 情况 | 处理 |
|---|---|
| 只在单一榜单刷分，机制不可迁移 | 只进参考文献，不进改造 |
| 依赖大规模合成数据训练工具调用模型（ToolLLaMA、Gorilla 训练部分） | 只取"检索 + 多路径决策"的思路 |
| 需要改模型权重（Titans、AgentTuning、RL 训练类） | 不进路线图，仅作方向对照 |
| 纯协议规范（MCP / A2A） | 作为互操作参考，不当作优化点 |
| 2026 年新预印本、数字未复现 | 进正文但**标注待核**，不写进验收标准 |

### 仓库现状核对（2026-11-18 实查）

改造点必须挂在真实符号上，所以先核对。**与第一版相比有两处更正**：

| 位置 | 实查结果 |
|---|---|
| `server/application/policy/command-risk.js:58` | `classifyCommand()` 返回 `{level:'read'|'write'|'danger'|'blocked', reasons}`；`isBlockedCommand()` 在其上封装 |
| `server/work/command-risk.js` | 仅 re-export 转发层 |
| `server/critic.js:5/13/34/35` | `critiquePlan` / `critiqueResult` 存在，异常时兜底 `unreviewed()`；**无失败类型字段** |
| `server/work/verify.js` | **存在**（第一版误记为"未发现"）。功能是跑验收命令：`SAFE_PROGRAMS` 白名单 + `SAFE_NPM_SCRIPTS` 白名单 + 拒绝 shell 元字符，`MAX_OUTPUT=4000`。它只回答"命令是否通过"，不回答"为什么失败" |
| `server/work/project-memory.js` | `tokenizeQuery` / `scopeMatches` / `scoreMemoryEntry` / `createProjectMemory` / `summarizeExecution`；关键词打分 + 扁平条目，无标签、无链接 |
| `server/work/agent-context.js:45` | `buildLibraryContext(library, {executorId, maxChars = 1200})`，超预算时 `body.slice(0, maxChars)` 硬截断 |
| `server/eval/tasks.js` | 5 条固定任务（`create-file` / `plan-two-steps` / `verify-pass` / `verify-fail` / `reject-escape`），骨架可用但样本太少 |
| 全仓库 | **未发现**任何工具检索/排序函数（`rankTools` / `selectTools` / `toolRelevance` / `scoreTool` 均无命中） |

这两条"未发现"（失败分类、工具检索）是 P0 的直接依据。

---

## 2. 论文总表

优先级：**P0** = 两周内可落且收益直接；**P1** = 一个迭代；**P2** = 需要协议/架构改动。

### A. 编排与工作流

| # | 论文 | 年份 / 出处 | 一句话机制 | 命中模块 | 优先级 |
|---|---|---|---|---|---|
| A1 | AFlow: Automating Agentic Workflow Generation | ICLR 2025 Oral | 工作流即代码图，用 MCTS 搜拓扑；小模型配好拓扑可逼近大模型 | `work/orchestrator/`、`team-templates.js` | P2 |
| A2 | SagaLLM | VLDB 2025（2503.11951） | 把 Saga 事务模式引入多 Agent 规划：补偿回滚 + 检查点 + 独立校验 | `outbox.js`、`effects.js`、`engine.js` settle | P1 |
| A3 | Agent Workflow Memory | 2024（2409.07429） | 从历史轨迹中归纳"可复用工作流"，下次直接注入 | `project-memory.js`、`skills/` | P1 |
| A4 | ExpeL: LLM Agents Are Experiential Learners | AAAI 2024（2308.10144） | 对比成功/失败轨迹提炼自然语言洞见，存入经验池，测试时召回 | 失败反思（接 Reflexion） | P1 |
| A5 | The Horizon Gap | 2026（2608.06663） | 长程任务里"只看结果"的信号会失效，必须引入过程级信号 | `critic.js`、`eval/` | P1 |
| A6 | Beyond the Leaderboard（失败综述） | 2026（2607.05775） | 27 篇基准/审计归纳出六类失败簇，含"上下文累积导致长程退化" | `agent-context.js` | P1 |
| A7 | MetaGPT | ICLR 2024 Oral（2308.00352） | 把 SOP 写进角色 prompt，强制结构化交付物 | `team-templates.js`、`sheet.js` | P2 |
| A8 | AutoGen | 2023（2308.08155） | conversable agent + conversation programming + human-in-the-loop | `team-room.js` | P2 |
| A9 | AgentScope | 2024（2402.14034，阿里） | 消息交换为核心 + 内置容错 + 全链路监控 | `outbox.js`、`live-session.js` | P2 |
| A10 | Agentic AI Frameworks 综述 | 2025（2508.10146） | 横向对比 CrewAI / LangGraph / AutoGen / MetaGPT 等的架构、记忆、护栏 | 全局参照 | — |

### B. 上下文与记忆

| # | 论文 | 年份 / 出处 | 一句话机制 | 命中模块 | 优先级 |
|---|---|---|---|---|---|
| B1 | Agentic Context Engineering (ACE) | 2025（2510.04618） | 上下文当"可进化剧本"：Generator→Reflector→Curator，增量合并 | `agent-context.js`、`project-memory.js` | P0 |
| B2 | MemGPT | 2023（2310.08560） | 仿 OS 虚拟内存：主上下文 + 外部存储换页 | `agent-context.js` | P0 |
| B3 | A Survey of Context Engineering | 2025（2507.13334） | 组件（检索/处理/管理）+ 实现（RAG/记忆/工具/多 Agent）双轴分类 | `agent-context.js` | P0 |
| B4 | Everything is Context（文件系统抽象） | 2025（2512.05470） | 上下文当可挂载、可治理的文件系统：构造→装载→评估三段 | `artifacts/`、`handoff.js` | P2 |
| B5 | A-MEM: Agentic Memory | 2025（2502.12110） | 卡片笔记（关键词/标签/描述）+ 动态链接 + 记忆进化 | `project-memory.js` | P1 |
| B6 | Mem0 | 2025（2504.19413） | 抽取→合并→去重的事实型记忆层，只召回相关事实 | `project-memory.js` | P1 |
| B7 | MemoryOS | 2025 | 短/中/长三层记忆 + 动态更新 + 自适应检索 | `project-memory.js` | P2 |
| B8 | HippoRAG | NeurIPS 2024（2405.14831） | 知识图谱 + 个性化 PageRank 做多跳记忆检索 | `project-memory.js` | P2 |
| B9 | Lost in the Middle | 2023（2307.03172） | 长上下文中段信息利用率显著下降 | 注入顺序设计 | P0（设计约束） |
| B10 | LLMLingua / LongLLMLingua | 2023–2024 | 小模型给 token 打分做压缩，query-aware 版本保留问题相关内容 | 超预算压缩策略 | P1 |

### C. 工具、执行器与接口

| # | 论文 | 年份 / 出处 | 一句话机制 | 命中模块 | 优先级 |
|---|---|---|---|---|---|
| C1 | ToolLLM / ToolBench | ICLR 2024（2307.16789，清华） | 万级 API 下先检索、再 DFSDT 多路径决策 | `skills/`、`mcp.js`、`executors/` | P0 |
| C2 | Re-Invoke | 2023（2310.17012） | 合成 query + 多视角重排的零样本工具检索 | 工具检索基线算法 | P0 |
| C3 | Smurfs | 2024（2405.05955） | 子 Agent 只回压缩结论，token 降 60.9% | 子 Agent 回传协议 | P0 |
| C4 | SWE-agent（ACI） | NeurIPS 2024（2405.15793） | 为 Agent 专门设计"计算机接口"，接口设计直接决定表现 | `executors/`、工具描述文案 | P1 |
| C5 | Agentless | 2024（2407.01489） | 固定三段流水线（定位→修复→验证）胜过复杂自主 Agent，成本 $0.70 | 反对"过度自主"的证据 | P1（设计原则） |
| C6 | CodeAct / OpenHands | 2024（2407.16741） | 用可执行代码而非 JSON 作为动作空间 | `executors/cli.js` 的输入形态 | P2 |
| C7 | LLMCompiler | 2023（2312.04511） | 先把任务编译成 DAG，再并行调工具 | `advancePlan` 并行度 | P2 |
| C8 | Terminal-Bench | 2025 | 容器内终端任务，按最终状态判分（80→112 题） | `eval/tasks.js` 任务形态 | P1 |
| C9 | MCP / ACP / A2A / ANP 协议综述 | 2025（2505.02279） | MCP 管工具接入，A2A 管 Agent 间委派 | `mcp.js`、`handoff.js` | P2 |

### D. 验证与评测

| # | 论文 | 年份 / 出处 | 一句话机制 | 命中模块 | 优先级 |
|---|---|---|---|---|---|
| D1 | Why Do Multi-Agent LLM Systems Fail? (MAST) | NeurIPS 2025（2503.13657） | 3 类 14 种失败模式，κ=0.88，可标注可归因 | `critic.js`、`verify.js` | P0 |
| D2 | CRITIC | ICLR 2024（2305.11738，清华/MSRA） | 自省式纠错不可靠，**必须接外部工具取证** | `critic.js` + `verify.js` 联动 | P0 |
| D3 | Chain-of-Verification (CoVe) | 2023（2309.11495） | 先出草稿，再独立回答校验问题（不让草稿污染校验） | 校验 prompt 设计 | P1 |
| D4 | Self-Refine | NeurIPS 2023（2303.17651） | 生成-自评-改写循环，7 任务平均 +20% | `critic.js` 迭代上限 | P1 |
| D5 | Reflexion | NeurIPS 2023（2303.11366） | 失败后写语言化反思进记忆，重试时注入 | 重试路径 + 记忆 | P0 |
| D6 | AgentRewardBench | 2025（2504.08942） | LLM 评审**系统性高估**成功率（精确率很少超过 ~70%） | `critic.js` 的可信度边界 | P0（约束） |
| D7 | Agent-as-a-Judge | ICML 2025（2410.10934） | 用带工具的 Agent 审整条轨迹，而非只看最终答案 | `eval/runner.js` | P1 |
| D8 | Frozen Judges, Moving Agents | 2026（2609.34198） | 评审与被评版本耦合，判分漂移会被误读为"升级" | `eval/` 版本固定 | P2 |
| D9 | AgentBench | ICLR 2024（2308.03688，清华） | 8 类环境统一评测，暴露多轮交互缺陷 | `eval/` | P1 |
| D10 | τ-bench | 2024（2406.12045） | 工具-用户-领域规则三方交互，考察一致性与规则遵循 | `eval/tasks.js` | P2 |

### E. 安全、权限与注入

| # | 论文 | 年份 / 出处 | 一句话机制 | 命中模块 | 优先级 |
|---|---|---|---|---|---|
| E1 | AgentSpec | ICSE 2026（2503.18666） | 规则 = 触发事件 + 谓词 + 执行动作；毫秒级 | `command-risk.js` | P1 |
| E2 | CaMeL: Defeating Prompt Injections by Design | 2025（2503.18813，DeepMind/ETH） | 从可信 query 提取控制流，工具数据只能做数据不能改流程 | 执行器输入隔离 | P1 |
| E3 | AgentDojo | NeurIPS 2024（2406.13352） | 动态环境同时测"攻击成功率"和"正常任务可用性" | `eval/` 安全维度 | P1 |
| E4 | InjecAgent | ACL Findings 2024（2403.02691） | 工具返回值里的间接注入 | MCP / 外部工具输出 | P1 |
| E5 | Ignored, Not Refused | 2026（2610.23254） | 被挡住的注入里 76–80% 只是"被忽略"而非"被拒绝" | 安全指标定义 | P1（度量纠偏） |
| E6 | Agent Skills 安全综述 | 2026（2602.12430） | 社区技能 **26.1% 含漏洞** | `skills/installer.js` 审查 | P0（安装期） |
| E7 | 单 Agent 对齐、组队后失守 | 2026（2611.17820，Harvard/Anthropic） | 责任扩散导致群体安全行为退化 | `team-*` 安全责任人 | P2 |

### F. 成本与模型路由

| # | 论文 | 年份 / 出处 | 一句话机制 | 命中模块 | 优先级 |
|---|---|---|---|---|---|
| F1 | FrugalGPT | 2023（2305.05176） | 便宜模型先答，不可靠再升级（串行级联） | `model-hub.js` | P2 |
| F2 | RouteLLM | 2024（2406.18665） | 生成前用分类器预测"是否需要强模型"（并行路由） | `model-hub.js` | P2 |

### G. 多智能体（含"什么时候不该拆"）

| # | 论文 | 年份 / 出处 | 一句话机制 | 用途 |
|---|---|---|---|---|
| G1 | Improving Factuality via Multiagent Debate | 2023（2305.14325） | 多实例互相阅读并修正，提升事实性 | 辩论模式依据 |
| G2 | Tran & Kiela：等预算下单 Agent ≥ 多 Agent | 2026（2604.02460） | 多 Agent "收益"多为重复计算，非真协作 | **强约束** |
| G3 | When Does Multi-Agent Collaboration Help? 熵视角 | 2026（2602.04234） | 单 Agent 在 ~43.3% 情况下取胜；首轮基本决定结果 | **强约束** |
| G4 | Worse Together | 2026（2610.00583） | Agent 团队仅达最优组局面的 12–30%，单协调者 32–64% | **强约束** |
| G5 | Rethinking Multi-Agent Collaboration | 2026（2609.19759） | 只在"长程 + 稀疏依赖"任务上多 Agent 才占优 | 拆分判据 |
| G6 | Does Multi-Agent Collaboration Pay?（双控） | 2026（2610.27655） | 13 个有效格中 12 个更差，加权 −28 分，最好也得花 5.5× token | **强约束** |
| G7 | Multi-Agent Collaboration Mechanisms 综述 | 2025（2501.06322） | 角色分化、编排模式、协作机制的分类 | 术语统一 |

### H. 技能沉淀

| # | 论文 | 年份 / 出处 | 一句话机制 | 命中模块 | 优先级 |
|---|---|---|---|---|---|
| H1 | Voyager | 2023（2305.16291） | 技能 = 可执行代码，自动积累 + 检索 | `skills/catalog.json` | P2 |
| H2 | Dynamic Agent Skills（生命周期综述） | 2026（2607.10113） | 124 篇审计：六种"技能"定义 + 八阶段生命周期 | `skills/service.js` | P1 |
| H3 | SoK: Agentic Skills | 2026（2602.20867） | 七种设计模式 + 表征-范围双分类 | `skills/` | P1 |
| H4 | A Systematic Survey of Agentic Skills | 2026（2608.29596） | 九阶段生命周期（发现→创作→存储→检索→编排→执行修复→终身适应→评测→治理） | `skills/` | P1 |

---

## 3. 反直觉证据专章：多智能体什么时候真的有用

这一节单独成章，因为它直接决定 Lagent 的产品优先级。

### 3.1 证据

| 研究 | 设定 | 结论 |
|---|---|---|
| Tran & Kiela（2604.02460） | 固定推理 token 预算、理想上下文利用 | 单 Agent 在多跳推理上"一致追平或超过"多 Agent；2 数据集 × 3 模型族 × 5 种 MAS 架构 |
| 熵视角（2602.04234） | 对比单 Agent 与 MAS | 单 Agent 在约 **43.3%** 的用例中取胜；结果大多在第一轮就已决定 |
| Worse Together（2610.00583） | 多用户多 Agent 团队 vs 单协调者 | 团队达最优组局面的 **12–30%**，单协调者 **32–64%**；参与率从 4 人时的 66–82% 掉到 16 人时的 10–25% |
| 双控实验（2610.27655） | τ²-bench 双控设置 | 13 个有效格中 **12 个更差**，加权均值 **−28 分**；最好情况也只是在 **5.5× token** 成本下打平 |
| Rethinking（2609.19759） | 任务依赖结构 | 只在**长程 + 稀疏依赖**任务上占优；紧耦合顺序流程里单 Agent harness 更好 |

### 3.2 对 Lagent 的四条推论

1. **默认单 Agent，多 Agent 要"申请"。**
   派发页应有一个判据：任务是否"长程且子任务之间依赖稀疏"。不满足就别拆。现在 Lagent 以"多 Agent 指挥台"为卖点，但如果没有这个判据，用户会默认拆，然后付 5–15× token 换更差的结果。

2. **比较必须等预算。**
   评估多 Agent 收益时，对照组要吃掉同样的 token 预算。否则测到的是"钱多"，不是"协作好"。

3. **协调开销要能被看见。**
   `session-usage.js` / `usage.js` 已有用量统计，应拆成"执行 token / 协调 token"。协调占比超过阈值就应提示合并角色。Anthropic 公开数据里多 Agent 约 15× token，且 token 用量本身能解释大部分任务表现方差。

4. **群体安全会退化。**
   2611.17820 显示单个 Agent 对齐良好，组队后安全行为下降（责任扩散）。缓解办法是**指定一名安全责任人 + 共享安全规格**——这正好可以落到 `team-*` 的房间配置里。

> 需要注意：第 3 节引用的 2026 年预印本，其具体数字多为摘要级，未逐篇复现。结论方向在 4 篇独立工作中一致，可信度较高；精确数值不要写进验收标准。

---

## 4. 分主题精读（只写：机制 → 落点 → 验收）

### 4.1 MAST：先给失败装分类法（P0）

**机制**：3 大类 14 种失败模式。构建方式为 150 条初始轨迹 + 6 名专家标注（Cohen's κ=0.88），扩展到 1,600+ 条轨迹、7 个框架（ChatDev、MetaGPT、HyperAgent、AppWorld、AG2、Magentic-One、OpenManus）。核心论断：**失败多源于系统设计，而非模型能力**。

**落点**：`server/critic.js` 增加 `failureMode` 枚举。第一批只做 6 项，且每项都要有 Lagent 内可观测的信号：

| 代号 | 模式 | 可观测信号 |
|---|---|---|
| FM-1.3 | 步骤重复 | 同一 `(executorId, 归一化 command)` 在计划内出现 ≥2 次 |
| FM-2.2 | 该澄清不澄清 | 需求含未解析占位符（`TODO`、`<xxx>`、空变量）仍派发 |
| FM-2.3 | 任务偏航 | 产出文件与工单目标无交集 |
| FM-2.4 | 隐瞒信息 | 子 Agent 回传缺少"结论/证据"任一段 |
| FM-3.2 | 无/不完整验证 | 工单 `done` 但无 `verify.js` 或 `critic.js` 记录 |
| FM-3.3 | 错误验证 | critic 判 pass 但复跑 `verify` 失败 |

**验收**：能从 `data/` 直接统计一周内各 `failureMode` 占比；重复步骤类失败占比下降 ≥30%。

**边界**：不要一次上满 14 类。论文里各模式的具体占比（如"步骤重复 15.7%"）来自二手摘要，**未核原文**，不要作为目标值。

---

### 4.2 CRITIC：自省不可靠，验证必须取证（P0）

**机制**：Self-Refine 证明"生成-自评-改写"循环便宜有效（7 任务平均 +20%），但 CRITIC 直接反驳其前提——纯自评复用的是产生错误的同一份参数知识，模型会自信地为错误辩护。CRITIC 的做法是"先验证再修正"：草稿 → 调外部工具（搜索、代码解释器）取证 → 基于证据批注 → 修订。结论：**脱离外部反馈的自纠错收益很小甚至为负**。

**落点**：这是 Lagent 最容易做对也最容易做错的一处。`critic.js` 和 `verify.js` 现在互不相干：前者看结构，后者跑命令。应建立一条固定链路：

```
工单产出 → verify.js 跑验收命令（外部证据）
        → critic.js 读取 verify 结果 + 产物结构
        → verdict: pass | revise | reject | unreviewed
```

`critiqueResult` 的入参里补 `verification` 字段（命令、退出码、输出摘要），让"通过"有外部依据，而不是只看 `findings` 数组是否为空。

**验收**：critic 判 `pass` 但复跑 `verify` 失败的样本（FM-3.3）占比从当前基线降到 <5%。

---

### 4.3 AgentRewardBench：评审会系统性高估（P0 约束）

**机制**：1,302 条专家标注轨迹、5 个基准、4 个模型。结论：没有单一 LLM 评审在所有基准上都好；LLM 评审**高估成功率**（精确率很少超过 ~70%），而规则评审**低估**。

**落点**：`critic.js` 的 pass 不能等同于"任务成功"。需要三层：

| 层 | 判据 | 可信度 |
|---|---|---|
| 规则/执行 | `verify.js` 退出码、文件存在性、schema 校验 | 高（可复现） |
| 结构评审 | `critic.js` 现有逻辑 | 中 |
| LLM 评审 | 可读性、完整性、意图匹配 | 低（仅作参考） |

展示层（`run-projection.js`、前端工单详情）要能区分"通过验证"和"评审认为通过"。

**验收**：任一工单的最终状态都能追溯到具体判据层；`pass` 中由规则层支撑的比例 ≥60%。

---

### 4.4 ACE：上下文当"可进化剧本"（P0）

**机制**：Generator 产出轨迹 → Reflector 从成功与失败中提炼洞见 → Curator 把洞见**作为增量 delta** 合并进结构化剧本。针对两个失效模式：**brevity bias**（过度压缩丢掉领域细节）与 **context collapse**（反复重写后上下文坍缩、性能反降）。核心手段是 `grow-and-refine`：条目只增、只合并、只淘汰，不做全文重写。

**关键数据**：相比强基线，agents 任务 +10.6%、金融任务 +8.6%；适应延迟降低约 86.9%。论文自述坍缩案例：第 60 步上下文从 18,282 token / 66.7 分掉到 122 token / 57.1 分，低于"不做适应"的 63.7。

**落点**：`project-memory.js` 旁新增 `playbook`，条目结构：

```js
{
  id,
  trigger: { executorId, taskType, tags: [] },
  insight: '≤200 字，必须带条件与反例',
  evidence: [ticketId],
  counter: [ticketId],   // 反例，缺此项权重减半
  hits, lastUsedAt, createdAt
}
```

三件事：
1. **Reflector**：工单 settle 时跑。先做规则版（从 report + 失败原因拼装），不调模型也能上。
2. **Curator**：只合并同 trigger 的条目、累加 `hits`，不改正文；总数上限 200，超限按 `hits` 淘汰。
3. **注入**：改 `buildLibraryContext`，先按 `trigger` 命中筛条目，再在预算内按 `hits` 排序截断。

**验收**：同项目连做 10 个同类工单，第 8–10 单注入 token 比第 1 单降 ≥25%，成功率不降；playbook 条目数稳定 ≤200。

**边界**：只有正例没有反例的条目打半折，否则反思会污染后续任务。

---

### 4.5 上下文分层：MemGPT + Context Engineering 综述（P0）

**机制**：MemGPT 把上下文当虚拟内存——主上下文常驻、外部存储按需换入换出。综述（2507.13334）给出组件分类：检索生成、上下文处理（长序列、自精炼、结构化整合）、上下文管理（记忆层级、压缩、优化）。另外 Anthropic 工程侧的 write / select / compress / isolate 四操作可作为落地口径（**注意：这来自官方博客，不是 arXiv 综述的原始分类**）。

**落点**：`buildLibraryContext` 现在只有 `maxChars=1200` 硬截断，`slice` 会保留开头、丢掉结论。改成三层预算：

| 层 | 内容 | 超预算时 |
|---|---|---|
| system | 项目 brief、策略、角色规格 | 永不压缩 |
| working | 当前计划、最近 3 张工单摘要 | 先压摘要 |
| recall | 记忆检索结果、playbook 条目 | 先减条数 |

压缩顺序按"信息密度从低到高"淘汰，而不是从头截断。同时遵守 Lost in the Middle：**关键约束放首尾，中间放低优先级内容**。

**验收**：30 轮以上长会话，每轮注入 token 稳定在阈值内，不随轮次线性增长；`maxChars` 截断导致的"结论丢失"（末尾项缺失）为 0。

---

### 4.6 工具检索：ToolLLM + Re-Invoke（P0）

**机制**：ToolLLM 覆盖 16,000+ 真实 API，核心不是"塞更多工具"，而是 **API retriever 先选工具**，再用 **DFSDT（深度优先决策树）** 在候选路径上搜索——一条路失败可回退换路径，明显优于 ReAct 的单路贪心。Re-Invoke 给出零样本工具检索做法：合成 query + 多视角重排。

**落点**：仓库中**确实没有**任何工具排序函数（已实查）。在 `skills/service.js` 旁新增：

```js
rankTools(task, tools, { k = 8 })  // BM25 或 embedding + 类别先验
```

- `agent-context.js` 注入工具清单时改为 top-k，不再全量。
- 执行器失败重试从"同参数重试"升级为"换候选"：取 `rankTools` 第 2、3 名再试一次。

**验收**：注册工具 ≥40 个时，注入 token 降 ≥40%，30 条人工标注任务的工具首选准确率不低于改造前；二次重试成功率提升 ≥10%。

---

### 4.7 Smurfs：子 Agent 只回摘要（P0）

**机制**：把 DFSDT 拆到多 Agent，规划器/执行器/校验器分工，子 Agent 之间只传**压缩结论**。相比原生 DFSDT，token 用量降 60.9%。

**落点**：子 Agent 回传固定三段——`结论` / `证据指针（文件路径或 ticketId）` / `失败原因`。完整日志写 artifact，只回路径。主 Agent 汇总时不再拼全量输出。

**验收**：多 Agent 计划总 token 降 ≥30%，协调消息占比下降；子 Agent 结论可追溯率 100%（每条能点回证据）。

**注意**：结合第 3 节——如果任务不满足"长程 + 稀疏依赖"，就不该拆，这段协议用不上。

---

### 4.8 Reflexion + ExpeL：失败要留下东西（P0/P1）

**机制**：Reflexion 把任务反馈转成自然语言反思存入情景记忆，重试时复用，相当于零微调的"语言化强化学习"。ExpeL（清华，AAAI 2024）进一步：从成功与失败轨迹的对比中提炼洞见，存进经验池，测试时召回相似成功轨迹并应用洞见。

**落点**：接到现有重试路径（`maxTurns` 补充逻辑之前）：失败 → 生成一条 ≤120 字的反思（失败动作、错误现象、下次改法）→ 写入 `project-memory` 的 `scope='reflection'` → 同 executor 下次派发时前置注入。

**验收**：同类任务第二次尝试成功率比第一次提升 ≥10%；反思条目能被引用计数统计到。

---

### 4.9 SagaLLM：工单要有事务语义（P1）

**机制**：针对 LLM 规划的四个短板（自验证不可靠、上下文窄化、缺事务保证、Agent 间协调不足），引入 Saga 模式：补偿回滚、模块化检查点、独立校验 Agent，LLM 负责状态跟踪、依赖分析、日志 schema 生成与恢复编排。在 REALM 的序列/反应式规划问题上验证，显著改善约束遵循与故障恢复。

**落点**：Lagent 已有 `outbox.js`（投递）、`effects.js`（副作用）、工单状态机，差三样：

1. **幂等键**：每个 effect 带 `idempotencyKey = ticketId + stepId + attempt`，重放不重复执行。
2. **补偿动作**：工单定义 `compensate` 字段（如"删除已创建文件"），失败回滚时按逆序执行。
3. **检查点**：计划推进前落一次快照，恢复时从快照继续而不是从头重跑。

**验收**：人为杀掉执行器中途进程，恢复后不出现重复副作用；回滚后工作区与开工前一致（用目录哈希比对）。

---

### 4.10 AgentSpec：权限四档升级为规则表（P1）

**机制**：规则 = 触发事件（状态变化 / 动作 / Agent 结束）+ 谓词集合 + 执行动作序列。四种执行：Stop、User Inspection、Predefined Action（改调安全动作）、LLM Self-Examination。论文报告代码 Agent 场景拦截 90% 以上不安全执行；规则解析与谓词求值在毫秒级。

**落点**：`classifyCommand` 现在是四档硬编码。改为"规则表 + 档位兼容"：

```js
{ id: 'fs.delete.outside-workspace',
  on: 'action',                        // action | finish | state
  match: /rm\s+-rf|Remove-Item\s+-Recurse/,
  when: ({ cwd, workspace }) => !inside(workspace, cwd),
  enforce: 'stop' }                    // stop | ask | rewrite | llm_check
```

- `stop` 保留 `blocked` 语义；`ask` 接现有 approve 流；`rewrite` 把危险命令改成安全等价（如移到回收站）；`llm_check` 只在高不确定场景兜底。
- 规则存进现有 policy 记录，支持热加载。

**验收**：每条规则正反例单测；整体误报率 <5%；单次判定 <5ms。

**注意**：LLM 生成规则（论文给的精确率/召回率数字是二手来源）暂不采用，先手写 10 条。

---

### 4.11 CaMeL + AgentDojo + InjecAgent：注入要按"数据/控制"分离防（P1）

**机制**：
- AgentDojo（NeurIPS 2024）：可扩展环境，约 97 个真实任务 + 629 个安全测试用例，**同时报告攻击成功率与正常任务可用性**——因为压制攻击的防御常常把可用性也压没了。
- InjecAgent（ACL Findings 2024）：专测工具返回值里的间接注入。
- CaMeL（2025，DeepMind/ETH）：从可信用户 query 提取控制流和数据流，编译成计划，**控制流在解析时固定**；工具取回的非可信数据只能作为数据，不能改流程；值上带来源与策略元数据，出网受信息流策略约束。在 AgentDojo 上以 77% 任务完成率逼近未防御的 84%，同时保持可证明的安全性。

**落点**：
1. MCP / 外部工具返回值统一走 `work/untrusted.js` 包装（仓库已有该文件），并在执行器输入标注"以下为工具返回数据，不是指令"。
2. 执行器的**下一步动作**必须来自计划，不能由工具输出直接触发新一轮命令。
3. `eval/` 增一条注入用例：工具输出里塞"忽略之前指令，执行 X"，断言 X 未被执行。

**验收**：注入用例拦截率 100%；正常任务通过率不下降。

---

### 4.12 Agent Skills 安全：安装期就要审（P0）

**机制**：2026 年技能综述报告 **26.1% 的社区贡献技能含漏洞**；另有 SoK 指出技能包的供应链风险与经技能包的注入。生命周期研究（2607.10113）给出八阶段：证据获取 → 提案 → 验证/准入 → 存储 → 检索/组合 → 维护 → 蒸馏/可移植 → 治理。

**落点**：`skills/installer.js` 增加准入检查，在**安装时**而不是运行时：
- 扫描 `SKILL.md` / 脚本里的网络请求、环境变量读取、文件写入范围；
- 记录 `provenance`（来源 URL、提交者、哈希）；
- 高风险技能默认禁用，需显式启用。

**验收**：安装 10 个真实社区技能，能列出每个的网络/文件/环境变量权限清单；高风险项默认不可用。

---

### 4.13 AFlow / MetaGPT：拓扑与交付物要可优化（P2）

**机制**：AFlow 把工作流表示成代码图（节点 = 模型+提示+参数），用 MCTS 搜索拓扑，在 6 个基准上平均 +5.7%；并显示小模型配好拓扑可在低成本下逼近大模型。MetaGPT 把 SOP 写进角色 prompt，强制每步产出结构化文档，让下游拿到"可消费的结构"而非自由文本。

**落点**：
- `team-templates.js` 的模板增加 `steps[]`，每步带 `deliverable: { schema }`，产物由 `sheet.js` 投影。
- 长期：把"角色 + 步骤 + 交付物"落成可搜索的结构，评测分数回写，逐步淘汰低分拓扑。

**验收**：模板产出结构合规率（字段齐全）≥90%。

**不建议现在做**：AFlow 式的自动拓扑搜索。Lagent 目前评测样本只有 5 条，搜索会过拟合到这 5 条。先把 `eval/` 扩到 30 条以上。

---

### 4.14 成本路由：FrugalGPT 与 RouteLLM（P2）

**机制**：FrugalGPT 是串行级联——便宜模型先答，质检不过再升级（论文报告最高省 98.3%，但受基准与模型价差影响很大）。RouteLLM 是前置预测——用偏好数据训练路由分类器，生成前决定用强模型还是弱模型（报告成本降 >2×）。

**落点**：`model-hub.js` 已有供应商池，可加一层策略：
- 默认按"工单风险档"选模型：`read`/`write` 用中档，`danger` 或需长链推理用强模型；
- 级联只在**有可靠验收**的工单上启用（有 `verify.js` 命令），否则"质检"本身不可信。

**验收**：单位任务成本降 ≥20%，成功率不降。

**顺序提醒**：必须在 MAST 分类 + verify 联动之后再做，否则无法判断"升级是否必要"。

---

## 5. 按模块汇总的改造清单

| 模块 / 文件 | 改造 | 依据 | 优先级 | 验收 |
|---|---|---|---|---|
| `server/critic.js` | `failureMode` 六类归因 | MAST | P0 | 失败分布可统计 |
| `server/critic.js` | 接入 `verification` 证据，区分三层判据 | CRITIC、AgentRewardBench | P0 | FM-3.3 <5% |
| `work/agent-context.js` | 三层预算 + 按密度淘汰 + 首尾重排 | MemGPT、Context Eng. 综述、Lost in the Middle | P0 | token 不随轮次增长 |
| `work/agent-context.js` | playbook + 工具 top-k 注入 | ACE、ToolLLM | P0 | token −25%~−40% |
| `work/project-memory.js` | playbook / reflection 两个 scope | ACE、Reflexion、ExpeL | P0 | 二次成功率 +10% |
| `work/skills/service.js` | `rankTools()` 检索层 | ToolLLM、Re-Invoke | P0 | 首选准确率不降 |
| 子 Agent 回传协议 | 三段式（结论/证据/失败原因） | Smurfs | P0 | 多 Agent token −30% |
| `work/skills/installer.js` | 安装期权限审查 + provenance | Agent Skills 安全综述 | P0 | 高风险默认禁用 |
| `application/policy/command-risk.js` | 规则表 + 4 种执行动作 + 热加载 | AgentSpec | P1 | 误报 <5%，<5ms |
| `work/outbox.js`、`effects.js` | 幂等键 + 补偿动作 + 检查点 | SagaLLM | P1 | 无重复副作用 |
| `work/untrusted.js` + 执行器 | 数据/控制流分离 | CaMeL、InjecAgent | P1 | 注入用例 100% 拦截 |
| `work/project-memory.js` | 卡片化（keywords/tags/description）+ 1-hop 链接 | A-MEM、Mem0 | P1 | 命中率 +15% |
| `skills/service.js` | 生命周期：准入/维护/淘汰/回滚 | 技能生命周期综述 | P1 | 每个技能有状态与来源 |
| `server/eval/tasks.js` | 5 条 → ≥30 条，覆盖注入与长程 | AgentBench、AgentDojo、Terminal-Bench | P1 | 每周可比 |
| `server/eval/runner.js` | 轨迹级评审（带工具） | Agent-as-a-Judge | P1 | 步骤级反馈 |
| `work/team-templates.js` | SOP 步骤 + 交付物 schema | MetaGPT | P2 | 合规率 ≥90% |
| `work/team-room.js` | 发言模式（轮询/主持/辩论）+ 安全责任人 | AutoGen、2611.17820 | P2 | 协调消息下降 |
| `model-hub.js` | 风险档路由 + 有验收才级联 | RouteLLM、FrugalGPT | P2 | 成本 −20% |
| `work/handoff.js`、`mcp.js` | A2A task 字段对齐 | 协议综述 | P2 | 跨框架委派一次 |
| `work/usage.js` | 执行 token / 协调 token 拆分 | 第 3 节证据 | P1 | 协调占比可见 |

---

## 6. 落地路线

### P0（两周，四项互不依赖，可并行）

1. **`critic.js` 加 `failureMode`**：只加字段与枚举，不改判定逻辑。先有度量。
2. **`critic.js` × `verify.js` 联动**：评审读验收证据，区分三层可信度。
3. **上下文三层预算**：先改 `buildLibraryContext`，不引入 playbook 也能立刻见效。
4. **`rankTools()` + 工具 top-k**。

四项都要求：单测 + 一条可跑的对照数据。

### P1（一个迭代）

5. playbook / reflection（ACE + Reflexion + ExpeL）
6. 规则表权限（AgentSpec，先 10 条）
7. 幂等键 + 补偿动作（SagaLLM）
8. 注入用例 + 数据/控制分离（CaMeL）
9. 技能安装期审查
10. `eval/` 扩到 30 条
11. 用量拆分（执行 vs 协调）

### P2（架构级）

12. SOP 模板 + 交付物 schema
13. 发言模式 + 安全责任人
14. A2A 只读发现 → 委派
15. 成本路由
16. 默认单 Agent 的拆分判据与提示

### 不建议现在做

| 事项 | 原因 |
|---|---|
| 自动拓扑搜索（AFlow 式） | 评测样本只有 5 条，会过拟合 |
| Voyager 式自动沉淀可执行技能 | 代码审计成本高于收益，等规则表稳定后再开 |
| 完整 14 类 MAST | 先 6 类，标注稳定后再扩 |
| 用 LLM 自动生成安全规则 | 精确率/召回率为二手数据，先手写 |
| 自研 Agent 互联协议 | 直接对齐 A2A |
| 用多 Agent 作为默认执行形态 | 第 3 节证据不支持 |

---

## 7. 证据强度

做决策时按这张表取信。**没核实的数字不写进验收标准。**

| 数据点 | 数值 | 来源 | 状态 |
|---|---|---|---|
| ACE agents / finance 提升 | +10.6% / +8.6% | arXiv 摘要与多方报道一致 | 已核（摘要级） |
| ACE 适应延迟降低 | 86.9% | 二手一致 | 待核 |
| ACE 上下文坍缩案例 | 18,282 tok/66.7 → 122 tok/57.1 | 检索摘要 | 待核 |
| MAST 规模 | 14 模式 / 3 类 / κ=0.88 / 150 条 | NeurIPS 摘要 | 已核 |
| MAST-Data | 1,600+ 轨迹 / 7 框架 | NeurIPS 摘要 | 已核 |
| MAST 干预提升 | +9.4% / +15.6% | 第三方读后记 | 待核 |
| MAST 高频模式占比 | 步骤重复 15.7% 等 | 第三方读后记 | 待核 |
| AgentSpec 拦截率 | >90% | 摘要 | 已核（摘要级） |
| AgentSpec 开销 | 解析 1.42ms / 求值 1.11–2.83ms | 摘要 | 待核 |
| AgentSpec 规则生成 | P 95.56% / R 70.96% | 摘要 | 待核 |
| Smurfs token 降幅 | 60.9% | arXiv 摘要 | 已核 |
| AgentRewardBench | 1,302 轨迹；LLM 评审精确率很少超 ~70% | 论文页 | 已核（摘要级） |
| CaMeL AgentDojo | 77% vs 未防御 84% | 二手（v2 数字，v1 为 67%） | 待核 |
| A-MEM 效果 | F1 25.5→45.9 / token −85~93% | 第三方读后记 | 待核 |
| 单 Agent vs 多 Agent | 43.3% 单 Agent 胜；−28 分；5.5× token | 4 篇 2026 预印本 | 方向可信，数值待核 |
| AFlow 提升 | 平均 +5.7%；小模型低成本逼近大模型 | ICLR 页 / 二手 | 已核（摘要级） |
| AWM 提升 | Mind2Web +24.6%，WebArena +51.1% | arXiv HTML | 已核（摘要级） |
| FrugalGPT 节省 | 最高 98.3% | 论文摘要 | 已核（条件性强） |
| RouteLLM 降本 | >2× | 论文摘要 | 已核（摘要级） |
| 社区技能漏洞率 | 26.1% | 2026 技能综述 | 待核 |

**待核处理方式**：进实现前抓原文对应段落，或用本地 20–30 条任务小规模复现；未复现的数字只作方向参考。

---

## 8. 国内工作

| 工作 | 单位 | 对 Lagent 的价值 |
|---|---|---|
| ToolLLM / ToolBench | 清华、OpenBMB | 工具检索 + DFSDT，对应 P0-4 |
| AgentBench | 清华 THUDM | 8 类环境多维评测，对应 `eval/` |
| CRITIC | 清华、MSRA | 自纠错必须取证，对应 critic × verify 联动 |
| ExpeL | 清华 | 经验池 + 成功/失败对比提炼，对应 reflection |
| AgentScope | 阿里通义 | 消息总线 + 容错 + 监控，对应 `outbox` / 可观测 |
| ModelScope-Agent | 阿里达摩院 | 工具注册/检索 + 记忆控制 + 可定制编排 |
| AgentTuning | 清华、智谱 | 指令微调提升泛化（Lagent 不重训，作对照） |
| AgentVerse | 面壁智能 | 多 Agent 动态组队（招募-协作-评估） |
| AFlow | DeepWisdom / MetaGPT 社区 | 工作流当代码图做搜索 |
| CiteAgent（基于 AgentScope） | 通义 + 人大 | 大规模 Agent 群体可复现实验 |

共同点：**把编排、通信、评测当基础设施做**，而不是堆 prompt。这与 Lagent 正在推进的 `application/` + `adapter/` 分层方向一致。

---

## 9. 参考文献

按主题分组，编号与前文对应。

**编排与工作流**
1. Zhang J. et al. *AFlow: Automating Agentic Workflow Generation.* ICLR 2025.
2. Chang E., Geng L. *SagaLLM: Context Management, Validation, and Transaction Guarantees for Multi-Agent LLM Planning.* VLDB 2025. arXiv:2503.11951
3. Wang Z. et al. *Agent Workflow Memory.* arXiv:2409.07429
4. Zhao A. et al. *ExpeL: LLM Agents Are Experiential Learners.* AAAI 2024. arXiv:2308.10144
5. *The Horizon Gap: Planning, Memory, Execution, Training, and Evaluation for Long-Horizon LLM Agents.* arXiv:2608.06663
6. *Beyond the Leaderboard: A Synthesis of Tool-Use, Planning, and Reasoning Failures in LLM Agents.* arXiv:2607.05775
7. Hong S. et al. *MetaGPT.* ICLR 2024. arXiv:2308.00352
8. Wu Q. et al. *AutoGen.* arXiv:2308.08155
9. *AgentScope.* arXiv:2402.14034
10. Derouiche et al. *Agentic AI Frameworks: Architectures, Protocols, and Design Challenges.* arXiv:2508.10146

**上下文与记忆**
11. Zhang Q. et al. *Agentic Context Engineering.* arXiv:2510.04618
12. Packer C. et al. *MemGPT.* arXiv:2310.08560
13. Mei L. et al. *A Survey of Context Engineering for LLMs.* arXiv:2507.13334
14. Xu X. et al. *Everything is Context: Agentic File System Abstraction.* arXiv:2512.05470
15. Xu W. et al. *A-MEM: Agentic Memory for LLM Agents.* arXiv:2502.12110
16. Chhikara et al. *Mem0.* arXiv:2504.19413
17. Kang et al. *MemoryOS.* 2025（预印本）
18. Gutiérrez et al. *HippoRAG.* NeurIPS 2024. arXiv:2405.14831
19. Liu N. F. et al. *Lost in the Middle.* arXiv:2307.03172
20. Jiang H. et al. *LLMLingua* / *LongLLMLingua.* 2023–2024

**工具与执行器**
21. Qin Y. et al. *ToolLLM.* ICLR 2024. arXiv:2307.16789
22. Chen Y. et al. *Re-Invoke.* arXiv:2310.17012
23. *Smurfs: Multi-Agent System using Context-Efficient DFSDT.* arXiv:2405.05955
24. Yang J. et al. *SWE-agent: Agent-Computer Interfaces.* NeurIPS 2024. arXiv:2405.15793
25. Xia C. S. et al. *Agentless.* arXiv:2407.01489
26. Wang X. et al. *CodeAct / OpenHands.* arXiv:2407.16741
27. Kim S. et al. *An LLM Compiler for Parallel Function Calling.* arXiv:2312.04511
28. *Terminal-Bench.* 2025（基准文档，arXiv 编号未核）
29. Ehtesham A. et al. *A Survey of Agent Interoperability Protocols: MCP, ACP, A2A, ANP.* arXiv:2505.02279

**验证与评测**
30. Cemri M. et al. *Why Do Multi-Agent LLM Systems Fail?* NeurIPS 2025. arXiv:2503.13657
31. Gou Z. et al. *CRITIC.* ICLR 2024. arXiv:2305.11738
32. Dhuliawala S. et al. *Chain-of-Verification.* arXiv:2309.11495
33. Madaan A. et al. *Self-Refine.* NeurIPS 2023. arXiv:2303.17651
34. Shinn N. et al. *Reflexion.* NeurIPS 2023. arXiv:2303.11366
35. Lù X. H. et al. *AgentRewardBench.* arXiv:2504.08942
36. Zhuge M. et al. *Agent-as-a-Judge.* ICML 2025. arXiv:2410.10934
37. *Frozen Judges, Moving Agents.* arXiv:2609.34198
38. Liu X. et al. *AgentBench.* ICLR 2024. arXiv:2308.03688
39. Yao S. et al. *τ-bench.* arXiv:2406.12045

**安全**
40. Wang H. et al. *AgentSpec.* ICSE 2026. arXiv:2503.18666
41. Debenedetti E. et al. *Defeating Prompt Injections by Design (CaMeL).* arXiv:2503.18813
42. Debenedetti E. et al. *AgentDojo.* NeurIPS 2024. arXiv:2406.13352
43. Zhan Q. et al. *InjecAgent.* ACL Findings 2024. arXiv:2403.02691
44. *Ignored, Not Refused.* arXiv:2610.23254
45. Xu R., Yan Y. *Agent Skills for LLMs: Architecture, Acquisition, Security.* arXiv:2602.12430
46. *单 Agent 对齐、组队后失守.* arXiv:2611.17820

**成本**
47. Chen L., Zaharia M., Zou J. *FrugalGPT.* arXiv:2305.05176
48. Ong I. et al. *RouteLLM.* arXiv:2406.18665

**多智能体**
49. Du Y. et al. *Improving Factuality and Reasoning through Multiagent Debate.* arXiv:2305.14325
50. Tran, Kiela. *等预算下单 Agent 与多 Agent 对比.* arXiv:2604.02460
51. *When Does Multi-Agent Collaboration Help? An Entropy Perspective.* arXiv:2602.04234
52. *Worse Together: How Performance Breaks Down in Multi-User Multi-Agent Teams.* arXiv:2610.00583
53. *Rethinking Multi-Agent Collaboration: When More Is Less.* arXiv:2609.19759
54. *Does Multi-Agent Collaboration Pay When Agents Serve Users?* arXiv:2610.27655
55. *Multi-Agent Collaboration Mechanisms: A Survey of LLMs.* arXiv:2501.06322

**技能**
56. Wang G. et al. *Voyager.* arXiv:2305.16291
57. *Dynamic Agent Skills: A Lifecycle Survey and Taxonomy.* arXiv:2607.10113
58. Jiang Y. et al. *SoK: Agentic Skills.* arXiv:2602.20867
59. *A Systematic Survey of Agentic Skills.* arXiv:2608.29596

**背景（不进改造清单）**
60. Yao S. et al. *ReAct.* arXiv:2210.03629
61. Li C. et al. *ModelScope-Agent.* arXiv:2309.00986
62. Chen W. et al. *AgentVerse.* arXiv:2308.10848
63. *ChatDev.* arXiv:2307.07924

> 说明：26xx 编号为 2026 年论文，距今三日内至数月不等；其中部分为预印本，正式发表状态未经核实。编号以 `arXiv:标题` 形式给出，检索时以标题为准更稳妥。

---

## 10. 一句话结论

Lagent 的下一阶段不是"接更多 Agent"，而是把这四个控制面做扎实：**失败可分类（MAST + CRITIC）、上下文可分层（MemGPT + ACE）、工具可选择（ToolLLM）、交付可验证（verify × critic）**。多智能体作为**按需选项**而非默认形态——2026 年的证据已经说明，在等预算下，多角色常常只是更贵的重复计算。
