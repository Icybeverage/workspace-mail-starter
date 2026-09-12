import React, { useEffect, useId, useMemo, useState } from 'react';
import { api, ApiError } from '../api.js';
import { PasswordField, Banner, Chip, Spinner } from './Bits.jsx';

export default function MailboxForm({ domains, fixedDomainId = null, onCreated, reload }) {
  const formId = useId().replace(/:/g, '');
  const eligible = useMemo(() => (domains || []).filter((d) =>
    d.status !== 'ownership_pending' && d.kind !== undefined
  ), [domains]);

  const [domainId, setDomainId] = useState(fixedDomainId || (eligible[0] ? eligible[0].id : ''));
  useEffect(() => {
    if (!eligible.some((d)=>d.id===domainId)) setDomainId(fixedDomainId || eligible[0]?.id || '');
  }, [eligible, fixedDomainId, domainId]);
  const [localPart, setLocalPart] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [uncertain, setUncertain] = useState(null);
  const [created, setCreated] = useState(null);

  const selected = eligible.find((d) => d.id === domainId) || null;
  const address = selected && localPart ? `${localPart.toLowerCase()}@${selected.name}` : '';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setUncertain(null);
    setCreated(null);
    try {
      const res = await api('/mailboxes', {
        method: 'POST',
        body: { domainId, localPart, password }
      });
      setCreated(res.mailbox);
      setLocalPart('');
      setPassword('');
      if (reload) await reload();
      if (onCreated) onCreated(res.mailbox);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'creation_uncertain') {
        setUncertain(err.payload?.mailbox || null);
        if (reload) await reload();
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  if (eligible.length === 0) {
    return (
      <Banner tone="warn">
        No domain is ready for mailboxes yet. Add the hosted domain or verify a custom domain first.
      </Banner>
    );
  }

  return (
    <form className="field mailbox-form" onSubmit={submit} style={{ gap: 14 }} aria-busy={busy}>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor={`${formId}-local`}>Mailbox name</label>
          <input
            id={`${formId}-local`}
            type="text"
            value={localPart}
            placeholder={selected ? `you@${selected.name}` : 'you'}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${formId}-local-hint`}
            required
            onChange={(e) => setLocalPart(e.target.value.replace(/[^a-zA-Z0-9._-]/g, ''))}
          />
          <span className="hint" id={`${formId}-local-hint`}>Letters, numbers, dots, hyphens, and underscores.</span>
        </div>
        <div className="field">
          <label htmlFor={`${formId}-domain`}>Domain</label>
          <select
            id={`${formId}-domain`}
            value={domainId}
            onChange={(e) => setDomainId(e.target.value)}
            disabled={Boolean(fixedDomainId)}
            required
          >
            {eligible.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}{d.kind === 'hosted' ? ' (hosted, shared)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <PasswordField
        id={`${formId}-password`}
        label="Mailbox password"
        value={password}
        onChange={setPassword}
        hint="Sent once to the mail server; Workspace does not store it. This password is separate from your app account password."
      />

      {address ? <p className="faint">Creating: <span className="mono">{address}</span></p> : null}

      {error ? <Banner tone="bad">{error.message}</Banner> : null}
      {uncertain ? (
        <Banner tone="warn">
          The mail server did not confirm in time, so this mailbox is in an <strong>uncertain</strong> state.
          Use “Check status” on the mailbox to reconcile — the app will verify upstream and will never reset a password.
        </Banner>
      ) : null}
      {created ? (
        <Banner tone="ok">
          <span className="row-tight">
            <span>Mailbox created:</span> <span className="mono">{created.address}</span>
            <Chip tone="ok">created</Chip>
          </span>
          <div className="faint" style={{ marginTop: 4 }}>
            Delivery is not verified yet — send a real test message to confirm inbound and outbound.
          </div>
        </Banner>
      ) : null}

      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={busy || !domainId || !localPart || password.length < 10} aria-busy={busy}>
          {busy ? <Spinner label="Creating mailbox…" /> : 'Create mailbox'}
        </button>
        <span className="faint">512 MB storage included.</span>
      </div>
    </form>
  );
}
