import { sha256Hex } from './security.js';

export const SESSION_COOKIE = 'workspace_session';

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

export function buildSessionCookie(token, config, { secure = null } = {}) {
  const maxAgeSec = Math.floor((config.sessionTtlDays * 24 * 60 * 60));
  const useSecure = secure === null ? config.isProd : secure;
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    `Path=${config.basePath || '/'}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`
  ];
  if (useSecure) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearSessionCookie(config, { secure = null } = {}) {
  const useSecure = secure === null ? config.isProd : secure;
  const attrs = [`${SESSION_COOKIE}=`, `Path=${config.basePath || '/'}`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (useSecure) attrs.push('Secure');
  return attrs.join('; ');
}

export function ok(res, data = {}) {
  return res.json({ ok: true, ...data });
}

export function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, error: { code, message, ...extra } });
}

export function requireAuth(db) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) return fail(res, 401, 'unauthenticated', 'Sign in to continue.');
    const tokenHash = sha256Hex(token);
    const row = db.prepare(`
      SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(tokenHash);
    if (!row) return fail(res, 401, 'unauthenticated', 'Session is invalid or expired. Sign in again.');
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
      return fail(res, 401, 'session_expired', 'Session expired. Sign in again.');
    }
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), row.session_id);
    req.user = { id: row.user_id, email: row.email };
    req.sessionId = row.session_id;
    req.sessionToken = token;
    next();
  };
}

function originAllowed(origin, req, config) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = String(req.headers.host || '').toLowerCase();
  if (!config.appOrigin && parsed.origin.toLowerCase() === `${req.protocol}://${host}`) return true;
  if (config.appOrigin) {
    try {
      if (new URL(config.appOrigin).origin.toLowerCase() === parsed.origin.toLowerCase()) return true;
    } catch { /* ignore malformed config */ }
  }
  for (const extra of config.extraOrigins || []) {
    if (extra.toLowerCase() === parsed.origin.toLowerCase()) return true;
  }
  return false;
}

// CSRF defense: browsers attach Origin to cross-site writes, so a mismatched Origin
// is rejected outright; requests without Origin are non-browser clients that gain
// nothing from ambient cookies. SameSite=Lax remains the primary defense.
export function sameOriginGuard(config) {
  return (req, res, next) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (origin) {
      if (originAllowed(origin, req, config)) return next();
      return fail(res, 403, 'csrf_origin_mismatch', 'Request origin is not allowed.');
    }
    const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (secFetchSite === 'cross-site') {
      return fail(res, 403, 'csrf_cross_site', 'Cross-site writes are not allowed.');
    }
    return next();
  };
}

export class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  consume(key, { limit, windowMs }) {
    const now = Date.now();
    const hits = (this.buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
      const retryAfterMs = windowMs - (now - hits[0]);
      this.buckets.set(key, hits);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    hits.push(now);
    this.buckets.set(key, hits);
    return { ok: true, remaining: limit - hits.length };
  }

  sweep() {
    const now = Date.now();
    const maxWindow = 60 * 60 * 1000;
    for (const [key, hits] of this.buckets) {
      const alive = hits.filter((t) => now - t < maxWindow);
      if (alive.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, alive);
    }
  }
}

export function rateLimit(limiter, bucketName, { by = 'ip', limit, windowMs } = {}) {
  return (req, res, next) => {
    const cfg = { limit, windowMs };
    const subject = by === 'tenant' ? (req.user ? req.user.id : 'anon') : req.ip;
    const result = limiter.consume(`${bucketName}:${subject}`, cfg);
    if (!result.ok) {
      res.set('Retry-After', String(result.retryAfterSec));
      return fail(res, 429, 'rate_limited', `Too many requests. Try again in ${result.retryAfterSec}s.`);
    }
    next();
  };
}

export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
