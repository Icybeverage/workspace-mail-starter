import React from 'react';
import { cx, fmtRelative, fmtDateTime } from '../util.js';

const TONES = {
  'domain.created': 'info',
  'domain.verified': 'ok',
  'domain.plan.created': 'info',
  'domain.plan.manual': 'warn',
  'domain.activated': 'ok',
  'domain.activate_blocked': 'bad',
  'mailbox.created': 'ok',
  'mailbox.creating': 'info',
  'mailbox.uncertain': 'warn',
  'mailbox.reconciled': 'info',
  'mailbox.failed': 'bad',
  'mailbox.collision': 'bad',
  'check.run': 'info',
  'cloudflare.applied': 'ok',
  'cloudflare.apply_failed': 'bad',
  'cloudflare.verify_record': 'info',
  'agent.run': 'pending',
  'mailserver.zone': 'info'
};

export default function Timeline({ items, emptyLabel = 'No activity yet.' }) {
  if (!items || items.length === 0) {
    return <p className="muted">{emptyLabel}</p>;
  }
  return (
    <div className="timeline">
      {items.map((item) => (
        <div className="timeline-item" key={item.id}>
          <span className={cx('tl-dot', TONES[item.kind] || '')} aria-hidden="true" />
          <div className="tl-body">
            <span className="tl-message">{item.message}</span>
            <span className="tl-meta">
              <span className="mono">{item.kind}</span>
              {item.domain ? <span>· {item.domain}</span> : null}
              <span title={fmtDateTime(item.createdAt)}>· {fmtRelative(item.createdAt)}</span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
