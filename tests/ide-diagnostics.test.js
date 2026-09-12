import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailServerClient, normalizeMailServerUsers } from '../server/services/mailserver.js';
import { dkimDiagnosis } from '../server/services/dns.js';
import {
  makeTestApp,
  makeMockFetch,
  mailserverHandlers,
  makeMailServerState,
  makeDnsState,
  makeDnsInspector,
  request,
  signup
} from './helpers.js';

// ---------------------------------------------------------------------------
// MAIL_SERVER listUsers hardening: a malformed successful response must fail closed.
// ---------------------------------------------------------------------------

function mailserverClientWithBody(rawBody, status = 200) {
  return createMailServerClient({
    config: { mailserver: { baseUrl: 'https://mailserver.test/admin', username: 'admin', password: 'mailserver-secret', timeoutMs: 200 } },
    fetchImpl: async () => new Response(rawBody, { status, headers: { 'content-type': 'application/json' } })
  });
}

const GROUPED_LISTING = [{
  domain: 'example.test',
  users: [
    { email: 'Launch-Test@example.test', privileges: [], box_quota: 536870912, box_size: '2.9K', percent: '  0%', quota: '512M', status: 'active' },
    { email: 'other@example.test', privileges: [] }
  ]
}];

test('normalizeMailServerUsers accepts the verified grouped v76 shape and the legacy flat shape', () => {
  const grouped = normalizeMailServerUsers(GROUPED_LISTING);
  assert.equal(grouped.ok, true);
  assert.equal(grouped.users.length, 2);
  assert.equal(grouped.users[0].email, 'Launch-Test@example.test');

  const flat = normalizeMailServerUsers([{ email: 'a@example.test', privileges: [] }, { email: 'b@example.test' }]);
  assert.equal(flat.ok, true);
  assert.equal(flat.users.length, 2);

  // Mixed grouped + flat entries flatten the same way the client always did.
  const mixed = normalizeMailServerUsers([{ domain: 'x.test', users: [{ email: 'a@x.test' }] }, { email: 'b@y.test' }]);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.users.length, 2);
});

test('normalizeMailServerUsers keeps empty arrays and empty groups valid', () => {
  assert.deepEqual(normalizeMailServerUsers([]), { ok: true, users: [] });
  const emptyGroups = normalizeMailServerUsers([{ domain: 'example.test', users: [] }, { domain: 'other.test', users: [] }]);
  assert.deepEqual(emptyGroups, { ok: true, users: [] });
});

test('normalizeMailServerUsers rejects non-array bodies instead of treating them as an empty list', () => {
  for (const body of [null, { users: [] }, { error: 'unexpected' }, 'not-an-array', 42]) {
    const result = normalizeMailServerUsers(body);
    assert.equal(result.ok, false, `body ${JSON.stringify(body)} must be rejected`);
    assert.match(result.error, /unrecognized user list/i);
  }
});

test('normalizeMailServerUsers rejects invalid entries and users instead of dropping them silently', () => {
  for (const body of [
    ['plain-string-entry'],
    [null],
    [[{ email: 'nested@x.test' }]],
    [{ email: 'valid@x.test' }, { noEmail: true }],
    [{ email: '' }],
    [{ email: 'not-an-email' }],
    [{ email: 'missing-domain@' }],
    [{ email: 123 }]
  ]) {
    const result = normalizeMailServerUsers(body);
    assert.equal(result.ok, false, `body ${JSON.stringify(body)} must be rejected`);
    assert.match(result.error, /treated as unavailable|valid email/i);
  }
});

test('listUsers maps grouped users with the Qoder Workspace storage fields intact', async () => {
  const mailserver = mailserverClientWithBody(JSON.stringify(GROUPED_LISTING));
  const res = await mailserver.listUsers();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.users.length, 2);
  const user = res.users[0];
  assert.equal(user.email, 'launch-test@example.test');
  assert.deepEqual(user.privileges, []);
  assert.equal(user.boxQuotaBytes, 536870912);
  assert.equal(user.boxSize, '2.9K');
  assert.equal(user.percentText, '  0%');
  assert.equal(user.quotaText, '512M');
  assert.equal(user.status, 'active');
  // A user without storage fields stays valid; the display fields degrade to null.
  const bare = res.users[1];
  assert.equal(bare.email, 'other@example.test');
  assert.equal(bare.boxQuotaBytes, null);
  assert.equal(bare.boxSize, null);
});

test('mailbox collision lookup normalizes the whitespace accepted by user-list validation', async () => {
  const mailserver = mailserverClientWithBody(JSON.stringify([{ email: ' Existing@example.test ' }]));
  const result = await mailserver.userExists('existing@example.test');
  assert.equal(result.ok, true);
  assert.equal(result.exists, true);
});

test('a successful HTTP response with a malformed body becomes unavailable, never an empty user list', async () => {
  for (const raw of [
    '<html><body>admin login</body></html>', // non-JSON 200 (e.g. auth page)
    'null', // JSON null
    JSON.stringify({ status: 'ok', users: 'garbage' }) // JSON object, not an array
  ]) {
    const mailserver = mailserverClientWithBody(raw);
    const listed = await mailserver.listUsers();
    assert.equal(listed.ok, false, `raw body ${raw.slice(0, 40)} must not yield a usable list`);
    assert.equal(listed.configured, true);
    assert.deepEqual(listed.users, []);
    assert.match(listed.error, /unrecognized user list|invalid entry|valid email/i);

    const exists = await mailserver.userExists('launch-test@example.test');
    assert.equal(exists.ok, false, 'an unusable listing must never claim exists:false');
    assert.equal(exists.exists, undefined);
  }
});

test('a partially valid listing with one corrupt entry is rejected whole, not partially trusted', async () => {
  // The colliding address is visible in the body, but the corrupt entry makes the
  // whole listing untrustworthy: accepting the valid subset could hide others.
  const mailserver = mailserverClientWithBody(JSON.stringify([
    { domain: 'example.test', users: [{ email: 'launch-test@example.test', privileges: [] }] },
    'corrupt-entry'
  ]));
  const res = await mailserver.listUsers();
  assert.equal(res.ok, false);
  assert.deepEqual(res.users, []);
});

test('malformed successful user listing blocks mailbox creation instead of permitting a collision', async () => {
  // Before the fix this 200 body flattened to "no users", the collision check
  // passed, and creation proceeded over unknown existing mailboxes.
  const fetchImpl = makeMockFetch([
    {
      match: (u, m) => m === 'GET' && u.includes('/mail/users'),
      handle: async () => ({ body: { status: 'ok', users: 'garbage' } })
    },
    {
      match: (u, m) => m === 'POST' && u.includes('/mail/users/add'),
      handle: async () => ({ status: 200, body: 'OK' })
    }
  ]);
  const app = await makeTestApp({ fetchImpl, dnsInspector: makeDnsInspector(makeDnsState()) });
  try {
    const a = await signup(app, 'alpha@example.test');
    const domains = await request(app.base, '/api/domains', { cookie: a.sessionCookie });
    const domainId = domains.json.domains.find((d) => d.kind === 'hosted').id;

    const r = await request(app.base, '/api/mailboxes', {
      method: 'POST',
      body: { domainId, localPart: 'launch-test-20260912', password: 'brand-new-secret-1' },
      cookie: a.sessionCookie,
      origin: app.base
    });
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'mailserver_unavailable');
    assert.match(r.json.error.message, /existing addresses/i);
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 0, 'creation must not be attempted when the listing is unusable');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get().n, 0);
  } finally {
    await app.close();
  }
});

test('grouped listing with a real collision still blocks creation (flattening preserved)', async () => {
  const fetchImpl = makeMockFetch([
    {
      match: (u, m) => m === 'GET' && u.includes('/mail/users'),
      handle: async () => ({
        body: [{ domain: 'example.test', users: [{ email: 'Launch-Test-20260912@example.test', privileges: [] }] }]
      })
    },
    {
      match: (u, m) => m === 'POST' && u.includes('/mail/users/add'),
      handle: async () => ({ status: 200, body: 'OK' })
    }
  ]);
  const app = await makeTestApp({ fetchImpl, dnsInspector: makeDnsInspector(makeDnsState()) });
  try {
    const a = await signup(app, 'alpha@example.test');
    const domains = await request(app.base, '/api/domains', { cookie: a.sessionCookie });
    const domainId = domains.json.domains.find((d) => d.kind === 'hosted').id;
    const r = await request(app.base, '/api/mailboxes', {
      method: 'POST',
      body: { domainId, localPart: 'launch-test-20260912', password: 'brand-new-secret-1' },
      cookie: a.sessionCookie,
      origin: app.base
    });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'address_taken');
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 0);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// DKIM check diagnosis: mismatched key vs missing record vs unavailable key.
// ---------------------------------------------------------------------------

test('dkimDiagnosis: a published key that differs from the provider key is a key mismatch', () => {
  const d = dkimDiagnosis({
    selector: 'mail',
    publishedRecords: ['v=DKIM1; p=OLDSERVERKEY'],
    desiredValue: 'v=DKIM1; p=CURRENTSERVERKEY'
  });
  assert.equal(d.condition, 'key_mismatch');
  assert.equal(d.comparison, 'differs');
  assert.equal(d.providerKeyAvailable, true);
  assert.equal(d.matchedRecordCount, 0);
  assert.deepEqual(d.recordCounts, { expected: 1, current: 1 });
  assert.match(d.summary, /does not match/);
  assert.match(d.nextStep, /update/i);
  // The diagnosis explains the state without duplicating key material.
  assert.ok(!JSON.stringify(d).includes('OLDSERVERKEY'));
  assert.ok(!JSON.stringify(d).includes('CURRENTSERVERKEY'));
});

test('dkimDiagnosis: an exact or whitespace/quote-variant match is a key match', () => {
  const exact = dkimDiagnosis({ selector: 'mail', publishedRecords: ['v=DKIM1; p=KEY1'], desiredValue: 'v=DKIM1; p=KEY1' });
  assert.equal(exact.condition, 'key_match');
  assert.equal(exact.comparison, 'equal');
  assert.equal(exact.matchedRecordCount, 1);
  assert.deepEqual(exact.recordCounts, { expected: 1, current: 1 });
  assert.match(exact.nextStep, /no action needed/i);

  const quoted = dkimDiagnosis({ selector: 'mail', publishedRecords: ['"v=DKIM1; p=KEY1"'], desiredValue: 'v=DKIM1;p=KEY1' });
  assert.equal(quoted.condition, 'key_match');
  assert.equal(quoted.matchedRecordCount, 1);
});

test('dkimDiagnosis: no published record with a provider key available is a missing record', () => {
  const d = dkimDiagnosis({ selector: 'mail', publishedRecords: [], desiredValue: 'v=DKIM1; p=CURRENTSERVERKEY' });
  assert.equal(d.condition, 'record_missing');
  assert.equal(d.comparison, 'none_published');
  assert.equal(d.providerKeyAvailable, true);
  assert.equal(d.matchedRecordCount, 0);
  assert.deepEqual(d.recordCounts, { expected: 1, current: 0 });
  assert.match(d.summary, /no dkim record/i);
  assert.match(d.nextStep, /publish/i);
});

test('dkimDiagnosis: no provider key is an explicit unavailable comparison, whatever is published', () => {
  const nothing = dkimDiagnosis({ selector: 'mail', publishedRecords: [], desiredValue: null });
  assert.equal(nothing.condition, 'provider_key_unavailable');
  assert.equal(nothing.comparison, 'not_compared');
  assert.equal(nothing.providerKeyAvailable, false);
  assert.equal(nothing.matchedRecordCount, null);
  assert.deepEqual(nothing.recordCounts, { expected: 1, current: 0 });
  assert.match(nothing.nextStep, /first mailbox/i);

  // A stale record may exist while the provider key is unavailable: still not compared.
  const stale = dkimDiagnosis({ selector: 'mail', publishedRecords: ['v=DKIM1; p=OLD'], desiredValue: null });
  assert.equal(stale.condition, 'provider_key_unavailable');
  assert.equal(stale.comparison, 'not_compared');
  assert.deepEqual(stale.recordCounts, { expected: 1, current: 1 });
  assert.match(stale.summary, /cannot be compared/i);
});

test('dkimDiagnosis: extra records alongside a match are called out with counts', () => {
  const d = dkimDiagnosis({
    selector: 'mail',
    publishedRecords: ['v=DKIM1; p=CURRENTSERVERKEY', 'v=DKIM1; p=STALE'],
    desiredValue: 'v=DKIM1; p=CURRENTSERVERKEY'
  });
  assert.equal(d.condition, 'key_match');
  assert.equal(d.matchedRecordCount, 1);
  assert.deepEqual(d.recordCounts, { expected: 1, current: 2 });
  assert.match(d.summary, /along with 1 other record/i);
  assert.match(d.nextStep, /remove the extra/i);
});

// ---------------------------------------------------------------------------
// DKIM check details through the real inspect endpoint (all mocks, no network).
// ---------------------------------------------------------------------------

function dumpFor(domain, dkimValue) {
  return [[domain, [
    { qname: domain, rtype: 'MX', value: '10 mailserver.test.' },
    { qname: domain, rtype: 'TXT', value: 'v=spf1 mx -all' },
    { qname: `mail._domainkey.${domain}`, rtype: 'TXT', value: dkimValue },
    { qname: `_dmarc.${domain}`, rtype: 'TXT', value: 'v=DMARC1; p=quarantine;' }
  ]]];
}

async function setupDomainWithDkim({ dump, publishedDkim }) {
  const dnsState = makeDnsState();
  dnsState.mx = [{ priority: 10, exchange: 'mailserver.test' }];
  dnsState.txt = ['v=spf1 mx -all'];
  dnsState.dkim = publishedDkim;
  dnsState.dmarc = ['v=DMARC1; p=quarantine;'];
  const mailserverState = makeMailServerState();
  mailserverState.dump = dump;
  const fetchImpl = makeMockFetch(mailserverHandlers(mailserverState));
  const app = await makeTestApp({ fetchImpl, dnsInspector: makeDnsInspector(dnsState) });
  app.dnsState = dnsState;
  const a = await signup(app, 'diag@example.test');
  const created = await request(app.base, '/api/domains', {
    method: 'POST', body: { name: 'diag.test' }, cookie: a.sessionCookie, origin: app.base
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const { domain, verifyRecord } = created.json;
  dnsState.verifyTxt.push(verifyRecord.value);
  const verified = await request(app.base, `/api/domains/${domain.id}/verify`, {
    method: 'POST', body: { method: 'dns' }, cookie: a.sessionCookie, origin: app.base
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  const inspected = await request(app.base, `/api/domains/${domain.id}/inspect`, { cookie: a.sessionCookie });
  assert.equal(inspected.status, 200, JSON.stringify(inspected.json));
  return { app, cookie: a.sessionCookie, domainId: domain.id, checks: inspected.json.checks };
}

test('inspect explains a published DKIM key that differs from the mail server key', async () => {
  const { app, domainId, checks, cookie } = await setupDomainWithDkim({
    dump: dumpFor('diag.test', 'v=DKIM1; p=CURRENTSERVERKEY'),
    publishedDkim: ['v=DKIM1; p=PUBLISHEDOLDKEY']
  });
  try {
    const dkim = checks.find((c) => c.scope === 'dkim');
    assert.equal(dkim.status, 'warn', 'status truth preserved: mismatch is warn, not pass');
    assert.equal(dkim.details.selector, 'mail', 'existing details field preserved');
    assert.equal(dkim.details.note, null, 'existing details field preserved');
    assert.equal(dkim.details.condition, 'key_mismatch');
    assert.equal(dkim.details.comparison, 'differs');
    assert.equal(dkim.details.providerKeyAvailable, true);
    assert.equal(dkim.details.matchedRecordCount, 0);
    assert.deepEqual(dkim.details.recordCounts, { expected: 1, current: 1 });
    assert.match(dkim.details.summary, /does not match the mail server's current signing key/i);
    assert.match(dkim.details.nextStep, /update/i);
    assert.match(dkim.details.nextStep, /exactly one/i);
    // No key material or credentials leak into the check details.
    const raw = JSON.stringify(dkim.details);
    assert.ok(!raw.includes('PUBLISHEDOLDKEY'));
    assert.ok(!raw.includes('CURRENTSERVERKEY'));
    assert.ok(!raw.includes('mailserver-secret'));
    assert.ok(!/PRIVATE KEY/i.test(raw));

    // The persisted checks (domain detail endpoint) keep the enriched details.
    const detail = await request(app.base, `/api/domains/${domainId}`, { cookie });
    const persisted = detail.json.checks.find((c) => c.scope === 'dkim');
    assert.equal(persisted.details.condition, 'key_mismatch');
    assert.deepEqual(persisted.details.recordCounts, { expected: 1, current: 1 });
  } finally {
    await app.close();
  }
});

test('inspect reports a missing DKIM record when the provider key is available', async () => {
  const { app, checks } = await setupDomainWithDkim({
    dump: dumpFor('diag.test', 'v=DKIM1; p=CURRENTSERVERKEY'),
    publishedDkim: []
  });
  try {
    const dkim = checks.find((c) => c.scope === 'dkim');
    assert.equal(dkim.status, 'warn');
    assert.equal(dkim.details.condition, 'record_missing');
    assert.equal(dkim.details.comparison, 'none_published');
    assert.deepEqual(dkim.details.recordCounts, { expected: 1, current: 0 });
    assert.equal(dkim.details.note, 'Appears after a mailbox is staged on the mail server.');
    assert.match(dkim.details.nextStep, /publish/i);
    assert.ok(!JSON.stringify(dkim.details).includes('CURRENTSERVERKEY'));
  } finally {
    await app.close();
  }
});

test('inspect stays pending with an explicit unavailable-provider-key reason when the dump has no DKIM', async () => {
  const { app, checks } = await setupDomainWithDkim({ dump: null, publishedDkim: [] });
  try {
    const dkim = checks.find((c) => c.scope === 'dkim');
    assert.equal(dkim.status, 'pending', 'status truth preserved: no provider key is pending');
    assert.equal(dkim.details.condition, 'provider_key_unavailable');
    assert.equal(dkim.details.comparison, 'not_compared');
    assert.equal(dkim.details.providerKeyAvailable, false);
    assert.equal(dkim.details.matchedRecordCount, null);
    assert.deepEqual(dkim.details.recordCounts, { expected: 1, current: 0 });
    assert.match(dkim.details.summary, /signing key is not available/i);
    assert.match(dkim.details.nextStep, /first mailbox/i);
  } finally {
    await app.close();
  }
});

test('inspect passes with counts and a no-action step when the published key matches', async () => {
  const { app, checks } = await setupDomainWithDkim({
    dump: dumpFor('diag.test', 'v=DKIM1; p=CURRENTSERVERKEY'),
    publishedDkim: ['v=DKIM1; p=CURRENTSERVERKEY']
  });
  try {
    const dkim = checks.find((c) => c.scope === 'dkim');
    assert.equal(dkim.status, 'pass');
    assert.equal(dkim.details.condition, 'key_match');
    assert.equal(dkim.details.comparison, 'equal');
    assert.equal(dkim.details.matchedRecordCount, 1);
    assert.deepEqual(dkim.details.recordCounts, { expected: 1, current: 1 });
    assert.match(dkim.details.nextStep, /no action needed/i);
    const scopes = checks.map((c) => c.scope).sort();
    assert.deepEqual(scopes, ['dkim', 'dmarc', 'mx', 'ownership', 'spf'], 'check API shape unchanged');
  } finally {
    await app.close();
  }
});
