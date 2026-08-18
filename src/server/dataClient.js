// Thin authenticated fetch wrapper for the data API (server/routes/dataApi.mjs).
// No credentials live here — in development the server resolves the
// principal from a fixed header/default automatically (see server/auth.mjs);
// this client never invents or overrides ownership fields, only ever reading
// server-computed IDs back from responses.

const DEFAULT_TIMEOUT_MS = 8000;

export class DataApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'DataApiError';
    this.status = status;
    this.code = code;
  }
}

export function createDataClient({ baseUrl = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  async function request(method, path, body, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {};
      if (body != null) headers['Content-Type'] = 'application/json';
      // Stable idempotency key: the server's operation ledger (tenant-scoped)
      // replays the recorded result for a retried operationId instead of
      // re-executing the mutation (see server/routes/dataApi.mjs).
      if (options.operationId) headers['X-Roma-Operation-Id'] = String(options.operationId);
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (!response.ok) throw new DataApiError(json.error ?? `Request failed (${response.status}).`, { status: response.status, code: json.code });
      return json;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body, options) => request('POST', path, body ?? {}, options),
    patch: (path, body, options) => request('PATCH', path, body ?? {}, options),
    del: (path, options) => request('DELETE', path, null, options),
  };
}
