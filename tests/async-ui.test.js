import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncGeneration } from '../client/src/asyncGeneration.js';
import { fmtDateTime, workspaceNodeDetails } from '../client/src/util.js';

test('fmtDateTime renders mailbox file timestamps in Pacific with AM/PM', () => {
  const modified = workspaceNodeDetails({
    type: 'File',
    name: 'Brief.txt',
    modified: 'Sat, 12 Sep 2026 20:48:31 GMT'
  }).find((row) => row.label === 'Modified')?.value;
  assert.match(modified, /Sep 12, 2026/);
  assert.match(modified, /(AM|PM)/);
  assert.match(modified, /(PDT|PST)/);
  assert.equal(fmtDateTime('2026-09-13T00:30:00Z'), 'Sep 12, 2026, 5:30 PM PDT');
});

test('async generation guard drops stale completions after invalidation', () => {
  const gen = createAsyncGeneration();
  const first = gen.begin();
  assert.equal(gen.isActive(first), true);

  gen.invalidate();
  assert.equal(gen.isActive(first), false);

  const second = gen.begin();
  assert.equal(gen.isActive(second), true);
  assert.equal(gen.isActive(first), false);

  gen.invalidate();
  assert.equal(gen.isActive(second), false);
});

// Domain detail remount (App key={route.id}), investigation panel domain reset,
// and agent panel domain reset are React integration behaviors. Verify in root
// Playwright/browser checks — source-string regex matching is not a regression test.
