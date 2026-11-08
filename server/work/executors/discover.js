import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function findOnPath(command, environment, extensions = ['.exe']) {
  const value = environment.PATH ?? environment.Path ?? environment.path ?? '';
  const names = process.platform === 'win32' ? extensions.flatMap(extension => [`${command}${extension}`, `${command}${extension.toLowerCase()}`]) : [command];
  for (const entry of value.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    for (const name of new Set(names)) {
      const candidate = path.join(directory, name);
      if (existingFile(candidate)) return candidate;
    }
  }
  return null;
}

function existingFile(candidate) {
  try { return typeof candidate === 'string' && existsSync(candidate) && !candidate.endsWith(path.sep) ? candidate : null; }
  catch { return null; }
}

export function findCodexBinary(environment = process.env) {
  const explicit = existingFile(environment.DATAAGENT_CODEX_CLI);
  if (explicit) return explicit;
  const aliasRoot = environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : null;
  const onPath = findOnPath('codex', environment);
  if (onPath) return onPath;
  if (!aliasRoot) return null;
  let packages = [];
  try { packages = readdirSync(aliasRoot).filter(name => /^OpenAI\.Codex_/i.test(name)); } catch { return null; }
  for (const packageDir of packages.sort().reverse()) {
    const alias = path.join(aliasRoot, packageDir, 'chatgpt-desktop.exe');
    let target = null;
    try { target = readlinkSync(alias); } catch { continue; }
    const candidate = path.join(path.dirname(target), 'resources', 'codex.exe');
    if (existingFile(candidate)) return candidate;
  }
  return null;
}

export function findClaudeCodeCli(environment = process.env) {
  const explicit = existingFile(environment.DATAAGENT_CLAUDE_CLI);
  if (explicit) return { binary: explicit, prefix: [] };
  const onPath = findOnPath('claude', environment);
  if (onPath) return { binary: onPath, prefix: [] };
  const roots = [environment.APPDATA && path.join(environment.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), environment.APPDATA && path.join(environment.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')];
  for (const candidate of roots) {
    if (existingFile(candidate)) return candidate.endsWith('.js') ? { binary: process.execPath, prefix: [candidate] } : { binary: candidate, prefix: [] };
  }
  return null;
}
