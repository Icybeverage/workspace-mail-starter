import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Banner, SectionTitle, Spinner } from '../components/Bits.jsx';
import Timeline from '../components/Timeline.jsx';

export default function ActivityPage({ data }) {
  const [items, setItems] = useState(null);
  const [domainId, setDomainId] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = domainId ? `&domainId=${encodeURIComponent(domainId)}` : '';
      const res = await api(`/activity?limit=150${q}`);
      setItems(res.items);
    } catch (err) {
      setError(err.message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [domainId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="page page-narrow">
      <div className="topbar">
        <h1>Activity</h1>
      </div>
      <p className="muted page-intro">
        A timeline of domain setup and mailbox changes. Passwords and tokens never appear here.
      </p>

      {error ? <Banner tone="bad">{error}</Banner> : null}

      <section className="card">
        <SectionTitle
          title="History"
          sub={loading ? 'Refreshing…' : `${items ? items.length : 0} event(s)`}
          right={(
            <div className="row-tight">
              <label className="faint" htmlFor="activity-domain">Filter</label>
              <select id="activity-domain" value={domainId} onChange={(e) => setDomainId(e.target.value)} style={{ width: 'auto' }}>
                <option value="">All domains</option>
                {(data.domains || []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
              <button type="button" className="btn btn-sm" onClick={load} disabled={loading}>
                {loading ? <Spinner label="Loading" /> : 'Refresh'}
              </button>
            </div>
          )}
        />
        {items === null ? <p className="muted">Loading…</p> : <Timeline items={items} emptyLabel="No activity for this filter yet." />}
      </section>
    </div>
  );
}
