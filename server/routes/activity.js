import express from 'express';
import { ok, requireAuth } from '../lib/http.js';

export function activityRoutes({ db }) {
  const router = express.Router();
  router.use(requireAuth(db));

  router.get('/', (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const domainId = typeof req.query.domainId === 'string' && req.query.domainId ? req.query.domainId : null;

    const params = [req.user.id];
    let where = 'WHERE a.tenant_id = ?';
    if (domainId) {
      where += ' AND a.domain_id = ?';
      params.push(domainId);
    }
    params.push(limit);
    const rows = db.prepare(`
      SELECT a.*, d.name AS domain_name FROM activity a
      LEFT JOIN domains d ON d.id = a.domain_id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT ?
    `).all(...params);

    return ok(res, {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        message: r.message,
        domainId: r.domain_id,
        domain: r.domain_name,
        mailboxId: r.mailbox_id,
        data: r.data_json ? JSON.parse(r.data_json) : null,
        createdAt: r.created_at
      }))
    });
  });

  return router;
}
