# 技能与插件中心设计

日期：2026-11-16

## 目标

给 Lagent 增加一个可用的「技能与插件」中心，让用户在不离开软件的情况下：

- 从内置推荐清单或任意 GitHub 仓库安装 Agent Skill。
- 安装、启用、停用、更新、卸载技能，并清楚知道来源、版本和作用范围。
- 浏览官方与自定义 GitHub 插件市场，安装、启停、更新、卸载插件。
- 让内置 Lagent 模型和外部 CLI Agent 都能实际用上已启用的技能。

## 非目标

- 不自己发明技能格式，不替换 Claude Code 的原生目录和插件机制。
- 不执行技能里的脚本，不替用户运行插件 hooks。
- 不承诺 Codex、DSH、OpenCode 等 Agent 原生加载 Claude 格式技能；第一版只通过 Library 清单提示它们。
- 不做远程技能商店、评分、下载量或账号同步。
- 不做技能编辑器；只做安装与生命周期管理。

## 用户体验

新增页面「技能与插件」，挂在「更多」导航下，包含四个标签：

### 已安装

- 列表展示：名称、描述、来源、固定 commit、作用范围（项目/全局）、启用状态、更新状态。
- 操作：启用/停用、查看 `SKILL.md`、检查更新、卸载。
- 目录丢失时显示 `missing`，提供重新安装或移除记录。

### 发现

- 内置推荐清单按四类展示：
  - 代码开发与审查：`webapp-testing`、`frontend-design`、`mcp-builder`
  - 文档与协作：`doc-coauthoring`、`docx`、`pptx`、`pdf`
  - 数据与报表：`xlsx`
  - GitHub 与项目管理：官方插件 `github`、`commit-commands`、`pr-review-toolkit`
- 支持输入任意 GitHub 仓库地址，预览仓库内可安装的技能目录。
- 安装前展示：来源、commit、许可证、文件清单、同名冲突、作用域选择。
- 默认安装到项目 `.claude/skills`；可勾选安装到全局 `~/.claude/skills`。

### 插件市场

- 展示已配置的 marketplace 与其中的插件。
- 插件详情展示组件清单：skills、commands、agents、MCP、hooks。
- 支持添加任意 GitHub marketplace、安装、启用/停用、更新、卸载。
- 插件声明的安装命令必须展示命令与 `sha256`，用户确认后才传 `--accept-command`。

### 来源

- 展示内置清单、官方 marketplace、自定义 GitHub marketplace。
- 支持添加/移除自定义来源，显示最近同步时间。

## 架构

采用「原生文件 + Lagent 注册表」：

- Skill 文件真实写入项目或全局的 `.claude/skills`，Claude Code 原样加载。
- Lagent 在 SQLite 中记录安装来源、commit、文件哈希和启用状态。
- 插件通过本机 Claude Code CLI 安装，不复制插件状态；Lagent 只缓存展示结果。
- 内置 Lagent 模型通过技能索引 + `read_skill` 工具渐进读取技能正文。

### 服务端模块

新增 `server/work/skills/`：

- `catalog.json`：内置推荐清单，只存仓库、路径、分类、固定 ref。
- `sources.js`：解析 GitHub/Git 地址、浅克隆、校验、计算哈希。
- `installer.js`：原子安装、备份、冲突处理、卸载、更新、启动核对。
- `plugins.js`：封装 `claude plugin` CLI，统一使用 `--json`。
- `service.js`：对引擎和路由暴露统一 API。

### 数据模型

SQLite 新增两类实体，不改现有表：

```text
work-skill {
  id, name, description, scope: 'project' | 'global', projectId?,
  source: { type, repo, path, ref, commit },
  targetPath, files: [{ path, sha256, size }],
  enabled, installedAt, updatedAt, missing?
}

work-skill-source {
  id, type: 'catalog' | 'marketplace',
  location, label, trusted, lastSyncedAt
}
```

插件状态不落库，以 `claude plugin list --json` 为准，内存缓存 30 秒。

### 内置模型接入

- `engine.js` 在构造任务时收集「当前项目已启用 + 全局已启用」的技能。
- 系统提示只注入技能名称、描述和触发条件，不注入正文。
- `model.js` 新增工具 `read_skill{name}`：
  - 只解析已启用技能；
  - 读取对应 `SKILL.md`，上限 32KB；
  - 路径必须落在登记过的技能目录内；
  - 返回带行号正文和截断提示。
- 技能正文按轮进入上下文，不跨任务持久化。

### UI

- 新增 `src/components/SkillsPanel.tsx`。
- 新增 `src/api.ts` 方法与 `src/superagent.ts` 类型。
- 样式沿用 `superagent.css` 现有卡片、标签、按钮和表单模式。
- 安装弹窗统一展示来源、commit、许可证、文件、冲突与风险。

## 核心流程

### 技能预览与安装

```text
UI 选择推荐技能或贴 GitHub 地址
  → POST /api/work/skills/preview
  → 浅克隆到临时目录
  → 校验 SKILL.md、路径、符号链接、文件大小
  → 返回 { source, commit, license, files[], digest, conflicts[] }
  → 用户选择范围并确认
  → POST /api/work/skills/install（带 commit 与 digest）
  → 按固定 commit 重新拉取并校验
  → 备份同名目录
  → 原子写入 .claude/skills/<name>
  → 写 work-skill 注册表
  → 同步 Library 清单
```

### 启用与停用

- 停用不改文件，只把注册表 `enabled` 置为 false；Claude Code 仍能看到文件，但 Lagent 不再把技能注入内置模型。
- 需要在 Claude Code 侧真正禁用时，用户可以卸载或手工调整。
- 第一版在 UI 上明确说明这个差异。

### 更新

- `POST /api/work/skills/:id/update` 重新解析来源到最新 commit，生成差异预览。
- 用户确认后按新 commit 安装，保留旧版本备份。
- 失败时保留旧文件与旧注册表，状态标记 `update-failed`。

### 插件

```text
GET  /api/work/plugins             → claude plugin list --json --available
POST /api/work/plugins/preview     → claude plugin details <name> --json
POST /api/work/plugins/marketplaces → claude plugin marketplace add <source> --json
POST /api/work/plugins/install     → claude plugin install <name>@<marketplace> --scope ... --json -y
POST /api/work/plugins/:id/enable  → claude plugin enable <name> --json
POST /api/work/plugins/:id/disable → claude plugin disable <name> --json
POST /api/work/plugins/:id/update  → claude plugin update <name> --json
DELETE /api/work/plugins/:id       → claude plugin uninstall <name> --json
```

## 安全边界

### 信任分层

- 内置清单与官方 marketplace：来源固定，安装前展示信息。
- 任意 GitHub 仓库：必须预览并勾选可信确认。
- 任意 marketplace：添加前确认来源。
- 插件声明安装命令：必须展示命令与 `sha256`，确认后才执行。

### 文件系统

- 只允许写入 `<项目>/.claude/skills/<name>` 或 `~/.claude/skills/<name>`。
- `<name>` 只接受 `[a-zA-Z0-9._-]`，拒绝 `..`、绝对路径、盘符和保留名。
- 拒绝符号链接/junction，写入前 realpath 校验。
- 单技能上限：100 个文件、总计 5MB、单文件 512KB。
- 拒绝 `.git`、`.ssh`、`.env`、密钥类文件。
- 安装使用临时目录 + 备份 + rename，失败恢复原状。

### 执行

- 内置模型只读文本，不执行技能脚本。
- Lagent 不执行插件 hooks。
- 远程来源只允许 HTTPS/SSH Git 地址，拒绝 `file://`、回环地址和私有网段。
- 克隆与插件命令超时 120 秒；同一目标路径加内存锁，防止并发安装。

## 错误处理

- 网络失败、仓库无技能、缺少 `SKILL.md`、许可证缺失：返回可读中文提示。
- 同名冲突：覆盖 / 改名安装 / 取消。
- 权限不足、目标不可写：不落注册表，保留原文件。
- Git 或 Claude Code CLI 缺失：对应功能禁用并给出安装提示，不影响其他功能。
- 启动核对发现目录丢失：标记 `missing`，提供重新安装或移除记录。
- 插件命令失败：展示退出码与脱敏后的 stderr，不把完整环境变量写进日志。

## 测试

### 服务端单元测试

- 来源解析：`owner/repo`、HTTPS、SSH、带子目录、非法地址。
- 路径校验：穿越、绝对路径、盘符、保留名、符号链接。
- 文件上限与哈希校验。
- 安装、覆盖、更新、卸载、备份恢复。
- 启动 reconcile 与 `missing` 状态。
- `read_skill`：成功、未知、已停用、超长、越界。

### 插件封装测试

- 假 spawn：JSON 解析、scope、超时、非零退出码。
- `--accept-command` 仅在确认后传入。

### 路由与 UI

- 路由覆盖 preview/install/enable/disable/update/remove。
- Playwright 流程：预览 → 安装到临时项目 → 已安装列表 → 停用 → 卸载。
- 手工验收：安装官方 `xlsx` 后 Claude Code 可见；内置模型可通过 `read_skill` 读到正文。

## 实施分期

1. **技能中心核心**：来源解析、预览、安装、启停、卸载、注册表、内置模型 `read_skill`、技能页三个标签。
2. **插件市场**：CLI 封装、marketplace 浏览与添加、插件安装与生命周期、插件技能索引。
3. **更新与体验**：差异预览、失败恢复、来源管理、E2E 与手工验收。

## API 约定

```text
GET    /api/work/skills
GET    /api/work/skills/catalog
POST   /api/work/skills/preview
POST   /api/work/skills/install
POST   /api/work/skills/:id/enable
POST   /api/work/skills/:id/disable
POST   /api/work/skills/:id/update
DELETE /api/work/skills/:id
POST   /api/work/skills/:id/reinstall

GET    /api/work/plugins
GET    /api/work/plugins/marketplaces
POST   /api/work/plugins/preview
POST   /api/work/plugins/marketplaces
DELETE /api/work/plugins/marketplaces/:name
POST   /api/work/plugins/install
POST   /api/work/plugins/:id/enable
POST   /api/work/plugins/:id/disable
POST   /api/work/plugins/:id/update
DELETE /api/work/plugins/:id
```

所有写接口都走现有同源检查与会话校验；返回错误沿用 `{ error }` 结构。
