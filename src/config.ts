/**
 * Upstream endpoints and fetch policy.
 *
 * Note what is NOT here: API keys. The client app embedded its FRED key in the
 * bundle (Option A in the Finocus plan); this Worker is Option B, so the key
 * lives in a Worker secret and arrives via `Env`. Nothing in this repo should
 * ever hold a credential literal.
 */
export const API_BASE_URLS = {
  stooq: 'https://stooq.com',
  yahoo: 'https://query1.finance.yahoo.com',
  fred: 'https://api.stlouisfed.org/fred',
  secData: 'https://data.sec.gov',
  secArchives: 'https://www.sec.gov/Archives',
  openFigi: 'https://api.openfigi.com/v3',
  tradingViewCalendar: 'https://economic-calendar.tradingview.com',
} as const;

/**
 * Contact string SEC requires from automated clients.
 *
 * SEC rejects requests that don't identify themselves with a contact address,
 * and 403s an empty User-Agent outright. In the app this header was dead weight
 * (browsers forbid setting it); here it is load-bearing, because the Worker
 * really is the automated client SEC's fair-access policy is about.
 *
 * It lives in a secret rather than this file because it is a personal address
 * that would otherwise sit in git forever. Throwing on a missing value is
 * deliberate: the alternative is every SEC request 403ing with no indication
 * why, and the refresh loop swallowing it as an ordinary upstream failure.
 */
export function secUserAgent(env: { SEC_USER_AGENT?: string }): string {
  const ua = env.SEC_USER_AGENT?.trim();
  if (!ua) {
    throw new Error(
      'SEC_USER_AGENT is not set. SEC 403s requests without a contact address — ' +
        'run: npx wrangler secret put SEC_USER_AGENT',
    );
  }
  return ua;
}

/** SEC asks for no more than 10 requests/second. We stay well under. */
export const SEC_REQUEST_GAP_MS = 150;
