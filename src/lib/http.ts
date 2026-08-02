/** Error carrying the HTTP status so callers can special-case rate limits. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** True for HTTP 429 — refresh treats this as "keep the previous payload". */
  get isRateLimit(): boolean {
    return this.status === 429;
  }
}

/** Fetch JSON, throwing HttpError on non-2xx responses. */
export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} for ${stripKeys(url)}`);
  return (await res.json()) as T;
}

/** Fetch raw text (CSV, XML), throwing HttpError on non-2xx responses. */
export async function getText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} for ${stripKeys(url)}`);
  return await res.text();
}

/** POST a JSON body and parse a JSON response (OpenFIGI's mapping endpoint). */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} for ${stripKeys(url)}`);
  return (await res.json()) as T;
}

/**
 * Keep the FRED key out of thrown messages. Worker exceptions land in
 * `wrangler tail` and the observability dashboard, so an unscrubbed URL would
 * leak the secret into logs the moment a series 404s.
 */
export function stripKeys(url: string): string {
  return url.replace(/([?&](apikey|api_key|token)=)[^&]+/gi, '$1***');
}

/** Small delay used to stay inside SEC's fair-access rate. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff, but only for throttling.
 *
 * Yahoo hands out 429s readily — a single IP doing a handful of chart requests
 * can trip it — and since the market payload is rebuilt once a day, one refused
 * request would otherwise mean a full day of stale prices. Retrying a 404 or a
 * parse failure would just waste the cron's time, so those fail immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 2000 } = {},
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const retryable = e instanceof HttpError && (e.isRateLimit || e.status >= 500);
      if (!retryable || i === attempts - 1) throw e;
      await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw lastError;
}
