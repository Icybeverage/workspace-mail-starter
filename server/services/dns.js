import dns from 'node:dns';
import { sha256Hex } from '../lib/security.js';

const { Resolver } = dns.promises;

export function createDnsInspector({ resolver = new Resolver({ timeout: 5000, tries: 2 }) } = {}) {
  async function tryResolve(fn, name) {
    try {
      return { ok: true, value: await fn(name) };
    } catch (err) {
      const code = err && err.code ? err.code : 'UNKNOWN';
      return { ok: false, code, value: [] };
    }
  }

  async function inspect(domain, { dkimSelector = 'mail', relayRecords = [] } = {}) {
    const relayQueries = [...new Map(
      relayRecords
        .filter((record) => record && record.type === 'CNAME' && record.name)
        .map((record) => [String(record.name).toLowerCase().replace(/\.$/, ''), record])
    ).keys()];
    const [mx, apexTxt, dkimTxt, dmarcTxt, ...relayResults] = await Promise.all([
      tryResolve((n) => resolver.resolveMx(n), domain),
      tryResolve((n) => resolver.resolveTxt(n), domain),
      tryResolve((n) => resolver.resolveTxt(n), `${dkimSelector}._domainkey.${domain}`),
      tryResolve((n) => resolver.resolveTxt(n), `_dmarc.${domain}`),
      ...relayQueries.map((name) => tryResolve((n) => resolver.resolveCname(n), name))
    ]);

    const txts = (apexTxt.value || []).map((chunks) => chunks.join(''));
    const spfRecords = txts.filter((t) => /^v=spf1(\s|$)/i.test(t));
    const dkimRecords = (dkimTxt.value || []).map((chunks) => chunks.join(''));
    const dmarcRecords = (dmarcTxt.value || []).map((chunks) => chunks.join(''));
    const mxRecords = (mx.ok ? mx.value : []).map((r) => ({ priority: r.priority, exchange: String(r.exchange).replace(/\.$/, '').toLowerCase() }))
      .sort((a, b) => a.priority - b.priority || a.exchange.localeCompare(b.exchange));

    return {
      domain,
      checkedAt: new Date().toISOString(),
      dnsStatus: {
        mx: mx.ok ? 'answered' : mx.code,
        txt: apexTxt.ok ? 'answered' : apexTxt.code,
        dkim: dkimTxt.ok ? 'answered' : dkimTxt.code,
        dmarc: dmarcTxt.ok ? 'answered' : dmarcTxt.code
      },
      mx: mxRecords,
      txt: txts,
      spf: { records: spfRecords, count: spfRecords.length, valid: spfRecords.length === 1 },
      dkim: { selector: dkimSelector, records: dkimRecords, present: dkimRecords.length > 0 },
      dmarc: { records: dmarcRecords, present: dmarcRecords.length > 0 },
      relay: Object.fromEntries(relayQueries.map((name, i) => [
        name,
        relayResults[i].ok
          ? relayResults[i].value.map((value) => String(value).replace(/\.$/, '').toLowerCase())
          : []
      ]))
    };
  }

  async function txt(name) {
    const res = await tryResolve((n) => resolver.resolveTxt(n), name);
    return { ok: res.ok, values: (res.value || []).map((chunks) => chunks.join('')), code: res.code };
  }

  return { inspect, txt };
}

export function parseSpfMechanisms(spf) {
  const tokens = String(spf).trim().split(/\s+/);
  if (tokens[0] && tokens[0].toLowerCase() === 'v=spf1') tokens.shift();
  const terminal = tokens.length && /^[?~+-]?all$/i.test(tokens[tokens.length - 1]) ? tokens.pop() : null;
  return { mechanisms: tokens, terminal };
}

export function mergeSpf(existingSpfs, desiredSpf) {
  if (!existingSpfs || existingSpfs.length === 0) {
    return { ok: true, value: desiredSpf, merged: false, note: 'No existing SPF record; proposed as-is.' };
  }
  if (existingSpfs.length > 1) {
    return {
      ok: false,
      conflict: 'Multiple SPF records are published. Merge them into one record manually — a domain must have exactly one SPF record.'
    };
  }
  const existing = existingSpfs[0];
  if (/%\{|redirect=/i.test(existing) || !/^v=spf1(?:\s|$)/i.test(existing) || /\s[-~?](?!all(?:\s|$))/i.test(existing)) {
    return {
      ok: false,
      conflict: 'Existing SPF record uses macros or redirect=. Merge manually so the third-party policy is preserved.'
    };
  }
  const parsedExisting = parseSpfMechanisms(existing);
  const parsedDesired = parseSpfMechanisms(desiredSpf);
  if (parsedExisting.mechanisms.some((m) => /^[?~+-]?all$/i.test(m))) {
    return { ok: false, conflict: 'SPF contains an all mechanism before the end; resolve this policy manually before activation.' };
  }
  const seen = new Set(parsedExisting.mechanisms.map((m) => m.toLowerCase()));
  const merged = [...parsedExisting.mechanisms];
  for (const mech of parsedDesired.mechanisms) {
    if (!seen.has(mech.toLowerCase())) {
      merged.push(mech);
      seen.add(mech.toLowerCase());
    }
  }
  let terminal = parsedExisting.terminal;
  let note = 'Merged with existing SPF mechanisms preserved.';
  if (!terminal) {
    terminal = '~all';
    note = 'Existing SPF had no "all" mechanism; appended ~all (softfail).';
  }
  return { ok: true, value: ['v=spf1', ...merged, terminal].join(' '), merged: true, note };
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function fingerprint(value) {
  return sha256Hex(stableStringify(value));
}

function normalizeTxtRecord(value) {
  return String(value).replace(/[\s"]+/g, '');
}

// Explains a DKIM check result without exposing key material: only the match
// state, record counts and a safe next step are reported. The exact TXT values
// are public DNS data and stay in the DNS plan; the diagnosis never duplicates
// them, and private keys or credentials never enter DNS inspection at all.
export function dkimDiagnosis({ selector, publishedRecords, desiredValue }) {
  const published = Array.isArray(publishedRecords) ? publishedRecords : [];
  const providerKeyAvailable = typeof desiredValue === 'string' && normalizeTxtRecord(desiredValue) !== '';
  const matched = providerKeyAvailable
    ? published.filter((rec) => normalizeTxtRecord(rec) === normalizeTxtRecord(desiredValue)).length
    : 0;
  const recordName = `${selector}._domainkey`;

  let condition;
  let comparison;
  let summary;
  let nextStep;

  if (!providerKeyAvailable) {
    condition = 'provider_key_unavailable';
    comparison = 'not_compared';
    summary = published.length === 0
      ? `No DKIM record is published at ${recordName} yet, and the mail server's current signing key is not available, so there is nothing to compare.`
      : `${published.length} DKIM record${published.length === 1 ? '' : 's'} published at ${recordName}, but the mail server's current signing key is not available, so ${published.length === 1 ? 'it' : 'they'} cannot be compared.`;
    nextStep = `Create the first mailbox on this domain so the mail server generates its DKIM key, then re-run the DNS checks to compare the published record against it.`;
  } else if (published.length === 0) {
    condition = 'record_missing';
    comparison = 'none_published';
    summary = `No DKIM record is published at ${recordName} yet; the mail server's current signing key is available for comparison.`;
    nextStep = `Publish the TXT record proposed for ${recordName} in the DNS plan — until it exists, outbound mail from this domain cannot be DKIM-verified.`;
  } else if (matched === 0) {
    condition = 'key_mismatch';
    comparison = 'differs';
    summary = `A DKIM record is published at ${recordName}, but it does not match the mail server's current signing key — mail signed with the current key fails DKIM verification until the record is updated.`;
    nextStep = `Re-run planning and update the ${recordName} TXT record to the mail server's current key from the DNS plan, keeping exactly one record; mail signed with the previous key may still verify in the meantime.`;
  } else {
    condition = 'key_match';
    comparison = 'equal';
    const extra = published.length - matched;
    summary = extra === 0
      ? `The published DKIM record at ${recordName} matches the mail server's current signing key.`
      : `The mail server's current DKIM key is published at ${recordName}, along with ${extra} other record${extra === 1 ? '' : 's'} at the same name.`;
    nextStep = extra === 0
      ? 'No action needed — re-run the DNS checks after the mail server rotates its signing key.'
      : `Remove the extra TXT record${extra === 1 ? '' : 's'} at ${recordName} so exactly one remains; verifiers may otherwise select a stale key.`;
  }

  return {
    selector,
    condition,
    comparison,
    providerKeyAvailable,
    matchedRecordCount: providerKeyAvailable ? matched : null,
    recordCounts: { expected: 1, current: published.length },
    summary,
    nextStep
  };
}

export function dnsStateFingerprint(inspected) {
  return fingerprint({
    mx: inspected.mx,
    spf: inspected.spf.records,
    dkim: inspected.dkim.records,
    dmarc: inspected.dmarc.records,
    relay: inspected.relay || {}
  });
}

export function recommendedRecords({ domain, mailHost }) {
  return [
    { name: '@', type: 'MX', value: `10 ${mailHost}`, explanation: 'Route inbound mail to the Workspace mail server.' },
    { name: '@', type: 'TXT', value: 'v=spf1 mx -all', explanation: 'Allow only the mail server to send for this domain.' },
    { name: '_dmarc', type: 'TXT', value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, explanation: 'DMARC policy (adjust the report address if you prefer).' }
  ];
}

export function normalizeMailServerDump(raw, domain) {
  if (!raw || typeof raw !== 'object') return { records: [], supported: false };
  let records = null;
  if (Array.isArray(raw)) records = raw.flatMap((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[1])) return [entry];
    const zone = String(entry[0]).replace(/\.$/, '').toLowerCase();
    // MAIL_SERVER groups subdomain mail records inside their parent DNS zone.
    // Exact record-name filtering below still isolates the requested domain.
    if (zone !== domain && !domain.endsWith(`.${zone}`)) return [];
    return entry[1].map((record) => record && (record.qname ?? record.name) === '@'
      ? { ...record, qname: zone } : record);
  });
  else if (Array.isArray(raw.records)) records = raw.records;
  else records = Object.values(raw).flatMap((v) => (Array.isArray(v) ? v : []));
  if (!Array.isArray(records)) return { records: [], supported: false };
  const out = [];
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const qname = String(rec.qname ?? rec.name ?? '').toLowerCase();
    const rtype = String(rec.rtype ?? rec.type ?? '').toUpperCase();
    const value = rec.value !== undefined ? String(rec.value) : (rec.content !== undefined ? String(rec.content) : '');
    if (!['MX', 'TXT'].includes(rtype) || value === '') continue;
    const bare = qname.replace(/\.$/, '');
    const belongs = qname === '@' || bare === domain || bare === `_dmarc.${domain}` || bare === `mail._domainkey.${domain}`;
    if (!belongs) continue;
    out.push({ qname: qname === '' ? '@' : qname, type: rtype, value, explanation: rec.explanation ? String(rec.explanation) : '' });
  }
  return { records: out, supported: out.length > 0 };
}

export function buildDnsPlan({ domain, kind, inspected, desired, mailHost }) {
  const records = [];
  const conflicts = [];

  const currentMx = (inspected.mx || []).map((m) => `${m.priority} ${m.exchange}`);
  const desiredMx = desired.filter((r) => r.type === 'MX').map((r) => r.value.replace(/\.$/, ''));
  const mxValue = desiredMx[0] || `10 ${mailHost}`;
  const mxAction = currentMx.length === 0 ? 'create' : (currentMx.length === 1 && currentMx[0] === mxValue ? 'keep' : 'update');

  if (kind === 'hosted') {
    return {
      domain,
      kind,
      generatedAt: new Date().toISOString(),
      sources: { desired: 'provider_managed', dkim: 'provider_managed' },
      records: [{
        key: 'mx:@',
        name: '@',
        type: 'MX',
        current: currentMx,
        proposed: mxValue,
        action: 'managed',
        reason: 'Hosted on the shared Workspace domain — DNS is managed by the provider.'
      }],
      conflicts: [],
      approvalsRequired: [],
      delivery: deliveryStatus()
    };
  }

  records.push({
    key: 'mx:@',
    name: '@',
    type: 'MX',
    current: currentMx,
    proposed: mxValue,
    action: mxAction,
    requiresMxApproval: mxAction !== 'keep',
    reason: mxAction === 'keep'
      ? 'MX already points at the Workspace mail server.'
      : (mxAction === 'create'
        ? 'No MX records exist yet; adding one starts routing inbound mail to Workspace.'
        : 'Replacing existing MX records changes where inbound mail is delivered.')
  });

  const desiredSpf = desired.find((r) => r.type === 'TXT' && /^v=spf1\b/i.test(r.value));
  const spfDesiredValue = desiredSpf ? desiredSpf.value : 'v=spf1 mx -all';
  const spfMerge = mergeSpf(inspected.spf.records, spfDesiredValue);
  if (spfMerge.ok) {
    const currentSpf = inspected.spf.records;
    const changed = currentSpf.length !== 1 || currentSpf[0] !== spfMerge.value;
    records.push({
      key: 'spf:@',
      name: '@',
      type: 'TXT',
      current: currentSpf,
      proposed: spfMerge.value,
      action: changed ? (currentSpf.length ? 'update' : 'create') : 'keep',
      reason: spfMerge.note
    });
  } else {
    records.push({
      key: 'spf:@',
      name: '@',
      type: 'TXT',
      current: inspected.spf.records,
      proposed: null,
      action: 'conflict',
      reason: spfMerge.conflict
    });
    conflicts.push({ key: 'spf:@', type: 'spf', reason: spfMerge.conflict, resolution: 'manual' });
  }

  const dkimDesired = desired.find((r) => r.type === 'TXT' && /_domainkey/i.test(r.qname) && /p=/.test(r.value));
  if (dkimDesired) {
    const currentDkim = inspected.dkim.records;
    const same = currentDkim.some((rec) => normalizeTxtRecord(rec) === normalizeTxtRecord(dkimDesired.value));
    records.push({
      key: `dkim:${inspected.dkim.selector}`,
      name: `${inspected.dkim.selector}._domainkey`,
      type: 'TXT',
      current: currentDkim,
      proposed: dkimDesired.value,
      action: currentDkim.length === 0 ? 'create' : (same ? 'keep' : 'update'),
      reason: 'DKIM signing record from the mail server.'
    });
  } else {
    records.push({
      key: `dkim:${inspected.dkim.selector}`,
      name: `${inspected.dkim.selector}._domainkey`,
      type: 'TXT',
      current: inspected.dkim.records,
      proposed: null,
      action: 'pending_upstream',
      reason: 'DKIM record is generated by the mail server once a mailbox is staged on this domain.'
    });
  }

  const dmarcDesired = desired.find((r) => r.type === 'TXT' && /^v=DMARC1\b/i.test(r.value));
  const dmarcValue = inspected.dmarc.records.length === 1 ? inspected.dmarc.records[0] : (dmarcDesired ? dmarcDesired.value : recommendedRecords({ domain, mailHost }).find((r) => r.name === '_dmarc').value);
  if (inspected.dmarc.records.length > 1) conflicts.push({ key: 'dmarc:_dmarc', type: 'dmarc', reason: 'Multiple DMARC records require manual resolution.', resolution: 'manual' });
  const dmarcAction = inspected.dmarc.records.length === 0
    ? 'create'
    : (inspected.dmarc.records.includes(dmarcValue) ? 'keep' : 'update');
  records.push({
    key: 'dmarc:_dmarc',
    name: '_dmarc',
    type: 'TXT',
    current: inspected.dmarc.records,
    proposed: dmarcValue,
    action: dmarcAction,
    reason: dmarcAction === 'keep'
      ? 'DMARC policy already published.'
      : (dmarcDesired ? 'DMARC policy from the mail server zone dump.' : 'Recommended DMARC policy — review before applying.')
  });

  for (const relay of desired.filter((record) => record.type === 'CNAME' && record.value)) {
    const name = String(relay.name || relay.qname || '').replace(/\.$/, '').toLowerCase();
    if (!name) continue;
    const current = inspected.relay?.[name] || [];
    const same = current.length === 1 && current[0] === String(relay.value).replace(/\.$/, '').toLowerCase();
    const action = current.length === 0 ? 'create' : (same ? 'keep' : 'update');
    records.push({
      key: relay.key || `relay:${name}`,
      name,
      type: 'CNAME',
      current,
      proposed: relay.value,
      action,
      reason: relay.explanation || 'Required CNAME for outgoing relay sender authentication.'
    });
    if (current.length > 1) {
      conflicts.push({
        key: relay.key || `relay:${name}`,
        type: 'relay',
        reason: `Multiple CNAME records exist at ${name}; resolve them manually.`,
        resolution: 'manual'
      });
    }
  }

  const planCore = {
    domain,
    records: records.map((r) => ({ key: r.key, name: r.name, type: r.type, current: r.current, proposed: r.proposed, action: r.action }))
  };

  return {
    domain,
    kind,
    generatedAt: new Date().toISOString(),
    sources: {
      desired: desired.some((r) => r.source === 'mailserver_dump') ? 'mailserver_dump' : 'recommended_default',
      dkim: dkimDesired ? 'mailserver_dump' : 'pending_upstream'
    },
    records,
    conflicts,
    approvalsRequired: records.some((r) => r.requiresMxApproval) ? ['mx'] : [],
    planHash: fingerprint(planCore),
    delivery: deliveryStatus()
  };
}

export function deliveryStatus() {
  return {
    inbound: 'unknown',
    outbound: 'unknown',
    note: 'Mail delivery is not verified. Inbound and outbound delivery stay "unknown" until an actual test message round-trips — DNS records alone do not prove delivery.'
  };
}
