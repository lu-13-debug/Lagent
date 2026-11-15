import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveService } from './work/live-session.js';

function fixture(t, captureImpl) {
  const events = [];
  let calls = 0;
  const capture = captureImpl || (async input => {
    calls += 1;
    return { image: `data:image/jpeg;base64,AAAA${calls}`, width: 800, height: 600, title: input.title || 'Codex 会话', process: 'codex' };
  });
  const live = createLiveService({ capture, emit: event => events.push(event), env: {} });
  t.after(() => live.close());
  return { live, events, calls: () => calls };
}

test('启动实时观察立即采集首帧，tick 递增序号', async t => {
  const f = fixture(t);
  const session = await f.live.start({ handle: '12345', process: 'codex', title: 'Codex 会话' });
  assert.equal(session.status, 'live');
  assert.equal(session.handle, 12345);
  assert.equal(session.frames, 1);
  assert.equal(session.seq, 1);
  const frame = f.live.frame(session.id);
  assert.match(frame.image, /^data:image\/jpeg;base64,/);
  assert.equal(frame.seq, 1);
  assert.deepEqual(f.events.slice(0, 2).map(event => event.type), ['live-start', 'live-frame']);
  await f.live.tick();
  assert.equal(f.live.get(session.id).seq, 2);
  assert.equal(f.events.filter(event => event.type === 'live-frame').at(-1).payload.seq, 2);
  assert.equal(f.live.list().length, 1);
});

test('敏感标题自动暂停并清空画面，切换页面后可恢复', async t => {
  let title = '支付确认';
  const f = fixture(t, async input => ({ image: 'data:image/jpeg;base64,PRIVATE', width: 800, height: 600, title, process: 'codex' }));
  const session = await f.live.start({ handle: 222, process: 'codex', title: 'Codex 会话' });
  assert.equal(session.status, 'paused');
  assert.equal(session.pausedReason, 'sensitive-title');
  assert.equal(session.frames, 0);
  assert.throws(() => f.live.frame(session.id), { status: 404 });
  assert.equal(f.events.filter(event => event.type === 'live-frame').length, 0);
  // 标题仍敏感时继续观察也不会推送画面。
  await f.live.tick();
  assert.equal(f.events.filter(event => event.type === 'live-frame').length, 0);
  title = 'Codex 会话';
  const resumed = f.live.resume(session.id);
  assert.equal(resumed.status, 'live');
  await f.live.tick();
  assert.equal(f.live.get(session.id).frames, 1);
  assert.equal(f.events.filter(event => event.type === 'live-frame').length, 1);
  assert.equal(f.live.frame(session.id).width, 800);
});

test('接管后停止采集并清空画面', async t => {
  const f = fixture(t);
  const session = await f.live.start({ handle: 333, process: 'codex' });
  const taken = f.live.takeover(session.id);
  assert.equal(taken.status, 'takeover');
  assert.throws(() => f.live.frame(session.id), { status: 404 });
  const before = f.calls();
  await f.live.tick();
  assert.equal(f.calls(), before);
  assert.ok(f.events.some(event => event.type === 'live-takeover'));
  assert.equal(f.live.stop(session.id).ok, true);
  assert.throws(() => f.live.get(session.id), { status: 404 });
});

test('暂停/继续限制与重复窗口拒绝', async t => {
  const f = fixture(t);
  const session = await f.live.start({ handle: 444, process: 'codex' });
  assert.throws(() => f.live.resume(session.id), { status: 409 });
  await assert.rejects(f.live.start({ handle: 444, process: 'codex' }), { status: 409 });
  await assert.rejects(f.live.start({ handle: 'abc' }), { status: 400 });
  assert.throws(() => f.live.pause('missing'), { status: 404 });
  const paused = f.live.pause(session.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pausedReason, 'manual');
  assert.throws(() => f.live.pause(session.id, 'manual'), { status: 409 });
  assert.equal(f.live.resume(session.id).status, 'live');
});

test('连续截图失败三次后停止采集', async t => {
  const f = fixture(t, async () => { throw Object.assign(new Error('窗口已关闭'), { status: 404 }); });
  // 首帧失败时直接拒绝启动，不留下半截会话。
  await assert.rejects(f.live.start({ handle: 555, process: 'codex' }), { message: '窗口已关闭' });
  assert.equal(f.live.list().length, 0);
});

test('已在观察中的会话截图失败会进入 error 状态', async t => {
  let fail = false;
  const f = fixture(t, async () => {
    if (fail) throw Object.assign(new Error('窗口已关闭'), { status: 404 });
    return { image: 'data:image/jpeg;base64,AAAA', width: 640, height: 480, title: 'Codex 会话', process: 'codex' };
  });
  const session = await f.live.start({ handle: 666, process: 'codex' });
  fail = true;
  assert.deepEqual(await f.live.tick(), { captured: 0 });
  await f.live.tick();
  await f.live.tick();
  const after = f.live.get(session.id);
  assert.equal(after.status, 'error');
  assert.match(after.lastError, /窗口已关闭/);
  assert.throws(() => f.live.frame(session.id), { status: 404 });
});
