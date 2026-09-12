// Workspace verification harness entrypoint.
//
//   npm run verify                              — offline/fixture verification
//   node scripts/harness/run.js --live <url>    — additionally run OPTIONAL
//                                                 read-only live checks
//
// Offline/fixture mode (the default) runs:
//   1. the existing test suite (`npm test`)          — with a hard timeout
//   2. the production build (`npm run build`)        — with a hard timeout
//   3. an isolated scratch app with explicit fake providers (no real Neo4j,
//      Mail server, Cloudflare or LLM), health-checked in-process
//   4. standalone Chromium smoke checks against that app through the
//      production build (signup, navigation, Workspace, honest unavailable
//      states, desktop/mobile overflow, bottom-scroll -> navigation)
//
// Every check lands in review/harness/<run-id>/report.json (+ report.html
// and labeled screenshots). Exit codes:
//   0 all required checks passed; 1 something failed; 2 incomplete (a
//   required check could not run — e.g. Chromium missing — never counted
//   as passed).
//
// Safety: process.env is scrubbed of provider credentials and anything
// credential-looking before any work; live credentials are captured first
// and only ever passed in memory; no .env or credential files are read.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSecretVault, envKeyIsSensitive, sanitizeError } from './sanitize.js';
import { createRegistry } from './checks.js';
import { runCommand, gitInfo, tail, installSignalCleanup } from './proc.js';
import { writeReports } from './report.js';
import { bootScratchApp } from './scratch.js';
import { runFixtureBrowserChecks, FIXTURE_BROWSER_CHECKS } from './browser.js';
import { runLiveChecks, validateLiveTarget } from './live.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..', '..');
const HARNESS_DIR = path.join(ROOT_DIR, 'review', 'harness');

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version;

const ICON = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' };

// Populated as main() progresses so the entry-point catch can record a failed
// check and write a sanitized partial report even when an unexpected exception
// escapes main(). Never printed directly — always through the vault sanitizer.
const fatalState = {
  startedAt: null,
  t0: null,
  runId: null,
  outDir: null,
  vault: null,
  registry: null,
  mode: 'fixture',
  versions: null,
  scrubbedEnvKeys: [],
  logs: {}
};

function usage() {
  return [
    'Usage:',
    '  npm run verify                     # offline/fixture verification (default)',
    '  node scripts/harness/run.js --live https://mail.example.test/launch/',
    '',
    'Options:',
    '  --live <url>   additionally run OPTIONAL read-only live checks against the',
    '                 given deployment. Public checks run by default; the',
    '                 credentialed checks (Overview/Mailboxes/Workspace/graph read',
    '                 of the account) run only when WORKSPACE_TEST_EMAIL and',
    '                 WORKSPACE_TEST_PASSWORD are both set in the environment.',
    '  --help         show this help',
    '',
    'Browser setup (one-time): npm install && npx playwright install chromium'
  ].join('\n');
}

function parseArgs(argv) {
  const out = { live: null, help: false, errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--live') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) out.errors.push('--live requires a URL argument');
      else {
        out.live = value;
        i += 1;
      }
    } else out.errors.push(`unknown argument: ${arg}`);
  }
  return out;
}

// node --test (TAP when piped) prints summary lines like "# tests 96".
function parseTapCounts(text) {
  const get = (key) => {
    const m = text.match(new RegExp(`^#\\s+${key}\\s+(\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return { tests: get('tests'), pass: get('pass'), fail: get('fail'), skipped: get('skipped'), cancelled: get('cancelled') };
}

async function npmVersion() {
  const r = await runCommand('npm', ['--version'], { cwd: ROOT_DIR, timeoutMs: 20_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

function newRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const suffix = Math.random().toString(36).slice(2, 6);
  return `run-${stamp}-${suffix}`;
}

async function main() {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  fatalState.startedAt = startedAt;
  fatalState.t0 = t0;
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.errors.length > 0) {
    console.error(args.errors.join('\n'));
    console.error(usage());
    return 1;
  }

  // Live credentials must be captured BEFORE the environment is scrubbed;
  // they are passed in memory only and never appear in reports.
  let creds = null;
  if (args.live) {
    const email = process.env.WORKSPACE_TEST_EMAIL;
    const password = process.env.WORKSPACE_TEST_PASSWORD;
    if (email && password) creds = { email: String(email), password: String(password) };
    const early = validateLiveTarget(args.live, { credentialsPresent: Boolean(creds) });
    if (!early.ok) {
      console.error(`Invalid --live target: ${early.error}`);
      return 1;
    }
  }

  installSignalCleanup();

  // Scrub the environment in-process: no provider credentials (real or
  // accidental), no test secrets. Removed values are registered with the
  // vault so even an accidental leak would be redacted from reports.
  const vault = makeSecretVault();
  fatalState.vault = vault;
  const scrubbedEnvKeys = [];
  for (const key of Object.keys(process.env)) {
    if (envKeyIsSensitive(key)) {
      const value = process.env[key];
      if (typeof value === 'string' && value) vault.register(value);
      delete process.env[key];
      scrubbedEnvKeys.push(key);
    }
  }
  fatalState.scrubbedEnvKeys = scrubbedEnvKeys;

  const runId = newRunId();
  const outDir = path.join(HARNESS_DIR, runId);
  fs.mkdirSync(outDir, { recursive: true });
  fatalState.runId = runId;
  fatalState.outDir = outDir;
  fatalState.mode = args.live ? 'fixture+live' : 'fixture';

  const registry = createRegistry({
    vault,
    onRecord(check) {
      console.log(`  [${ICON[check.status] || '?'}] ${check.title}${check.status === 'passed' ? '' : ` — ${check.detail.split('\n')[0]}`}`);
    }
  });
  fatalState.registry = registry;

  console.log(`Workspace verification harness — run ${runId}`);
  console.log(`Mode: ${args.live ? 'fixture + optional live (read-only)' : 'fixture (offline, fake providers)'}`);
  if (scrubbedEnvKeys.length > 0) {
    console.log(`Scrubbed ${scrubbedEnvKeys.length} credential-looking env var(s) before starting (names only): ${scrubbedEnvKeys.join(', ')}`);
  }

  const logs = fatalState.logs;
  const versions = { node: process.version, npm: await npmVersion(), app: APP_VERSION, playwright: null, chromium: null };
  fatalState.versions = versions;

  // ---------------- Phase 1: existing test suite ---------------------------
  console.log('\nPhase: suite');
  await registry.run({ id: 'unit-tests', phase: 'suite', title: 'Existing test suite passes (npm test)', timeoutMs: 420_000 }, async () => {
    const r = await runCommand('npm', ['test'], { cwd: ROOT_DIR, timeoutMs: 400_000, maxOutputChars: 262_144 });
    logs.unitTests = tail(r.stdout + (r.stderr ? `\n${r.stderr}` : ''));
    if (r.timedOut) throw new Error(`npm test timed out and its process tree was killed. Output tail:\n${logs.unitTests}`);
    if (r.code !== 0) throw new Error(`npm test exited with code ${r.code}. Output tail:\n${logs.unitTests}`);
    // The package test script forces the TAP reporter, so counts must be
    // parseable; an unparseable summary is itself a failure, not a pass.
    const counts = parseTapCounts(r.stdout);
    if (counts.tests === null || counts.pass === null || counts.fail === null) {
      throw new Error(`npm test exited 0 but the TAP summary was not parseable. Output tail:\n${logs.unitTests}`);
    }
    if (counts.fail > 0 || counts.cancelled > 0) {
      throw new Error(`test runner reported failures despite exit code 0: ${JSON.stringify(counts)}`);
    }
    if (counts.skipped > 0) {
      throw new Error(`${counts.skipped} test(s) were skipped; required tests must run, so this run is not green: ${JSON.stringify(counts)}`);
    }
    return `${counts.tests} tests: ${counts.pass} pass, ${counts.fail} fail, ${counts.skipped ?? 0} skipped`;
  });

  // ---------------- Phase 2: production build ------------------------------
  await registry.run({ id: 'production-build', phase: 'suite', title: 'Production build succeeds (npm run build)', timeoutMs: 240_000 }, async () => {
    const r = await runCommand('npm', ['run', 'build'], { cwd: ROOT_DIR, timeoutMs: 220_000 });
    logs.build = tail(r.stdout + (r.stderr ? `\n${r.stderr}` : ''));
    if (r.timedOut) throw new Error(`npm run build timed out and its process tree was killed. Output tail:\n${logs.build}`);
    if (r.code !== 0) throw new Error(`npm run build exited with code ${r.code}. Output tail:\n${logs.build}`);
    const indexPath = path.join(ROOT_DIR, 'client', 'dist', 'index.html');
    const assetsDir = path.join(ROOT_DIR, 'client', 'dist', 'assets');
    if (!fs.existsSync(indexPath)) throw new Error('build exited 0 but client/dist/index.html is missing');
    const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
    if (assets.length === 0) throw new Error('build exited 0 but client/dist/assets is empty');
    return `built client/dist (${assets.length} asset files); output tail:\n${logs.build}`;
  });

  // ---------------- Phase 3: isolated scratch app --------------------------
  console.log('\nPhase: app (isolated scratch, fake providers)');
  let scratch = null;
  await registry.run({ id: 'scratch-boot', phase: 'app', title: 'Scratch app boots with fake providers and healthy status', timeoutMs: 60_000 }, async () => {
    scratch = await bootScratchApp({ vault });
    const res = await fetch(`${scratch.base}/health`, { signal: AbortSignal.timeout(10_000) });
    if (res.status !== 200) throw new Error(`GET /launch/health returned HTTP ${res.status}`);
    const body = await res.json();
    if (body.status !== 'ok' || body.dependencies?.sqlite?.ok !== true) {
      throw new Error(`unhealthy scratch app: ${JSON.stringify(body)}`);
    }
    if (body.dependencies?.neo4j?.configured !== false) {
      throw new Error('scratch app must NOT have Neo4j configured (graph must stay unconfigured)');
    }
    if (body.dependencies?.llm?.configured !== false) {
      throw new Error('scratch app must NOT have an LLM configured');
    }
    return `health ok on ${scratch.base}; sqlite ok; neo4j unconfigured (honest degraded graph expected); MAIL_SERVER is the in-process fixture (${scratch.config.mailserver.baseUrl})`;
  });

  if (scratch) {
    await registry.run({ id: 'scratch-cleanup', phase: 'app', title: 'Scratch app and temp state are fully cleaned up', timeoutMs: 60_000 }, async () => {
      const base = scratch.base;
      const dataDir = scratch.config.dataDir;
      await scratch.close();
      scratch = null;
      // The server socket must be gone: a follow-up request has to fail.
      let refused = false;
      try {
        await fetch(base, { signal: AbortSignal.timeout(5_000) });
      } catch {
        refused = true;
      }
      if (!refused) throw new Error(`scratch server still answers on ${base} after close()`);
      if (fs.existsSync(dataDir)) throw new Error(`scratch data dir ${dataDir} still exists after close()`);
      return `server socket closed (${base} refuses connections) and temp data dir removed`;
    });
  }

  // ---------------- Phase 4: browser smoke checks (fixture) ----------------
  // Boots a second scratch app: the previous one was closed by the cleanup
  // check on purpose, so this phase gets its own isolated instance.
  console.log('\nPhase: browser (standalone Chromium smoke checks)');
  let browserScratch = null;
  try {
    browserScratch = await bootScratchApp({ vault });
  } catch (err) {
    // A boot failure is a failed required check, and the browser checks that
    // depend on the app are skipped (never passed).
    await registry.run({ id: 'browser-scratch-boot', phase: 'browser', title: 'Browser: scratch app boots for smoke checks', timeoutMs: 60_000 }, async () => {
      throw err;
    });
    for (const def of FIXTURE_BROWSER_CHECKS) {
      registry.record({
        ...def, phase: 'browser', status: 'skipped',
        detail: 'scratch app failed to boot for the browser phase',
        startedAt: new Date().toISOString(), durationMs: 0, artifacts: [], conditional: false
      });
    }
  }
  if (browserScratch) {
    try {
      const browserInfo = await runFixtureBrowserChecks({ registry, scratch: browserScratch, outDir, vault });
      versions.playwright = browserInfo.playwrightVersion;
      versions.chromium = browserInfo.browserVersion;
    } finally {
      await browserScratch.close().catch(() => {});
    }
  }

  // ---------------- Phase 5: OPTIONAL live mode ----------------------------
  let liveInfo = null;
  if (args.live) {
    console.log('\nPhase: live (OPTIONAL, read-only; labeled separately from fixture evidence)');
    liveInfo = await runLiveChecks({ registry, rawUrl: args.live, outDir, vault, creds });
    if (liveInfo.guardBlocked && liveInfo.guardBlocked.length > 0) {
      logs.liveGuard = `read-only request guard blocked ${liveInfo.guardBlocked.length} non-allowlisted request(s), e.g.: ${liveInfo.guardBlocked[0]}`;
      console.log(`  [note] ${logs.liveGuard}`);
    }
  }

  // ---------------- Report -------------------------------------------------
  const summary = registry.summary();
  const git = await gitInfo(ROOT_DIR);
  const finishedAt = new Date().toISOString();

  const report = {
    harness: { name: 'workspace-verify', version: 1, entrypoint: 'npm run verify' },
    runId,
    mode: args.live ? 'fixture+live' : 'fixture',
    startedAt,
    finishedAt,
    durationMs: Date.now() - t0,
    versions,
    git,
    env: {
      // Names only — values were scrubbed before any check ran.
      scrubbedEnvKeys,
      note: 'provider credentials and credential-looking variables are removed from the harness environment; fixtures only'
    },
    checks: registry.checks,
    summary,
    logs,
    live: liveInfo && liveInfo.target
      ? {
          origin: liveInfo.target.origin,
          path: liveInfo.target.path,
          host: liveInfo.target.host,
          credentialed: liveInfo.credentialed,
          note: 'live checks are read-only and labeled phase "live"; credentials, if supplied, came from the environment and are never recorded'
        }
      : null
  };

  const { jsonPath, htmlPath } = writeReports({ outDir, report, vault });

  console.log(`\nSummary: ${summary.total} checks — ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
  if (summary.skipped > 0) {
    const required = registry.checks.filter((c) => c.status === 'skipped' && !c.conditional).map((c) => c.id);
    console.log(`  Skipped (required, incomplete): ${required.length ? required.join(', ') : 'none'}`);
    const conditional = registry.checks.filter((c) => c.status === 'skipped' && c.conditional).map((c) => c.id);
    if (conditional.length) console.log(`  Skipped (conditional, preconditions absent): ${conditional.join(', ')}`);
  }
  console.log(`Report: ${path.relative(ROOT_DIR, jsonPath)}`);
  console.log(`        ${path.relative(ROOT_DIR, htmlPath)}`);
  console.log(`Exit code: ${summary.exitCode}${summary.exitCode === 2 ? ' (verification incomplete: a required check could not run)' : ''}`);
  return summary.exitCode;
}

// Unexpected internal failure path: record a failed check and write a
// sanitized partial report so an aborted run still leaves evidence. Reuses
// registry.run (which sanitizes the error via the vault) and writeReports
// (which redacts the whole tree and audits for leaks). Raw stacks can embed
// secrets, so the console only ever receives sanitized text.
async function fatalReport(err) {
  const { vault, registry, outDir, runId, startedAt, t0, versions, scrubbedEnvKeys, logs, mode } = fatalState;
  const sanitized = sanitizeError(err, vault);
  console.error('Harness internal error:', sanitized);

  if (!registry || !runId || !outDir) {
    console.error('The harness failed before its report directory was ready; no report was written.');
    return 1;
  }

  await registry.run({
    id: 'harness-fatal',
    phase: 'harness',
    title: 'Harness run completes without internal errors',
    timeoutMs: 30_000
  }, async () => {
    throw err;
  });

  const finishedAt = new Date().toISOString();
  let git = {};
  try {
    git = await gitInfo(ROOT_DIR) || {};
  } catch {
    // Git info is optional evidence; losing it must not lose the report.
  }

  const summary = registry.summary();
  const report = {
    harness: { name: 'workspace-verify', version: 1, entrypoint: 'npm run verify' },
    runId,
    mode,
    startedAt: startedAt || finishedAt,
    finishedAt,
    durationMs: t0 ? Date.now() - t0 : 0,
    exitCode: summary.exitCode,
    versions: versions || { node: process.version, npm: null, app: APP_VERSION, playwright: null, chromium: null },
    git,
    env: {
      scrubbedEnvKeys: scrubbedEnvKeys || [],
      note: 'provider credentials and credential-looking variables are removed from the harness environment; fixtures only'
    },
    fatal: {
      message: sanitized,
      note: 'The harness terminated with an unexpected internal error. This is a partial report: checks that never ran are absent, not passed.'
    },
    checks: registry.checks,
    summary,
    logs: logs || {},
    live: null
  };

  try {
    const { jsonPath, htmlPath } = writeReports({ outDir, report, vault });
    console.log(`Partial report (fatal error): ${path.relative(ROOT_DIR, jsonPath)}`);
    console.log(`                            ${path.relative(ROOT_DIR, htmlPath)}`);
  } catch (reportErr) {
    console.error('Could not write the partial report:', sanitizeError(reportErr, vault));
  }
  console.log('Exit code: 1 (harness internal error)');
  return 1;
}

// Entry point: an unexpected internal failure is still a failed run — the
// fatal path above keeps it evidenced and sanitized. Guarded by isMain so
// importing this module (e.g. tests/harness.test.js) never starts the harness.
const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  try {
    process.exitCode = await main();
  } catch (err) {
    try {
      process.exitCode = await fatalReport(err);
    } catch (reportErr) {
      console.error('Harness fatal handling failed:', sanitizeError(reportErr, fatalState.vault));
      process.exitCode = 1;
    }
  }
}

export { fatalReport, fatalState };
