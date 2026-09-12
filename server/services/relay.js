import { canonicalizeDomain } from './domain-names.js';

const SENDGRID_PROVIDER = 'sendgrid';
const DEFAULT_SENDGRID_BASE = 'https://api.sendgrid.com/v3';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 15000;

function exactDomain(value) {
  const result = canonicalizeDomain(String(value || ''));
  return result.ok ? result.domain : null;
}

function safeProviderError(status, fallback = 'The outgoing email provider rejected the request.') {
  if (status === 401 || status === 403) return 'The outgoing email provider credentials were rejected.';
  if (status === 404) return 'The requested sender-authentication record was not found.';
  if (status === 408 || status === 429) return 'The outgoing email provider asked Workspace to retry later.';
  if (status >= 500) return 'The outgoing email provider is temporarily unavailable.';
  return fallback;
}

function timeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(250, Math.floor(parsed)));
}

function providerDomainFrom(value) {
  if (!value || typeof value !== 'object') return null;
  return exactDomain(value.domain || value.name || value.whitelabel_domain);
}

function dnsEntry(value, fallbackType = 'CNAME') {
  if (!value || typeof value !== 'object') return null;
  const name = String(value.host ?? value.name ?? value.hostname ?? '').trim().replace(/\.$/, '').toLowerCase();
  const recordValue = String(value.data ?? value.value ?? value.target ?? '').trim().replace(/\.$/, '');
  const type = String(value.type || fallbackType).toUpperCase();
  if (!name || !recordValue || type !== 'CNAME') return null;
  return { name, type, value: recordValue };
}

export function normalizeSendgridDnsRecords(payload) {
  const dns = payload?.dns && typeof payload.dns === 'object' ? payload.dns : payload;
  if (!dns || typeof dns !== 'object') return [];
  const candidates = [
    ['mail_cname', dns.mail_cname],
    ['dkim1', dns.dkim1],
    ['dkim2', dns.dkim2],
    ['custom_spf', dns.custom_spf]
  ];
  const seen = new Set();
  const records = [];
  for (const [key, value] of candidates) {
    const record = dnsEntry(value);
    if (!record || seen.has(`${record.name}|${record.value}`)) continue;
    seen.add(`${record.name}|${record.value}`);
    records.push({ key: `relay:${key}`, ...record });
  }
  return records;
}

function providerValid(payload) {
  return payload?.valid === true;
}

export function createSendgridClient({ apiKey, baseUrl = DEFAULT_SENDGRID_BASE, timeout = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, logger } = {}) {
  const apiBase = String(baseUrl || DEFAULT_SENDGRID_BASE).replace(/\/+$/, '');
  const requestTimeout = timeoutMs(timeout);

  async function request(path, { method = 'GET', body } = {}) {
    const started = Date.now();
    try {
      const response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(requestTimeout),
        redirect: 'error'
      });
      let json = null;
      try {
        json = await response.json();
      } catch {
        // The provider's response body is never copied into a public error.
      }
      logger?.info('relay provider request', { provider: SENDGRID_PROVIDER, path, method, status: response.status, ms: Date.now() - started });
      return {
        ok: response.ok,
        status: response.status,
        json,
        error: response.ok ? null : safeProviderError(response.status)
      };
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      logger?.warn('relay provider request failed', {
        provider: SENDGRID_PROVIDER,
        path,
        method,
        timedOut,
        error: timedOut ? 'timeout' : 'request_failed'
      });
      return {
        ok: false,
        status: 0,
        timeout: timedOut,
        error: timedOut ? 'The outgoing email provider did not respond in time.' : 'The outgoing email provider request failed.'
      };
    }
  }

  async function listExact(domain) {
    const expected = exactDomain(domain);
    if (!expected) return { ok: false, status: 400, error: 'The relay domain is invalid.' };
    const result = await request(`/whitelabel/domains?domain=${encodeURIComponent(expected)}`);
    if (!result.ok) return result;
    if (!Array.isArray(result.json)) {
      return { ok: false, status: 502, error: 'The outgoing email provider returned an invalid domain list.' };
    }
    const matches = result.json.filter((entry) => providerDomainFrom(entry) === expected);
    if (matches.length > 1) {
      return { ok: false, status: 502, error: `The outgoing email provider returned multiple records for ${expected}.` };
    }
    if (!matches.length) return { ok: true, domain: null };
    const entry = matches[0];
    return {
      ok: true,
      domain: {
        id: entry.id ?? entry.domain_id ?? null,
        name: expected,
        dnsRecords: normalizeSendgridDnsRecords(entry),
        valid: providerValid(entry),
        raw: entry
      }
    };
  }

  async function create(domain) {
    const expected = exactDomain(domain);
    if (!expected) return { ok: false, status: 400, error: 'The relay domain is invalid.' };
    const result = await request('/whitelabel/domains', {
      method: 'POST',
      body: { domain: expected, automatic_security: true, default: false }
    });
    if (!result.ok) return result;
    const name = providerDomainFrom(result.json);
    if (name !== expected) {
      return { ok: false, status: 502, error: 'The outgoing email provider did not confirm the requested domain.' };
    }
    return {
      ok: true,
      domain: {
        id: result.json.id ?? result.json.domain_id ?? null,
        name,
        dnsRecords: normalizeSendgridDnsRecords(result.json),
        valid: providerValid(result.json),
        raw: result.json
      }
    };
  }

  async function validate(providerDomainId, domain) {
    const expected = exactDomain(domain);
    if (!providerDomainId || !expected) return { ok: false, status: 400, error: 'A prepared exact relay domain is required.' };
    const identity = await request(`/whitelabel/domains/${encodeURIComponent(String(providerDomainId))}`);
    if (!identity.ok) return identity;
    if (providerDomainFrom(identity.json) !== expected || String(identity.json?.id) !== String(providerDomainId)) {
      return { ok: false, status: 502, error: 'The outgoing email provider did not confirm the exact requested domain.' };
    }
    const result = await request(`/whitelabel/domains/${encodeURIComponent(String(providerDomainId))}/validate`, { method: 'POST' });
    if (!result.ok) return result;
    const confirmed = providerDomainFrom(result.json);
    if (String(result.json?.id) !== String(providerDomainId) || (confirmed && confirmed !== expected)) {
      return { ok: false, status: 502, error: 'The outgoing email provider did not confirm the exact requested domain.' };
    }
    return {
      ok: true,
      domain: {
        id: providerDomainId,
        name: expected,
        dnsRecords: normalizeSendgridDnsRecords(identity.json),
        valid: providerValid(result.json),
        raw: result.json
      }
    };
  }

  return { listExact, create, validate };
}

function publicRelayState({ configured, domain, status, dnsRecords = [], message, error = null, verifiedAt = null, checkedAt = null }) {
  return {
    configured,
    provider: configured ? SENDGRID_PROVIDER : null,
    domain: domain?.name || null,
    status,
    dnsRecords: dnsRecords.map(({ key, name, type, value }) => ({ key, name, type, value })),
    message,
    error,
    verifiedAt,
    checkedAt
  };
}

export function createRelayService({ db, config, fetchImpl = fetch, logger }) {
  const relayConfig = config.relay || {};
  const configured = relayConfig.provider === SENDGRID_PROVIDER && Boolean(relayConfig.apiKey);
  const client = configured
    ? createSendgridClient({
      apiKey: relayConfig.apiKey,
      baseUrl: relayConfig.apiBase,
      timeout: relayConfig.timeoutMs,
      fetchImpl,
      logger
    })
    : null;

  function isConfigured() {
    return configured;
  }

  function domainAccess(tenantId, domainId) {
    const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(domainId);
    if (!row || (row.tenant_id !== tenantId && row.kind !== 'hosted')) {
      return { ok: false, status: 404, code: 'domain_not_found', message: 'Domain not found.' };
    }
    return { ok: true, row };
  }

  function rowFor(domainId) {
    return db.prepare('SELECT * FROM relay_auth WHERE domain_id = ?').get(domainId) || null;
  }

  function recordsFromRow(row) {
    try {
      return JSON.parse(row?.dns_records_json || '[]');
    } catch {
      return [];
    }
  }

  function saveRelay({ tenantId, row, providerDomain, status, error = null }) {
    const now = new Date().toISOString();
    const existing = rowFor(row.id);
    const relayId = existing?.id || `relay_${row.id}`;
    const verifiedAt = status === 'verified' ? (existing?.verified_at || now) : null;
    db.prepare(`
      INSERT INTO relay_auth
        (id, tenant_id, domain_id, provider, provider_domain_id, domain, status, dns_records_json, error_message, verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain_id) DO UPDATE SET
        tenant_id=excluded.tenant_id, provider=excluded.provider,
        provider_domain_id=excluded.provider_domain_id, domain=excluded.domain,
        status=excluded.status, dns_records_json=excluded.dns_records_json,
        error_message=excluded.error_message, verified_at=excluded.verified_at,
        updated_at=excluded.updated_at
    `).run(
      relayId,
      tenantId,
      row.id,
      SENDGRID_PROVIDER,
      String(providerDomain.id),
      row.name,
      status,
      JSON.stringify(providerDomain.dnsRecords || []),
      error,
      verifiedAt,
      existing?.created_at || now,
      now
    );
    return db.prepare('SELECT * FROM relay_auth WHERE domain_id = ?').get(row.id);
  }

  function publicRow(row, domain, configuredValue = configured) {
    if (!configuredValue) {
      return publicRelayState({
        configured: false,
        domain,
        status: 'direct_mx',
        message: 'No relay provider is configured. Direct-MX behavior remains unchanged.'
      });
    }
    if (domain.kind === 'hosted') {
      return publicRelayState({
        configured: true,
        domain,
        status: 'managed',
        message: 'The shared hosted domain is managed by Workspace. Existing provider authentication can be viewed, but tenants cannot change it.'
      });
    }
    const relayRow = rowFor(row.id);
    if (!relayRow) {
      return publicRelayState({
        configured: true,
        domain,
        status: 'not_prepared',
        message: 'Prepare SendGrid sender authentication after ownership verification.'
      });
    }
    return publicRelayState({
      configured: true,
      domain,
      status: relayRow.status,
      dnsRecords: recordsFromRow(relayRow),
      message: relayRow.status === 'verified'
        ? 'SendGrid confirmed sender authentication for this exact domain. This does not prove message delivery.'
        : relayRow.status === 'failed'
          ? 'SendGrid sender authentication needs attention before this domain can be activated.'
          : 'Publish the required CNAME records, then validate sender authentication with SendGrid.',
      error: relayRow.error_message,
      verifiedAt: relayRow.verified_at,
      checkedAt: relayRow.updated_at
    });
  }

  function statusForTenant({ tenantId, domainId }) {
    const access = domainAccess(tenantId, domainId);
    if (!access.ok) return access;
    return { ok: true, relay: publicRow(access.row, { name: access.row.name, kind: access.row.kind }) };
  }

  async function get({ tenantId, domainId }) {
    const access = domainAccess(tenantId, domainId);
    if (!access.ok) return access;
    const row = access.row;
    if (!configured) return { ok: true, relay: publicRow(row, row) };
    if (row.kind === 'hosted') {
      const found = await client.listExact(row.name);
      if (!found.ok) return { ok: false, status: found.status || 502, code: 'relay_provider_error', message: found.error };
      if (!found.domain) {
        return {
          ok: true,
          relay: publicRelayState({
            configured: true,
            domain: row,
            status: 'pending',
            message: 'No existing SendGrid authentication was found for the shared hosted domain.'
          })
        };
      }
      return {
        ok: true,
        relay: publicRelayState({
          configured: true,
          domain: row,
          status: found.domain.valid ? 'verified' : 'pending',
          dnsRecords: found.domain.dnsRecords,
          message: found.domain.valid
            ? 'SendGrid authentication exists for the shared hosted domain. Tenants cannot change global sender settings.'
            : 'SendGrid authentication exists but is not currently verified.'
        })
      };
    }
    return { ok: true, relay: publicRow(row, row) };
  }

  function recordsForPlan({ tenantId, row }) {
    if (!configured || row.kind === 'hosted') return { records: [], limitations: [] };
    const relayRow = rowFor(row.id);
    if (!relayRow) {
      return {
        records: [],
        limitations: ['SendGrid sender authentication is not prepared yet. Prepare it after ownership verification, publish its CNAME records, and validate before activation.']
      };
    }
    return {
      records: recordsFromRow(relayRow).map((record) => ({
        key: record.key,
        name: record.name,
        type: 'CNAME',
        value: record.value,
        qname: record.name,
        explanation: 'Required CNAME for SendGrid sender authentication.',
        source: 'sendgrid'
      })),
      limitations: relayRow.status === 'verified'
        ? []
        : ['SendGrid sender authentication is pending. Publish the required CNAME records and validate it before activation.']
    };
  }

  function activationStatus({ tenantId, row }) {
    if (!configured || row.kind === 'hosted') return { configured: false, status: 'direct_mx' };
    const relayRow = rowFor(row.id);
    if (!relayRow) return { configured: true, status: 'pending', message: 'Prepare and validate SendGrid sender authentication for this exact domain.' };
    return {
      configured: true,
      status: relayRow.status === 'verified' ? 'verified' : relayRow.status === 'failed' ? 'failed' : 'pending',
      message: relayRow.status === 'failed'
        ? relayRow.error_message || 'SendGrid sender authentication failed.'
        : 'Publish the required CNAME records and validate sender authentication with SendGrid.'
    };
  }

  async function prepare({ tenantId, domainId }) {
    const access = domainAccess(tenantId, domainId);
    if (!access.ok) return access;
    const row = access.row;
    if (!configured) return { ok: false, status: 409, code: 'relay_not_configured', message: 'No outgoing relay provider is configured. Direct-MX behavior remains unchanged.' };
    if (row.kind === 'hosted') return { ok: false, status: 403, code: 'hosted_relay_managed', message: 'The shared hosted domain is managed by Workspace; tenants cannot change its sender authentication.' };
    if (row.tenant_id !== tenantId) return { ok: false, status: 404, code: 'domain_not_found', message: 'Domain not found.' };
    if (!row.verified_at) return { ok: false, status: 409, code: 'ownership_required', message: 'Verify ownership before preparing sender authentication.' };

    const lookup = await client.listExact(row.name);
    if (!lookup.ok) return saveFailed(lookup.error, lookup.status);
    if (lookup.domain) {
      if (!lookup.domain.id) return saveFailed('The outgoing email provider returned an existing record without an id.', 502);
      const saved = saveRelay({ tenantId, row, providerDomain: lookup.domain, status: lookup.domain.valid ? 'verified' : 'pending' });
      return { ok: true, existing: true, relay: publicRow(row, row), dnsRecords: recordsFromRow(saved) };
    }

    let created = await client.create(row.name);
    if (!created.ok && (created.timeout || created.status === 0)) {
      // A timed-out create may have succeeded upstream. Re-read the exact domain
      // before reporting failure so retries remain idempotent.
      const retryLookup = await client.listExact(row.name);
      if (retryLookup.ok && retryLookup.domain) created = retryLookup;
    }
    if (!created.ok) return saveFailed(created.error, created.status);
    if (!created.domain?.id) return saveFailed('The outgoing email provider did not return a domain id.', 502);
    const saved = saveRelay({ tenantId, row, providerDomain: created.domain, status: created.domain.valid ? 'verified' : 'pending' });
    return { ok: true, existing: false, relay: publicRow(row, row), dnsRecords: recordsFromRow(saved) };

    function saveFailed(message, providerStatus) {
      const existing = rowFor(row.id);
      if (existing) {
        db.prepare('UPDATE relay_auth SET status = ?, error_message = ?, updated_at = ? WHERE domain_id = ?')
          .run('failed', message, new Date().toISOString(), row.id);
      }
      return { ok: false, status: providerStatus === 401 || providerStatus === 403 ? 502 : 502, code: 'relay_provider_error', message };
    }
  }

  async function validate({ tenantId, domainId }) {
    const access = domainAccess(tenantId, domainId);
    if (!access.ok) return access;
    const row = access.row;
    if (!configured) return { ok: false, status: 409, code: 'relay_not_configured', message: 'No outgoing relay provider is configured.' };
    if (row.kind === 'hosted') return { ok: false, status: 403, code: 'hosted_relay_managed', message: 'The shared hosted domain is managed by Workspace; tenants cannot change its sender authentication.' };
    if (row.tenant_id !== tenantId) return { ok: false, status: 404, code: 'domain_not_found', message: 'Domain not found.' };
    if (!row.verified_at) return { ok: false, status: 409, code: 'ownership_required', message: 'Verify ownership before validating sender authentication.' };
    const relayRow = rowFor(row.id);
    if (!relayRow || !relayRow.provider_domain_id || relayRow.domain !== row.name) {
      return { ok: false, status: 409, code: 'relay_not_prepared', message: 'Prepare sender authentication for this exact domain first.' };
    }
    const result = await client.validate(relayRow.provider_domain_id, row.name);
    if (!result.ok) {
      db.prepare('UPDATE relay_auth SET status = ?, error_message = ?, updated_at = ? WHERE domain_id = ?')
        .run('failed', result.error, new Date().toISOString(), row.id);
      return { ok: false, status: 502, code: 'relay_provider_error', message: result.error };
    }
    const status = result.domain.valid ? 'verified' : 'pending';
    const saved = saveRelay({ tenantId, row, providerDomain: result.domain, status });
    return { ok: true, relay: publicRow(row, row), dnsRecords: recordsFromRow(saved) };
  }

  return {
    isConfigured,
    statusForTenant,
    get,
    prepare,
    validate,
    recordsForPlan,
    activationStatus
  };
}
