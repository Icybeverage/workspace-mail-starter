import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Banner, Chip, CodeLine, CopyButton, PasswordField, Spinner, StatusChip } from './Bits.jsx';
import MailboxForm from './MailboxForm.jsx';
import { DOMAIN_STATUS_LABELS, RECORD_ACTION_LABELS, cx } from '../util.js';

const STEP_LABELS = ['Domain', 'Ownership', 'Mailbox', 'DNS'];

export default function Wizard({ meta, onClose, navigate, reload }) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState('hosted');
  const [customName, setCustomName] = useState('');
  const [domain, setDomain] = useState(null);
  const [verifyRecord, setVerifyRecord] = useState(null);
  const [verifyMethod, setVerifyMethod] = useState('dns');
  const [cfToken, setCfToken] = useState('');
  const [pendingNote, setPendingNote] = useState(null);
  const [mailboxDone, setMailboxDone] = useState(false);
  const [plan, setPlan] = useState(null);
  const [planCfToken, setPlanCfToken] = useState('');
  const [approveMx, setApproveMx] = useState(false);
  const [manualInstructions, setManualInstructions] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [applyNote, setApplyNote] = useState(null);
  const [relay, setRelay] = useState(null);

  const hostedDomain = meta?.hostedDomain || 'the hosted domain';
  const isHosted = domain ? domain.kind === 'hosted' : mode === 'hosted';
  const verified = domain && (domain.verifiedAt || domain.kind === 'hosted');

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const createDomain = () => run(async () => {
    const body = mode === 'hosted' ? { name: hostedDomain } : { name: customName };
    const res = await api('/domains', { method: 'POST', body });
    setDomain(res.domain);
    setVerifyRecord(res.verifyRecord || null);
    if (reload) await reload();
    setStep(1);
  });

  const verify = (method) => run(async () => {
    setPendingNote(null);
    setError(null);
    try {
      const res = await api(`/domains/${domain.id}/verify`, { method: 'POST', body: { method, cfToken: method === 'cloudflare' ? cfToken : undefined } });
      setDomain(res.domain);
      setVerifyRecord(null);
      if (res.domain.kind === 'custom') {
        const relayStatus = await api(`/domains/${res.domain.id}/relay`);
        setRelay(relayStatus.relay);
      }
      if (reload) await reload();
      setStep(2);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'propagation_pending' || err.code === 'verification_failed')) {
        setPendingNote(err.message);
      }
      throw err;
    }
  });

  const createPlan = () => run(async () => {
    const res = await api(`/domains/${domain.id}/plan`, { method: 'POST', body: { cfToken: planCfToken || undefined } });
    setPlan(res.plan);
    if (reload) await reload();
  });

  const prepareRelay = () => run(async () => {
    const res = await api(`/domains/${domain.id}/relay/prepare`, { method: 'POST', body: {} });
    setRelay(res.relay);
    setApplyNote('SendGrid authentication is prepared. Publish the listed CNAMEs, then validate them before activation.');
  });

  const validateRelay = () => run(async () => {
    const res = await api(`/domains/${domain.id}/relay/validate`, { method: 'POST', body: {} });
    setRelay(res.relay);
    setApplyNote(res.relay.message);
  });

  const dryRun = () => run(async () => {
    const res = await api(`/domains/${domain.id}/plan/apply`, {
      method: 'POST',
      body: { planId: plan.id, planHash: plan.planHash, dryRun: true }
    });
    setApplyNote(`Dry run: ${res.operations.length} write operation(s) would run. Nothing was changed.`);
  });

  const applyManual = () => run(async () => {
    const res = await api(`/domains/${domain.id}/plan/apply`, {
      method: 'POST',
      body: { planId: plan.id, planHash: plan.planHash, method: 'manual', approvals: { mx: approveMx } }
    });
    setManualInstructions(res.instructions);
    if (reload) await reload();
  });

  const applyCloudflare = () => run(async () => {
    const res = await api(`/domains/${domain.id}/plan/apply`, {
      method: 'POST',
      body: { planId: plan.id, planHash: plan.planHash, method: 'cloudflare', approvals: { mx: approveMx } }
    });
    setApplyNote(`Applied to Cloudflare: ${res.summary.created} created, ${res.summary.updated} updated, ${res.summary.skipped} skipped. Propagation takes a few minutes; delivery stays unverified until a real message round-trips.`);
    if (reload) await reload();
  });

  const activate = () => run(async () => {
    const res = await api(`/domains/${domain.id}/activate`, { method: 'POST', body: {} });
    setDomain(res.domain);
    if (reload) await reload();
    navigate('domain', domain.id);
    onClose();
  });

  const needsMxApproval = plan && (plan.approvalsRequired || []).includes('mx');
  const conflicts = (plan && plan.conflicts) || [];

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="domain-wizard-title">
        <div className="modal-head">
          <div>
            <h2 id="domain-wizard-title">Add a domain</h2>
            <p className="faint">Four steps: choose a domain, verify ownership, create a mailbox, review DNS.</p>
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy} aria-label="Close wizard">Close</button>
        </div>

        <div className="wizard-steps" role="list">
          {STEP_LABELS.map((label, i) => (
            <div key={label} role="listitem" className={cx('wizard-step', step === i && 'active', step > i && 'done')}>
              <span className="idx">{step > i ? '✓' : i + 1}</span>
              <span>{label}</span>
            </div>
          ))}
        </div>

        {error ? <Banner tone="bad">{error.message}</Banner> : null}

        {step === 0 ? (
          <div className="field" style={{ gap: 14 }}>
            <div className="grid grid-2">
              <button
                type="button"
                className={cx('card', mode === 'hosted' && 'card-select')}
                onClick={() => setMode('hosted')}
                aria-pressed={mode === 'hosted'}
                style={{ textAlign: 'left', cursor: 'pointer' }}
              >
                <div className="row-tight"><h3>Hosted domain</h3><Chip tone="info">fastest</Chip></div>
                <p className="muted">Get an address on the shared <span className="mono">{hostedDomain}</span> namespace. DNS is managed for you — no records to change. Reserved names like admin or postmaster are blocked.</p>
              </button>
              <button
                type="button"
                className={cx('card', mode === 'custom' && 'card-select')}
                onClick={() => setMode('custom')}
                aria-pressed={mode === 'custom'}
                style={{ textAlign: 'left', cursor: 'pointer' }}
              >
                <div className="row-tight"><h3>Custom domain</h3><Chip tone="plain">you own it</Chip></div>
                <p className="muted">Use a domain you already own. You will prove ownership with a TXT record (or a zone-scoped Cloudflare token), then review every DNS change before anything is written.</p>
              </button>
            </div>
            {mode === 'custom' ? (
              <div className="field">
                <label htmlFor="wiz-domain">Your domain</label>
                <input
                  id="wiz-domain"
                  type="text"
                  value={customName}
                  placeholder="example.com"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setCustomName(e.target.value.toLowerCase().trim())}
                />
                <span className="hint">No paths, ports, or IP addresses. International domains are converted to punycode.</span>
              </div>
            ) : null}
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy || (mode === 'custom' && !customName)} aria-busy={busy} onClick={createDomain}>
                {busy ? <Spinner label="Creating…" /> : 'Continue'}
              </button>
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          isHosted ? (
            <div className="field" style={{ gap: 14 }}>
              <Banner tone="info">Ownership step skipped: <span className="mono">{domain.name}</span> is hosted by the provider and shared across accounts.</Banner>
              <div className="row"><button type="button" className="btn btn-primary" onClick={() => setStep(2)}>Continue</button></div>
            </div>
          ) : (
            <div className="field" style={{ gap: 14 }}>
              <p className="muted">
                Prove you control <span className="mono">{domain.name}</span> by publishing a unique TXT record — or let Workspace write it for you with a Cloudflare API token scoped to this one zone.
              </p>
              <div className="auth-tabs" role="tablist" aria-label="Verification method">
                <button type="button" role="tab" aria-selected={verifyMethod === 'dns'} className="auth-tab" onClick={() => setVerifyMethod('dns')}>DNS TXT record</button>
                <button type="button" role="tab" aria-selected={verifyMethod === 'cloudflare'} className="auth-tab" onClick={() => setVerifyMethod('cloudflare')}>Cloudflare token</button>
              </div>
              {verifyMethod === 'dns' ? (
                verifyRecord ? (
                  <div className="field">
                    <span className="faint">Add this TXT record at your DNS provider, then verify:</span>
                    <CodeLine>{`${verifyRecord.name}  TXT  "${verifyRecord.value}"`}</CodeLine>
                    <div className="row"><CopyButton text={`${verifyRecord.name} TXT "${verifyRecord.value}"`} label="Copy record" /></div>
                  </div>
                ) : (
                  <Banner tone="warn">Verification record data is missing; reopen the domain page to see it.</Banner>
                )
              ) : (
                <div className="field">
                  <label htmlFor="wiz-cf">Cloudflare API token (scoped to <span className="mono">{domain.name}</span> only)</label>
                  <input
                    id="wiz-cf"
                    type="password"
                    value={cfToken}
                    onChange={(e) => setCfToken(e.target.value)}
                    placeholder="Paste token — Zone:DNS:Edit for this zone only"
                    autoComplete="off"
                  />
                  <span className="hint">Stored encrypted (AES-256-GCM) with the server vault key; never returned by the API, never logged, never written to the graph.</span>
                </div>
              )}
              {pendingNote ? <Banner tone="warn">{pendingNote}</Banner> : null}
              <div className="row">
                <button type="button" className="btn btn-primary" disabled={busy || (verifyMethod === 'cloudflare' && !cfToken)} aria-busy={busy} onClick={() => verify(verifyMethod)}>
                  {busy ? <Spinner label="Verifying…" /> : 'Verify ownership'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setStep(0)}>Back</button>
              </div>
            </div>
          )
        ) : null}

        {step === 2 ? (
          <div className="field" style={{ gap: 14 }}>
            <p className="muted">
              Choose the mailbox name and password yourself. The password is sent once to the mail server and never stored by Workspace.
              {!isHosted ? ' You can create it before DNS cutover — mail starts flowing once MX is switched.' : ''}
            </p>
            <MailboxForm
              domains={domain ? [domain] : []}
              fixedDomainId={domain ? domain.id : null}
              reload={reload}
              onCreated={() => setMailboxDone(true)}
            />
            {mailboxDone ? <Banner tone="ok">Mailbox ready. Continue to DNS planning.</Banner> : null}
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={() => setStep(3)}>Continue</button>
              {!mailboxDone ? <span className="faint">Skipping is fine — you can create the mailbox any time from the Mailboxes page.</span> : null}
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          isHosted ? (
            <div className="field" style={{ gap: 14 }}>
              <Banner tone="info">DNS is managed by the provider for <span className="mono">{domain.name}</span>. Nothing to change.</Banner>
              <div className="row"><button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={activate}>{busy ? <Spinner label="Activating…" /> : 'Activate domain'}</button></div>
            </div>
          ) : (
            <div className="field" style={{ gap: 14 }}>
              {meta?.outgoingRelay === 'sendgrid' ? (
                <div className="card relay-wizard-card">
                  <div className="row-tight"><h3>Outgoing provider: SendGrid</h3><Chip tone={relay?.status === 'verified' ? 'ok' : 'pending'}>{relay?.status === 'verified' ? 'authenticated' : 'setup required'}</Chip></div>
                  <p className="muted">Custom domains need SendGrid sender authentication before activation. Authentication does not prove message delivery.</p>
                  {relay?.message ? <p className="faint">{relay.message}</p> : null}
                  {relay?.dnsRecords?.length ? <CodeLine>{relay.dnsRecords.map((record) => `${record.name}  ${record.type}  ${record.value}`).join('\n')}</CodeLine> : null}
                  <div className="row">
                    <button type="button" className="btn btn-sm" disabled={busy || !verified || relay?.status === 'verified'} onClick={prepareRelay}>
                      {relay?.status === 'not_prepared' ? 'Prepare authentication' : 'Refresh authentication'}
                    </button>
                    <button type="button" className="btn btn-sm" disabled={busy || !relay?.dnsRecords?.length || relay?.status === 'verified'} onClick={validateRelay}>Validate CNAMEs</button>
                  </div>
                </div>
              ) : null}
              {!plan ? (
                <>
                  <p className="muted">
                    Workspace builds a dry-run plan first: every current record, every proposed change, and any conflicts that need a manual merge.
                    Applying via Cloudflare requires you to approve MX changes explicitly and keeps a backup of every changed record.
                  </p>
                  <div className="field">
                    <label htmlFor="wiz-plan-cf">Cloudflare token (optional — enables one-click apply)</label>
                    <input
                      id="wiz-plan-cf"
                      type="password"
                      value={planCfToken}
                      onChange={(e) => setPlanCfToken(e.target.value)}
                      placeholder="Optional: Zone:DNS:Edit for this zone only"
                      autoComplete="off"
                    />
                  </div>
                  <div className="row">
                    <button type="button" className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={createPlan}>
                      {busy ? <Spinner label="Building plan…" /> : 'Create DNS plan (dry run)'}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setStep(2)}>Back</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="row spread">
                    <div className="row-tight">
                      <h3>Plan v{plan.version}</h3>
                      <Chip tone="info">dry-run preview</Chip>
                      {plan.sources ? <span className="faint">records from: {plan.sources.desired === 'mailserver_dump' ? 'mail server zone' : 'recommended defaults'}</span> : null}
                    </div>
                  </div>
                  <div style={{ overflowX: 'auto' }}>
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
                    <Banner tone="bad">
                      Conflicts need manual resolution before applying: {conflicts.map((c) => c.reason).join(' ')}
                    </Banner>
                  ) : null}
                  {needsMxApproval ? (
                    <label className="checkbox">
                      <input type="checkbox" checked={approveMx} onChange={(e) => setApproveMx(e.target.checked)} />
                      <span>
                        I understand that applying MX changes reroutes <strong>inbound mail</strong> for <span className="mono">{domain.name}</span> to the Workspace mail server.
                        My approval is bound to plan v{plan.version} (hash {String(plan.planHash).slice(0, 10)}…).
                      </span>
                    </label>
                  ) : null}
                  {applyNote ? <Banner tone="ok">{applyNote}</Banner> : null}
                  {manualInstructions ? (
                    <div className="field">
                      <span className="faint">Add these records at your DNS provider, then run checks from the domain page:</span>
                      <CodeLine>{manualInstructions.map((i) => `${i.fqdn}  ${i.type}  ${i.value}`).join('\n')}</CodeLine>
                      <div className="row"><CopyButton text={manualInstructions.map((i) => `${i.fqdn} ${i.type} ${i.value}`).join('\n')} label="Copy instructions" /></div>
                    </div>
                  ) : null}
                  <div className="row">
                    <button type="button" className="btn" disabled={busy || conflicts.length > 0 || (needsMxApproval && !approveMx)} onClick={dryRun}>Dry run</button>
                    <button type="button" className="btn btn-primary" disabled={busy || conflicts.length > 0 || (needsMxApproval && !approveMx)} aria-busy={busy} onClick={applyCloudflare}>
                      Apply via Cloudflare
                    </button>
                    <button type="button" className="btn" disabled={busy || conflicts.length > 0} onClick={applyManual}>
                      Show manual instructions
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => navigate('domain', domain.id)}>Open domain page</button>
                  </div>
                  <p className="faint">
                    Delivery is never claimed from DNS alone. After applying, inbound and outbound stay “unknown” until a real test message round-trips.
                  </p>
                </>
              )}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
