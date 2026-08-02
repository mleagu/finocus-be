/** Bindings declared in wrangler.jsonc, plus secrets set with `wrangler secret put`. */
export interface Env {
  /** KV namespace holding every precomputed payload. */
  CACHE: KVNamespace;
  /** FRED API key — `wrangler secret put FRED_API_KEY`. Never commit it. */
  FRED_API_KEY: string;
  /**
   * Contact string sent to SEC as `User-Agent`, e.g. "Finocus Research
   * contact@example.com" — `wrangler secret put SEC_USER_AGENT`.
   *
   * A secret because it is a personal contact address, not because it is
   * sensitive: SEC's fair-access policy requires a REAL address and 403s
   * requests without one, so it is load-bearing and cannot be blanked. Optional
   * in the type so a missing value fails loudly at runtime with a usable
   * message rather than silently.
   */
  SEC_USER_AGENT?: string;
  /**
   * Optional shared secret. When set, POST /admin/refresh requires it as a
   * bearer token, so the expensive refresh can't be triggered by strangers.
   */
  ADMIN_TOKEN?: string;
}
