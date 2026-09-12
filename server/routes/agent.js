import express from 'express';
import { ok, fail, requireAuth, rateLimit } from '../lib/http.js';
import { llmConfigured } from '../lib/env.js';

export function agentRoutes({ db, config, limiter, agentService }) {
  const router = express.Router();
  router.use(requireAuth(db));

  router.get('/info', (req, res) => {
    return ok(res, {
      mode: llmConfigured(config) ? 'ai_assisted' : 'rule_based',
      modeNote: llmConfigured(config)
        ? `LLM explanations enabled (${config.llm.model}). Statuses always come from deterministic tool results.`
        : 'Rule-based setup assistant — no LLM is configured on the server.',
      capabilities: [
        'inspect_domain', 'run_checks', 'find_blockers', 'plan_actions', 'verify_state'
      ],
      writePolicy: 'Never applies DNS changes or creates mailboxes. Write actions go through the normal plan/approve endpoints.'
    });
  });

  router.post('/ask', rateLimit(limiter, 'agent', config.rateLimits.agent), async (req, res) => {
    const domainId = String(req.body?.domainId || '');
    if (!domainId) return fail(res, 400, 'domain_required', 'domainId is required.');
    const question = typeof req.body?.question === 'string' ? req.body.question.slice(0, 500) : '';
    const result = await agentService.runAgent({ tenantId: req.user.id, domainId, question });
    if (!result.ok) return fail(res, result.status || 500, result.code || 'agent_failed', result.message || 'The assistant could not complete the request.');
    return ok(res, result);
  });

  router.post('/investigate', rateLimit(limiter, 'agent', config.rateLimits.agent), async (req, res) => {
    const domainId = typeof req.body?.domainId === 'string' ? req.body.domainId.trim() : '';
    if (!domainId || domainId.length > 100) return fail(res,400,'domain_required','A valid domainId is required.');
    const controller = new AbortController();
    const stop = () => controller.abort();
    res.on('close',stop);
    res.set({'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    res.flushHeaders();
    const send = event => { if (!res.destroyed && !controller.signal.aborted) res.write(JSON.stringify(event)+'\n'); };
    try {
      const result = await agentService.investigate({tenantId:req.user.id,domainId,onEvent:send,signal:controller.signal});
      if (!result.ok) send({type:'error',message:result.status===404?'Domain not found or not accessible.':'The investigation could not start.'});
      else send({type:'result',result});
    } catch {
      send({type:'error',message:'The investigation could not finish. Please try again.'});
    } finally {
      res.off('close',stop);
      if (!res.destroyed) res.end();
    }
  });

  return router;
}
