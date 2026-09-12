import React from 'react';
import { Chip, EmptyState, StatusChip } from '../components/Bits.jsx';
import Wizard from '../components/Wizard.jsx';
import { DOMAIN_STATUS_LABELS } from '../util.js';

export default function DomainsPage({ data, navigate, reload, openWizard, wizardOpen, setWizardOpen }) {
  const domains = data.domains || [];
  const custom = domains.filter((d) => d.kind === 'custom');
  const hosted = domains.filter((d) => d.kind === 'hosted');

  return (
    <div className="page">
      <div className="topbar">
        <h1>Domains</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={openWizard}>Add domain</button>
      </div>
      <p className="muted page-intro">
        Use the shared hosted namespace or connect a domain you own. Custom domains are reserved to your account.
      </p>

      {domains.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No domains yet"
            icon="⬡"
            action={<button type="button" className="btn btn-primary" onClick={openWizard}>Add your first domain</button>}
          >
            Add the shared hosted domain for an instant address, or connect a custom domain with a TXT ownership record.
          </EmptyState>
        </div>
      ) : null}

      {hosted.length > 0 ? (
        <section className="grid grid-cards">
          {hosted.map((d) => <DomainCard key={d.id} domain={d} navigate={navigate} shared />)}
        </section>
      ) : null}

      {custom.length > 0 ? (
        <>
          <h2 style={{ marginTop: 6 }}>Custom domains</h2>
          <section className="grid grid-cards">
            {custom.map((d) => <DomainCard key={d.id} domain={d} navigate={navigate} />)}
          </section>
        </>
      ) : null}

      {domains.length > 0 && custom.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No custom domain connected"
            icon="◎"
            action={<button type="button" className="btn" onClick={openWizard}>Connect a custom domain</button>}
          >
            Bring a domain you own to route its mail through Workspace — ownership is proven with a unique TXT record
            before any DNS change is planned.
          </EmptyState>
        </div>
      ) : null}

      {wizardOpen ? (
        <Wizard meta={data.meta} onClose={() => setWizardOpen(false)} navigate={navigate} reload={reload} />
      ) : null}
    </div>
  );
}

function DomainCard({ domain, navigate, shared = false }) {
  return (
    <article className="card">
      <div className="row spread">
        <div className="row-tight">
          <h3 className="mono">{domain.name}</h3>
          <Chip tone={shared ? 'info' : 'plain'}>{shared ? 'hosted' : 'custom'}</Chip>
          {domain.cfZone ? <Chip tone="ok">Cloudflare connected</Chip> : null}
        </div>
        <StatusChip map={DOMAIN_STATUS_LABELS} status={domain.status} />
      </div>
      <div className="row spread">
        <span className="faint">{domain.mailboxCount} mailbox(es) on this domain</span>
        <button type="button" className="btn btn-sm" onClick={() => navigate('domain', domain.id)}>
          {domain.status === 'ownership_pending' ? 'Verify →' : 'Open →'}
        </button>
      </div>
      {domain.status === 'ownership_pending' && domain.verifyRecord ? (
        <div className="codeblock">{`${domain.verifyRecord.name}  TXT  "${domain.verifyRecord.value}"`}</div>
      ) : null}
      {shared ? (
        <p className="faint">
          Shared across all accounts — mailboxes are isolated per account, and existing addresses are never taken over.
        </p>
      ) : null}
    </article>
  );
}
