import { recordActivity, cryptoRandomId } from '../db.js';
import { buildAddress, validateLocalPart } from './domain-names.js';
import { MAIL_SERVER_QUOTA_LIMITATION } from './mailserver.js';

const ACTIVE_STATUSES = ['pending', 'creating', 'created', 'uncertain'];
const MAIL_SERVER_RECONCILE_GRACE_MS = 30_000;

export function createMailboxService({ db, config, mailserver, graph, logger, snapshotBuilder }) {
  const inFlightCreates = new Set();
  const reconcileGraceMs = Number.isFinite(config.mailboxReconcileGraceMs)
    ? Math.max(1_000, config.mailboxReconcileGraceMs)
    : MAIL_SERVER_RECONCILE_GRACE_MS;

  function listForTenant(tenantId) {
    return db.prepare(`
      SELECT m.*, d.name AS domain_name, d.kind AS domain_kind
      FROM mailboxes m JOIN domains d ON d.id = m.domain_id
      WHERE m.tenant_id = ?
      ORDER BY m.created_at DESC
    `).all(tenantId).map(shaped);
  }

  function shaped(row) {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      domainId: row.domain_id,
      domain: row.domain_name,
      domainKind: row.domain_kind,
      localPart: row.local_part,
      address: row.address,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      upstreamConfirmedAt: row.upstream_confirmed_at,
      delivery: {
        inbound: 'unknown',
        outbound: 'unknown',
        note: 'Not tested. Delivery status is only known after a real message round-trip.'
      },
      quota: { note: MAIL_SERVER_QUOTA_LIMITATION }
    };
  }

  function getMailbox(tenantId, mailboxId) {
    const row = db.prepare(`
      SELECT m.*, d.name AS domain_name, d.kind AS domain_kind
      FROM mailboxes m JOIN domains d ON d.id = m.domain_id
      WHERE m.tenant_id = ? AND m.id = ?
    `).get(tenantId, mailboxId);
    return row ? shaped(row) : null;
  }

  function getMailboxForDomain(tenantId, domainId) {
    return db.prepare('SELECT * FROM mailboxes WHERE tenant_id = ? AND domain_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(tenantId, domainId) || null;
  }

  function activeCount(where = '', params = []) {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
    const row = db.prepare(`SELECT COUNT(*) AS n FROM mailboxes WHERE status IN (${placeholders}) ${where}`).get(...ACTIVE_STATUSES, ...params);
    return row.n;
  }

  function activeCountForTenant(tenantId) {
    return activeCount('AND tenant_id = ?', [tenantId]);
  }

  function getJob(tenantId, jobId) {
    const row = db.prepare('SELECT * FROM jobs WHERE tenant_id = ? AND id = ?').get(tenantId, jobId);
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      payload: row.payload_json ? JSON.parse(row.payload_json) : null,
      result: row.result_json ? JSON.parse(row.result_json) : null
    };
  }

  function isWithinReconcileGrace(row) {
    const updatedAt = Date.parse(row.updated_at || '');
    return Number.isFinite(updatedAt) && Date.now() - updatedAt < reconcileGraceMs;
  }

  function uncertainResult(tenantId, row, message = 'The mail server request is still uncertain. Wait for the reconciliation grace period, then check status again; do not retry blindly.') {
    return {
      ok: false,
      status: 202,
      uncertain: true,
      code: 'creation_uncertain',
      message,
      mailbox: getMailbox(tenantId, row.id),
      job: row.job_id ? getJob(tenantId, row.job_id) : null
    };
  }

  function conditionalMailboxTransition({ tenantId, row, status, now, confirmed = false, jobStatus, jobError = null }) {
    return db.transaction(() => {
      const latest = db.prepare('SELECT * FROM mailboxes WHERE tenant_id = ? AND id = ?').get(tenantId, row.id);
      if (!latest || !MAIL_SERVER_ACTIVE_STATUSES.has(latest.status)) return { changed: false, latest };
      const mailboxUpdate = confirmed
        ? db.prepare(`UPDATE mailboxes
            SET status = ?, upstream_confirmed_at = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND status = ?`)
        : db.prepare(`UPDATE mailboxes
            SET status = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND status = ?`);
      const result = confirmed
        ? mailboxUpdate.run(status, now, now, tenantId, row.id, latest.status)
        : mailboxUpdate.run(status, now, tenantId, row.id, latest.status);
      if (result.changes !== 1) {
        return { changed: false, latest: db.prepare('SELECT * FROM mailboxes WHERE tenant_id = ? AND id = ?').get(tenantId, row.id) };
      }
      if (latest.job_id && jobStatus) {
        db.prepare(`UPDATE jobs SET status = ?, result_json = CASE WHEN ? = 'succeeded' THEN ? ELSE result_json END,
          error = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status IN ('in_progress', 'uncertain')`)
          .run(
            jobStatus,
            jobStatus,
            jobStatus === 'succeeded' ? JSON.stringify({ address: row.address, upstream: 'confirmed_on_reconcile' }) : null,
            jobError,
            now,
            tenantId,
            latest.job_id
          );
      }
      return { changed: true, latest: db.prepare('SELECT * FROM mailboxes WHERE tenant_id = ? AND id = ?').get(tenantId, row.id) };
    })();
  }

  async function upstreamStateFor(address) {
    const check = await mailserver.userExists(address);
    if (!check.ok) {
      return {
        ok: false,
        code: check.configured === false ? 'mailserver_unconfigured' : 'mailserver_unavailable',
        message: check.configured === false
          ? 'The mail server admin API is not configured. Ask the operator to set MAIL_SERVER_BASE_URL, MAIL_SERVER_USERNAME, and MAIL_SERVER_PASSWORD.'
          : `Could not reach the mail server to check for existing addresses: ${check.error || 'unknown error'}`
      };
    }
    return { ok: true, exists: check.exists };
  }

  async function createMailbox({ tenantId, domainId, localPart, mailboxPassword }) {
    const domain = db.prepare('SELECT * FROM domains WHERE id = ?').get(domainId);
    if (!domain) return { ok: false, status: 404, code: 'domain_not_found', message: 'Domain not found.' };
    const ownedByTenant = domain.tenant_id === tenantId;
    const hostedShared = domain.kind === 'hosted';
    if (!ownedByTenant && !hostedShared) {
      return { ok: false, status: 404, code: 'domain_not_found', message: 'Domain not found.' };
    }
    if (!hostedShared && !domain.verified_at) {
      return { ok: false, status: 409, code: 'ownership_required', message: 'Verify domain ownership before creating mailboxes on it.' };
    }

    const localCheck = validateLocalPart(localPart, { reserved: config.reservedLocalparts, hosted: hostedShared });
    if (!localCheck.ok) return { ok: false, status: 400, code: 'invalid_local_part', message: localCheck.error };
    const local = localCheck.localPart;
    const address = buildAddress(local, domain.name);

    if (typeof mailboxPassword !== 'string' || mailboxPassword.length < 10) {
      return { ok: false, status: 400, code: 'weak_password', message: 'Mailbox password must be at least 10 characters.' };
    }

    if (!mailserver.configured()) {
      return {
        ok: false,
        status: 503,
        code: 'mailserver_unconfigured',
        message: 'The mail server admin API is not configured, so mailboxes cannot be created yet. Ask the operator to set MAIL_SERVER_BASE_URL, MAIL_SERVER_USERNAME, and MAIL_SERVER_PASSWORD.'
      };
    }

    if (activeCount() >= config.globalMailboxCap) {
      return { ok: false, status: 503, code: 'capacity_reached', message: 'The server has reached its mailbox capacity. Contact the operator.' };
    }
    if (activeCountForTenant(tenantId) >= config.mailboxLimitPerAccount) {
      return {
        ok: false, status: 409, code: 'account_limit',
        message: `This account is limited to ${config.mailboxLimitPerAccount} mailbox${config.mailboxLimitPerAccount === 1 ? '' : 'es'}.`
      };
    }

    let existing = db.prepare('SELECT * FROM mailboxes WHERE address = ?').get(address);
    if (existing && existing.tenant_id !== tenantId) {
      recordActivity(db, {
        tenantId, domainId, kind: 'mailbox.collision',
        message: `Address ${address} is already taken; the existing mailbox was left untouched.`,
        data: { address }
      });
      return { ok: false, status: 409, code: 'address_taken', message: `The address ${address} is already in use. Existing mailboxes are never taken over — choose a different name.` };
    }
    if (existing && ['pending', 'creating'].includes(existing.status)) {
      return { ok: false, status: 409, code: 'creation_in_progress', message: 'A mailbox creation for this address is already in progress.' };
    }
    if (existing && existing.status === 'created') {
      return { ok: false, status: 409, code: 'already_created', message: `${address} already exists on your account.` };
    }
    if (existing && existing.status === 'uncertain' && isWithinReconcileGrace(existing)) {
      // A read-only existence check may safely confirm a mailbox that landed.
      // An absent result remains uncertain until the grace period has elapsed.
      const graceCheck = await upstreamStateFor(address);
      if (!graceCheck.ok) return { ok: false, status: 503, code: graceCheck.code, message: graceCheck.message };
      if (graceCheck.exists) {
        const now = new Date().toISOString();
        conditionalMailboxTransition({
          tenantId,
          row: existing,
          status: 'created',
          now,
          confirmed: true,
          jobStatus: 'succeeded'
        });
        return { ok: false, status: 409, code: 'address_taken', message: `The address ${address} already exists on the mail server. Existing mailboxes are never taken over or reset — choose a different name.` };
      }
      return uncertainResult(tenantId, existing);
    }

    const upstream = await upstreamStateFor(address);
    if (!upstream.ok) {
      return { ok: false, status: 503, code: upstream.code, message: upstream.message };
    }
    if (upstream.exists) {
      recordActivity(db, {
        tenantId, domainId, kind: 'mailbox.collision',
        message: `${address} already exists on the mail server; it was not modified.`,
        data: { address, source: 'mailserver' }
      });
      if (existing && existing.status === 'uncertain') {
        const now = new Date().toISOString();
        const transitioned = conditionalMailboxTransition({
          tenantId,
          row: existing,
          status: 'created',
          now,
          confirmed: true,
          jobStatus: 'succeeded'
        });
        if (!transitioned.changed && transitioned.latest?.status === 'creating') {
          return uncertainResult(tenantId, transitioned.latest, 'A mailbox creation is still in progress; its upstream result is not yet safe to retry.');
        }
      }
      return { ok: false, status: 409, code: 'address_taken', message: `The address ${address} already exists on the mail server. Existing mailboxes are never taken over or reset — choose a different name.` };
    }

    if (existing && existing.status === 'uncertain') {
      // Only an aged, positively rechecked absence can release the reservation.
      const now = new Date().toISOString();
      const transitioned = conditionalMailboxTransition({
        tenantId,
        row: existing,
        status: 'failed',
        now,
        jobStatus: 'failed',
        jobError: 'Reconciled: no mailbox exists upstream after the uncertainty grace period.'
      });
      if (!transitioned.changed) {
        if (transitioned.latest?.status === 'uncertain' || transitioned.latest?.status === 'creating' || transitioned.latest?.status === 'pending') {
          return uncertainResult(tenantId, transitioned.latest, 'The mailbox reservation changed while it was being reconciled; wait and check status again.');
        }
        existing = transitioned.latest;
      } else {
        recordActivity(db, {
          tenantId, domainId, mailboxId: existing.id, kind: 'mailbox.reconciled',
          message: `Reconciled ${address}: no upstream mailbox exists after the uncertainty grace period; safe to retry.`,
          data: { address }
        });
      }
    }

    const now = new Date().toISOString();
    const mailboxId = existing ? existing.id : cryptoRandomId();
    const jobId = cryptoRandomId();

    const persist = db.transaction(() => {
      if (activeCount() >= config.globalMailboxCap || activeCountForTenant(tenantId) >= config.mailboxLimitPerAccount) {
        const e = new Error('Mailbox capacity reached.'); e.code = 'capacity_reached'; throw e;
      }
      const latest = db.prepare('SELECT * FROM mailboxes WHERE address = ?').get(address);
      if (latest && (latest.tenant_id !== tenantId || ACTIVE_STATUSES.includes(latest.status))) {
        const e = new Error('This mailbox is already reserved or being created.'); e.code = 'address_taken'; throw e;
      }
      if (existing) {
        db.prepare('UPDATE mailboxes SET status = ?, job_id = ?, updated_at = ? WHERE id = ?')
          .run('creating', jobId, now, mailboxId);
      } else {
        db.prepare(`INSERT INTO mailboxes (id, tenant_id, domain_id, local_part, address, status, job_id, upstream_confirmed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
          .run(mailboxId, tenantId, domainId, local, address, 'creating', jobId, now, now);
      }
      // Job state is written before the external write; payload intentionally excludes the password.
      db.prepare(`INSERT INTO jobs (id, tenant_id, domain_id, mailbox_id, type, status, payload_json, result_json, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'mailbox_create', 'in_progress', ?, NULL, NULL, ?, ?)`)
        .run(jobId, tenantId, domainId, mailboxId, JSON.stringify({ address, domainId }), now, now);
      db.prepare(`INSERT INTO setup_actions (id, tenant_id, domain_id, kind, status, target_check, created_at, updated_at)
        VALUES (?, ?, ?, 'create_mailbox', 'in_progress', 'mailbox', ?, ?)`)
        .run(cryptoRandomId(), tenantId, domainId, now, now);
    });
    try { persist(); } catch (err) {
      return {ok:false,status:409,code:err.code === 'capacity_reached' ? err.code : 'address_taken',message:'Mailbox capacity or address reservation changed. Refresh before trying again.'};
    }

    recordActivity(db, {
      tenantId, domainId, mailboxId, kind: 'mailbox.creating',
      message: `Requested mailbox ${address} from the mail server.`,
      data: { address, jobId }
    });

    inFlightCreates.add(mailboxId);
    let result;
    try {
      result = await mailserver.addUser({ email: address, password: mailboxPassword });
    } finally {
      inFlightCreates.delete(mailboxId);
    }

    const finishedAt = new Date().toISOString();
    if (result.ok) {
      db.prepare('UPDATE mailboxes SET status = ?, upstream_confirmed_at = ?, updated_at = ? WHERE id = ?')
        .run('created', finishedAt, finishedAt, mailboxId);
      db.prepare('UPDATE jobs SET status = ?, result_json = ?, updated_at = ? WHERE id = ?')
        .run('succeeded', JSON.stringify({ address, upstream: 'confirmed' }), finishedAt, jobId);
      db.prepare(`UPDATE setup_actions SET status = 'done', updated_at = ? WHERE domain_id = ? AND tenant_id = ? AND kind = 'create_mailbox' AND status = 'in_progress'`)
        .run(finishedAt, domainId, tenantId);
      recordActivity(db, {
        tenantId, domainId, mailboxId, kind: 'mailbox.created',
        message: `Mailbox ${address} created on the mail server.`,
        data: { address }
      });
      projectTenant(tenantId);
      return {
        ok: true,
        mailbox: getMailbox(tenantId, mailboxId),
        job: getJob(tenantId, jobId),
        limitations: [MAIL_SERVER_QUOTA_LIMITATION],
        delivery: { inbound: 'unknown', outbound: 'unknown', note: 'Delivery is not verified until a real test message round-trips.' }
      };
    }

    if (result.timeout) {
      db.prepare('UPDATE mailboxes SET status = ?, updated_at = ? WHERE id = ?').run('uncertain', finishedAt, mailboxId);
      db.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('uncertain', 'Mail server did not confirm within the timeout.', finishedAt, jobId);
      db.prepare(`UPDATE setup_actions SET status = 'pending', updated_at = ? WHERE domain_id = ? AND tenant_id = ? AND kind = 'create_mailbox' AND status = 'in_progress'`)
        .run(finishedAt, domainId, tenantId);
      recordActivity(db, {
        tenantId, domainId, mailboxId, kind: 'mailbox.uncertain',
        message: `Mail server did not confirm ${address} in time. Status is uncertain — reconcile before retrying; the mailbox will never be reset.`,
        data: { address, jobId }
      });
      projectTenant(tenantId);
      return {
        ok: false,
        status: 202,
        uncertain: true,
        code: 'creation_uncertain',
        message: 'The mail server did not respond in time. The request may or may not have been applied. Use "Check status" to reconcile — do not retry blindly.',
        mailbox: getMailbox(tenantId, mailboxId),
        job: getJob(tenantId, jobId)
      };
    }

    db.prepare('UPDATE mailboxes SET status = ?, updated_at = ? WHERE id = ?').run('failed', finishedAt, mailboxId);
    db.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run('failed', result.error || 'Mail server rejected the request.', finishedAt, jobId);
    db.prepare(`UPDATE setup_actions SET status = 'failed', updated_at = ? WHERE domain_id = ? AND tenant_id = ? AND kind = 'create_mailbox' AND status = 'in_progress'`)
      .run(finishedAt, domainId, tenantId);
    recordActivity(db, {
      tenantId, domainId, mailboxId, kind: 'mailbox.failed',
      message: `Mail server rejected mailbox ${address}: ${result.error || 'unknown error'}`,
      data: { address, jobId }
    });
    projectTenant(tenantId);
    return {
      ok: false,
      status: 502,
      code: 'mail_server_error',
      message: `The mail server rejected the request: ${result.error || 'unknown error'}`,
      mailbox: getMailbox(tenantId, mailboxId),
      job: getJob(tenantId, jobId)
    };
  }

  async function reconcileMailbox({ tenantId, mailboxId }) {
    const row = db.prepare('SELECT * FROM mailboxes WHERE tenant_id = ? AND id = ?').get(tenantId, mailboxId);
    if (!row) return { ok: false, status: 404, code: 'not_found', message: 'Mailbox not found.' };
    if (!MAIL_SERVER_ACTIVE_STATUSES.has(row.status)) {
      return { ok: true, mailbox: getMailbox(tenantId, mailboxId), reconciled: false, message: `Nothing to reconcile; status is ${row.status}.` };
    }
    if (inFlightCreates.has(row.id)) {
      return {
        ok: true,
        reconciled: false,
        pending: true,
        message: 'Mailbox creation is still in progress upstream. No local state was changed; check again after the request settles.',
        mailbox: getMailbox(tenantId, mailboxId)
      };
    }
    if (isWithinReconcileGrace(row) && row.status !== 'uncertain') {
      return {
        ok: true,
        reconciled: false,
        pending: true,
        message: 'The upstream result is still uncertain. No local state was changed; wait before reconciling again.',
        mailbox: getMailbox(tenantId, mailboxId)
      };
    }
    const upstream = await mailserver.userExists(row.address);
    if (!upstream.ok) {
      return { ok: false, status: 503, code: 'mailserver_unavailable', message: upstream.error || 'Could not reach the mail server.' };
    }
    const now = new Date().toISOString();
    if (upstream.exists) {
      const transitioned = conditionalMailboxTransition({
        tenantId,
        row,
        status: 'created',
        now,
        confirmed: true,
        jobStatus: 'succeeded'
      });
      if (!transitioned.changed) {
        return {
          ok: true,
          reconciled: false,
          pending: ['creating', 'pending', 'uncertain'].includes(transitioned.latest?.status),
          mailbox: getMailbox(tenantId, mailboxId),
          message: 'Mailbox state changed while reconciling; no competing state was overwritten.'
        };
      }
      recordActivity(db, {
        tenantId, domainId: row.domain_id, mailboxId: row.id, kind: 'mailbox.reconciled',
        message: `Reconciled ${row.address}: confirmed on the mail server. Its password was not touched.`,
        data: { address: row.address }
      });
      projectTenant(tenantId);
      return { ok: true, reconciled: true, exists: true, mailbox: getMailbox(tenantId, mailboxId) };
    }
    if (isWithinReconcileGrace(row)) {
      return {
        ok: true,
        reconciled: false,
        pending: true,
        exists: false,
        message: 'The upstream check still shows no mailbox, but the original request remains within its uncertainty grace period. No local state was changed.',
        mailbox: getMailbox(tenantId, mailboxId)
      };
    }
    const transitioned = conditionalMailboxTransition({
      tenantId,
      row,
      status: 'failed',
      now,
      jobStatus: 'failed',
      jobError: 'Reconciled: no mailbox exists upstream after the uncertainty grace period.'
    });
    if (!transitioned.changed) {
      return {
        ok: true,
        reconciled: false,
        pending: ['creating', 'pending', 'uncertain'].includes(transitioned.latest?.status),
        mailbox: getMailbox(tenantId, mailboxId),
        message: 'Mailbox state changed while reconciling; no competing state was overwritten.'
      };
    }
    recordActivity(db, {
      tenantId, domainId: row.domain_id, mailboxId: row.id, kind: 'mailbox.reconciled',
      message: `Reconciled ${row.address}: not present upstream after the uncertainty grace period — creation did not land.`,
      data: { address: row.address }
    });
    projectTenant(tenantId);
    return { ok: true, reconciled: true, exists: false, mailbox: getMailbox(tenantId, mailboxId) };
  }

  function projectTenant(tenantId) {
    try {
      const snapshot = snapshotBuilder(tenantId);
      graph.project(tenantId, snapshot).catch(() => {});
    } catch (err) {
      logger?.warn('snapshot build failed', { error: String(err && err.message) });
    }
  }

  return { listForTenant, getMailbox, getMailboxForDomain, createMailbox, reconcileMailbox, projectTenant, activeCountForTenant };
}

const MAIL_SERVER_ACTIVE_STATUSES = new Set(['creating', 'uncertain', 'pending']);
