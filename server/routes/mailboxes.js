import express from 'express';
import { ok, fail, requireAuth, rateLimit } from '../lib/http.js';
import { MAIL_SERVER_QUOTA_LIMITATION } from '../services/mailserver.js';

export function mailboxRoutes({ db, config, limiter, mailboxService }) {
  const router = express.Router();
  router.use(requireAuth(db));

  router.get('/', (req, res) => {
    return ok(res, {
      mailboxes: mailboxService.listForTenant(req.user.id),
      limits: {
        perAccount: config.mailboxLimitPerAccount,
        globalCap: config.globalMailboxCap,
        used: mailboxService.activeCountForTenant(req.user.id)
      },
      notes: {
        quota: MAIL_SERVER_QUOTA_LIMITATION,
        passwordPolicy: 'Passwords are chosen by you at creation, sent once to the mail server, and never stored or logged by this app.',
        delivery: 'Delivery status is unknown until a real test message round-trips.'
      }
    });
  });

  router.post('/', rateLimit(limiter, 'mailbox', config.rateLimits.mailboxCreate), async (req, res) => {
    const result = await mailboxService.createMailbox({
      tenantId: req.user.id,
      domainId: String(req.body?.domainId || ''),
      localPart: String(req.body?.localPart || ''),
      mailboxPassword: String(req.body?.password || '')
    });
    if (!result.ok) {
      if (result.uncertain) {
        return res.status(202).json({ ok: false, error: { code: result.code, message: result.message, uncertain: true }, mailbox: result.mailbox, job: result.job });
      }
      return fail(res, result.status, result.code, result.message, { mailbox: result.mailbox, job: result.job });
    }
    return ok(res, { mailbox: result.mailbox, job: result.job, limitations: result.limitations, delivery: result.delivery });
  });

  router.get('/:id', (req, res) => {
    const mailbox = mailboxService.getMailbox(req.user.id, req.params.id);
    if (!mailbox) return fail(res, 404, 'mailbox_not_found', 'Mailbox not found.');
    return ok(res, { mailbox });
  });

  router.post('/:id/reconcile', rateLimit(limiter, 'mailbox', config.rateLimits.mailboxCreate), async (req, res) => {
    const result = await mailboxService.reconcileMailbox({ tenantId: req.user.id, mailboxId: req.params.id });
    if (!result.ok) return fail(res, result.status, result.code, result.message);
    return ok(res, result);
  });

  return router;
}
