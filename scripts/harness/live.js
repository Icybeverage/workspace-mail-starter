// OPTIONAL live read-only verification against the real deployment.
//
// Never runs automatically: only when the operator passes `--live <url>`.
//
//   Default (no credentials):  public checks only — GET /launch/health via
//     fetch, and the login page rendered in Chromium (DOM assertion; the SPA
//     HTML alone contains no form markers because React renders client-side).
//
//   With WORKSPACE_TEST_EMAIL and WORKSPACE_TEST_PASSWORD both supplied in the
//     environment: additionally signs in through the real UI and READS that
//     account's Overview, Mailboxes, Workspace and domain Graph views.
//
// Hard safety rules:
//   - Credentials come only from the environment (captured before the harness
//     scrubs process.env) — never CLI arguments, never logged, and registered
//     with the sanitizer vault so they cannot appear in any report.
//   - The live target is validated twice (CLI parse and inside runLiveChecks):
//     HTTPS required, URL userinfo rejected, non-default ports rejected, the
//     path must be exactly /launch, and credentialed checks additionally
//     require the exact host mail.example.test.
//   - A network request guard is installed on the browser context BEFORE any
//     navigation or credential entry: exact-origin + read-only-GET path
//     allowlist, the login POST as the single permitted write, everything
//     else (off-origin redirects, other hosts, mailbox creation, DNS/plan
//     writes, the state-persisting inspect endpoint, logout) is aborted.
//   - If sign-in fails, dependent checks are skipped and no screenshots are
//     taken; screenshots exist only after a successful login.
//   - Strictly read-only once signed in. No mailbox creation, no mail sends,
//     no DNS changes, no inspection endpoint (it persists check state), no
//     calendar/file writes, no deploy.
//   - All live evidence is labeled phase "live" so it can never be confused
//     with fixture/offline evidence.

import { launchChromium } from './browser.js';
import { SkipSignal } from './checks.js';

export const LIVE_EXPECTED_HOST = process.env.LIVE_ALLOWED_HOST || 'mail.example.test';
export const LIVE_EXPECTED_PATH = '/launch';

export const LIVE_CHECK_DEFS = [
  { id: 'live-target', title: 'Live: target URL passes origin/path validation' },
  { id: 'live-health', title: 'Live: public /launch/health responds ok' },
  { id: 'live-login-page', title: 'Live: login page renders the auth form (DOM)' },
  { id: 'live-signin', title: 'Live: sign in with supplied test credentials' },
  { id: 'live-authed-overview', title: 'Live: read account Overview (post-login screenshot)' },
  { id: 'live-authed-mailboxes', title: 'Live: read account Mailboxes (post-login screenshot)' },
  { id: 'live-authed-workspace', title: 'Live: read account Workspace (post-login screenshot)' },
  { id: 'live-authed-graph', title: 'Live: read account domain graph (post-login screenshot)' }
];

const AUTHED_CHECK_IDS = ['live-authed-overview', 'live-authed-mailboxes', 'live-authed-workspace', 'live-authed-graph'];

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

// Validate the --live target. HTTPS is required for everything; the path must
// be exactly /launch (the app's mount point); URL userinfo, non-default
// ports, query strings and fragments are all rejected. The exact expected
// host is required once credentialed checks are possible.
export function validateLiveTarget(rawUrl, { credentialsPresent = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    return { ok: false, error: `not a valid URL: ${rawUrl}` };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'live mode requires an https:// URL (plain HTTP is refused)' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'live target must not contain URL userinfo (user:pass@host)' };
  }
  if (parsed.port !== '') {
    return { ok: false, error: `live target must use the default HTTPS port, got :${parsed.port}` };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: 'live target must be a bare origin+path URL (no query string or fragment)' };
  }
  // Exact path match only: "/launch" or "/launch/" — no double slashes,
  // no sub-paths, no lookalikes. Operator typos should fail loudly.
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path !== LIVE_EXPECTED_PATH || (parsed.pathname !== LIVE_EXPECTED_PATH && parsed.pathname !== `${LIVE_EXPECTED_PATH}/`)) {
    return { ok: false, error: `live target path must be ${LIVE_EXPECTED_PATH} (optionally with a single trailing slash), got ${parsed.pathname || '/'}` };
  }
  if (credentialsPresent && parsed.hostname !== LIVE_EXPECTED_HOST) {
    return {
      ok: false,
      error: `credentialed live checks are only allowed on ${LIVE_EXPECTED_HOST}, got ${parsed.hostname}`
    };
  }
  return { ok: true, origin: parsed.origin, path: LIVE_EXPECTED_PATH, host: parsed.hostname };
}

// ---------------------------------------------------------------------------
// Request guard: exact-origin + read-only allowlist
// ---------------------------------------------------------------------------

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Read-only GET endpoints the SPA legitimately needs. The state-persisting
// inspect endpoint, every write route (mailboxes, domains plan/verify/apply,
// agent, workspace) and all other hosts are deliberately absent.
export function allowedApiGetPatterns(basePath = LIVE_EXPECTED_PATH) {
  const b = escapeRe(basePath);
  return [
    new RegExp(`^${b}/api/auth/me$`),
    new RegExp(`^${b}/api/meta$`),
    new RegExp(`^${b}/api/domains$`),
    new RegExp(`^${b}/api/domains/[^/]+$`),
    new RegExp(`^${b}/api/domains/[^/]+/graph$`),
    new RegExp(`^${b}/api/domains/[^/]+/relay$`),
    new RegExp(`^${b}/api/mailboxes$`),
    new RegExp(`^${b}/api/workspace$`),
    new RegExp(`^${b}/api/workspace/knowledge$`),
    new RegExp(`^${b}/api/activity$`)
  ];
}

// Pure decision function (unit-tested without a browser): allow only
//   - GET/HEAD to the exact origin for: the app root, /launch/health,
//     built assets, and the read-only API allowlist above
//   - POST to the exact origin at /launch/api/auth/login, and only when
//     allowLoginPost is true (credentialed phase)
// Everything else — off-origin, other methods, non-allowlisted paths —
// is blocked, which also stops redirect hops to any other host.
export function decideLiveRequest({ method, url, target, allowLoginPost = false }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, reason: 'unparseable request URL' };
  }
  if (u.origin !== target.origin) {
    return { allow: false, reason: `off-origin request to ${u.origin} (only ${target.origin} is allowed)` };
  }
  const m = String(method || 'GET').toUpperCase();
  const p = u.pathname;
  const base = target.path;
  if (m === 'GET' || m === 'HEAD') {
    const staticAllowed = p === base || p === `${base}/` || p === `${base}/health` || p.startsWith(`${base}/assets/`);
    const apiAllowed = allowedApiGetPatterns(base).some((re) => re.test(p));
    if (staticAllowed || apiAllowed) return { allow: true };
    return { allow: false, reason: `non-allowlisted read ${m} ${p}` };
  }
  if (allowLoginPost && m === 'POST' && p === `${base}/api/auth/login`) {
    return { allow: true };
  }
  return { allow: false, reason: `blocked ${m} ${p} (live mode is read-only; only the login POST is permitted)` };
}

// Install the guard on a Playwright context. Must run BEFORE page.goto so no
// request — including redirect hops — can leave the allowlist before
// credentials are entered.
export function installLiveGuard(context, target, { allowLoginPost = false, onBlock = null } = {}) {
  const blocked = [];
  const ready = context.route('**/*', async (route) => {
    const decision = decideLiveRequest({
      method: route.request().method(),
      url: route.request().url(),
      target,
      allowLoginPost
    });
    if (decision.allow) {
      // route.continue() follows redirects without routing the subsequent
      // request again. A 307 from login could therefore forward its POST body
      // outside the allowed origin. Fetch a single hop and refuse redirects.
      try {
        const response = await route.fetch({ maxRedirects: 0, timeout: 20_000 });
        if (response.status() >= 300 && response.status() < 400) {
          const reason = 'redirect blocked by live read-only guard';
          blocked.push(reason);
          if (onBlock) onBlock(reason);
          await response.dispose();
          return route.abort();
        }
        await route.fulfill({ response });
        await response.dispose();
        return;
      } catch {
        return route.abort();
      }
    }
    blocked.push(decision.reason);
    if (onBlock) onBlock(decision.reason);
    return route.abort();
  });
  return { blocked, ready };
}

// ---------------------------------------------------------------------------
// Live check execution
// ---------------------------------------------------------------------------

function recordSkipped(registry, def, detail, conditional) {
  registry.record({
    ...def, phase: 'live', status: 'skipped', detail, conditional,
    startedAt: new Date().toISOString(), durationMs: 0, artifacts: []
  });
}

async function gotoView(page, navLabel, heading, target) {
  await page.locator('.nav-item', { hasText: navLabel }).click();
  await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  const url = page.url();
  if (!url.startsWith(target.origin)) {
    throw new Error(`unexpected navigation off target: ${url}`);
  }
  await page.waitForTimeout(400); // let view data settle before screenshot
  return url;
}

// rawUrl is re-validated here — never trust only the CLI-layer check.
export async function runLiveChecks({ registry, rawUrl, outDir, vault, creds = null }) {
  const credentialed = Boolean(creds);
  if (creds) {
    vault.register(creds.password);
    vault.register(creds.email);
  }

  // -- target validation (runs as a check; failure skips the phase) --------
  let target = null;
  await registry.run({ id: 'live-target', phase: 'live', title: LIVE_CHECK_DEFS[0].title, timeoutMs: 10_000, conditional: false }, async () => {
    const v = validateLiveTarget(rawUrl, { credentialsPresent: credentialed });
    if (!v.ok) throw new Error(v.error);
    target = v;
    return `https target ${v.origin}${v.path} accepted${credentialed ? ` (credentialed mode; host pinned to ${LIVE_EXPECTED_HOST})` : ' (public checks only)'}`;
  });

  const targetCheck = registry.checks.find((c) => c.id === 'live-target');
  if (!targetCheck || targetCheck.status !== 'passed') {
    for (const def of LIVE_CHECK_DEFS.slice(1)) {
      recordSkipped(registry, def, 'live target failed validation; no live request was made', false);
    }
    return { credentialed: false, target: null };
  }

  // -- public checks (fetch for health; Chromium DOM for the login page) ---
  await registry.run({ id: 'live-health', phase: 'live', title: LIVE_CHECK_DEFS[1].title, conditional: false, timeoutMs: 30_000 }, async () => {
    const res = await fetch(`${target.origin}${target.path}/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000)
    });
    if (res.status !== 200) throw new Error(`GET ${target.path}/health returned HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true || body.status !== 'ok') {
      throw new Error(`health payload is not ok: ${body ? JSON.stringify({ ok: body.ok, status: body.status }) : 'not JSON'}`);
    }
    return `GET ${target.path}/health -> ok; service ${body.service}, version ${body.version ?? 'unknown'}, sqlite ok`;
  });

  // -- credentialed checks are REQUIRED once credentials are supplied ------
  const credConditional = !credentialed;
  const publicBrowser = await launchChromium();
  if (!publicBrowser.ok) {
    recordSkipped(registry, LIVE_CHECK_DEFS[2], publicBrowser.reason, credConditional);
  } else {
    const pubBrowser = publicBrowser.browser;
    try {
      // Public context: login POST is NOT allowed — nothing may be written
      // even if a page bug tried. No screenshots in this context.
      const pubContext = await pubBrowser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
      pubContext.setDefaultTimeout(20_000);
      const guard = installLiveGuard(pubContext, target, { allowLoginPost: false });
      await guard.ready;
      const page = await pubContext.newPage();
      page.setDefaultNavigationTimeout(30_000);
      await registry.run({ id: 'live-login-page', phase: 'live', title: LIVE_CHECK_DEFS[2].title, conditional: credConditional, timeoutMs: 90_000 }, async () => {
        await page.goto(`${target.origin}${target.path}/`);
        // DOM assertion: the SPA shell HTML has no form markers — React must
        // render them — so "the login page works" means the auth form is in
        // the live DOM. No screenshot: screenshots require a successful login.
        await page.locator('#auth-email').waitFor({ state: 'visible' });
        await page.getByRole('tab', { name: 'Sign in', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
        if (guard.blocked.length > 0) {
          throw new Error(`request guard blocked unexpected requests on the public login page: ${guard.blocked.slice(0, 3).join(' | ')}`);
        }
        return 'login page rendered the auth form in Chromium (email field, Sign-in tab and submit button present); no writes were possible';
      });
      await pubContext.close();
    } finally {
      await pubBrowser.close().catch(() => {});
    }
  }

  // -- credentialed phase ----------------------------------------------------
  if (!credentialed) {
    for (const def of LIVE_CHECK_DEFS.slice(3)) {
      recordSkipped(registry, def, 'WORKSPACE_TEST_EMAIL and WORKSPACE_TEST_PASSWORD were not both supplied in the environment', true);
    }
    return { credentialed: false, target };
  }

  const launch = await launchChromium();
  if (!launch.ok) {
    // Credentials were explicitly provided: verification is incomplete, not
    // quietly green. Non-conditional skips => nonzero exit.
    for (const def of LIVE_CHECK_DEFS.slice(3)) {
      recordSkipped(registry, def, launch.reason, false);
    }
    return { credentialed: true, target };
  }

  const browser = launch.browser;
  let guardBlocked = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    context.setDefaultTimeout(20_000);
    // Guard installed BEFORE any navigation: only read-only GETs plus the
    // single login POST can leave this context, for the exact origin only.
    const guard = installLiveGuard(context, target, { allowLoginPost: true });
    await guard.ready;
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(30_000);

    const signinCheck = await registry.run({ id: 'live-signin', phase: 'live', title: LIVE_CHECK_DEFS[3].title, conditional: false, timeoutMs: 90_000 }, async () => {
      await page.goto(`${target.origin}${target.path}/`);
      await page.locator('#auth-email').fill(creds.email);
      await page.locator('#auth-password').fill(creds.password);
      const loginResponse = page.waitForResponse((response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === `${target.path}/api/auth/login`);
      await page.locator('form button[type="submit"]').click();
      const response = await loginResponse;
      if (response.status() !== 200) {
        throw new Error(`Login returned HTTP ${response.status()}${response.status() === 429 ? '; rate limit reached, wait for Retry-After before another login attempt' : ''}`);
      }
      await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
      // No screenshot here: the first screenshot is taken by the first
      // authed check, only after login has succeeded.
      return 'signed in with the supplied test credentials and reached the Overview view';
    });

    // Auth failure (or an unexpected browser error) => skip dependent checks,
    // take no screenshots of the account, and leave exit code nonzero.
    if (signinCheck.status !== 'passed') {
      for (const id of AUTHED_CHECK_IDS) {
        const def = LIVE_CHECK_DEFS.find((d) => d.id === id);
        recordSkipped(registry, def, 'sign-in did not succeed; dependent read-only checks are skipped and no screenshots were taken', false);
      }
      await context.close();
      return { credentialed: true, target, signin: 'failed' };
    }

    // Everything below only runs after a successful login, so screenshots
    // are taken exclusively in an authenticated, read-only session.
    await registry.run({ id: 'live-authed-overview', phase: 'live', title: LIVE_CHECK_DEFS[4].title, conditional: false, timeoutMs: 60_000 }, async (ctx) => {
      await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${outDir}/live-01-overview.png`, fullPage: true });
      ctx.artifacts.push('live-01-overview.png');
      return 'Overview rendered for the signed-in account';
    });

    await registry.run({ id: 'live-authed-mailboxes', phase: 'live', title: LIVE_CHECK_DEFS[5].title, conditional: false, timeoutMs: 60_000 }, async (ctx) => {
      const url = await gotoView(page, 'Mailboxes', 'Mailboxes', target);
      await page.screenshot({ path: `${outDir}/live-02-mailboxes.png`, fullPage: true });
      ctx.artifacts.push('live-02-mailboxes.png');
      return `Mailboxes rendered (${url}) — read-only, nothing created`;
    });

    await registry.run({ id: 'live-authed-workspace', phase: 'live', title: LIVE_CHECK_DEFS[6].title, conditional: false, timeoutMs: 60_000 }, async (ctx) => {
      const url = await gotoView(page, 'Workspace', 'Workspace', target);
      await page.getByRole('heading', { name: 'Your services' }).waitFor();
      await page.screenshot({ path: `${outDir}/live-03-workspace.png`, fullPage: true });
      ctx.artifacts.push('live-03-workspace.png');
      return `Workspace rendered (${url}) — read-only, no portals opened`;
    });

    await registry.run({ id: 'live-authed-graph', phase: 'live', title: LIVE_CHECK_DEFS[7].title, conditional: false, timeoutMs: 90_000 }, async (ctx) => {
      await page.locator('.nav-item', { hasText: 'Domains' }).click();
      await page.getByRole('heading', { name: 'Domains', exact: true }).waitFor();
      const openButton = page.getByRole('button', { name: /Open →/ }).first();
      if (await openButton.count() === 0) {
        throw new SkipSignal('account has no domain that can be opened for the graph view');
      }
      await openButton.click();
      await page.getByRole('heading', { name: 'Dependency graph', exact: true }).waitFor();
      await page.waitForTimeout(600); // let the graph request settle (either render or degraded banner)
      const url = page.url();
      if (!url.startsWith(target.origin)) throw new Error(`unexpected navigation off target: ${url}`);
      await page.screenshot({ path: `${outDir}/live-04-domain-graph.png`, fullPage: true });
      ctx.artifacts.push('live-04-domain-graph.png');
      return 'domain dependency graph view loaded (rendered or honestly degraded)';
    });

    if (guard.blocked.length > 0) {
      // Not a check failure by itself, but surfaced honestly in the report:
      // the page requested something outside the read-only allowlist and the
      // guard refused it. Recorded via the return value, never by mutating an
      // already-recorded check.
      guardBlocked = guard.blocked.slice(0, 20);
    }

    // No logout POST: live mode stays read-only after sign-in; closing the
    // context discards the session cookies locally.
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }

  return { credentialed: true, target, guardBlocked };
}
