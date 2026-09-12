import express from 'express';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, generateToken, sha256Hex } from '../lib/security.js';
import { buildSessionCookie, buildClearSessionCookie, ok, fail, requireAuth, rateLimit, SESSION_COOKIE, parseCookies } from '../lib/http.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

function createSession(db, config, req, res, userId) {
  const token = generateToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  db.prepare(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), userId, sha256Hex(token), now.toISOString(), expiresAt.toISOString(), now.toISOString(),
      req.ip || null, String(req.headers['user-agent'] || '').slice(0, 300));
  res.set('Set-Cookie', buildSessionCookie(token, config, { secure: req.secure || config.isProd }));
}

export function authRoutes({ db, config, limiter }) {
  const router = express.Router();

  router.post('/signup', rateLimit(limiter, 'signup', config.rateLimits.signup), async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return fail(res, 400, 'invalid_email', 'Enter a valid email address for your app account.');
    }
    if (password.length < 10) {
      return fail(res, 400, 'weak_password', 'App account password must be at least 10 characters.');
    }
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      return fail(res, 409, 'email_taken', 'An account with this email already exists. Sign in instead.');
    }
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    db.prepare('INSERT INTO users (id, email, password_hash, is_admin, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(userId, email, await hashPassword(password), now);
    createSession(db, config, req, res, userId);
    return ok(res, {
      user: { id: userId, email, createdAt: now },
      notes: {
        identity: 'This app account is separate from any mailbox credentials you create later.',
        emailRecovery: 'Email-based password recovery is not implemented. Keep your password safe — there is no reset flow yet.'
      }
    });
  });

  router.post('/login', rateLimit(limiter, 'login', config.rateLimits.login), async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const valid = user ? await verifyPassword(password, user.password_hash) : false;
    if (!valid) {
      await new Promise((r) => setTimeout(r, 250));
      return fail(res, 401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    createSession(db, config, req, res, user.id);
    return ok(res, { user: { id: user.id, email: user.email, createdAt: user.created_at } });
  });

  router.post('/logout', requireAuth(db), (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SESSION_COOKIE]) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(cookies[SESSION_COOKIE]));
    }
    db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
    res.set('Set-Cookie', buildClearSessionCookie(config, { secure: req.secure || config.isProd }));
    return ok(res, {});
  });

  router.get('/me', requireAuth(db), (req, res) => {
    const user = db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(req.user.id);
    return ok(res, { user: { id: user.id, email: user.email, createdAt: user.created_at } });
  });

  return router;
}
