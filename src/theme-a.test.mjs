import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';

const read = file => postcss.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
const valuesOf = (css, selector) => {
  const values = {};
  css.walkRules(rule => { if (rule.selector === selector) rule.walkDecls(decl => { values[decl.prop] = decl.value; }); });
  return values;
};
const luminance = hex => hex.replace('#', '').match(/../g).map(n => parseInt(n, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, index) => sum + v * [.2126, .7152, .0722][index], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

test('A 夜间 / B 白天：控制台 token 落地且文字与语义色达 4.5:1', () => {
  const shell = read('./superagent.css');
  const light = valuesOf(shell, '.sa-shell');
  const dark = valuesOf(shell, 'html[data-theme="dark"] .sa-shell');
  assert.equal(light['--sa-canvas'], '#f3f1ea');
  assert.equal(light['--sa-accent'], '#a8492b');
  assert.equal(light['--sa-sidebar'], '244px');
  assert.equal(light['--sa-rail'], '340px');
  assert.equal(light['--sa-r-md'], '4px');
  assert.equal(dark['--sa-canvas'], '#0b0d0c');
  assert.equal(dark['--sa-accent'], '#d9a441');
  assert.equal(dark['--sa-on-accent'], '#141008');

  for (const [name, tokens] of [['light', light], ['dark', dark]]) {
    for (const fg of ['--sa-text', '--sa-text-2', '--sa-text-3', '--sa-success', '--sa-warning', '--sa-danger']) {
      for (const bg of ['--sa-canvas', '--sa-surface', '--sa-surface-2', '--sa-surface-3']) {
        assert.ok(contrast(tokens[fg], tokens[bg]) >= 4.5, `${name}: ${fg} / ${bg}`);
      }
    }
    assert.ok(contrast(tokens['--sa-accent'], tokens['--sa-on-accent']) >= 4.5, `${name}: 主色按钮`);
  }
});

test('控制台与公共页面共用同一套 A/B 色板，避免两处漂移', () => {
  const shell = read('./superagent.css');
  const appearance = read('./appearance.css');
  const concise = read('./concise-theme.css');
  const shellLight = valuesOf(shell, '.sa-shell');
  const shellDark = valuesOf(shell, 'html[data-theme="dark"] .sa-shell');
  const pageLight = valuesOf(appearance, ':root, html[data-theme="light"]');
  const pageDark = valuesOf(appearance, 'html[data-theme="dark"]');
  const conciseLight = valuesOf(concise, 'html[data-view="concise"][data-theme="light"]');
  const conciseDark = valuesOf(concise, 'html[data-view="concise"][data-theme="dark"]');

  const pairs = [
    [shellLight['--sa-canvas'], pageLight['--surface-0'], conciseLight['--surface-0']],
    [shellLight['--sa-surface'], pageLight['--surface-1'], conciseLight['--surface-1']],
    [shellLight['--sa-text'], pageLight['--text-1'], conciseLight['--text-1']],
    [shellLight['--sa-accent'], pageLight['--accent'], conciseLight['--accent']],
    [shellDark['--sa-canvas'], pageDark['--surface-0'], conciseDark['--surface-0']],
    [shellDark['--sa-surface'], pageDark['--surface-1'], conciseDark['--surface-1']],
    [shellDark['--sa-text'], pageDark['--text-1'], conciseDark['--text-1']],
    [shellDark['--sa-accent'], pageDark['--accent'], conciseDark['--accent']]
  ];
  for (const [control, page, conciseValue] of pairs) assert.equal(control, page, '控制台与公共页面');
  for (const [control, page, conciseValue] of pairs) assert.equal(control, conciseValue, '控制台与简洁视图');
});
