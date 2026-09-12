import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Chip, EmptyState, SectionTitle } from '../components/Bits.jsx';
import Timeline from '../components/Timeline.jsx';

export default function OverviewPage({ data, navigate, openWizard }) {
  const [activity, setActivity] = useState(null);

  useEffect(() => {
    let alive = true;
    api('/activity?limit=8').then((r) => { if (alive) setActivity(r.items); }).catch(() => { if (alive) setActivity([]); });
    return () => { alive = false; };
  }, [data]);

  const domains = data.domains || [];
  const mailboxes = data.mailboxes || [];
  const custom = domains.filter((d) => d.kind === 'custom');
  const hosted = domains.find((d) => d.kind === 'hosted');
  const customVerified = custom.some((d) => d.verifiedAt);
  const mailboxCreated = mailboxes.some((m) => m.status === 'created' || m.status === 'uncertain');
  const customActive = custom.some((d) => d.status === 'active');
  const uncertain = mailboxes.filter((m) => m.status === 'uncertain');
  const needsWork = domains.filter((d) => ['ownership_pending', 'verified', 'dns_planned', 'dns_manual_pending', 'dns_partial'].includes(d.status));
  const emptyAccount = domains.length === 0 && mailboxes.length === 0;

  const checklist = [
    { id: 'account', label: 'Create your app account', state: 'done', detail: 'Separate from mailbox credentials.' },
    { id: 'domain', label: 'Add a domain', state: domains.length > 0 ? 'done' : 'pending', detail: `Use the shared ${hosted?.name || 'hosted'} domain or bring your own.`, action: openWizard ? 'Add domain' : null },
    {
      id: 'verify',
      label: 'Verify custom-domain ownership',
      state: customVerified ? 'done' : 'pending',
      detail: custom.length > 0 ? 'Publish a unique TXT record or use a zone-scoped Cloudflare token.' : 'Optional — the shared hosted domain does not require ownership verification.',
      action: customVerified || !openWizard ? null : 'Verify domain'
    },
    { id: 'mailbox', label: 'Create your first mailbox', state: mailboxCreated ? 'done' : 'pending', detail: 'Choose an address and a password for your inbox.', action: mailboxCreated ? null : 'Go to mailboxes' },
    {
      id: 'dns',
      label: 'Review DNS & activate a custom domain',
      state: customActive ? 'done' : hosted && custom.length === 0 ? 'managed' : 'pending',
      detail: hosted && custom.length === 0
        ? 'DNS is managed by the provider for your shared hosted domain.'
        : 'Preview the changes, approve MX updates, then run checks.',
      action: customActive || (hosted && custom.length === 0) ? null : 'Review domain'
    }
  ];

  return (
    <div className="page">
      <div className="topbar">
        <h1>Overview</h1>
      </div>

      <section className="hero">
        <h1 style={{ fontSize: 30 }}>{mailboxCreated ? 'Your workspace is ready to open.' : 'Set up your business email.'}</h1>
        <p className="lede">
          {mailboxCreated
            ? 'Open your inbox or Workspace, then confirm delivery with a real test message.'
            : 'Start with a hosted mailbox or connect a domain you own. Workspace shows each step before any DNS change.'}
        </p>
        <div className="hero-actions">
          {mailboxCreated ? (
            <>
              <a className="btn btn-primary" href="/mail/" target="_blank" rel="noopener noreferrer">Open inbox <span aria-hidden="true">↗</span></a>
              <button type="button" className="btn" onClick={() => navigate('workspace')}>Open Workspace</button>
              <button type="button" className="btn btn-ghost" onClick={() => navigate('mailboxes')}>Manage mailbox</button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-primary" onClick={openWizard}>Add a domain</button>
              <button type="button" className="btn" onClick={() => navigate('mailboxes')}>Create a mailbox</button>
              <button type="button" className="btn btn-ghost" onClick={() => navigate('activity')}>View activity</button>
            </>
          )}
        </div>
        <p className="faint">
          Delivery is checked separately: inbound and outbound remain unverified until a real test message round-trips.
        </p>
      </section>

      <section className="grid grid-3">
        <div className="card stat">
          <span className="num">{domains.length}</span>
          <span className="label">Domains</span>
          <span className="faint">{custom.length} custom · {hosted ? 'shared hosted included' : 'no hosted domain'}</span>
        </div>
        <div className="card stat">
          <span className="num">{mailboxes.length}</span>
          <span className="label">Mailboxes</span>
          <span className="faint">{mailboxes.filter((m) => m.status === 'created').length} confirmed on the mail server</span>
        </div>
        <div className="card stat">
          <span className="num">{needsWork.length + uncertain.length}</span>
          <span className="label">Pending steps</span>
          <span className="faint">{needsWork.length} domain step(s), {uncertain.length} mailbox reconciliation(s)</span>
        </div>
      </section>

      <section className="card">
        <div className="row spread">
          <div>
            <h3>Workspace</h3>
            <p className="muted">
              {mailboxCreated
                ? 'Open mail, calendar and files with your mailbox credentials — your Workspace app password will not work on these portals.'
                : 'Create a mailbox first, then open mail, calendar and files with your mailbox credentials.'}
            </p>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => navigate('workspace')}>View workspace</button>
        </div>
        <div className="row">
          <a className="btn btn-sm" href="/mail/" target="_blank" rel="noopener noreferrer">Mail <span aria-hidden="true">↗</span></a>
          <a className="btn btn-sm" href="/cloud/index.php/apps/calendar/" target="_blank" rel="noopener noreferrer">Calendar <span aria-hidden="true">↗</span></a>
          <a className="btn btn-sm" href="/cloud/index.php/apps/files/" target="_blank" rel="noopener noreferrer">Files <span aria-hidden="true">↗</span></a>
          <span className="faint">Mailbox storage usage is on the Workspace page; Files storage is separate.</span>
        </div>
      </section>

      {uncertain.length > 0 ? (
        <section className="card">
          <div className="row spread">
            <div>
              <h3>Mailbox status needs reconciliation</h3>
              <p className="muted">
                {uncertain.map((m) => m.address).join(', ')} — the mail server did not confirm in time. Reconcile before retrying;
                existing mailboxes are never reset.
              </p>
            </div>
            <button type="button" className="btn" onClick={() => navigate('mailboxes')}>Review mailboxes</button>
          </div>
        </section>
      ) : null}

      <section className="grid grid-2">
        <div className="card">
          <SectionTitle title="Setup checklist" sub="Your progress from signup to a working inbox." />
          <ul className="list-plain">
            {checklist.map((item) => (
              <li key={item.id} className="row spread checklist-item">
                <div className="row-tight checklist-content">
                  <Chip tone={item.state === 'done' ? 'ok' : item.state === 'managed' ? 'info' : 'pending'}>
                    {item.state === 'done' ? 'done' : item.state === 'managed' ? 'managed' : 'to do'}
                  </Chip>
                  <div>
                    <div>{item.label}</div>
                    <div className="faint">{item.detail}</div>
                  </div>
                </div>
                {item.state !== 'done' && item.state !== 'managed' && item.action ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      if (item.id === 'mailbox') navigate('mailboxes');
                      else if (item.id === 'dns') navigate('domains');
                      else openWizard();
                    }}
                  >
                    {item.action}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <SectionTitle
            title="Recent activity"
            sub="Setup activity. Passwords and tokens are never shown."
            right={<button type="button" className="btn btn-sm" onClick={() => navigate('activity')}>View all</button>}
          />
          {activity === null ? <p className="muted">Loading…</p> : <Timeline items={activity} emptyLabel="Nothing has happened yet — add a domain to get started." />}
        </div>
      </section>

      {emptyAccount ? (
        <section className="card">
          <EmptyState
            title="Start with a hosted domain"
            icon="✉"
            action={(
              <div className="row center-actions">
                <button type="button" className="btn btn-primary" onClick={openWizard}>Add your first domain</button>
              </div>
            )}
          >
            The hosted domain gives you an address without DNS work. You can connect a custom domain later, after proving
            ownership and reviewing its DNS changes.
          </EmptyState>
        </section>
      ) : null}
    </div>
  );
}
