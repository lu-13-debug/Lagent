export const METRIC_DEPENDENCIES = {
  dau: ['activity'],
  new_users: ['users'],
  d1_retention: ['users', 'activity'],
  d7_retention: ['users', 'activity'],
  revenue: ['payments'],
  arppu: ['payments'],
  pay_rate: ['activity', 'payments'],
  arpdau: ['activity', 'payments'],
};

export const METRIC_LABELS = {
  dau: '日活跃用户',
  new_users: '新增注册用户',
  d1_retention: '次日留存率',
  d7_retention: '7日留存率',
  revenue: '成功支付收入',
  arppu: '付费用户平均收入',
  pay_rate: '活跃付费率',
  arpdau: '日活跃用户平均收入',
};

export const TABLE_LABELS = { users: '注册表', activity: '活跃表', payments: '支付表' };

export function buildCapability(types, profile = null, fields = null) {
  const tables = new Set(types);
  const knownFields = fields || new Set();
  const dependencies = profile?.metricDependencies || METRIC_DEPENDENCIES;
  const labels = profile?.metricLabels || METRIC_LABELS;
  const tableLabels = profile?.tableLabels || TABLE_LABELS;
  const order = profile?.metricOrder?.filter(id => dependencies[id]) || Object.keys(dependencies);
  if (!profile) for (const id of Object.keys(dependencies)) if (!order.includes(id)) order.push(id);
  const missingOf = dep => dep.includes('.') ? !knownFields.has(dep) : !tables.has(dep);
  const metrics = {};
  for (const id of order) {
    const missing = dependencies[id].filter(missingOf);
    metrics[id] = { label: labels[id] || id, status: missing.length ? 'unavailable' : 'computed', missing, unlocks: [] };
  }
  const satisfiedWithoutTable = table => dep => dep.includes('.')
    ? knownFields.has(dep) || !tables.has(dep.split('.')[0])
    : tables.has(dep) || dep === table;
  for (const id of order) {
    if (metrics[id].status === 'computed') continue;
    metrics[id].unlocks = order
      .filter(candidate => metrics[candidate].status === 'unavailable' && dependencies[candidate].every(dep => dep.includes('.') ? knownFields.has(dep) : tables.has(dep)))
      .map(candidate => labels[candidate] || candidate);
  }
  const relevantTables = Object.keys(tableLabels).filter(table => order.some(id => dependencies[id].some(dep => dep === table)));
  const missingTables = relevantTables.filter(table => !tables.has(table)).map(table => ({
    table,
    label: tableLabels[table],
    unlocks: order
      .filter(id => metrics[id].status === 'unavailable' && dependencies[id].every(satisfiedWithoutTable(table)))
      .map(id => labels[id] || id),
  }));
  const missingFields = profile?.fieldLabels && fields
    ? Object.entries(profile.fieldLabels)
      .filter(([field]) => !knownFields.has(field) && tables.has(field.split('.')[0]) && order.some(id => metrics[id].status === 'unavailable' && dependencies[id].includes(field)))
      .map(([field, label]) => ({ field, label }))
    : [];
  return {
    metrics,
    missingTables,
    missingFields,
    computed: order.filter(id => metrics[id].status === 'computed'),
    unavailable: order.filter(id => metrics[id].status === 'unavailable'),
  };
}
