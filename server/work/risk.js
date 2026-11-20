// 兼容门面：审批预览已移到 server/application/ticket/preview.js，
// 脱敏已移到 server/platform/redact.js。现有 import 保持不变。
export * from '../application/ticket/preview.js';
export * from '../platform/redact.js';
