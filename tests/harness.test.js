// Harness self-tests: the verification harness's own guarantees (timeout
// handling, failed/skipped reporting, secret sanitization, child-process
// cleanup, and live-mode origin validation) must hold before the harness is
// trusted to verify anything. Everything here is mocked — live mode is NEVER
// executed by tests, and nothing reaches the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  makeSecretVault, scrubProcessEnv, envKeyIsSensitive, sanitizeError, envPresenceSummary
} from '../scripts/harness/sanitize.js';
import { createRegistry, withTimeout, SkipSignal, TIMEOUT_CODE } from '../scripts/harness/checks.js';
import { runCommand, tail } from '../scripts/harness/proc.js';
import {
  validateLiveTarget, decideLiveRequest, allowedApiGetPatterns,
  LIVE_EXPECTED_HOST
} from '../scripts/harness/live.js';
import { writeReports } from '../scripts/harness/report.js';

// ---------------------------------------------------------------------------
// checks.js — status model, timeout handling, exit-code semantics
// ---------------------------------------------------------------------------

test('harness checks: passed/failed/skipped are reported distinctly and skips never count as passes', async () => {
  const registry = createRegistry();
  await registry.run({ id: 'ok', phase: 'p', title: 'ok check' }, async () => 'fine');
  await registry.run({ id: 'bad', phase: 'p', title: 'bad check' }, async () => {
    throw new Error('assertion broke');
  });
  await registry.run({ id: 'skip', phase: 'p', title: 'skipped check' }, async (ctx) => {
    ctx.skip('tool unavailable');
  });

  const byId = Object.fromEntries(registry.checks.map((c) => [c.id, c]));
  assert.equal(byId.ok.status, 'passed');
  assert.equal(byId.bad.status, 'failed');
  assert.match(byId.bad.detail, /assertion broke/);
  assert.equal(byId.skip.status, 'skipped');
  assert.equal(byId.skip.detail, 'tool unavailable');

  const s = registry.summary();
  assert.equal(s.total, 3);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.exitCode, 1, 'a failure must produce a nonzero exit');
});

test('harness checks: a hung check fails via timeout instead of hanging the run', async () => {
  const registry = createRegistry();
  let timer;
  try {
  const check = await registry.run({ id: 'hang', phase: 'p', title: 'hung check', timeoutMs: 150 }, async () => {
    await new Promise((resolve) => { timer = setTimeout(resolve, 60_000); });
    return 'never';
  });
  assert.equal(check.status, 'failed');
  assert.match(check.detail, /timed out after 150ms/);
  assert.equal(registry.summary().failed, 1);
  } finally {
    clearTimeout(timer);
  }
});

test('harness checks: conditional skips exit 0 only when nothing failed; required skips exit 2', async () => {
  const withConditionalSkip = createRegistry();
  await withConditionalSkip.run({ id: 'a', phase: 'p', title: 'a' }, async () => 'x');
  await withConditionalSkip.run({ id: 'b', phase: 'p', title: 'b', conditional: true }, async (ctx) => {
    ctx.skip('precondition absent (e.g. no live credentials)');
  });
  assert.equal(withConditionalSkip.summary().exitCode, 0, 'conditional skip alone must not fail the run');

  const withRequiredSkip = createRegistry();
  await withRequiredSkip.run({ id: 'a', phase: 'p', title: 'a' }, async () => 'x');
  await withRequiredSkip.run({ id: 'b', phase: 'p', title: 'b' }, async (ctx) => {
    ctx.skip('Chromium is not installed');
  });
  const s = withRequiredSkip.summary();
  assert.equal(s.exitCode, 2, 'a skipped required check must exit nonzero (incomplete)');
  assert.equal(s.skippedRequired, 1);
});

test('harness checks: withTimeout rejects with a marker code and does not swallow the real result', async () => {
  const good = await withTimeout(Promise.resolve('value'), 1000, 'op');
  assert.equal(good, 'value');

  await assert.rejects(
    withTimeout(new Promise(() => {}), 50, 'slow op'),
    (err) => err.code === TIMEOUT_CODE && /slow op timed out/.test(err.message)
  );
});

test('harness checks: ctx.artifacts attach to the recorded check even when it fails', async () => {
  const registry = createRegistry();
  const check = await registry.run({ id: 'shot', phase: 'p', title: 'check with artifact' }, async (ctx) => {
    ctx.artifacts.push('failure.png');
    throw new Error('boom');
  });
  assert.deepEqual(check.artifacts, ['failure.png']);
});

// ---------------------------------------------------------------------------
// sanitize.js — secret hygiene
// ---------------------------------------------------------------------------

test('harness sanitize: env scrubbing removes provider credentials and test secrets, keeps the rest', () => {
  const env = {
    PATH: '/usr/bin',
    NODE_ENV: 'test',
    MAIL_SERVER_PASSWORD: 'real-secret-1',
    NEO4J_URI: 'bolt://x',
    NEO4J_PASSWORD: 'real-secret-2',
    LLM_API_KEY: 'real-secret-3',
    WORKSPACE_TEST_PASSWORD: 'real-secret-4',
    VAULT_KEY: 'a'.repeat(64),
    MY_API_TOKEN: 'real-secret-5',
    HARMLESS_NAME: 'ok'
  };
  const removed = scrubProcessEnv(env);
  assert.deepEqual(
    Object.keys(env).sort(),
    ['HARMLESS_NAME', 'NODE_ENV', 'PATH'].sort(),
    'only non-sensitive variables survive'
  );
  assert.ok(removed.includes('MAIL_SERVER_PASSWORD'));
  assert.ok(removed.includes('WORKSPACE_TEST_PASSWORD'));
  assert.ok(envKeyIsSensitive('CF_DNS_TOKEN'));
  assert.ok(!envKeyIsSensitive('PATH'));
  assert.ok(!envKeyIsSensitive('BASE_PATH'));
});

test('harness sanitize: vault redacts by key pattern and by registered value, and audits for leaks', () => {
  const vault = makeSecretVault();
  vault.register('Sup3r-Secret-Password');
  const report = {
    password: 'hunter2hunter2',
    nested: { sessionCookie: 'abc', note: 'the password was Sup3r-Secret-Password' },
    safe: 'all good'
  };
  const out = vault.redactDeep(report);
  assert.equal(out.password, '[redacted]');
  assert.equal(out.nested.sessionCookie, '[redacted]');
  assert.equal(out.nested.note, 'the password was [redacted]');
  assert.equal(out.safe, 'all good');

  const leaks = vault.audit(JSON.stringify({ leak: 'Sup3r-Secret-Password' }));
  assert.equal(leaks.length, 1, 'audit must find a leaked registered value');
});

test('harness sanitize: sanitizeError scrubs registered secrets and caps length', () => {
  const vault = makeSecretVault();
  vault.register('TokenValue-XYZ');
  const err = new Error('failed with TokenValue-XYZ');
  const text = sanitizeError(err, vault);
  assert.ok(!text.includes('TokenValue-XYZ'));
  assert.ok(text.includes('[redacted]'));

  const long = sanitizeError(new Error('x'.repeat(5000)), vault);
  assert.ok(long.length < 2200);
});

test('harness sanitize: envPresenceSummary reports set/unset without values', () => {
  process.env.__HARNESS_PROBE_SET__ = 'value-never-to-appear';
  try {
    const summary = envPresenceSummary(['__HARNESS_PROBE_SET__', '__HARNESS_PROBE_UNSET__']);
    assert.deepEqual(summary, { __HARNESS_PROBE_SET__: 'set', __HARNESS_PROBE_UNSET__: 'unset' });
    assert.ok(!JSON.stringify(summary).includes('value-never-to-appear'));
  } finally {
    delete process.env.__HARNESS_PROBE_SET__;
  }
});

// ---------------------------------------------------------------------------
// proc.js — child environment scrubbing, timeouts, process-tree cleanup
// ---------------------------------------------------------------------------

test('harness proc: children never inherit credential-looking env, even from caller overrides', async () => {
  const r = await runCommand(process.execPath, ['-e', 'console.log(process.env.MAIL_SERVER_PASSWORD === undefined ? "scrubbed" : "LEAK:" + process.env.MAIL_SERVER_PASSWORD)'], {
    timeoutMs: 30_000,
    env: { MAIL_SERVER_PASSWORD: 'override-secret' }
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /scrubbed/);
  assert.ok(!r.stdout.includes('override-secret'));
  assert.ok(!r.stderr.includes('override-secret'));
});

test('harness proc: a hung command is killed on timeout and the run continues', async () => {
  const t0 = Date.now();
  const r = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 400 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 10_000, `timeout must not hang (took ${elapsed}ms)`);
});

// Descendant cleanup regression: killing the direct child must also kill
// processes it spawned. Runs the tree twice — once via timeout kill, once
// where the direct child exits "successfully" while a descendant lingers —
// because both paths must end with zero surviving descendants.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

const TREE_SPAWNER = [
  'const { spawn } = require("node:child_process");',
  'const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  'console.log("PID:" + kid.pid);'
].join(' ');

test('harness proc: timeout kills the whole process tree, not just the direct child', async () => {
  const r = await runCommand(process.execPath, ['-e', TREE_SPAWNER + ' setInterval(() => {}, 1000);'], { timeoutMs: 800 });
  const m = r.stdout.match(/PID:(\d+)/);
  assert.ok(m, `spawner must print its child pid (stdout: ${tail(r.stdout, 200)})`);
  const grandchildPid = Number(m[1]);
  assert.equal(r.timedOut, true);
  assert.ok(await waitUntilDead(grandchildPid), `descendant pid ${grandchildPid} must be dead after the group kill`);
});

test('harness proc: a descendant that outlives a successful direct child is reaped', async () => {
  // The direct child prints its descendant's pid and exits 0 immediately,
  // leaving the descendant running inside the same process group.
  const r = await runCommand(process.execPath, ['-e', TREE_SPAWNER + ' process.exit(0);'], { timeoutMs: 30_000 });
  assert.equal(r.code, 0, r.stderr);
  const m = r.stdout.match(/PID:(\d+)/);
  assert.ok(m, `spawner must print its child pid (stdout: ${tail(r.stdout, 200)})`);
  const grandchildPid = Number(m[1]);
  assert.ok(await waitUntilDead(grandchildPid), `stray descendant pid ${grandchildPid} must be reaped after the direct child exits`);
});

test('harness proc: tail truncates long output from the front marker', () => {
  assert.equal(tail('short'), 'short');
  const long = `${'x'.repeat(5000)}END`;
  const cut = tail(long, 100);
  assert.ok(cut.startsWith('…[truncated]'));
  assert.ok(cut.endsWith('END'));
  assert.ok(cut.length < 200);
});

// ---------------------------------------------------------------------------
// live.js — origin/target validation and the read-only request guard
// ---------------------------------------------------------------------------

const TARGET = { origin: 'https://mail.example.test', path: '/launch' };

test('harness live: validateLiveTarget enforces HTTPS, exact path, and a clean URL', () => {
  const ok = validateLiveTarget('https://mail.example.test/launch/', { credentialsPresent: false });
  assert.equal(ok.ok, true);
  assert.equal(ok.origin, 'https://mail.example.test');
  assert.equal(ok.path, '/launch');

  const rejected = [
    ['http://mail.example.test/launch/', 'plain http'],
    ['https://mail.example.test/launch', 'trailing slash variant is accepted', 'ACCEPT'],
    ['https://mail.example.test/launch//', 'double slash'],
    ['https://mail.example.test/admin', 'wrong path'],
    ['https://mail.example.test/', 'root path'],
    ['https://user:pass@mail.example.test/launch/', 'url userinfo'],
    ['https://mail.example.test:8443/launch/', 'non-default port'],
    ['https://mail.example.test/launch/?x=1', 'query string'],
    ['https://mail.example.test/launch/#frag', 'fragment'],
    ['not a url', 'garbage']
  ];
  for (const [url, why, expect] of rejected) {
    const v = validateLiveTarget(url, { credentialsPresent: false });
    if (expect === 'ACCEPT') {
      assert.equal(v.ok, true, `${url} (${why})`);
    } else {
      assert.equal(v.ok, false, `${url} (${why})`);
      assert.ok(typeof v.error === 'string' && v.error.length > 0);
    }
  }
});

test('harness live: credentialed mode additionally pins the exact expected host', () => {
  const ok = validateLiveTarget('https://mail.example.test/launch/', { credentialsPresent: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.host, LIVE_EXPECTED_HOST);

  const evil = validateLiveTarget('https://mail.example.test.evil.example/launch/', { credentialsPresent: true });
  assert.equal(evil.ok, false, 'suffix-lookalike host must be rejected');
  assert.match(evil.error, /mail\.example\.test/);

  const other = validateLiveTarget('https://other-host.example/launch/', { credentialsPresent: true });
  assert.equal(other.ok, false);
});

test('harness live: request guard allows only exact-origin reads plus the login POST', () => {
  const allow = (method, url) => decideLiveRequest({ method, url, target: TARGET, allowLoginPost: true });
  const publicOnly = (method, url) => decideLiveRequest({ method, url, target: TARGET, allowLoginPost: false });

  // Reads the SPA needs.
  for (const p of [
    '/launch', '/launch/', '/launch/health',
    '/launch/assets/index-abc.js', '/launch/assets/style.css',
    '/launch/api/auth/me', '/launch/api/meta',
    '/launch/api/domains', '/launch/api/domains/dom_hosted', '/launch/api/domains/dom_hosted/graph',
    '/launch/api/mailboxes', '/launch/api/workspace', '/launch/api/activity'
  ]) {
    assert.equal(allow('GET', `https://mail.example.test${p}`).allow, true, `GET ${p} should be allowed`);
  }

  // The single permitted write.
  assert.equal(allow('POST', 'https://mail.example.test/launch/api/auth/login').allow, true);
  // ...and only in the credentialed phase.
  assert.equal(publicOnly('POST', 'https://mail.example.test/launch/api/auth/login').allow, false,
    'login POST must be blocked in the public phase');

  // Everything else is blocked.
  const blocked = [
    ['POST', 'https://mail.example.test/launch/api/mailboxes', 'mailbox creation'],
    ['POST', 'https://mail.example.test/launch/api/domains/dom_1/plan/apply', 'dns apply'],
    ['POST', 'https://mail.example.test/launch/api/domains/dom_1/verify', 'domain verify'],
    ['POST', 'https://mail.example.test/launch/api/domains/dom_1/plan', 'dns plan'],
    ['POST', 'https://mail.example.test/launch/api/auth/logout', 'logout'],
    ['POST', 'https://mail.example.test/launch/api/agent', 'agent'],
    ['GET', 'https://mail.example.test/launch/api/domains/dom_1/inspect', 'state-persisting inspect endpoint'],
    ['GET', 'https://mail.example.test/launch/api/domains/dom_1/plan/apply', 'apply is not a read even via GET'],
    ['GET', 'https://mail.example.test/launch/api/admin', 'unknown api path'],
    ['GET', 'https://mail.example.test/api/mailboxes', 'api without base path'],
    ['GET', 'https://evil.example/launch/api/domains', 'off-origin host'],
    ['GET', 'https://mail.example.test.evil.example/launch/', 'lookalike origin'],
    ['GET', 'https://mail.example.test:8443/launch/', 'port variant origin'],
    ['PUT', 'https://mail.example.test/launch/api/domains', 'other method'],
    ['DELETE', 'https://mail.example.test/launch/api/domains/dom_1', 'delete']
  ];
  for (const [method, url, why] of blocked) {
    const d = allow(method, url);
    assert.equal(d.allow, false, `${method} ${url} (${why})`);
    assert.ok(d.reason && d.reason.length > 0, 'block reasons must be present for the report');
  }
});

test('harness live: api GET allowlist is anchored to the base path', () => {
  const patterns = allowedApiGetPatterns('/launch');
  assert.ok(patterns.every((re) => re instanceof RegExp));
  assert.ok(patterns.some((re) => re.test('/launch/api/domains/x')));
  assert.ok(patterns.some((re) => re.test('/launch/api/domains/x/relay')));
  assert.ok(!patterns.some((re) => re.test('/launch/api/domains/x/relay/prepare')));
  assert.ok(!patterns.some((re) => re.test('/launch/api/domains/x/graph/extra')));
  assert.ok(!patterns.some((re) => re.test('/launch/api/domains/x/inspect')));
  assert.ok(!patterns.some((re) => re.test('/launch/api/domainsx')));
  // Escaping: a base path with regex metacharacters is not misinterpreted.
  const weird = allowedApiGetPatterns('/launch.v2');
  assert.ok(weird.some((re) => re.test('/launch.v2/api/meta')));
  assert.ok(!weird.some((re) => re.test('/launchXv2/api/meta')));
});

// ---------------------------------------------------------------------------
// report.js — sanitized artifacts on disk
// ---------------------------------------------------------------------------

test('harness report: written JSON/HTML contain no registered secrets and never count skips as passes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-harness-report-'));
  try {
    const vault = makeSecretVault();
    const registry = createRegistry({ vault });
    vault.register('Never-Ship-This-9');
    await registry.run({ id: 'a', phase: 'p', title: 'check A' }, async () => 'contains Never-Ship-This-9 in detail');
    await registry.run({ id: 'b', phase: 'p', title: 'check B' }, async (ctx) => {
      ctx.skip('unavailable — never passed');
    });

    const report = {
      runId: 'run-test',
      mode: 'fixture',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 5,
      versions: { node: process.version },
      git: { available: false },
      checks: registry.checks,
      summary: registry.summary(),
      logs: {},
      live: null
    };
    const { jsonPath, htmlPath, sanitizeWarning } = writeReports({ outDir: dir, report, vault });

    const json = fs.readFileSync(jsonPath, 'utf8');
    const html = fs.readFileSync(htmlPath, 'utf8');
    for (const artifact of [json, html]) {
      assert.ok(!artifact.includes('Never-Ship-This-9'), 'registered secret must not appear in artifacts');
      assert.ok(artifact.includes('[redacted]'), 'secret occurrence must be visibly redacted');
    }
    // redactDeep covers every string value, so the serialized report is
    // already clean and the emergency leak-replacement path stays cold.
    assert.equal(sanitizeWarning, null, 'no sanitize warning when redaction removed everything');
    assert.ok(json.includes('"skipped"') && json.includes('"passed"'));
    assert.ok(html.includes('>skipped<'), 'HTML shows skipped status explicitly');

    const parsed = JSON.parse(json);
    assert.equal(parsed.summary.passed, 1);
    assert.equal(parsed.summary.skipped, 1);
    assert.equal(parsed.checks.find((c) => c.id === 'b').status, 'skipped');

    // HTML escaping: detail text with markup cannot inject into the report.
    fs.rmSync(dir, { recursive: true, force: true });
    const registry2 = createRegistry();
    await registry2.run({ id: 'x', phase: 'p', title: '<script>' }, async () => 'detail <img src=x onerror=alert(1)>');
    const report2 = { runId: 'run-esc', mode: 'fixture', startedAt: '', finishedAt: '', durationMs: 0, versions: {}, git: {}, checks: registry2.checks, summary: registry2.summary(), logs: {}, live: null };
    writeReports({ outDir: dir, report: report2, vault: makeSecretVault() });
    const html2 = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
    assert.ok(!html2.includes('<img src=x'));
    assert.ok(!html2.includes('<script>'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
