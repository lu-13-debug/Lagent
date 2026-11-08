# 移动可用性投影与通知收件箱 v1

## 范围

Batch E7 只扩展服务端移动网关，不修改 UI、不新增依赖，也不实现 APNs/FCM/Web Push 等推送发送。通知只在移动客户端重新连接、读取收件箱或保持 SSE 连接时可见。

## 移动投影

`sanitizeMobileTicket` 增加 owner 可见的 `title` 与 `summary`，分别截断到 100 和 400 个字符。`sanitizeMobileDetail` 的 report 增加 `summary`（最多 400 字符）。以下内容仍被排除：

- 命令原文、`executorInput`、prompt、审批快照和凭据。
- report artifacts、原始记录、stdout/stderr、工具结果正文和数据集记录。
- team proposal 正文、节点产物以及任何未在 allowlist 中声明的字段。

因此移动端可以展示可读标题、状态摘要和报告摘要，但不能读取执行输入、命令或原始数据。

## 通知触发与保留

通知只从 Work `ticket` 事件生成，触发状态严格为：

- `awaiting_review`
- `completed`
- `failed`
- `blocked`
- `cancelled`

`working`、`queued`、`waiting` 以及 assignment/report 事件不会生成通知。通知使用 Work 事件 `id` 去重，唯一键为 `(owner_id, event_id)`；每个 owner 最多保留最新 200 条，超出后裁剪最旧记录。通知写入移动网关自己的 SQLite 表，不写回 Work store，也不会递归发布新的 Work 事件。

持久化字段仅为：`event_id`、`ticket_id`、`status`、`title`、`summary`、`created_at`、`read_at`。通知列表返回 `id`、`ticketId`、`title`、`status`、`summary`、`createdAt`、`unread`，不返回数据库行、owner 内部键或原始事件 payload。

## API

所有接口复用现有设备 Bearer token（兼容 `x-device-token`）、设备 TTL/撤销检查、进程内限流和 owner 隔离。

```text
GET  /api/mobile/bootstrap
GET  /api/mobile/notifications?limit=50
POST /api/mobile/notifications/:id/read
POST /api/mobile/notifications/read-all
```

- bootstrap 保留原有字段，并新增 `notifications: { unread }`。
- 列表默认返回 50 条；`limit` 只接受 1 到 200 的十进制整数，非法值返回 400。响应为 `{ notifications, unread }`，按最新优先排序。
- 单条已读返回 `{ ok, notification, unread }`；不存在或属于其他 owner 的通知统一返回 404。
- 全部已读返回 `{ ok: true, unread: 0 }`。重复标记已读是幂等的。

本地部署 owner 为 `local`，云端按当前登录 `userId` 工作区隔离。跨设备或跨账号不能读取、标记或推断另一 owner 的通知。

## SSE

新增最小事件帧：

```text
event: notification
data: {"id":"...","ticketId":"...","status":"completed","createdAt":"...","unread":true}
```

SSE notification 只包含 `id/ticketId/status/createdAt/unread`，不发送 title、summary 或任何 Work payload 其他字段。原有脱敏 Work SSE 帧继续保留；通知去重时不会重复广播 SSE。通知写入异常按 best-effort 处理，不能阻塞已提交 Work 事件的原 SSE 投递，此时可能丢失对应通知。

## 验证与限制

定向测试：

```powershell
node --test server/mobile-gateway.test.js
node --test server/mobile-gateway.test.js server/app.test.js server/cloud-app.test.js server/work.test.js
```

当前限流和内存连接表均为单进程状态；多实例部署不共享全局请求配额或在线 SSE 客户端，通知 SQLite 依赖共享且一致的数据目录。v1 没有推送发送、通知删除、分布式锁或多实例广播保证。全量测试、构建和 UI e2e 由外部验收流程执行。
