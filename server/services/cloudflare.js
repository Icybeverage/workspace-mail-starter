import { fingerprint } from './dns.js';

const CF_TIMEOUT_MS = 15000;

export function createCloudflareClient({ config, logger, fetchImpl = fetch }) {
  const apiBase = config.cloudflareApiBase;

  async function cfFetch(token, path, { method = 'GET', body = null } = {}) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(CF_TIMEOUT_MS),
        redirect: 'error'
      });
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { ok: false, httpOk: false, status: 0, error: timedOut ? 'Cloudflare did not respond in time.' : 'Cloudflare request failed.' };
    }
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    const apiOk = res.ok && json && json.success !== false;
    const apiErrors = json && Array.isArray(json.errors) ? json.errors.map((e) => e.message).filter(Boolean) : [];
    return {
      ok: apiOk,
      httpOk: res.ok,
      status: res.status,
      result: json ? json.result : null,
      resultInfo: json?.result_info,
      error: apiOk ? null : (apiErrors.join('; ') || `Cloudflare returned HTTP ${res.status}.`)
    };
  }

  async function verifyToken(token) {
    const res = await cfFetch(token, '/user/tokens/verify');
    if (!res.ok) return { ok: false, error: res.error || 'Token verification failed.' };
    return { ok: true, status: res.result?.status || 'active' };
  }

  // The token is expected to be scoped to a single zone; we require exactly one exact-name match.
  async function findZone(token, domain) {
    const res = await cfFetch(token, `/zones?name=${encodeURIComponent(domain)}&per_page=50`);
    if (!res.ok) return { ok: false, error: res.error || 'Zone lookup failed.' };
    const matches = (res.result || []).filter((z) => String(z.name).toLowerCase() === domain);
    if (matches.length === 0) {
      return { ok: false, error: `No Cloudflare zone found for "${domain}". Check the domain is in this Cloudflare account and the token covers this zone.` };
    }
    if (matches.length > 1) {
      return { ok: false, error: `Multiple zones matched "${domain}" — refusing to continue.` };
    }
    return { ok: true, zone: { id: matches[0].id, name: matches[0].name } };
  }

  async function listRecords(token, zoneId) {
    const all = [];
    for (let page = 1; page <= 10; page += 1) {
      const res = await cfFetch(token, `/zones/${zoneId}/dns_records?per_page=100&page=${page}`);
      if (!res.ok) return { ok: false, error: res.error || 'Could not list DNS records.' };
      all.push(...(res.result || []));
      const totalPages = res.resultInfo?.total_pages || 1;
      if (totalPages > 10) return { ok:false, error: "Zone exceeds the supported record count; use manual DNS setup." };
      if (page >= totalPages) break;
    }
    return {
      ok: true,
      records: all.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        content: r.content,
        priority: r.priority ?? null,
        ttl: r.ttl
      }))
    };
  }

  function recordKey(r) {
    return `${r.type}:${r.name}`;
  }

  function listFingerprint(records) {
    return fingerprint(
      records
        .map((r) => ({ type: r.type, name: r.name, content: r.content, priority: r.priority }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    );
  }

  function planValueToCf(domain, op) {
    const name = op.name === '@' ? domain : (op.name === domain || op.name.endsWith(`.${domain}`) ? op.name : `${op.name}.${domain}`);
    if (op.type === 'MX') {
      const m = String(op.proposed).match(/^(\d+)\s+(.+)$/);
      if (!m) return { error: `Invalid MX value "${op.proposed}".` };
      return { value: { type: 'MX', name, content: m[2], priority: Number(m[1]), ttl: 3600 } };
    }
    return { value: { type: op.type, name, content: String(op.proposed), ttl: 3600 } };
  }

  async function applyOperations(token, zoneId, domain, operations) {
    const current = await listRecords(token, zoneId);
    if (!current.ok) return { ok: false, error: current.error, results: [] };
    function matchesOperation(record, value, op) {
      if (record.type !== value.type || record.name.toLowerCase() !== value.name.toLowerCase()) return false;
      if (op.key.startsWith('spf:')) return /^v=spf1(?:\s|$)/i.test(record.content);
      if (op.key.startsWith('dmarc:')) return /^v=DMARC1(?:;|\s|$)/i.test(record.content);
      return true;
    }
    const results = [];

    for (const op of operations) {
      const action = op.action;
      if (action !== 'create' && action !== 'update') {
        results.push({ key: op.key, action, status: 'skipped' });
        continue;
      }
      const converted = planValueToCf(domain, op);
      if (converted.error) {
        results.push({ key: op.key, action, status: 'error', error: converted.error });
        continue;
      }
      const value = converted.value;
      const matches = current.records.filter((r) => matchesOperation(r, value, op));
      const existing = matches[0] || null;
      if (matches.length > 1 && value.type !== 'MX') {
        results.push({ key:op.key, action, status:'error', error:'Multiple matching policy records; resolve manually before applying.' });
        break;
      }

      if (action === 'create') {
        if (existing) {
          // Do not overwrite whatever appeared since planning.
          results.push({ key: op.key, action, status: existing.content === value.content && (value.type !== 'MX' || existing.priority === value.priority) ? 'skipped' : 'error', reason: 'A matching record already exists; it was preserved.' });
          continue;
        }
        const res = await cfFetch(token, `/zones/${zoneId}/dns_records`, { method: 'POST', body: value });
        results.push({
          key: op.key,
          action,
          status: res.ok ? 'created' : 'error',
          recordId: res.result?.id || null,
          backup: null,
          error: res.error
        });
      } else {
        if (!existing) {
          results.push({ key: op.key, action, status: 'error', error: 'Record to update no longer exists; re-plan.' });
          continue;
        }
        const res = await cfFetch(token, `/zones/${zoneId}/dns_records/${existing.id}`, { method: 'PUT', body: value });
        if (res.ok && value.type === 'MX') {
          // The reviewed MX operation replaces the complete existing MX set.
          for (const extra of matches.slice(1)) {
            const removed = await cfFetch(token, `/zones/${zoneId}/dns_records/${extra.id}`, {method:'DELETE'});
            results.push({key:op.key, action:'remove_old_mx',status:removed.ok?'deleted':'error',recordId:extra.id,backup:extra,error:removed.error});
            if (!removed.ok) break;
          }
        }
        results.push({
          key: op.key,
          action,
          status: res.ok ? 'updated' : 'error',
          recordId: existing.id,
          backup: { id: existing.id, type: existing.type, name: existing.name, content: existing.content, priority: existing.priority, ttl: existing.ttl },
          error: res.error
        });
      }
    }

    const summary = {
      created: results.filter((r) => r.status === 'created').length,
      updated: results.filter((r) => r.status === 'updated').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      errors: results.filter((r) => r.status === 'error').length
    };
    logger?.info('cloudflare apply finished', { zoneId, summary, keys: results.map((r) => `${r.key}:${r.status}`) });
    return { ok: summary.errors === 0, results, summary };
  }

  return { verifyToken, findZone, listRecords, applyOperations, listFingerprint };
}
