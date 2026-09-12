// Check model for the Workspace verification harness.
//
// Every check has exactly one of three statuses:
//   passed   — the assertion ran and held
//   failed   — the assertion ran and broke (or timed out, or threw)
//   skipped  — the check could not run (tool/browser/credentials unavailable)
// A skipped check is never counted as passed, and the run's exit code says so.
//
// Exit codes:
//   0 — every check passed (conditional checks may be skipped for absent
//       preconditions, e.g. live credentials were not provided)
//   1 — at least one check failed
//   2 — nothing failed, but a non-conditional check was skipped
//       (verification is incomplete, e.g. Chromium is not installed)

import { sanitizeError } from './sanitize.js';

export const TIMEOUT_CODE = 'HARNESS_TIMEOUT';

export class SkipSignal extends Error {
  constructor(reason) {
    super(String(reason));
    this.name = 'SkipSignal';
  }
}

// Race a promise against a timer. The losing side is ignored; callers that
// need real cleanup (child processes, browsers) handle it in their own layer.
export function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = TIMEOUT_CODE;
      reject(err);
    }, ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

export function createRegistry({ vault, onRecord } = {}) {
  const checks = [];

  function record(check) {
    checks.push(check);
    if (onRecord) {
      try { onRecord(check); } catch { /* progress printing must never break a run */ }
    }
    return check;
  }

  // def: { id, phase, title, timeoutMs, conditional }
  // fn(ctx): ctx.skip(reason) marks the check skipped; artifacts recorded on
  // ctx are attached to the resulting check whatever its outcome (failure
  // screenshots stay useful). A returned string becomes the detail; throwing
  // marks the check failed. IMPORTANT: fn runs before the check is recorded,
  // so callbacks must never look the check up in registry.checks — use ctx.
  async function run(def, fn) {
    const {
      id, phase, title,
      timeoutMs = 60_000,
      conditional = false
    } = def;
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const ctx = {
      artifacts: [],
      skip(reason) { throw new SkipSignal(reason); }
    };
    let check;
    try {
      const result = await withTimeout(Promise.resolve(fn(ctx)), timeoutMs, `check "${title}"`);
      const detail = typeof result === 'string' ? result : (result && result.detail ? String(result.detail) : '');
      check = {
        id, phase, title, conditional,
        status: 'passed',
        detail,
        startedAt,
        durationMs: Date.now() - t0,
        artifacts: ctx.artifacts.slice()
      };
    } catch (err) {
      const detail = err instanceof SkipSignal
        ? String(err.message)
        : (err && err.code === TIMEOUT_CODE
          ? String(err.message)
          : sanitizeError(err, vault));
      check = {
        id, phase, title, conditional,
        status: err instanceof SkipSignal ? 'skipped' : 'failed',
        detail,
        startedAt,
        durationMs: Date.now() - t0,
        artifacts: ctx.artifacts.slice()
      };
    }
    return record(check);
  }

  function summary() {
    const passed = checks.filter((c) => c.status === 'passed').length;
    const failed = checks.filter((c) => c.status === 'failed').length;
    const skipped = checks.filter((c) => c.status === 'skipped').length;
    const skippedRequired = checks.filter((c) => c.status === 'skipped' && !c.conditional).length;
    let exitCode = 0;
    if (failed > 0) exitCode = 1;
    else if (skippedRequired > 0) exitCode = 2;
    return { total: checks.length, passed, failed, skipped, skippedRequired, exitCode };
  }

  return { checks, record, run, summary };
}
