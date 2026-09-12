export const DISPLAY_TIME_ZONE = 'America/Los_Angeles';

export function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { timeZone: DISPLAY_TIME_ZONE });
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('en-US', {
    timeZone: DISPLAY_TIME_ZONE, year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
  });
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[i]}`;
}

export function fmtConfidence(value) {
  if (!value) return 'Unknown';
  return String(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// Interpret a CalDAV wall-clock timestamp in its source zone, independently
// of the browser zone. Floating events use the workspace's Pacific zone.
export function parseIcalDate(value, timezone = DISPLAY_TIME_ZONE) {
  if (!value) return null;
  const raw = String(value);
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/);
  if (!compact) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const [, y, mo, d, h, mi, s, z] = compact;
  const civil = Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0));
  if (z || !h) return new Date(civil);
  const zone = !timezone || timezone === 'floating/date' ? DISPLAY_TIME_ZONE : timezone;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    let instant = civil;
    for (let i = 0; i < 4; i += 1) {
      const p = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
      const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      const correction = civil - shown;
      if (!correction) return new Date(instant);
      instant += correction;
    }
    return null; // Invalid/nonexistent wall time: preserve source rather than invent an instant.
  } catch {
    return null;
  }
}

export function fmtIcalDateTime(value, timezone) {
  const date = parseIcalDate(value, timezone);
  if (!date) return value || '—';
  if (/^\d{8}$|^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return date.toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
  }
  return fmtDateTime(date);
}

export function fmtEventRange(start, end, timezone) {
  if (!start) return '—';
  const startText = fmtIcalDateTime(start, timezone);
  if (!end || end === start) return startText;
  return `${startText} – ${fmtIcalDateTime(end, timezone)}`;
}

/** Resolve a workspace snapshot id from a graph node localId (`mailboxId:resourceId`). */
export function graphNodeResourceId(node, expectedMailboxId) {
  if (!node?.localId || !expectedMailboxId) return null;
  if (node.mailboxId && node.mailboxId !== expectedMailboxId) return null;
  const prefix = `${expectedMailboxId}:`;
  const localId = String(node.localId);
  if (!localId.startsWith(prefix)) return null;
  return localId.slice(prefix.length);
}

export function findSourceEmail(item, node) {
  if (!item || !node) return null;
  const resourceId = graphNodeResourceId(node, item.mailboxId);
  if (node.type === 'Email') {
    return resourceId ? item.emails.find((email) => email.id === resourceId) || null : null;
  }
  if (node.type === 'Commitment') {
    const action = resourceId ? item.actions.find((entry) => entry.id === resourceId) : null;
    if (!action) return null;
    return item.emails.find((email) => email.id === action.emailId) || null;
  }
  return null;
}

export function workspaceNodeTitle(type) {
  return {
    Workspace: 'Workspace snapshot',
    Calendar: 'Calendar',
    Event: 'Calendar event',
    Storage: 'Files storage',
    File: 'File',
    Email: 'Email message',
    Commitment: 'Suggested action',
    Mailbox: 'Mailbox',
    Domain: 'Domain'
  }[type] || 'Resource';
}

export function workspaceNodeDetails(node) {
  const rows = [];
  switch (node.type) {
    case 'Event':
      rows.push({ label: 'When', value: fmtEventRange(node.start, node.end, node.timezone) });
      if (node.recurring) rows.push({ label: 'Series', value: 'Recurring (not expanded)' });
      break;
    case 'File':
      if (node.sizeBytes != null) rows.push({ label: 'Size', value: fmtBytes(node.sizeBytes) || '—' });
      if (node.modified) rows.push({ label: 'Modified', value: fmtDateTime(node.modified) });
      break;
    case 'Email':
      if (node.sender) rows.push({ label: 'From', value: node.sender });
      if (node.date) rows.push({ label: 'Received', value: fmtDateTime(node.date) });
      break;
    case 'Commitment':
      rows.push({ label: 'Confidence', value: fmtConfidence(node.confidence) });
      rows.push({ label: 'Method', value: 'Rule-based pattern match' });
      if (node.deadlineText) rows.push({ label: 'Deadline hint', value: node.deadlineText });
      if (node.evidence) rows.push({ label: 'Source excerpt', value: node.evidence });
      break;
    case 'Storage':
      if (node.usedBytes != null) rows.push({ label: 'Used', value: fmtBytes(node.usedBytes) || '—' });
      break;
    case 'Workspace':
      if (node.syncedAt) rows.push({ label: 'Last synced', value: fmtDateTime(node.syncedAt) });
      break;
    default:
      break;
  }
  return rows;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
      return true;
    } catch {
      return false;
    }
  }
}

const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%+=?';
export function generatePassword(length = 18) {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i += 1) out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  return out;
}

export const DOMAIN_STATUS_LABELS = {
  ownership_pending: ['Unverified', 'warn'],
  verified: ['Ownership verified', 'info'],
  dns_planned: ['DNS plan ready', 'info'],
  dns_manual_pending: ['Manual DNS pending', 'warn'],
  dns_applied: ['DNS applied', 'info'],
  dns_partial: ['DNS partially applied', 'bad'],
  active: ['Active', 'ok'],
  managed: ['Provider managed', 'info']
};

export const MAILBOX_STATUS_LABELS = {
  pending: ['Queued', 'info'],
  creating: ['Creating', 'info'],
  created: ['Created', 'ok'],
  uncertain: ['Uncertain — reconcile', 'warn'],
  failed: ['Failed', 'bad']
};

export const CHECK_STATUS_LABELS = {
  pass: ['pass', 'ok'],
  warn: ['warn', 'warn'],
  fail: ['fail', 'bad'],
  unknown: ['unknown', 'plain'],
  pending: ['pending', 'pending'],
  managed: ['managed', 'info']
};

export const RECORD_ACTION_LABELS = {
  create: ['create', 'ok'],
  update: ['replace', 'warn'],
  keep: ['keep', 'plain'],
  conflict: ['conflict — manual merge', 'bad'],
  pending_upstream: ['pending upstream', 'pending'],
  managed: ['managed', 'info']
};
