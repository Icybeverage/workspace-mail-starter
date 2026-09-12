import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createAsyncGeneration } from '../asyncGeneration.js';
import { api, ApiError } from '../api.js';
import { Banner, Chip, CodeLine, CopyButton, EmptyState, SectionTitle, Spinner, StatusChip } from '../components/Bits.jsx';
import MailboxForm from '../components/MailboxForm.jsx';
import GraphView from '../components/GraphView.jsx';
import AgentPanel from '../components/AgentPanel.jsx';
import InvestigationPanel from '../components/InvestigationPanel.jsx';
import Timeline from '../components/Timeline.jsx';
import { CHECK_STATUS_LABELS, DOMAIN_STATUS_LABELS, MAILBOX_STATUS_LABELS, RECORD_ACTION_LABELS, fmtRelative, fmtDateTime } from '../util.js';

const GRAPH_RECORD_STATE_LABELS = {
  configured: ['Configured', 'ok'],
  managed: ['Managed', 'info'],
  missing: ['Missing', 'warn'],
  mismatch: ['Mismatch', 'warn'],
  conflict: ['Conflict', 'bad'],
  failed: ['Failed', 'bad'],
  pending: ['Pending', 'pending'],
  unknown: ['Unknown', 'plain']
};

const GRAPH_ACTION_STATUS_LABELS = {
  done: ['Done', 'ok'],
  pending: ['Pending', 'pending'],
  failed: ['Failed', 'bad'],
  running: ['In progress', 'info'],
  unknown: ['Unknown', 'plain']
};

export default function DomainDetailPage({ domainId, navigate, reload, openWizard }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(null);
  const [activity, setActivity] = useState([]);
  const [graphState, setGraphState] = useState({ loading: true, graph: null, degraded: false, status: null, error: null });
  const [selectedNode, setSelectedNode] = useState(null);
  const [impact, setImpact] = useState(null);
  const [verifyMethod, setVerifyMethod] = useState('dns');
  const [cfToken, setCfToken] = useState('');
  const [planCfToken, setPlanCfToken] = useState('');
  const [approveMx, setApproveMx] = useState(false);
  const [manual, setManual] = useState(null);
  const [relay, setRelay] = useState(null);
  const impactGen = useRef(createAsyncGeneration());

  const invalidateImpact = useCallback(() => {
    impactGen.current.invalidate();
    setImpact(null);
  }, []);

  useEffect(() => () => { impactGen.current.invalidate(); }, []);

  const load = useCallback(async () => {
    setError(null);
    setSelectedNode(null);
    invalidateImpact();
    try {
      const res = await api(`/domains/${domainId}`);
      setDetail(res);
    } catch (err) {
      setError(err);
    }
    api(`/domains/${domainId}/relay`)
      .then((r) => setRelay(r.relay))
      .catch(() => setRelay(null));
    api(`/activity?limit=30&domainId=${encodeURIComponent(domainId)}`)
      .then((r) => setActivity(r.items))
      .catch(() => setActivity([]));
    setGraphState((s) => ({ ...s, loading: true }));
    api(`/domains/${domainId}/graph`)
      .then((r) => setGraphState({ loading: false, graph: r.graph, degraded: Boolean(r.graph?.degraded), status: r.status, error: null }))
      .catch((err) => setGraphState({ loading: false, graph: null, degraded: true, status: err.payload?.graphStatus || null, error: err.message }));
  }, [domainId, invalidateImpact]);

  useEffect(() => { load(); }, [load]);

  async function act(name, fn) {
    setBusy(name);
    setBanner(null);
    try {
      const res = await fn();
      if (res && res.message) setBanner({ tone: 'ok', text: res.message });
      await load();
      if (reload) await reload();
      return res;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'activation_blocked') {
        setBanner({ tone: 'bad', text: `${err.message} ${(err.payload?.blockers || []).map((b) => `${b.scope}: ${b.detail}`).join(' ')}` });
      } else {
        setBanner({ tone: 'bad', text: err.message });
      }
      return null;
    } finally {
      setBusy(null);
    }
  }

  if (error && (!error.payload || error.status === 404)) {
    return (
      <div className="page">
        <div className="card">
          <EmptyState title="Domain not found" icon="⬡" action={<button type="button" className="btn" onClick={() => navigate('domains')}>Back to domains</button>}>
            {error.status === 404 ? 'This domain does not exist or belongs to another account.' : error.message}
          </EmptyState>
        </div>
      </div>
    );
  }

  if (!detail) {
    return <div className="page"><Spinner label="Loading domain…" /></div>;
  }

  const { domain, plan, checks, mailboxes, actions, limitations } = detail;
  const relayStatus = relay || detail.relay;
  const isHosted = domain.kind === 'hosted';
  const needsVerify = !isHosted && !domain.verifiedAt;
  const conflicts = (plan && plan.conflicts) || [];
  const needsMxApproval = plan && (plan.approvalsRequired || []).includes('mx');
  const latestChecks = checks || [];
  const canActivate = !isHosted && domain.verifiedAt && domain.status !== 'active';

  async function showImpact(node) {
    const token = impactGen.current.begin();
    setImpact(null);
    try {
      const res = await api(`/domains/${domainId}/impact?recordId=${encodeURIComponent(node.id)}`);
      if (!impactGen.current.isActive(token)) return;
      setImpact(res.impacted);
    } catch (err) {
      if (!impactGen.current.isActive(token)) return;
      setImpact({ error: err.message });
    }
  }

  return (
    <div className="page">
      <div className="topbar">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate('domains')}>← Domains</button>
        <h1 className="mono detail-title" style={{ fontSize: 24 }}>{domain.name}</h1>
        <Chip tone={isHosted ? 'info' : 'plain'}>{isHosted ? 'hosted' : 'custom'}</Chip>
        <StatusChip map={DOMAIN_STATUS_LABELS} status={domain.status} />
        {domain.cfZone ? <Chip tone="ok">Cloudflare connected</Chip> : null}
        <span className="spacer" />
        <button type="button" className="btn btn-sm" disabled={busy === 'checks'} onClick={() => act('checks', () => api(`/domains/${domainId}/inspect`))}>
          {busy === 'checks' ? <Spinner label="Checking…" /> : 'Run DNS checks'}
        </button>
        {canActivate ? (
          <button type="button" className="btn btn-sm btn-primary" disabled={busy === 'activate'} onClick={() => act('activate', () => api(`/domains/${domainId}/activate`, { method: 'POST', body: {} }))}>
            {busy === 'activate' ? <Spinner label="Activating…" /> : 'Activate'}
          </button>
        ) : null}
      </div>

      <InvestigationPanel key={domainId} domainId={domainId} domainName={domain.name} />

      {banner ? <Banner tone={banner.tone}>{banner.text}</Banner> : null}

      {isHosted ? (
        <Banner tone="info">
          This domain is hosted on the shared namespace. DNS is managed by the provider, so there are no records to change.
          Create a mailbox to get started; delivery remains unverified until a real test message round-trips.
          Mailboxes are isolated per account, and existing addresses are never taken over.
        </Banner>
      ) : null}

      {needsVerify ? (
        <section className="card">
          <SectionTitle title="Verify ownership" sub="Prove you control this domain before any DNS planning." />
          <div className="auth-tabs" role="tablist" aria-label="Verification method" style={{ maxWidth: 420 }}>
            <button type="button" role="tab" aria-selected={verifyMethod === 'dns'} className="auth-tab" onClick={() => setVerifyMethod('dns')}>DNS TXT record</button>
            <button type="button" role="tab" aria-selected={verifyMethod === 'cloudflare'} className="auth-tab" onClick={() => setVerifyMethod('cloudflare')}>Cloudflare token</button>
          </div>
          {verifyMethod === 'dns' ? (
            domain.verifyRecord ? (
              <div className="field">
                <span className="faint">Publish this exact TXT record, then verify:</span>
                <CodeLine>{`${domain.verifyRecord.name}  TXT  "${domain.verifyRecord.value}"`}</CodeLine>
                <div className="row"><CopyButton text={`${domain.verifyRecord.name} TXT "${domain.verifyRecord.value}"`} label="Copy record" /></div>
              </div>
            ) : null
          ) : (
            <div className="field">
              <label htmlFor="dd-cf">Cloudflare API token (scoped to <span className="mono">{domain.name}</span> only)</label>
              <input id="dd-cf" type="password" value={cfToken} onChange={(e) => setCfToken(e.target.value)} placeholder="Zone:DNS:Edit for this zone only" autoComplete="off" />
              <span className="hint">Encrypted at rest (AES-256-GCM with the server vault key). Never returned by the API, logged, or written to the graph.</span>
            </div>
          )}
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy === 'verify' || (verifyMethod === 'cloudflare' && !cfToken)}
              onClick={() => act('verify', () => api(`/domains/${domainId}/verify`, { method: 'POST', body: { method: verifyMethod, cfToken: verifyMethod === 'cloudflare' ? cfToken : undefined } }))}
            >
              {busy === 'verify' ? <Spinner label="Verifying…" /> : 'Verify ownership'}
            </button>
            {verifyMethod === 'dns' ? <span className="faint">DNS propagation can take a few minutes — re-run verification shortly.</span> : null}
          </div>
        </section>
      ) : null}

      {!isHosted ? (
        <section className="card">
          <SectionTitle
            title="Outgoing provider"
            sub="Sender authentication is separate from ownership and never proves message delivery."
          />
          {!relayStatus?.configured ? (
            <Banner tone="info">No outgoing relay is configured. Direct-MX behavior remains unchanged.</Banner>
          ) : (
            <>
              <div className="row spread">
                <div className="row-tight">
                  <span className="faint">Provider</span>
                  <Chip tone="info">SendGrid</Chip>
                  <StatusChip map={{ direct_mx: ['Direct MX', 'info'], not_prepared: ['Not prepared', 'warn'], pending: ['DNS required', 'pending'], failed: ['Needs attention', 'bad'], verified: ['Authenticated', 'ok'] }} status={relayStatus.status} />
                </div>
              </div>
              <p className="muted">{relayStatus.message}</p>
              {relayStatus.error ? <Banner tone="bad">{relayStatus.error}</Banner> : null}
              {relayStatus.dnsRecords?.length ? (
                <div className="field">
                  <span className="faint">Publish these exact public CNAME records at your DNS provider:</span>
                  <CodeLine>{relayStatus.dnsRecords.map((record) => `${record.name}  ${record.type}  ${record.value}`).join('\n')}</CodeLine>
                  <div className="row"><CopyButton text={relayStatus.dnsRecords.map((record) => `${record.name} ${record.type} ${record.value}`).join('\n')} label="Copy relay records" /></div>
                </div>
              ) : null}
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={Boolean(busy) || !domain.verifiedAt || relayStatus.status === 'verified'}
                  onClick={() => act('relay-prepare', () => api(`/domains/${domainId}/relay/prepare`, { method: 'POST', body: {} }))}
                >
                  {busy === 'relay-prepare' ? <Spinner label="Preparing…" /> : 'Prepare SendGrid authentication'}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={Boolean(busy) || !domain.verifiedAt || !relayStatus.dnsRecords?.length || relayStatus.status === 'verified'}
                  onClick={() => act('relay-validate', () => api(`/domains/${domainId}/relay/validate`, { method: 'POST', body: {} }))}
                >
                  {busy === 'relay-validate' ? <Spinner label="Validating…" /> : 'Validate CNAMEs'}
                </button>
              </div>
              {!domain.verifiedAt ? <span className="faint">Verify ownership before preparing sender authentication.</span> : null}
            </>
          )}
        </section>
      ) : null}

      {!isHosted && domain.verifiedAt ? (
        <section className="card">
          <SectionTitle
            title="DNS plan"
            sub="Dry-run first. Only reviewed operations are written, unrelated records are preserved, and MX changes need your explicit approval."
            right={(
              <div className="row-tight">
                <button type="button" className="btn btn-sm" disabled={busy === 'plan'} onClick={() => act('plan', () => api(`/domains/${domainId}/plan`, { method: 'POST', body: { cfToken: planCfToken || undefined } }))}>
                  {busy === 'plan' ? <Spinner label="Planning…" /> : (plan ? 'Re-plan (dry run)' : 'Create plan (dry run)')}
                </button>
              </div>
            )}
          />
          {!plan ? (
            <div className="field" style={{ gap: 12 }}>
              <p className="muted">
                No plan yet. Creating one reads your current DNS and the mail server's desired records, then shows every
                proposed change without writing anything.
              </p>
              <div className="field" style={{ maxWidth: 520 }}>
                <label htmlFor="dd-plan-cf">Cloudflare token (optional — for one-click apply)</label>
                <input id="dd-plan-cf" type="password" value={planCfToken} onChange={(e) => setPlanCfToken(e.target.value)} placeholder="Zone:DNS:Edit for this zone only" autoComplete="off" />
              </div>
            </div>
          ) : (
            <>
              <div className="row spread">
                <div className="row-tight">
                  <span className="mono">v{plan.version}</span>
                  <Chip tone={plan.status === 'draft' ? 'info' : plan.status === 'applied' ? 'ok' : 'plain'}>{plan.status}</Chip>
                  {plan.staleNow ? <Chip tone="warn">stale — DNS changed since planning</Chip> : null}
                  <span className="faint">created {fmtRelative(plan.createdAt)}{plan.appliedAt ? ` · applied ${fmtRelative(plan.appliedAt)}` : ''}</span>
                </div>
                <span className="faint">hash {String(plan.planHash || '').slice(0, 12)}…</span>
              </div>
          <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr><th>Record</th><th>Type</th><th>Current</th><th>Proposed</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    {plan.records.map((r) => (
                      <tr key={r.key}>
                        <td className="val">{r.name}</td>
                        <td>{r.type}</td>
                        <td className="val current">{r.current && r.current.length ? r.current.join('\n') : '—'}</td>
                        <td className="val">{r.proposed || '—'}</td>
                        <td><StatusChip map={RECORD_ACTION_LABELS} status={r.action} title={r.reason} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {plan.sources && plan.sources.limitations && plan.sources.limitations.length ? (
                <Banner tone="warn">{plan.sources.limitations.join(' ')}</Banner>
              ) : null}
              {conflicts.length ? (
                <Banner tone="bad">Conflicts need manual resolution: {conflicts.map((c) => c.reason).join(' ')}</Banner>
              ) : null}
              {plan.status === 'draft' ? (
                <>
                  {needsMxApproval ? (
                    <label className="checkbox">
                      <input type="checkbox" checked={approveMx} onChange={(e) => setApproveMx(e.target.checked)} />
                      <span>
                        I approve the MX change for <span className="mono">{domain.name}</span> — it reroutes inbound mail to the Workspace mail server.
                        Approval binds to plan v{plan.version} (hash {String(plan.planHash).slice(0, 10)}…).
                      </span>
                    </label>
                  ) : null}
                  <div className="row">
                    <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => act('dry', () => api(`/domains/${domainId}/plan/apply`, { method: 'POST', body: { planId: plan.id, planHash: plan.planHash, dryRun: true } }).then((r) => ({ message: `Dry run: ${r.operations.length} write operation(s) would run. Nothing was changed.` })))}>
                      Dry run
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={Boolean(busy) || conflicts.length > 0 || (needsMxApproval && !approveMx) || !domain.cfZone}
                      title={!domain.cfZone ? 'Connect Cloudflare (or use manual instructions)' : undefined}
                      onClick={() => act('apply-cf', () => api(`/domains/${domainId}/plan/apply`, { method: 'POST', body: { planId: plan.id, planHash: plan.planHash, method: 'cloudflare', approvals: { mx: approveMx } } }).then((r) => ({ message: `Applied via Cloudflare: ${r.summary.created} created, ${r.summary.updated} updated, ${r.summary.skipped} skipped. Delivery stays unverified until a real message round-trips.` })))}
                    >
                      Apply via Cloudflare
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={Boolean(busy) || conflicts.length > 0}
                      onClick={() => act('manual', () => api(`/domains/${domainId}/plan/apply`, { method: 'POST', body: { planId: plan.id, planHash: plan.planHash, method: 'manual', approvals: { mx: approveMx } } }).then((r) => { setManual(r.instructions); return { message: r.message }; }))}
                    >
                      Show manual instructions
                    </button>
                  </div>
                </>
              ) : null}
              {manual ? (
                <div className="field">
                  <span className="faint">Add these records at your DNS provider, then run checks:</span>
                  <CodeLine>{manual.map((i) => `${i.fqdn}  ${i.type}  ${i.value}`).join('\n')}</CodeLine>
                  <div className="row"><CopyButton text={manual.map((i) => `${i.fqdn} ${i.type} ${i.value}`).join('\n')} label="Copy instructions" /></div>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <section className="grid grid-2">
        <div className="card">
          <SectionTitle title="Check results" sub="Live DNS + provider state. Delivery is separate and unverified." />
          {latestChecks.length === 0 ? (
            <p className="muted">No checks yet — run DNS checks to see the current state.</p>
          ) : (
            <ul className="list-plain">
              {latestChecks.map((c) => (
                <li key={`${c.scope}-${c.checkedAt}`} className="row spread" style={{ alignItems: 'flex-start' }}>
                  <div className="row-tight" style={{ alignItems: 'flex-start' }}>
                    <StatusChip map={CHECK_STATUS_LABELS} status={c.status} />
                    <div>
                      <div className="mono">{c.scope}</div>
                      <div className="faint">{checkDetail(c)}</div>
                    </div>
                  </div>
                  <span className="faint" title={fmtDateTime(c.checkedAt)}>{fmtRelative(c.checkedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="row-tight delivery-summary">
            <Chip tone="plain">inbound: unknown</Chip>
            <Chip tone="plain">outbound: unknown</Chip>
            <span className="faint">{detail.delivery ? detail.delivery.note : ''}</span>
          </div>
        </div>

        <div className="card">
          <SectionTitle
            title="Setup assistant"
            sub="A rule-based guide to the next setup step, using your current results."
          />
          <AgentPanel domainId={domainId} />
        </div>
      </section>

      <section className="card">
        <SectionTitle title="Mailboxes on this domain" sub="Per-account isolation; addresses are globally unique and never taken over." />
        <div className="table-scroll">
          {mailboxes.length === 0 ? (
            <p className="muted">No mailbox on this domain yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Address</th><th>Status</th><th>Confirmed upstream</th><th>Created</th></tr>
              </thead>
              <tbody>
                {mailboxes.map((m) => (
                  <tr key={m.id}>
                    <td className="val">{m.address}</td>
                    <td><StatusChip map={MAILBOX_STATUS_LABELS} status={m.status} /></td>
                    <td className="faint">{m.upstreamConfirmedAt ? fmtRelative(m.upstreamConfirmedAt) : '—'}</td>
                    <td className="faint">{fmtRelative(m.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {!needsVerify && mailboxes.length < 1 ? (
          <div style={{ marginTop: 12 }}>
            <MailboxForm domains={[domain]} fixedDomainId={domain.id} reload={load} />
          </div>
        ) : null}
      </section>

      <section className="card">
        <SectionTitle
          title="Dependency graph"
          sub="Neo4j graph of your domain setup. Click a node for details."
          right={graphState.status && graphState.status.degraded ? <Chip tone="warn">graph degraded</Chip> : null}
        />
        {graphState.loading ? <Spinner label="Loading dependency graph…" /> : (
          <div className="grid graph-layout">
            <GraphView
              graph={graphState.graph}
              degraded={graphState.degraded}
              status={graphState.status}
              selectedId={selectedNode ? selectedNode.id : null}
              onSelect={(node) => { setSelectedNode(node); invalidateImpact(); }}
            />
            {selectedNode ? (
              <div className="graph-detail">
                <div className="row spread">
                  <h3>{graphNodeTitle(selectedNode.type)}</h3>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setSelectedNode(null); invalidateImpact(); }} aria-label="Close node details">Close</button>
                </div>
                <dl className="kv graph-detail-fields">
                  {graphNodeDetails(selectedNode).map(({ label, value, statusMap, format, mono }) => (
                    <React.Fragment key={label}>
                      <dt>{label}</dt>
                      <dd className={mono ? 'mono' : undefined}>
                        {statusMap ? <StatusChip map={statusMap} status={value} /> : (format ? format(value) : value || '—')}
                      </dd>
                    </React.Fragment>
                  ))}
                </dl>
                {selectedNode.type === 'DNSRecord' ? (
                  <div className="graph-impact">
                    <button type="button" className="btn btn-sm" onClick={() => showImpact(selectedNode)}>Show impacted mailboxes</button>
                    {impact ? (
                      impact.error ? <p className="faint">{impact.error}</p>
                        : impact.length === 0 ? <p className="faint">No mailboxes depend on this record.</p>
                          : (
                            <ul className="list-plain graph-impact-list">
                              {impact.map((i) => (
                                <li key={i.address} className="row-tight graph-impact-item">
                                  <Chip tone="info">{i.status}</Chip>
                                  <span className="mono graph-impact-address">{i.address}</span>
                                </li>
                              ))}
                            </ul>
                          )
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
        {graphState.error && !graphState.graph ? <p className="faint">{graphState.error}</p> : null}
      </section>

      <section className="grid grid-2">
        <div className="card">
          <SectionTitle title="Recent activity" sub="Setup activity for this domain." />
          <Timeline items={activity} emptyLabel="No activity yet for this domain." />
        </div>
        <div className="card">
          <SectionTitle title="Open setup actions" sub="Open items are also shown in the dependency graph." />
          {(actions || []).length === 0 ? (
            <p className="muted">No open actions.</p>
          ) : (
            <ul className="list-plain">
              {actions.map((a) => (
                <li key={a.id} className="row spread">
                  <span className="mono">{a.kind}</span>
                  <Chip tone={a.status === 'done' ? 'ok' : a.status === 'failed' ? 'bad' : 'pending'}>{a.status}</Chip>
                </li>
              ))}
            </ul>
          )}
          <p className="faint">{limitations ? limitations.join(' ') : ''}</p>
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={load}>Refresh everything</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={openWizard}>Add another domain</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function graphNodeTitle(type) {
  return {
    Domain: 'Domain',
    Mailbox: 'Mailbox',
    DNSRecord: 'DNS record',
    Check: 'DNS check',
    SetupAction: 'Setup action'
  }[type] || 'Graph node';
}

function graphNodeDetails(node) {
  const formatScope = (value) => value ? String(value).toUpperCase() : '—';
  const formatKind = (value) => value
    ? String(value).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
    : '—';

  switch (node.type) {
    case 'Domain':
      return [
        { label: 'Domain name', value: node.name, mono: true },
        { label: 'Status', value: node.status, statusMap: DOMAIN_STATUS_LABELS }
      ];
    case 'Mailbox':
      return [
        { label: 'Mailbox address', value: node.address, mono: true },
        { label: 'Status', value: node.status, statusMap: MAILBOX_STATUS_LABELS }
      ];
    case 'DNSRecord':
      return [
        { label: 'Record name', value: node.name, mono: true },
        { label: 'Record type', value: node.dnsType || node.recordType, format: formatScope, mono: true },
        { label: 'State', value: node.state, statusMap: GRAPH_RECORD_STATE_LABELS }
      ];
    case 'Check':
      return [
        { label: 'Check scope', value: node.scope, format: formatScope, mono: true },
        { label: 'Status', value: node.status, statusMap: CHECK_STATUS_LABELS }
      ];
    case 'SetupAction':
      return [
        { label: 'Action kind', value: node.kind, format: formatKind },
        { label: 'Status', value: node.status, statusMap: GRAPH_ACTION_STATUS_LABELS }
      ];
    default:
      return [];
  }
}

function checkDetail(check) {
  const d = check.details || {};
  if (check.scope === 'mx') {
    const cur = (d.current || []).join(', ');
    return `current: ${cur || 'none'} · expected ${d.expected || '—'}${d.dnsStatus && d.dnsStatus !== 'answered' ? ` (DNS: ${d.dnsStatus})` : ''}`;
  }
  if (check.scope === 'spf') return d.issue || `records: ${(d.records || []).join(' | ') || 'none'}`;
  if (check.scope === 'dkim') return d.summary || d.note || `selector: ${d.selector || 'mail'}`;
  if (check.scope === 'dmarc') return `records: ${(d.records || []).join(' | ') || 'none'}`;
  if (check.scope === 'ownership') return d.method ? `via ${d.method} at ${d.at ? fmtDateTime(d.at) : '—'}` : (d.hint || '');
  return '';
}
