import { API_BASE_URLS } from '../config';
import type { SeriesPoint } from '../types';
import { getJson } from '../lib/http';

/**
 * FRED (St. Louis Fed) data layer — plan groups E (valuation) and F (macro).
 *
 * IMPORTANT scope note, verified live against the API on 2026-08-01: FRED hosts
 * NO S&P 500 valuation series. `/series/search` returns zero results for
 * "Shiller PE", "cyclically adjusted price earnings", "S&P 500 dividend yield"
 * and "S&P 500 price earnings ratio"; the Wilshire 5000 series were delisted.
 * So trailing P/E, CAPE, dividend yield, P/B and P/S are NOT retrievable here.
 *
 * What IS derivable is an economy-wide market P/E built from two NIPA/Z.1 series
 * covering the SAME universe (nonfinancial corporate business) — see
 * `deriveValuation`. It is a macro proxy, not the S&P 500's own P/E; the UI
 * labels it as such.
 *
 * FRED's own `SP500` series is capped at 10 years by licensing, so price history
 * still comes from Yahoo (see services/sp500.ts).
 */

const BASE = API_BASE_URLS.fred;

/** Series IDs used by the deep-dive (all verified to exist and be free). */
export const FRED_SERIES = {
  treasury10Y: 'DGS10',
  treasury2Y: 'DGS2',
  treasury3M: 'DGS3MO',
  spread10Y2Y: 'T10Y2Y',
  spread10Y3M: 'T10Y3M',
  fedFunds: 'FEDFUNDS',
  cpi: 'CPIAUCSL',
  vix: 'VIXCLS',
  /** Nonfinancial corporate business; corporate equities; liability, market value ($ millions). */
  corporateEquities: 'NCBCEL',
  /** Nonfinancial corporate business: profits after tax ($ billions) — same universe as above. */
  corporateProfits: 'NFCPATAX',
  gdp: 'GDP',
} as const;

export type FredSeriesId = (typeof FRED_SERIES)[keyof typeof FRED_SERIES];

/** True once a real key replaces the placeholder; gates the whole FRED layer. */
export function hasFredKey(apiKey: string | undefined): boolean {
  return !!apiKey && !apiKey.startsWith('YOUR_');
}

// ---- Raw response shape (only the fields we read) ----

export interface FredObservationsResponse {
  observations?: Array<{ date: string; value: string }>;
}

// ---- Pure parsing (unit-tested) ----

/** "YYYY-MM-DD" → UTC-midnight epoch ms. NaN for anything malformed. */
export function parseFredDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Map a FRED observations payload to ascending SeriesPoint[]. FRED marks missing
 * values (holidays, not-yet-published) with a literal "." — those rows are
 * dropped rather than coerced to 0.
 */
export function parseFredObservations(json: FredObservationsResponse): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const o of json?.observations ?? []) {
    if (!o || o.value === '.' || o.value == null) continue;
    const v = Number(o.value);
    const t = parseFredDate(o.date);
    if (!Number.isFinite(v) || !Number.isFinite(t)) continue;
    out.push({ t, v });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Most recent point of an ascending series. */
export function latestPoint(series: SeriesPoint[]): SeriesPoint | undefined {
  return series.length ? series[series.length - 1] : undefined;
}

/**
 * Every observation date present in BOTH series, ascending. Quarterly FRED
 * series publish on different lags (GDP can be a quarter ahead of the Z.1
 * flow-of-funds tables), so ratios must be built from common quarters rather
 * than from each series' own latest point.
 */
export function alignedSeries(
  a: SeriesPoint[],
  b: SeriesPoint[],
): Array<{ t: number; a: number; b: number }> {
  const bByTime = new Map(b.map((p) => [p.t, p.v]));
  const out: Array<{ t: number; a: number; b: number }> = [];
  for (const p of a) {
    const match = bByTime.get(p.t);
    if (match != null) out.push({ t: p.t, a: p.v, b: match });
  }
  return out;
}

/** Newest observation date present in both series. */
export function alignedLatest(
  a: SeriesPoint[],
  b: SeriesPoint[],
): { t: number; a: number; b: number } | undefined {
  const all = alignedSeries(a, b);
  return all.length ? all[all.length - 1] : undefined;
}

/**
 * Where `value` sits within `values`, as a 0–100 rank (share of observations at
 * or below it). This is what lets the summary say "expensive" against the
 * market's own history instead of an invented threshold.
 */
export function percentileRank(values: number[], value: number): number | undefined {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0 || !Number.isFinite(value)) return undefined;
  const atOrBelow = finite.filter((v) => v <= value).length;
  return (atOrBelow / finite.length) * 100;
}

/** Ratio of two aligned series as its own time series, skipping bad denominators. */
function ratioSeries(
  a: SeriesPoint[],
  b: SeriesPoint[],
  scale: number,
): SeriesPoint[] {
  return alignedSeries(a, b)
    .filter((p) => p.b > 0)
    .map((p) => ({ t: p.t, v: (p.a / scale) / p.b }));
}

/** Year-over-year % change of a monthly series (CPI → inflation rate). */
export function yearOverYearPct(series: SeriesPoint[]): number | undefined {
  const last = latestPoint(series);
  if (!last) return undefined;
  const targetT = Date.UTC(
    new Date(last.t).getUTCFullYear() - 1,
    new Date(last.t).getUTCMonth(),
    new Date(last.t).getUTCDate(),
  );
  const prior = series.find((p) => p.t === targetT);
  if (!prior || prior.v === 0) return undefined;
  return (last.v / prior.v - 1) * 100;
}

/**
 * Real (inflation-adjusted) total return from a nominal % return and a % inflation
 * rate over the same span — Fisher relation, not naive subtraction.
 */
export function realReturnPct(nominalPct?: number, inflationPct?: number): number | undefined {
  if (nominalPct == null || inflationPct == null) return undefined;
  return ((1 + nominalPct / 100) / (1 + inflationPct / 100) - 1) * 100;
}

// ---- Derived snapshots ----

export interface ValuationSnapshot {
  /**
   * Aggregate market P/E for US nonfinancial corporate business. NOT the S&P
   * 500's trailing P/E: different universe (all nonfinancial corporations,
   * public and private, financials excluded) and different earnings basis
   * (NIPA national-accounts profits, not GAAP reported EPS). Quarterly, and
   * lagged roughly one to two quarters.
   */
  marketPe?: number;
  earningsYieldPct?: number;
  /** Earnings yield minus the 10Y Treasury yield. */
  equityRiskPremiumPct?: number;
  /** Corporate equities market value as a % of GDP ("Buffett indicator"). */
  buffettIndicatorPct?: number;
  /** Where today's P/E sits in its own full history (0–100). */
  marketPePercentile?: number;
  buffettPercentile?: number;
  /** Start of the history backing those percentiles. */
  historySinceT?: number;
  /** Observation date backing the quarterly ratios. */
  asOf?: number;
}

export interface MacroSnapshot {
  treasury10YPct?: number;
  treasury2YPct?: number;
  treasury3MPct?: number;
  spread10Y2YPct?: number;
  spread10Y3MPct?: number;
  fedFundsPct?: number;
  vix?: number;
  cpiYoYPct?: number;
  /** Where today's VIX sits in its trailing 10-year daily range (0–100). */
  vixPercentile?: number;
  /** 3M T-bill, used as the risk-free rate for Sharpe/Sortino. */
  riskFreeAnnualPct?: number;
  valuation: ValuationSnapshot;
  /** Latest daily observation seen across the rate series. */
  asOf?: number;
}

/** Build the valuation block from the matched-universe series. Pure. */
export function deriveValuation(input: {
  corporateEquities: SeriesPoint[];
  corporateProfits: SeriesPoint[];
  gdp: SeriesPoint[];
  treasury10YPct?: number;
}): ValuationSnapshot {
  const out: ValuationSnapshot = {};

  // NCBCEL is $ millions; NFCPATAX and GDP are $ billions.
  const peSeries = ratioSeries(input.corporateEquities, input.corporateProfits, 1000);
  const peLatest = latestPoint(peSeries);
  if (peLatest) {
    out.marketPe = peLatest.v;
    out.earningsYieldPct = 100 / peLatest.v;
    out.asOf = peLatest.t;
    out.marketPePercentile = percentileRank(
      peSeries.map((p) => p.v),
      peLatest.v,
    );
    out.historySinceT = peSeries[0].t;
    if (input.treasury10YPct != null) {
      out.equityRiskPremiumPct = out.earningsYieldPct - input.treasury10YPct;
    }
  }

  const buffettSeries = ratioSeries(input.corporateEquities, input.gdp, 1000);
  const buffettLatest = latestPoint(buffettSeries);
  if (buffettLatest) {
    out.buffettIndicatorPct = buffettLatest.v * 100;
    out.buffettPercentile = percentileRank(
      buffettSeries.map((p) => p.v),
      buffettLatest.v,
    );
    out.asOf ??= buffettLatest.t;
    out.historySinceT ??= buffettSeries[0].t;
  }

  return out;
}

// ---- Network ----

export function fredUrl(seriesId: string, apiKey: string, fromMs?: number): string {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: 'json',
    sort_order: 'asc',
  });
  if (fromMs != null) {
    params.set('observation_start', new Date(fromMs).toISOString().slice(0, 10));
  }
  return `${BASE}/series/observations?${params.toString()}`;
}

/** Fetch one FRED series as ascending points. Throws on HTTP failure. */
export async function fetchFredSeries(
  seriesId: string,
  apiKey: string,
  fromMs?: number,
): Promise<SeriesPoint[]> {
  const json = await getJson<FredObservationsResponse>(fredUrl(seriesId, apiKey, fromMs));
  return parseFredObservations(json);
}

/** Fetch several series at once; a failing series yields [] instead of rejecting. */
async function fetchAllBestEffort(
  ids: string[],
  apiKey: string,
  fromMsFor: (id: string) => number | undefined,
): Promise<Record<string, SeriesPoint[]>> {
  const settled = await Promise.allSettled(
    ids.map((id) => fetchFredSeries(id, apiKey, fromMsFor(id))),
  );
  const out: Record<string, SeriesPoint[]> = {};
  ids.forEach((id, i) => {
    const r = settled[i];
    out[id] = r.status === 'fulfilled' ? r.value : [];
  });
  return out;
}

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * How far back each series is pulled. Most only need enough for a current level
 * and a YoY comparison, but anything feeding a percentile needs its full
 * distribution. The quarterly Z.1/NIPA series run to 1945–47 and are only a few
 * hundred points each, so full history is cheap; VIX is daily, so it is capped
 * at 10 years and the summary describes it as a 10-year range accordingly.
 */
const DEFAULT_LOOKBACK_YEARS = 6;
const VIX_LOOKBACK_YEARS = 10;
const FULL_HISTORY_SERIES = new Set<string>([
  FRED_SERIES.corporateEquities,
  FRED_SERIES.corporateProfits,
  FRED_SERIES.gdp,
]);

function lookbackFor(id: string, nowMs: number): number | undefined {
  if (FULL_HISTORY_SERIES.has(id)) return undefined; // no observation_start → all of it
  const years = id === FRED_SERIES.vix ? VIX_LOOKBACK_YEARS : DEFAULT_LOOKBACK_YEARS;
  return nowMs - years * YEAR_MS;
}

/**
 * Load the macro + valuation snapshot. Every series is best-effort: the whole
 * snapshot degrades to undefined fields rather than failing, matching the
 * resilience pattern used by indices/crypto `fetchDetail`.
 */
export async function fetchMacroSnapshot(nowMs: number, apiKey: string): Promise<MacroSnapshot> {
  const ids = Object.values(FRED_SERIES);
  const byId = await fetchAllBestEffort(ids, apiKey, (id) => lookbackFor(id, nowMs));

  const at = (id: string) => latestPoint(byId[id] ?? [])?.v;
  const treasury10YPct = at(FRED_SERIES.treasury10Y);

  const vixSeries = byId[FRED_SERIES.vix] ?? [];
  const vix = latestPoint(vixSeries)?.v;

  const rateDates = [FRED_SERIES.treasury10Y, FRED_SERIES.treasury3M, FRED_SERIES.vix]
    .map((id) => latestPoint(byId[id] ?? [])?.t)
    .filter((t): t is number => t != null);

  return {
    treasury10YPct,
    treasury2YPct: at(FRED_SERIES.treasury2Y),
    treasury3MPct: at(FRED_SERIES.treasury3M),
    spread10Y2YPct: at(FRED_SERIES.spread10Y2Y),
    spread10Y3MPct: at(FRED_SERIES.spread10Y3M),
    fedFundsPct: at(FRED_SERIES.fedFunds),
    vix,
    cpiYoYPct: yearOverYearPct(byId[FRED_SERIES.cpi] ?? []),
    vixPercentile:
      vix != null ? percentileRank(vixSeries.map((p) => p.v), vix) : undefined,
    riskFreeAnnualPct: at(FRED_SERIES.treasury3M),
    valuation: deriveValuation({
      corporateEquities: byId[FRED_SERIES.corporateEquities] ?? [],
      corporateProfits: byId[FRED_SERIES.corporateProfits] ?? [],
      gdp: byId[FRED_SERIES.gdp] ?? [],
      treasury10YPct,
    }),
    asOf: rateDates.length ? Math.max(...rateDates) : undefined,
  };
}
