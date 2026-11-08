# 移动配对与远程 Work API 验证（E6）

## 范围

v1 只提供服务端 API，不包含手机 UI、网页推送或推送发送。移动端复用现有 Work engine；桌面 UI、凭据管理、模型配置、数据集删除和 Work policy 写接口均未扩展。全量测试、构建和 UI e2e 由 Claude 外跑。

## 配对与设备

- `POST /api/mobile/pair` 只能由已登录的桌面会话调用，返回一次性 6 位码 `{code, expiresAt}`。配对码 5 分钟有效，错误尝试按来源最多 5 次，超限返回 429。
- `POST /api/mobile/pair/claim` 使用 `{code, deviceName}` 换取 `{deviceId, deviceToken, expiresAt}`。码只能成功消费一次；设备名做 NFKC、控制字符清理、长度限制和 HTML 转义。
- 设备 token 为 256 位随机值，只保存 SHA-256 hash，TTL 为 90 天。`GET /api/mobile/devices` 列出当前 owner 设备，`DELETE /api/mobile/devices/:id` 立即撤销并断开该设备 SSE。
- 认证支持 `Authorization: Bearer <deviceToken>` 与 `x-device-token`。token、配对码和认证头不进入日志或审计响应。

## 远程 Work API

设备认证后可访问：

- `GET /api/mobile/bootstrap`
- `GET /api/mobile/policy`（只读）
- `GET /api/mobile/events`（SSE，15 秒心跳）
- `POST /api/mobile/command`
- `GET /api/mobile/tickets/:id`
- `POST /api/mobile/tickets/:id/actions`

不支持 `PUT /api/mobile/policy`，未知移动接口返回 404。普通 `/api/work/*` 不接受设备 token，避免移动凭据越过专用投影边界。

## 隔离与脱敏

- 个人模式 owner 固定为本地工作区；云端由父层认证设备 token，并用 token 记录的 owner 选择账号工作区。A 的设备不能查看或操作 B 的工单。
- SSE 只发布给同 owner 的设备连接；撤销、过期或关闭网关会结束后连接。
- 每设备每分钟最多 60 次请求，限流在内存中按设备执行。
- 移动响应使用字段级 allowlist。bootstrap 不包含设置、凭据或工具 prompt；工单不包含标题、命令、prompt、审批快照或原始数据；report 只暴露标识/类型/状态类字段。
- 事件载荷只保留状态与 report id，不转发命令、prompt、原始 records 或 executorInput。
- 本地移动入口依赖应用既有 localhost 网络守卫；云端父层检查 Host、Origin/CSRF 和全局并发预算。

## 安全边界

v1 不开放凭据读取/写入、模型或 policy 写、数据集删除、任意 shell、推送发送。Work 执行仍受现有 policy、审批、预算和审计控制。token 不能用于普通桌面 Work API。

## 残余风险

- 移动设备 token 放在客户端存储，设备丢失时需在桌面端及时撤销。
- 限流与 SSE 连接状态是单进程内存状态；多实例部署需外部共享限流或粘性会话。
- 配对码尝试限制按请求来源计数，反向代理必须正确配置可信代理地址。
- 移动投影减少敏感暴露，但不替代 TLS、账号密码安全、设备管理和出网隔离。

## 定向验证

```powershell
node --test server/mobile-gateway.test.js
node --test server/mobile-gateway.test.js server/app.test.js server/cloud-app.test.js server/work.test.js
```

Claude 外跑全量测试、build、terminal/outbox 等既有定向套件及 UI e2e；本轮不提交、不打包、不部署。