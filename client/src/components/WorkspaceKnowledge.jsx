import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { buildQoderBrief, isQoderHandoffType } from '../qoderBrief.js';
import { copyText, findSourceEmail, fmtBytes, fmtConfidence, fmtDateTime, workspaceNodeDetails, workspaceNodeTitle } from '../util.js';
import { Banner, Chip, EmptyState, SectionTitle, Spinner } from './Bits.jsx';
import GraphView from './GraphView.jsx';

export default function WorkspaceKnowledge() {
  const [mailboxes, setMailboxes] = useState([]);
  const [items, setItems] = useState([]);
  const [mailboxId, setMailboxId] = useState('');
  const [password, setPassword] = useState('');
  const [includeEmail, setIncludeEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bootLoading, setBootLoading] = useState(true);
  const [error, setError] = useState('');
  const [graphState, setGraphState] = useState({ loading: false, graph: null, degraded: false, error: null });
  const [selected, setSelected] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [qoderOpen, setQoderOpen] = useState(false);
  const [qoderCopyError, setQoderCopyError] = useState('');

  const item = items.find((entry) => entry.mailboxId === mailboxId);
  const contextEdges = graphState.graph?.edges.filter((edge) => ['SUGGESTS', 'POSSIBLY_REFERENCES'].includes(edge.type)) || [];
  const contextIds = new Set(contextEdges.flatMap((edge) => [edge.from, edge.to]));
  const visibleGraph = graphState.graph && !showAll && contextIds.size
    ? { ...graphState.graph, nodes: graphState.graph.nodes.filter((node) => contextIds.has(node.id)), edges: contextEdges }
    : graphState.graph;
  const sourceEmail = selected ? findSourceEmail(item, selected) : null;
  const friendlyGraph = Boolean(!showAll && contextIds.size);
  const qoderBrief = useMemo(() => (
    selected && isQoderHandoffType(selected.type)
      ? buildQoderBrief({ selected, graph: graphState.graph, item })
      : null
  ), [selected, graphState.graph, item]);

  useEffect(() => {
    setQoderOpen(false);
    setQoderCopyError('');
  }, [selected?.id, mailboxId]);

  useEffect(() => {
    setBootLoading(true);
    setError('');
    Promise.all([api('/mailboxes'), api('/workspace/knowledge')])
      .then(([mailboxesRes, knowledgeRes]) => {
        const owned = mailboxesRes.mailboxes.filter((mailbox) => mailbox.status === 'created');
        setMailboxes(owned);
        setMailboxId(owned[0]?.id || '');
        setItems(knowledgeRes.items);
      })
      .catch((err) => setError(err.message))
      .finally(() => setBootLoading(false));
  }, []);

  useEffect(() => {
    setSelected(null);
    const mailbox = mailboxes.find((entry) => entry.id === mailboxId);
    if (!mailbox || !item) {
      setGraphState({ loading: false, graph: null, degraded: false, error: null });
      return;
    }
    setGraphState({ loading: true, graph: null, degraded: false, error: null });
    let current = true;
    api(`/domains/${mailbox.domainId}/graph`)
      .then((res) => {
        if (!current) return;
        const nodes = res.graph.nodes.filter((node) => node.mailboxId === mailboxId || (node.type === 'Mailbox' && node.localId === mailboxId));
        const ids = new Set(nodes.map((node) => node.id));
        setGraphState({
          loading: false,
          graph: { ...res.graph, nodes, edges: res.graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) },
          degraded: Boolean(res.graph?.degraded),
          error: null
        });
      })
      .catch((err) => {
        if (!current) return;
        setGraphState({ loading: false, graph: null, degraded: true, error: err.message });
      });
    return () => { current = false; };
  }, [mailboxId, items, mailboxes, item]);

  async function sync(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const transient = password;
    setPassword('');
    try {
      const res = await api('/workspace/knowledge/sync', { method: 'POST', body: { mailboxId, password: transient, includeEmail } });
      setItems((prev) => [...prev.filter((entry) => entry.mailboxId !== mailboxId), res.item]);
      if (res.graphStatus?.degraded) {
        setError('Snapshot saved. Neo4j is temporarily unavailable; graph projection will retry.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyQoderBrief() {
    if (!qoderBrief?.ok) return;
    setQoderCopyError('');
    const ok = await copyText(qoderBrief.markdown);
    if (!ok) setQoderCopyError('Could not copy to clipboard. Try Download brief instead.');
  }

  function downloadQoderBrief() {
    if (!qoderBrief?.ok) return;
    setQoderCopyError('');
    const blob = new Blob([qoderBrief.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'qoder-task.md';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await api(`/workspace/knowledge/${mailboxId}`, { method: 'DELETE' });
      setItems((prev) => prev.filter((entry) => entry.mailboxId !== mailboxId));
      setSelected(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (bootLoading) {
    return (
      <section className="card workspace-knowledge">
        <SectionTitle title="Connected workspace graph" sub="See how your mailbox, calendar, files and suggested actions relate." />
        <Spinner label="Loading workspace knowledge…" />
      </section>
    );
  }

  return (
    <section className="card workspace-knowledge">
      <SectionTitle title="Connected workspace graph" sub="See how your mailbox, calendar, files and suggested actions relate." />
      <p className="muted">
        Sync stores event titles and times, file names and sizes, and optional email subjects, senders and suggested-action excerpts.
        File contents and calendar descriptions are excluded. Your mailbox password is never saved.
      </p>

      {error ? <Banner tone="warn">{error}</Banner> : null}

      {mailboxes.length ? (
        <form onSubmit={sync} className="stack workspace-form">
          <label>
            Mailbox
            <select value={mailboxId} onChange={(event) => { setMailboxId(event.target.value); setPassword(''); }} disabled={busy}>
              {mailboxes.map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.address}</option>)}
            </select>
          </label>
          <label>
            Mailbox password for this sync
            <input type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} />
          </label>
          <label className="checkline">
            <input type="checkbox" checked={includeEmail} onChange={(event) => setIncludeEmail(event.target.checked)} disabled={busy} />
            Analyze my latest 20 inbox messages for suggested actions and resource mentions
          </label>
          <span className="faint">Leave unchecked to refresh calendar and files while keeping saved email insights.</span>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Reading workspace…' : 'Sync workspace graph'}</button>
            {item ? <button type="button" className="btn" disabled={busy} onClick={disconnect}>Remove saved snapshot</button> : null}
          </div>
        </form>
      ) : (
        <EmptyState title="Create a mailbox to connect" icon="✉">
          Create a mailbox first, then connect its calendar and files here.
        </EmptyState>
      )}

      {item ? (
        <div className="workspace-snapshot stack">
          <p className="muted snapshot-meta">
            Last synced {fmtDateTime(item.syncedAt)} · {item.calendars.length} calendars · {item.events.length} events · {item.files.length} files · {item.emails.length} emails · {item.actions.length} suggestions
          </p>
          {item.emailAnalyzed ? (
            <p className="faint">Email analysis last refreshed {fmtDateTime(item.emailSyncedAt || item.syncedAt)}.</p>
          ) : (
            <p className="faint">Email analysis not included in this snapshot. Check the box above to analyze inbox messages.</p>
          )}
          <p className="faint">
            Snapshot, not continuous sync. Calendar: past 7 and next 30 days, up to 3 calendars and 50 events each; recurring series are not expanded.
            Files: first 200 in the root folder. Email: latest 20 in Inbox; messages over 256 KB are skipped ({item.skippedLargeEmails || 0} skipped).
          </p>
          <p className="muted">Files storage used: {item.storage.usedBytes == null ? 'Not reported' : fmtBytes(item.storage.usedBytes)}</p>

          {contextIds.size > 0 ? (
            <div className="actions workspace-view-toggle">
              <button type="button" className={`btn btn-sm${!showAll ? ' btn-primary' : ''}`} onClick={() => setShowAll(false)}>Action context</button>
              <button type="button" className={`btn btn-sm${showAll ? ' btn-primary' : ''}`} onClick={() => setShowAll(true)}>All resources</button>
            </div>
          ) : null}

          <div className="workspace-graph-section stack">
            {friendlyGraph ? <h4 className="workspace-graph-heading">Suggested connections</h4> : null}
            <p className="faint">
              {friendlyGraph
                ? 'Select a card for details.'
                : 'Select a node for details. Scroll the graph horizontally to explore larger snapshots.'}
            </p>
            {graphState.loading ? (
              <Spinner label="Loading workspace graph…" />
            ) : graphState.error && !graphState.graph ? (
              <Banner tone="warn">Could not load the workspace graph: {graphState.error}</Banner>
            ) : (
              <GraphView
                graph={visibleGraph}
                degraded={graphState.degraded}
                selectedId={selected?.id}
                onSelect={setSelected}
                friendly={friendlyGraph}
                emptyTitle="No workspace nodes yet"
                emptyChildren="Sync the workspace graph to project calendar, files, and email suggestions here."
              />
            )}
            {graphState.degraded && graphState.graph ? (
              <p className="faint">Graph projection is degraded. Your saved snapshot is still available above.</p>
            ) : null}
          </div>

          {selected ? (
            <div className="card workspace-node-detail">
              <div className="row spread">
                <strong className="detail-title">{selected.name || selected.address}</strong>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSelected(null)} aria-label="Close node details">Close</button>
              </div>
              <p className="muted">{workspaceNodeTitle(selected.type)}</p>
              <dl className="kv graph-detail-fields">
                {workspaceNodeDetails(selected).map(({ label, value }) => (
                  <React.Fragment key={label}>
                    <dt>{label}</dt>
                    <dd>{value || '—'}</dd>
                  </React.Fragment>
                ))}
              </dl>
              {sourceEmail ? (
                <p className="faint">
                  Source email: {sourceEmail.sender || 'unknown sender'} · {sourceEmail.name} · {fmtDateTime(sourceEmail.date)}
                </p>
              ) : null}
              {(selected.sourceUrl || sourceEmail?.sourceUrl) ? (
                <a href={selected.sourceUrl || sourceEmail.sourceUrl} target="_blank" rel="noopener noreferrer">Open source email</a>
              ) : null}
              {isQoderHandoffType(selected.type) ? (
                <div className="qoder-handoff stack">
                  <div className="actions qoder-handoff-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setQoderOpen((open) => !open)}
                      aria-expanded={qoderOpen}
                    >
                      {qoderOpen ? 'Hide Qoder brief' : 'Prepare for Qoder'}
                    </button>
                  </div>
                  {qoderOpen && qoderBrief?.ok ? (
                    <div className="qoder-handoff-preview stack">
                      <p className="faint">
                        This preview includes the selected subject and related resource names from your workspace graph.
                        Review the brief before sharing — message bodies, senders, and credentials are excluded.
                      </p>
                      <pre className="codeblock qoder-handoff-markdown" aria-label="Qoder task brief preview">{qoderBrief.markdown}</pre>
                      <div className="actions qoder-handoff-actions">
                        <button type="button" className="btn btn-sm btn-primary" onClick={copyQoderBrief}>Copy brief</button>
                        <button type="button" className="btn btn-sm" onClick={downloadQoderBrief}>Download brief</button>
                      </div>
                      {qoderCopyError ? <Banner tone="bad">{qoderCopyError}</Banner> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {item.emailAnalyzed ? (
            <div className="workspace-actions stack">
              <h3>Suggested actions</h3>
              <p className="faint">
                Rule-based analysis; review the source before acting. Mention links are possible references, not confirmed matches.
                Nothing is sent, scheduled or changed automatically.
              </p>
              {item.actions.length ? item.actions.map((action) => {
                const email = item.emails.find((entry) => entry.id === action.emailId);
                return (
                  <div className="card workspace-action-card" key={action.id}>
                    <div className="row spread workspace-action-head">
                      <strong>{action.name}</strong>
                      <Chip tone="warn">{fmtConfidence(action.confidence || 'needs_review')}</Chip>
                    </div>
                    <p className="muted">{action.deadlineText || 'No explicit deadline detected'}</p>
                    {email ? (
                      <p className="faint">
                        From {email.sender || 'unknown sender'} · {email.name} · {fmtDateTime(email.date)}
                      </p>
                    ) : null}
                    {email?.sourceUrl ? (
                      <a href={email.sourceUrl} target="_blank" rel="noopener noreferrer">Review source email</a>
                    ) : null}
                  </div>
                );
              }) : <p className="muted">No suggested actions found in this snapshot.</p>}
            </div>
          ) : null}
        </div>
      ) : mailboxes.length ? (
        <EmptyState title="No saved snapshot yet" icon="◌">
          Enter your mailbox password and sync to capture calendar, files, and optional email suggestions.
        </EmptyState>
      ) : null}
    </section>
  );
}
