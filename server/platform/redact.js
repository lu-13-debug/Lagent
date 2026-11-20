// 纯技术：把文本里的凭据抹掉。不认识业务概念，供内层预览与外层日志复用。

const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|password|passwd|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_\-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-]{8,}\b/gi
];
const META = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function redactSecrets(value) {
  let output = String(value || '').replace(META, ' ');
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[已隐藏凭据]');
  return output;
}

export function redactPreview(value, max = 500) {
  const output = redactSecrets(value).replace(/\s+/g, ' ').trim();
  return output.length > max ? `${output.slice(0, max)}…` : output;
}
