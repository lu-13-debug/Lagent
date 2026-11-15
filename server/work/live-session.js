import { randomUUID } from 'node:crypto';
import { workError } from './domain.js';

// 实时观察：只保存最近一帧到内存，1 秒轮询；识别到敏感窗口标题立即暂停采集。
// 画面不落盘、不写事件表，SSE 断开后也不会补发历史帧。
export const SENSITIVE_TITLE = /支付|银行|密码|验证码|身份证|信用卡|钱包|助记词|恢复码|wallet|payment|password|passwd|passcode|2fa|otp|one[- ]time|secret|private\s*key/i;
export const LIVE_STATUSES = Object.freeze(['live', 'paused', 'takeover', 'error']);

const text = (value, label, max) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length > max) throw workError(`${label}不能超过 ${max} 字`, 400);
  return result;
};

function handleOf(value) {
  const number = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isSafeInteger(number) || number <= 0 || number > Number.MAX_SAFE_INTEGER) throw workError('窗口句柄无效', 400);
  return number;
}

export function createLiveService({ capture, emit = () => {}, now = () => new Date().toISOString(), intervalMs = 1000, maxSessions = 3, env = process.env } = {}) {
  if (typeof capture !== 'function') throw new TypeError('实时观察需要截图函数');
  const sessions = new Map();
  let timer = null;
  let ticking = false;
  const budget = Math.max(800, Math.min(Number(intervalMs) || Number(env.LAGENT_LIVE_INTERVAL_MS) || 1000, 5000));

  function publicSession(session) {
    return {
      id: session.id,
      handle: session.handle,
      process: session.process,
      title: session.title,
      ticketId: session.ticketId,
      status: session.status,
      pausedReason: session.pausedReason || '',
      lastError: session.lastError || '',
      intervalMs: budget,
      frames: session.frames,
      seq: session.seq,
      startedAt: session.startedAt,
      lastFrameAt: session.lastFrameAt || null,
      width: session.width || 0,
      height: session.height || 0
    };
  }

  const find = id => {
    const session = typeof id === 'string' ? sessions.get(id) : null;
    if (!session) throw workError('实时观察会话不存在', 404);
    return session;
  };

  function pauseInternal(session, reason) {
    if (session.status !== 'live') return;
    session.status = 'paused';
    session.pausedReason = reason;
    session.lastFrame = null;
    session.width = 0;
    session.height = 0;
    emit({ type: 'live-pause', ...(session.ticketId ? { ticketId: session.ticketId } : {}), payload: { id: session.id, reason } });
    if (![...sessions.values()].some(item => item.status === 'live')) stopTimer();
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, budget);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function captureOne(session, { silent = false } = {}) {
    const frame = await capture({ handle: session.handle, process: session.process, title: session.title });
    if (!frame || typeof frame.image !== 'string' || !/^data:image\/(jpeg|png);base64,/.test(frame.image)) {
      throw workError('截图结果无效', 502);
    }
    // 标题以窗口实时返回值为准，避免用户切到支付/密码页面后还在推送旧标题。
    const title = text(frame.title, '窗口标题', 200) || session.title;
    session.title = title;
    if (SENSITIVE_TITLE.test(title)) {
      if (silent) {
        session.status = 'paused';
        session.pausedReason = 'sensitive-title';
        session.lastFrame = null;
      } else {
        pauseInternal(session, 'sensitive-title');
      }
      return null;
    }
    session.lastError = '';
    session.errors = 0;
    session.lastFrame = frame.image;
    session.width = Number(frame.width) || 0;
    session.height = Number(frame.height) || 0;
    session.lastFrameAt = now();
    session.frames += 1;
    session.seq += 1;
    return { seq: session.seq, image: frame.image, width: session.width, height: session.height, at: session.lastFrameAt, title };
  }

  async function start(input = {}) {
    if (String(env.LAGENT_LIVE_VIEW) === '0') throw workError('实时观察已关闭', 409);
    if (sessions.size >= maxSessions) throw workError(`最多同时观察 ${maxSessions} 个窗口`, 429);
    const handle = handleOf(input.handle);
    if ([...sessions.values()].some(session => session.handle === handle && session.status !== 'error')) throw workError('该窗口已在观察中', 409);
    const session = {
      id: randomUUID(),
      handle,
      process: text(input.process, '进程名', 80),
      title: text(input.title, '窗口标题', 200),
      ticketId: text(input.ticketId, '工单 id', 100),
      status: 'live',
      pausedReason: '',
      lastError: '',
      errors: 0,
      frames: 0,
      seq: 0,
      lastFrame: null,
      width: 0,
      height: 0,
      startedAt: now(),
      lastFrameAt: null
    };
    sessions.set(session.id, session);
    try {
      const frame = await captureOne(session, { silent: true });
      emit({ type: 'live-start', ...(session.ticketId ? { ticketId: session.ticketId } : {}), payload: { id: session.id, handle, process: session.process, title: session.title, status: session.status } });
      if (session.pausedReason === 'sensitive-title') emit({ type: 'live-pause', ...(session.ticketId ? { ticketId: session.ticketId } : {}), payload: { id: session.id, reason: 'sensitive-title' } });
      if (frame) emit({ type: 'live-frame', ...(session.ticketId ? { ticketId: session.ticketId } : {}), payload: { id: session.id, ...frame } });
    } catch (failure) {
      sessions.delete(session.id);
      throw failure;
    }
    if (session.status === 'live') startTimer();
    return publicSession(session);
  }

  async function tick() {
    if (ticking) return { captured: 0 };
    ticking = true;
    let captured = 0;
    try {
      for (const session of sessions.values()) {
        if (session.status !== 'live') continue;
        try {
          const frame = await captureOne(session);
          if (!frame) continue;
          captured += 1;
          emit({ type: 'live-frame', ...(session.ticketId ? { ticketId: session.ticketId } : {}), payload: { id: session.id, ...frame } });
        } catch (failure) {
          session.errors += 1;
          session.lastError = String(failure?.message || failure).slice(0, 200);
          if (session.errors >= 3) {
            session.status = 'error';
            session.lastFrame = null;
            emit({ type: 'live-pause', ...(session.ticketId ? { ticketId: session.ticketId } : {}), payload: { id: session.id, reason: 'capture-failed', error: session.lastError } });
          }
        }
      }
    } finally {
      ticking = false;
      if (![...sessions.values()].some(item => item.status === 'live')) stopTimer();
    }
    return { captured };
  }

  function pause(id, reason = 'manual') {
    const session = find(id);
    if (session.status !== 'live') throw workError('当前状态不能暂停', 409);
    pauseInternal(session, reason);
    return publicSession(session);
  }

  function resume(id) {
    const session = find(id);
    if (session.status !== 'paused') throw workError('只有暂停中的会话可以继续', 409);
    // 不在 resume 时立即截图：下一轮采集会以窗口实时标题重新判断，敏感页面不会被推送。
    session.status = 'live';
    session.pausedReason = '';
    startTimer();
    emit({ type: 'live-resume', ...(session.ticketId ? { ticketId: session.ticketId } : {}), payload: { id: session.id } });
    return publicSession(session);
  }

  function takeover(id) {
    const session = find(id);
    session.status = 'takeover';
    session.lastFrame = null;
    session.width = 0;
    session.height = 0;
    if (![...sessions.values()].some(item => item.status === 'live')) stopTimer();
    emit({ type: 'live-takeover', ...(session.ticketId ? { ticketId: session.ticketId } : {}), payload: { id: session.id, handle: session.handle, process: session.process } });
    return publicSession(session);
  }

  function stop(id) {
    const session = find(id);
    session.lastFrame = null;
    sessions.delete(session.id);
    if (![...sessions.values()].some(item => item.status === 'live')) stopTimer();
    emit({ type: 'live-stop', ...(session.ticketId ? { ticketId: session.ticketId } : {}), payload: { id: session.id } });
    return { ok: true, id: session.id };
  }

  function frame(id) {
    const session = find(id);
    if (!session.lastFrame) throw workError(session.status === 'paused' ? '画面已暂停，当前没有可查看的截图' : '还没有可用的画面', 404);
    return { id: session.id, seq: session.seq, image: session.lastFrame, width: session.width, height: session.height, at: session.lastFrameAt, status: session.status };
  }

  function close() {
    stopTimer();
    sessions.clear();
  }

  return {
    start,
    list: () => [...sessions.values()].map(publicSession),
    get: id => publicSession(find(id)),
    frame,
    pause,
    resume,
    takeover,
    stop,
    tick,
    close
  };
}
