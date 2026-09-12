export const MAIL_SERVER_QUOTA_LIMITATION = 'New mailboxes have a 512 MB storage quota.';

const MAIL_SERVER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

// Fail closed: a successful response whose body does not parse into the known
// user-list shapes must never flatten into an empty list, or a collision check
// would silently pass and permit creation over an existing mailbox.
// Accepted shapes (verified against live MAIL_SERVER v76):
//   grouped: [{domain, users:[{email, privileges, box_quota, ...}]}, ...]
//   legacy flat: [{email, privileges, ...}, ...]
export function normalizeMailServerUsers(json) {
  if (!Array.isArray(json)) {
    return { ok: false, error: 'Mail server returned an unrecognized user list; it is treated as unavailable instead of empty so existing addresses are not hidden.' };
  }
  const users = [];
  for (const entry of json) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'Mail server user list contained an invalid entry; it is treated as unavailable instead of empty so existing addresses are not hidden.' };
    }
    users.push(...(Array.isArray(entry.users) ? entry.users : [entry]));
  }
  for (const u of users) {
    const email = u && typeof u === 'object' && !Array.isArray(u) && typeof u.email === 'string' ? u.email.trim() : null;
    if (!email || !MAIL_SERVER_EMAIL_PATTERN.test(email)) {
      return { ok: false, error: 'Mail server user list contained an entry without a valid email address; it is treated as unavailable instead of empty so existing addresses are not hidden.' };
    }
  }
  return { ok: true, users };
}

export function createMailServerClient({ config, logger, fetchImpl = fetch }) {
  const { baseUrl, username, password, timeoutMs } = config.mailserver;

  function configured() {
    return Boolean(baseUrl && username && password);
  }

  async function request(path, { method = 'GET', form = null, timeout = timeoutMs } = {}) {
    if (!configured()) return { ok: false, configured: false, error: 'Mail server admin API is not configured.' };
    const url = `${baseUrl}${path}`;
    const headers = {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      Accept: 'application/json'
    };
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    const started = Date.now();
    try {
      const res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeout), redirect: 'error' });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }
      logger?.info('mailserver request', { path, method, status: res.status, ms: Date.now() - started });
      return { ok: res.ok, status: res.status, json, text: res.ok ? undefined : text.slice(0, 500) };
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      logger?.warn('mailserver request failed', { path, method, timedOut, error: timedOut ? 'timeout' : String(err && err.message) });
      return { ok: false, timeout: timedOut, error: timedOut ? 'Mail server did not respond in time.' : 'Mail server request failed.' };
    }
  }

  async function listUsers() {
    const res = await request('/mail/users?format=json');
    if (!res.ok) return { ok: false, configured: res.configured !== false, timeout: res.timeout, error: res.error || `Mail server returned ${res.status}.`, users: [] };
    // A 200 with a malformed body must fail closed: flattening it to "no users"
    // would let a collision check pass against mailboxes that really exist.
    const normalized = normalizeMailServerUsers(res.json);
    if (!normalized.ok) {
      return { ok: false, configured: true, error: normalized.error, users: [] };
    }
    return {
      ok: true,
      users: normalized.users.map((u) => {
        // Verified MAIL_SERVER shape: box_quota is the quota in bytes; box_size, percent and
        // quota are the server's own display strings and are retained verbatim for display.
        const boxQuota = Number(u.box_quota);
        return {
          email: String(u.email || '').trim().toLowerCase(),
          privileges: Array.isArray(u.privileges) ? u.privileges : (u.privileges ? [u.privileges] : []),
          boxQuotaBytes: Number.isFinite(boxQuota) && boxQuota >= 0 ? boxQuota : null,
          boxSize: typeof u.box_size === 'string' ? u.box_size : null,
          percentText: typeof u.percent === 'string' ? u.percent : null,
          quotaText: typeof u.quota === 'string' ? u.quota : null,
          status: typeof u.status === 'string' ? u.status : null
        };
      })
    };
  }

  async function userExists(address) {
    const res = await listUsers();
    if (!res.ok) return res;
    const match = res.users.find((u) => u.email === String(address).toLowerCase());
    return { ok: true, exists: Boolean(match), user: match || null };
  }

  // privileges is always empty: app-created mailboxes never get admin rights.
  async function addUser({ email, password: mailboxPassword }) {
    const res = await request('/mail/users/add', {
      method: 'POST',
      form: { email, password: mailboxPassword, privileges: '', quota: '512M' }
    });
    if (res.configured === false) return { ok: false, configured: false, error: res.error };
    if (res.timeout) return { ok: false, timeout: true, error: res.error };
    if (!res.ok) return { ok: false, status: res.status, error: res.error || `Mail server rejected the request (${res.status}).` };
    return { ok: true, status: res.status };
  }

  async function getDnsDump() {
    const res = await request('/dns/dump?format=json');
    if (!res.ok) return { ok: false, supported: false, timeout: res.timeout, error: res.error || `Zone dump unavailable (${res.status}).` };
    return { ok: true, supported: true, data: res.json };
  }

  async function listZones() {
    const res = await request('/dns/zones?format=json');
    if (!res.ok) return { ok: false, supported: false, error: res.error || `Zone list unavailable (${res.status}).` };
    return { ok: true, supported: true, zones: Array.isArray(res.json) ? res.json : [] };
  }

  // MAIL_SERVER automatically generates domain DNS when its first mailbox is added.
  async function ensureZone(domain) {
    return { ok: true, pendingMailbox: true, note: 'Create the first mailbox after domain ownership verification to generate DKIM and DNS records.' };
  }

  return { configured, request, listUsers, userExists, addUser, getDnsDump, listZones, ensureZone, quotaLimitation: MAIL_SERVER_QUOTA_LIMITATION };
}
