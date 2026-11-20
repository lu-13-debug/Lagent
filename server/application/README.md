# application/ — 内层：业务规则与用例

这里放业务概念，不放技术实现。

- 一个业务概念一个包：`project/`、`chat/`、`ticket/`、`plan/`、`execution/`、`policy/`、`memory/`、`skill/`、`team/`。
- 每个包按需包含：
  - `model.js`：实体、值对象、不变式（状态机、预算范围、依赖规则）。
  - `service.js`：编排一次外部请求，只依赖本层与 `repository` 接口。
  - `repository.js`：端口，只声明方法，不写 SQL。
- 允许 import：Node 标准库（`node:path`、`node:crypto` 等）、本层其它概念、`server/platform/` 的纯技术函数。
- 禁止 import：`express`、`node:sqlite`、`node:child_process`、`node:fs`、`node:http`、`fetch`、`server/adapter/`。
- 跨概念复用：放被依赖的一方，或提成第三个概念包；不要建 `shared/`。

检查：`npm run lint:arch`。

放置判据：**看它 import 什么**。出现框架、数据库、子进程、文件系统或网络 → 外层。
