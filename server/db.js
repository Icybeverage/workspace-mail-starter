import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_knowledge (
  tenant_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, mailbox_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  ownership_method TEXT,
  verify_token TEXT,
  verified_at TEXT,
  cf_token_enc TEXT,
  cf_zone_id TEXT,
  cf_zone_name TEXT,
  last_plan_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_domains_tenant ON domains(tenant_id);

CREATE TABLE IF NOT EXISTS relay_auth (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  domain_id TEXT NOT NULL UNIQUE REFERENCES domains(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_domain_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL,
  dns_records_json TEXT NOT NULL,
  error_message TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_auth_tenant ON relay_auth(tenant_id);

CREATE TABLE IF NOT EXISTS dns_plans (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  plan_hash TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  records_json TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  conflicts_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  status TEXT NOT NULL,
  approved_mx_hash TEXT,
  approved_at TEXT,
  applied_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_domain ON dns_plans(domain_id, version DESC);

CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  local_part TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  job_id TEXT,
  upstream_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_domain_local ON mailboxes(domain_id, local_part);
CREATE INDEX IF NOT EXISTS idx_mailboxes_tenant ON mailboxes(tenant_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  domain_id TEXT,
  mailbox_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  domain_id TEXT,
  mailbox_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  details_json TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checks_domain ON checks(domain_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS setup_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  target_check TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_domain ON setup_actions(domain_id);

CREATE TABLE IF NOT EXISTS cf_backups (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  zone_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_name TEXT NOT NULL,
  prior_json TEXT,
  applied_at TEXT NOT NULL
);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function migrate(db) {
  db.exec(SCHEMA);
  const current = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (!current) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  } else if (Number(current.value) < SCHEMA_VERSION) {
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
  }
  return db;
}

export function initDb(dbPath) {
  const db = openDb(dbPath);
  migrate(db);
  return db;
}

export function tx(db, fn) {
  return db.transaction(fn)();
}

// Hosted domain is shared across accounts; it is owned by the internal system tenant.
export const SYSTEM_TENANT_ID = 'system';

export function ensureHostedDomain(db, hostedDomain) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM domains WHERE name = ?').get(hostedDomain);
  if (existing) return existing;
  const row = {
    id: 'dom_hosted',
    tenant_id: SYSTEM_TENANT_ID,
    name: hostedDomain,
    kind: 'hosted',
    status: 'managed',
    ownership_method: 'hosted',
    verify_token: null,
    verified_at: now,
    cf_token_enc: null,
    cf_zone_id: null,
    cf_zone_name: null,
    last_plan_id: null,
    created_at: now,
    updated_at: now
  };
  db.prepare(`INSERT INTO domains (id, tenant_id, name, kind, status, ownership_method, verify_token, verified_at,
      cf_token_enc, cf_zone_id, cf_zone_name, last_plan_id, created_at, updated_at)
    VALUES (@id, @tenant_id, @name, @kind, @status, @ownership_method, @verify_token, @verified_at,
      @cf_token_enc, @cf_zone_id, @cf_zone_name, @last_plan_id, @created_at, @updated_at)`).run(row);
  return db.prepare('SELECT * FROM domains WHERE id = ?').get(row.id);
}

export function recordActivity(db, { tenantId, domainId = null, mailboxId = null, kind, message, data = null }) {
  db.prepare(`INSERT INTO activity (id, tenant_id, domain_id, mailbox_id, kind, message, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(cryptoRandomId(), tenantId, domainId, mailboxId, kind, message, data ? JSON.stringify(data) : null, new Date().toISOString());
}

export function cryptoRandomId() {
  return crypto.randomUUID();
}
