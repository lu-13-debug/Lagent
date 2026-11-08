# Batch E1 执行器注册表与受控终端验证

日期：2026-11-06。范围仅服务端 Work 执行器、命令路由、持久化/SSE 投影、定向测试与本文档；未修改 UI，未接入 Claude Code、Codex、浏览器或 GitHub（这些属于 E2）。

## 实现

- 新增 `server/work/executors/index.js` 注册表：校验执行器 id、名称与能力，提供 `list/resolve/requireAvailable/close`，拒绝重复 id；旧单 analysis 执行器仍可兼容包装。
- `analysis` 执行器补充公开元数据，保留原有分析 workflow、报告与团队能力；terminal 不提供 team 能力，ticket detail 的 `team` 为 `null`。
- `POST /api/work/command` 支持可选 `executorId`，默认 `analysis`；不存在或不可用的执行器返回 400。幂等键覆盖 `executorId + command + datasetId + executorInput`。
- terminal 只接受结构化 `executorInput: { program, args }`，不接收原始 shell 字符串；控制输入仅保存在 `work-control`，不出现在 ticket/API 投影。
- terminal 程序白名单为 `git`、`npm`、`ls`、`pwd`，并按子命令/参数进一步限制；拒绝 shell 元字符、Windows 变量展开和工作区外相对路径。
- terminal 使用 `shell:false`、固定 workspace cwd、环境变量白名单、默认 60 秒超时、stdout+stderr 合计 200KB 上限与有限并发。
- terminal 命令创建后先进入 `awaiting_review`，批准前不启动；批准时使用冻结的 `executorInput`，不会采用审批请求里替换后的输入。
- 执行结果写入 `task.artifacts.terminal`；Work 完成/失败 report 携带 terminal artifacts，并通过既有 work-event/SSE 投影。失败不自动重试，停止/Abort 会终止子进程。
- `server/app.js` 注册 `analysis + terminal`；cloud 账号的 terminal cwd 使用各自 `Store` 的 dataDir，避免跨账号目录混用。
- `routes.js` 已把完整命令体传给 engine，无需额外改动。

## 安全边界

- 这不是 OS 沙箱。白名单、参数校验、cwd 固定、环境过滤和 `shell:false` 只降低误用范围，不能阻止所有副作用。
- `git`、`npm` 仍可能读取当前工作区文件或访问网络；不应把 terminal 视为强隔离的不可信代码执行环境。
- terminal 仍需人工审批，不做自动批准、自动重试或后台自由执行。

## 定向测试

```text
第 1 轮（E1 用例扩展前）：node --test server/work.test.js
结果：11/11 通过

第 2 轮（E1 用例扩展后，最终轮）：node --test server/work.test.js
结果：14/16 通过
失败：两个 terminal 审批测试在 action() 无 assignment 时把执行器错误解析为 analysis
```

定点修复：`action()` 改为按 ticket/assignment 计算出的 `activeId` 调用 `executors.resolve(activeId)`。修复后 `node --check server/work/engine.js` 通过；按两轮定向测试硬上限未启动第 3 轮，因此这两个修复后的运行路径尚待外跑复验。

本记录未运行全量测试、build 或浏览器 e2e，不把这些项目记为通过。

## 后续

请 Claude 外跑 `node --test server/work.test.js` 复验两个 terminal 审批路径，再执行全量测试、build 与 UI e2e。保留全部未提交改动；不提交、不打包、不部署。

## Claude 外验（2026-11-06）

- `action()` 的 `activeId` 修复后，`node --test server/work.test.js` **16/16** 通过，两个 terminal 审批失败路径已复验。
- `server/terminal-executor.test.js` **3/3**：白名单/元字符、成功执行、超时/停止。
- 全量 `node --test --test-concurrency=1` **658/658** 通过。
- `npm run build`（含 tsc）通过；`superagent-shell` + `concise-appearance` e2e **2/2** 通过。
- E1 关闭；E2（Codex / Claude Code CLI 适配器）已派发并由 Codex 认领。
