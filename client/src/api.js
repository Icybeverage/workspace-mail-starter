const BASE = import.meta.env.BASE_URL;

export class ApiError extends Error {
  constructor(status, code, message, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(`${BASE}api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || (json && json.ok === false)) {
    const err = (json && json.error) || {};
    throw new ApiError(res.status, err.code || 'request_failed', err.message || `Request failed (${res.status}).`, json);
  }
  return json;
}

export function apiBase() {
  return BASE;
}
