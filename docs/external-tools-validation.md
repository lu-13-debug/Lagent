# Batch E3 受控浏览器与 GitHub 只读执行器验证

日期：2026-11-06。范围仅服务端 Work 执行器、审批/工件/SSE 集成、定向测试与本文档；未修改 UI，未新增依赖，未开放 GitHub 写操作、任意浏览器自动化或任意网络访问。

## 实现

- 新增 `server/work/executors/browser.js`，注册 id 为 `browser`、kind 为 `tool`，只接受 `executorInput:{url,maxChars?}`；`maxChars` 默认 8000，范围 1-50000。
- 浏览器仅允许 HTTP/HTTPS 与 80/443 端口；拒绝 URL 凭据、`localhost`、`.localhost`、`.local`、IPv4/IPv6 回环、私网、链路本地、保留及组播地址。主机名在启动前与每个请求路由阶段均进行 DNS 全地址检查，重定向和子资源也经过同一层校验。
- Playwright 使用临时 Chromium context：禁用页面 JavaScript、阻止 service worker、拒绝下载、不传入 cookie/凭据/storage state；不执行用户脚本，不提供点击、输入、上传或持久 profile 能力。
- 页面结果只投影 `title`、最终 URL、可见文本和最多 30 条 HTTP(S) 链接。默认/输入超时 30 秒，stop、close、超时和 Abort 会关闭 context 与 browser。
- 可用条件为 `LAGENT_BROWSER_ENABLED=1` 且 Playwright 模块可加载；`bootstrap.agents` 输出真实 `available/unavailable` 状态。Chromium 可执行文件可选用 `LAGENT_CHROMIUM_EXECUTABLE_PATH` 指向本机已安装版本。
- 新增 `server/work/executors/github.js`，注册 id 为 `github`、kind 为 `tool`，只接受 `executorInput:{action,owner,repo,number?,path?}`。action 白名单为 `repo|issues|pulls|checks|file`；`checks` 必须提供 PR number，`file` 必须提供仓库根目录下的 POSIX 相对路径。
- GitHub host 固定为 `https://api.github.com`，请求固定 `GET`，拒绝重定向；owner/repo、number 与 file path 均严格校验。JSON 响应上限 1MiB，文件默认上限 256KiB，超时 30 秒。
- GitHub token 仅从进程环境 `GITHUB_TOKEN` 读取；无 token 时 `available:false` 且启动返回 503。token 不写 Store、ticket、report、SSE 或错误信息，请求头不进入工件；错误使用白名单消息并做 token/凭据模式脱敏。
- GitHub 只返回结构化摘要：仓库字段、Issue/PR 的数量与标题/状态/URL、check-runs 的统计与条目、文本文件内容与大小。不返回原始大 JSON、完整请求头或 token。
- `server/app.js` 注册 `analysis + terminal + codex + claude-code + browser + github`。`POST /api/work/command` 支持对应 `executorId`；创建后仍为 `awaiting_review`，人工 approve 后才启动，审批请求不能替换创建时冻结的 `executorInput`。
- Work 完成/失败 report 与既有 SSE 只投影 `artifacts.browser` 或 `artifacts.github` 白名单；`detail().team` 对 tool 执行器为 `null`。控制输入保留在内部 `work-control`，不出现在公开 ticket/detail/report/SSE。

## 定向测试

执行环境为 Windows/PowerShell。沙箱内 Node test runner 启动测试文件时返回 `spawn EPERM`，第一轮定向测试经授权在沙箱外执行；Playwright 与 GitHub 外调均通过注入的 fake 实现，没有访问真实网站或 GitHub。

```text
第 1 轮（最终轮）：node --test server/external-tools.test.js server/work.test.js server/cli-executors.test.js
结果：28/28 通过

覆盖：URL 协议/凭据/端口/私网拒绝、DNS 私网、子资源路由阻断、JS/下载禁用、链接上限、
maxChars 截断、超时与 stop 关闭、GitHub 无 token、action/path/number 校验、file/checks 摘要、
响应大小、HTTP 错误与 token 脱敏、超时、审批前不启动、审批后 report/SSE artifact、旧 Work/terminal/CLI 回归。

node --check：server/work/executors/browser.js、github.js、server/work/engine.js、server/app.js、server/external-tools.test.js 通过。
```

本记录未运行全量测试、build 或 UI e2e，不把这些项目记为通过。

## 安全边界与限制

- 这不是通用浏览器或自动化平台。没有点击、表单输入、脚本注入、cookie 持久化、文件下载、任意协议、任意端口或私有网络访问能力。
- DNS 校验与实际 Chromium 网络连接之间仍存在 DNS rebinding / TOCTOU 窗口。路由层会在每次请求前复查名称解析结果，但不能替代操作系统级出网隔离；生产部署仍应配置网络策略、代理审计与域名/目标允许列表。
- 当前允许访问任意公开 HTTP(S) 主机，内容仍可能包含提示注入、恶意链接或不适宜内容；页面文本只作为执行工件返回，不自动作为模型指令执行。
- Playwright 模块存在不代表 Chromium 二进制一定可用；真实启动失败会生成脱敏 failed artifact，不会回退到其他浏览器或 shell。
- GitHub 只读边界依赖固定 host、GET 与 action 模板，不提供写 API、GraphQL、自定义 endpoint、token 输入或原始响应透传。真实 token 权限仍应遵循最小权限。
- `file` 只能读取仓库根目录下的 UTF-8 文本；二进制、超大文件、非 base64 响应与异常 API 响应均失败。Issue/PR 列表最多投影 20 条，check-runs 最多 30 条。
- 真实浏览器与 GitHub 外调未在定向测试中执行；外部服务可用性、网络策略、GitHub 限流和 Playwright 版本兼容性仍需部署验收。

## 后续

请 Claude 外跑 `node --test server/external-tools.test.js server/work.test.js server/cli-executors.test.js`，再跑全量测试、build 与 UI e2e。保留全部未提交改动；不提交、不打包、不部署。
