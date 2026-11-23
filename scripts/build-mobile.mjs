#!/usr/bin/env node
// 构建 Android 外壳 APK。需要 JDK 17+、Android SDK（platform 34 / build-tools 34.0.0）和 Gradle 8.9。
// 用法：npm run mobile:build
//   GRADLE_BIN 指定 gradle 可执行文件；ANDROID_HOME / ANDROID_SDK_ROOT 指定 SDK 目录。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const project = join(root, 'mobile', 'android');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
const gradle = process.env.GRADLE_BIN || (process.platform === 'win32' ? 'gradle.bat' : 'gradle');

if (!existsSync(project)) {
  console.error(`找不到 Android 工程：${project}`);
  process.exit(1);
}
if (!sdk || !existsSync(sdk)) {
  console.error('没有找到 Android SDK。请安装后设置 ANDROID_HOME，例如：');
  console.error('  export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"');
  process.exit(1);
}

const task = process.argv.includes('--debug') ? 'assembleDebug' : 'assembleRelease';
console.log(`使用 Gradle: ${gradle}`);
console.log(`使用 SDK: ${sdk}`);
console.log(`构建任务: ${task}`);

const result = spawnSync(gradle, ['-p', project, task, '--console=plain'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk }
});
if (result.error) {
  console.error(`启动 Gradle 失败：${result.error.message}`);
  console.error('可以用 GRADLE_BIN 指定 gradle 路径。');
  process.exit(1);
}
process.exit(result.status ?? 1);
