import type { Env } from '../env';

/**
 * Every payload the Worker serves is written here by the cron job and only read
 * on the request path. Keys are versioned so a breaking shape change can be
 * rolled out by bumping the prefix instead of racing a cache purge.
 */
const V = 'v1';

export const KEYS = {
  market: `${V}:market`,
  investorIndex: `${V}:investors`,
  investor: (id: string) => `${V}:investor:${id}`,
  consensus: `${V}:consensus`,
  calendar: `${V}:calendar`,
  /**
   * Raw parsed filing, keyed by accession. 13F filings are IMMUTABLE once
   * accepted — the document at that accession will never change — so this is
   * cached with no expiry and makes every refresh after the first nearly free.
   */
  filing: (cik: string, accession: string) => `${V}:filing:${cik}:${accession}`,
  /**
   * CUSIP -> ticker for every security ever seen, as ONE entry.
   *
   * Deliberately not one key per CUSIP: KV operations count against the
   * Worker's 50-subrequest budget, so a per-CUSIP layout meant a single
   * 200-holding manager could exhaust the entire invocation on cache reads.
   */
  tickers: `${V}:tickers`,
  /**
   * Last refresh that did something. Written only when a step changed a payload
   * or failed, never as a heartbeat — see the note in refresh.ts about the
   * write budget.
   */
  refreshLog: `${V}:refresh-log`,
  // There is deliberately no `cursor` key. The round-robin position used to
  // live here and cost two KV operations per cron tick to maintain; it is now
  // derived from wall time in `cursorAt()`, which the clock already knows.
} as const;

/** Envelope stamped on everything served, so clients can show data age. */
export interface Cached<T> {
  data: T;
  /** When the refresh that produced this ran (epoch ms). */
  builtAt: number;
}

export async function readCache<T>(env: Env, key: string): Promise<Cached<T> | null> {
  return await env.CACHE.get<Cached<T>>(key, 'json');
}

export async function writeCache<T>(
  env: Env,
  key: string,
  data: T,
  builtAt = Date.now(),
): Promise<void> {
  await env.CACHE.put(key, JSON.stringify({ data, builtAt } satisfies Cached<T>));
}

/** Read-through helper for the immutable caches (filings, tickers). */
export async function readOrCompute<T>(
  env: Env,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = await readCache<T>(env, key);
  if (hit) return hit.data;
  const value = await compute();
  await writeCache(env, key, value);
  return value;
}
