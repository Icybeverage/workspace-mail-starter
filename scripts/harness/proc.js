// Child-process runner with hard timeouts and guaranteed cleanup.
//
// Children are spawned detached (own process group on POSIX) so that a
// timeout — or harness exit — kills the whole tree: npm spawns descendants
// (`npm test` -> node -> node --test runners), and killing only the direct
// child would orphan them. Every child is also tracked globally and killed
// when this process exits, so a failing harness never leaks processes.
//
// The child environment is always a scrubbed copy of process.env: provider
// credentials (MAIL_SERVER_*, NEO4J_*, LLM_*, WORKSPACE_TEST_*) and anything
// credential-looking are removed before spawn, whether they came from the
// ambient environment or from caller-supplied overrides.

import { spawn } from 'node:child_process';
import { scrubProcessEnv } from './sanitize.js';

const liveChildren = new Set();

// Kill the child's entire process group. `child.pid` is the group leader id
// because we spawned it detached; a negative PID addresses the whole group.
function killTree(child, signal) {
  if (!child) return;
  if (!child.pid || process.platform === 'win32') {
    try { child.kill(signal); } catch { /* not started / already gone */ }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Group leader already reaped; fall back to the direct child only.
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function killAll() {
  for (const child of liveChildren) killTree(child, 'SIGKILL');
  liveChildren.clear();
}

process.once('exit', killAll);

// Ctrl+C / terminate must not orphan detached children. Installed only by
// the harness entrypoint (not at import time) so importing proc.js from the
// test suite never changes the test runner's signal behavior.
export function installSignalCleanup() {
  const onSignal = () => {
    killAll();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
}

function isKillSignal(signal) {
  return signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP';
}

// buildChildEnv: copy process.env, apply caller overrides, then scrub the
// copy in place (scrubProcessEnv deletes sensitive keys and returns their
// names — the mutation is the payload, the return value is for logging).
function buildChildEnv(extra) {
  const envCopy = { ...process.env, ...(extra || {}) };
  scrubProcessEnv(envCopy);
  return envCopy;
}

// If the direct child exited but the process group still has members (a
// runaway descendant), kill the group so cleanup is complete even when the
// command "succeeds".
function reapStrayGroup(child) {
  if (!child.pid || process.platform === 'win32') return;
  try {
    process.kill(-child.pid, 0); // probe: group still has live members?
  } catch {
    return; // group is gone; nothing to do
  }
  killTree(child, 'SIGKILL');
}

// Runs a command, always resolves with a result object (never rejects).
// On timeout the group gets SIGTERM, then SIGKILL after a grace period;
// output is capped to the last `maxOutputChars`.
export function runCommand(cmd, args, {
  timeoutMs = 120_000,
  cwd,
  env,
  maxOutputChars = 131_072,
  killGraceMs = 5_000
} = {}) {
  return new Promise((resolve) => {
    const childEnv = buildChildEnv(env);
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      });
    } catch (err) {
      resolve({ code: null, signal: null, timedOut: false, error: String(err && err.message), stdout: '', stderr: '' });
      return;
    }

    liveChildren.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer = null;

    const cap = (text, chunk) => {
      const next = text + chunk;
      return next.length > maxOutputChars ? next.slice(next.length - maxOutputChars) : next;
    };

    child.stdout.on('data', (d) => { stdout = cap(stdout, d.toString()); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d.toString()); });

    const timeout = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), killGraceMs);
      if (killTimer.unref) killTimer.unref();
    }, timeoutMs);
    if (timeout.unref) timeout.unref();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      liveChildren.delete(child);
      resolve(result);
    };

    child.on('error', (err) => {
      finish({ code: null, signal: null, timedOut, error: String(err && err.message), stdout, stderr });
    });

    child.on('close', (code, signal) => {
      reapStrayGroup(child);
      finish({
        code,
        signal,
        timedOut,
        error: null,
        // A user-initiated kill is not a test result; surface it distinctly.
        interrupted: isKillSignal(signal) && !timedOut,
        stdout,
        stderr
      });
    });
  });
}

// Best-effort git metadata; never throws, never required.
export async function gitInfo(cwd) {
  const out = {};
  try {
    const rev = await runCommand('git', ['rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 10_000 });
    out.revision = rev.code === 0 ? rev.stdout.trim().split('\n')[0] : null;
  } catch { out.revision = null; }
  try {
    const branch = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 10_000 });
    out.branch = branch.code === 0 ? branch.stdout.trim().split('\n')[0] : null;
  } catch { out.branch = null; }
  try {
    const status = await runCommand('git', ['status', '--porcelain', '--', '.'], { cwd, timeoutMs: 10_000 });
    out.dirty = status.code === 0 ? status.stdout.trim().length > 0 : null;
  } catch { out.dirty = null; }
  out.available = Boolean(out.revision);
  return out;
}

export function tail(text, maxChars = 4000) {
  if (!text) return '';
  const clean = String(text).trimEnd();
  return clean.length > maxChars ? `…[truncated]\n${clean.slice(clean.length - maxChars)}` : clean;
}
