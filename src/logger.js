// Structured JSON logs. Anything that looks like a credential is redacted before printing.
const SECRET_KEYS = /token|secret|password|authorization|hmac|cookie|^code$/i;
const SECRET_VALUES = /\b(shpat|shpca|shppa|shpss|shpua)_[A-Za-z0-9]+/g;

function redact(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(SECRET_VALUES, '[redacted]');
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? '[redacted]' : redact(item, depth + 1)]));
  }
  return value;
}

function write(level, message, fields = {}) {
  if (process.env.LOG_SILENT === '1' && level !== 'error') return;
  const entry = { time: new Date().toISOString(), level, message, ...redact(fields) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(entry));
}

export const log = {
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields)
};

export { redact };
