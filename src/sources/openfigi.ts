import { API_BASE_URLS } from '../config';
import { postJson } from '../lib/http';

/**
 * CUSIP -> ticker resolution for 13F holdings.
 *
 * 13F reports securities by CUSIP only, so without this every holding would
 * render as a raw issuer string like "ALPHABET INC" with no way to link it to
 * price data. OpenFIGI is free and keyless (25 requests/minute, 10 identifiers
 * per request).
 *
 * It answers CORS preflight with allow-methods and allow-headers but no
 * allow-origin, so browsers reject it despite the 200 — hence the dev proxy on
 * web, which also has to forward the POST body.
 */

/** OpenFIGI caps unauthenticated requests at 10 identifiers each. */
const BATCH_SIZE = 10;

interface FigiRecord {
  ticker?: string;
  exchCode?: string;
  securityType?: string;
  name?: string;
}

type FigiResult = { data?: FigiRecord[]; warning?: string; error?: string };

/**
 * Foreign-domiciled securities carry a CINS, not a CUSIP — same 9 characters,
 * but with a letter in front (Chubb H1467J104, Accenture G1151C101). OpenFIGI
 * treats these as a *different identifier type*: querying them as ID_CUSIP
 * fails with "No identifier found" for every single one, while ID_CINS resolves
 * them cleanly. Getting this wrong silently drops the tickers for most of the
 * Ireland/Bermuda/Switzerland-domiciled S&P 500 names.
 */
export function idTypeFor(cusip: string): 'ID_CUSIP' | 'ID_CINS' {
  return /^[A-Za-z]/.test(cusip) ? 'ID_CINS' : 'ID_CUSIP';
}

/** Prefer the US composite listing; fall back to whatever came back first. */
export function pickTicker(result: FigiResult | undefined): string | undefined {
  const records = result?.data;
  if (!records?.length) return undefined;
  const us = records.find((r) => r.exchCode === 'US');
  return (us ?? records[0]).ticker || undefined;
}

/** Split into chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Process-lifetime cache — CUSIP→ticker never changes within a session. */
const cache = new Map<string, string | undefined>();

/**
 * Resolve CUSIPs to tickers, returning a map of only those that resolved.
 *
 * Best-effort by design: a failed batch leaves those holdings without a ticker
 * rather than failing the whole portfolio, since the issuer name is already
 * enough to render the row.
 */
export async function resolveTickers(cusips: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(cusips)];
  const missing = unique.filter((c) => !cache.has(c));

  for (const batch of chunk(missing, BATCH_SIZE)) {
    const body = batch.map((c) => ({ idType: idTypeFor(c), idValue: c }));
    try {
      const results = await postJson<FigiResult[]>(
        `${API_BASE_URLS.openFigi}/mapping`,
        body,
      );
      batch.forEach((cusip, i) => cache.set(cusip, pickTicker(results[i])));
    } catch {
      // Leave uncached so a later render can retry.
    }
  }

  const out = new Map<string, string>();
  for (const cusip of unique) {
    const ticker = cache.get(cusip);
    if (ticker) out.set(cusip, ticker);
  }
  return out;
}
