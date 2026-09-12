import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/lib/env.js';
import { createApp } from '../server/app.js';
import { createLogger } from '../server/lib/log.js';

export function makeConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
  return loadConfig({
    skipDotEnv: true,
    nodeEnv: 'test',
    dataDir: dir,
    dbPath: path.join(dir, 'test.sqlite'),
    basePath: '/launch',
    hostedDomain: 'example.test',
    mailboxLimitPerAccount: 1,
    globalMailboxCap: 25,
    vaultKey: Buffer.alloc(32, 7),
    mailserver: {
      baseUrl: 'https://mailserver.test/admin',
      username: 'admin@mailserver.test',
      password: 'mailserver-secret',
      timeoutMs: 200,
      mailHost: 'mailserver.test'
    },
    neo4j: { uri: '', username: 'neo4j', password: '' },
    ...overrides
  });
}

export function makeMockFetch(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    const call = { url: u, method, body: opts.body ? String(opts.body) : null, headers: opts.headers || {} };
    calls.push(call);
    for (const h of handlers) {
      const matched = typeof h.match === 'function' ? h.match(u, method) : u.includes(h.match);
      if (!matched) continue;
      if (h.matchMethod && h.matchMethod !== method) continue;
      if (h.delayMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, h.delayMs);
          if (opts.signal) {
            if (opts.signal.aborted) {
              clearTimeout(t);
              const e = new Error('The operation was aborted');
              e.name = 'TimeoutError';
              reject(e);
              return;
            }
            opts.signal.addEventListener('abort', () => {
              clearTimeout(t);
              const e = new Error('The operation was aborted');
              e.name = 'TimeoutError';
              reject(e);
            });
          }
        });
      }
      const res = await h.handle(u, method, opts);
      const body = res.body === undefined ? null : (typeof res.body === 'string' ? res.body : JSON.stringify(res.body));
      return new Response(body, { status: res.status || 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'mock: no handler', url: u }), { status: 404, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  fn.callsTo = (needle) => calls.filter((c) => c.url.includes(needle));
  return fn;
}

export function makeMailServerState() {
  return { users: [], dump: null, zoneAdds: [], addFailures: 0, addDelayMs: 0 };
}

export function mailserverHandlers(state) {
  return [
    {
      match: (u, m) => m === 'GET' && u.includes('/mail/users'),
      handle: async () => ({ body: state.users })
    },
    {
      match: (u, m) => m === 'POST' && u.includes('/mail/users/add'),
      handle: async (u, m, opts) => {
        if (state.addDelayMs) {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, state.addDelayMs);
            if (opts.signal) {
              const onAbort = () => {
                clearTimeout(t);
                const e = new Error('The operation was aborted');
                e.name = 'TimeoutError';
                reject(e);
              };
              if (opts.signal.aborted) return onAbort();
              opts.signal.addEventListener('abort', onAbort);
            }
          });
        }
        if (state.addFailures > 0) {
          state.addFailures -= 1;
          return { status: 400, body: 'Invalid password' };
        }
        const params = new URLSearchParams(String(opts.body || ''));
        const email = params.get('email');
        state.users.push({ email, privileges: [] });
        state.lastAddPrivileges = params.get('privileges');
        state.lastAddPassword = params.get('password');
        return { status: 200, body: 'OK' };
      }
    },
    {
      match: (u, m) => m === 'GET' && u.includes('/dns/dump'),
      handle: async () => (state.dump === null
        ? { status: 404, body: { error: 'no dump' } }
        : { body: state.dump })
    },
    {
      match: (u, m) => m === 'GET' && u.includes('/dns/zones'),
      handle: async () => ({ body: state.zones || ['example.test'] })
    },
    {
      match: (u, m) => m === 'POST' && u.includes('/dns/zones/add'),
      handle: async (u, m, opts) => {
        const params = new URLSearchParams(String(opts.body || ''));
        state.zoneAdds.push(params.get('zone'));
        return { status: 200, body: 'OK' };
      }
    }
  ];
}

export function makeCfState() {
  return { zones: [], records: new Map(), tokenValid: true, calls: [] };
}

export function cfHandlers(state) {
  return [
    { match: (u) => u.includes('/user/tokens/verify'), handle: async () => (state.tokenValid ? { body: { success: true, result: { status: 'active' } } } : { status: 403, body: { success: false, errors: [{ message: 'Invalid token' }] } }) },
    {
      match: (u, m) => m === 'GET' && u.includes('/zones?'),
      handle: async (u) => {
        const name = new URL(u).searchParams.get('name');
        return { body: { success: true, result: state.zones.filter((z) => z.name === name) } };
      }
    },
    {
      match: (u, m) => m === 'GET' && /\/zones\/[^/]+\/dns_records/.test(u),
      handle: async (u) => {
        const zoneId = u.match(/\/zones\/([^/]+)\/dns_records/)[1];
        const list = [...state.records.values()].filter((r) => r.zoneId === zoneId);
        return { body: { success: true, result: list.map(({ zoneId: _z, ...rest }) => rest) } };
      }
    },
    {
      match: (u, m) => m === 'POST' && /\/zones\/[^/]+\/dns_records$/.test(u),
      handle: async (u, m, opts) => {
        const zoneId = u.match(/\/zones\/([^/]+)\/dns_records/)[1];
        const body = JSON.parse(String(opts.body));
        const id = `rec-${state.records.size + 1}`;
        state.records.set(id, { id, zoneId, ...body });
        state.calls.push({ op: 'create', name: body.name, type: body.type });
        return { body: { success: true, result: { id, ...body } } };
      }
    },
    {
      match: (u, m) => m === 'PUT' && /\/zones\/[^/]+\/dns_records\/[^/]+$/.test(u),
      handle: async (u, m, opts) => {
        const [, zoneId, recId] = u.match(/\/zones\/([^/]+)\/dns_records\/([^/]+)$/);
        const body = JSON.parse(String(opts.body));
        state.records.set(recId, { id: recId, zoneId, ...body });
        state.calls.push({ op: 'update', name: body.name, type: body.type });
        return { body: { success: true, result: { id: recId, ...body } } };
      }
    }
  ];
}

export function makeDnsState() {
  return {
    mx: [],
    txt: [],
    dkim: [],
    dmarc: [],
    verifyTxt: []
  };
}

export function makeDnsInspector(state) {
  return {
    state,
    async inspect(domain) {
      return {
        domain,
        checkedAt: new Date().toISOString(),
        dnsStatus: { mx: state.mx.length ? 'answered' : 'ENOTFOUND', txt: 'answered', dkim: state.dkim.length ? 'answered' : 'ENOTFOUND', dmarc: state.dmarc.length ? 'answered' : 'ENOTFOUND' },
        mx: state.mx,
        txt: state.txt,
        spf: { records: state.txt.filter((t) => t.startsWith('v=spf1')), count: state.txt.filter((t) => t.startsWith('v=spf1')).length, valid: state.txt.filter((t) => t.startsWith('v=spf1')).length === 1 },
        dkim: { selector: 'mail', records: state.dkim, present: state.dkim.length > 0 },
        dmarc: { records: state.dmarc, present: state.dmarc.length > 0 }
      };
    },
    async txt(name) {
      if (name.startsWith('_workspace-verify.')) {
        return { ok: state.verifyTxt.length > 0, values: state.verifyTxt, code: state.verifyTxt.length ? 'ok' : 'ENOTFOUND' };
      }
      return { ok: false, values: [], code: 'ENOTFOUND' };
    }
  };
}

export function captureLogger() {
  const lines = [];
  const stream = { write: (s) => { lines.push(s); return true; } };
  const logger = createLogger({ name: 'test', stream });
  logger.lines = lines;
  return logger;
}

export async function makeTestApp({ configOverrides = {}, fetchImpl, dnsInspector, graph, logger, workspaceReader } = {}) {
  const config = makeConfig(configOverrides);
  const app = createApp({
    config,
    fetchImpl,
    dnsInspector,
    graph,
    workspaceReader,
    logger: logger || captureLogger()
  });
  const server = await new Promise((resolve) => {
    const s = app.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/launch`;
  return {
    ...app,
    server,
    base,
    config,
    async close() {
      await new Promise((r) => server.close(r));
      await app.close();
    }
  };
}

export async function request(base, path, { method = 'GET', body, cookie, origin, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, json, setCookies, cookie: setCookies[0] || null, headers: res.headers };
}

export function extractCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  return setCookieHeader.split(';')[0];
}

export async function signup(app, email, password = 'password12345') {
  const r = await request(app.base, '/api/auth/signup', { method: 'POST', body: { email, password }, origin: app.base });
  const cookie = extractCookie(r.cookie);
  return { ...r, sessionCookie: cookie };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
