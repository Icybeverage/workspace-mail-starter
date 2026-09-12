import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphService, nodeId, pruneProps } from '../server/services/graph.js';
import { makeConfig, makeTestApp, makeMockFetch, mailserverHandlers, makeMailServerState, makeDnsState, makeDnsInspector, request, signup, captureLogger, sleep } from './helpers.js';

function makeFakeDriver() {
  const runCalls = [];
  let closed = false;
  const driver = {
    async verifyConnectivity() { /* always reachable */ },
    session() {
      return {
        async run(cypher, params) {
          runCalls.push({ cypher, params });
          return { records: [] };
        },
        async close() { /* no-op */ }
      };
    },
    async close() { closed = true; }
  };
  return { driver, runCalls, isClosed: () => closed };
}

test('projection writes are tenant-scoped and ids are tenant-prefixed', async () => {
  const config = makeConfig();
  const fake = makeFakeDriver();
  const graph = createGraphService({ config, logger: captureLogger(), driverFactory: () => fake.driver });

  const dnsState = makeDnsState();
  const app = await makeTestApp({
    fetchImpl: makeMockFetch(mailserverHandlers(makeMailServerState())),
    dnsInspector: makeDnsInspector(dnsState),
    graph
  });
  try {
    const a = await signup(app, 'alpha@example.test');
    const me = await request(app.base, '/api/auth/me', { cookie: a.sessionCookie });
    const tenantId = me.json.user.id;

    const created = await request(app.base, '/api/domains', {
      method: 'POST', body: { name: 'alpha-graph.test' }, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(created.status, 200);
    await sleep(150); // projection is fire-and-forget after the response

    assert.ok(fake.runCalls.length > 0, 'projection must have run');
    for (const call of fake.runCalls) {
      assert.equal(call.params.tenantId, tenantId, `every graph query must carry the tenant scope: ${call.cypher.slice(0, 40)}`);
    }

    const nodeCall = fake.runCalls.find((c) => Array.isArray(c.params.nodes));
    assert.ok(nodeCall, 'a node-merge call must have happened');
    for (const node of nodeCall.params.nodes) {
      assert.ok(node.id.startsWith(`t:${tenantId}:`), `node ids must be tenant-prefixed: ${node.id}`);
      for (const key of Object.keys(node.props)) {
        assert.ok(!/password|token|secret|credential/i.test(key), `credential-ish prop in graph: ${key}`);
      }
    }
    assert.ok(nodeCall.params.nodes.some((n) => n.label === 'Domain' && n.id === `t:${tenantId}:Domain:${created.json.domain.id}`));
  } finally {
    await app.close();
  }
});

test('graph service is strictly scoped: foreign ids return no nodes and driver receives the caller tenant', async () => {
  const config = makeConfig();
  const fake = makeFakeDriver();
  const graph = createGraphService({ config, logger: captureLogger(), driverFactory: () => fake.driver });

  const dnsState = makeDnsState();
  const app = await makeTestApp({
    fetchImpl: makeMockFetch(mailserverHandlers(makeMailServerState())),
    dnsInspector: makeDnsInspector(dnsState),
    graph
  });
  try {
    const a = await signup(app, 'alpha@example.test');
    const b = await signup(app, 'beta@example.test');
    const meB = await request(app.base, '/api/auth/me', { cookie: b.sessionCookie });
    const tenantB = meB.json.user.id;

    const created = await request(app.base, '/api/domains', {
      method: 'POST', body: { name: 'alpha-graph.test' }, cookie: a.sessionCookie, origin: app.base
    });
    const domainA = created.json.domain.id;
    await sleep(150);

    const g = await request(app.base, `/api/domains/${domainA}/graph`, { cookie: b.sessionCookie });
    assert.equal(g.status, 200, JSON.stringify(g.json));
    assert.deepEqual(g.json.graph.nodes, [], 'tenant B sees no nodes for another tenant domain');

    const graphCalls = fake.runCalls.filter((c) => c.cypher.includes('WorkspaceEntity') && c.params.domainId);
    assert.ok(graphCalls.length > 0);
    for (const call of graphCalls) {
      assert.equal(call.params.tenantId, tenantB);
      assert.equal(call.params.domainId, nodeId(tenantB, 'Domain', domainA), 'scoping id must be minted for the calling tenant');
    }
  } finally {
    await app.close();
  }
});

test('unconfigured graph: honest 503 degraded, never fabricated graph data', async () => {
  const dnsState = makeDnsState();
  const app = await makeTestApp({
    fetchImpl: makeMockFetch(mailserverHandlers(makeMailServerState())),
    dnsInspector: makeDnsInspector(dnsState)
  });
  try {
    const a = await signup(app, 'alpha@example.test');
    const created = await request(app.base, '/api/domains', {
      method: 'POST', body: { name: 'alpha-graph.test' }, cookie: a.sessionCookie, origin: app.base
    });
    const domainId = created.json.domain.id;

    const g = await request(app.base, `/api/domains/${domainId}/graph`, { cookie: a.sessionCookie });
    assert.equal(g.status, 503);
    assert.equal(g.json.error.code, 'graph_unavailable');
    assert.equal(g.json.error.degraded, true);
    assert.equal(g.json.error.graphStatus.enabled, false);
    assert.equal(g.json.graph, undefined, 'no fake graph payload when Neo4j is unavailable');

    const impact = await request(app.base, `/api/domains/${domainId}/impact?recordId=x`, { cookie: a.sessionCookie });
    assert.equal(impact.status, 503);
    assert.equal(impact.json.error.code, 'graph_unavailable');
    assert.equal(impact.json.error.degraded, true);

    const health = await request(app.base, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.dependencies.neo4j.configured, false);
  } finally {
    await app.close();
  }
});

test('pruneProps strips credential-looking fields before projection', () => {
  const out = pruneProps({
    address: 'hello@example.test',
    status: 'created',
    password: 'nope',
    verify_token: 'nope',
    cfToken: 'nope',
    apiKey: 'nope',
    updatedAt: '2026-01-01T00:00:00.000Z',
    empty: undefined
  });
  assert.deepEqual(out, {
    address: 'hello@example.test',
    status: 'created',
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
});

test('nodeId embeds tenant and label so ids are globally unique per tenant', () => {
  assert.equal(nodeId('u1', 'Domain', 'd1'), 't:u1:Domain:d1');
  assert.notEqual(nodeId('u1', 'Mailbox', 'x'), nodeId('u2', 'Mailbox', 'x'));
});
