import { BRAND_NAME } from './brand.js';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api.js';
import { Wordmark, Spinner } from './components/Bits.jsx';
import AuthPage from './pages/AuthPage.jsx';
import OverviewPage from './pages/OverviewPage.jsx';
import DomainsPage from './pages/DomainsPage.jsx';
import DomainDetailPage from './pages/DomainDetailPage.jsx';
import MailboxesPage from './pages/MailboxesPage.jsx';
import WorkspacePage from './pages/WorkspacePage.jsx';
import ActivityPage from './pages/ActivityPage.jsx';

const BASE = import.meta.env.BASE_URL;

function parseRoute(pathname) {
  const rel = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\//, '');
  const segs = rel.split('/').filter(Boolean);
  if (segs[0] === 'domains' && segs[1]) return { view: 'domain', id: decodeURIComponent(segs[1]) };
  if (segs[0] === 'domains') return { view: 'domains' };
  if (segs[0] === 'mailboxes') return { view: 'mailboxes' };
  if (segs[0] === 'workspace') return { view: 'workspace' };
  if (segs[0] === 'activity') return { view: 'activity' };
  return { view: 'overview' };
}

function NavIcon({ name }) {
  const common = { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (name === 'overview') return <svg {...common}><rect x="3" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" /></svg>;
  if (name === 'domains') return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.6 2.6 3.9 5.7 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.7-3.9-9S9.4 5.6 12 3z" /></svg>;
  if (name === 'mailboxes') return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2.4" /><path d="m3.6 6.6 8.4 6 8.4-6" /></svg>;
  if (name === 'workspace') return <svg {...common}><circle cx="7.5" cy="7.5" r="3.2" /><circle cx="16.5" cy="7.5" r="3.2" /><circle cx="7.5" cy="16.5" r="3.2" /><circle cx="16.5" cy="16.5" r="3.2" /></svg>;
  if (name === 'activity') return <svg {...common}><path d="M4 12h4l2-5 3.5 10 2-5H20" /></svg>;
  return null;
}

function pendingCount(domains, mailboxes) {
  const domainPending = (domains || []).filter((d) =>
    ['ownership_pending', 'verified', 'dns_planned', 'dns_manual_pending', 'dns_partial'].includes(d.status)).length;
  const mailboxPending = (mailboxes || []).filter((m) => m.status === 'uncertain').length;
  return domainPending + mailboxPending;
}

export default function App() {
  const [user, setUser] = useState(undefined);
  const [route, setRoute] = useState(parseRoute(window.location.pathname));
  const [data, setData] = useState({ domains: [], mailboxes: [], meta: null });
  const [bootError, setBootError] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const navigate = useCallback((view, id) => {
    const path = view === 'domain' ? `domains/${encodeURIComponent(id)}`
      : view === 'overview' ? ''
      : view;
    window.history.pushState({}, '', `${BASE}${path}`);
    setRoute(view === 'domain' ? { view, id } : { view });
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [domains, mailboxes, meta] = await Promise.all([
        api('/domains'),
        api('/mailboxes'),
        api('/meta')
      ]);
      setData({ domains: domains.domains || [], mailboxes: mailboxes.mailboxes || [], meta });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      } else {
        setBootError(err.message || 'Failed to load data.');
      }
    }
  }, []);

  const checkSession = useCallback(async () => {
    try {
      const me = await api('/auth/me');
      setUser(me.user);
      return me.user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        return null;
      }
      setBootError(err.message || 'Could not reach the server.');
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    checkSession().then((u) => {
      if (u) loadData();
    });
  }, [checkSession, loadData]);

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  useEffect(() => {
    document.title = 'Workspace · Set up your business email';
    document.querySelector('meta[name="description"]')?.setAttribute(
      'content',
      'Workspace — set up business email for your domain, with delivery verified separately.'
    );
  }, []);

  useLayoutEffect(() => {
    // Keep route changes on the document scroll owner, including mobile browsers
    // that expose body.scrollTop separately from window.scrollY.
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [route.view, route.id]);

  const onAuthed = useCallback(async (authedUser) => {
    setUser(authedUser);
    await loadData();
    navigate('overview');
  }, [loadData, navigate]);

  const onLogout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } catch {
      // session is dropped server-side regardless; continue to signed-out state
    }
    setUser(null);
    setData({ domains: [], mailboxes: [], meta: null });
  }, []);

  const counts = useMemo(() => ({
    domains: data.domains.length,
    mailboxes: data.mailboxes.length,
    pending: pendingCount(data.domains, data.mailboxes)
  }), [data]);

  if (user === undefined) {
    return (
      <div className="auth-shell">
        <Spinner label={`Loading ${BRAND_NAME}…`} />
      </div>
    );
  }

  if (user === null) {
    return <AuthPage onAuthed={onAuthed} bootError={bootError} />;
  }

  const nav = [
    { view: 'overview', label: 'Overview' },
    { view: 'domains', label: 'Domains', badge: counts.domains || null, alert: counts.pending > 0 },
    { view: 'mailboxes', label: 'Mailboxes', badge: counts.mailboxes || null },
    { view: 'workspace', label: 'Workspace' },
    { view: 'activity', label: 'Activity' }
  ];

  const pageProps = { data, reload: loadData, navigate, openWizard: () => {
    setWizardOpen(true);
    navigate('domains');
  }, user };

  return (
    <div className="shell">
      <aside className="sidebar">
        <Wordmark />
        <nav className="nav" aria-label="Main">
          {nav.map((item) => (
            <button
              key={item.view}
              type="button"
              className="nav-item"
              aria-current={route.view === item.view || (item.view === 'domains' && route.view === 'domain') ? 'page' : undefined}
              onClick={() => navigate(item.view)}
            >
              <NavIcon name={item.view} />
              <span>{item.label}</span>
              {item.badge ? <span className="nav-badge" aria-label={`${item.badge} items`}>{item.badge}</span> : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-user" title={user.email}>{user.email}</div>
          <button type="button" className="btn btn-sm" onClick={onLogout}>Sign out</button>
        </div>
      </aside>

      <main className="main">
        {route.view === 'overview' ? <OverviewPage {...pageProps} /> : null}
        {route.view === 'domains' ? (
          <DomainsPage {...pageProps} wizardOpen={wizardOpen} setWizardOpen={setWizardOpen} />
        ) : null}
        {route.view === 'domain' ? <DomainDetailPage key={route.id} {...pageProps} domainId={route.id} /> : null}
        {route.view === 'mailboxes' ? <MailboxesPage {...pageProps} /> : null}
        {route.view === 'workspace' ? <WorkspacePage {...pageProps} /> : null}
        {route.view === 'activity' ? <ActivityPage {...pageProps} /> : null}
      </main>
    </div>
  );
}
