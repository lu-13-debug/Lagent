// 兼容门面：规则已移到 server/application/ticket/model.js。
// 现有代码继续 import './domain.js'，等 Phase 3 拆 engine 时再逐批改为直接引用内层。
export * from '../application/ticket/model.js';
