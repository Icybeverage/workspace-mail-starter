import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeDomain, validateLocalPart, parseVerifyTxt } from '../server/services/domain-names.js';
import { mergeSpf, parseSpfMechanisms, normalizeMailServerDump } from '../server/services/dns.js';

test('canonicalizeDomain accepts normal domains, lowercases, strips trailing dot', () => {
  assert.deepEqual(canonicalizeDomain('Example.COM'), { ok: true, domain: 'example.com' });
  assert.deepEqual(canonicalizeDomain('mail.example.co.uk.'), { ok: true, domain: 'mail.example.co.uk' });
});

test('canonicalizeDomain converts IDN to punycode via domainToASCII', () => {
  const r = canonicalizeDomain('münchen.de');
  assert.equal(r.ok, true);
  assert.equal(r.domain, 'xn--mnchen-3ya.de');
});

test('canonicalizeDomain rejects IPs, paths, ports, spaces, malformed labels', () => {
  for (const bad of ['1.2.3.4', '127.0.0.1', 'http://example.com', 'example.com/path', 'example.com:8080', 'exa mple.com', '-bad.com', 'bad-.com', 'no_dot', 'example..com', 'example.c', `${'a'.repeat(64)}.com`, '']) {
    const r = canonicalizeDomain(bad);
    assert.equal(r.ok, false, `expected rejection: ${bad}`);
  }
});

test('validateLocalPart enforces syntax and hosted reserved names', () => {
  assert.equal(validateLocalPart('sam', { reserved: ['admin'], hosted: true }).ok, true);
  assert.equal(validateLocalPart('a.b_c-d', { reserved: [], hosted: true }).ok, true);
  assert.equal(validateLocalPart('admin', { reserved: ['admin'], hosted: true }).ok, false);
  assert.equal(validateLocalPart('admin', { reserved: ['admin'], hosted: false }).ok, true);
  assert.equal(validateLocalPart('..dots', { hosted: true }).ok, false);
  assert.equal(validateLocalPart('-lead', { hosted: true }).ok, false);
  assert.equal(validateLocalPart('UPPER', { hosted: true }).localPart, 'upper');
});

test('parseVerifyTxt matches the exact published value', () => {
  assert.equal(parseVerifyTxt(['"workspace-verify=abc"', 'other'], 'abc'), true);
  assert.equal(parseVerifyTxt(['workspace-verify=ab'], 'abc'), false);
  assert.equal(parseVerifyTxt([], 'abc'), false);
});

test('mergeSpf keeps a single SPF and preserves third-party mechanisms', () => {
  const merged = mergeSpf(['v=spf1 include:_spf.google.com ~all'], 'v=spf1 mx -all');
  assert.equal(merged.ok, true);
  assert.equal(merged.value, 'v=spf1 include:_spf.google.com mx ~all');
});

test('mergeSpf deduplicates overlapping mechanisms', () => {
  const merged = mergeSpf(['v=spf1 mx include:x.com -all'], 'v=spf1 mx include:y.com -all');
  assert.equal(merged.value, 'v=spf1 mx include:x.com include:y.com -all');
});

test('mergeSpf passes through when no SPF exists', () => {
  const merged = mergeSpf([], 'v=spf1 mx -all');
  assert.equal(merged.ok, true);
  assert.equal(merged.value, 'v=spf1 mx -all');
  assert.equal(merged.merged, false);
});

test('mergeSpf flags multiple SPF records as a manual conflict', () => {
  const merged = mergeSpf(['v=spf1 mx -all', 'v=spf1 include:x.com -all'], 'v=spf1 mx -all');
  assert.equal(merged.ok, false);
  assert.match(merged.conflict, /Multiple SPF/);
});

test('mergeSpf flags macros/redirect as a manual conflict', () => {
  const merged = mergeSpf(['v=spf1 redirect=_spf.example.com'], 'v=spf1 mx -all');
  assert.equal(merged.ok, false);
  assert.match(merged.conflict, /redirect|macros/i);
});

test('mergeSpf appends a softfail terminal when existing SPF has none', () => {
  const merged = mergeSpf(['v=spf1 include:x.com'], 'v=spf1 mx -all');
  assert.equal(merged.value, 'v=spf1 include:x.com mx ~all');
});

test('parseSpfMechanisms separates terminal qualifier', () => {
  assert.deepEqual(parseSpfMechanisms('v=spf1 mx include:a.com -all'), { mechanisms: ['mx', 'include:a.com'], terminal: '-all' });
  assert.deepEqual(parseSpfMechanisms('v=spf1 mx'), { mechanisms: ['mx'], terminal: null });
});

test('normalizeMailServerDump filters to the domain and maps fields', () => {
  const raw = {
    records: [
      { qname: '@', rtype: 'MX', value: '10 box.test' },
      { qname: 'other.com', rtype: 'MX', value: '10 elsewhere.test' },
      { qname: 'mail._domainkey.example.com', rtype: 'TXT', value: 'v=DKIM1; p=abc' },
      { qname: 'example.com', rtype: 'A', value: '203.0.113.5' }
    ]
  };
  const out = normalizeMailServerDump(raw, 'example.com');
  assert.equal(out.supported, true);
  assert.equal(out.records.length, 2);
  assert.ok(out.records.some((r) => r.type === 'MX' && r.value === '10 box.test'));
  assert.ok(out.records.some((r) => r.type === 'TXT' && r.qname.includes('_domainkey')));
  assert.equal(normalizeMailServerDump(null, 'example.com').supported, false);
});

test('normalizeMailServerDump handles the live grouped array format and never emits website A records', () => {
  // Shape returned by the real GET /dns/dump: [[zone, [records...]], ...]
  const raw = [
    ['example.test', [
      { qname: 'example.test', rtype: 'MX', value: '10 mail.example.test.', explanation: 'mail' },
      { qname: 'example.test', rtype: 'A', value: '203.0.113.10', explanation: 'website' },
      { qname: 'www.example.test', rtype: 'A', value: '203.0.113.11' },
      { qname: '_dmarc.example.test', rtype: 'TXT', value: 'v=DMARC1; p=quarantine' },
      { qname: 'mail._domainkey.example.test', rtype: 'TXT', value: 'v=DKIM1; p=abc' }
    ]],
    ['other.example', [{ qname: '@', rtype: 'MX', value: '10 other.test' }]]
  ];
  const out = normalizeMailServerDump(raw, 'example.test');
  assert.equal(out.supported, true);
  assert.equal(out.records.length, 3);
  assert.ok(out.records.every((r) => r.type !== 'A'), 'website A records must never enter a plan');
  assert.ok(out.records.some((r) => r.type === 'MX' && r.value === '10 mail.example.test.'));
  assert.ok(out.records.some((r) => r.qname === '_dmarc.example.test'));
  assert.ok(out.records.some((r) => r.qname.includes('_domainkey')));
  assert.ok(!out.records.some((r) => r.value.includes('other.test')), 'other zones are filtered out');
});

test('normalizeMailServerDump reads a subdomain grouped inside its parent zone without attributing the parent apex', () => {
  // MAIL_SERVER groups subdomain mail records inside the parent DNS zone, so the
  // requested domain must select exactly its own records from that zone and
  // must never inherit the parent zone's apex records.
  const raw = [
    ['example.com', [
      { qname: '@', rtype: 'MX', value: '10 box.example.com.' },
      { qname: 'example.com', rtype: 'TXT', value: 'v=spf1 mx -all' },
      { qname: 'sub.example.com', rtype: 'MX', value: '10 box.example.com.' },
      { qname: 'sub.example.com', rtype: 'TXT', value: 'v=spf1 mx -all' },
      { qname: '_dmarc.sub.example.com', rtype: 'TXT', value: 'v=DMARC1; p=quarantine' },
      { qname: 'mail._domainkey.sub.example.com', rtype: 'TXT', value: 'v=DKIM1; p=abc' },
      { qname: 'www.sub.example.com', rtype: 'A', value: '203.0.113.7' }
    ]],
    ['other.example', [{ qname: 'sub.example.com', rtype: 'MX', value: '10 elsewhere.test' }]]
  ];
  const out = normalizeMailServerDump(raw, 'sub.example.com');
  assert.equal(out.supported, true);
  assert.equal(out.records.length, 4);
  assert.ok(out.records.every((r) => r.type !== 'A'));
  assert.ok(!out.records.some((r) => r.qname === 'example.com'), "the parent zone's apex records must not become the subdomain's records");
  assert.ok(out.records.some((r) => r.type === 'MX' && r.qname === 'sub.example.com'));
  assert.ok(out.records.some((r) => r.qname === '_dmarc.sub.example.com'));
  assert.ok(out.records.some((r) => r.qname === 'mail._domainkey.sub.example.com'));
  assert.ok(!out.records.some((r) => r.value.includes('elsewhere.test')), 'unrelated zones stay filtered out');

  // A subdomain whose records exist only at the parent zone's apex has no
  // supported records: the parent apex must not be reported as the subdomain.
  const onlyParentApex = normalizeMailServerDump([
    ['example.com', [{ qname: '@', rtype: 'MX', value: '10 box.example.com.' }]]
  ], 'sub.example.com');
  assert.equal(onlyParentApex.supported, false);
});
