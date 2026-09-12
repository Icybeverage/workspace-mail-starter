import { createInvestigator } from './investigation.js';
import crypto from 'node:crypto';
import { llmConfigured } from '../lib/env.js';

const SAFE_STEP_LIMIT = 6;

function deliveryVerified(delivery) {
  return delivery?.inbound === 'pass' && delivery?.outbound === 'pass';
}

function enforceDeliveryHonesty(text, delivery) {
  if (deliveryVerified(delivery)) return text;
  const withoutCompletionClaim = text.replace(
    /\b(?:the )?(?:email )?setup(?: is)? complete\b/gi,
    'DNS setup checks pass, but delivery is unverified'
  );
  if (/delivery (?:is )?(?:unverified|unknown)|delivery status/i.test(withoutCompletionClaim)) return withoutCompletionClaim;
  return `${withoutCompletionClaim} Delivery remains unverified until a real message round-trip.`;
}

export function createAgentService({ db, config, domainService, graph, logger, fetchImpl = fetch }) {
  async function runAgent({ tenantId, domainId, question }) {
    const steps = [];
    const startedAt = new Date().toISOString();

    const detail = domainService.getDomainDetail(tenantId, domainId);
    if (detail.error) return { ok: false, status: detail.error.status, code: detail.error.code, message: detail.error.message };
    if (steps.length < SAFE_STEP_LIMIT) {
      steps.push({
        tool: 'inspect_domain',
        status: 'ok',
        at: new Date().toISOString(),
        summary: `Domain ${detail.domain.name} (${detail.domain.kind}) is "${detail.domain.status}" with ${detail.mailboxes.length} mailbox(es).`,
        result: {
          status: detail.domain.status,
          ownershipVerified: Boolean(detail.domain.verifiedAt),
          mailboxes: detail.mailboxes.map((m) => ({ address: m.address, status: m.status }))
        }
      });
    }

    const inspection = await domainService.inspectDomain({ tenantId, domainId, persist: true });
    if (!inspection.ok) return { ok: false, status: inspection.status, code: inspection.code, message: inspection.message };
    steps.push({
      tool: 'run_checks',
      status: 'ok',
      at: new Date().toISOString(),
      summary: `Ran live DNS checks: ${inspection.checks.map((c) => `${c.scope}=${c.status}`).join(', ')}.`,
      result: { checks: inspection.checks.map((c) => ({ scope: c.scope, status: c.status })) }
    });

    let blockers = [];
    let blockersSource = 'sql';
    if (graph.status().available) {
      try {
        blockers = await graph.blockers(tenantId, domainId);
        blockersSource = 'graph';
      } catch (err) {
        logger?.warn('graph blockers failed; falling back to SQL-derived blockers', { error: String(err && err.message) });
      }
    }
    if (blockersSource === 'sql') {
      blockers = sqlBlockers(detail, inspection);
    }
    steps.push({
      tool: 'find_blockers',
      status: 'ok',
      at: new Date().toISOString(),
      summary: blockers.length === 0
        ? 'No blockers found for activation.'
        : `${blockers.length} blocker(s): ${blockers.map((b) => `${b.scope || b.type}/${b.state || b.status}`).join(', ')}`,
      source: blockersSource,
      result: { blockers }
    });
    const graphStatus = graph.status();
    if (blockersSource === 'sql' && graphStatus.enabled && graphStatus.degraded) {
      steps.push({
        tool: 'graph_status',
        status: 'degraded',
        at: new Date().toISOString(),
        summary: `Graph is degraded (${graphStatus.lastError || 'unavailable'}); blockers were derived from SQL state with the same traversal rules.`,
        result: graphStatus
      });
    }

    const suggestions = suggestActions(detail, inspection, blockers);
    steps.push({
      tool: 'plan_actions',
      status: 'ok',
      at: new Date().toISOString(),
      summary: suggestions.length === 0
        ? 'DNS setup checks currently pass; delivery remains unverified until a real message round-trip.'
        : `Next actions: ${suggestions.map((s) => s.id).join(', ')}.`,
      result: { suggestions }
    });

    const post = await domainService.inspectDomain({ tenantId, domainId, persist: true });
    const before = new Map(inspection.checks.map((c) => [c.scope, c.status]));
    const changes = post.ok
      ? post.checks.filter((c) => before.get(c.scope) !== c.status).map((c) => ({ scope: c.scope, from: before.get(c.scope), to: c.status }))
      : [];
    steps.push({
      tool: 'verify_state',
      status: 'ok',
      at: new Date().toISOString(),
      summary: changes.length === 0
        ? 'Re-checked after the workflow: no state changes observed.'
        : `Re-checked: ${changes.map((c) => `${c.scope} ${c.from}→${c.to}`).join(', ')}.`,
      result: {
        checks: post.ok ? post.checks.map((c) => ({ scope: c.scope, status: c.status })) : [],
        changes,
        delivery: post.ok ? post.delivery : null
      }
    });

    const applyNote = suggestions.length > 0
      ? 'Write actions (DNS changes, mailbox creation) are never applied by the assistant. Use the plan buttons so approvals and backups stay intact.'
      : null;

    let answer = ruleBasedAnswer({ detail, inspection, blockers, suggestions, changes, graphStatus: graph.status() });
    let mode = 'rule_based';
    let llmNote = 'Rule-based setup assistant — no LLM is configured on the server.';

    if (llmConfigured(config)) {
      const llmResult = await explainWithLlm({ detail, inspection, blockers, suggestions, question });
      if (llmResult.ok) {
        answer = llmResult.text;
        mode = 'ai_assisted';
        llmNote = `Explanation written by ${config.llm.model} from the tool results above; all statuses come from the checks, not the model.`;
      } else {
        llmNote = `LLM explanation unavailable (${llmResult.error}); using rule-based explanation instead.`;
      }
    }
    answer = enforceDeliveryHonesty(answer, inspection.delivery);

    db.prepare(`INSERT INTO activity (id, tenant_id, domain_id, mailbox_id, kind, message, data_json, created_at)
      VALUES (?, ?, ?, NULL, 'agent.run', ?, ?, ?)`)
      .run(crypto.randomUUID(), tenantId, domainId, `Assistant run (${mode}) for ${detail.domain.name}.`, JSON.stringify({ steps: steps.map((s) => s.tool), mode, question: question ? question.slice(0, 200) : null }), new Date().toISOString());

    return {
      ok: true,
      mode,
      modeNote: llmNote,
      question: question || null,
      answer,
      blockers,
      suggestions,
      applyNote,
      steps,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  }

  function sqlBlockers(detail, inspection) {
    const out = [];
    for (const c of inspection.checks) {
      if (['fail', 'warn', 'pending', 'unknown'].includes(c.status)) {
        out.push({ scope: c.scope, state: c.status, detail: c.details, dependentMailboxes: detail.mailboxes.map((m) => m.address) });
      }
    }
    if (!detail.domain.verifiedAt && detail.domain.kind === 'custom') {
      out.push({ scope: 'ownership', state: 'fail', detail: { hint: detail.domain.verifyRecord }, dependentMailboxes: [] });
    }
    return out;
  }

  function suggestActions(detail, inspection, blockers) {
    const s = [];
    if (detail.domain.kind === 'custom' && !detail.domain.verifiedAt) {
      s.push({ id: 'verify_ownership', label: 'Verify domain ownership', why: detail.domain.verifyRecord ? `Add TXT ${detail.domain.verifyRecord.name}` : 'Use Cloudflare or TXT verification' });
    }
    if (detail.domain.kind === 'custom' && detail.domain.verifiedAt && !detail.plan) {
      s.push({ id: 'create_dns_plan', label: 'Create the DNS plan', why: 'Dry-run review of records before anything is written' });
    }
    if (detail.plan && detail.plan.status === 'draft') {
      const conflicts = detail.plan.conflicts.length;
      s.push({
        id: conflicts ? 'resolve_conflicts' : 'apply_dns_plan',
        label: conflicts ? `Resolve ${conflicts} DNS conflict(s)` : 'Apply the reviewed DNS plan',
        why: conflicts ? 'SPF conflicts require a manual merge' : 'Applies via Cloudflare (with backups) or shows manual instructions'
      });
    }
    if (detail.mailboxes.length === 0) {
      s.push({ id: 'create_mailbox', label: 'Create the first mailbox', why: 'Choose the address and password yourself; passwords are never stored by this app' });
    }
    const ready = ['mx', 'spf', 'dkim'].every((scope) => inspection.checks.some((c) => c.scope === scope && c.status === 'pass'));
    if (detail.domain.kind === 'custom' && detail.domain.verifiedAt && ready && detail.domain.status !== 'active') {
      s.push({ id: 'activate_domain', label: 'Activate the domain', why: 'Ownership, MX, SPF and DKIM checks pass' });
    }
    if (detail.domain.kind === 'hosted' && inspection.checks.some((c) => ['mx', 'spf', 'dkim'].includes(c.scope) && c.status !== 'pass')) {
      s.push({ id: 'review_managed_dns', label: 'Ask the workspace operator to review DNS', why: 'The shared domain has a DNS check that needs attention.' });
    }
    for (const m of detail.mailboxes) {
      if (m.status === 'uncertain') s.push({ id: `reconcile_${m.id}`, label: `Reconcile ${m.address}`, why: 'Confirm whether the mail server applied the creation' });
    }
    return s.slice(0, 8);
  }

  function ruleBasedAnswer({ detail, inspection, blockers, suggestions, changes, graphStatus }) {
    const lines = [];
    const d = detail.domain;
    lines.push(`Domain ${d.name} (${d.kind === 'hosted' ? 'hosted on the shared Workspace domain' : 'custom domain'}) is currently "${d.status}".`);
    const failing = inspection.checks.filter((c) => c.status !== 'pass' && c.status !== 'managed');
    if (failing.length === 0 && blockers.length === 0) {
      lines.push('All setup checks pass right now, but delivery is still unverified.');
    } else {
      const parts = (blockers.length ? blockers : failing).map((b) => {
        const scope = b.scope || `${(b.type || '').toLowerCase()} record`;
        const state = b.state || b.status;
        if (scope === 'mx') return `MX is ${state} — inbound mail will not reach mailboxes until MX points at the mail server`;
        if (scope === 'spf') return `SPF is ${state} — outbound mail may be rejected as spam`;
        if (scope === 'dkim') {
          const check = inspection.checks.find((c) => c.scope === 'dkim');
          const explanation = check?.details?.summary || check?.details?.note || 'Review the published signing record against the mail server.';
          return `DKIM is ${state} — ${explanation}`;
        }
        if (scope === 'dmarc') return `DMARC is ${state} — recommended for deliverability but not blocking`;
        if (scope === 'ownership') return 'Ownership is not verified yet — add the TXT record or connect Cloudflare';
        return `${scope} is ${state}`;
      });
      lines.push(`What blocks progress: ${parts.join('; ')}.`);
    }
    if (detail.mailboxes.length > 0) {
      const addrs = detail.mailboxes.map((m) => `${m.address} (${m.status})`).join(', ');
      lines.push(`Mailboxes depending on this domain: ${addrs}.`);
    }
    if (suggestions.length > 0) {
      lines.push(`Suggested next steps: ${suggestions.map((s) => s.label).join('; ')}.`);
    }
    if (changes.length > 0) {
      lines.push(`Since the workflow started: ${changes.map((c) => `${c.scope} changed ${c.from}→${c.to}`).join(', ')}.`);
    }
    lines.push('Delivery status stays "unknown" until a real test message round-trips — DNS checks do not prove delivery.');
    if (graphStatus.enabled && graphStatus.degraded) {
      lines.push('Note: the Neo4j graph is degraded, so blocker reasoning used identical SQL-derived state.');
    }
    return lines.join(' ');
  }

  async function explainWithLlm({ detail, inspection, blockers, suggestions, question }) {
    const context = {
      domain: { name: detail.domain.name, kind: detail.domain.kind, status: detail.domain.status, verified: Boolean(detail.domain.verifiedAt) },
      checks: inspection.checks.map((c) => ({ scope: c.scope, status: c.status })),
      blockers: blockers.map((b) => ({ scope: b.scope || b.name, state: b.state || b.status })),
      suggestions: suggestions.map((s) => s.id),
      mailboxes: detail.mailboxes.map((m) => ({ status: m.status }))
    };
    try {
      const res = await fetchImpl(`${config.llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
        body: JSON.stringify({
          model: config.llm.model,
          temperature: 0,
          max_tokens: 400,
          messages: [
            {
              role: 'system',
              content: 'You explain email DNS setup state for a business email onboarding tool. Use ONLY the JSON state provided. Never invent mailbox names, IPs, or statuses. If a status is unknown, say it is unknown. Keep it under 120 words. Plain language, no markdown headers.'
            },
            { role: 'user', content: `State: ${JSON.stringify(context)}\nQuestion: ${question || 'What is going on with this domain and what should I do next?'}` }
          ]
        }),
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content;
      if (!text || typeof text !== 'string') return { ok: false, error: 'empty completion' };
      return { ok: true, text: text.trim().slice(0, 2000) };
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { ok: false, error: timedOut ? 'timeout' : String(err && err.message) };
    }
  }

  return { runAgent, investigate: createInvestigator({ domainService, graph }) };
}
