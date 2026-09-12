import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, makeMockFetch, mailserverHandlers, makeMailServerState, makeDnsState, makeDnsInspector, makeCfState, cfHandlers, request, signup } from './helpers.js';
import { decryptSecret } from '../server/lib/security.js';

function setup({ mailserverState = makeMailServerState(), cfState = makeCfState() } = {}) {
  const dnsState = makeDnsState();
  const fetchImpl = makeMockFetch([...mailserverHandlers(mailserverState), ...cfHandlers(cfState)]);
  return makeTestApp({
    fetchImpl,
    dnsInspector: makeDnsInspector(dnsState),
    configOverrides: {}
  }).then((app) => ({ app, dnsState, mailserverState, cfState, fetchImpl }));
}

async function createDomain(app, cookie, name) {
  const r = await request(app.base, '/api/domains', {
    method: 'POST', body: { name }, cookie, origin: app.base
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

test('DNS TXT ownership: wrong and missing records fail, matching record verifies', async () => {
  const { app, dnsState } = await setup();
  try {
    const a = await signup(app, 'owner@example.test');
    const { domain, verifyRecord } = await createDomain(app, a.sessionCookie, 'alpha-own.test');
    assert.equal(domain.status, 'ownership_pending');
    assert.equal(verifyRecord.type, 'TXT');
    assert.equal(verifyRecord.name, '_workspace-verify.alpha-own.test');
    assert.match(verifyRecord.value, /^workspace-verify=/);

    // No record at all.
    const missing = await request(app.base, `/api/domains/${domain.id}/verify`, {
      method: 'POST', body: { method: 'dns' }, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(missing.status, 409);
    assert.equal(missing.json.error.code, 'verification_failed');
    assert.equal(missing.json.error.verifyRecord.name, '_workspace-verify.alpha-own.test');

    // Wrong value.
    dnsState.verifyTxt.push('workspace-verify=not-the-right-token');
    const wrong = await request(app.base, `/api/domains/${domain.id}/verify`, {
      method: 'POST', body: { method: 'dns' }, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.error.code, 'verification_failed');

    // Matching value (exact string).
    dnsState.verifyTxt.push(verifyRecord.value);
    const good = await request(app.base, `/api/domains/${domain.id}/verify`, {
      method: 'POST', body: { method: 'dns' }, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(good.status, 200, JSON.stringify(good.json));
    assert.equal(good.json.domain.status, 'verified');
    assert.equal(good.json.domain.ownershipMethod, 'dns_txt');
    assert.equal(good.json.domain.verifyRecord, null);

    // Idempotent re-verify.
    const again = await request(app.base, `/api/domains/${domain.id}/verify`, {
      method: 'POST', body: { method: 'dns' }, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.alreadyVerified, true);
  } finally {
    await app.close();
  }
});

test('mailboxes cannot be created on an unverified custom domain', async () => {
  const { app, mailserverState, fetchImpl } = await setup();
  try {
    const a = await signup(app, 'owner@example.test');
    const { domain } = await createDomain(app, a.sessionCookie, 'alpha-own.test');
    const r = await request(app.base, '/api/mailboxes', {
      method: 'POST',
      body: { domainId: domain.id, localPart: 'sales', password: 'long-enough-pw' },
      cookie: a.sessionCookie,
      origin: app.base
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'ownership_required');
    assert.equal(mailserverState.users.length, 0);
    assert.equal(fetchImpl.callsTo('/mail/users').length, 0);
  } finally {
    await app.close();
  }
});

test('Cloudflare ownership: writes TXT, reports propagation pending, then verifies via stored encrypted token', async () => {
  const { app, dnsState, cfState } = await setup();
  const cfToken = 'cf-secret-token-XYZ-42';
  try {
    const a = await signup(app, 'owner@example.test');
    const { domain, verifyRecord } = await createDomain(app, a.sessionCookie, 'beta-own.test');
    cfState.zones.push({ id: 'zone-1', name: 'beta-own.test' });

    const verified = await request(app.base, `/api/domains/${domain.id}/verify`, {
      method: 'POST', body: { method: 'cloudflare', cfToken }, cookie: a.sessionCookie, origin: app.base
    });
    // The TXT record was written to Cloudflare but is not visible via DNS yet.
    assert.equal(verified.status, 409, JSON.stringify(verified.json));
    assert.equal(verified.json.error.code, 'propagation_pending');

    const txtRecords = [...cfState.records.values()].filter((r) => r.type === 'TXT');
    assert.equal(txtRecords.length, 1);
    assert.equal(txtRecords[0].name, '_workspace-verify.beta-own.test');
    assert.equal(txtRecords[0].content, verifyRecord.value);

    // Token is stored encrypted, never plaintext, and decrypts with the vault key.
    const row = app.db.prepare('SELECT cf_token_enc, cf_zone_id, cf_zone_name FROM domains WHERE id = ?').get(domain.id);
    assert.ok(row.cf_token_enc);
    assert.ok(!row.cf_token_enc.includes(cfToken));
    assert.match(row.cf_token_enc, /^v1\./);
    assert.equal(decryptSecret(row.cf_token_enc, app.config.vaultKey), cfToken);

    // TXT now visible: verify again without re-pasting the token (uses the stored one).
    dnsState.verifyTxt.push(verifyRecord.value);
    const second = await request(app.base, `/api/domains/${domain.id}/verify`, {
      method: 'POST', body: { method: 'cloudflare' }, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.domain.status, 'verified');
    assert.equal(second.json.domain.ownershipMethod, 'cloudflare_txt');

    // The second pass recognized the existing TXT and did not duplicate it.
    const creates = cfState.calls.filter((c) => c.op === 'create');
    assert.equal(creates.length, 1);
  } finally {
    await app.close();
  }
});

test('Cloudflare ownership: invalid token and unknown zone fail cleanly with no writes', async () => {
  const { app, cfState } = await setup();
  try {
    const a = await signup(app, 'owner@example.test');
    const { domain } = await createDomain(app, a.sessionCookie, 'gamma-own.test');

    cfState.tokenValid = false;
    const bad = await request(app.base, `/api/domains/${domain.id}/verify`, {
      method: 'POST', body: { method: 'cloudflare', cfToken: 'bad-token' }, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'cf_token_invalid');
    assert.equal(cfState.calls.length, 0);

    cfState.tokenValid = true; // zone list stays empty
    const noZone = await request(app.base, `/api/domains/${domain.id}/verify`, {
      method: 'POST', body: { method: 'cloudflare', cfToken: 'good-token' }, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(noZone.status, 400);
    assert.equal(noZone.json.error.code, 'cf_zone_not_found');
    assert.equal(cfState.calls.length, 0);

    const row = app.db.prepare('SELECT cf_token_enc FROM domains WHERE id = ?').get(domain.id);
    assert.equal(row.cf_token_enc, null, 'no token stored when verification fails');
  } finally {
    await app.close();
  }
});
