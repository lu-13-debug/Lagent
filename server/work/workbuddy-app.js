import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

// WorkBuddy 桌面端是 Electron 应用，没有对外命令行；Lagent 通过 Chromium 调试端口
// 驱动它的会话界面。这里只负责找到 WorkBuddy.exe，供执行器与 Agent 探测共用。

let cached = null;

function readShortcutTarget(lnk) {
  if (process.platform !== 'win32' || !existsSync(lnk)) return '';
  try {
    const quoted = lnk.replace(/'/g, "''");
    const script = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${quoted}');$s.TargetPath`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 4000,
      encoding: 'utf8',
      windowsHide: true
    });
    const target = String(output || '').trim().split(/\r?\n/).pop() || '';
    return /WorkBuddy\.exe$/i.test(target) ? target : '';
  } catch {
    return '';
  }
}

function candidatePaths(env) {
  const programFiles = env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    env.LAGENT_WORKBUDDY_EXE,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'WorkBuddy', 'WorkBuddy.exe') : '',
    path.join(programFiles, 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(programFilesX86, 'WorkBuddy', 'WorkBuddy.exe'),
    'D:\\workbuddy\\WorkBuddy.exe'
  ].filter(Boolean);
}

function shortcutPaths(env) {
  return [
    env.APPDATA ? path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WorkBuddy.lnk') : '',
    env.ProgramData ? path.join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WorkBuddy.lnk') : ''
  ].filter(Boolean);
}

export function resolveWorkbuddyExe(env = process.env) {
  if (cached && cached.env === env) return cached.path;
  let resolved = '';
  for (const candidate of candidatePaths(env)) {
    if (candidate && existsSync(candidate)) { resolved = path.resolve(candidate); break; }
  }
  if (!resolved) {
    for (const lnk of shortcutPaths(env)) {
      const target = readShortcutTarget(lnk);
      if (target) { resolved = path.resolve(target); break; }
    }
  }
  cached = { env, path: resolved };
  return resolved;
}

export function resetWorkbuddyExeCache() {
  cached = null;
}
