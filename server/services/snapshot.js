const ACTION_TO_RECORD_STATE = {
  keep: 'configured',
  create: 'missing',
  update: 'mismatch',
  conflict: 'conflict',
  pending_upstream: 'pending',
  managed: 'managed'
};

const CHECK_TO_RECORD_STATE = {
  pass: 'configured',
  warn: 'mismatch',
  fail: 'failed',
  pending: 'pending',
  unknown: 'unknown',
  managed: 'managed'
};

function scopeForRecordKey(key) {
  const prefix = String(key).split(':')[0];
  return ['mx', 'spf', 'dkim', 'dmarc', 'relay'].includes(prefix) ? prefix : null;
}

export function createSnapshotBuilder({ db }) {
  return function buildSnapshot(tenantId) {
    const domains = db.prepare(`
      SELECT * FROM domains WHERE tenant_id = ? OR kind = 'hosted' ORDER BY created_at ASC
    `).all(tenantId);

    const mailboxes = db.prepare(`
      SELECT m.* FROM mailboxes m
      JOIN domains d ON d.id = m.domain_id
      WHERE m.tenant_id = ? AND (d.tenant_id = ? OR d.kind = 'hosted')
    `).all(tenantId, tenantId);

    const records = [];
    const checks = [];
    const actions = [];

    const latestCheckStmt = db.prepare(`
      SELECT c.* FROM checks c
      JOIN (SELECT scope, MAX(checked_at) AS latest FROM checks WHERE domain_id = ? GROUP BY scope) l
        ON l.scope = c.scope AND l.latest = c.checked_at
      WHERE c.domain_id = ?
    `);

    for (const d of domains) {
      const plan = db.prepare('SELECT * FROM dns_plans WHERE domain_id = ? ORDER BY version DESC LIMIT 1').get(d.id);
      const latestChecks = latestCheckStmt.all(d.id, d.id);
      const checkByScope = new Map(latestChecks.map((c) => [c.scope, c]));

      for (const c of latestChecks) {
        checks.push({
          localId: `${d.id}:${c.scope}`,
          domainId: d.id,
          scope: c.scope,
          status: c.status,
          checkedAt: c.checked_at
        });
      }

      if (plan) {
        for (const rec of JSON.parse(plan.records_json)) {
          const scope = scopeForRecordKey(rec.key);
          const check = scope ? checkByScope.get(scope) : null;
          const state = check && CHECK_TO_RECORD_STATE[check.status]
            ? CHECK_TO_RECORD_STATE[check.status]
            : (ACTION_TO_RECORD_STATE[rec.action] || 'unknown');
          const linkedCheck = checks.find((c) => c.domainId === d.id && c.scope === scope);
          if (linkedCheck) linkedCheck.recordId = `${d.id}:${rec.key}`;
          records.push({
            localId: `${d.id}:${rec.key}`,
            domainId: d.id,
            name: rec.name,
            type: rec.type,
            state
          });
        }
      } else {
        for (const scope of ['ownership','mx','spf','dkim','dmarc','relay']) {
          const check=checkByScope.get(scope);
          const recId=`${d.id}:${scope}`;
          const linked=checks.find((c)=>c.domainId===d.id && c.scope===scope);
          if(linked) linked.recordId=recId;
          records.push({localId:recId,domainId:d.id,name:scope==='mx'||scope==='spf'?'@':scope==='dkim'?'mail._domainkey':scope==='dmarc'?'_dmarc':scope==='relay'?'relay':'_workspace-verify',type:scope==='mx'?'MX':'TXT',state:check?CHECK_TO_RECORD_STATE[check.status]||'unknown':scope==='ownership'&&(d.verified_at||d.kind==='hosted')?'configured':'unknown'});
        }
      }

      for (const a of db.prepare('SELECT * FROM setup_actions WHERE domain_id = ? AND tenant_id = ?').all(d.id, tenantId)) {
        actions.push({
          id: a.id,
          domain_id: a.domain_id,
          kind: a.kind,
          status: a.status,
          target_check: a.target_check
        });
      }
    }

    const workspace = db.prepare('SELECT * FROM workspace_knowledge WHERE tenant_id = ?').all(tenantId)
      .filter((row) => mailboxes.some((m) => m.id === row.mailbox_id))
      .map((row) => ({mailboxId:row.mailbox_id,domainId:mailboxes.find((m) => m.id === row.mailbox_id).domain_id,data:JSON.parse(row.data_json)}));
    return { domains, mailboxes, records, checks, actions, workspace };
  };
}
