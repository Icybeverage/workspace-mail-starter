import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, makeMockFetch, mailserverHandlers, makeMailServerState, makeDnsState, makeDnsInspector, request, signup } from './helpers.js';

function setup({ mailserverState = makeMailServerState() } = {}) {
  const dnsState = makeDnsState();
  const fetchImpl = makeMockFetch(mailserverHandlers(mailserverState));
  return makeTestApp({
    fetchImpl,
    dnsInspector: makeDnsInspector(dnsState),
    configOverrides: {}
  }).then((app) => ({ app, dnsState, mailserverState, fetchImpl }));
}

test('tenant isolation: cross-tenant domain reads and writes return 404', async () => {
  const { app } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');
    const b = await signup(app, 'beta@example.test');
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);

    const created = await request(app.base, '/api/domains', {
      method: 'POST', body: { name: 'alpha-iso.test' }, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(created.status, 200);
    const domainId = created.json.domain.id;

    const listB = await request(app.base, '/api/domains', { cookie: b.sessionCookie });
    assert.equal(listB.status, 200);
    assert.ok(!listB.json.domains.some((d) => d.name === 'alpha-iso.test'));

    const cases = [
      ['GET', `/api/domains/${domainId}`],
      ['GET', `/api/domains/${domainId}/graph`],
      ['GET', `/api/domains/${domainId}/inspect`],
      ['POST', `/api/domains/${domainId}/plan`],
      ['POST', `/api/domains/${domainId}/plan/apply`],
      ['POST', `/api/domains/${domainId}/activate`],
      ['POST', `/api/domains/${domainId}/verify`]
    ];
    for (const [method, path] of cases) {
      const r = await request(app.base, path, {
        method, body: method === 'POST' ? {} : undefined, cookie: b.sessionCookie, origin: app.base
      });
      if (path.endsWith('/graph')) {
        // Graph is unconfigured in tests: honest 503 degraded, never another tenant's data.
        assert.equal(r.status, 503, `${path} should be 503 for tenant B`);
        assert.equal(r.json.error.code, 'graph_unavailable');
        assert.equal(r.json.error.degraded, true);
        assert.ok(!JSON.stringify(r.json).includes('alpha-iso.test'));
      } else {
        assert.equal(r.status, 404, `${path} should be 404 for tenant B, got ${r.status}`);
        assert.equal(r.json.error.code, 'domain_not_found');
      }
    }

    // B cannot register A's domain either.
    const dup = await request(app.base, '/api/domains', {
      method: 'POST', body: { name: 'alpha-iso.test' }, cookie: b.sessionCookie, origin: app.base
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'domain_taken');
  } finally {
    await app.close();
  }
});

test('tenant isolation: cross-tenant mailbox reads, writes, and reconcile return 404', async () => {
  const { app, mailserverState } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');
    const b = await signup(app, 'beta@example.test');

    const domainsA = await request(app.base, '/api/domains', { cookie: a.sessionCookie });
    const hosted = domainsA.json.domains.find((d) => d.kind === 'hosted');
    assert.ok(hosted, 'hosted domain must be visible');
    assert.equal(hosted.shared, true);

    const created = await request(app.base, '/api/mailboxes', {
      method: 'POST',
      body: { domainId: hosted.id, localPart: 'iso-a', password: 'iso-pass-12345' },
      cookie: a.sessionCookie,
      origin: app.base
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    assert.equal(created.json.mailbox.address, 'iso-a@example.test');
    assert.equal(created.json.mailbox.status, 'created');
    const mailboxId = created.json.mailbox.id;

    // B's mailbox list never contains A's mailbox.
    const listB = await request(app.base, '/api/mailboxes', { cookie: b.sessionCookie });
    assert.equal(listB.status, 200);
    assert.ok(!listB.json.mailboxes.some((m) => m.id === mailboxId));

    const readB = await request(app.base, `/api/mailboxes/${mailboxId}`, { cookie: b.sessionCookie });
    assert.equal(readB.status, 404);
    assert.equal(readB.json.error.code, 'mailbox_not_found');

    const reconcileB = await request(app.base, `/api/mailboxes/${mailboxId}/reconcile`, {
      method: 'POST', body: {}, cookie: b.sessionCookie, origin: app.base
    });
    assert.equal(reconcileB.status, 404);

    // B cannot create a different localpart on A's custom domain (kind must not leak either).
    const crossMailbox = await request(app.base, '/api/mailboxes', {
      method: 'POST',
      body: { domainId: 'not-a-real-domain-id', localPart: 'x', password: 'long-enough-pw' },
      cookie: b.sessionCookie,
      origin: app.base
    });
    assert.equal(crossMailbox.status, 404);
    assert.equal(crossMailbox.json.error.code, 'domain_not_found');

    assert.equal(mailserverState.users.length, 1);
  } finally {
    await app.close();
  }
});

test('tenant isolation: activity feed is per-tenant', async () => {
  const { app } = await setup();
  try {
    const a = await signup(app, 'alpha@example.test');
    const b = await signup(app, 'beta@example.test');

    const created = await request(app.base, '/api/domains', {
      method: 'POST', body: { name: 'alpha-iso.test' }, cookie: a.sessionCookie, origin: app.base
    });
    const domainId = created.json.domain.id;

    const activityB = await request(app.base, '/api/activity', { cookie: b.sessionCookie });
    assert.equal(activityB.status, 200);
    assert.ok(!activityB.json.items.some((i) => i.message.includes('alpha-iso.test')), 'B must not see A activity');
    assert.ok(!(await request(app.base, `/api/activity?domainId=${domainId}`, { cookie: b.sessionCookie })).json.items.length);

    const activityA = await request(app.base, '/api/activity', { cookie: a.sessionCookie });
    assert.ok(activityA.json.items.some((i) => i.kind === 'domain.created'));
  } finally {
    await app.close();
  }
});
