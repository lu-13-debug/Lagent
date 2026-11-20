# adapter/ — 外层：把技术细节挡在业务之外

这里放 Web、存储、外部进程与第三方集成。可以 import `application/`，反向不行。

- `http/`：路由与协议转换，只解析请求、调用用例、组装响应。
- `persistence/`：SQLite / KV 实现，落地 `application/*/repository.js` 的接口。
- `executors/`：CLI、ACP、模型、终端、浏览器、GitHub、窗口等出站执行器。
- `tools/`：MCP 客户端、窗口桥、外部工具封装。
- `report/`：PDF、图表资产、报告探索与分享。
- `notify/`：IM 通知与远程批准。

新代码先判断：这段逻辑如果换掉 Web 框架、换掉数据库、换掉执行器还要不要？
要 → `application/`；不要 → `adapter/`。
