import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphService, nodeId } from '../server/services/graph.js';
import { createAgentService } from '../server/services/agent.js';
import {
  makeConfig,
  makeTestApp,
  makeMockFetch,
  mailserverHandlers,
  makeMailServerState,
  makeDnsState,
  makeDnsInspector,
  request,
  signup,
  sleep
} from './helpers.js';

function graphRecord(values) {
  return { get: (key) => values[key] };
}

function makeGraphDriver({ blockWrites = false, failWrites = false } = {}) {
  const calls = [];
  let transactionCount = 0;
  let writeStarted;
  let releaseWrite;
  const started = new Promise((resolve) => { writeStarted = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  const driver = {
    async verifyConnectivity() {},
    session() {
      return {
        async executeWrite(callback) {
          transactionCount += 1;
          writeStarted();
          if (blockWrites) await gate;
          if (failWrites) throw new Error('projection write failed');
          return callback({
            async run(cypher, params) {
              calls.push({ cypher, params, transactional: true });
              return { records: [] };
            }
          });
        },
        async run(cypher, params) {
          calls.push({ cypher, params, transactional: false });
          if (cypher.includes('RETURN collect(DISTINCT n)')) {
            return {
              records: [graphRecord({
                nodes: [
                  { properties: { id: nodeId('tenant-1', 'Domain', 'domain-1'), entityLabel: 'Domain', name: 'example.test' } },
                  { properties: { id: nodeId('tenant-1', 'DNSRecord', 'domain-1:mx'), entityLabel: 'DNSRecord', name: '@', dnsType: 'MX', state: 'configured' } }
                ],
                edges: []
              })]
            };
          }
          if (cypher.includes('r.dnsType AS type')) {
            return {
              records: [graphRecord({
                recordId: 'domain-1:mx',
                name: '@',
                type: 'MX',
                state: 'missing',
                mailboxes: [],
                actions: []
              })]
            };
          }
          return { records: [] };
        },
        async close() {}
      };
    },
    async close() {}
  };
  return {
    driver,
    calls,
    started,
    releaseWrite,
    transactionCount: () => transactionCount
  };
}

function snapshot() {
  return {
    domains: [{ id: 'domain-1', name: 'example.test', kind: 'custom', status: 'setup' }],
    mailboxes: [],
    records: [{ localId: 'domain-1:mx', domainId: 'domain-1', name: '@', type: 'MX', state: 'missing' }],
    checks: [],
    actions: []
  };
}

test('graph projection is transactional, reads wait for it, and DNS types survive reads', async () => {
  const fake = makeGraphDriver({ blockWrites: true });
  const graph = createGraphService({
    config: makeConfig({ neo4j: { uri: 'bolt://mock', username: 'neo4j', password: 'mock' } }),
    driverFactory: () => fake.driver
  });
  try {
    const projection = graph.project('tenant-1', snapshot());
    await fake.started;
    let readFinished = false;
    const read = graph.getDomainGraph('tenant-1', 'domain-1').then((value) => {
      readFinished = true;
      return value;
    });
    await sleep(10);
    assert.equal(readFinished, false, 'a graph read must not observe a projection still in flight');
    fake.releaseWrite();
    await projection;
    const result = await read;
    const dnsNode = result.nodes.find((node) => node.entityLabel === 'DNSRecord');
    assert.equal(dnsNode.type, 'DNSRecord');
    assert.equal(dnsNode.dnsType, 'MX');
    assert.equal(dnsNode.recordType, 'MX');
    assert.equal(fake.transactionCount(), 1, 'all snapshot writes must use one transaction');

    const blockers = await graph.blockers('tenant-1', 'domain-1');
    assert.equal(blockers[0].type, 'MX');
    assert.ok(fake.calls.some((call) => call.cypher.includes('r.dnsType AS type')));
  } finally {
    await graph.close();
  }
});

test('failed graph projections remain degraded and reads fail honestly', async () => {
  const fake = makeGraphDriver({ failWrites: true });
  const graph = createGraphService({
    config: makeConfig({ neo4j: { uri: 'bolt://mock', username: 'neo4j', password: 'mock' } }),
    driverFactory: () => fake.driver
  });
  try {
    await assert.rejects(graph.project('tenant-1', snapshot()), /projection write failed/);
    assert.equal(graph.status().available, true);
    assert.equal(graph.status().degraded, true);
    assert.match(graph.status().projectionError, /projection write failed/);
    await assert.rejects(graph.getDomainGraph('tenant-1', 'domain-1'), /projection is degraded/);
  } finally {
    await graph.close();
  }
});

test('agent never labels DNS checks as complete while delivery is unknown', async () => {
  const detail = {
    domain: { name: 'example.test', kind: 'hosted', status: 'managed', verifiedAt: '2026-01-01T00:00:00.000Z' },
    mailboxes: [{ id: 'mailbox-1', address: 'hello@example.test', status: 'created' }],
    plan: { status: 'applied', conflicts: [] }
  };
  const inspection = {
    ok: true,
    domain: detail.domain,
    checks: [
      { scope: 'ownership', status: 'pass' },
      { scope: 'mx', status: 'pass' },
      { scope: 'spf', status: 'pass' },
      { scope: 'dkim', status: 'pass' },
      { scope: 'dmarc', status: 'managed' }
    ],
    delivery: { inbound: 'unknown', outbound: 'unknown' }
  };
  const db = { prepare: () => ({ run() {} }) };
  const graph = { status: () => ({ enabled: false, available: false, degraded: false }) };
  const domainService = {
    getDomainDetail: () => detail,
    inspectDomain: async () => inspection
  };
  const agent = createAgentService({ db, config: makeConfig(), domainService, graph });
  const result = await agent.runAgent({ tenantId: 'tenant-1', domainId: 'domain-1' });
  assert.equal(result.ok, true);
  assert.match(result.steps.find((step) => step.tool === 'plan_actions').summary, /delivery remains unverified/);
  assert.doesNotMatch(result.answer, /setup is complete/i);
  assert.match(result.answer, /delivery.*unverified/i);
});

test('timeout reconciliation is fail-closed and does not permit an immediate retry', async () => {
  const state = makeMailServerState();
  const fetchImpl = makeMockFetch(mailserverHandlers(state));
  const app = await makeTestApp({
    fetchImpl,
    dnsInspector: makeDnsInspector(makeDnsState()),
    configOverrides: {
      mailboxLimitPerAccount: 5,
      mailboxReconcileGraceMs: 1_000,
      mailserver: {
        baseUrl: 'https://mailserver.test/admin',
        username: 'admin@mailserver.test',
        password: 'mailserver-secret',
        timeoutMs: 20,
        mailHost: 'mailserver.test'
      }
    }
  });
  try {
    const account = await signup(app, 'regression@example.test');
    const domains = await request(app.base, '/api/domains', { cookie: account.sessionCookie });
    const domainId = domains.json.domains.find((domain) => domain.kind === 'hosted').id;
    state.addDelayMs = 100;
    const first = await request(app.base, '/api/mailboxes', {
      method: 'POST',
      body: { domainId, localPart: 'uncertain', password: 'uncertain-password-1' },
      cookie: account.sessionCookie,
      origin: app.base
    });
    state.addDelayMs = 0;
    assert.equal(first.status, 202);
    const mailboxId = first.json.mailbox.id;

    const reconcile = await request(app.base, `/api/mailboxes/${mailboxId}/reconcile`, {
      method: 'POST',
      body: {},
      cookie: account.sessionCookie,
      origin: app.base
    });
    assert.equal(reconcile.status, 200);
    assert.equal(reconcile.json.pending, true);
    assert.equal(reconcile.json.mailbox.status, 'uncertain');

    const retry = await request(app.base, '/api/mailboxes', {
      method: 'POST',
      body: { domainId, localPart: 'uncertain', password: 'uncertain-password-2' },
      cookie: account.sessionCookie,
      origin: app.base
    });
    assert.equal(retry.status, 202);
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 1, 'an uncertain timeout must not trigger a second add');

    app.db.prepare('UPDATE mailboxes SET updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 2_000).toISOString(), mailboxId);
    const agedReconcile = await request(app.base, `/api/mailboxes/${mailboxId}/reconcile`, {
      method: 'POST',
      body: {},
      cookie: account.sessionCookie,
      origin: app.base
    });
    assert.equal(agedReconcile.json.exists, false);
    assert.equal(agedReconcile.json.mailbox.status, 'failed');

    const safeRetry = await request(app.base, '/api/mailboxes', {
      method: 'POST',
      body: { domainId, localPart: 'uncertain', password: 'uncertain-password-3' },
      cookie: account.sessionCookie,
      origin: app.base
    });
    assert.equal(safeRetry.status, 200, JSON.stringify(safeRetry.json));
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 2);
  } finally {
    await app.close();
  }
});

test('reconcile does not fail a mailbox while its upstream add is still running', async () => {
  let addStarted;
  let releaseAdd;
  const addReady = new Promise((resolve) => { addStarted = resolve; });
  const addGate = new Promise((resolve) => { releaseAdd = resolve; });
  const fetchImpl = makeMockFetch([
    {
      match: (url, method) => method === 'GET' && url.includes('/mail/users'),
      handle: async () => ({ body: [] })
    },
    {
      match: (url, method) => method === 'POST' && url.includes('/mail/users/add'),
      handle: async () => {
        addStarted();
        await addGate;
        return { status: 200, body: 'OK' };
      }
    }
  ]);
  const app = await makeTestApp({
    fetchImpl,
    dnsInspector: makeDnsInspector(makeDnsState()),
    configOverrides: {
      mailboxLimitPerAccount: 5,
      mailserver: {
        baseUrl: 'https://mailserver.test/admin',
        username: 'admin@mailserver.test',
        password: 'mailserver-secret',
        timeoutMs: 5_000,
        mailHost: 'mailserver.test'
      }
    }
  });
  try {
    const account = await signup(app, 'inflight@example.test');
    const domains = await request(app.base, '/api/domains', { cookie: account.sessionCookie });
    const domainId = domains.json.domains.find((domain) => domain.kind === 'hosted').id;
    const createPromise = request(app.base, '/api/mailboxes', {
      method: 'POST',
      body: { domainId, localPart: 'inflight', password: 'inflight-password-1' },
      cookie: account.sessionCookie,
      origin: app.base
    });
    await addReady;
    const mailbox = app.db.prepare('SELECT id FROM mailboxes WHERE address = ?').get('inflight@example.test');
    const reconciled = await app.services.mailboxService.reconcileMailbox({
      tenantId: account.json?.user?.id || (await request(app.base, '/api/auth/me', { cookie: account.sessionCookie })).json.user.id,
      mailboxId: mailbox.id
    });
    assert.equal(reconciled.pending, true);
    assert.equal(reconciled.mailbox.status, 'creating');
    assert.equal(
      fetchImpl.calls.filter((call) => call.method === 'GET' && call.url.includes('/mail/users')).length,
      1,
      'reconcile must not race the in-flight add with another upstream read'
    );
    releaseAdd();
    const created = await createPromise;
    assert.equal(created.status, 200);
    assert.equal(fetchImpl.callsTo('/mail/users/add').length, 1);
  } finally {
    releaseAdd();
    await app.close();
  }
});
