export const STAGE_DEFINITIONS = Object.freeze([
  ['quality', '数据理解与质量检查', '检查字段、覆盖范围与质量风险', 'skill-quality'],
  ['plan', '任务规划', '理解目标、决定步骤与分工', 'skill-plan'],
  ['preprocess', '数据处理', '生成可核验的派生数据处理记录', 'skill-preprocess'],
  ['activity', '活跃与新增分析', '核查活跃、新增及变化', 'skill-activity'],
  ['retention', '留存分析', '依据完整观察窗口分析留存', 'skill-retention'],
  ['monetization', '商业化分析', '分析收入、付费与币种口径', 'skill-monetization'],
  ['channel', '渠道分析', '分析渠道构成及同口径表现', 'skill-channel'],
  ['seasonality', '周内分析', '核查日期覆盖及周内差异', 'skill-seasonality'],
  ['charts', '图表设计与绘制', '用真实聚合数据绘制标准图表', 'skill-charts'],
  ['insights', '洞察与建议', '根据可追溯证据提出发现与行动', 'skill-insights'],
  ['report', '报告撰写', '整合已核验指标、图表与限制', 'skill-report'],
  ['verify', '结果核验', '复核数值、单位、图文及证据', 'skill-verify'],
  ['pdf', 'PDF排版与输出', '导出已核验报告及本地图表', 'skill-pdf'],
].map(stage => Object.freeze(stage)));

// 产品配置只保留「任务规划」：其余 12 个阶段属于已归档的数据分析报告流水线，
// 保留定义是为了让历史任务快照与归档代码仍能读取，但设置界面与工作流配置不再暴露。
export const ACTIVE_STAGES = Object.freeze(['plan']);
