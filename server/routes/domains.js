import express from 'express';
import { ok, fail, requireAuth, rateLimit } from '../lib/http.js';
import { GraphUnavailableError } from '../services/graph.js';

export function domainRoutes({ db, config, limiter, domainService, relay, graph }) {
  const router = express.Router();
  router.use(requireAuth(db));

  router.get('/', (req, res) => {
    return ok(res, { domains: domainService.domainsForTenant(req.user.id) });
  });

  router.post('/', rateLimit(limiter, 'provision', config.rateLimits.provision), (req, res) => {
    const name = req.body?.name;
    const result = domainService.createDomain({ tenantId: req.user.id, name });
    if (!result.ok) return fail(res, result.status, result.code, result.message);
    return ok(res, {
      domain: result.domain,
      verifyRecord: result.verifyRecord || null,
      next: result.domain.kind === 'hosted'
        ? 'Create a mailbox on the hosted domain.'
        : 'Publish the TXT verification record (or connect Cloudflare), then verify.'
    });
  });

  router.get('/:id', (req, res) => {
    const detail = domainService.getDomainDetail(req.user.id, req.params.id);
    if (detail.error) return fail(res, detail.error.status, detail.error.code, detail.error.message);
    return ok(res, detail);
  });

  router.get('/:id/inspect', rateLimit(limiter, 'inspect', config.rateLimits.inspect), async (req, res) => {
    const result = await domainService.inspectDomain({ tenantId: req.user.id, domainId: req.params.id });
    if (!result.ok) return fail(res, result.status, result.code, result.message);
    return ok(res, result);
  });

  router.get('/:id/relay', async (req, res) => {
    const result = await relay.get({ tenantId: req.user.id, domainId: req.params.id });
    if (!result.ok) return fail(res, result.status, result.code, result.message);
    return ok(res, { relay: result.relay });
  });

  router.post('/:id/relay/prepare', rateLimit(limiter, 'provision', config.rateLimits.provision), async (req, res) => {
    const result = await relay.prepare({ tenantId: req.user.id, domainId: req.params.id });
    if (!result.ok) return fail(res, result.status, result.code, result.message);
    return ok(res, result);
  });

  router.post('/:id/relay/validate', rateLimit(limiter, 'provision', config.rateLimits.provision), async (req, res) => {
    const result = await relay.validate({ tenantId: req.user.id, domainId: req.params.id });
    if (!result.ok) return fail(res, result.status, result.code, result.message);
    return ok(res, result);
  });

  router.post('/:id/verify', rateLimit(limiter, 'provision', config.rateLimits.provision), async (req, res) => {
    const method = req.body?.method === 'cloudflare' ? 'cloudflare' : 'dns';
    const result = await domainService.verifyDomain({
      tenantId: req.user.id,
      domainId: req.params.id,
      method,
      cfToken: typeof req.body?.cfToken === 'string' ? req.body.cfToken : undefined
    });
    if (!result.ok) return fail(res, result.status || 400, result.code, result.message, {
      verifyRecord: result.verifyRecord,
      providerZone: result.providerZone
    });
    return ok(res, result);
  });

  router.post('/:id/plan', rateLimit(limiter, 'provision', config.rateLimits.provision), async (req, res) => {
    const result = await domainService.createPlan({
      tenantId: req.user.id,
      domainId: req.params.id,
      cfToken: typeof req.body?.cfToken === 'string' ? req.body.cfToken : undefined
    });
    if (!result.ok) return fail(res, result.status, result.code, result.message);
    return ok(res, result);
  });

  router.post('/:id/plan/apply', rateLimit(limiter, 'provision', config.rateLimits.provision), async (req, res) => {
    const result = await domainService.applyPlan({
      tenantId: req.user.id,
      domainId: req.params.id,
      planId: req.body?.planId,
      method: req.body?.method === 'cloudflare' ? 'cloudflare' : 'manual',
      approvals: req.body?.approvals && typeof req.body.approvals === 'object' ? req.body.approvals : {},
      planHash: typeof req.body?.planHash === 'string' ? req.body.planHash : undefined,
      dryRun: req.body?.dryRun === true
    });
    if (!result.ok) return fail(res, result.status, result.code, result.message, {
      conflicts: result.conflicts,
      requireApproval: result.requireApproval,
      results: result.results,
      summary: result.summary
    });
    return ok(res, result);
  });

  router.post('/:id/activate', rateLimit(limiter, 'provision', config.rateLimits.provision), async (req, res) => {
    const result = await domainService.activateDomain({ tenantId: req.user.id, domainId: req.params.id });
    if (!result.ok) return fail(res, result.status, result.code, result.message, { blockers: result.blockers, graphHint: result.graphHint });
    return ok(res, result);
  });

  router.get('/:id/graph', async (req, res) => {
    try {
      const g = await graph.getDomainGraph(req.user.id, req.params.id);
      return ok(res, { graph: g, status: graph.status() });
    } catch (err) {
      if (err instanceof GraphUnavailableError) {
        return fail(res, 503, 'graph_unavailable', err.message, { degraded: true, graphStatus: graph.status() });
      }
      throw err;
    }
  });

  router.get('/:id/impact', async (req, res) => {
    const recordId = req.query.recordId;
    if (typeof recordId !== 'string' || !recordId) {
      return fail(res, 400, 'record_required', 'recordId query parameter is required.');
    }
    try {
      const impacted = await graph.impact(req.user.id, recordId);
      return ok(res, { impacted });
    } catch (err) {
      if (err instanceof GraphUnavailableError) {
        return fail(res, 503, 'graph_unavailable', err.message, { degraded: true, graphStatus: graph.status() });
      }
      throw err;
    }
  });

  return router;
}
