import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp, makeMockFetch, mailserverHandlers, makeMailServerState, makeDnsState, makeDnsInspector, makeCfState, cfHandlers, request, signup } from './helpers.js';

function setup({ mailserverState = makeMailServerState(), cfState = makeCfState() } = {}) {
  const dnsState = makeDnsState();
  const fetchImpl = makeMockFetch([...mailserverHandlers(mailserverState), ...cfHandlers(cfState)]);
  return makeTestApp({
    fetchImpl,
    dnsInspector: makeDnsInspector(dnsState),
    configOverrides: {}
  }).then((app) => {
    app.dnsState = dnsState;
    app.cfState = cfState;
    return { app, dnsState, mailserverState, cfState, fetchImpl };
  });
}

async function verifiedDomain(app, cookie, name) {
  const created = await request(app.base, '/api/domains', {
    method: 'POST', body: { name }, cookie, origin: app.base
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const { domain, verifyRecord } = created.json;
  app.dnsState.verifyTxt.push(verifyRecord.value);
  const verified = await request(app.base, `/api/domains/${domain.id}/verify`, {
    method: 'POST', body: { method: 'dns' }, cookie, origin: app.base
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.json));
  return domain.id;
}

function createPlan(app, cookie, domainId) {
  return request(app.base, `/api/domains/${domainId}/plan`, {
    method: 'POST', body: {}, cookie, origin: app.base
  });
}

function applyPlan(app, cookie, domainId, body) {
  return request(app.base, `/api/domains/${domainId}/plan/apply`, {
    method: 'POST', body, cookie, origin: app.base
  });
}

test('plan creation: recommended MX/SPF/DMARC with DKIM pending, plan hash bound to approvals', async () => {
  const { app } = await setup();
  try {
    const a = await signup(app, 'planner@example.test');
    const domainId = await verifiedDomain(app, a.sessionCookie, 'alpha-plan.test');

    const plan = await createPlan(app, a.sessionCookie, domainId);
    assert.equal(plan.status, 200, JSON.stringify(plan.json));
    const records = plan.json.plan.records;
    const byKey = Object.fromEntries(records.map((r) => [r.key, r]));

    assert.equal(byKey['mx:@'].action, 'create');
    assert.equal(byKey['mx:@'].requiresMxApproval, true);
    assert.equal(byKey['spf:@'].action, 'create');
    assert.equal(byKey['spf:@'].proposed, 'v=spf1 mx -all');
    assert.equal(byKey['dkim:mail'].action, 'pending_upstream');
    assert.equal(byKey['dmarc:_dmarc'].action, 'create');
    assert.deepEqual(plan.json.plan.approvalsRequired, ['mx']);
    assert.ok(plan.json.plan.planHash);
    assert.equal(plan.json.plan.delivery.inbound, 'unknown');

    // Domain status moved to dns_planned; nothing written anywhere yet.
    const detail = await request(app.base, `/api/domains/${domainId}`, { cookie: a.sessionCookie });
    assert.equal(detail.json.domain.status, 'dns_planned');
  } finally {
    await app.close();
  }
});

test('dry run returns the operations preview and writes nothing', async () => {
  const { app } = await setup();
  try {
    const a = await signup(app, 'planner@example.test');
    const domainId = await verifiedDomain(app, a.sessionCookie, 'alpha-plan.test');
    const plan = (await createPlan(app, a.sessionCookie, domainId)).json.plan;

    const dry = await applyPlan(app, a.sessionCookie, domainId, {
      planId: plan.id, planHash: plan.planHash, method: 'manual', dryRun: true
    });
    assert.equal(dry.status, 200, JSON.stringify(dry.json));
    assert.equal(dry.json.dryRun, true);
    assert.ok(Array.isArray(dry.json.operations) && dry.json.operations.length >= 3);

    const row = app.db.prepare('SELECT status FROM dns_plans WHERE id = ?').get(plan.id);
    assert.equal(row.status, 'draft', 'dry run must not consume the plan');
    const domainRow = app.db.prepare('SELECT status FROM domains WHERE id = ?').get(domainId);
    assert.equal(domainRow.status, 'dns_planned');
    const manualActivity = app.db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'domain.plan.manual'").get().n;
    assert.equal(manualActivity, 0);
  } finally {
    await app.close();
  }
});

test('SPF conflicts block apply until resolved manually', async () => {
  const { app, dnsState } = await setup();
  try {
    const a = await signup(app, 'planner@example.test');
    const domainId = await verifiedDomain(app, a.sessionCookie, 'alpha-plan.test');
    dnsState.txt.push('v=spf1 include:first.test ~all', 'v=spf1 include:second.test ~all');

    const plan = (await createPlan(app, a.sessionCookie, domainId)).json.plan;
    assert.ok(plan.conflicts.some((c) => c.type === 'spf'));
    assert.equal(plan.records.find((r) => r.key === 'spf:@').action, 'conflict');

    const apply = await applyPlan(app, a.sessionCookie, domainId, {
      planId: plan.id, planHash: plan.planHash, method: 'manual', approvals: { mx: true }
    });
    assert.equal(apply.status, 409);
    assert.equal(apply.json.error.code, 'conflicts_unresolved');
    assert.equal(app.db.prepare('SELECT status FROM dns_plans WHERE id = ?').get(plan.id).status, 'draft');
  } finally {
    await app.close();
  }
});

test('a mismatched plan hash is rejected', async () => {
  const { app } = await setup();
  try {
    const a = await signup(app, 'planner@example.test');
    const domainId = await verifiedDomain(app, a.sessionCookie, 'alpha-plan.test');
    const plan = (await createPlan(app, a.sessionCookie, domainId)).json.plan;

    const apply = await applyPlan(app, a.sessionCookie, domainId, {
      planId: plan.id, planHash: 'f'.repeat(64), method: 'manual', approvals: { mx: true }
    });
    assert.equal(apply.status, 409);
    assert.equal(apply.json.error.code, 'plan_mismatch');
  } finally {
    await app.close();
  }
});

test('MX replacement requires explicit approval bound to the stored plan', async () => {
  const { app } = await setup();
  try {
    const a = await signup(app, 'planner@example.test');
    const domainId = await verifiedDomain(app, a.sessionCookie, 'alpha-plan.test');
    const plan = (await createPlan(app, a.sessionCookie, domainId)).json.plan;

    const unapproved = await applyPlan(app, a.sessionCookie, domainId, {
      planId: plan.id, planHash: plan.planHash, method: 'manual', approvals: {}
    });
    assert.equal(unapproved.status, 400);
    assert.equal(unapproved.json.error.code, 'mx_approval_required');
    assert.equal(unapproved.json.error.requireApproval, 'mx');

    const approved = await applyPlan(app, a.sessionCookie, domainId, {
      planId: plan.id, planHash: plan.planHash, method: 'manual', approvals: { mx: true }
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.json.method, 'manual');
    const fqdns = approved.json.instructions.map((i) => i.fqdn);
    assert.ok(fqdns.includes('alpha-plan.test'));
    assert.ok(fqdns.includes('_dmarc.alpha-plan.test'));

    const planRow = app.db.prepare('SELECT status, approved_mx_hash FROM dns_plans WHERE id = ?').get(plan.id);
    assert.equal(planRow.status, 'manual');
    assert.equal(planRow.approved_mx_hash, plan.planHash);
    assert.equal(app.db.prepare('SELECT status FROM domains WHERE id = ?').get(domainId).status, 'dns_manual_pending');
  } finally {
    await app.close();
  }
});

test('a superseded plan cannot be applied', async () => {
  const { app } = await setup();
  try {
    const a = await signup(app, 'planner@example.test');
    const domainId = await verifiedDomain(app, a.sessionCookie, 'alpha-plan.test');
    const v1 = (await createPlan(app, a.sessionCookie, domainId)).json.plan;
    const v2 = (await createPlan(app, a.sessionCookie, domainId)).json.plan;
    assert.equal(v2.version, v1.version + 1);

    const apply = await applyPlan(app, a.sessionCookie, domainId, {
      planId: v1.id, planHash: v1.planHash, method: 'manual', approvals: { mx: true }
    });
    assert.equal(apply.status, 409);
    assert.equal(apply.json.error.code, 'plan_not_draft');
  } finally {
    await app.close();
  }
});

test('stale DNS (records changed since planning) is rejected before any write', async () => {
  const { app, dnsState, fetchImpl } = await setup();
  try {
    const a = await signup(app, 'planner@example.test');
    const domainId = await verifiedDomain(app, a.sessionCookie, 'alpha-plan.test');
    const plan = (await createPlan(app, a.sessionCookie, domainId)).json.plan;

    // Something changed in DNS after planning (a third party added DMARC).
    dnsState.dmarc.push('v=DMARC1; p=reject;');
    const apply = await applyPlan(app, a.sessionCookie, domainId, {
      planId: plan.id, planHash: plan.planHash, method: 'manual', approvals: { mx: true }
    });
    assert.equal(apply.status, 409, JSON.stringify(apply.json));
    assert.equal(apply.json.error.code, 'plan_stale_dns');
    assert.equal(app.db.prepare('SELECT status FROM dns_plans WHERE id = ?').get(plan.id).status, 'draft');
    assert.equal(fetchImpl.callsTo('cloudflare.com').length, 0);
  } finally {
    await app.close();
  }
});

async function cfConnectedDomain(app, cookie, name) {
  const created = await request(app.base, '/api/domains', {
    method: 'POST', body: { name }, cookie, origin: app.base
  });
  const { domain, verifyRecord } = created.json;
  app.cfState.zones.push({ id: 'zone-1', name });
  const first = await request(app.base, `/api/domains/${domain.id}/verify`, {
    method: 'POST', body: { method: 'cloudflare', cfToken: 'cf-token-plan-1' }, cookie, origin: app.base
  });
  assert.equal(first.status, 409); // written, propagation pending
  app.dnsState.verifyTxt.push(verifyRecord.value);
  const second = await request(app.base, `/api/domains/${domain.id}/verify`, {
    method: 'POST', body: { method: 'cloudflare' }, cookie, origin: app.base
  });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  return domain.id;
}

test('cloudflare apply: creates only the reviewed records, never deletes unrelated ones', async () => {
  const { app, cfState, dnsState } = await setup();
  try {
    const a = await signup(app, 'planner@example.test');
    const domainId = await cfConnectedDomain(app, a.sessionCookie, 'beta-cf.test');

    // An unrelated website record that must survive the whole flow.
    cfState.records.set('www-1', { id: 'www-1', zoneId: 'zone-1', type: 'A', name: 'www.beta-cf.test', content: '203.0.113.7', ttl: 300 });

    const plan = (await createPlan(app, a.sessionCookie, domainId)).json.plan;
    assert.equal(plan.sources.desired, 'recommended_default');

    const applied = await applyPlan(app, a.sessionCookie, domainId, {
      planId: plan.id, planHash: plan.planHash, method: 'cloudflare', approvals: { mx: true }
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.json));
    assert.equal(applied.json.summary.errors, 0);
    assert.equal(applied.json.summary.created, 3); // MX + SPF + DMARC (DKIM is pending upstream)
    assert.equal(applied.json.summary.updated, 0);

    const values = [...cfState.records.values()];
    const mx = values.find((r) => r.type === 'MX');
    assert.equal(mx.content, 'mailserver.test');
    assert.equal(mx.priority, 10);
    assert.ok(values.find((r) => r.type === 'TXT' && r.content === 'v=spf1 mx -all'));
    assert.ok(values.find((r) => r.type === 'TXT' && r.name === '_dmarc.beta-cf.test' && r.content.startsWith('v=DMARC1')));
    assert.ok(values.find((r) => r.id === 'www-1' && r.content === '203.0.113.7'), 'unrelated A record preserved');
    assert.ok(cfState.calls.every((c) => c.op !== 'delete'), 'no deletes in a create-only apply');

    const domainRow = app.db.prepare('SELECT status FROM domains WHERE id = ?').get(domainId);
    assert.equal(domainRow.status, 'dns_applied');
    const planRow = app.db.prepare('SELECT status, approved_mx_hash FROM dns_plans WHERE id = ?').get(plan.id);
    assert.equal(planRow.status, 'applied');
    assert.equal(planRow.approved_mx_hash, plan.planHash);

    // Post-apply inspection still refuses to claim delivery.
    const detail = await request(app.base, `/api/domains/${domainId}`, { cookie: a.sessionCookie });
    assert.equal(detail.json.delivery.inbound, 'unknown');
    assert.match(detail.json.delivery.note, /not verified|unknown/i);
  } finally {
    await app.close();
  }
});

test('cloudflare apply: updated records are backed up; provider drift rejects stale plans', async () => {
  const { app, cfState, dnsState } = await setup();
  try {
    const a = await signup(app, 'planner@example.test');
    const domainId = await cfConnectedDomain(app, a.sessionCookie, 'gamma-cf.test');

    // An existing third-party SPF that planned merge will extend.
    cfState.records.set('spf-1', {
      id: 'spf-1', zoneId: 'zone-1', type: 'TXT', name: 'gamma-cf.test', content: 'v=spf1 include:thirdparty.test ~all', ttl: 300
    });
    dnsState.txt.push('v=spf1 include:thirdparty.test ~all');

    const plan = (await createPlan(app, a.sessionCookie, domainId)).json.plan;
    const spf = plan.records.find((r) => r.key === 'spf:@');
    assert.equal(spf.action, 'update');
    assert.equal(spf.proposed, 'v=spf1 include:thirdparty.test mx ~all');

    // Provider drift after planning: a record changed behind our back.
    cfState.records.set('drift-1', { id: 'drift-1', zoneId: 'zone-1', type: 'A', name: 'api.gamma-cf.test', content: '198.51.100.9', ttl: 300 });
    const staleApply = await applyPlan(app, a.sessionCookie, domainId, {
      planId: plan.id, planHash: plan.planHash, method: 'cloudflare', approvals: { mx: true }
    });
    assert.equal(staleApply.status, 409, JSON.stringify(staleApply.json));
    assert.equal(staleApply.json.error.code, 'plan_stale_provider');
    assert.equal(app.db.prepare('SELECT status FROM dns_plans WHERE id = ?').get(plan.id).status, 'draft');

    // Re-plan against the current provider state, then apply.
    const replan = (await createPlan(app, a.sessionCookie, domainId)).json.plan;
    const applied = await applyPlan(app, a.sessionCookie, domainId, {
      planId: replan.id, planHash: replan.planHash, method: 'cloudflare', approvals: { mx: true }
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.json));
    assert.equal(applied.json.summary.updated, 1);
    assert.equal(applied.json.summary.errors, 0);

    // The updated SPF's prior value is preserved in the backup table.
    const backups = app.db.prepare('SELECT * FROM cf_backups').all();
    const spfBackup = backups.find((b) => b.record_key.includes('spf') || b.record_type === 'TXT');
    assert.ok(spfBackup, 'updated record must be backed up');
    assert.ok(spfBackup.prior_json.includes('include:thirdparty.test'));
    assert.ok(cfState.records.get('spf-1').content.includes('include:thirdparty.test'));
    assert.ok(cfState.records.get('spf-1').content.includes('mx'));
    assert.ok(cfState.records.get('drift-1'), 'unrelated drift record untouched');
    assert.ok(cfState.calls.every((c) => c.op !== 'delete'), 'no deletes');
  } finally {
    await app.close();
  }
});

test('activation is blocked by failing checks and never claims delivery', async () => {
  const { app } = await setup();
  try {
    const a = await signup(app, 'planner@example.test');
    const domainId = await verifiedDomain(app, a.sessionCookie, 'alpha-plan.test');

    const blocked = await request(app.base, `/api/domains/${domainId}/activate`, {
      method: 'POST', body: {}, cookie: a.sessionCookie, origin: app.base
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, 'activation_blocked');
    const scopes = blocked.json.error.blockers.map((b) => b.scope);
    assert.ok(scopes.includes('mx'));
    assert.ok(scopes.includes('spf'));
    assert.ok(blocked.json.error.graphHint.length > 0);
  } finally {
    await app.close();
  }
});
