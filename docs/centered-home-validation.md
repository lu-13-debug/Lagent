# 简洁版居中任务首页

参考只读：D:/codex/Modex-MH-Agent/resources/app/dist/assets/ConversationPage-Dz8W6WSe.css及main-CBKOVvDb.css；未启动参考应用。

真实规则核对：cv-home-title clamp(28px,3vw,36px)/600/1.25/-.01em；cv-home-sub 15px/1.6/margin-top12；cv-home-box max760/margin-top34/radius22/padding16px14px12px20px；textarea min84/16px/1.7；note margin12/13px；kinds margin24/32px；recent margin60，宽屏3列/gap12/radius16/padding16px18px/blur6px。参考最终覆盖层使用主题派生阴影，不复制其hex。

采用用户明确规格：外宽1200、主列760/880/980（1600/1900断点），标题始终28–36px，圆角始终22；MODex大屏还有42/50px及更大字号/圆角覆盖，本项目不采用这些覆盖值。

范围：ConciseWorkspace.tsx、concise-workspace.css；App仅传只读默认模型名和现有设置/报告列表回调。不修改主题token、任务/模型/费用接口、正常版树、保护文件；未提交、打包或部署。

修改前基线：artifacts/home-before-standard-{白天,夜间}.png，home-before-{1440,1024,390}-{白天,夜间}.png，home-before-tokens.json。完成后对比记录待追加。

## 验收结果（2026-11-04）
生产构建通过（含tsc --noEmit），Vite保留既有chunk体积提示。centered-home两项与concise-appearance一项共3/3通过；补大屏列宽和Tab顺序后centered-home2/2再次通过。1440主列760px、1600为880px、1900为980px均实测。输入框→选择数据→模型→发送→快捷意图键盘顺序通过。
三尺寸明暗新截图artifacts/home-after-{1440,1024,390}-{白天,夜间}.png已生成并目检桌面白天/390夜间。快捷意图不弹窗、不创建任务、不调用模型；点击发送仍开向导；上传→识别核对→费用确认→确定性分析报告通过。
主题变量before/after JSON逐项一致；正常浅色截图像素一致，夜间差异仅顶栏小图标区域(354,28)-(1050,34)，无布局变化。未修改concise-theme.css或主题token。日期沿用YYYY-MM-DD（按用户保留原实现）。
与参考偏差：遵循用户指定的36px标题上限、22px圆角，不采用MODex的大屏进一步字号膨胀；DataAgent保留当前分析及全部错误/确认/示例/审查/额度说明。未重跑后端全量测试，本轮不修改后端。

独立只读审查无阻断问题。当前分析卡的原有操作保留自然DOM焦点顺序，位于快捷意图与最近列表之间，未用正tabIndex重排，避免视觉与阅读顺序分叉。

## 清单复核补正（2026-11-04）
发现并先红复现1900px输入卡宽980px（超760限制），补max-width:760px。列表固定64px、padding8px6px，标题/来源省略显示防长文本撑高，桌面三列标题仍两行。新增home-audit.spec.ts实测9项任务只展示6条、1024/390长标题行64px、工具/意图44px热区、reduced-motion与打印无渐变白底。最终构建(含tsc)通过，home-audit+centered-home2+concise-appearance共4/4通过。
主题变量仍逐项一致；本轮正常白天截图仅110/8701920像素有不超过32级的轻微抗锯齿差异，无布局变化；夜间仅原顶栏图标小区域差异。当前分析操作仍保留在快捷意图与最近列表之间，这是与简写Tab顺序的字面差异；未隐藏原操作或使用正tabIndex。
