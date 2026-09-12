// Standalone Chromium smoke checks against the isolated scratch app.
// Uses Playwright (dev dependency). If Playwright or its Chromium build is
// missing, every browser check is recorded as skipped — never passed.
//
// Checks run against the production build served by the real Express app
// (scratch.js) with fake providers, so they exercise exactly what ships.

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const FIXTURE_BROWSER_CHECKS = [
  { id: 'browser-signup', title: 'Browser: sign up via UI and land on Overview' },
  { id: 'browser-navigation', title: 'Browser: navigate all five views with correct headings and URLs' },
  { id: 'browser-add-domain-from-overview', title: 'Browser: Overview "Add a domain" opens the Domains wizard' },
  { id: 'browser-workspace', title: 'Browser: Workspace portals render with honest no-mailbox state' },
  { id: 'browser-unavailable-states', title: 'Browser: visible unavailable states (storage unavailable, graph degraded)' },
  { id: 'browser-desktop-overflow', title: 'Browser: no horizontal overflow at desktop width' },
  { id: 'browser-mobile-overflow', title: 'Browser: no horizontal overflow at mobile widths (390px, 320px)' },
  { id: 'browser-bottom-scroll-navigation', title: 'Browser: bottom-scroll to navigation on mobile resets scroll' }
];

function playwrightPackageVersion() {
  try {
    const pkgPath = require.resolve('playwright/package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return null;
  }
}

export async function launchChromium() {
  let pw;
  try {
    pw = await import('playwright');
  } catch {
    return {
      ok: false,
      reason: 'Playwright is not installed (dev dependency). Fix: npm install && npx playwright install chromium'
    };
  }
  try {
    const browser = await pw.chromium.launch({ headless: true });
    return { ok: true, browser, chromiumVersion: browser.version(), playwrightVersion: playwrightPackageVersion() };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/executable doesn't exist|playwright install|Failed to launch/i.test(msg)) {
      return {
        ok: false,
        reason: `Chromium is not installed for Playwright. Fix: npx playwright install chromium (first line: ${msg.split('\n')[0]})`
      };
    }
    return { ok: false, reason: `Could not launch Chromium: ${msg.split('\n')[0]}` };
  }
}

function watchPageErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err && err.message || err)));
  return {
    errors,
    assertNone(what) {
      if (errors.length === 0) return;
      throw new Error(`uncaught page error(s) during ${what}: ${errors.slice(0, 3).join(' | ')}`);
    }
  };
}

async function shot(page, outDir, name) {
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, fullPage: true });
  return name;
}

async function probeOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, innerWidth: window.innerWidth };
  });
}

const NAV_VIEWS = [
  { label: 'Overview', path: '/launch', heading: 'Overview' },
  { label: 'Domains', path: '/launch/domains', heading: 'Domains' },
  { label: 'Mailboxes', path: '/launch/mailboxes', heading: 'Mailboxes' },
  { label: 'Workspace', path: '/launch/workspace', heading: 'Workspace' },
  { label: 'Activity', path: '/launch/activity', heading: 'Activity' }
];

export async function runFixtureBrowserChecks({ registry, scratch, outDir, vault }) {
  const launch = await launchChromium();
  if (!launch.ok) {
    for (const def of FIXTURE_BROWSER_CHECKS) {
      registry.record({
        ...def, phase: 'browser', status: 'skipped', detail: launch.reason,
        startedAt: new Date().toISOString(), durationMs: 0, artifacts: [], conditional: false
      });
    }
    return { browserVersion: null, playwrightVersion: null };
  }

  const browser = launch.browser;
  const signupEmail = `harness-${Date.now()}@example.test`;
  const signupPassword = 'Harness-Fixture-123';
  const mailboxPassword = 'Mailbox-Fixture-123';
  vault.register(signupPassword);
  vault.register(mailboxPassword);

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(15_000);
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(20_000);
    const pageErrors = watchPageErrors(page);

    // --- 1. signup ---------------------------------------------------------
    await registry.run({ id: 'browser-signup', phase: 'browser', title: FIXTURE_BROWSER_CHECKS[0].title, timeoutMs: 90_000 }, async (ctx) => {
      await page.goto(scratch.base);
      await page.getByRole('tab', { name: 'Create account' }).click();
      await page.locator('#auth-email').fill(signupEmail);
      await page.locator('#auth-password').fill(signupPassword);
      await page.locator('form button[type="submit"]').click();
      await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
      if (!page.url().replace(/\/$/, '').endsWith('/launch')) {
        throw new Error(`expected to land on ${scratch.base}, got ${page.url()}`);
      }
      pageErrors.assertNone('signup');
      ctx.artifacts.push(await shot(page, outDir, '01-desktop-signup-overview.png'));
      return `signed up ${signupEmail} through the UI; landed on ${page.url()} with the Overview heading`;
    });

    // --- 2. navigation -----------------------------------------------------
    await registry.run({ id: 'browser-navigation', phase: 'browser', title: FIXTURE_BROWSER_CHECKS[1].title, timeoutMs: 90_000 }, async (ctx) => {
      const seen = [];
      for (const view of NAV_VIEWS) {
        await page.locator('.nav-item', { hasText: view.label }).click();
        await page.getByRole('heading', { name: view.heading, exact: true }).waitFor();
        const url = page.url();
        if (!url.replace(/\/$/, '').endsWith(view.path)) {
          throw new Error(`clicking "${view.label}" left URL at ${url}, expected ${view.path}`);
        }
        seen.push(`${view.label} -> ${view.path}`);
      }
      ctx.artifacts.push(await shot(page, outDir, '02-desktop-navigation-activity.png'));
      pageErrors.assertNone('navigation');
      return `navigated: ${seen.join('; ')}`;
    });

    // --- 3. Overview "Add a domain" opens the Domains wizard -----------------
    // Regression: openWizard must navigate to Domains before the wizard renders
    // (the wizard is only mounted by DomainsPage), so clicking the Overview
    // button has to move the URL to /launch/domains and open the dialog.
    await registry.run({ id: 'browser-add-domain-from-overview', phase: 'browser', title: FIXTURE_BROWSER_CHECKS[2].title, timeoutMs: 90_000 }, async (ctx) => {
      await page.locator('.nav-item', { hasText: 'Overview' }).click();
      await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Add a domain', exact: true }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      await dialog.getByRole('heading', { name: 'Add a domain', exact: true }).waitFor();
      const url = page.url();
      if (!url.replace(/\/$/, '').endsWith('/launch/domains')) {
        throw new Error(`"Add a domain" must navigate to /launch/domains before opening the wizard, got ${url}`);
      }
      ctx.artifacts.push(await shot(page, outDir, '08-desktop-add-domain-wizard.png'));
      await page.getByRole('button', { name: 'Close wizard' }).click();
      await dialog.waitFor({ state: 'detached' });
      pageErrors.assertNone('add a domain from overview');
      return 'Overview "Add a domain" navigated to /launch/domains and opened the wizard dialog; closed again without creating anything';
    });

    // --- 4. workspace (fresh account, honest empty state) -------------------
    await registry.run({ id: 'browser-workspace', phase: 'browser', title: FIXTURE_BROWSER_CHECKS[3].title, timeoutMs: 90_000 }, async (ctx) => {
      await page.locator('.nav-item', { hasText: 'Workspace' }).click();
      await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Your services' }).waitFor();
      for (const action of ['Open mail', 'Open calendar', 'Open files']) {
        await page.getByRole('link', { name: new RegExp(action) }).waitFor();
      }
      await page.getByRole('heading', { name: 'No mailbox yet' }).waitFor();
      ctx.artifacts.push(await shot(page, outDir, '03-desktop-workspace-no-mailbox.png'));
      pageErrors.assertNone('workspace');
      return 'Workspace shows Webmail/Calendar/Files portals and the honest "No mailbox yet" empty state';
    });

    // --- 5. visible unavailable states -------------------------------------
    await registry.run({ id: 'browser-unavailable-states', phase: 'browser', title: FIXTURE_BROWSER_CHECKS[4].title, timeoutMs: 120_000 }, async (ctx) => {
      // Create a real mailbox through the UI (fake MAIL_SERVER accepts it).
      await page.locator('.nav-item', { hasText: 'Mailboxes' }).click();
      await page.getByRole('heading', { name: 'Mailboxes', exact: true }).waitFor();
      await page.getByLabel('Mailbox name').fill('inbox');
      await page.getByLabel('Mailbox password').fill(mailboxPassword);
      await page.getByRole('button', { name: 'Create mailbox' }).click();
      await page.getByText('Mailbox created:').waitFor();

      // Fake upstream failure -> storage must show unavailable, never numbers.
      scratch.mailserverState.usersFail = true;
      try {
        await page.locator('.nav-item', { hasText: 'Workspace' }).click();
        await page.getByRole('heading', { name: 'Workspace', exact: true }).waitFor();
        // Scope to the warning banner: the same message also appears in a table
        // cell, and an unscoped getByText would be a strict-mode violation.
        await page.locator('.banner.warn', { hasText: 'Storage usage is unavailable right now' }).waitFor();
        await page.locator('.chip.warn', { hasText: 'Unavailable' }).first().waitFor();
        ctx.artifacts.push(await shot(page, outDir, '04-desktop-workspace-storage-unavailable.png'));
      } finally {
        scratch.mailserverState.usersFail = false;
      }

      // Neo4j unconfigured -> domain dependency graph must show degraded banner.
      await page.locator('.nav-item', { hasText: 'Domains' }).click();
      await page.getByRole('heading', { name: 'Domains', exact: true }).waitFor();
      await page.getByRole('button', { name: /Open →/ }).first().click();
      await page.getByRole('heading', { name: scratch.config.hostedDomain, exact: true }).waitFor();
      await page.getByText('graph view is degraded').waitFor();
      ctx.artifacts.push(await shot(page, outDir, '05-desktop-domain-graph-degraded.png'));
      pageErrors.assertNone('unavailable states');
      return 'mailbox created via UI; with fake MAIL_SERVER failing, Workspace shows "Storage usage is unavailable" + Unavailable chip; domain detail shows the Neo4j "graph view is degraded" banner';
    });

    // --- 6. desktop overflow ------------------------------------------------
    await registry.run({ id: 'browser-desktop-overflow', phase: 'browser', title: FIXTURE_BROWSER_CHECKS[5].title, timeoutMs: 90_000 }, async () => {
      const probes = [];
      for (const view of NAV_VIEWS.slice(0, 4)) { // overview, domains, mailboxes, workspace
        await page.locator('.nav-item', { hasText: view.label }).click();
        await page.getByRole('heading', { name: view.heading, exact: true }).waitFor();
        await page.waitForTimeout(150);
        const o = await probeOverflow(page);
        if (o.scrollWidth > o.clientWidth + 1) {
          throw new Error(`horizontal overflow on ${view.label}: scrollWidth ${o.scrollWidth} > clientWidth ${o.clientWidth}`);
        }
        probes.push(`${view.label}: ${o.scrollWidth}/${o.clientWidth}`);
      }
      pageErrors.assertNone('desktop overflow probe');
      return `document scrollWidth <= clientWidth on desktop 1280px (${probes.join('; ')})`;
    });

    // --- 7. mobile overflow --------------------------------------------------
    await registry.run({ id: 'browser-mobile-overflow', phase: 'browser', title: FIXTURE_BROWSER_CHECKS[6].title, timeoutMs: 120_000 }, async (ctx) => {
      // 390px is a common phone width; 320px guards the known delivery-summary
      // overflow class of bugs at the narrowest supported width (body min-width: 320px).
      // Domain detail is included at both widths: it carries the densest
      // tables/plan output of any view.
      const probes = [];
      const mobileViews = [
        { label: 'Overview', heading: 'Overview' },
        { label: 'Mailboxes', heading: 'Mailboxes' }
      ];
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        for (const view of mobileViews) {
          await page.locator('.nav-item', { hasText: view.label }).click();
          await page.getByRole('heading', { name: view.heading, exact: true }).waitFor();
          await page.waitForTimeout(150);
          const o = await probeOverflow(page);
          if (o.scrollWidth > o.clientWidth + 1) {
            throw new Error(`horizontal overflow at ${width}px on ${view.label}: scrollWidth ${o.scrollWidth} > clientWidth ${o.clientWidth}`);
          }
          probes.push(`${view.label}@${width}: ${o.scrollWidth}/${o.clientWidth}`);
        }
        await page.locator('.nav-item', { hasText: 'Domains' }).click();
        await page.getByRole('heading', { name: 'Domains', exact: true }).waitFor();
        await page.getByRole('button', { name: /Open →/ }).first().click();
        await page.getByRole('heading', { name: scratch.config.hostedDomain, exact: true }).waitFor();
        await page.waitForTimeout(150);
        const detail = await probeOverflow(page);
        if (detail.scrollWidth > detail.clientWidth + 1) {
          throw new Error(`horizontal overflow at ${width}px on domain detail: scrollWidth ${detail.scrollWidth} > clientWidth ${detail.clientWidth}`);
        }
        probes.push(`Domain detail@${width}: ${detail.scrollWidth}/${detail.clientWidth}`);
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      ctx.artifacts.push(await shot(page, outDir, '06-mobile-overview.png'));
      pageErrors.assertNone('mobile overflow probe');
      return `document scrollWidth <= clientWidth (${probes.join('; ')})`;
    });

    // --- 8. mobile bottom-scroll -> navigation -------------------------------
    await registry.run({ id: 'browser-bottom-scroll-navigation', phase: 'browser', title: FIXTURE_BROWSER_CHECKS[7].title, timeoutMs: 90_000 }, async (ctx) => {
      // Start from Overview at mobile width, scroll to the bottom, then trigger
      // the Mailboxes nav item with a DOM-level click. A Playwright .click() would
      // auto-scroll the nav into view BEFORE clicking and mask whether the app's
      // route-change scroll reset actually ran.
      await page.locator('.nav-item', { hasText: 'Overview' }).click();
      await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(200);
      const bottomY = await page.evaluate(() => window.scrollY);
      if (bottomY <= 0) {
        throw new Error('page did not scroll at mobile viewport (expected scrollable Overview content to test bottom-scroll navigation)');
      }
      await page.evaluate(() => {
        const item = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('Mailboxes'));
        if (!item) throw new Error('Mailboxes nav item not found');
        item.click();
      });
      await page.getByRole('heading', { name: 'Mailboxes', exact: true }).waitFor();
      const url = page.url();
      if (!url.replace(/\/$/, '').endsWith('/launch/mailboxes')) {
        throw new Error(`navigation from page bottom went to ${url}, expected /launch/mailboxes`);
      }
      await page.waitForTimeout(150);
      const topY = await page.evaluate(() => window.scrollY);
      if (topY !== 0) {
        throw new Error(`scroll was not reset to top after navigation (scrollY=${topY})`);
      }
      ctx.artifacts.push(await shot(page, outDir, '07-mobile-after-bottom-scroll-navigation.png'));
      pageErrors.assertNone('bottom-scroll navigation');
      return `scrolled to bottom of Overview (scrollY=${bottomY}px), DOM nav click reached /launch/mailboxes and scroll reset to 0`;
    });

    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }

  return { browserVersion: launch.chromiumVersion, playwrightVersion: launch.playwrightVersion };
}
