import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseDotEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadDotEnv(file = path.join(ROOT_DIR, '.env')) {
  try {
    if (!fs.existsSync(file)) return;
    const parsed = parseDotEnv(fs.readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is best-effort; never log its contents.
  }
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function normalizeBasePath(raw) {
  let bp = String(raw || '/launch').trim();
  if (!bp.startsWith('/')) bp = `/${bp}`;
  if (bp.length > 1 && bp.endsWith('/')) bp = bp.slice(0, -1);
  return bp === '/' ? '' : bp;
}

function parseVaultKey(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) buf = Buffer.from(trimmed, 'hex');
  else {
    try {
      buf = Buffer.from(trimmed, 'base64');
    } catch {
      buf = null;
    }
  }
  if (!buf || buf.length !== 32) return { error: 'VAULT_KEY must decode to 32 bytes (hex or base64)' };
  return buf;
}

const DEFAULT_RESERVED = [
  'admin', 'administrator', 'product', 'postmaster', 'abuse', 'support',
  'security', 'hostmaster', 'webmaster', 'root', 'mailer-daemon', 'noreply',
  'no-reply', 'info', 'billing', 'help', 'mail', 'email', 'dns', 'mx',
  'notifications', 'alerts', 'team', 'teams', 'sales', 'contact'
];

export function loadConfig(overrides = {}) {
  if (!overrides.skipDotEnv) loadDotEnv();

  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';
  const basePath = normalizeBasePath(process.env.BASE_PATH ?? '/launch');
  const dataDir = path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data');

  const mailserverBaseUrl = (process.env.MAIL_SERVER_BASE_URL || 'https://mail.example.test/admin').replace(/\/+$/, '');
  let mailserverHost = 'mail.example.test';
  try {
    mailserverHost = new URL(mailserverBaseUrl).hostname;
  } catch {
    // keep default
  }

  const vault = parseVaultKey(process.env.VAULT_KEY);

  const config = {
    nodeEnv,
    isProd,
    port: intEnv('PORT', 3210),
    host: process.env.HOST || '127.0.0.1',
    basePath,
    appOrigin: process.env.APP_ORIGIN || '',
    extraOrigins: (process.env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    dataDir,
    dbPath: process.env.DB_PATH || path.join(dataDir, 'workspace.sqlite'),
    sessionTtlDays: intEnv('SESSION_TTL_DAYS', 14),

    mailserver: {
      baseUrl: mailserverBaseUrl,
      username: process.env.MAIL_SERVER_USERNAME || '',
      password: process.env.MAIL_SERVER_PASSWORD || '',
      timeoutMs: intEnv('MAIL_SERVER_TIMEOUT_MS', 15000),
      mailHost: process.env.MAIL_SERVER_MAIL_HOST || mailserverHost
    },

    relay: {
      provider: String(process.env.WORKSPACE_RELAY_PROVIDER || '').trim().toLowerCase(),
      apiKey: process.env.SENDGRID_API_KEY || '',
      apiBase: (process.env.SENDGRID_API_BASE || 'https://api.sendgrid.com/v3').replace(/\/+$/, ''),
      timeoutMs: intEnv('SENDGRID_TIMEOUT_MS', 10000)
    },

    hostedDomain: (process.env.HOSTED_DOMAIN || 'example.test').toLowerCase(),
    mailboxLimitPerAccount: intEnv('MAILBOX_LIMIT_PER_ACCOUNT', 1),
    globalMailboxCap: intEnv('GLOBAL_MAILBOX_CAP', 50),
    reservedLocalparts: (process.env.RESERVED_LOCALPARTS || DEFAULT_RESERVED.join(','))
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

    neo4j: {
      uri: process.env.NEO4J_URI || '',
      username: process.env.NEO4J_USERNAME || 'neo4j',
      password: process.env.NEO4J_PASSWORD || ''
    },

    vaultKey: vault instanceof Buffer ? vault : null,
    vaultKeyError: vault && vault.error ? vault.error : null,

    cloudflareApiBase: 'https://api.cloudflare.com/client/v4',

    llm: {
      baseUrl: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
      apiKey: process.env.LLM_API_KEY || '',
      model: process.env.LLM_MODEL || ''
    },

    rateLimits: {
      login: { limit: intEnv('RATE_LOGIN_LIMIT', 10), windowMs: 15 * 60 * 1000 },
      signup: { limit: intEnv('RATE_SIGNUP_LIMIT', 5), windowMs: 60 * 60 * 1000 },
      mailboxCreate: { limit: intEnv('RATE_MAILBOX_LIMIT', 10), windowMs: 60 * 60 * 1000 },
      provision: { limit: intEnv('RATE_PROVISION_LIMIT', 30), windowMs: 60 * 60 * 1000 },
      agent: { limit: intEnv('RATE_AGENT_LIMIT', 20), windowMs: 60 * 60 * 1000 },
      inspect: { limit: intEnv('RATE_INSPECT_LIMIT', 60), windowMs: 60 * 60 * 1000 }
    }
  };

  return Object.assign(config, overrides, overrides.skipDotEnv ? {} : {});
}

export function mailserverConfigured(config) {
  return Boolean(config.mailserver.baseUrl && config.mailserver.username && config.mailserver.password);
}

export function llmConfigured(config) {
  return Boolean(config.llm.baseUrl && config.llm.apiKey && config.llm.model);
}
