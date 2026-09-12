import express from 'express';
import { ok, fail, requireAuth, rateLimit } from '../lib/http.js';
import { readWorkspaceSources } from '../services/workspace-knowledge.js';

// Only mailboxes that plausibly exist on the mail server justify an upstream lookup.
// A tenant with no mailbox (or only failed/queued ones) never triggers an admin API call.
const UPSTREAM_ELIGIBLE_STATUSES = new Set(['created', 'uncertain']);

const NOT_CONFIGURED_MESSAGE = 'The mail server admin API is not configured, so real storage usage cannot be checked right now.';

function parsePercent(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : null;
  if (typeof raw !== 'string') return null;
  const value = Number.parseFloat(raw.replace(/%/g, '').trim());
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function unmeasuredItem(mailbox) {
  if (mailbox.status === 'failed') {
    return {
      address: mailbox.address,
      mailboxStatus: mailbox.status,
      available: false,
      reason: 'creation_failed',
      message: 'No mailbox exists on the mail server for this address, so there is no storage to measure.'
    };
  }
  return {
    address: mailbox.address,
    mailboxStatus: mailbox.status,
    available: false,
    reason: 'creation_in_progress',
    message: 'Mailbox creation has not been confirmed yet; storage is measured after the mailbox exists.'
  };
}

function unavailableItem(mailbox, reason, message) {
  return { address: mailbox.address, mailboxStatus: mailbox.status, available: false, reason, message };
}

function measuredItem(mailbox, upstream) {
  return {
    address: mailbox.address,
    mailboxStatus: mailbox.status,
    available: true,
    // box_size stays exactly as the mail server measured it; quota bytes come from box_quota.
    used: upstream.boxSize,
    quota: upstream.quotaText,
    quotaBytes: upstream.boxQuotaBytes,
    percent: parsePercent(upstream.percentText),
    upstreamStatus: upstream.status
  };
}

export function workspaceRoutes({ db, config, limiter, mailboxService, mailserver, graph, snapshotBuilder, fetchImpl, workspaceReader = readWorkspaceSources }) {
  const router = express.Router();
  router.use(requireAuth(db));

  router.get('/knowledge', (req,res) => {
    const items = db.prepare('SELECT mailbox_id, data_json, synced_at FROM workspace_knowledge WHERE tenant_id = ?').all(req.user.id)
      .map((row) => ({mailboxId:row.mailbox_id,syncedAt:row.synced_at,...JSON.parse(row.data_json)}));
    return ok(res,{items});
  });
  router.post('/knowledge/sync', rateLimit(limiter,'knowledge',{by:'tenant',limit:5,windowMs:15*60*1000}), async (req,res) => {
    const mailbox = db.prepare('SELECT * FROM mailboxes WHERE id = ? AND tenant_id = ?').get(String(req.body?.mailboxId || ''),req.user.id);
    if (!mailbox || mailbox.status !== 'created') return fail(res,404,'mailbox_not_found','Choose a created mailbox on your account.');
    const password = req.body?.password;
    delete req.body.password;
    if (typeof password !== 'string' || !password || password.length > 1024) return fail(res,400,'password_required','Enter the mailbox password for this read-only sync.');
    let data;
    try {
      data = await workspaceReader({config,address:mailbox.address,password,fetchImpl,includeEmail:req.body?.includeEmail === true});
    } catch {
      return fail(res,502,'workspace_sync_failed','Could not read the workspace. Check your mailbox password and that Calendar and Files are available. Your previous snapshot is unchanged.');
    }
    const previousRow = db.prepare('SELECT data_json FROM workspace_knowledge WHERE tenant_id = ? AND mailbox_id = ?').get(req.user.id,mailbox.id);
    if (req.body?.includeEmail === true) data.emailSyncedAt = data.syncedAt;
    else if (previousRow) {
      const previous = JSON.parse(previousRow.data_json);
      if (previous.emailAnalyzed) {
        for (const key of ['emails','actions','emailAnalyzed','skippedLargeEmails']) data[key] = previous[key];
        data.emailSyncedAt = previous.emailSyncedAt || previous.syncedAt;
        const resourceIds = new Set([...data.events,...data.files].map((resource) => resource.id));
        data.mentions = previous.mentions.filter((mention) => resourceIds.has(mention.target));
      }
    }
    db.prepare('INSERT INTO workspace_knowledge (tenant_id,mailbox_id,data_json,synced_at) VALUES (?,?,?,?) ON CONFLICT(tenant_id,mailbox_id) DO UPDATE SET data_json=excluded.data_json,synced_at=excluded.synced_at')
      .run(req.user.id,mailbox.id,JSON.stringify(data),data.syncedAt);
    let graphStatus;
    try { graphStatus = await graph.project(req.user.id,snapshotBuilder(req.user.id)); }
    catch { graphStatus = {degraded:true}; }
    return ok(res,{item:{mailboxId:mailbox.id,...data},domainId:mailbox.domain_id,graphStatus});
  });
  router.delete('/knowledge/:mailboxId', async (req,res) => {
    db.prepare('DELETE FROM workspace_knowledge WHERE tenant_id = ? AND mailbox_id = ?').run(req.user.id,req.params.mailboxId);
    try { await graph.project(req.user.id,snapshotBuilder(req.user.id)); } catch { /* queued projection retries */ }
    return ok(res,{});
  });

  router.get('/', rateLimit(limiter, 'workspace', { ...config.rateLimits.inspect, by: 'tenant' }), async (req, res) => {
    const mailboxes = mailboxService.listForTenant(req.user.id);
    const eligible = mailboxes.filter((m) => UPSTREAM_ELIGIBLE_STATUSES.has(m.status));

    const storage = {
      status: 'no_mailbox',
      checkedAt: new Date().toISOString(),
      upstreamQueried: false,
      items: [],
      message: 'No mailbox exists on your account yet, so there is no storage to measure.'
    };

    if (mailboxes.length > 0 && eligible.length === 0) {
      storage.status = 'not_created';
      storage.message = 'None of your mailboxes exist on the mail server yet, so there is no storage to measure.';
      storage.items = mailboxes.map(unmeasuredItem);
    } else if (eligible.length > 0 && !mailserver.configured()) {
      storage.status = 'not_configured';
      storage.message = NOT_CONFIGURED_MESSAGE;
      storage.items = mailboxes.map((m) => (eligible.includes(m) ? unavailableItem(m, 'not_configured', NOT_CONFIGURED_MESSAGE) : unmeasuredItem(m)));
    } else if (eligible.length > 0) {
      storage.upstreamQueried = true;
      const list = await mailserver.listUsers();
      if (!list.ok) {
        storage.status = list.configured === false ? 'not_configured' : 'unavailable';
        const reason = String(list.error || 'the mail server could not be reached').replace(/\.+$/, '');
        storage.message = list.configured === false
          ? NOT_CONFIGURED_MESSAGE
          : `Storage usage is unavailable right now (${reason}). Nothing is estimated in its place.`;
        storage.items = mailboxes.map((m) => (eligible.includes(m) ? unavailableItem(m, 'upstream_unavailable', storage.message) : unmeasuredItem(m)));
      } else {
        storage.status = 'ok';
        storage.message = 'Storage figures below are measured by the mail server.';
        // Filter the upstream listing to addresses this tenant actually owns; nothing else may surface.
        const owned = new Set(mailboxes.map((m) => String(m.address).toLowerCase()));
        const byEmail = new Map();
        for (const u of list.users) {
          if (u.email && owned.has(u.email)) byEmail.set(u.email, u);
        }
        storage.items = mailboxes.map((m) => {
          if (!UPSTREAM_ELIGIBLE_STATUSES.has(m.status)) return unmeasuredItem(m);
          const upstream = byEmail.get(String(m.address).toLowerCase());
          return upstream
            ? measuredItem(m, upstream)
            : unavailableItem(m, 'not_reported', 'The mail server did not report storage for this address (it may not exist upstream yet).');
        });
      }
    }

    return ok(res, {
      workspace: {
        storage,
        notes: {
          credentials: 'The mail, calendar and files portals use your mailbox credentials: sign in with your mailbox address and the mailbox password you set at creation — not your Workspace app password.',
          files: 'Files storage is separate. The optional workspace graph sync reads its usage and file metadata with your mailbox credentials.',
          measurement: 'Storage is measured by the mail server and can lag slightly. When it is unreachable the app shows unavailable rather than guessing.'
        }
      }
    });
  });

  return router;
}
