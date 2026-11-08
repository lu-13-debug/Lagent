import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';

const read = () => postcss.parse(fs.existsSync(new URL('./concise-theme.css', import.meta.url)) ? fs.readFileSync(new URL('./concise-theme.css', import.meta.url), 'utf8') : '');
test('简洁样式的所有选择器隔离正常版', () => {
  const css = read(); let count = 0;
  css.walkRules(rule => { count++; for (const selector of rule.selectors) assert.ok(selector.startsWith('html[data-view="concise"]'), selector); });
  assert.ok(count > 10, '应提供简洁主题和组件样式');
});
const luminance = hex => hex.slice(1).match(/../g).map(n => parseInt(n,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
const contrast = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
test('简洁白天夜间所有文字和语义状态在各层背景达到4.5', () => {
  for (const theme of ['light','dark']) {
    const tokens = {};
    read().walkRules(rule => {if (rule.selector === `html[data-view="concise"][data-theme="${theme}"]`) rule.walkDecls(d=>tokens[d.prop]=d.value);});
    assert.ok(tokens['--text-1'], `缺少${theme}主题`);
    for (const fg of ['--text-1','--text-2','--text-3','--success','--warning','--danger']) for (const bg of ['--surface-0','--surface-1','--surface-2','--surface-3']) assert.ok(contrast(tokens[fg],tokens[bg])>=4.5, `${theme}: ${fg}/${bg}`);
  }
});
test('设置文案只保留主题层次，不再暴露正常版/简洁版切换', () => {
  const source = fs.readFileSync(new URL('./components/AppearanceSettings.tsx',import.meta.url),'utf8');
  for (const label of ['白天','夜间','跟随系统']) assert.ok(source.includes(label),label);
  assert.ok(!source.includes('正常版'),'不应再出现正常版');
  assert.ok(!source.includes('页面视图'),'不应再出现页面视图切换');
});
