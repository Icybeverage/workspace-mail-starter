// Isolated scratch app for harness browser smoke checks.
//
// Reuses tests/helpers.js fixtures so the harness exercises the real Express
// app with the same fake providers the unit suite uses:
//   - Mail server  -> in-process mock fetch (https://mailserver.invalid, reserved TLD)
//   - DNS resolver   -> fake inspector (tests/helpers.js makeDnsInspector)
//   - Neo4j          -> intentionally unconfigured (empty URI): the app must
//                       show honest "graph degraded/unavailable" states
//   - LLM            -> unconfigured
// No credential files or normal .env are read (makeConfig uses skipDotEnv),
// and process.env is scrubbed by the harness entrypoint before this loads.
// The scratch DB lives in a fresh temp dir that close() removes.

import fs from 'node:fs';
import {
  makeConfig, makeMockFetch, mailserverHandlers, makeMailServerState,
  makeDnsState, makeDnsInspector, captureLogger
} from '../../tests/helpers.js';
import { createApp } from '../../server/app.js';

export function makeScratchConfig() {
  return makeConfig({
    mailboxLimitPerAccount: 5,
    // Explicit fakes — never real endpoints. `.invalid` is a reserved TLD, so
    // even a bug that bypassed the mock fetch could not reach a real server.
    mailserver: {
      baseUrl: 'https://mailserver.invalid/admin',
      username: 'fixture-admin',
      password: 'fixture-mailserver-password',
      timeoutMs: 200,
      mailHost: 'mailserver.invalid'
    },
    neo4j: { uri: '', username: 'neo4j', password: '' },
    llm: { baseUrl: '', apiKey: '', model: '' }
  });
}

export async function bootScratchApp({ vault } = {}) {
  const config = makeScratchConfig();
  vault?.register(config.mailserver.password);

  const mailserverState = makeMailServerState();
  // Extra fixture knob: when usersFail is true the fake MAIL_SERVER /mail/users
  // listing returns 500, which the app must surface as an honest
  // "storage unavailable" state (never fabricated numbers).
  const handlers = [
    {
      match: (u, m) => m === 'GET' && u.includes('/mail/users') && mailserverState.usersFail === true,
      handle: async () => ({ status: 500, body: 'fixture: upstream unavailable' })
    },
    ...mailserverHandlers(mailserverState)
  ];
  const fetchImpl = makeMockFetch(handlers);
  const dnsState = makeDnsState();
  const logger = captureLogger();
  const app = createApp({
    config,
    fetchImpl,
    dnsInspector: makeDnsInspector(dnsState),
    logger
  });

  const server = await new Promise((resolve, reject) => {
    const s = app.app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/launch`;

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(resolve));
    await app.close();
    try {
      fs.rmSync(config.dataDir, { recursive: true, force: true });
    } catch { /* best effort; temp dir is disposable */ }
  }

  return { app, server, base, port, config, mailserverState, dnsState, fetchImpl, logger, close };
}
