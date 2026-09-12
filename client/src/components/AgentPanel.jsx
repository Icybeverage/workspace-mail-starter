import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Banner, Chip, Spinner } from './Bits.jsx';
import { cx, fmtRelative } from '../util.js';

export default function AgentPanel({ domainId }) {
  const [info, setInfo] = useState(null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api('/agent/info').then((r) => { if (alive) setInfo(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    setQuestion('');
    setResult(null);
    setError(null);
  }, [domainId]);

  async function run(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api('/agent/ask', { method: 'POST', body: { domainId, question } });
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field" style={{ gap: 14 }}>
      <div className="row-tight">
        <Chip tone={info?.mode === 'ai_assisted' ? 'info' : 'plain'}>
          {info?.mode === 'ai_assisted' ? 'AI-assisted explanation' : 'Rule-based setup assistant'}
        </Chip>
        <span className="faint">{info ? info.modeNote : 'Checking assistant mode…'}</span>
      </div>
      <form className="field" onSubmit={run} style={{ gap: 10 }}>
        <label htmlFor="agent-q">Ask about this domain</label>
        <textarea
          id="agent-q"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Why is activation blocked? What should I do next?"
          maxLength={500}
          style={{ minHeight: 60 }}
        />
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy || !question.trim()} aria-busy={busy}>
            {busy ? <Spinner label="Checking your setup…" /> : 'Run setup assistant'}
          </button>
          <span className="faint">Reads current results only; it does not change DNS or mailboxes.</span>
        </div>
      </form>

      {error ? <Banner tone="bad">{error}</Banner> : null}

      {result ? (
        <div className="field" style={{ gap: 12 }}>
          <div className="row-tight">
            <Chip tone={result.mode === 'ai_assisted' ? 'info' : 'plain'}>
              {result.mode === 'ai_assisted' ? 'AI-assisted' : 'Rule-based'}
            </Chip>
            <span className="faint">{result.modeNote}</span>
          </div>
          <p className="muted assistant-answer">{result.answer}</p>

          {result.steps && result.steps.length ? (
            <div className="timeline" aria-label="Assistant tool trace">
              {result.steps.map((s, i) => (
                <div className="timeline-item" key={`${s.tool}-${i}`}>
                  <span className={cx('tl-dot', s.status === 'degraded' ? 'warn' : 'ok')} aria-hidden="true" />
                  <div className="tl-body">
                    <span className="tl-message"><span className="mono">{s.tool}</span> — {s.summary}</span>
                    <span className="tl-meta">
                      {s.source ? <span>source: {s.source}</span> : null}
                      <span>· {fmtRelative(s.at)}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {result.suggestions && result.suggestions.length ? (
            <div className="field">
              <span className="faint">Suggested actions</span>
              <ul className="list-plain">
                {result.suggestions.map((s) => (
                  <li key={s.id} className="row-tight">
                    <Chip tone="info">{s.id}</Chip>
                    <span className="muted">{s.label} — {s.why}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {result.applyNote ? <p className="faint">{result.applyNote}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
