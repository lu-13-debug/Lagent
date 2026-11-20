# Batch E2 只读 CLI 执行器验证

日期：2026-11-06。范围仅服务端 Work 执行器、Work 集成、定向测试与本文档；未修改 UI，未接入浏览器或 GitHub（E3 范围），未开放写仓库、任意 shell、依赖安装或子智能体。

## 实现

- 新增 `server/work/executors/cli.js` 通用受控 CLI 适配器，以及 `codex.js`、`claude-code.js` 两个注册执行器。
- 可执行文件只读取 `LAGENT_CODEX_CLI` / `LAGENT_CLAUDE_CLI` 指向的绝对文件路径；路径缺失、非文件或相对路径时执行器 `available:false`，不会回退到 PATH 搜索。
- Codex 固定参数模板：`exec --json --sandbox read-only -C <workspace> <wrapped-prompt>`。
- Claude Code 固定参数模板：`-p --output-format stream-json --max-turns <n> <wrapped-prompt>`。
- `executorInput` 仅允许 `{prompt,maxTurns?}`；默认 5 回合，范围 1-20，prompt 去首尾空白、拒绝 NUL；Claude Code / Codex 当前上限 64KiB，通用适配器默认 16KiB。参数以 argv 数组传入，不支持附加 shell、任意参数或自定义 binary。
- `server/work/executors/index.js` 的既有注册表负责 id、可用性、capabilities 与关闭；`server/app.js` 注册 `analysis + terminal + codex + claude-code`。
- `POST /api/work/command` 支持 `executorId:'codex'|'claude-code'`，创建后仍为 `awaiting_review`/`stage:'approval'`，人工 approve 后才启动。审批请求不能替换创建时冻结的 `executorInput`。
- 幂等键覆盖执行器、command、datasetId 与规范化后的 `executorInput`；同一 clientRequestId 跨执行器或更换 prompt 返回 409。控制字段保存在 `work-control`，不进入 ticket/detail/SSE 公开投影。
- Work 执行中 stage 为 `cli`；完成/失败 report 的 `artifacts.cli` 携带结构化结果。CLI 工单 `detail().team` 为 `null`，团队验收/提案能力不开放给 CLI。

## 进程与网络边界

- `spawn` 固定 `shell:false`、工作区 cwd、`windowsHide:true`、stdin 忽略、stdout/stderr 管道；本地模式 cwd 为项目根，cloud 模式 cwd 为账号各自 `Store` 的 dataDir。
- 环境变量采用白名单：保留 PATH、Windows 基础变量、临时目录、语言/终端变量、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`；不传 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`LAGENT_CREDENTIAL_MASTER_KEY` 等应用凭据。
- 默认超时 3600 秒（项目步骤可用 `executorInput.timeoutMs` 覆盖，范围 60000-7200000）；stdout+stderr 合计 512KiB，超限截断。stop/Abort 终止子进程并写 cancelled artifact；不自动重试。
- 两个执行器分别限制最多 2 个并发 CLI 子进程。服务重启时，已启动但无活动子进程的 CLI task 标记为 failed，避免恢复出僵死任务。
- Codex 使用其自身 `--sandbox read-only` 策略。Claude Code 当前固定模板没有等价的强隔离参数；写入/联网限制主要依赖提示词和本机 Claude Code 配置。
- 因此这不是 OS 沙箱。服务端模板能阻止调用方追加 `--dangerously-*`、`--full-auto`、写文件、安装依赖等参数，但不能证明外部 CLI 自身或其配置绝不会产生副作用。生产使用仍需依赖外部 CLI 的权限机制、操作系统隔离和审计。
- 未接浏览器、GitHub、任意 shell 或子智能体；CLI 提示词明确要求只读、不修改文件、不安装依赖、不联网、不启动子智能体，但模型指令不是强制安全边界。

## 结构化输出

- Codex 按 JSONL 解析，支持 stdout 分块重组；空行忽略，坏行/非对象 JSON 只计数为 `malformedLines`。
- Claude Code 按 `stream-json` 事件解析 assistant/result/error；只投影最终摘要、允许的 usage 数字、错误和统计。`result` 顶层 `num_turns`、`duration_ms`、`duration_api_ms`、`total_cost_usd` 仅在数值有效时并入 usage。
- 公开报告只包含 `summary`、`usage`、`error`、工作区内 artifact 相对路径、统计、退出码/信号、超时/截断/取消标记和耗时。
- 不保存 reasoning/thinking 内容、完整 JSONL、原始事件或工具输入。摘要/错误会去 ANSI、常见 key/token 模式和 NUL，错误最多 2000 字符；artifact 路径拒绝工作区外路径。
- task 内部仍保存 `cliInput` 以便恢复判断，但该字段不进入 Work API、detail、report 或 SSE 投影；公开上下文不包含 prompt 原文。

## 定向测试

执行环境为 Windows/PowerShell。沙箱内 Node test runner 启动子进程时报 `spawn EPERM`，定向测试经授权在沙箱外执行；所有 CLI 进程均由注入的 fake spawn 代替，没有调用真实 Codex/Claude Code。

```text
第 1 轮：node --test server/cli-executors.test.js
结果：4/5 通过
失败：Claude result 顶层 num_turns/duration_ms 未并入 usage
修正：parser 在数值有效时合并这两个 usage 字段，并增加 duration_api_ms/total_cost_usd 的同规则处理

第 2 轮（最终轮）：node --test server/cli-executors.test.js server/cli-work.test.js server/work.test.js
结果：17/17 通过
覆盖：Work 既有 16 项回归，以及 E2 Work CLI 审批前不执行、冻结输入、幂等冲突、argv/cwd/shell/env、report/SSE 脱敏
说明：该组合命令的最终统计未包含 cli.test.js 的 5 项；修复后 CLI 单元文件仍需 Claude 外跑复验
```

静态检查：`node --check` 覆盖 `cli.js`、`codex.js`、`claude-code.js`、`cli.test.js`、`cli-work.test.js`、`engine.js`、`app.js`，全部通过。`npx tsc --noEmit` 通过。

本记录未运行全量测试、build 或 UI e2e，不把这些项目记为通过。

## 版本与协议风险

- 本机帮助核对显示 Claude Code `2.1.318` 的帮助没有列出 `--max-turns`；E2 固定模板仍按要求传入该参数。若实际版本不支持，进程会以非零退出并在报告中给出脱敏错误，不会删除参数或退回 PATH。
- 本机 Codex `0.166.0-alpha.6` 的 `codex exec --help` 未显示 turn 参数；当前模板通过只读提示词说明回合上限，不伪造额外 CLI 参数。
- 两个 CLI 的 JSON/JSONL 事件字段可能随版本变化；无法解析的事件会计入 malformedLines，缺失结果时任务按退出状态失败，不会把原始事件暴露给 Work API。
- 真实执行还依赖本机 CLI 登录/配置目录和版本兼容性。本文档未声称已真实外调 Codex/Claude Code。

## 后续

请 Claude 外跑 `node --test server/cli-executors.test.js`、`node --test server/cli-work.test.js` 与 `node --test server/work.test.js`，再执行全量测试、build 与 UI e2e。保留全部未提交改动；不提交、不打包、不部署。