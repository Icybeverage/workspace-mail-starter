import React, { useState } from 'react';
import { api } from '../api.js';
import { Banner, Wordmark, PasswordField, Spinner } from '../components/Bits.jsx';
import { cx } from '../util.js';

export default function AuthPage({ onAuthed, bootError }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api(`/auth/${mode}`, { method: 'POST', body: { email, password } });
      await onAuthed(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <Wordmark />
          <p className="muted">Set up your business email with confidence.</p>
        </div>

        <div className="card auth-form-card" style={{ gap: 18 }}>
          <div className="auth-tabs" role="tablist" aria-label="Sign in or create an account">
            <button
              type="button"
              role="tab"
              className="auth-tab"
              aria-selected={mode === 'login'}
              onClick={() => { setMode('login'); setError(null); }}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              className="auth-tab"
              aria-selected={mode === 'signup'}
              onClick={() => { setMode('signup'); setError(null); }}
            >
              Create account
            </button>
          </div>

          {bootError ? <Banner tone="bad">{bootError}</Banner> : null}
          {error ? <Banner tone="bad">{error}</Banner> : null}

          <form className="field" style={{ gap: 14 }} onSubmit={submit} aria-busy={busy}>
            <div className="field">
              <label htmlFor="auth-email">App account email</label>
              <input
                id="auth-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
              />
            </div>
            <PasswordField
              id="auth-password"
              label="App account password"
              value={password}
              onChange={setPassword}
              showGenerate={false}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              hint={mode === 'signup' ? 'At least 10 characters. This is separate from any mailbox password you create later.' : undefined}
            />
            <button type="submit" className={cx('btn', 'btn-primary')} disabled={busy || !email || !password} aria-busy={busy}>
              {busy ? <Spinner label={mode === 'login' ? 'Signing in…' : 'Creating account…'} /> : (mode === 'login' ? 'Sign in' : 'Create account')}
            </button>
          </form>

          <div className="hr" />
          <p className="auth-note">
            Accounts sign up instantly — no operator approval needed. Email-based password recovery is not implemented yet,
            so keep your password safe. Mailbox passwords are separate and handled only by the mail server.
          </p>
        </div>
      </div>
    </div>
  );
}
