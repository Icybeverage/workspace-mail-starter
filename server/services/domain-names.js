import net from 'node:net';
import { domainToASCII } from 'node:url';

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function canonicalizeDomain(input) {
  if (typeof input !== 'string') return { ok: false, error: 'Domain must be a string.' };
  let raw = input.trim().toLowerCase();
  if (!raw) return { ok: false, error: 'Enter a domain name.' };
  if (raw.endsWith('.')) raw = raw.slice(0, -1);

  if (raw.length > 253) return { ok: false, error: 'Domain is too long.' };
  if (/[/\\:@?#\s]/.test(raw)) {
    return { ok: false, error: 'Domain must not contain a path, port, spaces, or special characters.' };
  }
  if (net.isIP(raw)) return { ok: false, error: 'IP addresses are not valid email domains.' };

  let ascii;
  try {
    ascii = domainToASCII(raw);
  } catch {
    ascii = '';
  }
  if (!ascii) return { ok: false, error: 'Domain is not valid internationalized text.' };
  ascii = ascii.toLowerCase();
  if (net.isIP(ascii)) return { ok: false, error: 'IP addresses are not valid email domains.' };

  const labels = ascii.split('.');
  if (labels.length < 2) return { ok: false, error: 'Enter a full domain like example.com.' };
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return { ok: false, error: `Invalid label "${label}".` };
    if (!LABEL_RE.test(label)) {
      return { ok: false, error: `Invalid label "${label}" — use letters, digits, and internal hyphens only.` };
    }
  }
  const tld = labels[labels.length - 1];
  if (/^[0-9]+$/.test(tld) || tld.length < 2) {
    return { ok: false, error: 'Top-level part of the domain looks invalid.' };
  }
  return { ok: true, domain: ascii };
}

export function validateLocalPart(input, { reserved = [], hosted = false } = {}) {
  if (typeof input !== 'string') return { ok: false, error: 'Mailbox name must be a string.' };
  const local = input.trim().toLowerCase();
  if (!local) return { ok: false, error: 'Choose a mailbox name.' };
  if (local.length > 64) return { ok: false, error: 'Mailbox name is too long (max 64 characters).' };
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(local)) {
    return { ok: false, error: 'Use letters, digits, dots, dashes, or underscores; must start and end alphanumeric.' };
  }
  if (local.includes('..')) return { ok: false, error: 'Mailbox name cannot contain consecutive dots.' };
  if (hosted && reserved.includes(local)) {
    return { ok: false, error: `"${local}" is reserved on the shared hosted domain. Pick another name.` };
  }
  return { ok: true, localPart: local };
}

export function buildAddress(localPart, domain) {
  return `${localPart}@${domain}`;
}

export function verifyRecordName(domain) {
  return `_workspace-verify.${domain}`;
}

export function verifyRecordValue(token) {
  return `workspace-verify=${token}`;
}

export function parseVerifyTxt(records, token) {
  const expected = verifyRecordValue(token);
  return (records || []).some((txt) => String(txt).replace(/^"|"$/g, '').trim() === expected);
}
