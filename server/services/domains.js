import { recordActivity, cryptoRandomId } from '../db.js';
import { canonicalizeDomain, verifyRecordName, verifyRecordValue, parseVerifyTxt } from './domain-names.js';
import { buildDnsPlan, dnsStateFingerprint, dkimDiagnosis, normalizeMailServerDump, recommendedRecords, deliveryStatus } from './dns.js';
import { generateToken, encryptSecret, decryptSecret } from '../lib/security.js';

const OPS_WRITABLE = new Set(['create', 'update']);

export function createDomainService({ db, config, mailserver, dnsInspector, cloudflare, relay, graph, logger, snapshotBuilder }) {
  function domainsForTenant(tenantId) {
    const rows = db.prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM mailboxes m WHERE m.domain_id = d.id AND m.tenant_id = ?) AS mailbox_count
      FROM domains d
      WHERE d.tenant_id = ? OR d.kind = 'hosted'
      ORDER BY CASE WHEN d.kind = 'hosted' THEN 1 ELSE 0 END, d.created_at DESC
    `).all(tenantId, tenantId);
    return rows.map((r) => shapeDomain(r, tenantId));
  }

  function shapedDomainAccess(tenantId, domainId) {
    const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(domainId);
    if (!row) return { error: { status: 404, code: 'domain_not_found', message: 'Domain not found.' } };
    if (row.tenant_id !== tenantId && row.kind !== 'hosted') {
      return { error: { status: 404, code: 'domain_not_found', message: 'Domain not found.' } };
    }
    return { row };
  }

  function shapeDomain(row, tenantId = row.tenant_id) {
    const mailboxCount = row.mailbox_count !== undefined
      ? row.mailbox_count
      : db.prepare('SELECT COUNT(*) AS n FROM mailboxes WHERE domain_id = ? AND tenant_id = ?').get(row.id, tenantId).n;
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      ownershipMethod: row.ownership_method,
      verifiedAt: row.verified_at,
      cfZone: row.cf_zone_name ? { name: row.cf_zone_name, connected: true } : null,
      mailboxCount,
      shared: row.kind === 'hosted' && row.tenant_id !== tenantId,
      verifyRecord: row.kind === 'custom' && !row.verified_at
        ? { type: 'TXT', name: verifyRecordName(row.name), value: verifyRecordValue(row.verify_token) }
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function getDomainDetail(tenantId, domainId) {
    const access = shapedDomainAccess(tenantId, domainId);
    if (access.error) return access;
    const row = access.row;
    const domain = shapeDomain(row, tenantId);
    const plan = getLatestPlan(row.id);
    const checks = getLatestChecks(row.id);
    const mailboxes = db.prepare(`
      SELECT * FROM mailboxes WHERE domain_id = ? AND tenant_id = ? ORDER BY created_at DESC
    `).all(row.id, tenantId).map((m) => ({
      id: m.id,
      address: m.address,
      localPart: m.local_part,
      status: m.status,
      createdAt: m.created_at,
      upstreamConfirmedAt: m.upstream_confirmed_at
    }));
    const actions = db.prepare('SELECT * FROM setup_actions WHERE domain_id = ? AND tenant_id = ? ORDER BY created_at DESC').all(row.id, tenantId)
      .map((a) => ({ id: a.id, kind: a.kind, status: a.status, targetCheck: a.target_check, updatedAt: a.updated_at }));
    return {
      domain,
      plan: plan ? publicPlan(plan) : null,
      checks,
      mailboxes,
      actions,
      relay: relay?.statusForTenant({ tenantId, domainId })?.relay || { configured: false, status: 'direct_mx', message: 'No relay provider is configured. Direct-MX behavior remains unchanged.' },
      delivery: deliveryStatus(),
      limitations: [
        'Mail delivery is never claimed as verified from DNS alone.',
        'DKIM records appear only after the mail server has staged a mailbox for this domain.'
      ]
    };
  }

  function getLatestPlan(domainId) {
    return db.prepare('SELECT * FROM dns_plans WHERE domain_id = ? ORDER BY version DESC LIMIT 1').get(domainId) || null;
  }

  function publicPlan(planRow, inspectedNowFingerprint = null) {
    const records = JSON.parse(planRow.records_json);
    const conflicts = JSON.parse(planRow.conflicts_json);
    const sources = JSON.parse(planRow.sources_json);
    const state = JSON.parse(planRow.state_hash);
    return {
      id: planRow.id,
      version: planRow.version,
      planHash: planRow.plan_hash,
      status: planRow.status,
      createdAt: planRow.created_at,
      appliedAt: planRow.applied_at,
      approvedAt: planRow.approved_at,
      records,
      conflicts,
      sources,
      approvalsRequired: records.some((r) => r.requiresMxApproval) ? ['mx'] : [],
      staleNow: inspectedNowFingerprint ? inspectedNowFingerprint !== state.dns : null,
      delivery: deliveryStatus()
    };
  }

  function getLatestChecks(domainId) {
    const rows = db.prepare(`
      SELECT c.* FROM checks c
      JOIN (SELECT scope, MAX(checked_at) AS latest FROM checks WHERE domain_id = ? GROUP BY scope) l
        ON l.scope = c.scope AND l.latest = c.checked_at
      WHERE c.domain_id = ?
    `).all(domainId, domainId);
    return rows.map((c) => ({
      scope: c.scope,
      status: c.status,
      details: c.details_json ? JSON.parse(c.details_json) : null,
      checkedAt: c.checked_at
    }));
  }

  function createDomain({ tenantId, name, kind = 'custom' }) {
    const canon = canonicalizeDomain(name);
    if (!canon.ok) return { ok: false, status: 400, code: 'invalid_domain', message: canon.error };
    const domain = canon.domain;

    if (domain === config.hostedDomain) {
      const hosted = db.prepare('SELECT * FROM domains WHERE name = ?').get(domain);
      return { ok: true, domain: shapeDomain(hosted, tenantId), existing: true, kind: 'hosted' };
    }

    const existing = db.prepare('SELECT * FROM domains WHERE name = ?').get(domain);
    if (existing) {
      if (existing.tenant_id === tenantId) return { ok: true, domain: shapeDomain(existing, tenantId), existing: true };
      return {
        ok: false,
        status: 409,
        code: 'domain_taken',
        message: `The domain ${domain} is already registered to another account. Domains are globally unique.`
      };
    }

    if(db.prepare('SELECT COUNT(*) AS n FROM domains WHERE tenant_id=?').get(tenantId).n>=5) return {ok:false,status:409,code:'domain_limit',message:'This beta supports up to five custom domains per account.'};
    const now = new Date().toISOString();
    const row = {
      id: cryptoRandomId(),
      tenant_id: tenantId,
      name: domain,
      kind: 'custom',
      status: 'ownership_pending',
      ownership_method: null,
      verify_token: generateToken(18),
      verified_at: null,
      cf_token_enc: null,
      cf_zone_id: null,
      cf_zone_name: null,
      last_plan_id: null,
      created_at: now,
      updated_at: now
    };
    db.prepare(`INSERT INTO domains (id, tenant_id, name, kind, status, ownership_method, verify_token, verified_at,
        cf_token_enc, cf_zone_id, cf_zone_name, last_plan_id, created_at, updated_at)
      VALUES (@id, @tenant_id, @name, @kind, @status, @ownership_method, @verify_token, @verified_at,
        @cf_token_enc, @cf_zone_id, @cf_zone_name, @last_plan_id, @created_at, @updated_at)`).run(row);
    recordActivity(db, {
      tenantId, domainId: row.id, kind: 'domain.created',
      message: `Domain ${domain} registered. Ownership verification pending.`,
      data: { domain }
    });
    projectTenant(tenantId);
    return { ok: true, domain: shapeDomain(row, tenantId), verifyRecord: { type: 'TXT', name: verifyRecordName(domain), value: verifyRecordValue(row.verify_token) } };
  }

  async function verifyDomain({ tenantId, domainId, method, cfToken }) {
    const access = shapedDomainAccess(tenantId, domainId);
    if (access.error) return { ok: false, ...access.error };
    const row = access.row;
    if (row.kind === 'hosted') return { ok: true, domain: shapeDomain(row, tenantId), alreadyVerified: true };
    if (row.tenant_id !== tenantId) return { ok: false, status: 404, code: 'domain_not_found', message: 'Domain not found.' };
    if (row.verified_at) return { ok: true, domain: shapeDomain(row, tenantId), alreadyVerified: true };

    const recordName = verifyRecordName(row.name);
    const token = row.verify_token;
    let providerZone = null;

    if (method === 'cloudflare') {
      if (!cfToken && !row.cf_token_enc) {
        return { ok: false, status: 400, code: 'cf_token_required', message: 'Paste a Cloudflare API token scoped to this zone to verify automatically, or verify with a DNS TXT record instead.' };
      }
      if (!config.vaultKey) {
        return { ok: false, status: 503, code: 'vault_unconfigured', message: 'Server vault key (VAULT_KEY) is not configured, so Cloudflare tokens cannot be stored securely. Use DNS TXT verification instead.' };
      }
      let secret = cfToken;
      if (!secret) {
        try {
          secret = decryptSecret(row.cf_token_enc, config.vaultKey);
        } catch {
          return { ok: false, status: 400, code: 'cf_token_unreadable', message: 'Stored Cloudflare token could not be decrypted. Re-enter it.' };
        }
      }
      const verified = await cloudflare.verifyToken(secret);
      if (!verified.ok) return { ok: false, status: 400, code: 'cf_token_invalid', message: verified.error || 'Cloudflare token is invalid.' };
      const zone = await cloudflare.findZone(secret, row.name);
      if (!zone.ok) return { ok: false, status: 400, code: 'cf_zone_not_found', message: zone.error };
      const apply = await cloudflare.applyOperations(secret, zone.zone.id, row.name, [{
        key: 'verify:dns_txt',
        name: recordName,
        type: 'TXT',
        proposed: verifyRecordValue(token),
        action: 'create'
      }]);
      const opResult = apply.results[0];
      if (!opResult || (opResult.status !== 'created' && opResult.status !== 'updated' && opResult.status !== 'skipped')) {
        return { ok: false, status: 502, code: 'cf_write_failed', message: opResult?.error || 'Cloudflare rejected the verification record.' };
      }
      db.prepare('UPDATE domains SET cf_token_enc = ?, cf_zone_id = ?, cf_zone_name = ?, updated_at = ? WHERE id = ?')
        .run(encryptSecret(secret, config.vaultKey), zone.zone.id, zone.zone.name, new Date().toISOString(), row.id);
      providerZone = { id: zone.zone.id, name: zone.zone.name };
      recordActivity(db, {
        tenantId, domainId: row.id, kind: 'cloudflare.verify_record',
        message: `Wrote ownership TXT record to Cloudflare zone ${zone.zone.name}.`,
        data: { record: recordName, result: opResult.status }
      });
    }

    const lookup = await dnsInspector.txt(recordName);
    if (!lookup.ok || !parseVerifyTxt(lookup.values, token)) {
      const pendingPropagation = method === 'cloudflare' && lookup.ok === false;
      return {
        ok: false,
        status: 409,
        code: pendingPropagation ? 'propagation_pending' : 'verification_failed',
        message: method === 'cloudflare' && lookup.ok
          ? `TXT record ${recordName} is not visible in DNS yet. Cloudflare changes usually propagate within a few minutes — re-run verification shortly.`
          : `No matching TXT record found at ${recordName}. Add the record exactly as shown, then try again.`,
        verifyRecord: { type: 'TXT', name: recordName, value: verifyRecordValue(token) },
        providerZone
      };
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE domains SET status = ?, ownership_method = ?, verified_at = ?, updated_at = ? WHERE id = ?')
      .run('verified', method === 'cloudflare' ? 'cloudflare_txt' : 'dns_txt', now, now, row.id);
    db.prepare(`INSERT INTO setup_actions (id, tenant_id, domain_id, kind, status, target_check, created_at, updated_at)
      VALUES (?, ?, ?, 'verify_ownership', 'done', 'ownership', ?, ?)`)
      .run(cryptoRandomId(), tenantId, row.id, now, now);
    recordActivity(db, {
      tenantId, domainId: row.id, kind: 'domain.verified',
      message: `Ownership of ${row.name} verified via ${method === 'cloudflare' ? 'Cloudflare + DNS TXT' : 'DNS TXT record'}.`,
      data: { method }
    });

    let zoneResult = null;
    if (mailserver.configured()) {
      try {
        zoneResult = await mailserver.ensureZone(row.name);
        if (zoneResult && zoneResult.ok) {
          recordActivity(db, {
            tenantId, domainId: row.id, kind: 'mailserver.zone',
            message: zoneResult.pendingMailbox ? `Domain ${row.name} is verified. Create its first mailbox to generate the mail server DNS records.` : `Mail server zone ${zoneResult.alreadyPresent ? 'already exists' : 'created'} for ${row.name}.`,
            data: { zone: row.name }
          });
        }
      } catch (err) {
        logger?.warn('ensureZone failed', { error: String(err && err.message) });
        zoneResult = { ok: false, error: 'Mail server zone provisioning failed.' };
      }
    }

    projectTenant(tenantId);
    return {
      ok: true,
      domain: shapeDomain(db.prepare('SELECT * FROM domains WHERE id = ?').get(row.id), tenantId),
      providerZone,
      mailServerZone: zoneResult
        ? (zoneResult.ok ? (zoneResult.pendingMailbox ? 'pending_first_mailbox' : 'ready') : { status: 'manual_step_required', limitation: zoneResult.limitation || zoneResult.error })
        : 'skipped (mail server admin API not configured)'
    };
  }

  async function inspectDomain({ tenantId, domainId, persist = true }) {
    const access = shapedDomainAccess(tenantId, domainId);
    if (access.error) return { ok: false, ...access.error };
    const row = access.row;
    const desiredResult = await desiredRecordsFor(row, tenantId);
    const inspected = await inspectDns(row.name, desiredResult.records);
    const planRow = getLatestPlan(row.id);
    const plan = planRow ? publicPlan(planRow) : null;
    const checkPlan = buildDnsPlan({ domain: row.name, kind: 'custom', inspected, desired: desiredResult.records, mailHost: config.mailserver.mailHost });
    const checks = computeChecks({ tenantId, row, inspected, plan: checkPlan });
    if (persist) {
      const now = new Date().toISOString();
      const insert = db.prepare('INSERT INTO checks (id, tenant_id, domain_id, scope, status, details_json, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const insertMany = db.transaction(() => {
        for (const c of checks) insert.run(cryptoRandomId(), tenantId, row.id, c.scope, c.status, JSON.stringify(c.details), now);
      });
      insertMany();
      recordActivity(db, {
        tenantId, domainId: row.id, kind: 'check.run',
        message: `Ran DNS checks for ${row.name}: ${checks.map((c) => `${c.scope}=${c.status}`).join(', ')}`,
        data: { checks: checks.map((c) => ({ scope: c.scope, status: c.status })) }
      });
      projectTenant(tenantId);
    }
    return { ok: true, domain: shapeDomain(row, tenantId), inspected, checks, dnsStateFingerprint: dnsStateFingerprint(inspected), delivery: deliveryStatus() };
  }

  async function inspectDns(domain, desired) {
    const relayRecords = desired.filter((record) => record.type === 'CNAME');
    return dnsInspector.inspect(domain, { relayRecords });
  }

  function computeChecks({ tenantId, row, inspected, plan }) {
    const checks = [];
    const mailHost = config.mailserver.mailHost;
    const mxMatches = inspected.mx.length === 1 && inspected.mx[0].exchange === mailHost;
    checks.push({
      scope: 'ownership',
      status: row.verified_at || row.kind === 'hosted' ? 'pass' : 'fail',
      details: row.verified_at ? { method: row.ownership_method, at: row.verified_at } : { hint: 'Add the _workspace-verify TXT record or connect Cloudflare.' }
    });
    checks.push({
      scope: 'mx',
      status: inspected.mx.length === 0 ? (inspected.dnsStatus.mx === 'ENOTFOUND' || inspected.dnsStatus.mx === 'ENODATA' ? 'fail' : 'unknown')
        : (mxMatches ? 'pass' : 'warn'),
      details: { current: inspected.mx.map((m) => `${m.priority} ${m.exchange}`), expected: `10 ${mailHost}`, dnsStatus: inspected.dnsStatus.mx }
    });
    checks.push({
      scope: 'spf',
      status: inspected.spf.count > 1 ? 'fail' : (plan?.records?.find((r)=>r.key==='spf:@')?.action === 'keep' ? 'pass' : 'warn'),
      details: { records: inspected.spf.records, issue: inspected.spf.count > 1 ? 'Multiple SPF records — merge to exactly one.' : null }
    });
    const dkimPlanRecord = plan?.records?.find((r) => r.key.startsWith('dkim:'));
    checks.push({
      scope: 'dkim',
      status: dkimPlanRecord?.action === 'keep' ? 'pass' : (plan && plan.sources.dkim === 'pending_upstream' ? 'pending' : 'warn'),
      details: {
        selector: inspected.dkim.selector,
        note: inspected.dkim.present ? null : 'Appears after a mailbox is staged on the mail server.',
        // Distinguishes a mismatched published key from a missing record and from
        // an unavailable provider key; carries counts and a safe next step only.
        ...dkimDiagnosis({
          selector: inspected.dkim.selector,
          publishedRecords: inspected.dkim.records,
          desiredValue: dkimPlanRecord?.proposed ?? null
        })
      }
    });
    checks.push({
      scope: 'dmarc',
      status: inspected.dmarc.records.length === 1 && /^v=DMARC1\s*;/i.test(inspected.dmarc.records[0]) ? 'pass' : 'warn',
      details: { records: inspected.dmarc.records }
    });
    const relayState = relay?.activationStatus({ tenantId, row });
    if (relayState?.configured) {
      checks.push({
        scope: 'relay',
        status: relayState.status === 'verified' ? 'pass' : relayState.status === 'failed' ? 'fail' : 'pending',
        details: {
          provider: 'sendgrid',
          domain: row.name,
          message: relayState.message || 'Publish the required CNAME records and validate sender authentication with SendGrid.'
        }
      });
    }
    return checks;
  }

  async function createPlan({ tenantId, domainId, cfToken }) {
    const access = shapedDomainAccess(tenantId, domainId);
    if (access.error) return { ok: false, ...access.error };
    const row = access.row;
    if (row.kind === 'hosted') {
      return {
        ok: true,
        plan: {
          id: null,
          version: 0,
          planHash: null,
          status: 'managed',
          records: [{
            key: 'mx:@', name: '@', type: 'MX', current: [], proposed: null, action: 'managed',
            reason: 'Hosted on the shared Workspace domain — DNS is managed by the provider.'
          }],
          conflicts: [],
          approvalsRequired: [],
          sources: { desired: 'provider_managed', dkim: 'provider_managed' },
          delivery: deliveryStatus()
        },
        message: 'No DNS plan is needed: the hosted domain is managed by the provider.'
      };
    }
    if (!row.verified_at) {
      return { ok: false, status: 409, code: 'ownership_required', message: 'Verify ownership before planning DNS changes.' };
    }

    const desiredResult = await desiredRecordsFor(row, tenantId);
    const inspectedWithRelay = await inspectDns(row.name, desiredResult.records);

    let cfState = null;
    let cfZone = null;
    if (cfToken) {
      if (!config.vaultKey) {
        return { ok: false, status: 503, code: 'vault_unconfigured', message: 'VAULT_KEY is not configured; Cloudflare tokens cannot be stored. Use manual DNS mode.' };
      }
      const verified = await cloudflare.verifyToken(cfToken);
      if (!verified.ok) return { ok: false, status: 400, code: 'cf_token_invalid', message: verified.error };
      const zone = await cloudflare.findZone(cfToken, row.name);
      if (!zone.ok) return { ok: false, status: 400, code: 'cf_zone_not_found', message: zone.error };
      const listing = await cloudflare.listRecords(cfToken, zone.zone.id);
      if (!listing.ok) return { ok: false, status: 502, code: 'cf_list_failed', message: listing.error };
      cfZone = zone.zone;
      cfState = cloudflare.listFingerprint(listing.records);
      db.prepare('UPDATE domains SET cf_token_enc = ?, cf_zone_id = ?, cf_zone_name = ?, updated_at = ? WHERE id = ?')
        .run(encryptSecret(cfToken, config.vaultKey), zone.zone.id, zone.zone.name, new Date().toISOString(), row.id);
    } else if (row.cf_token_enc && config.vaultKey) {
      try {
        const secret = decryptSecret(row.cf_token_enc, config.vaultKey);
        const listing = await cloudflare.listRecords(secret, row.cf_zone_id);
        if (listing.ok) cfState = cloudflare.listFingerprint(listing.records);
        cfZone = { id: row.cf_zone_id, name: row.cf_zone_name };
      } catch {
        logger?.warn('stored cloudflare token unreadable during plan');
      }
    }

    const plan = buildDnsPlan({
      domain: row.name,
      kind: row.kind,
      inspected: inspectedWithRelay,
      desired: desiredResult.records,
      mailHost: config.mailserver.mailHost
    });
    plan.sources.desiredDetail = desiredResult.sourceNote;
    plan.sources.limitations = desiredResult.limitations;

    const now = new Date().toISOString();
    const versionRow = db.prepare('SELECT MAX(version) AS v FROM dns_plans WHERE domain_id = ?').get(row.id);
    const version = (versionRow.v || 0) + 1;
    const planId = cryptoRandomId();
    const stateHash = JSON.stringify({ dns: dnsStateFingerprint(inspectedWithRelay), cf: cfState });
    db.prepare('UPDATE dns_plans SET status = ? WHERE domain_id = ? AND status = ?').run('superseded', row.id, 'draft');
    db.prepare(`INSERT INTO dns_plans (id, domain_id, version, plan_hash, state_hash, records_json, ops_json, conflicts_json, sources_json,
        status, approved_mx_hash, approved_at, applied_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, NULL, ?)`)
      .run(planId, row.id, version, plan.planHash, stateHash, JSON.stringify(plan.records), JSON.stringify(plan.records),
        JSON.stringify(plan.conflicts), JSON.stringify(plan.sources), now);
    db.prepare('UPDATE domains SET last_plan_id = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(planId, row.status === 'verified' ? 'dns_planned' : row.status, now, row.id);
    db.prepare(`INSERT INTO setup_actions (id, tenant_id, domain_id, kind, status, target_check, created_at, updated_at)
      VALUES (?, ?, ?, 'apply_dns_plan', 'pending', 'mx', ?, ?)`)
      .run(cryptoRandomId(), tenantId, row.id, now, now);
    recordActivity(db, {
      tenantId, domainId: row.id, kind: 'domain.plan.created',
      message: `DNS plan v${version} created (dry-run): ${plan.records.map((r) => `${r.key}=${r.action}`).join(', ')}`,
      data: { planId, version, conflicts: plan.conflicts.length }
    });
    projectTenant(tenantId);

    const planRow = db.prepare('SELECT * FROM dns_plans WHERE id = ?').get(planId);
    const publicResult = publicPlan(planRow, dnsStateFingerprint(inspectedWithRelay));
    publicResult.cfZone = cfZone;
    publicResult.operationsPreview = plan.records.filter((r) => OPS_WRITABLE.has(r.action) && r.proposed);
    publicResult.relay = relay?.statusForTenant({ tenantId, domainId: row.id })?.relay || null;
    return { ok: true, plan: publicResult, inspected: inspectedWithRelay, checks: computeChecks({ tenantId, row, inspected: inspectedWithRelay, plan: publicResult }) };
  }

  async function desiredRecordsFor(row, tenantId) {
    const limitations = [];
    if (mailserver.configured()) {
      const dump = await mailserver.getDnsDump();
      if (dump.ok && dump.supported) {
        const normalized = normalizeMailServerDump(dump.data, row.name);
        if (normalized.supported) {
          const records = normalized.records
            .filter((r) => ['MX', 'TXT'].includes(r.type))
            .map((r) => ({ ...r, source: 'mailserver_dump' }));
          const withSource = records.length ? records : [];
          if (withSource.length) {
            const relayPlan = relay?.recordsForPlan({ tenantId, row }) || { records: [], limitations: [] };
            return { records: [...withSource, ...relayPlan.records], sourceNote: 'mailserver_dump', limitations: [...limitations, ...relayPlan.limitations] };
          }
        }
        limitations.push(`The mail server does not host a DNS zone for ${row.name} yet, so provider-generated records are unavailable. Records below are recommended defaults.`);
      } else {
        limitations.push(`The mail server zone dump is unavailable (${dump.error || 'unsupported'}). Records below are recommended defaults.`);
      }
    } else {
      limitations.push('The mail server admin API is not configured; records below are recommended defaults.');
    }
    const relayPlan = relay?.recordsForPlan({ tenantId, row }) || { records: [], limitations: [] };
    return {
      records: [
        ...recommendedRecords({ domain: row.name, mailHost: config.mailserver.mailHost }).map((r) => ({ qname: r.name, ...r, source: 'recommended_default' })),
        ...relayPlan.records
      ],
      sourceNote: 'recommended_default',
      limitations: [...limitations, ...relayPlan.limitations]
    };
  }

  async function applyPlan({ tenantId, domainId, planId, method = 'manual', approvals = {}, planHash, dryRun = false }) {
    const access = shapedDomainAccess(tenantId, domainId);
    if (access.error) return { ok: false, ...access.error };
    const row = access.row;
    if (row.kind === 'hosted') return { ok: false, status: 400, code: 'hosted_managed', message: 'The hosted domain is managed by the provider — no DNS changes are needed.' };
    if (row.tenant_id !== tenantId) return { ok: false, status: 404, code: 'domain_not_found', message: 'Domain not found.' };

    const planRow = planId
      ? db.prepare('SELECT * FROM dns_plans WHERE id = ? AND domain_id = ?').get(planId, row.id)
      : getLatestPlan(row.id);
    if (!planRow) return { ok: false, status: 404, code: 'plan_not_found', message: 'No DNS plan exists yet. Create one first.' };
    if (planRow.status !== 'draft') {
      return { ok: false, status: 409, code: 'plan_not_draft', message: `Plan v${planRow.version} is ${planRow.status}; create a fresh plan.` };
    }
    const plan = publicPlan(planRow);
    const state = JSON.parse(planRow.state_hash);
    const operations = plan.records.filter((r) => OPS_WRITABLE.has(r.action) && r.proposed);
    const needsMxApproval = plan.records.some((r) => r.requiresMxApproval);

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        plan: plan,
        operations,
        conflicts: plan.conflicts,
        message: 'Dry run: nothing was written.'
      };
    }

    if (plan.conflicts.length > 0) {
      return {
        ok: false,
        status: 409,
        code: 'conflicts_unresolved',
        message: 'This plan has conflicts that need manual resolution before it can be applied.',
        conflicts: plan.conflicts
      };
    }
    if (planHash !== planRow.plan_hash) {
      return { ok: false, status: 409, code: 'plan_mismatch', message: 'The supplied plan hash does not match the stored plan. Re-open the latest plan and try again.' };
    }
    if (needsMxApproval && approvals.mx !== true) {
      return {
        ok: false,
        status: 400,
        code: 'mx_approval_required',
        message: 'Changing MX records reroutes inbound mail and requires explicit approval.',
        requireApproval: 'mx'
      };
    }

    const freshDesired = await desiredRecordsFor(row, tenantId);
    const freshInspection = await inspectDns(row.name, freshDesired.records);
    const freshDnsHash = dnsStateFingerprint(freshInspection);
    if (freshDnsHash !== state.dns) {
      return {
        ok: false,
        status: 409,
        code: 'plan_stale_dns',
        message: 'DNS records changed since this plan was created. Create a fresh plan to see the current state.'
      };
    }

    if (method === 'manual') {
      const now = new Date().toISOString();
      db.prepare('UPDATE dns_plans SET status = ?, applied_at = ?, approved_mx_hash = ?, approved_at = ? WHERE id = ?')
        .run('manual', now, needsMxApproval ? planRow.plan_hash : null, needsMxApproval ? now : null, planRow.id);
      db.prepare('UPDATE domains SET status = ?, updated_at = ? WHERE id = ?').run('dns_manual_pending', now, row.id);
      recordActivity(db, {
        tenantId, domainId: row.id, kind: 'domain.plan.manual',
        message: `Manual DNS instructions issued for ${row.name} (plan v${planRow.version}).`,
        data: { planId: planRow.id, operations: operations.map((o) => `${o.key}:${o.action}`) }
      });
      projectTenant(tenantId);
      return {
        ok: true,
        method: 'manual',
        instructions: operations.map((o) => ({
          name: o.name,
          type: o.type,
          value: o.proposed,
          fqdn: fqdnForRecord(o.name, row.name),
          current: o.current,
          action: o.action
        })),
        message: 'Add these records at your DNS provider, then run checks to confirm. Records for unrelated services are untouched.'
      };
    }

    if (method !== 'cloudflare') return { ok: false, status: 400, code: 'invalid_method', message: 'method must be "cloudflare" or "manual".' };
    if (!row.cf_token_enc || !row.cf_zone_id) {
      return { ok: false, status: 409, code: 'cf_not_connected', message: 'Cloudflare is not connected for this domain. Verify ownership via Cloudflare or use manual DNS mode.' };
    }
    if (!config.vaultKey) return { ok: false, status: 503, code: 'vault_unconfigured', message: 'VAULT_KEY is not configured.' };

    let secret;
    try {
      secret = decryptSecret(row.cf_token_enc, config.vaultKey);
    } catch {
      return { ok: false, status: 400, code: 'cf_token_unreadable', message: 'Stored Cloudflare token could not be decrypted. Re-verify the domain with a fresh token.' };
    }

    const zoneCheck = await cloudflare.findZone(secret, row.name);
    if (!zoneCheck.ok || zoneCheck.zone.id !== row.cf_zone_id) {
      return { ok: false, status: 409, code: 'cf_zone_changed', message: zoneCheck.error || 'The connected zone no longer matches. Re-verify the domain.' };
    }
    const listing = await cloudflare.listRecords(secret, row.cf_zone_id);
    if (!listing.ok) return { ok: false, status: 502, code: 'cf_list_failed', message: listing.error };
    if (!state.cf || cloudflare.listFingerprint(listing.records) !== state.cf) {
      return {
        ok: false,
        status: 409,
        code: 'plan_stale_provider',
        message: 'Records in the Cloudflare zone changed since this plan was created. Re-run planning to review the current state before applying.'
      };
    }

    const claimed = db.prepare("UPDATE dns_plans SET status='applying', approved_at=?, approved_mx_hash=? WHERE id=? AND status='draft'").run(new Date().toISOString(), needsMxApproval ? planRow.plan_hash : null, planRow.id);
    if (claimed.changes !== 1) return {ok:false,status:409,code:'plan_in_progress',message:'This plan is already being applied. Refresh its status.'};
    const before = new Date().toISOString();
    for (const r of listing.records) {
      const reviewed = operations.some((op)=> {
        const name = fqdnForRecord(op.name, row.name);
        return r.name===name && r.type===op.type;
      });
      if (reviewed) db.prepare('INSERT INTO cf_backups (id,domain_id,zone_id,record_key,record_type,record_name,prior_json,applied_at) VALUES (?,?,?,?,?,?,?,?)').run(cryptoRandomId(),row.id,row.cf_zone_id,`${r.type}:${r.name}`,r.type,r.name,JSON.stringify(r),before);
    }
    const applyResult = await cloudflare.applyOperations(secret, row.cf_zone_id, row.name, operations);
    const now = new Date().toISOString();
    const backupStmt = db.prepare(`INSERT INTO cf_backups (id, domain_id, zone_id, record_key, record_type, record_name, prior_json, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of (applyResult.results || [])) {
      if (r.backup) backupStmt.run(cryptoRandomId(), row.id, row.cf_zone_id, r.key, r.backup.type, r.backup.name, JSON.stringify(r.backup), now);
    }

    if (!applyResult.ok || !applyResult.summary || applyResult.summary.errors > 0) {
      applyResult.summary ||= {errors:1};
      db.prepare("UPDATE dns_plans SET status='partial' WHERE id=?").run(planRow.id);
      db.prepare('UPDATE domains SET status = ?, updated_at = ? WHERE id = ?').run('dns_partial', now, row.id);
      recordActivity(db, {
        tenantId, domainId: row.id, kind: 'cloudflare.apply_failed',
        message: `Cloudflare apply finished with ${applyResult.summary.errors} error(s); no unrelated records changed and changed records were backed up.`,
        data: { summary: applyResult.summary }
      });
      projectTenant(tenantId);
      return {
        ok: false,
        status: 502,
        code: 'cf_apply_partial',
        message: 'Some records could not be applied. Fix the reported errors, re-plan, and apply again.',
        results: applyResult.results,
        summary: applyResult.summary
      };
    }

    db.prepare('UPDATE dns_plans SET status = ?, applied_at = ?, approved_mx_hash = ?, approved_at = ? WHERE id = ?')
      .run('applied', now, needsMxApproval ? planRow.plan_hash : null, needsMxApproval ? now : null, planRow.id);
    db.prepare('UPDATE domains SET status = ?, updated_at = ? WHERE id = ?').run('dns_applied', now, row.id);
    db.prepare(`UPDATE setup_actions SET status = 'done', updated_at = ? WHERE domain_id = ? AND kind = 'apply_dns_plan' AND status = 'pending'`)
      .run(now, row.id);
    recordActivity(db, {
      tenantId, domainId: row.id, kind: 'cloudflare.applied',
      message: `Applied DNS plan v${planRow.version} to Cloudflare zone ${row.cf_zone_name}: ${applyResult.summary.created} created, ${applyResult.summary.updated} updated, ${applyResult.summary.skipped} skipped.`,
      data: { summary: applyResult.summary, backups: applyResult.results.filter((r) => r.backup).length }
    });

    const fresh = await inspectDomain({ tenantId, domainId: row.id, persist: true });
    projectTenant(tenantId);
    return {
      ok: true,
      method: 'cloudflare',
      summary: applyResult.summary,
      results: applyResult.results,
      checks: fresh.ok ? fresh.checks : [],
      message: 'DNS plan applied. Propagation can take a few minutes; run checks to confirm. Delivery remains unverified until a real message round-trips.'
    };
  }

  function fqdnForRecord(name, domain) {
    const normalized = String(name || '').replace(/\.$/, '');
    return normalized === '@' ? domain
      : normalized === domain || normalized.endsWith(`.${domain}`) ? normalized
        : `${normalized}.${domain}`;
  }

  async function activateDomain({ tenantId, domainId }) {
    const access = shapedDomainAccess(tenantId, domainId);
    if (access.error) return { ok: false, ...access.error };
    const row = access.row;
    if (row.kind === 'hosted') {
      const now = new Date().toISOString();
      db.prepare('UPDATE domains SET status = ?, updated_at = ? WHERE id = ?').run('active', now, row.id);
      recordActivity(db, { tenantId, domainId: row.id, kind: 'domain.activated', message: `Hosted domain ${row.name} marked active.`, data: {} });
      projectTenant(tenantId);
      return { ok: true, domain: shapeDomain(db.prepare('SELECT * FROM domains WHERE id = ?').get(row.id), tenantId), delivery: deliveryStatus() };
    }
    if (row.tenant_id !== tenantId) return { ok: false, status: 404, code: 'domain_not_found', message: 'Domain not found.' };
    if (!row.verified_at) return { ok: false, status: 409, code: 'ownership_required', message: 'Verify ownership first.' };

    const inspection = await inspectDomain({ tenantId, domainId: row.id, persist: true });
    if (!inspection.ok) return inspection;
    const checks = inspection.checks;
    const mx = checks.find((c) => c.scope === 'mx');
    const spf = checks.find((c) => c.scope === 'spf');
    const blockers = [];
    if (mx.status !== 'pass') blockers.push({ scope: 'mx', status: mx.status, detail: 'MX must point at the mail server.' });
    if (spf.status !== 'pass') blockers.push({ scope: 'spf', status: spf.status, detail: 'Fix the SPF record (exactly one valid SPF).' });
    const dkim = checks.find((c) => c.scope === 'dkim');
    if (dkim.status !== 'pass') blockers.push({scope:'dkim',status:dkim.status,detail:'Publish the DKIM key generated for this mailbox.'});
    const relayCheck = checks.find((c) => c.scope === 'relay');
    if (relayCheck && relayCheck.status !== 'pass') {
      blockers.push({
        scope: 'relay',
        status: relayCheck.status,
        detail: relayCheck.details?.message || 'Complete SendGrid sender authentication for this exact domain before activation.'
      });
    }
    if (blockers.length > 0) {
      recordActivity(db, {
        tenantId, domainId: row.id, kind: 'domain.activate_blocked',
        message: `Activation blocked for ${row.name}: ${blockers.map((b) => b.scope).join(', ')}`,
        data: { blockers }
      });
      projectTenant(tenantId);
      return {
        ok: false,
        status: 409,
        code: 'activation_blocked',
        message: 'Activation is blocked by DNS checks that have not passed.',
        blockers,
        graphHint: 'See the dependency graph for what each mailbox depends on.'
      };
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE domains SET status = ?, updated_at = ? WHERE id = ?').run('active', now, row.id);
    db.prepare(`UPDATE setup_actions SET status = 'done', updated_at = ? WHERE domain_id = ? AND kind = 'apply_dns_plan' AND status = 'pending'`)
      .run(now, row.id);
    recordActivity(db, {
      tenantId, domainId: row.id, kind: 'domain.activated',
      message: `Domain ${row.name} activated. ${dkim.status === 'pass' ? 'DKIM present.' : 'DKIM still pending — it appears once a mailbox is staged.'}`,
      data: { dkim: dkim.status }
    });
    projectTenant(tenantId);
    return {
      ok: true,
      domain: shapeDomain(db.prepare('SELECT * FROM domains WHERE id = ?').get(row.id), tenantId),
      checks,
      delivery: deliveryStatus(),
      note: 'Activation means DNS is in place — it is not a delivery test. Inbound/outbound stay unknown until a real message round-trips.'
    };
  }

  function projectTenant(tenantId) {
    try {
      const snapshot = snapshotBuilder(tenantId);
      graph.project(tenantId, snapshot).catch(() => {});
    } catch (err) {
      logger?.warn('snapshot build failed', { error: String(err && err.message) });
    }
  }

  return {
    domainsForTenant,
    getDomainDetail,
    createDomain,
    verifyDomain,
    inspectDomain,
    createPlan,
    applyPlan,
    activateDomain,
    getLatestPlan,
    publicPlan
  };
}
