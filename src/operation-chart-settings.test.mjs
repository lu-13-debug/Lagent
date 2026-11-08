import test from 'node:test';
import assert from 'node:assert/strict';
const s = await import('./operation-chart-settings.ts').catch(() => ({}));

test('v2 defaults are complete and independently mutable', () => {
  assert.equal(typeof s.defaultSettings, 'function');
  const a = s.defaultSettings(), b = s.defaultSettings();
  assert.equal(a.version, 2);
  assert.deepEqual(a.order, ['channel', 'weekday', 'retention', 'payment', 'cumulative']);
  assert.equal(a.channelMetric, 'users');
  assert.equal(a.channelType, 'horizontal');
  assert.equal(a.channelSort, 'desc');
  assert.equal(a.weekdayMetric, 'dau');
  assert.equal(a.retentionType, 'line');
  assert.equal(a.cumulativeMetric, 'newUsers');
  for (const id of a.order) assert.deepEqual(a.charts[id], { title:'', note:'', showLabels:true, showLegend:true, legendPosition:'top', palette:'default' });
  a.charts.channel.title = 'changed'; a.order.reverse();
  assert.equal(b.charts.channel.title, '');
  assert.equal(b.order[0], 'channel');
});

test('v1 settings migrate without losing selections and split granularity', () => {
  const result = s.normalizeSettings({ hidden:['channel'], channelTopN:20, weekdayType:'line', retentionMetrics:['d7'], granularity:'week', paymentShow:'rate', cumulativeType:'line' });
  assert.equal(result.version, 2);
  assert.deepEqual(result.hidden,['channel']);
  assert.equal(result.channelTopN,20);
  assert.equal(result.weekdayType,'line');
  assert.deepEqual(result.retentionMetrics,['d7']);
  assert.equal(result.paymentGranularity,'week');
  assert.equal(result.cumulativeGranularity,'week');
  assert.equal(result.paymentShow,'rate');
  assert.equal(result.cumulativeType,'line');
});

test('normalization rejects malformed values, repairs order and validates presentations', () => {
  for (const input of [null, [], true, 1, 'bad']) assert.deepEqual(s.normalizeSettings(input),s.defaultSettings());
  const result = s.normalizeSettings({ order:['payment','payment','bad','channel'], hidden:['weekday','weekday','bad'], channelTopN:'5', channelMetric:'bad', channelType:'pie', channelSort:'bad', weekdayMetric:'bad', retentionType:'bad', paymentShow:'bad', cumulativeMetric:'bad', retentionMetrics:[], charts:{channel:{title:'  标题  ', note:' note ', showLabels:'false',showLegend:false,legendPosition:'side',palette:'warm'},weekday:[]} });
  assert.deepEqual(result.order,['payment','channel','weekday','retention','cumulative']);
  assert.deepEqual(result.hidden,['weekday']);
  assert.equal(result.channelTopN,10);
  assert.equal(result.channelMetric,'users'); assert.equal(result.channelType,'horizontal');
  assert.equal(result.channelSort,'desc'); assert.equal(result.weekdayMetric,'dau');
  assert.equal(result.retentionType,'line'); assert.equal(result.paymentShow,'both');
  assert.equal(result.cumulativeMetric,'newUsers');
  assert.deepEqual(result.retentionMetrics,['d1','d7']);
  assert.deepEqual(result.charts.channel,{title:'标题',note:'note',showLabels:true,showLegend:false,legendPosition:'top',palette:'warm'});
  assert.deepEqual(result.charts.weekday,s.defaultSettings().charts.weekday);
  assert.deepEqual(s.normalizeSettings({retentionMetrics:['d7','d7','bad']}).retentionMetrics,['d7']);
  const split = s.normalizeSettings({version:2,granularity:'month',paymentGranularity:'day',cumulativeGranularity:'week'});
  assert.equal(split.paymentGranularity,'day'); assert.equal(split.cumulativeGranularity,'week');
});

test('storage corruption and access failures recover without throwing', () => {
  assert.deepEqual(s.normalizeSettings({hidden:[...s.CHART_IDS]}).hidden,[...s.CHART_IDS]);
  for (const value of [null,'{bad','null','[]','42']) assert.deepEqual(s.readSettings({getItem:()=>value},'old-key'),s.defaultSettings());
  assert.deepEqual(s.readSettings({getItem(){throw Error('denied');}},'key'),s.defaultSettings());
  let stored;
  s.writeSettings({setItem(key,value){stored={key,value};}},'old-key',s.defaultSettings());
  assert.equal(stored.key,'old-key'); assert.equal(JSON.parse(stored.value).version,2);
  assert.deepEqual(s.readSettings({getItem:()=>stored.value},'old-key'),s.defaultSettings());
  assert.doesNotThrow(()=>s.writeSettings({setItem(){throw Error('quota');}},'key',s.defaultSettings()));
});

test('titles and notes trim, truncate Unicode code points, and preserve plain text', () => {
  assert.equal(s.cleanTitle('  ', '回退'),'回退'); assert.equal(s.cleanTitle(null,'回退'),'回退');
  assert.equal(s.cleanTitle('😀'.repeat(35),'回退'),'😀'.repeat(30));
  assert.equal(s.cleanNote(' 😀'.trim().repeat(45)),'😀'.repeat(40));
  assert.equal(s.cleanNote(42),''); assert.equal(s.cleanNote(' <b>x</b> '),'<b>x</b>');
});

test('moving charts swaps neighbors with bounded copy behavior', () => {
  const order = [...s.CHART_IDS];
  assert.deepEqual(s.moveChart(order,'channel',-1),order);
  assert.deepEqual(s.moveChart(order,'cumulative',1),order);
  assert.deepEqual(s.moveChart(order,'weekday',-1),['weekday','channel','retention','payment','cumulative']);
  assert.deepEqual(s.moveChart(order,'payment',1),['channel','weekday','retention','cumulative','payment']);
  assert.deepEqual(order,s.CHART_IDS);
});

test('channel sorting copies rows and always keeps null last for each metric', () => {
  const rows=[{channel:'乙',users:2,d1:null,revenue:5},{channel:'甲',users:null,d1:30,revenue:2},{channel:'丙',users:8,d1:20,revenue:null}];
  for (const metric of ['users','d1','revenue']) for (const sort of ['asc','desc']) {
    const result=s.sortChannels(rows,metric,sort);
    assert.notEqual(result,rows); assert.equal(result.at(-1)[metric],null);
    assert.equal(sort==='asc' ? result[0][metric]<=result[1][metric] : result[0][metric]>=result[1][metric],true);
  }
  assert.deepEqual(s.sortChannels(rows,'users','name').map(r=>r.channel),rows.map(r=>r.channel).sort((a,b)=>a.localeCompare(b,'zh-CN')));
  assert.equal(rows[0].channel,'乙');
});

test('retention toggles retain at least one metric and do not mutate', () => {
  const metrics=['d1','d7'];
  assert.deepEqual(s.toggleRetention(metrics,'d1'),['d7']);
  assert.deepEqual(s.toggleRetention(['d7'],'d7'),['d7']);
  assert.deepEqual(s.toggleRetention(['d7'],'d1'),['d7','d1']);
  assert.deepEqual(metrics,['d1','d7']);
});

function luminance(hex){ const rgb=hex.replace('#','').match(/../g).map(c=>parseInt(c,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4); return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722; }
test('all palette series contrast at least 3:1 against their theme backgrounds', () => {
  for(const palette of ['default','warm','cool']) for(const theme of ['light','dark']) {
    const colors=s.resolveSeriesColors(palette,theme);
    assert.deepEqual(Object.keys(colors),['primary','secondary','tertiary']);
    for(const color of Object.values(colors)) for(const bg of theme==='light'?['#ffffff']:['#151515','#222222','#333333']) {
      const a=luminance(color),b=luminance(bg);
      assert.ok((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)>=3,`${palette}/${theme} ${color} vs ${bg}`);
    }
  }
});
