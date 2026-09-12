// Secret hygiene for the Workspace verification harness.
// Reports must never contain passwords, cookies, tokens, private env values,
// raw auth responses, or other users' data. This module provides:
//   - scrubProcessEnv: remove credential-looking variables from process.env so
//     neither the harness nor its child processes can inherit real secrets.
//   - makeSecretVault: a registry of concrete secret values seen at runtime;
//     used to redact them from any string and to self-audit final reports.
//   - redactDeep: key-based + value-based redaction over report structures.

const REDACTED = '[redacted]';

// Keys whose values must never enter a report, by name pattern.
const SECRET_KEY_RE = /(password|passwd|pass\b|secret|token|cookie|authorization|credential|api[-_]?key|vault|session)/i;

// process.env keys that are stripped before anything runs. Provider settings
// (MAIL_SERVER_*, NEO4J_*, LLM_*) and anything credential-looking are removed so the
// harness always runs on explicit fixtures, never ambient credentials.
const SECRET_ENV_KEY_RE = /^(MAIL_SERVER_|NEO4J_|LLM_|WORKSPACE_TEST_|CF_|CLOUDFLARE_|VAULT_KEY|SESSION_)|(PASS|SECRET|TOKEN|COOKIE|CREDENTIAL|API_KEY)/i;

export function envKeyIsSensitive(key) {
  return SECRET_ENV_KEY_RE.test(key);
}

export function scrubProcessEnv(env = process.env) {
  const removed = [];
  for (const key of Object.keys(env)) {
    if (envKeyIsSensitive(key)) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

export function makeSecretVault() {
  const secrets = new Set();

  function register(value) {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    // Very short strings would redact harmless substrings; ignore them.
    if (trimmed.length < 4) return;
    secrets.add(trimmed);
  }

  function sanitizeText(text) {
    let out = text;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  }

  function redactDeep(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return sanitizeText(value);
    if (Array.isArray(value)) return value.map(redactDeep);
    if (typeof value === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(value)) {
        out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactDeep(val);
      }
      return out;
    }
    if (typeof value === 'function') return '[function]';
    return value;
  }

  // Self-audit: find any registered secret that still occurs in serialized output.
  function audit(text) {
    const leaks = [];
    for (const secret of secrets) {
      if (text.includes(secret)) leaks.push(secret);
    }
    return leaks;
  }

  return { register, sanitizeText, redactDeep, audit, get size() { return secrets.size; } };
}

export function sanitizeError(err, vault) {
  const raw = err instanceof Error ? (err.stack || err.message || String(err)) : String(err);
  const text = vault ? vault.sanitizeText(String(raw)) : String(raw);
  const capped = text.length > 2000 ? `${text.slice(0, 2000)}…[truncated]` : text;
  return capped;
}

// Environment summary that is safe to embed in reports: booleans only, never values.
export function envPresenceSummary(keys) {
  const out = {};
  for (const key of keys) out[key] = process.env[key] !== undefined ? 'set' : 'unset';
  return out;
}
