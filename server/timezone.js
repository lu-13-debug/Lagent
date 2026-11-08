const DEFAULT = Object.freeze({ name: 'Asia/Shanghai', offsetMinutes: 480 });
const MAX_OFFSET_MINUTES = 14 * 60;
const PRESETS = new Map([
  ['asia/shanghai', DEFAULT],
  ['utc', { name: 'UTC', offsetMinutes: 0 }],
  ['gmt', { name: 'UTC', offsetMinutes: 0 }],
]);

export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function offsetSuffix(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function parseTimezone(input) {
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return null;
    const preset = PRESETS.get(text.toLowerCase());
    if (preset) return preset;
    const match = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(text);
    if (match) {
      const hours = Number(match[2]), minutes = Number(match[3] || 0);
      if (minutes < 60) {
        const total = hours * 60 + minutes;
        if (total <= MAX_OFFSET_MINUTES) {
          const offsetMinutes = (match[1] === '-' ? -1 : 1) * total;
          return { name: formatOffset(offsetMinutes), offsetMinutes };
        }
      }
    }
    return null;
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const offset = input.offsetMinutes;
    if (Number.isInteger(offset) && Math.abs(offset) <= MAX_OFFSET_MINUTES) {
      const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : formatOffset(offset);
      return { name, offsetMinutes: offset };
    }
    if (typeof input.name === 'string') return parseTimezone(input.name);
  }
  return null;
}

export function normalizeTimezone(input, { strict = false, legacyAt, source = 'user', assumed = false } = {}) {
  const declaredAt = new Date(legacyAt || Date.now()).toISOString();
  if (input === undefined || input === null || input === '') return { ...DEFAULT, source: 'default', assumed: true, declaredAt };
  const parsed = parseTimezone(input);
  if (!parsed) {
    if (strict) throw new Error('时区须为 Asia/Shanghai、UTC 或 UTC±HH:MM');
    return { ...DEFAULT, source: 'default', assumed: true, declaredAt };
  }
  const stored = input && typeof input === 'object' && !Array.isArray(input);
  return {
    ...parsed,
    source: stored && ['user', 'default', 'detected'].includes(input.source) ? input.source : source,
    assumed: stored && typeof input.assumed === 'boolean' ? input.assumed : assumed,
    declaredAt: stored && typeof input.declaredAt === 'string' && Number.isFinite(Date.parse(input.declaredAt)) ? input.declaredAt : declaredAt,
  };
}

export function timezoneMinutes(timezone) {
  const offset = timezone?.offsetMinutes;
  return Number.isInteger(offset) && Math.abs(offset) <= MAX_OFFSET_MINUTES ? offset : DEFAULT.offsetMinutes;
}

export function timezoneLabel(timezone) {
  const name = timezone?.name || DEFAULT.name;
  return `${name}${timezone?.assumed ? '（未确认）' : ''}`;
}

export function timezoneCaption(timezone) {
  const name = timezone?.name || DEFAULT.name;
  const offset = formatOffset(timezoneMinutes(timezone));
  return name === offset ? offset : `${name}（${offset}）`;
}

export const DEFAULT_TIMEZONE = DEFAULT;
export const MAX_TIMEZONE_OFFSET = MAX_OFFSET_MINUTES;
