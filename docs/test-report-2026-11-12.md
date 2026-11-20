# Lagent 全面功能测试报告

> **历史快照**：本报告记录 2026-11-12 当天的测试结果，其中测试数量与 e2e spec 数已随功能演进变化；当前基线以 `npm test` 与 `npm run test:e2e` 的实际输出为准。  
> 日期：2026-11-12
> 提交：`57e5865`（测试基线 `3d6ba11`）
> 环境：Windows 11 / Node 24 / Electron 45 / Edge (msedge)

## 1. 测试范围

| 层级 | 内容 | 结果 |
| --- | --- | --- |
| 服务端单元/集成 | 95 个 `server/*.test.js`（含 work、MCP、mobile、cloud、analysis、model hub 等） | 693 pass / 0 fail |
| 前端单元 | 33 个 `src/*.test.mjs` | 159 pass / 0 fail |
| 桌面进程 | 8 个 `desktop/*.test.cjs` | 57 pass / 0 fail |
| 类型与构建 | `tsc --noEmit`、`vite build` | 通过 |
| 确定性 eval | `scripts/eval.mjs` 5 个任务 | 5/5 pass |
| 真实 API 冒烟 | 12 个场景（工单/计划/项目/模板/用量/权限） | 12/12 pass |
| 桌面安装版 | `Lagent.exe --smoke-test` + Playwright Electron | 通过 |
| Playwright e2e | 全部 28 个 spec | 运行中（见下） |

## 2. 真实 API 冒烟明细

1. `/api/work/bootstrap`：18 个 Agent、1 个数据集。
2. 终端工单：创建 → completed，报告 1 份。
3. 工单 trace：11 个 span（assignment/report/usage/event）。
4. roster：terminal 成功率 1，usage 调用 1 次。
5. 对话设置：对工具执行器传 permission → 400（符合预期）。
6. 两步计划：创建成功，`runs?include=plans` 投影为 `kind=plan`，2 步。
7. 计划取消：status=cancelled。
8. 项目导入：brief 读写、`brief.md` 含「未解问题 / 下一步 / 接手先跑」。
9. 项目变更与记忆：变更 1 条，memory 形状正确。
10. 团队模板：创建、列出、删除。
11. effects 端点：返回数组。
12. 项目清理：删除成功。

## 3. 桌面安装版

- 安装目录：`%LOCALAPPDATA%\Programs\Lagent`
- 快捷方式：桌面 / 开始菜单 → `Lagent Launcher.vbs`（自动启动本机服务）
- smoke 结果：`ok:true, mode:local, appReady:true, bootstrapStatus:200, nodeIsolated:true, packaged:true`
- Playwright Electron 实测：内置 Agent 与 Claude Code 的模型/思考/权限三项胶囊均可见。
- 截图：`lagent-final-desktop.png`（临时目录）

## 4. 已知说明

- 服务端全量测试建议串行执行（`--test-concurrency=1`）。并行跑时 `model-executor` 的子进程测试会因资源竞争偶发超时。
- 外部 CLI 的模型/思考强度支持取决于 CLI 本身：Claude Code（`--model/--effort`）与 Codex（`-m/model_reasoning_effort`）已接入；其它 CLI 会收到参数但可能忽略。
- NSIS 安装包在本机 `/S` 静默安装未落盘，当前安装版是用同版本 `win-unpacked` 部署 + 快捷方式脚本；安装包本身已生成。

## 5. 待补：Playwright e2e 全量结果

（运行中，完成后更新）

## 6. 额外验证

- 服务重启持久化：创建终端工单 → 杀掉服务 → 用同一数据目录重启 → 工单仍为 `completed`，标题保留。
- 桌面安装版页面巡检（Playwright Electron）：指挥台、团队（19 张档案卡）、运行、工具、项目均加载，控制台 0 error。

## 7. 测试中发现并修复的问题

### 7.1 真实缺陷：线程内联「交给另一个 Agent」按钮无效
- 现象：工单线程底部有「交给另一个 Agent 接力」表单，但点击「交接」没有反应。
- 原因：`handoff()` 只使用详情弹窗的 `detail` 状态；在线程内联表单里 `detail` 为空，函数直接 return。
- 修复：来源改为 `detail?.ticket || activeTicket`，报告/验收证据在详情缺失时回退到 `activeDetail`。
- 验证：`e2e/handoff.spec.ts` 桌面端用例通过。

### 7.2 测试选择器过期（非产品缺陷）
- `critic.spec.ts`：旧版直接找「完整报告」tab；新版首页先有「完整报告」按钮。改为先点按钮再进 tab。
- `memory.spec.ts`：面板类名从 `.memory-panel` 改为 `.sa-memory`。
- 两处修复后对应用例全部通过。

## 5. Playwright e2e 全量结果（最终）

- 总计：**54 tests / 30 passed / 24 failed**（16.9 分钟，workers=1）。
- 通过的重点套件：conversation-settings（2）、superagent-shell（2）、critic（5）、memory（3）、handoff（2）、project-brief、project-chat、tools、legacy-shell、visual 指挥台/项目/团队、centered-home、chart-viewer、concise-appearance 等。
- 失败分类：
  1. **过期测试（主要原因）**：分析工作台改版后，旧选择器/入口不再存在。
     - `agent-trace`、`model-picker`、`model-usage`、`multi-model`、`report-toc`、`sticky-header`、`subagents`、`usage-small-fixes`、`workflow-panel`、`workflow`、`plans`。
     - 典型：模型设置已改为「规划设置 / 凭据库 / 模型配置 / Skill 与插件」四页，旧测试直接找「API 地址」；报告页需要先点「完整报告」按钮；计划列表已并入运行页。
  2. **全量运行时的测试隔离问题**：`window-plan`、`windows`、`visual 设置/工具/运行` 在单独运行时全部通过，全量串行时受前序测试留下的服务端状态影响（模型/凭据/窗口/用户数据）。
  3. **真实缺陷（已修复）**：线程内联「交给另一个 Agent」按钮空转（见第 7 节），修复后 handoff 两个用例通过。
- 结论：本轮新增/修改的 Agent 指挥台功能 e2e 全绿；失败集中在旧分析工作台的过期 UI 测试与测试隔离，不是服务端功能回归（server 693 tests 全绿）。

## 8. 建议后续

1. 更新旧分析工作台 e2e：模型设置四页流程、报告入口、计划/运行页入口、子智能体/评审面板新选择器。
2. e2e 服务端按 spec 隔离数据目录，或在 `beforeEach` 重置模型/凭据/用户全局状态，消除全量串行污染。
3. 将服务端测试串行化写入 `npm test` 或 CI，避免 `model-executor` 并行超时。
