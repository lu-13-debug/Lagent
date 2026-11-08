# 图表查看验证记录（2026-11-03）

改动：OperationCharts.tsx、OperationChartControls.tsx、OperationChartVisual.tsx、operation-charts.css、operation-chart-settings.ts及测试、e2e/chart-viewer.spec.ts。

卡片、设置面板和wide Modal使用同一settings，按任务原key保存v2并迁移v1；正常/简洁复用原入口。SVG唯一渲染器，保留聚合口径、cohort加权及无覆盖断线。三套系列配色独立于界面主题，PNG副本显式写入浅色系列色和深色文字，沿用白底2400×1000。打印强制浅色系列，隐藏设置与弹窗。

验证：先RED设置9项及浏览器缺少新region，再实现；定向12/12通过；完整npm test 495/495通过（日志artifacts/chart-viewer-full-tests.txt）。其后独立审查修正标题覆盖指标单位、付费aria名称、单系列图例，最终构建通过。构建仍有Vite大文件提示。

浏览器已实测：五图指标类型、排序、顺序、隐藏恢复、目标标题备注、配色、放大同步与Esc焦点返回、PNG下载、刷新持久化、正常明暗、390px无页面横向溢出、简洁完整报告、打印隐藏控件。任务数、钱包不变，模拟模型调用0次。截图和PNG保存artifacts/chart-viewer-*.png，PNG及窄屏已目检。

限制：打印通过print媒体截图验证，未使用操作系统打印对话框。完整测试在最后文案/图例审查修正前运行，修正后重跑构建、定向和对应浏览器用例。未修改服务端、未新增依赖、未提交、未打包、未部署；保留既有工作区修改。

## Claude协作反馈修复
付费图副标题原先固定描述柱和线，现按hasPayers/hasRate实际绘制状态生成。新增三显示模式浏览器用例，先红复现仅付费率仍有柱说明，修复后图表浏览器2/2通过；npm run build通过。本次未重跑完整npm test，未修改目录导航或ReportView.tsx。
