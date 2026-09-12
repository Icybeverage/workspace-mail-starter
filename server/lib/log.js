const SECRET_KEY_RE = /(password|passwd|secret|token|authorization|api[_-]?key|credential|cookie|vault)/i;

export function redactValue(key, value, depth = 0) {
  if (SECRET_KEY_RE.test(key)) return '[redacted]';
  if (depth > 4) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && /(bearer\s+[a-z0-9._-]{8,}|eyJ[a-zA-Z0-9_-]{10,}\.)/i.test(value)) return '[redacted]';
  return value;
}

export function redactRecord(fields = {}) {
  return redactValue('', fields, 0);
}

export function createLogger({ name = 'workspace', stream = process.stdout, enabled = true } = {}) {
  function emit(level, msg, fields = {}) {
    if (!enabled) return;
    const entry = {
      t: new Date().toISOString(),
      level,
      logger: name,
      msg,
      ...redactValue('', fields, 0)
    };
    try {
      stream.write(`${JSON.stringify(entry)}\n`);
    } catch {
      // logging must never crash the app
    }
  }
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (childName) => createLogger({ name: `${name}:${childName}`, stream, enabled })
  };
}

export const silentLogger = createLogger({ enabled: false });
