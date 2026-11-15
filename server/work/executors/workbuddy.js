import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import { chromium } from 'playwright';
import { workError } from '../domain.js';
import { resolveWorkbuddyExe } from '../workbuddy-app.js';

const execFileAsync = promisify(execFile);

const MAX_PROMPT = 8000;
const MAX_OUTPUT = 20000;
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_TIMEOUT_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 8000;
const LAUNCH_WAIT_MS = 45000;
const POLL_MS = 700;
const SEND_TIMEOUT_MS = 10000;
const statusError = (message, status = 400) => Object.assign(workError(message, status), { status });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function normalizeWorkbuddyInput(input, { defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw statusError('WorkBuddy 输入必须为对象');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw statusError('WorkBuddy 任务内容不能为空');
  if (prompt.includes('\0')) throw statusError('WorkBuddy 任务内容不允许 NUL 字符');
  if (prompt.length > MAX_PROMPT) throw statusError(`WorkBuddy 任务内容不能超过 ${MAX_PROMPT} 字`);
  const rawTimeout = input.timeoutMs === undefined ? defaultTimeoutMs : input.timeoutMs;
  if (!Number.isInteger(rawTimeout) || rawTimeout < MIN_TIMEOUT_MS || rawTimeout > MAX_TIMEOUT_MS) {
    throw statusError(`timeoutMs 必须是 ${MIN_TIMEOUT_MS / 1000}–${MAX_TIMEOUT_MS / 1000} 秒之间的整数`);
  }
  return {
    prompt,
    timeoutMs: rawTimeout,
    newConversation: input.newConversation !== false
  };
}

// WorkBuddy 的助手消息帧带 data-status；正文在各 markdown 块里。
// 这里只保留非折叠区（工具过程收在 cr-collapse 里），避免把过程日志当成结论。
export function extractAssistantReply(content) {
  if (typeof content !== 'string' || !content) return '';
  return content.trim().slice(0, MAX_OUTPUT);
}

async function isWorkbuddyRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/NH'], { timeout: 5000, windowsHide: true });
    return /WorkBuddy\.exe/i.test(String(stdout || ''));
  } catch {
    return false;
  }
}

function pageReady(page) {
  return page && !page.isClosed();
}

async function findComposer(page) {
  const boxes = page.locator('[role="textbox"][contenteditable="true"]');
  const total = await boxes.count().catch(() => 0);
  for (let index = total - 1; index >= 0; index -= 1) {
    const box = boxes.nth(index);
    if (await box.isVisible().catch(() => false)) return box;
  }
  return null;
}

async function startNewConversation(page) {
  const clicked = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button,[role="tab"],[role="button"],a')];
    const target = nodes.find(node => (node.textContent || '').trim() === '新建任务' && node.getBoundingClientRect().width > 0);
    if (!target) return false;
    target.click();
    return true;
  }).catch(() => false);
  if (clicked) await page.waitForTimeout(400);
  return clicked;
}

async function readFrameState(page) {
  return page.evaluate(() => {
    const frames = [...document.querySelectorAll('[data-cr-frame]')];
    const last = frames[frames.length - 1] || null;
    const content = last?.querySelector('[data-assistant-content]') || null;
    const blocks = content
      ? [...content.querySelectorAll('[data-markdown-content]')].filter(el => !el.closest('.cr-collapse'))
      : [];
    const text = blocks.map(el => (el.innerText || '').trim()).filter(Boolean).join('\n\n').trim();
    // 注意：消息帧的 data-status 从生成开始就是 complete，不能用来判断任务结束。
    // 真正可靠的信号是过程折叠条的 --completed 类（标题变成「已完成 Ns」）。
    const collapse = content?.querySelector('.cr-collapse') || null;
    const done = Boolean(content?.querySelector('.cr-collapse--completed'))
      || /^已完成/.test(collapse?.querySelector('.cr-collapse__title')?.textContent || '');
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(el => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    return {
      frameCount: frames.length,
      status: last?.getAttribute('data-status') || '',
      frameId: last?.getAttribute('data-cr-frame-id') || '',
      done,
      text,
      dialog: dialog ? (dialog.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    };
  });
}

function createPlaywrightDriver({ port, exe, launch, log }) {
  let browser = null;
  let page = null;

  async function connect() {
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: CONNECT_TIMEOUT_MS });
  }

  function pickPage(instance) {
    const pages = instance.contexts().flatMap(context => context.pages());
    return pages.find(item => /workbuddy|codebuddy/i.test(item.url()))
      || pages.find(item => pageReady(item))
      || null;
  }

  async function open() {
    try {
      browser = await connect();
    } catch {
      const running = await isWorkbuddyRunning();
      if (running) {
        throw statusError(`WorkBuddy 正在运行，但没有开启调试端口。请退出 WorkBuddy 后重新打开（Lagent 会自动带 --remote-debugging-port=${port} 启动），或手动以该参数启动。`, 503);
      }
      if (!launch) throw statusError(`WorkBuddy 未启动或调试端口 ${port} 不可用`, 503);
      if (!exe) throw statusError('没有找到 WorkBuddy 安装位置，请设置环境变量 LAGENT_WORKBUDDY_EXE 指向 WorkBuddy.exe', 503);
      try {
        const child = spawn(exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        log?.('launched', { exe, port });
      } catch (error) {
        throw statusError(`启动 WorkBuddy 失败：${error?.message || error}`, 503);
      }
      const deadline = Date.now() + LAUNCH_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(1000);
        try { browser = await connect(); break; } catch { /* 启动中 */ }
      }
      if (!browser) throw statusError(`WorkBuddy 已启动，但 ${Math.round(LAUNCH_WAIT_MS / 1000)} 秒内没有等到调试端口 ${port}`, 503);
    }
    page = pickPage(browser);
    if (!page) throw statusError('已连接 WorkBuddy，但没有找到可操作的页面', 503);
    await page.bringToFront().catch(() => {});
    return page;
  }

  async function send(prompt, { newConversation = true } = {}) {
    if (!pageReady(page)) await open();
    if (newConversation && !(await startNewConversation(page))) {
      throw statusError('没找到 WorkBuddy 的「新建任务」入口，请确认窗口停在主界面后再试', 409);
    }
    let box = await findComposer(page);
    const boxDeadline = Date.now() + 8000;
    while (!box && Date.now() < boxDeadline) {
      await sleep(400);
      box = await findComposer(page);
    }
    if (!box) throw statusError('没找到 WorkBuddy 的任务输入框，请确认窗口停在会话页面', 409);
    await box.click();
    await box.fill(prompt);
    const sendButton = page.locator('button[aria-label="发送"]').first();
    await sendButton.waitFor({ state: 'visible', timeout: SEND_TIMEOUT_MS });
    const enabledDeadline = Date.now() + 5000;
    while (await sendButton.isDisabled().catch(() => true)) {
      if (Date.now() > enabledDeadline) throw statusError('WorkBuddy 发送按钮没有变成可用状态，任务可能没有填进输入框', 409);
      await sleep(200);
    }
    const baseline = await page.evaluate(() => document.querySelectorAll('[data-cr-frame]').length);
    await sendButton.click();
    log?.('sent', { baseline });
    return { baseline };
  }

  async function wait({ baseline, timeoutMs, cancelled }) {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = '';
    let lastText = '';
    let stable = 0;
    while (Date.now() < deadline) {
      if (cancelled?.()) {
        const stop = page.locator('button[aria-label*="停止"]').first();
        if (await stop.count().catch(() => 0)) await stop.click().catch(() => {});
        throw statusError('WorkBuddy 任务已停止', 499);
      }
      if (!pageReady(page)) throw statusError('WorkBuddy 窗口已关闭，任务无法继续', 503);
      const state = await readFrameState(page).catch(() => null);
      if (state) {
        lastStatus = state.status;
        if (state.dialog && /(允许|同意|授权|允许一次)/.test(state.dialog) && /(拒绝|取消)/.test(state.dialog)) {
          throw statusError('WorkBuddy 弹出了权限确认，需要人工处理后才能在 Lagent 里继续', 409);
        }
        // 折叠条标记完成后正文仍可能继续渲染，等正文连续两次保持不变再收尾。
        if (state.frameCount > baseline && state.done && state.text) {
          if (state.text === lastText) stable += 1;
          else stable = 0;
          lastText = state.text;
          if (stable >= 2) return extractAssistantReply(state.text);
        } else {
          stable = 0;
          lastText = state.text || '';
        }
        if (/(error|failed|aborted)/i.test(state.status)) {
          throw statusError(state.text ? `WorkBuddy 执行失败：${state.text.slice(0, 300)}` : 'WorkBuddy 执行失败', 502);
        }
      }
      await sleep(POLL_MS);
    }
    const minutes = Math.max(1, Math.round((timeoutMs / 60000) * 10) / 10);
    throw Object.assign(statusError(`WorkBuddy 超过 ${minutes} 分钟没有返回结果（最后状态：${lastStatus || '未知'}）；任务可能仍在执行，可到 WorkBuddy 窗口查看`, 504), { code: 'workbuddy_timeout' });
  }

  async function close() {
    try { await browser?.close(); } catch { /* 连接已断开 */ }
    browser = null;
    page = null;
  }

  return { open, send, wait, close };
}

export function workbuddyExecutor({
  store,
  port = Number(process.env.LAGENT_WORKBUDDY_PORT) || DEFAULT_PORT,
  exe = process.env.LAGENT_WORKBUDDY_EXE || resolveWorkbuddyExe(),
  launch = process.env.LAGENT_WORKBUDDY_AUTOLAUNCH !== '0',
  timeoutMs = Number(process.env.LAGENT_WORKBUDDY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  driverFactory = options => createPlaywrightDriver(options)
} = {}) {
  if (!store || typeof store.put !== 'function' || typeof store.get !== 'function') throw new TypeError('workbuddyExecutor 需要 store');

  const active = new Map();
  let tail = Promise.resolve();
  const persist = task => { store.put('task', task); return task; };
  const serial = work => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };

  function finalize(task, { text, error, startedAt, cancelled }) {
    const stamp = new Date().toISOString();
    const failed = Boolean(error);
    task.status = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
    task.endedAt = stamp;
    task.updatedAt = stamp;
    task.error = cancelled ? 'WorkBuddy 任务已停止' : failed ? String(error?.message || error).slice(0, 2000) : undefined;
    task.artifacts = {
      ...(task.artifacts || {}),
      cli: {
        executorId: 'workbuddy',
        summary: (text || '').slice(0, 6000),
        usage: {},
        error: failed && !cancelled ? String(error?.message || error).slice(0, 2000) : undefined,
        artifacts: [],
        stats: { durationMs: Date.now() - startedAt },
        modelLabel: 'WorkBuddy 桌面版',
        exitCode: failed ? 1 : 0,
        durationMs: Date.now() - startedAt
      }
    };
    return persist(task);
  }

  function start(ticket, assignment, input) {
    const normalized = normalizeWorkbuddyInput(input?.executorInput ?? input, { defaultTimeoutMs: timeoutMs });
    const prior = store.get('task', assignment.id);
    if (prior) return prior;
    const stamp = new Date().toISOString();
    const task = {
      id: assignment.id,
      workAssignmentId: assignment.id,
      executorId: 'workbuddy',
      goal: ticket?.command || normalized.prompt,
      status: 'running',
      createdAt: stamp,
      updatedAt: stamp,
      activity: []
    };
    persist(task);
    const controller = { cancelled: false, task };
    active.set(task.id, controller);
    const startedAt = Date.now();
    void serial(async () => {
      if (controller.cancelled) { active.delete(task.id); finalize(task, { startedAt, cancelled: true }); return; }
      const driver = driverFactory({
        port,
        exe: exe || resolveWorkbuddyExe(),
        launch,
        log: (event, detail) => {
          task.activity = [...(task.activity || []), { at: new Date().toISOString(), event, ...(detail || {}) }].slice(-50);
        }
      });
      try {
        await driver.open();
        const { baseline } = await driver.send(normalized.prompt, { newConversation: normalized.newConversation });
        const text = await driver.wait({ baseline, timeoutMs: normalized.timeoutMs, cancelled: () => controller.cancelled });
        if (!controller.cancelled) finalize(task, { text, startedAt });
      } catch (error) {
        const cancelled = controller.cancelled || error?.status === 499;
        finalize(task, { error, startedAt, cancelled });
      } finally {
        active.delete(task.id);
        await driver.close().catch(() => {});
      }
    });
    return task;
  }

  return {
    id: 'workbuddy',
    name: 'WorkBuddy',
    kind: 'cli',
    available: true,
    requiresDataset: false,
    capabilities: ['cli', 'desktop', 'computer-use', 'text-output'],
    validateInput: input => normalizeWorkbuddyInput(input, { defaultTimeoutMs: timeoutMs }),
    defaultInput: text => normalizeWorkbuddyInput({ prompt: text }, { defaultTimeoutMs: timeoutMs }),
    start,
    get: id => store.get('task', id) || null,
    stop(task) {
      if (!task) return;
      const controller = active.get(task.id);
      if (controller) controller.cancelled = true;
      task.cancelled = true;
      task.status = 'cancelled';
      task.endedAt = new Date().toISOString();
      task.updatedAt = task.endedAt;
      task.error = 'WorkBuddy 任务已停止';
      persist(task);
    },
    close() {
      for (const controller of active.values()) {
        controller.cancelled = true;
        const task = controller.task;
        if (task && ['running', 'awaiting_approval'].includes(task.status)) {
          task.status = 'cancelled';
          task.cancelled = true;
          task.error = '服务重启，WorkBuddy 已中断';
          task.updatedAt = new Date().toISOString();
          persist(task);
        }
      }
      active.clear();
    }
  };
}
