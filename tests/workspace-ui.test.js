import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeId } from '../server/services/graph.js';
import {
  findSourceEmail,
  fmtBytes,
  fmtDateTime,
  fmtConfidence,
  fmtEventRange,
  fmtIcalDateTime,
  graphNodeResourceId,
  workspaceNodeDetails
} from '../client/src/util.js';

test('workspace formatters render readable calendar times and file sizes', () => {
  assert.equal(fmtIcalDateTime('20260913T000000Z', 'UTC'), 'Sep 12, 2026, 5:00 PM PDT');
  assert.equal(fmtIcalDateTime('20260912T170000', 'America/Los_Angeles'), 'Sep 12, 2026, 5:00 PM PDT');
  assert.equal(fmtIcalDateTime('20260912T200000', 'America/New_York'), 'Sep 12, 2026, 5:00 PM PDT');
  assert.equal(fmtIcalDateTime('20260912T170000', 'floating/date'), 'Sep 12, 2026, 5:00 PM PDT');
  assert.equal(fmtIcalDateTime('20260113T010000Z', 'UTC'), 'Jan 12, 2026, 5:00 PM PST');
  assert.equal(fmtIcalDateTime('20260912', 'floating/date'), 'Sep 12, 2026');
  assert.equal(fmtDateTime('2026-09-13T00:30:00Z'), 'Sep 12, 2026, 5:30 PM PDT');
  assert.equal(fmtDateTime('invalid'), 'invalid');
  assert.match(fmtEventRange('20260913T000000Z', '20260913T003000Z', 'UTC'), /–/);
  assert.equal(fmtBytes(14615303), '13.9 MB');
  assert.equal(fmtBytes(157), '157 B');
  assert.equal(fmtConfidence('needs_review'), 'Needs Review');
});

test('graph node local ids resolve snapshot resources only within the same mailbox', () => {
  const tenantId = 'tenant-1';
  const mailboxId = 'mailbox-a';
  const emailId = 'email-1';
  const actionId = 'action-1';
  const commitmentNode = {
    id: nodeId(tenantId, 'Commitment', `${mailboxId}:${actionId}`),
    type: 'Commitment',
    entityLabel: 'Commitment',
    tenantId,
    localId: `${mailboxId}:${actionId}`,
    mailboxId,
    name: 'Review Brief.txt'
  };
  const emailNode = {
    id: nodeId(tenantId, 'Email', `${mailboxId}:${emailId}`),
    type: 'Email',
    entityLabel: 'Email',
    tenantId,
    localId: `${mailboxId}:${emailId}`,
    mailboxId,
    name: 'Project update'
  };
  const item = {
    mailboxId,
    emails: [{ id: emailId, name: 'Project update', sender: 'boss@example.test', date: '2026-09-12T20:00:00.000Z' }],
    actions: [{ id: actionId, emailId, name: 'Review Brief.txt' }]
  };

  assert.equal(graphNodeResourceId(commitmentNode, mailboxId), actionId);
  assert.equal(findSourceEmail(item, commitmentNode)?.id, emailId);
  assert.equal(findSourceEmail(item, emailNode)?.id, emailId);

  const otherMailboxNode = {
    ...commitmentNode,
    id: nodeId(tenantId, 'Commitment', `mailbox-b:${actionId}`),
    localId: `mailbox-b:${actionId}`,
    mailboxId: 'mailbox-b'
  };
  assert.equal(graphNodeResourceId(otherMailboxNode, mailboxId), null);
  assert.equal(findSourceEmail(item, otherMailboxNode), null);
});

test('workspace node details hide internal ids and expose review context', () => {
  const fileDetails = workspaceNodeDetails({
    type: 'File',
    name: 'Brief.txt',
    sizeBytes: 20,
    modified: 'Sat, 12 Sep 2026 20:48:31 GMT'
  });
  assert.deepEqual(fileDetails.map((row) => row.label), ['Size', 'Modified']);
  assert.equal(fileDetails[0].value, '20 B');

  const actionDetails = workspaceNodeDetails({
    type: 'Commitment',
    confidence: 'needs_review',
    deadlineText: 'by Friday',
    evidence: 'Please review Brief.txt by Friday.'
  });
  assert.equal(actionDetails.find((row) => row.label === 'Confidence')?.value, 'Needs Review');
  assert.ok(!JSON.stringify(actionDetails).includes('t:tenant'));
});
