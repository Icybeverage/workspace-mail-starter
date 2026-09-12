import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, makeMockFetch, mailserverHandlers, makeMailServerState, makeDnsState, makeDnsInspector, request, signup, captureLogger } from './helpers.js';

function setup({ configOverrides = {}, mailserverState = makeMailServerState() } = {}) {
  const dnsState = makeDnsState();
  const fetchImpl = makeMockFetch(mailserverHandlers(mailserverState));
  const logger = captureLogger();
  return makeTestApp({
    fetchImpl,
    dnsInspector: makeDnsInspector(dnsState),
    logger,
    configOverrides: { mailboxLimitPerAccount: 5, ...configOverrides }
  }).then((app) => ({ app, dnsState, mailserverState, fetchImpl, logger }));
}

function findSecret(db, secret) {
  const hits = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  for (const { name } of tables) {
    for (const row of db.prepare(`SELECT * FROM "${name}"`).all()) {
      for (const [col, val] of Object.entries(row)) {
        if (val !== null && String(val).includes(secret)) hits.push(`${name}.${col}`);
      }
    }
  }
  return hits;
}

async function hostedDomainId(app, cookie) {
  const r = await request(app.base, '/api/domains', { cookie });
  const hosted = r.json.domains.find((d) => d.kind === 'hosted');
  assert.ok(hosted, 'hosted domain must exist');
  return hosted.id;
}

function createMailbox(app, cookie, { domainId, localPart, password }) {
  return request(app.base, '/api/mailboxes', {
    method: 'POST',
    body: { domainId, localPart, password },
    cookie,
    origin: app.base
  });
}

test('hosted mailbox creation: sends password once, privileges empty, never persists password', async () => {
  const { app, mailserverState, fetchImpl, logger } = await setup();
  const mailboxSecret = 'super-secret-mailbox-pw-1';
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);

    const created = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'hello', password: mailboxSecret });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    assert.equal(created.json.mailbox.address, 'hello@example.test');
    assert.equal(created.json.mailbox.status, 'created');
    assert.equal(created.json.delivery.inbound, 'unknown');
    assert.equal(created.json.delivery.outbound, 'unknown');

    // Sent to MAIL_SERVER exactly once with an empty privileges field (never admin).
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 1);
    assert.equal(mailserverState.lastAddPrivileges, '');
    assert.equal(mailserverState.lastAddPassword, mailboxSecret);
    assert.equal(mailserverState.users[0].email, 'hello@example.test');
    assert.deepEqual(mailserverState.users[0].privileges, []);

    // Job payload carries no password; nor does any DB column or log line.
    assert.equal(created.json.job.payload.password, undefined);
    assert.ok(!JSON.stringify(created.json.job.payload).includes(mailboxSecret));
    assert.deepEqual(findSecret(app.db, mailboxSecret), []);
    assert.ok(!logger.lines.join('').includes(mailboxSecret), 'logger must not contain the mailbox password');

    // Pending activity and job state are consistent.
    const activity = await request(app.base, '/api/mailboxes', { cookie: a.sessionCookie });
    assert.equal(activity.json.limits.used, 1);
  } finally {
    await app.close();
  }
});

test('MAIL_SERVER v76 grouped user listing is flattened for collision checks', async () => {
  // Live GET /mail/users?format=json returns [{domain, users:[...]}, ...].
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
  const app = await makeTestApp({ fetchImpl, dnsInspector: makeDnsInspector(makeDnsState()), configOverrides: {} });
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);
    const r = await createMailbox(app, a.sessionCookie, {
      domainId, localPart: 'launch-test-20260912', password: 'brand-new-secret-1'
    });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'address_taken');
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 0);
  } finally {
    await app.close();
  }
});

test('hosted collision: an existing upstream mailbox is never taken over', async () => {
  const mailserverState = makeMailServerState();
  // Simulated pre-existing operator mailbox (e.g. created outside the app).
  mailserverState.users.push({ email: 'launch-test-20260912@example.test', privileges: [] });
  const { app, fetchImpl } = await setup({ mailserverState });
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);

    const r = await createMailbox(app, a.sessionCookie, {
      domainId, localPart: 'launch-test-20260912', password: 'brand-new-secret-1'
    });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'address_taken');
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 0, 'must not attempt to add over an existing mailbox');

    // No local mailbox row was created and the upstream entry is untouched.
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get().n, 0);
    assert.deepEqual(mailserverState.users[0].privileges, []);
    assert.equal(mailserverState.users.length, 1);
  } finally {
    await app.close();
  }
});

test('hosted collision across accounts: second account cannot reserve the same address', async () => {
  const { app, fetchImpl, mailserverState } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');
    const b = await signup(app, 'beta@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);

    const first = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'shared', password: 'first-secret-123' });
    assert.equal(first.status, 200);

    const second = await createMailbox(app, b.sessionCookie, { domainId, localPart: 'shared', password: 'second-secret-123' });
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.equal(second.json.error.code, 'address_taken');
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 1, 'no add attempt for the blocked address');
    assert.equal(mailserverState.users.length, 1);

    // The owner can re-request and gets a safe, explicit "already yours" answer.
    const again = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'shared', password: 'third-secret-123' });
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'already_created');
  } finally {
    await app.close();
  }
});

test('account limit and reserved local parts are enforced before any upstream call', async () => {
  const { app, fetchImpl } = await setup({ configOverrides: { mailboxLimitPerAccount: 1 } });
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);

    const reserved = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'admin', password: 'long-enough-pw' });
    assert.equal(reserved.status, 400);
    assert.equal(reserved.json.error.code, 'invalid_local_part');
    for (const lp of ['postmaster', 'abuse', 'support', 'root', 'noreply']) {
      const r = await createMailbox(app, a.sessionCookie, { domainId, localPart: lp, password: 'long-enough-pw' });
      assert.equal(r.status, 400, `${lp} must be reserved on the hosted domain`);
    }
    assert.equal(fetchImpl.callsTo('/mail/users').length, 0, 'validation happens before any upstream call');

    const weak = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'okname', password: 'short' });
    assert.equal(weak.status, 400);
    assert.equal(weak.json.error.code, 'weak_password');

    const first = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'one', password: 'long-enough-pw' });
    assert.equal(first.status, 200);

    const second = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'two', password: 'long-enough-pw' });
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, 'account_limit');
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 1);
  } finally {
    await app.close();
  }
});

test('unconfigured mail server: 503 and no mailbox row is written', async () => {
  const { app } = await setup({
    configOverrides: { mailserver: { baseUrl: '', username: '', password: '', timeoutMs: 200, mailHost: 'mailserver.test' } }
  });
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);
    const r = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'hello', password: 'long-enough-pw' });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'mailserver_unconfigured');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get().n, 0);
  } finally {
    await app.close();
  }
});

test('timeout becomes an honest uncertain state; reconcile confirms upstream without touching the password', async () => {
  const { app, mailserverState, fetchImpl } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);
    const address = 'slow@example.test';

    // First attempt times out (handler stalls far beyond the 200ms client timeout).
    mailserverState.addDelayMs = 5000;
    const r1 = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'slow', password: 'uncertain-secret-1' });
    mailserverState.addDelayMs = 0;
    assert.equal(r1.status, 202, JSON.stringify(r1.json));
    assert.equal(r1.json.error.uncertain, true);
    assert.equal(r1.json.error.code, 'creation_uncertain');
    assert.equal(r1.json.mailbox.status, 'uncertain');

    // Upstream actually has it (the POST landed despite the timeout).
    mailserverState.users.push({ email: address, privileges: [] });
    const recon = await request(app.base, `/api/mailboxes/${r1.json.mailbox.id}/reconcile`, {
      method: 'POST', body: {}, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(recon.status, 200);
    assert.equal(recon.json.reconciled, true);
    assert.equal(recon.json.exists, true);
    assert.equal(recon.json.mailbox.status, 'created');

    // Only the original add call; reconcile used the read-only users list.
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 1);
    assert.ok(fetchImpl.callsTo('/mail/users?format=json').length >= 1);
    assert.equal(mailserverState.users.length, 1);
  } finally {
    await app.close();
  }
});

test('timeout then reconcile-absent marks failed; retry only succeeds after upstream absence check', async () => {
  const { app, mailserverState, fetchImpl } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);

    mailserverState.addDelayMs = 5000;
    const r1 = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'gone', password: 'uncertain-secret-2' });
    mailserverState.addDelayMs = 0;
    assert.equal(r1.status, 202);
    const mailboxId = r1.json.mailbox.id;

    // An immediate absent read cannot prove that the timed-out write will not land.
    const early = await request(app.base, `/api/mailboxes/${mailboxId}/reconcile`, {
      method: 'POST', body: {}, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(early.json.mailbox.status, 'uncertain');
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 1);
    // Advance the persisted reservation beyond the reconciliation grace period.
    app.db.prepare('UPDATE mailboxes SET updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 120000).toISOString(), mailboxId);
    // A fresh upstream absence after the grace period releases the reservation.
    const recon = await request(app.base, `/api/mailboxes/${mailboxId}/reconcile`, {
      method: 'POST', body: {}, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(recon.status, 200);
    assert.equal(recon.json.exists, false);
    assert.equal(recon.json.mailbox.status, 'failed');
    assert.equal(mailserverState.users.length, 0);

    // Retry is allowed and goes through the upstream absence check again.
    const r2 = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'gone', password: 'retry-secret-123' });
    assert.equal(r2.status, 200, JSON.stringify(r2.json));
    assert.equal(r2.json.mailbox.status, 'created');
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 2);
    assert.equal(mailserverState.users.length, 1);
  } finally {
    await app.close();
  }
});

test('retry over an upstream mailbox that landed during the timeout is refused, never reset', async () => {
  const { app, mailserverState, fetchImpl } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);
    const address = 'late@example.test';

    mailserverState.addDelayMs = 5000;
    const r1 = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'late', password: 'uncertain-secret-3' });
    mailserverState.addDelayMs = 0;
    assert.equal(r1.status, 202);

    mailserverState.users.push({ email: address, privileges: [] });
    const r2 = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'late', password: 'attempt-2-secret' });
    assert.equal(r2.status, 409, JSON.stringify(r2.json));
    assert.equal(r2.json.error.code, 'address_taken');
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 1, 'no second add attempt');

    // The local record was reconciled to created rather than retried.
    const read = await request(app.base, `/api/mailboxes/${r1.json.mailbox.id}`, { cookie: a.sessionCookie });
    assert.equal(read.json.mailbox.status, 'created');
    assert.equal(mailserverState.users.length, 1);
  } finally {
    await app.close();
  }
});
