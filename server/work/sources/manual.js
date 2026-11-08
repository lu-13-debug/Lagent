import { workError } from '../domain.js';
export function manualTrigger(input = {}) {
  if (typeof input?.text !== 'string' || !input.text.trim() || input.text.length > 3000) throw workError('指令须为1至3000字');
  if (input.clientRequestId !== undefined && (typeof input.clientRequestId !== 'string' || !input.clientRequestId.trim() || input.clientRequestId.length > 120)) throw workError('请求ID无效');
  return { source:'manual', text:input.text.trim(), clientRequestId:input.clientRequestId };
}
