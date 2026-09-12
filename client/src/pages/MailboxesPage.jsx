import React, { useState } from 'react';
import { api } from '../api.js';
import { Banner, Chip, EmptyState, SectionTitle, StatusChip, CopyButton } from '../components/Bits.jsx';
import MailboxForm from '../components/MailboxForm.jsx';
import { MAILBOX_STATUS_LABELS, fmtRelative } from '../util.js';

export default function MailboxesPage({ data, reload }) {
  const mailboxes = data.mailboxes || [];
  const [reconciling, setReconciling] = useState(null);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const eligibleDomains = (data.domains || []).filter((d) => d.status !== 'ownership_pending');

  async function reconcile(mailbox) {
    setReconciling(mailbox.id);
    setNotice(null);
    setError(null);
    try {
      const res = await api(`/mailboxes/${mailbox.id}/reconcile`, { method: 'POST', body: {} });
      setNotice(res.exists
        ? `${mailbox.address} exists on the mail server — status confirmed. Its password was not touched.`
        : `${mailbox.address} was not created upstream; it is marked failed and you can try again with a fresh name/password.`);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setReconciling(null);
    }
  }

  const uncertain = mailboxes.filter((m) => m.status === 'uncertain');

  return (
    <div className="page">
      <div className="topbar">
        <h1>Mailboxes</h1>
      </div>

      {notice ? <Banner tone="ok">{notice}</Banner> : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}

      {uncertain.length > 0 ? (
        <Banner tone="warn">
          {uncertain.length} mailbox(es) are in an uncertain state after a timeout. Use “Check status” to reconcile —
          the app verifies upstream and never resets an existing mailbox.
        </Banner>
      ) : null}

      <section className="card">
        <SectionTitle
          title="Create a mailbox"
          sub={`Your beta account includes ${data.meta?.limits?.mailboxesPerAccount ?? 1} mailbox with 512 MB of storage.`}
        />
        <MailboxForm domains={eligibleDomains} reload={reload} />
        <p className="faint">
          Use your mailbox password to sign into the inbox. Your Workspace account password is managed separately.
        </p>
      </section>

      <section className="card">
        <SectionTitle title="Your mailboxes" sub="Statuses reflect the mail server's actual state." />
        {mailboxes.length === 0 ? (
          <EmptyState title="No mailboxes yet" icon="✉">
            Choose an address above to get started.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Domain</th>
                  <th>Status</th>
                  <th>Delivery</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mailboxes.map((m) => (
                  <tr key={m.id}>
                    <td className="val">{m.address}</td>
                    <td>
                      {m.domain} {m.domainKind === 'hosted' ? <Chip tone="info">hosted</Chip> : null}
                    </td>
                    <td><StatusChip map={MAILBOX_STATUS_LABELS} status={m.status} /></td>
                    <td>
                      <div className="row-tight">
                        <Chip tone="plain" title="Inbound delivery is unknown until tested">in: unknown</Chip>
                        <Chip tone="plain" title="Outbound delivery is unknown until tested">out: unknown</Chip>
                      </div>
                    </td>
                    <td className="faint">{fmtRelative(m.createdAt)}</td>
                    <td>
                      <div className="row-tight">
                        <CopyButton text={m.address} label="Copy" />
                        {m.status === 'uncertain' || m.status === 'creating' ? (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={reconciling === m.id}
                            onClick={() => reconcile(m)}
                          >
                            {reconciling === m.id ? 'Checking…' : 'Check status'}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint">
          Delivery stays unverified until a real message round-trip; DNS checks alone cannot prove delivery.
        </p>
      </section>
    </div>
  );
}
