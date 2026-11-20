import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { workError } from './domain.js';

// 例行任务：按间隔/每日时间/手动/Webhook 触发，默认只创建「建议工单」，
// 进入全局收件箱等待人工批准；只有显式开启 auto 且策略允许时才自动执行。
export const ROUTINE_KINDS = Object.freeze(['task', 'daily-brief', 'stall-followup']);
export const ROUTINE_KIND = 'work-routine';
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROUTINES = 50;
const NAME_MAX = 80;
const PROMPT_MAX = 4000;
const DEFAULT_STALL_MS = 30 * 60 * 1000;

const hashToken = token => createHash('sha256').update(token).digest('hex');
const nowIso = now => new Date(now()).toISOString();
const text = (value, label, max) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length > max) throw workError(`${label}不能超过 ${max} 字`, 400);
  return result;
};

function normalizeSchedule(value = {}) {
  const kind = typeof value.kind === 'string' ? value.kind.trim() : 'manual';
  if (!['interval', 'daily', 'manual', 'webhook', 'git', 'file'].includes(kind)) throw workError('routine.schedule.kind 仅支持 interval/daily/manual/webhook/git/file', 400);
  if (kind === 'interval') {
    const intervalMs = Number(value.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) throw workError('间隔必须在 5 分钟到 30 天之间', 400);
    return { kind, intervalMs: Math.round(intervalMs) };
  }
  if (kind === 'daily') {
    const at = typeof value.at === 'string' ? value.at.trim() : '';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) throw workError('每日时间格式应为 HH:MM', 400);
    return { kind, at };
  }
  if (kind === 'file') {
    const relative = typeof value.path === 'string' ? value.path.trim().replaceAll('\\', '/') : '';
    if (!relative || relative.length > 300) throw workError('文件触发需要填写项目内的相对路径', 400);
    if (path.posix.isAbsolute(relative) || relative.split('/').some(part => part === '..')) throw workError('文件路径必须是项目内的相对路径', 400);
    const debounceMs = Math.max(0, Math.min(Number(value.debounceMs) || 0, 60000));
    return { kind, path: relative, debounceMs };
  }
  if (kind === 'git') return { kind };
  return { kind };
}

function nextDaily(at, from) {
  const [hour, minute] = at.split(':').map(Number);
  const date = new Date(from);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
  if (target.getTime() <= from) target.setDate(target.getDate() + 1);
  return target.getTime();
}

// 事件触发只看「是否变了」，不读取文件内容；Git 触发只看 HEAD，不扫描工作区。
function watchSignature(projectPath, schedule) {
  if (schedule.kind === 'git') {
    try {
      return `git:${execFileSync('git', ['-C', projectPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()}`;
    } catch {
      return 'git:unavailable';
    }
  }
  if (schedule.kind === 'file') {
    try {
      const root = path.resolve(projectPath);
      const target = path.resolve(root, schedule.path);
      if (target !== root && !target.startsWith(root + path.sep)) return 'file:outside';
      // 符号链接也必须留在项目内，避免借监视路径探测项目外文件。
      const realRoot = fs.realpathSync(root);
      let probe = target;
      while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      const realProbe = fs.realpathSync(probe);
      if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) return 'file:outside';
      const stat = fs.statSync(target);
      return `file:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'file:missing';
    }
  }
  return '';
}

export function createRoutineService({ store, engine, now = Date.now, tickMs = 30000, env = process.env } = {}) {
  if (!store || !engine) throw new TypeError('Routine 服务需要 store 与 engine');
  let timer = null;
  let ticking = false;

  const rows = () => store.list(ROUTINE_KIND).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const find = id => {
    if (typeof id !== 'string' || !id.trim()) throw workError('routine id 无效', 400);
    const row = store.get(ROUTINE_KIND, id.trim());
    if (!row) throw workError('例行任务不存在', 404);
    return row;
  };

  function publicRow(row) {
    return {
      id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
      kind: row.kind,
      projectId: row.projectId,
      projectChatId: row.projectChatId,
      executorId: row.executorId,
      schedule: { ...row.schedule },
      promptTemplate: row.promptTemplate || '',
      question: row.question || '',
      mode: row.mode,
      stallMs: row.stallMs || DEFAULT_STALL_MS,
      nextAt: row.nextAt || null,
      lastRunAt: row.lastRunAt || null,
      lastTicketId: row.lastTicketId || null,
      lastError: row.lastError || '',
      webhookConfigured: Boolean(row.webhookHash),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  function nextAtFor(schedule, from) {
    if (schedule.kind === 'interval') return from + schedule.intervalMs;
    if (schedule.kind === 'daily') return nextDaily(schedule.at, from);
    return null;
  }

  function ensureChat(projectId, executorId, name) {
    const project = engine.getProject(projectId);
    const chats = Array.isArray(project.chats) ? project.chats : [];
    const existing = chats.find(chat => chat.executorId === executorId && chat.source !== 'imported') || chats.find(chat => chat.executorId === executorId);
    if (existing) return { project, chat: existing };
    const created = engine.createProjectChat(project.id, { executorId, title: `Routine · ${name}`.slice(0, 60) });
    return { project, chat: created.chat };
  }

  function save(input = {}) {
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : '';
    const current = id ? find(id) : null;
    if (!current && rows().length >= MAX_ROUTINES) throw workError(`最多创建 ${MAX_ROUTINES} 个例行任务`, 429);
    const name = text(input.name ?? current?.name, '任务名称', NAME_MAX);
    if (!name) throw workError('请填写任务名称', 400);
    const kind = text(input.kind ?? current?.kind ?? 'task', '任务类型', 40) || 'task';
    if (!ROUTINE_KINDS.includes(kind)) throw workError('未知的例行任务类型', 400);
    const projectId = text(input.projectId ?? current?.projectId, '项目', 100);
    if (!projectId) throw workError('请选择项目', 400);
    const executorId = text(input.executorId ?? current?.executorId ?? '', '执行器', 60) || 'model';
    const schedule = normalizeSchedule(input.schedule ?? current?.schedule ?? { kind: 'manual' });
    const promptTemplate = text(input.promptTemplate ?? current?.promptTemplate, '任务说明', PROMPT_MAX);
    if (kind === 'task' && !promptTemplate) throw workError('普通例行任务需要填写任务说明', 400);
    const question = text(input.question ?? current?.question, '确认问题', 300);
    const mode = input.mode ?? current?.mode ?? 'suggest';
    if (!['suggest', 'auto'].includes(mode)) throw workError('routine.mode 仅支持 suggest/auto', 400);
    const stallMs = Number.isSafeInteger(Number(input.stallMs ?? current?.stallMs)) ? Number(input.stallMs ?? current?.stallMs) : DEFAULT_STALL_MS;
    if (stallMs < 10 * 60 * 1000 || stallMs > 7 * 24 * 60 * 60 * 1000) throw workError('停滞阈值必须在 10 分钟到 7 天之间', 400);
    const enabled = input.enabled === undefined ? Boolean(current?.enabled) : input.enabled === true;
    if (schedule.kind === 'file' && schedule.path.split('/').some(part => ['', '.git', '.ssh', '.gnupg'].includes(part) || /^\.env(\.|$)/i.test(part) || /\.(pem|key|p12|pfx)$/i.test(part))) {
      throw workError('不能监视 .git、.ssh、密钥或 .env 文件', 403);
    }
    // 新建或切换执行器时自动准备项目对话；项目/执行器组合必须真的可执行。
    const { project, chat } = ensureChat(projectId, executorId, name);
    const stamp = now();
    let webhookHash = current?.webhookHash || '';
    let webhookToken = '';
    if (schedule.kind === 'webhook' && (!webhookHash || input.rotateWebhook === true)) {
      webhookToken = randomBytes(24).toString('base64url');
      webhookHash = hashToken(webhookToken);
    }
    if (schedule.kind !== 'webhook') webhookHash = '';
    const eventDriven = schedule.kind === 'git' || schedule.kind === 'file';
    const row = {
      id: current?.id || randomUUID(),
      name,
      kind,
      projectId,
      projectChatId: chat.id,
      executorId,
      schedule,
      promptTemplate,
      question,
      mode,
      stallMs,
      enabled,
      webhookHash,
      nextAt: enabled && !eventDriven ? nextAtFor(schedule, stamp) : null,
      ...(eventDriven ? { watchHash: watchSignature(project.path, schedule), watchPendingSince: null } : {}),
      lastRunAt: current?.lastRunAt || null,
      lastSlot: current?.lastSlot || null,
      lastTicketId: current?.lastTicketId || null,
      lastError: '',
      createdAt: current?.createdAt || nowIso(now),
      updatedAt: nowIso(now)
    };
    store.put(ROUTINE_KIND, row);
    return { routine: publicRow(row), ...(webhookToken ? { webhookToken } : {}) };
  }

  function remove(id) {
    const row = find(id);
    store.delete(ROUTINE_KIND, row.id);
    return { ok: true, id: row.id };
  }

  function promptFor(row, slot) {
    const project = engine.getProject(row.projectId);
    const date = new Date(now()).toISOString().slice(0, 10);
    if (row.kind === 'stall-followup') return '';
    const base = row.kind === 'daily-brief'
      ? `请阅读项目「${project.name}」的当前状态，给出一份简短日报：昨天完成了什么、今天建议做什么、有哪些风险或阻塞。不要修改文件，只输出结论与建议。`
      : row.promptTemplate;
    return base
      .replaceAll('{{project}}', project.name)
      .replaceAll('{{date}}', date)
      .replaceAll('{{brief}}', engine.projectBrief(row.projectId)?.summary || '');
  }

  function createStallSuggestions(row, slot) {
    const stamp = now();
    const cutoff = stamp - row.stallMs;
    const stale = store.list('work-ticket')
      .filter(ticket => ticket && ticket.status === 'working' && String(ticket.updatedAt || ticket.createdAt || '').slice(0, 24) && Date.parse(ticket.updatedAt || ticket.createdAt) <= cutoff)
      .slice(0, 5);
    const created = [];
    let lastError = '';
    for (const ticket of stale) {
      const control = store.get('work-control', ticket.id);
      if (!control?.projectChatId) continue;
      try {
        const suggestion = engine.createSuggestion({
          projectChatId: control.projectChatId,
          executorId: ticket.executor || row.executorId,
          title: `停滞跟进：${String(ticket.title || ticket.id).slice(0, 40)}`,
          text: `工单「${ticket.title || ticket.id}」已超过 ${Math.round(row.stallMs / 60000)} 分钟没有更新，可能已经停滞。请检查执行状态，给出重试、交接或取消的建议；不要直接修改文件。`,
          question: `工单「${String(ticket.title || ticket.id).slice(0, 60)}」疑似停滞，是否让 ${ticket.executor || row.executorId} 检查并继续？`,
          clientRequestId: `routine:${row.id}:stall:${ticket.id}:${slot}`,
          routineId: row.id
        });
        created.push(suggestion);
      } catch (error) {
        // 单个工单无法跟进（例如执行器已不可用）不影响其它工单。
        lastError = String(error?.message || error).slice(0, 200);
      }
    }
    return { created, lastError };
  }

  function execute(row, { manual = false, slot = '' } = {}) {
    const runSlot = slot || String(Math.floor(now() / 60000));
    if (row.kind === 'stall-followup') {
      const { created, lastError } = createStallSuggestions(row, runSlot);
      return { tickets: created, text: created.length ? `已为 ${created.length} 个停滞工单创建跟进建议` : '没有发现停滞工单', ...(lastError ? { lastError } : {}) };
    }
    const body = promptFor(row, runSlot);
    if (!body) throw workError('例行任务内容为空', 400);
    const ticket = engine.createSuggestion({
      projectChatId: row.projectChatId,
      executorId: row.executorId,
      title: row.name,
      text: body,
      question: row.question || `Routine「${row.name}」建议执行，是否批准？`,
      clientRequestId: `routine:${row.id}:${runSlot}`,
      routineId: row.id
    });
    let autoApproved = false;
    let lastError = '';
    if (row.mode === 'auto' && engine.policy()?.requireApproval !== true) {
      try {
        engine.action(ticket.id, 'approve');
        autoApproved = true;
      } catch (error) {
        // 自动执行失败时保留建议工单，让用户能看到失败原因并手动处理。
        lastError = `自动执行失败：${String(error?.message || error).slice(0, 160)}`;
      }
    }
    return { tickets: [ticket], autoApproved, text: autoApproved ? '已自动执行' : '已创建建议工单', ...(lastError ? { lastError } : {}) };
  }

  function runNow(id, { manual = true } = {}) {
    let row = find(id);
    const slot = String(Math.floor(now() / 1000));
    try {
      const result = execute(row, { manual, slot });
      const tickets = result.tickets || [];
      row = {
        ...row,
        lastRunAt: nowIso(now),
        lastSlot: slot,
        lastTicketId: tickets[tickets.length - 1]?.id || row.lastTicketId || null,
        lastError: result.lastError || '',
        updatedAt: nowIso(now)
      };
      store.put(ROUTINE_KIND, row);
      return { routine: publicRow(row), ...result };
    } catch (error) {
      row = { ...row, lastRunAt: nowIso(now), lastError: String(error?.message || error).slice(0, 200), updatedAt: nowIso(now) };
      store.put(ROUTINE_KIND, row);
      throw error;
    }
  }

  function recordRun(row, slot) {
    try {
      const result = execute(row, { slot });
      const latest = store.get(ROUTINE_KIND, row.id) || row;
      const last = store.list('work-ticket').find(ticket => ticket.routineId === row.id);
      // 自动执行/停滞跟进失败时 execute 会带回原因；只有真正成功才清空 lastError。
      store.put(ROUTINE_KIND, { ...latest, lastRunAt: nowIso(now), lastTicketId: last?.id || latest.lastTicketId || null, lastError: result.lastError || '', updatedAt: nowIso(now) });
      return true;
    } catch (error) {
      store.put(ROUTINE_KIND, { ...row, lastRunAt: nowIso(now), lastError: String(error?.message || error).slice(0, 200), updatedAt: nowIso(now) });
      return false;
    }
  }

  function tick() {
    if (ticking) return { ran: 0 };
    ticking = true;
    let ran = 0;
    try {
      const stamp = now();
      for (const row of rows()) {
        if (!row.enabled) continue;
        // 单条例行任务的异常（项目被删、路径失效、监控读取失败）不能中断整轮，
        // 否则排在后面的例程每轮都会饿死。
        try {
          if (row.schedule?.kind === 'git' || row.schedule?.kind === 'file') {
            const project = engine.getProject(row.projectId);
            const signature = watchSignature(project.path, row.schedule);
            if (signature === row.watchHash) {
              if (row.watchPendingSince) store.put(ROUTINE_KIND, { ...row, watchPendingSince: null, updatedAt: nowIso(now) });
              continue;
            }
            const debounceMs = Number(row.schedule.debounceMs) || 0;
            const pending = row.watchPendingSince && row.watchPendingHash === signature ? row.watchPendingSince : 0;
            if (debounceMs && (!pending || stamp - pending < debounceMs)) {
              store.put(ROUTINE_KIND, { ...row, watchPendingSince: pending || stamp, watchPendingHash: signature, updatedAt: nowIso(now) });
              continue;
            }
            const advanced = { ...row, watchHash: signature, watchPendingSince: null, watchPendingHash: '', updatedAt: nowIso(now) };
            store.put(ROUTINE_KIND, advanced);
            if (recordRun(advanced, String(Math.floor(stamp / 1000)))) ran++;
            continue;
          }
          if (!row.nextAt || row.nextAt > stamp) continue;
          // 先推进 nextAt 再执行：即使执行慢或抛错，也不会在同一时间片重复触发。
          const advanced = { ...row, nextAt: nextAtFor(row.schedule, stamp), updatedAt: nowIso(now) };
          store.put(ROUTINE_KIND, advanced);
          if (recordRun(advanced, String(Math.floor(stamp / 1000)))) ran++;
        } catch (error) {
          try { store.put(ROUTINE_KIND, { ...row, lastError: String(error?.message || error).slice(0, 200), updatedAt: nowIso(now) }); } catch { /* 记录失败也要继续下一行。 */ }
        }
      }
    } finally {
      ticking = false;
    }
    return { ran };
  }

  function start() {
    if (timer) return stop;
    tick();
    timer = setInterval(() => { try { tick(); } catch { /* 定时器不允许异常冒泡。 */ } }, Math.max(5000, tickMs));
    timer.unref?.();
    return stop;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function findWebhook(token) {
    const value = typeof token === 'string' ? token.trim() : '';
    if (!value || value.length > 200) return null;
    const digest = Buffer.from(hashToken(value), 'hex');
    for (const row of rows()) {
      if (!row.enabled || row.schedule?.kind !== 'webhook' || !row.webhookHash) continue;
      const expected = Buffer.from(row.webhookHash, 'hex');
      if (expected.length === digest.length && timingSafeEqual(expected, digest)) return row;
    }
    return null;
  }

  function triggerWebhook(token, payload = {}) {
    const row = findWebhook(token);
    if (!row) throw workError('Webhook 令牌无效或已停用', 401);
    const note = payload && typeof payload === 'object' && typeof payload.text === 'string' ? payload.text.trim().slice(0, 1000) : '';
    let target = row;
    if (note) {
      // 触发内容只作为建议工单的补充说明，不执行外部传入的任意指令字段。
      target = { ...row, promptTemplate: `${row.promptTemplate || ''}${row.promptTemplate ? '\n\n' : ''}触发内容：${note}`.slice(0, PROMPT_MAX) };
    }
    const slot = String(Math.floor(now() / 1000));
    const result = execute(target, { manual: false, slot });
    const tickets = result.tickets || [];
    const next = { ...row, lastRunAt: nowIso(now), lastSlot: slot, lastTicketId: tickets[tickets.length - 1]?.id || row.lastTicketId || null, updatedAt: nowIso(now) };
    store.put(ROUTINE_KIND, next);
    return { routine: publicRow(next), ...result };
  }

  return {
    list: () => rows().map(publicRow),
    get: id => publicRow(find(id)),
    save,
    remove,
    runNow,
    tick,
    start,
    stop,
    triggerWebhook
  };
}
