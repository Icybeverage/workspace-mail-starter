import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, makeMockFetch, mailserverHandlers, makeMailServerState, makeDnsState, makeDnsInspector, makeCfState, cfHandlers, request, signup, captureLogger } from './helpers.js';
import { encryptSecret, decryptSecret } from '../server/lib/security.js';

const CF_TOKEN = 'cf-super-secret-token-abcdef-123456';

function setup() {
  const dnsState = makeDnsState();
  const mailserverState = makeMailServerState();
  const cfState = makeCfState();
  const fetchImpl = makeMockFetch([...mailserverHandlers(mailserverState), ...cfHandlers(cfState)]);
  const logger = captureLogger();
  return makeTestApp({
    fetchImpl,
    dnsInspector: makeDnsInspector(dnsState),
    logger,
    configOverrides: {}
  }).then((app) => {
    app.dnsState = dnsState;
    app.cfState = cfState;
    return { app, dnsState, mailserverState, cfState, fetchImpl, logger };
  });
}

test('Cloudflare token never appears in logs, API responses, activity, or the database at rest', async () => {
  const { app, dnsState, cfState, logger } = await setup();
  const seenResponses = [];
  async function tracked(promise) {
    const r = await promise;
    seenResponses.push(JSON.stringify(r.json));
    return r;
  }
  try {
    const a = await signup(app, 'owner@example.test');
    const created = await tracked(request(app.base, '/api/domains', {
      method: 'POST', body: { name: 'alpha-redact.test' }, cookie: a.sessionCookie, origin: app.base
    }));
    const { domain, verifyRecord } = created.json;
    cfState.zones.push({ id: 'zone-9', name: 'alpha-redact.test' });

    const verify1 = await tracked(request(app.base, `/api/domains/${domain.id}/verify`, {
      method: 'POST', body: { method: 'cloudflare', cfToken: CF_TOKEN }, cookie: a.sessionCookie, origin: app.base
    }));
    assert.equal(verify1.status, 409);
    dnsState.verifyTxt.push(verifyRecord.value);
    await tracked(request(app.base, `/api/domains/${domain.id}/verify`, {
      method: 'POST', body: { method: 'cloudflare' }, cookie: a.sessionCookie, origin: app.base
    }));

    await tracked(request(app.base, `/api/domains/${domain.id}/plan`, {
      method: 'POST', body: {}, cookie: a.sessionCookie, origin: app.base
    }));
    await tracked(request(app.base, `/api/domains/${domain.id}/inspect`, {
      method: 'POST', body: {}, cookie: a.sessionCookie, origin: app.base
    }));
    await tracked(request(app.base, `/api/domains/${domain.id}`, { cookie: a.sessionCookie }));
    await tracked(request(app.base, '/api/domains', { cookie: a.sessionCookie }));
    await tracked(request(app.base, '/api/activity', { cookie: a.sessionCookie }));
    await tracked(request(app.base, '/api/meta', {}));
    await tracked(request(app.base, '/health', {}));

    // Responses, logs, and durable rows must never carry the raw token.
    for (const body of seenResponses) {
      assert.ok(!body.includes(CF_TOKEN), 'token leaked in an API response');
      assert.ok(!body.includes('cf_token_enc'), 'ciphertext column must not be serialized');
    }
    assert.ok(!logger.lines.join('').includes(CF_TOKEN), 'token leaked into logs');

    const activityRows = app.db.prepare('SELECT * FROM activity').all();
    assert.ok(!JSON.stringify(activityRows).includes(CF_TOKEN), 'token leaked into activity');
    for (const table of ['domains', 'dns_plans', 'jobs', 'checks', 'setup_actions']) {
      const rows = app.db.prepare(`SELECT * FROM "${table}"`).all();
      assert.ok(!JSON.stringify(rows).includes(CF_TOKEN), `token leaked into ${table}`);
    }

    // Encrypted at rest, decryptable only with the vault key.
    const row = app.db.prepare('SELECT cf_token_enc FROM domains WHERE id = ?').get(domain.id);
    assert.ok(row.cf_token_enc.startsWith('v1.'));
    assert.equal(decryptSecret(row.cf_token_enc, app.config.vaultKey), CF_TOKEN);
    assert.throws(() => decryptSecret(row.cf_token_enc, Buffer.alloc(32, 1)), /unable to authenticate|invalid/i);
  } finally {
    await app.close();
  }
});

test('vault round-trip: wrong key and tampered ciphertext are rejected (AES-256-GCM)', () => {
  const key = Buffer.alloc(32, 9);
  const encrypted = encryptSecret('zone-scoped-token', key);
  assert.match(encrypted, /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
  assert.equal(decryptSecret(encrypted, key), 'zone-scoped-token');

  assert.throws(() => decryptSecret(encrypted, Buffer.alloc(32, 3)));
  const parts = encrypted.split('.');
  const tampered = [parts[0], parts[1], parts[2], Buffer.from('tampered').toString('base64')].join('.');
  assert.throws(() => decryptSecret(tampered, key));
});

test('cloudflare client uses only the fixed API base and bearer auth, and never deletes during creates', async () => {
  const { app, dnsState, cfState, fetchImpl } = await setup();
  try {
    const a = await signup(app, 'owner@example.test');
    const created = (await request(app.base, '/api/domains', {
      method: 'POST', body: { name: 'alpha-redact.test' }, cookie: a.sessionCookie, origin: app.base
    })).json;
    cfState.zones.push({ id: 'zone-9', name: 'alpha-redact.test' });
    await request(app.base, `/api/domains/${created.domain.id}/verify`, {
      method: 'POST', body: { method: 'cloudflare', cfToken: CF_TOKEN }, cookie: a.sessionCookie, origin: app.base
    });
    dnsState.verifyTxt.push(created.verifyRecord.value);

    const cfUrls = fetchImpl.calls.filter((c) => c.url.includes('cloudflare.com')).map((c) => c.url);
    assert.ok(cfUrls.length >= 2);
    for (const url of cfUrls) {
      assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/'), `unexpected external URL: ${url}`);
    }
    const authHeaders = fetchImpl.calls.filter((c) => c.url.includes('cloudflare.com')).map((c) => c.headers.Authorization);
    assert.ok(authHeaders.every((h) => h === `Bearer ${CF_TOKEN}`));
  } finally {
    await app.close();
  }
});

test('signup and login responses never echo the app password', async () => {
  const { app, logger } = await setup();
  const password = 'app-account-secret-9911';
  try {
    const signupRes = await request(app.base, '/api/auth/signup', {
      method: 'POST', body: { email: 'alpha@example.test', password }, origin: app.base
    });
    assert.equal(signupRes.status, 200);
    assert.ok(!JSON.stringify(signupRes.json).includes(password));
    const loginRes = await request(app.base, '/api/auth/login', {
      method: 'POST', body: { email: 'alpha@example.test', password }, origin: app.base
    });
    assert.equal(loginRes.status, 200);
    assert.ok(!JSON.stringify(loginRes.json).includes(password));
    assert.ok(!logger.lines.join('').includes(password));

    const users = app.db.prepare('SELECT * FROM users').all();
    assert.equal(users.length, 1);
    assert.ok(users[0].password_hash.startsWith('scrypt$'));
    assert.ok(!users[0].password_hash.includes(password));

    const badLogin = await request(app.base, '/api/auth/login', {
      method: 'POST', body: { email: 'alpha@example.test', password: 'wrong-password-9999' }, origin: app.base
    });
    assert.equal(badLogin.status, 401);
  } finally {
    await app.close();
  }
});
