import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, makeConfig, request, signup, extractCookie } from './helpers.js';

test('signup creates a session with secure cookie attributes', async (t) => {
  const app = await makeTestApp();
  t.after(() => app.close());

  const r = await signup(app, 'owner@example.test');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const cookie = r.cookie;
  assert.match(cookie, /workspace_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/launch/);
  assert.doesNotMatch(cookie, /Secure/);

  const me = await request(app.base, '/api/auth/me', { cookie: extractCookie(cookie) });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, 'owner@example.test');
});

test('production config marks the session cookie Secure', async (t) => {
  const app = await makeTestApp({ configOverrides: { nodeEnv: 'production', isProd: true } });
  t.after(() => app.close());
  const r = await request(app.base, '/api/auth/signup', { method: 'POST', body: { email: 'prod@example.test', password: 'password12345' }, origin: app.base });
  assert.match(r.cookie, /Secure/);
});

test('passwords are scrypt-hashed, never stored in plaintext', async (t) => {
  const app = await makeTestApp();
  t.after(() => app.close());
  await signup(app, 'hash@example.test', 'secret-password-99');
  const row = app.db.prepare('SELECT password_hash FROM users WHERE email = ?').get('hash@example.test');
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes('secret-password-99'));
});

test('login rejects wrong password and accepts the right one; logout invalidates', async (t) => {
  const app = await makeTestApp();
  t.after(() => app.close());
  await signup(app, 'log@example.test', 'password12345');

  const bad = await request(app.base, '/api/auth/login', { method: 'POST', body: { email: 'log@example.test', password: 'wrong-password' }, origin: app.base });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'invalid_credentials');

  const good = await request(app.base, '/api/auth/login', { method: 'POST', body: { email: 'log@example.test', password: 'password12345' }, origin: app.base });
  assert.equal(good.status, 200);
  const cookie = extractCookie(good.cookie);

  const out = await request(app.base, '/api/auth/logout', { method: 'POST', body: {}, cookie, origin: app.base });
  assert.equal(out.status, 200);
  const me = await request(app.base, '/api/auth/me', { cookie });
  assert.equal(me.status, 401);
});

test('signup validation: bad email, weak password, duplicate email', async (t) => {
  const app = await makeTestApp();
  t.after(() => app.close());
  const badEmail = await request(app.base, '/api/auth/signup', { method: 'POST', body: { email: 'not-an-email', password: 'password12345' }, origin: app.base });
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.json.error.code, 'invalid_email');

  const weak = await request(app.base, '/api/auth/signup', { method: 'POST', body: { email: 'weak@example.test', password: 'short' }, origin: app.base });
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error.code, 'weak_password');

  await signup(app, 'dupe@example.test');
  const dupe = await request(app.base, '/api/auth/signup', { method: 'POST', body: { email: 'dupe@example.test', password: 'password12345' }, origin: app.base });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.json.error.code, 'email_taken');
});

test('CSRF: cross-origin writes are rejected, same-origin and headerless clients pass', async (t) => {
  const app = await makeTestApp();
  t.after(() => app.close());
  const session = await signup(app, 'csrf@example.test');
  const cookie = session.sessionCookie;

  const cross = await request(app.base, '/api/domains', { method: 'POST', body: { name: 'evil.example' }, cookie, origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error.code, 'csrf_origin_mismatch');

  const crossFetch = await request(app.base, '/api/domains', { method: 'POST', body: { name: 'evil2.example' }, cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossFetch.status, 403);

  const sameOrigin = await request(app.base, '/api/domains', { method: 'POST', body: { name: 'good.example' }, cookie, origin: app.base });
  assert.equal(sameOrigin.status, 200);

  const noOrigin = await request(app.base, '/api/domains', { method: 'POST', body: { name: 'good2.example' }, cookie });
  assert.equal(noOrigin.status, 200);
});

test('unauthenticated writes are rejected', async (t) => {
  const app = await makeTestApp();
  t.after(() => app.close());
  const r = await request(app.base, '/api/domains', { method: 'POST', body: { name: 'x.example' }, origin: app.base });
  assert.equal(r.status, 401);
  const noCookieMailbox = await request(app.base, '/api/mailboxes', { method: 'POST', body: { domainId: 'dom_hosted', localPart: 'a', password: 'password12345' }, origin: app.base });
  assert.equal(noCookieMailbox.status, 401);
});

test('rate limiting kicks in for repeated logins', async (t) => {
  const rateLimits = { ...makeConfig().rateLimits, login: { limit: 3, windowMs: 60000 } };
  const app = await makeTestApp({ configOverrides: { rateLimits } });
  t.after(() => app.close());
  await signup(app, 'limit@example.test', 'password12345');
  let last;
  for (let i = 0; i < 4; i += 1) {
    last = await request(app.base, '/api/auth/login', { method: 'POST', body: { email: 'limit@example.test', password: 'nope-nope-nope' }, origin: app.base });
  }
  assert.equal(last.status, 429);
  assert.equal(last.json.error.code, 'rate_limited');
  assert.ok(last.headers.get('retry-after'));
});
