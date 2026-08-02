import { SEC_REQUEST_GAP_MS, secUserAgent } from './config';
import { buildAssessment } from './domain/assessment';
import { buildCalendar, isoDate, weekWindow } from './domain/calendar';
import { buildConsensus, buildMoves, type ConsensusInput } from './domain/consensus';
import {
  closeSeries,
  computeStats,
  downsample,
  sliceByWindow,
  type ReturnWindow,
} from './domain/stats';
import { SUPERINVESTORS, type Superinvestor } from './domain/superinvestors';
import type { Env } from './env';
import type { OhlcvPoint, SeriesPoint } from './types';
import { sleep } from './lib/http';
import { KEYS, readCache, readOrCompute, writeCache } from './lib/kv';
import {
  diffPortfolios,
  fetchFilings,
  fetchPortfolio,
  type Filing,
  type HoldingChange,
  type Portfolio,
} from './sources/edgar13f';
import { fetchEconomicCalendar } from './sources/economicCalendar';
import { fetchEarningsForDate, type EarningsEvent } from './sources/earnings';
import { fetchMacroSnapshot, hasFredKey } from './sources/fred';
import { resolveTickers } from './sources/openfigi';
import { fetchSp500History } from './sources/sp500';

/**
 * Scheduled refresh, structured around Cloudflare's hard limit of 50 subrequests
 * per invocation (free plan).
 *
 * That budget is the binding constraint on this whole file. Refreshing all 28
 * managers in one pass costs ~200 subrequests and dies a third of the way in —
 * measured, not guessed: a single-pass run completed 5 of 28 before every
 * remaining manager failed with "Too many subrequests".
 *
 * So the work is a round-robin instead. Each cron tick runs one step of:
 *
 *   market -> investors[0..1] -> investors[2..3] -> ... -> consensus -> calendar
 *
 * Which step is decided by the clock, not by a stored cursor — see `cursorAt`.
 *
 * Note that KV reads and writes count against the same budget as outbound
 * fetches, which is why the ticker map is a single entry rather than one key
 * per CUSIP.
 *
 * KV WRITES ARE THE SCARCE RESOURCE, separately from subrequests. The free plan
 * allows 1,000 a day against 100,000 reads, so anything that writes on a timer
 * rather than on a change is expensive: at a 15-minute cron, one write per tick
 * is a fifth of the daily budget. Two rules follow, and both are load-bearing:
 * never write to record that nothing happened, and prefer a read that proves a
 * write is unnecessary.
 *
 * Failure policy: each step is independent and only writes on success, so a
 * failed step leaves the PREVIOUS payload in place rather than blanking it.
 */

/** Managers per tick. 2 x ~9 subrequests on a cold run leaves clear headroom. */
const INVESTORS_PER_STEP = 2;

/**
 * Cap on OpenFIGI calls per manager (10 CUSIPs each).
 *
 * Without this, one large book exhausts the whole invocation on ticker lookups
 * alone: Bridgewater holds 993 positions and needed ~100 calls on a cold run,
 * which took down the manager batched after it. Leftovers stay uncached and are
 * picked up next cycle, so the map fills in over a few passes rather than
 * failing outright.
 *
 * Worst case per tick: 2 managers x 10 calls = 20, plus ~10 for filings, the
 * ticker map and the payload write — comfortably inside the 50 budget even if
 * both managers in a batch are cold and huge.
 */
const MAX_FIGI_CALLS_PER_STEP = 10;

export type Phase = 'market' | 'investors' | 'consensus' | 'calendar';

export const PHASES: Phase[] = ['market', 'investors', 'consensus', 'calendar'];

export interface Cursor {
  phase: Phase;
  /** Index into SUPERINVESTORS while in the `investors` phase. */
  index: number;
  /** Which full cycle this tick belongs to. */
  cycle: number;
}

/** Cron interval, and therefore the width of one slot. Must match wrangler.jsonc. */
const CRON_INTERVAL_MS = 15 * 60 * 1000;

/** Investor batches needed to cover the roster. */
function investorBatches(): number {
  return Math.ceil(SUPERINVESTORS.length / INVESTORS_PER_STEP);
}

/** market + investor batches + consensus + calendar. */
export function stepsPerCycle(): number {
  return investorBatches() + 3;
}

/**
 * Where the round-robin is, DERIVED FROM THE CLOCK rather than stored.
 *
 * This used to be a `{phase,index,cycle}` record read from KV at the start of
 * every tick and written back at the end. That cost two KV operations per tick
 * — 192 writes a day at a 15-minute cron — against a free-plan budget of 1,000
 * writes a day, purely to remember a number that the clock already knows.
 *
 * Wall time gives the same sequence for free: the slot is the tick number
 * modulo the cycle length, so every invocation computes its own position with
 * no state, no read, no write, and no way for the cursor to drift out of sync
 * with reality. A missed or delayed cron skips a slot instead of replaying one,
 * which is the behaviour we wanted anyway — the old cursor would repeat a step
 * after a failed write.
 *
 * The one property lost is "resume exactly where we left off after an outage".
 * That was never worth much here: every phase is idempotent and the whole cycle
 * comes round again in about four hours.
 */
export function cursorAt(nowMs: number): Cursor {
  const total = stepsPerCycle();
  const tick = Math.floor(nowMs / CRON_INTERVAL_MS);
  // Modulo is sign-preserving in JS, so normalise for pre-epoch inputs.
  const slot = ((tick % total) + total) % total;
  const cycle = Math.floor(tick / total);
  const batches = investorBatches();

  if (slot === 0) return { phase: 'market', index: 0, cycle };
  if (slot <= batches) {
    return { phase: 'investors', index: (slot - 1) * INVESTORS_PER_STEP, cycle };
  }
  if (slot === batches + 1) return { phase: 'consensus', index: 0, cycle };
  return { phase: 'calendar', index: 0, cycle };
}

export interface StepReport {
  phase: Phase;
  ok: boolean;
  /** Which managers this tick handled, when in the investors phase. */
  handled?: string[];
  /** KV keys this tick actually wrote. Empty means nothing had changed. */
  wrote: string[];
  next: Cursor;
  errors: string[];
  ranAt: number;
  durationMs: number;
}

/**
 * Advance the refresh by exactly one tick. This is what the cron calls.
 *
 * `forcePhase` runs a specific phase now regardless of the cursor. It is passed
 * in rather than written to KV first because KV is eventually consistent: a
 * write followed immediately by a read returns the OLD value often enough that
 * the override silently did nothing.
 */
export async function refreshStep(
  env: Env,
  nowMs = Date.now(),
  forcePhase?: Phase,
  cursorOverride?: Cursor,
): Promise<StepReport> {
  const derived = cursorOverride ?? cursorAt(nowMs);
  const cursor: Cursor = forcePhase ? { ...derived, phase: forcePhase, index: 0 } : derived;
  const errors: string[] = [];
  const wrote: string[] = [];
  const report: StepReport = {
    phase: cursor.phase,
    ok: true,
    wrote,
    next: cursorAt(nowMs + CRON_INTERVAL_MS),
    errors,
    ranAt: nowMs,
    durationMs: 0,
  };

  try {
    if (cursor.phase === 'market') {
      await refreshMarket(env, nowMs);
      wrote.push(KEYS.market);
    } else if (cursor.phase === 'investors') {
      const batch = SUPERINVESTORS.slice(cursor.index, cursor.index + INVESTORS_PER_STEP);
      report.handled = batch.map((s) => s.id);
      for (const investor of batch) {
        try {
          if (await refreshInvestor(env, investor, nowMs)) {
            wrote.push(KEYS.investor(investor.id));
          }
        } catch (e) {
          errors.push(`${investor.id}: ${errText(e)}`);
        }
        await sleep(SEC_REQUEST_GAP_MS);
      }
    } else if (cursor.phase === 'consensus') {
      await refreshConsensus(env, nowMs);
      wrote.push(KEYS.consensus, KEYS.investorIndex);
    } else {
      await refreshCalendar(env, nowMs);
      wrote.push(KEYS.calendar);
    }
  } catch (e) {
    report.ok = false;
    errors.push(`${cursor.phase}: ${errText(e)}`);
    // No recovery needed: the next slot is whatever the clock says, so a
    // failing phase cannot wedge the cycle or starve the others.
  }

  report.ok = report.ok && errors.length === 0;
  report.durationMs = Date.now() - nowMs;

  // The log is itself a KV write, and writing it on every tick cost as much as
  // the real work did — 96 a day to record, most often, that nothing had
  // changed. Recording only ticks that did something or went wrong keeps
  // /health useful (the last MEANINGFUL event, not the last heartbeat) and
  // still updates several times a day, because market, consensus and calendar
  // always write.
  if (errors.length || wrote.length) {
    await writeCache(env, KEYS.refreshLog, report, nowMs);
  }
  return report;
}

/** Price history + stats + assessment, all precomputed. */
export async function refreshMarket(env: Env, nowMs: number): Promise<void> {
  const history = await fetchSp500History(nowMs);

  // Macro is supplementary — without it the dashboard still has price and
  // stats, so a FRED failure degrades the payload instead of failing it.
  let macro;
  if (hasFredKey(env.FRED_API_KEY)) {
    try {
      macro = await fetchMacroSnapshot(nowMs, env.FRED_API_KEY);
    } catch {
      macro = undefined;
    }
  }

  const stats = computeStats(history, nowMs, macro?.riskFreeAnnualPct ?? 0);
  // Fewer than two bars means the price fetch came back effectively empty;
  // writing that would replace a good payload with a blank one.
  if (!stats) throw new Error(`insufficient price history (${history.length} bars)`);

  await writeCache(
    env,
    KEYS.market,
    { stats, assessment: buildAssessment(stats, macro), macro, charts: buildCharts(history, nowMs) },
    nowMs,
  );
}

/** Chart windows the dashboard offers. */
const CHART_WINDOWS: ReturnWindow[] = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y', '10Y', 'MAX'];

/**
 * Pre-slice and pre-thin the chart series, one per window.
 *
 * The raw 20-year daily history is ~5,000 bars and serialises to 600KB — far too
 * much to hand a phone, especially to render 300 pixels of chart. Slicing and
 * downsampling here drops the payload by an order of magnitude and means window
 * switching in the app is an array lookup rather than a recomputation.
 */
function buildCharts(history: OhlcvPoint[], nowMs: number): Record<string, SeriesPoint[]> {
  const series = closeSeries(history);
  const out: Record<string, SeriesPoint[]> = {};
  for (const w of CHART_WINDOWS) {
    out[w] = downsample(sliceByWindow(series, w, nowMs));
  }
  return out;
}

/** Cached payload shape, also what `/v1/investors/:id` serves. */
interface InvestorPayload {
  investor: Superinvestor;
  /**
   * Accession of the filing this payload was built from.
   *
   * Stored solely so the next refresh can tell whether anything has actually
   * changed without re-parsing. Absent on payloads written before this field
   * existed, which reads as "unknown" and costs one rebuild to heal.
   */
  accession?: string;
  current: Portfolio;
  previous?: { periodOfReport: string; totalValue: number };
  changes: HoldingChange[];
  tickers: Record<string, string>;
}

/**
 * One manager's latest filing, the prior quarter, and the diff.
 *
 * Filings are read through an immutable cache keyed by accession, so this
 * re-parses nothing on later runs: a 13F document never changes once accepted,
 * and outside the four filing windows a year nothing new appears at all.
 *
 * Returns whether it wrote. It usually does not — see the early return below.
 */
async function refreshInvestor(
  env: Env,
  investor: Superinvestor,
  nowMs: number,
): Promise<boolean> {
  const userAgent = secUserAgent(env);
  const filings = await fetchFilings(investor.cik, userAgent);
  if (filings.length === 0) throw new Error('no 13F filings on file');

  // 13F filings land four times a year. Every other run — the overwhelming
  // majority — was rebuilding a byte-identical payload and writing it back,
  // which cost 28 KV writes per cycle and roughly a third of the daily
  // free-tier write budget to change nothing. One read now answers the only
  // question that matters: is the newest accession the one already stored?
  //
  // Trading a read for a write is strongly favourable on this plan: reads are
  // metered at 100,000/day, writes at 1,000. It also skips the portfolio
  // fetches and the OpenFIGI pass entirely, which is why an unchanged manager
  // now costs one SEC call instead of a dozen subrequests.
  const existing = await readCache<InvestorPayload>(env, KEYS.investor(investor.id));
  if (existing?.data.accession && existing.data.accession === filings[0].accession) {
    return false;
  }

  const current = await cachedPortfolio(env, investor.cik, filings[0], userAgent);
  let previous: Portfolio | undefined;
  if (filings[1]) {
    try {
      previous = await cachedPortfolio(env, investor.cik, filings[1], userAgent);
    } catch {
      previous = undefined;
    }
  }

  const changes = diffPortfolios(current, previous);
  const tickers = await resolveWithCache(env, current.holdings.map((h) => h.cusip));
  const holdings = current.holdings.map((h) => ({ ...h, ticker: tickers[h.cusip] }));

  const payload: InvestorPayload = {
    investor,
    accession: filings[0].accession,
    current: { ...current, holdings },
    previous: previous
      ? { periodOfReport: previous.periodOfReport, totalValue: previous.totalValue }
      : undefined,
    changes,
    tickers,
  };
  await writeCache(env, KEYS.investor(investor.id), payload, nowMs);
  return true;
}

/**
 * Cross-investor aggregation, built entirely from cached payloads.
 *
 * Runs as its own phase because it needs all 28 managers present, and 28 KV
 * reads plus a write is most of one invocation's budget on its own.
 */
async function refreshConsensus(env: Env, nowMs: number): Promise<void> {
  const inputs: ConsensusInput[] = [];
  const index: Record<string, { periodOfReport: string; filingDate: string }> = {};

  for (const s of SUPERINVESTORS) {
    const hit = await readCache<InvestorPayload>(env, KEYS.investor(s.id));
    if (!hit) continue;
    const { current, changes, tickers } = hit.data;
    index[s.id] = { periodOfReport: current.periodOfReport, filingDate: current.filingDate };
    inputs.push({
      investorId: s.id,
      manager: s.manager,
      portfolio: current,
      changes,
      tickers: tickers ?? {},
    });
  }

  if (inputs.length === 0) throw new Error('no investor payloads cached yet');

  const entries = buildConsensus(inputs);
  await writeCache(
    env,
    KEYS.consensus,
    { entries: entries.slice(0, 100), moves: buildMoves(entries), investorCount: inputs.length },
    nowMs,
  );
  await writeCache(env, KEYS.investorIndex, index, nowMs);
}

/** How many companies per day survive the market-cap cut. */
const EARNINGS_PER_DAY = 30;

/**
 * The week-ahead calendar: global economic releases plus the largest earnings.
 *
 * Costs one calendar call, one Nasdaq call per day (8), and a write — about 10
 * subrequests, comfortably inside the budget. Earnings are best-effort per day
 * so one bad response costs a single day rather than the whole calendar.
 */
async function refreshCalendar(env: Env, nowMs: number): Promise<void> {
  const { dates } = weekWindow(nowMs);

  // Padded a day either side of the UTC window. The client buckets economic
  // events by ITS OWN local date, so a reader in UTC+13 needs the far edge of
  // the last UTC day and a reader in UTC-11 the near edge of the first. One
  // request covers the window whatever its width, so the padding is free;
  // anything outside the reader's seven local days is dropped client-side.
  const economic = await fetchEconomicCalendar(isoDate(nowMs, -1), isoDate(nowMs, 8));

  // Fetched in parallel, not in sequence. Nasdaq takes ~2s per request, so
  // eight sequential days ran ~18s and overran the waitUntil budget — the write
  // was cancelled and the calendar silently never appeared. Concurrency costs
  // the same subrequests and finishes in the time of the slowest day.
  const settled = await Promise.allSettled(
    dates.map((date) => fetchEarningsForDate(date, EARNINGS_PER_DAY)),
  );

  const earningsByDate: Record<string, { events: EarningsEvent[]; total: number }> = {};
  dates.forEach((date, i) => {
    const r = settled[i];
    // Weekends legitimately return nothing, and one failed day should not cost
    // the other seven.
    if (r.status === 'fulfilled') earningsByDate[date] = r.value;
  });

  await writeCache(
    env,
    KEYS.calendar,
    buildCalendar(dates, economic, earningsByDate, EARNINGS_PER_DAY),
    nowMs,
  );
}

function cachedPortfolio(
  env: Env,
  cik: string,
  filing: Filing,
  userAgent: string,
): Promise<Portfolio> {
  return readOrCompute(env, KEYS.filing(cik, filing.accession), () =>
    fetchPortfolio(cik, filing, userAgent),
  );
}

/**
 * CUSIP -> ticker against one shared map.
 *
 * Only genuinely new securities reach OpenFIGI, which matters both for its
 * 25 requests/minute unauthenticated limit and for the subrequest budget: the
 * map is a single read and at most a single write per tick.
 */
async function resolveWithCache(env: Env, cusips: string[]): Promise<Record<string, string>> {
  const stored = (await readCache<Record<string, string>>(env, KEYS.tickers))?.data ?? {};
  const unknown = [...new Set(cusips)]
    .filter((c) => !stored[c])
    .slice(0, MAX_FIGI_CALLS_PER_STEP * 10);

  if (unknown.length) {
    const resolved = await resolveTickers(unknown);
    if (resolved.size) {
      for (const [cusip, ticker] of resolved) stored[cusip] = ticker;
      await writeCache(env, KEYS.tickers, stored);
    }
  }

  const out: Record<string, string> = {};
  for (const cusip of cusips) if (stored[cusip]) out[cusip] = stored[cusip];
  return out;
}

/**
 * Every phase in one pass. Far exceeds the free plan's subrequest budget, so
 * this is for local `wrangler dev` and one-off backfills only — production uses
 * `refreshStep`.
 */
export async function refreshAll(env: Env, nowMs = Date.now()): Promise<StepReport[]> {
  const reports: StepReport[] = [];
  const total = stepsPerCycle();
  // The cursor is derived from `nowMs`, so passing the same clock every time
  // would run the same phase on every iteration. Walk the slots explicitly and
  // keep the real `nowMs` for `builtAt` — offsetting the clock instead would
  // stamp payloads with timestamps hours in the future.
  const base = cursorAt(nowMs);
  for (let i = 0; i < total; i++) {
    reports.push(
      await refreshStep(env, nowMs, undefined, cursorAt((base.cycle * total + i) * CRON_INTERVAL_MS)),
    );
  }
  return reports;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
