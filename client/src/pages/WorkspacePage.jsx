import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Banner, Chip, EmptyState, SectionTitle, Spinner, StatusChip } from '../components/Bits.jsx';
import { fmtBytes, MAILBOX_STATUS_LABELS } from '../util.js';
import WorkspaceKnowledge from '../components/WorkspaceKnowledge.jsx';

const PORTALS = [
  {
    id: 'mail',
    name: 'Webmail',
    href: '/mail/',
    action: 'Open mail',
    blurb: 'Read and send from your mailbox in the browser.',
    note: 'Same server as your mailbox.'
  },
  {
    id: 'calendar',
    name: 'Calendar',
    href: '/cloud/index.php/apps/calendar/',
    action: 'Open calendar',
    blurb: 'Calendars and events for your account.',
    note: 'Uses your mailbox credentials.'
  },
  {
    id: 'files',
    name: 'Files',
    href: '/cloud/index.php/apps/files/',
    action: 'Open files',
    blurb: 'Documents and files in the cloud portal.',
    note: 'Files storage is separate; sync the workspace graph to see its usage here.'
  }
];

export default function WorkspacePage({ navigate }) {
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api('/workspace');
      setWorkspace(res.workspace);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const storage = workspace?.storage;
  const degraded = storage && (storage.status === 'unavailable' || storage.status === 'not_configured');

  return (
    <div className="page">
      <div className="topbar">
        <h1>Workspace</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      <Banner tone="info">
        These portals run on the same server as your mailbox. Sign in with your <strong>mailbox address and the
        mailbox password</strong> you set at creation — your Workspace app password will not work here, and this app
        never stores or displays your mailbox password.
      </Banner>

      <section className="card">
        <SectionTitle title="Your services" sub="Open the services available for your mailbox. Delivery is separate and still needs a real test." />
        <div className="grid grid-3">
          {PORTALS.map((p) => (
            <div className={`portal${p.id === 'mail' ? ' portal-primary' : ''}`} key={p.id}>
              <h3>{p.name}</h3>
              <p className="muted">{p.blurb}</p>
              <span className="faint">{p.note}</span>
              <a className="btn btn-sm" href={p.href} target="_blank" rel="noopener noreferrer">
                {p.action}
                <span aria-hidden="true">↗</span>
              </a>
            </div>
          ))}
        </div>
      </section>

      <WorkspaceKnowledge />
      <section className="card">
        <SectionTitle
          title="Mailbox storage"
          sub="Real usage measured by the mail server — shown only for mailboxes on your account."
        />

        {error && !storage ? <Banner tone="bad">{error}</Banner> : null}
        {error && storage ? <Banner tone="warn">Could not refresh: {error} Showing the previous reading.</Banner> : null}
        {loading && !storage && !error ? <Spinner label="Checking mailbox storage…" /> : null}

        {storage ? (
          storage.items.length === 0 ? (
            <EmptyState
              title="No mailbox yet"
              icon="✉"
              action={<button type="button" className="btn btn-primary" onClick={() => navigate('mailboxes')}>Create a mailbox</button>}
            >
              Storage usage appears here once your mailbox exists on the mail server.
            </EmptyState>
          ) : (
            <>
              {degraded ? <Banner tone="warn">{storage.message}</Banner> : null}
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Mailbox</th>
                      <th>Status</th>
                      <th>Storage used</th>
                      <th>Quota</th>
                    </tr>
                  </thead>
                  <tbody>
                    {storage.items.map((item) => (
                      <tr key={item.address}>
                        <td className="val">{item.address}</td>
                        <td>
                          <div className="stack">
                            <StatusChip map={MAILBOX_STATUS_LABELS} status={item.mailboxStatus} />
                            {item.available && item.upstreamStatus ? (
                              <span className="faint">mail server: {item.upstreamStatus}</span>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          {item.available ? (
                            <div className="stack">
                              <span className="val" title="Measured by the mail server">{item.used ?? '—'}</span>
                              {item.percent === null ? (
                                <div className="meter empty" role="img" aria-label="Usage percent not reported by the mail server" />
                              ) : (
                                <div className="meter" role="img" aria-label={`${item.percent}% of quota used`}>
                                  <span style={{ width: `${Math.min(100, Math.max(0, item.percent))}%` }} />
                                </div>
                              )}
                              <span className="faint">
                                {item.percent === null ? 'Percent not reported' : `${item.percent}% of quota used`}
                              </span>
                            </div>
                          ) : (
                            <div className="stack">
                              <Chip tone="warn">Unavailable</Chip>
                              <span className="faint">{item.message}</span>
                            </div>
                          )}
                        </td>
                        <td
                          className="val"
                          title={Number.isFinite(item.quotaBytes) ? `${item.quotaBytes.toLocaleString()} bytes` : undefined}
                        >
                          {item.available ? (item.quota || fmtBytes(item.quotaBytes) || '—') : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="faint">
                Figures are measured by the mail server and can lag slightly. When the mail server is unreachable,
                usage shows as unavailable rather than an estimate.
              </p>
            </>
          )
        ) : null}
      </section>
    </div>
  );
}
