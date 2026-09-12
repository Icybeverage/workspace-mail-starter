import { BRAND_NAME } from '../brand.js';
import React, { useState } from 'react';
import { cx, copyText, generatePassword } from '../util.js';

export function Logo({ size = 38 }) {
  return (
    <svg className="pixel-cloud" width={size} height={size * .8} viewBox="0 0 40 32" role="img" aria-label="Pixel cloud" shapeRendering="crispEdges">
      <path fill="currentColor" d="M12 4h12v4h4v4h8v4h4v12H0V16h4v-4h8Z" />
      <path fill="#82adff" d="M4 28h32v4H4z" />
    </svg>
  );
}

export function Wordmark() {
  return <div className="brand" aria-label={BRAND_NAME}><Logo /><span className="brand-name">{BRAND_NAME.toUpperCase()}</span></div>;
}

export function Chip({ tone = 'plain', children, title }) {
  return (
    <span className={cx('chip', tone)} title={title}>
      {tone !== 'plain' ? <span className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function StatusChip({ map, status, title }) {
  const [label, tone] = map[status] || [status || 'unknown', 'plain'];
  return <Chip tone={tone} title={title}>{label}</Chip>;
}

export function Banner({ tone = 'info', children, icon = true }) {
  return (
    <div className={cx('banner', tone)} role={tone === 'bad' ? 'alert' : 'status'}>
      {icon ? <span aria-hidden="true">{tone === 'bad' ? '⚠' : tone === 'warn' ? '⚑' : tone === 'ok' ? '✓' : 'ℹ'}</span> : null}
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ title, children, action, icon = '◇' }) {
  return (
    <div className="empty">
      <div className="icon" aria-hidden="true" style={{ fontSize: 30 }}>{icon}</div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Spinner({ label = 'Working…' }) {
  return (
    <span className="row-tight" role="status" aria-live="polite">
      <span className="spin" aria-hidden="true" />
      <span className="spinner-label">{label}</span>
    </span>
  );
}

export function CopyButton({ text, label = 'Copy', small = true }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={cx('btn', 'btn-ghost', small && 'btn-sm')}
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }
      }}
      aria-label={copied ? 'Copied' : `${label}: ${text}`}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export function CodeLine({ children }) {
  return <div className="codeblock">{children}</div>;
}

export function PasswordField({ id, label, value, onChange, hint, autoComplete = 'new-password', showGenerate = true }) {
  const [visible, setVisible] = useState(false);
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-row">
        <input
          id={id}
          className="grow"
          type={visible ? 'text' : 'password'}
          value={value}
          autoComplete={autoComplete}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hintId}
          spellCheck={false}
        />
        <button
          type="button"
          className="btn btn-sm"
          aria-pressed={visible}
          aria-label={visible ? 'Hide password' : 'Show password'}
          title={visible ? 'Hide password' : 'Show password'}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
        {showGenerate ? (
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Generate a secure password"
            onClick={() => {
              onChange(generatePassword());
              setVisible(true);
            }}
          >
            Generate
          </button>
        ) : null}
      </div>
      {hint ? <span className="hint" id={hintId}>{hint}</span> : null}
    </div>
  );
}

export function SectionTitle({ title, sub, right }) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        {sub ? <p className="faint">{sub}</p> : null}
      </div>
      <span className="spacer" />
      {right}
    </div>
  );
}
