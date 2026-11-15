import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// package.json 是版本的唯一来源：运行时接口、对外 UA、备份元数据都从这里取，避免发布版本不一致。
export const APP_VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version;
