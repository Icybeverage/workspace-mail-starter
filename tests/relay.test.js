import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTestApp,
  makeMockFetch,
  mailserverHandlers,
  makeMailServerState,
  makeDnsState,
  makeDnsInspector,
  makeCfState,
  cfHandlers,
  request,
  signup
} from './helpers.js';
import { createSendgridClient } from '../server/services/relay.js';

const RELAY_KEY = 'sendgrid-test-key-never-log-this';

function sendgridState({ exactDomain = null, valid = false } = {}) {
  return {
    domains: exactDomain ? [{
      id: 41,
      domain: exactDomain,
      valid,
      dns: {
        mail_cname: { host: `em.${exactDomain}`, data: 'u.sendgrid.net' },
        dkim1: { host: `s1._domainkey.${exactDomain}`, data: 's1.sendgrid.net' },
        dkim2: { host: `s2._domainkey.${exactDomain}`, data: 's2.sendgrid.net' }
      }
    }] : [],
    calls: [],
    nextId: 41,
    failList: false,
    delayMs: 0,
    validateValid: valid
  };
}

function sendgridHandlers(state) {
  return [
    {
      match: (url, method) => method === 'GET' && /\/v3\/whitelabel\/domains\/\d+$/.test(url),
      handle: async (url) => {
        const id = Number(url.split('/').at(-1));
        const found = state.domains.find((entry) => entry.id === id);
        return { status: found ? 200 : 404, body: found || {} };
      }
    },
    {
      match: (url, method) => method === 'GET' && url.includes('/v3/whitelabel/domains?'),
      handle: async (url) => {
        state.calls.push({ method: 'GET', url });
        if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
        if (state.failList) return { status: 503, body: { errors: [{ message: 'provider unavailable' }] } };
        const domain = new URL(url).searchParams.get('domain');
        return { body: state.domains.filter((entry) => entry.domain === domain) };
      }
    },
    {
      match: (url, method) => method === 'POST' && url.endsWith('/v3/whitelabel/domains'),
      handle: async (url, method, opts) => {
        const body = JSON.parse(String(opts.body));
        state.calls.push({ method: 'POST', url, body });
        const created = {
          id: ++state.nextId,
          domain: body.domain,
          valid: false,
          dns: {
            mail_cname: { host: `em.${body.domain}`, data: 'u.sendgrid.net' },
            dkim1: { host: `s1._domainkey.${body.domain}`, data: 's1.sendgrid.net' },
            dkim2: { host: `s2._domainkey.${body.domain}`, data: 's2.sendgrid.net' }
          }
        };
        state.domains.push(created);
        return { body: created };
      }
    },
    {
      match: (url, method) => method === 'POST' && /\/v3\/whitelabel\/domains\/\d+\/validate$/.test(url),
      handle: async (url) => {
        state.calls.push({ method: 'POST', url });
        const id = Number(url.match(/domains\/(\d+)\/validate$/)[1]);
        const found = state.domains.find((entry) => entry.id === id);
        return {
          body: {
            id,
            valid: state.validateValid,
            validation_results: { mail_cname: { valid: true }, dkim1: { valid: state.validateValid }, dkim2: { valid: state.validateValid } }
          }
        };
      }
    }
  ];
}

function setup({ relayDomain = null, relayValid = false, cf = false } = {}) {
  const mailserverState = makeMailServerState();
  const dnsState = makeDnsState();
  const cfState = makeCfState();
  const relayState = sendgridState({ exactDomain: relayDomain, valid: relayValid });
  const fetchImpl = makeMockFetch([
    ...mailserverHandlers(mailserverState),
    ...sendgridHandlers(relayState),
    ...(cf ? cfHandlers(cfState) : [])
  ]);
  return makeTestApp({
    fetchImpl,
    dnsInspector: makeDnsInspector(dnsState),
    configOverrides: {
      relay: {
        provider: 'sendgrid',
        apiKey: RELAY_KEY,
        apiBase: 'https://api.sendgrid.test/v3',
        timeoutMs: 500
      }
    }
  }).then((app) => ({ app, dnsState, mailserverState, cfState, relayState, fetchImpl }));
}

async function createCustom(app, cookie, name) {
  const result = await request(app.base, '/api/domains', {
    method: 'POST',
    body: { name },
    cookie,
    origin: app.base
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  return result.json;
}

async function verifyCustom(app, dnsState, cookie, created) {
  dnsState.verifyTxt.push(created.verifyRecord.value);
  const result = await request(app.base, `/api/domains/${created.domain.id}/verify`, {
    method: 'POST',
    body: { method: 'dns' },
    cookie,
    origin: app.base
  });
  assert.equal(result.status, 200, JSON.stringify(result.json));
}

test('relay preparation is gated by tenant ownership and verified custom-domain ownership', async () => {
  const { app, relayState } = await setup();
  try {
    const owner = await signup(app, 'relay-owner@example.test');
    const created = await createCustom(app, owner.sessionCookie, 'pending-relay.test');
    const blocked = await request(app.base, `/api/domains/${created.domain.id}/relay/prepare`, {
      method: 'POST',
      body: {},
      cookie: owner.sessionCookie,
      origin: app.base
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, 'ownership_required');
    assert.equal(relayState.calls.length, 0, 'provider must not be mutated before ownership verification');
  } finally {
    await app.close();
  }
});

test('relay lookup is exact and preparation is idempotent with public CNAME output only', async () => {
  const { app, dnsState, relayState } = await setup({ relayDomain: 'other-relay.test' });
  try {
    const owner = await signup(app, 'relay-owner@example.test');
    const created = await createCustom(app, owner.sessionCookie, 'exact-relay.test');
    await verifyCustom(app, dnsState, owner.sessionCookie, created);

    const prepared = await request(app.base, `/api/domains/${created.domain.id}/relay/prepare`, {
      method: 'POST',
      body: {},
      cookie: owner.sessionCookie,
      origin: app.base
    });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.json));
    assert.equal(prepared.json.relay.domain, 'exact-relay.test');
    assert.equal(prepared.json.relay.status, 'pending');
    assert.equal(prepared.json.dnsRecords.length, 3);
    assert.ok(!JSON.stringify(prepared.json).includes('provider_domain_id'));
    assert.ok(prepared.json.dnsRecords.every((record) => record.type === 'CNAME'));
    assert.equal(relayState.calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(relayState.calls.filter((call) => call.method === 'POST')[0].body.default, false);
    assert.equal(relayState.calls.filter((call) => call.method === 'POST')[0].body.automatic_security, true);

    const retry = await request(app.base, `/api/domains/${created.domain.id}/relay/prepare`, {
      method: 'POST',
      body: {},
      cookie: owner.sessionCookie,
      origin: app.base
    });
    assert.equal(retry.status, 200, JSON.stringify(retry.json));
    assert.equal(relayState.calls.filter((call) => call.method === 'POST').length, 1, 'retry must reuse the exact existing provider record');
    assert.equal(relayState.calls.filter((call) => call.method === 'GET').length, 2);
  } finally {
    await app.close();
  }
});

test('relay state is tenant isolated and hosted domains cannot be changed by a tenant', async () => {
  const { app, dnsState, relayState } = await setup({ relayDomain: 'example.test', relayValid: true });
  try {
    const first = await signup(app, 'first-relay@example.test');
    const second = await signup(app, 'second-relay@example.test');
    const created = await createCustom(app, first.sessionCookie, 'private-relay.test');
    await verifyCustom(app, dnsState, first.sessionCookie, created);

    const foreign = await request(app.base, `/api/domains/${created.domain.id}/relay/prepare`, {
      method: 'POST',
      body: {},
      cookie: second.sessionCookie,
      origin: app.base
    });
    assert.equal(foreign.status, 404);
    assert.equal(relayState.calls.filter((call) => call.method === 'POST').length, 0);

    const domains = await request(app.base, '/api/domains', { cookie: first.sessionCookie });
    const hosted = domains.json.domains.find((domain) => domain.kind === 'hosted');
    const hostedRead = await request(app.base, `/api/domains/${hosted.id}/relay`, { cookie: first.sessionCookie });
    assert.equal(hostedRead.status, 200);
    assert.equal(hostedRead.json.relay.status, 'verified');
    const hostedPrepare = await request(app.base, `/api/domains/${hosted.id}/relay/prepare`, {
      method: 'POST',
      body: {},
      cookie: first.sessionCookie,
      origin: app.base
    });
    assert.equal(hostedPrepare.status, 403);
    assert.equal(hostedPrepare.json.error.code, 'hosted_relay_managed');
  } finally {
    await app.close();
  }
});

test('relay provider errors and timeouts are bounded and redacted', async () => {
  const state = sendgridState();
  const loggerLines = [];
  const client = createSendgridClient({
    apiKey: RELAY_KEY,
    baseUrl: 'https://api.sendgrid.test/v3',
    timeout: 250,
    logger: { info: (...args) => loggerLines.push(args), warn: (...args) => loggerLines.push(args) },
    fetchImpl: async (_url, opts) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        opts.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('aborted');
          error.name = 'TimeoutError';
          reject(error);
        });
      });
      return new Response('[]', { status: 200 });
    }
  });
  const started = Date.now();
  const result = await client.listExact('timeout-relay.test');
  assert.ok(Date.now() - started < 800, 'provider timeout must be bounded');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'The outgoing email provider did not respond in time.');
  assert.ok(!JSON.stringify(loggerLines).includes(RELAY_KEY));
  assert.ok(!JSON.stringify(state).includes(RELAY_KEY));
});

test('relay CNAMEs participate in the hashed manual and Cloudflare DNS plan without deleting unrelated records', async () => {
  const { app, dnsState, cfState } = await setup({ cf: true });
  try {
    const owner = await signup(app, 'relay-plan@example.test');
    const created = await createCustom(app, owner.sessionCookie, 'relay-plan.test');
    await verifyCustom(app, dnsState, owner.sessionCookie, created);
    const prepared = await request(app.base, `/api/domains/${created.domain.id}/relay/prepare`, {
      method: 'POST',
      body: {},
      cookie: owner.sessionCookie,
      origin: app.base
    });
    assert.equal(prepared.status, 200);
    cfState.zones.push({ id: 'relay-zone', name: 'relay-plan.test' });
    dnsState.verifyTxt.push('unused');

    const plan = await request(app.base, `/api/domains/${created.domain.id}/plan`, {
      method: 'POST',
      body: {},
      cookie: owner.sessionCookie,
      origin: app.base
    });
    assert.equal(plan.status, 200, JSON.stringify(plan.json));
    const relayRecords = plan.json.plan.records.filter((record) => record.key.startsWith('relay:'));
    assert.equal(relayRecords.length, 3);
    assert.ok(plan.json.plan.planHash);

    const manual = await request(app.base, `/api/domains/${created.domain.id}/plan/apply`, {
      method: 'POST',
      body: { planId: plan.json.plan.id, planHash: plan.json.plan.planHash, method: 'manual', approvals: { mx: true } },
      cookie: owner.sessionCookie,
      origin: app.base
    });
    assert.equal(manual.status, 200, JSON.stringify(manual.json));
    assert.ok(manual.json.instructions.some((instruction) => instruction.fqdn === 'em.relay-plan.test'));
  } finally {
    await app.close();
  }
});

test('configured relay authentication blocks activation while pending and passes after exact validation', async () => {
  const { app, dnsState, mailserverState, relayState } = await setup();
  try {
    const owner = await signup(app, 'relay-activation@example.test');
    const created = await createCustom(app, owner.sessionCookie, 'relay-activation.test');
    await verifyCustom(app, dnsState, owner.sessionCookie, created);
    dnsState.mx = [{ priority: 10, exchange: 'mailserver.test' }];
    dnsState.txt = ['v=spf1 mx -all'];
    dnsState.dkim = ['v=DKIM1; p=KEY'];
    dnsState.dmarc = ['v=DMARC1; p=quarantine;'];
    mailserverState.dump = [['relay-activation.test', [
      { qname: 'relay-activation.test', rtype: 'MX', value: '10 mailserver.test.' },
      { qname: 'relay-activation.test', rtype: 'TXT', value: 'v=spf1 mx -all' },
      { qname: 'mail._domainkey.relay-activation.test', rtype: 'TXT', value: 'v=DKIM1; p=KEY' },
      { qname: '_dmarc.relay-activation.test', rtype: 'TXT', value: 'v=DMARC1; p=quarantine;' }
    ]]];
    const pending = await request(app.base, `/api/domains/${created.domain.id}/activate`, {
      method: 'POST',
      body: {},
      cookie: owner.sessionCookie,
      origin: app.base
    });
    assert.equal(pending.status, 409);
    assert.ok(pending.json.error.blockers.some((blocker) => blocker.scope === 'relay'));
    assert.match(pending.json.error.blockers.find((blocker) => blocker.scope === 'relay').detail, /SendGrid|CNAME/i);

    const prepared = await request(app.base, `/api/domains/${created.domain.id}/relay/prepare`, {
      method: 'POST',
      body: {},
      cookie: owner.sessionCookie,
      origin: app.base
    });
    assert.equal(prepared.status, 200);
    relayState.validateValid = true;
    const validated = await request(app.base, `/api/domains/${created.domain.id}/relay/validate`, {
      method: 'POST',
      body: {},
      cookie: owner.sessionCookie,
      origin: app.base
    });
    assert.equal(validated.status, 200, JSON.stringify(validated.json));
    assert.equal(validated.json.relay.status, 'verified');
    const inspected = await request(app.base, `/api/domains/${created.domain.id}/inspect`, { cookie: owner.sessionCookie });
    assert.equal(inspected.json.checks.find((check) => check.scope === 'relay').status, 'pass');
  } finally {
    await app.close();
  }
});
