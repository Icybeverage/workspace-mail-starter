import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTestApp, makeMockFetch, mailserverHandlers, makeMailServerState, makeDnsState, makeDnsInspector,
  request, signup, captureLogger
} from './helpers.js';

function setup({ configOverrides = {}, mailserverState = makeMailServerState(), extraHandlers = [] } = {}) {
  const dnsState = makeDnsState();
  const fetchImpl = makeMockFetch([...extraHandlers, ...mailserverHandlers(mailserverState)]);
  const logger = captureLogger();
  return makeTestApp({
    fetchImpl,
    dnsInspector: makeDnsInspector(dnsState),
    logger,
    configOverrides: { mailboxLimitPerAccount: 5, ...configOverrides }
  }).then((app) => ({ app, dnsState, mailserverState, fetchImpl, logger }));
}

async function hostedDomainId(app, cookie) {
  const r = await request(app.base, '/api/domains', { cookie });
  const hosted = r.json.domains.find((d) => d.kind === 'hosted');
  assert.ok(hosted, 'hosted domain must exist');
  return hosted.id;
}

async function createMailbox(app, cookie, { domainId, localPart, password = 'password12345' }) {
  return request(app.base, '/api/mailboxes', {
    method: 'POST',
    body: { domainId, localPart, password },
    cookie,
    origin: app.base
  });
}

// Verified real MAIL_SERVER /mail/users row shape.
function withUsage(state, email, overrides = {}) {
  const user = state.users.find((u) => u.email === email);
  assert.ok(user, `mock upstream user ${email} must exist`);
  Object.assign(user, {
    box_quota: 536870912,
    box_size: '2.9K',
    percent: '  0%',
    quota: '512M',
    privileges: [],
    status: 'active',
    ...overrides
  });
  return user;
}

function workspace(app, cookie) {
  return request(app.base, '/api/workspace', { cookie });
}

test('workspace storage: only owned mailbox usage, verified fields, never other users or global stats', async () => {
  const { app, mailserverState, fetchImpl } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);
    const created = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'alpha-inbox' });
    assert.equal(created.status, 200, JSON.stringify(created.json));

    withUsage(mailserverState, 'alpha-inbox@example.test');
    // Other users on the mail server (other tenant + unrelated domain) must never surface.
    mailserverState.users.push({
      email: 'beta-inbox@example.test', privileges: [], box_quota: 10737418240,
      box_size: '9.9G', percent: ' 99%', quota: '10G', status: 'active'
    });
    mailserverState.users.push({ email: 'stranger@example.com', privileges: [], box_quota: 536870912, box_size: '7.7M', percent: ' 3%', quota: '512M', status: 'active' });

    const r = await workspace(app, a.sessionCookie);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { storage, notes } = r.json.workspace;
    assert.equal(storage.status, 'ok');
    assert.equal(storage.upstreamQueried, true);
    assert.equal(storage.items.length, 1);

    const item = storage.items[0];
    assert.equal(item.address, 'alpha-inbox@example.test');
    assert.equal(item.mailboxStatus, 'created');
    assert.equal(item.available, true);
    // box_size is preserved exactly as the mail server measured it.
    assert.equal(item.used, '2.9K');
    assert.equal(item.quota, '512M');
    // Quota bytes come from the verified box_quota field.
    assert.equal(item.quotaBytes, 536870912);
    assert.equal(item.percent, 0);
    assert.equal(item.upstreamStatus, 'active');

    // No other tenant's mailbox, no unrelated user, no privileges, no global/admin totals.
    const raw = JSON.stringify(r.json);
    assert.ok(!raw.includes('beta-inbox'), 'other tenant mailbox must not appear');
    assert.ok(!raw.includes('stranger@'), 'unrelated upstream user must not appear');
    assert.ok(!raw.includes('9.9G') && !raw.includes('7.7M'), 'other users\u2019 usage must not appear');
    assert.ok(!raw.includes('privileges'), 'privileges must not be exposed');
    assert.equal(storage.totalUsers, undefined);
    assert.equal(storage.totalBytes, undefined);
    assert.equal(r.json.workspace.users, undefined);

    assert.ok(notes.credentials.includes('mailbox password'), 'credentials note must name mailbox credentials');
    assert.ok(notes.credentials.includes('not your Workspace app password'));
    assert.ok(notes.files.toLowerCase().includes('separate'));

    // The upstream listing is consulted for this request, and the address filtering is client-safe.
    assert.ok(fetchImpl.callsTo('/mail/users').length >= 1);
  } finally {
    await app.close();
  }
});

test('workspace does not call upstream before a mailbox exists and never fabricates zero', async () => {
  const { app, mailserverState, fetchImpl } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');

    const empty = await workspace(app, a.sessionCookie);
    assert.equal(empty.status, 200, JSON.stringify(empty.json));
    assert.equal(empty.json.workspace.storage.status, 'no_mailbox');
    assert.equal(empty.json.workspace.storage.upstreamQueried, false);
    assert.deepEqual(empty.json.workspace.storage.items, []);
    assert.equal(fetchImpl.callsTo('/mail/users').length, 0, 'no mailbox means no upstream lookup');

    // A failed creation means no mailbox exists upstream: still no lookup, still no numbers.
    mailserverState.addFailures = 1;
    const domainId = await hostedDomainId(app, a.sessionCookie);
    const failed = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'alpha-inbox' });
    assert.equal(failed.status, 502, JSON.stringify(failed.json));

    const callsBefore = fetchImpl.callsTo('/mail/users').length;
    const r = await workspace(app, a.sessionCookie);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { storage } = r.json.workspace;
    assert.equal(storage.status, 'not_created');
    assert.equal(storage.upstreamQueried, false);
    assert.equal(fetchImpl.callsTo('/mail/users').length, callsBefore, 'failed mailbox must not trigger an admin lookup');
    assert.equal(storage.items.length, 1);
    assert.equal(storage.items[0].available, false);
    assert.equal(storage.items[0].reason, 'creation_failed');
    assert.ok(!('used' in storage.items[0]) && !('quotaBytes' in storage.items[0]) && !('percent' in storage.items[0]));
  } finally {
    await app.close();
  }
});

test('workspace: upstream error or timeout shows unavailable, never zeros', async () => {
  const mailserverState = makeMailServerState();
  const extraHandlers = [
    {
      match: (u, m) => m === 'GET' && u.includes('/mail/users') && mailserverState.usersFail === true,
      handle: async () => ({ status: 500, body: 'boom' })
    },
    {
      match: (u, m) => m === 'GET' && u.includes('/mail/users') && mailserverState.usersSlow === true,
      delayMs: 600,
      handle: async () => ({ body: mailserverState.users })
    }
  ];
  const { app, fetchImpl } = await setup({ mailserverState, extraHandlers });
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);
    const created = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'alpha-inbox' });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    withUsage(mailserverState, 'alpha-inbox@example.test');

    mailserverState.usersFail = true;
    const err = await workspace(app, a.sessionCookie);
    assert.equal(err.status, 200, JSON.stringify(err.json));
    const errStorage = err.json.workspace.storage;
    assert.equal(errStorage.status, 'unavailable');
    assert.equal(errStorage.upstreamQueried, true);
    assert.equal(errStorage.items[0].available, false);
    assert.equal(errStorage.items[0].reason, 'upstream_unavailable');
    assert.ok(!('used' in errStorage.items[0]) && !('quotaBytes' in errStorage.items[0]) && !('percent' in errStorage.items[0]));
    assert.ok(errStorage.message.toLowerCase().includes('unavailable'));
    assert.ok(!JSON.stringify(err.json).includes('"2.9K"'), 'no stale or fabricated usage may leak');

    mailserverState.usersFail = false;
    mailserverState.usersSlow = true;
    const slow = await workspace(app, a.sessionCookie);
    assert.equal(slow.status, 200, JSON.stringify(slow.json));
    assert.equal(slow.json.workspace.storage.status, 'unavailable');
    assert.equal(slow.json.workspace.storage.items[0].available, false);
    assert.ok(slow.json.workspace.storage.message.toLowerCase().includes('did not respond in time'));
    assert.ok(!('used' in slow.json.workspace.storage.items[0]));

    mailserverState.usersSlow = false;
    const ok = await workspace(app, a.sessionCookie);
    assert.equal(ok.json.workspace.storage.status, 'ok');
    assert.equal(ok.json.workspace.storage.items[0].used, '2.9K');
    assert.ok(fetchImpl.callsTo('/mail/users').length >= 3);
  } finally {
    await app.close();
  }
});

test('workspace percent parsing: finite 0-100 else null; box_size preserved verbatim', async () => {
  const { app, mailserverState } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);
    assert.equal((await createMailbox(app, a.sessionCookie, { domainId, localPart: 'alpha-inbox' })).status, 200);
    const upstream = withUsage(mailserverState, 'alpha-inbox@example.test');

    const cases = [
      ['  0%', 0],
      ['0.5%', 0.5],
      ['100%', 100],
      [' 42 ', 42],
      ['101%', null],
      ['-1%', null],
      ['n/a', null],
      [null, null]
    ];
    for (const [raw, expected] of cases) {
      upstream.percent = raw;
      const r = await workspace(app, a.sessionCookie);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.workspace.storage.items[0].percent, expected, `percent ${JSON.stringify(raw)}`);
    }

    upstream.box_size = '1023.9K';
    const r1 = await workspace(app, a.sessionCookie);
    assert.equal(r1.json.workspace.storage.items[0].used, '1023.9K', 'box_size must be preserved verbatim');

    upstream.box_size = null;
    upstream.box_quota = 536870912;
    const r2 = await workspace(app, a.sessionCookie);
    const item = r2.json.workspace.storage.items[0];
    assert.equal(item.available, true);
    assert.equal(item.used, null, 'missing box_size stays null, never coerced');
    assert.equal(item.quotaBytes, 536870912);
  } finally {
    await app.close();
  }
});

test('workspace keeps tenants isolated: each tenant sees only their own storage', async () => {
  const { app, mailserverState } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');
    const b = await signup(app, 'beta@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);

    assert.equal((await createMailbox(app, a.sessionCookie, { domainId, localPart: 'alpha-inbox' })).status, 200);
    assert.equal((await createMailbox(app, b.sessionCookie, { domainId, localPart: 'beta-inbox' })).status, 200);
    withUsage(mailserverState, 'alpha-inbox@example.test', { box_size: '2.9K', percent: '  0%' });
    withUsage(mailserverState, 'beta-inbox@example.test', { box_size: '1.5M', percent: ' 12%', box_quota: 536870912 });

    const ra = await workspace(app, a.sessionCookie);
    assert.equal(ra.json.workspace.storage.items.length, 1);
    assert.equal(ra.json.workspace.storage.items[0].address, 'alpha-inbox@example.test');
    const rawA = JSON.stringify(ra.json);
    assert.ok(!rawA.includes('beta-inbox') && !rawA.includes('1.5M'));

    const rb = await workspace(app, b.sessionCookie);
    assert.equal(rb.json.workspace.storage.items.length, 1);
    assert.equal(rb.json.workspace.storage.items[0].address, 'beta-inbox@example.test');
    const rawB = JSON.stringify(rb.json);
    assert.ok(!rawB.includes('alpha-inbox') && !rawB.includes('2.9K'));
    assert.equal(rb.json.workspace.storage.items[0].used, '1.5M');
    assert.equal(rb.json.workspace.storage.items[0].percent, 12);
  } finally {
    await app.close();
  }
});

test('workspace checks upstream for uncertain mailboxes but never invents their usage', async () => {
  const { app, mailserverState, fetchImpl } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');
    const domainId = await hostedDomainId(app, a.sessionCookie);

    mailserverState.addDelayMs = 600; // exceeds the 200 ms test timeout -> mailbox becomes uncertain
    const uncertain = await createMailbox(app, a.sessionCookie, { domainId, localPart: 'alpha-inbox' });
    assert.equal(uncertain.status, 202, JSON.stringify(uncertain.json));
    mailserverState.addDelayMs = 0;

    const callsBefore = fetchImpl.callsTo('/mail/users').length;
    const r = await workspace(app, a.sessionCookie);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const { storage } = r.json.workspace;
    assert.equal(storage.upstreamQueried, true, 'an uncertain mailbox may exist upstream, so it is checked');
    assert.equal(fetchImpl.callsTo('/mail/users').length, callsBefore + 1);
    assert.equal(storage.items[0].mailboxStatus, 'uncertain');
    assert.equal(storage.items[0].available, false);
    assert.equal(storage.items[0].reason, 'not_reported');
    assert.ok(!('used' in storage.items[0]) && !('percent' in storage.items[0]));
  } finally {
    await app.close();
  }
});
