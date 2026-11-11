# Work 执行器策略、预算与审计（Batch E4）

日期：2026-11-06。范围：`server/work/policy.js`、Work engine/routes、测试与文档；未修改 UI，未开放外部执行器默认权限。

## 策略默认值

- `mode:'personal'`、`acceptMode:'explicit'`、`requireApproval:true`。
- `allowedExecutors:['analysis','terminal']`。
- `codex`、`claude-code`、`browser`、`github` 默认拒绝；必须同时在 policy 中加入并设置 `LAGENT_ALLOW_EXTERNAL_EXECUTORS=1`。
- `budgets`: 并发最多 2、每 ticket 最多 12 次执行、最长运行 1 小时、Token 上限 200000（当前用于策略记录，执行器自身仍有独立上限）。
- `limits.browserHosts` / `limits.githubRepos` 默认空数组；执行器内部仍有自己的 URL/仓库校验。

## API

- `GET /api/work/policy` 返回脱敏 policy。
- `PUT /api/work/policy` 只接受白名单字段；非法执行器、重复项、越界预算返回 400。
- `POST /api/work/command` 与 `approve/retry` 会检查策略；拒绝时返回 403，并写 `work-audit`。
- `GET /api/work/bootstrap` 的 `policy` 使用当前策略，`agents` 仍显示执行器自身可用性。

## 审计与预算

- `work-audit` 记录 `{id,ticketId,action,executor,at,result,reason}`；不记录 prompt、URL、命令参数、token、输出或密钥。
- 每个 workspace 保留最近 2000 条审计。
- 启动前检查：每 ticket 执行次数、并发执行数、已有 assignment 运行时长；超限返回 429 并审计。

## 测试

```text
node --test server/work-policy.test.js server/work.test.js server/cli-work.test.js server/external-tools.test.js
# 27/27 通过
```

覆盖默认拒绝、策略 + 环境开关、白名单字段校验、脱敏审计、旧 analysis/terminal、E2 CLI 与 E3 browser/github 回归。

## 限制

- Token 预算字段已进入 policy，但当前执行器没有统一 Token 计量；analysis 的模型用量仍由 model-call 账本统计，CLI/browser/github 不产生模型 Token。
- 浏览器/GitHub 的真实外调未执行；DNS rebinding/TOCTOU 风险仍存在，生产需要出网隔离。
- UI 还没有策略编辑器和执行器选择器；本轮只提供 API。
- 保留全部未提交改动；不提交、打包或部署。
