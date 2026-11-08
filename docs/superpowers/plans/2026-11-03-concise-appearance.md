# 简洁页面与白天夜间主题实施计划

> For agentic workers: subagent-driven-development；用户已回复“开始”，按批准设计连续实施。

**Goal:** 保留正常版，简洁版改为任务优先页面，仅白天/夜间/跟随系统。
**Architecture:** 复用现有App状态和向导、Workspace、RunPanel；仅concise渲染新首页并按需展开详情。所有新增布局样式以concise或专属类限定，不引入palette。
**Tech Stack:** React/TypeScript/CSS tokens/Node test/Playwright。

## 任务1 简洁页面（独立）
Files: src/components/ConciseWorkspace.tsx、src/concise-workspace.css、src/concise-workspace.ts/test。
- [x] 先RED测试近期任务选择、状态提示与目标预填纯函数。
- [x] 组件中心输入+上传入口（打开现有向导/数据页面，不直接提交付费任务）、最近分析、当前任务状态。props:{task?,dataset?,tasks,onNew(goal?),onShowData(dataset),onSelectTask(task),onOpenData,onOpenDetails,onFullReport}。
- [x] 已有结果可进入完整报告；失败、确认、额度计费说明、示例标记和未审查提示不得隐藏。
- [x] 无自己的网络请求/任务状态；键盘/窄屏/明暗token兼容。root负责App接入与详细Workspace展开。

## 任务2 明暗层次（独立）
Files: src/concise-theme.css、AppearanceSettings.tsx及相关新测试。不修改appearance.ts/context、原appearance.css/overrides及App。
- [x] 浅/深主题用现有token，新增层次仅[data-view=concise]；正常版保持基线。
- [x] 完善简洁模式侧栏/浮层/按钮/输入/焦点、语义状态和图表可读性，仅light/dark。无额外配色。
- [x] 显示设置用白天/夜间/跟随系统、说明简洁版信息层次而非只收紧间距；保留功能与键盘逻辑。
- [x] reduced-motion关闭过渡、打印白底、不缩小触控目标；root浏览器截图对照。

## 任务3 集成（root）
Files: App.tsx、相关E2E/文档。
- [x] 简洁首页独立渲染，沿用任务与数据状态；详细报告由显式入口打开，同一Workspace/RunPanel处理。
- [x] 视图切换不重置任务或主题，正常模式结构不改；新CSS只导入不影响正常版。
- [x] 浏览器保存正常版旧基线；验证两种模式/明暗/system/375px/键盘/不创建任务与费用/报告和向导仍可达。
- [x] 构建、定向及必要回归，独立审查，记录真实通过与限制。保留全部既有未提交改动，不部署或打包。

## 验证记录（2026-11-03）

- `npm run build` 通过；保留 Vite 既有大文件体积提示，未做无关拆包。
- 外观、简洁状态、主题隔离与对比度定向测试 14/14 通过。
- 浏览器全套 5/5 通过：简洁外观、多凭据/私人 Skill/阶段强度/工具 PDF、三表协作与分享、401退款、超限上传。此后修正免费示例文案与手机顶栏，只重跑对应外观 E2E。
- 外观 E2E 覆盖向导目标预填、报告与执行抽屉、明暗持久化、系统主题动态跟随、375px无水平溢出/导航收放/顶栏不重叠、切回正常版、任务数与钱包不变。
- 正常版修改前后 1280×5634 截图像素完全一致；白天、夜间、375px截图已目检。
- 独立审查发现免费预置示例显示20额度的歧义，新增断言先红后绿；仅预置历史显示“不扣费”，用户基于示例数据新建任务仍展示额度。
- 手机布局修正收起导航的键盘可达性，以及顶栏换行和工具栏重叠；均限定简洁模式。
- 本轮未重跑完整后端测试集，未更新安装包、提交Git或部署。服务端PDF实现未改动，原PDF浏览器闭环已回归。

