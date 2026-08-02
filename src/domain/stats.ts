import { startOfYearMs, valueAsOf } from './series';
import type { OhlcvPoint, SeriesPoint } from '../types';

/**
 * Pure statistics engine for the S&P 500 deep-dive (plan groups A–D). Every
 * function is deterministic; callers inject `nowMs` where wall-clock matters.
 *
 * Conventions:
 *  - "return" values are FRACTIONS internally (0.01 = 1%) and PERCENT at the
 *    public summary boundary (StatsSummary), matching Asset.change* (percent).
 *  - Annualization uses 252 trading days.
 */

export const TRADING_DAYS = 252;
const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────
// Basic moments
// ─────────────────────────────────────────────────────────────────────────────

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Standard deviation. `sample` (default true) uses the n-1 (Bessel) divisor. */
export function stdev(xs: number[], sample = true): number {
  const n = xs.length;
  if (n < (sample ? 2 : 1)) return NaN;
  const m = mean(xs);
  const ss = xs.reduce((acc, x) => acc + (x - m) ** 2, 0);
  return Math.sqrt(ss / (sample ? n - 1 : n));
}

/** Population skewness (third standardized moment). */
export function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const m = mean(xs);
  const sd = stdev(xs, false);
  if (sd === 0) return NaN;
  return xs.reduce((acc, x) => acc + ((x - m) / sd) ** 3, 0) / n;
}

/** Excess kurtosis (0 for a normal distribution). */
export function kurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return NaN;
  const m = mean(xs);
  const sd = stdev(xs, false);
  if (sd === 0) return NaN;
  return xs.reduce((acc, x) => acc + ((x - m) / sd) ** 4, 0) / n - 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Series helpers
// ─────────────────────────────────────────────────────────────────────────────

/** OHLCV → close-only SeriesPoint[] (for charting / return math). */
export function closeSeries(points: OhlcvPoint[]): SeriesPoint[] {
  return points.map((p) => ({ t: p.t, v: p.c }));
}

export function closes(points: OhlcvPoint[]): number[] {
  return points.map((p) => p.c);
}

/** Simple period-over-period returns (fractions) from a value array. */
export function simpleReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] !== 0) out.push(values[i] / values[i - 1] - 1);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Returns & performance
// ─────────────────────────────────────────────────────────────────────────────

/** Compound annual growth rate (percent) given start/end value and span in years. */
export function cagr(startVal: number, endVal: number, years: number): number | undefined {
  if (startVal <= 0 || years <= 0) return undefined;
  return ((endVal / startVal) ** (1 / years) - 1) * 100;
}

export type ReturnWindow =
  | '1D'
  | '1W'
  | '1M'
  | '3M'
  | '6M'
  | 'YTD'
  | '1Y'
  | '3Y'
  | '5Y'
  | '10Y'
  | 'MAX';

const WINDOW_YEARS: Partial<Record<ReturnWindow, number>> = {
  '1D': 1 / 365,
  '1W': 7 / 365,
  '1M': 1 / 12,
  '3M': 0.25,
  '6M': 0.5,
  '1Y': 1,
  '3Y': 3,
  '5Y': 5,
  '10Y': 10,
};

/** Total % return for one window, anchored against the close as-of the window start. */
export function periodReturn(
  series: SeriesPoint[],
  window: ReturnWindow,
  nowMs: number,
): number | undefined {
  if (series.length === 0) return undefined;
  const last = series[series.length - 1].v;

  if (window === 'MAX') return ((last - series[0].v) / series[0].v) * 100;

  const anchorMs =
    window === 'YTD' ? startOfYearMs(nowMs) : nowMs - WINDOW_YEARS[window]! * 365 * DAY_MS;
  const past = valueAsOf(series, anchorMs) ?? (window === 'YTD' ? series[0].v : undefined);
  if (past == null || past === 0) return undefined;
  return ((last - past) / past) * 100;
}

/** Annualized return (CAGR, percent) for windows ≥ 1Y; undefined for shorter ones. */
export function annualizedReturn(
  series: SeriesPoint[],
  window: ReturnWindow,
  nowMs: number,
): number | undefined {
  const years = window === 'MAX' ? (series.length ? maxSpanYears(series) : 0) : WINDOW_YEARS[window];
  if (!years || years < 1) return undefined;
  const total = periodReturn(series, window, nowMs);
  if (total == null) return undefined;
  return cagr(100, 100 * (1 + total / 100), years);
}

function maxSpanYears(series: SeriesPoint[]): number {
  return (series[series.length - 1].t - series[0].t) / (365.25 * DAY_MS);
}

/** Slice a sorted series down to the points within a window (for charting). */
export function sliceByWindow(
  series: SeriesPoint[],
  window: ReturnWindow,
  nowMs: number,
): SeriesPoint[] {
  if (window === 'MAX') return series;
  const fromMs =
    window === 'YTD' ? startOfYearMs(nowMs) : nowMs - (WINDOW_YEARS[window] ?? 0) * 365 * DAY_MS;
  return series.filter((p) => p.t >= fromMs);
}

/** Stride-downsample a series to at most `maxPoints`, always keeping the last point. */
export function downsample(series: SeriesPoint[], maxPoints = 300): SeriesPoint[] {
  if (series.length <= maxPoints) return series;
  const stride = Math.ceil(series.length / maxPoints);
  const out = series.filter((_, i) => i % stride === 0);
  const last = series[series.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export interface Extreme {
  value: number;
  t: number;
}

export function allTimeHigh(series: SeriesPoint[]): Extreme | undefined {
  return series.reduce<Extreme | undefined>(
    (best, p) => (!best || p.v > best.value ? { value: p.v, t: p.t } : best),
    undefined,
  );
}

export function allTimeLow(series: SeriesPoint[]): Extreme | undefined {
  return series.reduce<Extreme | undefined>(
    (best, p) => (!best || p.v < best.value ? { value: p.v, t: p.t } : best),
    undefined,
  );
}

/** 52-week (trailing ~252 bars) high, low, and where the latest price sits (0–100%). */
export function fiftyTwoWeek(series: SeriesPoint[]): {
  high: number;
  low: number;
  pctOfRange: number;
} | undefined {
  if (series.length === 0) return undefined;
  const window = series.slice(-TRADING_DAYS);
  const high = Math.max(...window.map((p) => p.v));
  const low = Math.min(...window.map((p) => p.v));
  const last = series[series.length - 1].v;
  const pctOfRange = high === low ? 100 : ((last - low) / (high - low)) * 100;
  return { high, low, pctOfRange };
}

/** Consecutive up/down days at the end of the series (sign, count). */
export function currentStreak(rets: number[]): { direction: 'up' | 'down' | 'flat'; length: number } {
  if (rets.length === 0) return { direction: 'flat', length: 0 };
  const last = rets[rets.length - 1];
  const dir = last > 0 ? 'up' : last < 0 ? 'down' : 'flat';
  if (dir === 'flat') return { direction: 'flat', length: 0 };
  let len = 0;
  for (let i = rets.length - 1; i >= 0; i--) {
    const s = rets[i] > 0 ? 'up' : rets[i] < 0 ? 'down' : 'flat';
    if (s === dir) len++;
    else break;
  }
  return { direction: dir, length: len };
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Risk & volatility
// ─────────────────────────────────────────────────────────────────────────────

/** Annualized volatility (percent) from daily-return fractions. */
export function annualizedVol(dailyRets: number[]): number | undefined {
  if (dailyRets.length < 2) return undefined;
  return stdev(dailyRets) * Math.sqrt(TRADING_DAYS) * 100;
}

/** Realized vol over the trailing `days` returns (percent, annualized). */
export function realizedVol(dailyRets: number[], days: number): number | undefined {
  if (dailyRets.length < days) return undefined;
  return annualizedVol(dailyRets.slice(-days));
}

/** Worst peak-to-trough decline (negative percent) over the series. */
export function maxDrawdown(series: SeriesPoint[]): {
  drawdownPct: number;
  peakT: number;
  troughT: number;
} | undefined {
  if (series.length === 0) return undefined;
  let peak = series[0].v;
  let peakT = series[0].t;
  let worst = 0;
  let worstPeakT = series[0].t;
  let worstTroughT = series[0].t;
  for (const p of series) {
    if (p.v > peak) {
      peak = p.v;
      peakT = p.t;
    }
    const dd = (p.v - peak) / peak;
    if (dd < worst) {
      worst = dd;
      worstPeakT = peakT;
      worstTroughT = p.t;
    }
  }
  return { drawdownPct: worst * 100, peakT: worstPeakT, troughT: worstTroughT };
}

/** Downside deviation (percent, annualized) below a daily MAR (default 0). */
export function downsideDeviation(dailyRets: number[], marDaily = 0): number | undefined {
  if (dailyRets.length < 2) return undefined;
  const sq = dailyRets.map((r) => Math.min(0, r - marDaily) ** 2);
  return Math.sqrt(mean(sq)) * Math.sqrt(TRADING_DAYS) * 100;
}

/** Historical VaR: worst loss (positive percent) at the given confidence. */
export function historicalVar(dailyRets: number[], confidence = 0.95): number | undefined {
  if (dailyRets.length === 0) return undefined;
  const sorted = [...dailyRets].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((1 - confidence) * sorted.length)));
  return -sorted[idx] * 100;
}

/** Annualized Sharpe ratio. `riskFreeAnnualPct` defaults to 0. */
export function sharpe(dailyRets: number[], riskFreeAnnualPct = 0): number | undefined {
  if (dailyRets.length < 2) return undefined;
  const rf = riskFreeAnnualPct / 100 / TRADING_DAYS;
  const excess = dailyRets.map((r) => r - rf);
  const sd = stdev(excess);
  if (!sd) return undefined;
  return (mean(excess) / sd) * Math.sqrt(TRADING_DAYS);
}

/** Annualized Sortino ratio (downside-only risk). */
export function sortino(dailyRets: number[], riskFreeAnnualPct = 0): number | undefined {
  if (dailyRets.length < 2) return undefined;
  const rf = riskFreeAnnualPct / 100 / TRADING_DAYS;
  const dd = Math.sqrt(mean(dailyRets.map((r) => Math.min(0, r - rf) ** 2)));
  if (!dd) return undefined;
  return ((mean(dailyRets) - rf) / dd) * Math.sqrt(TRADING_DAYS);
}

/** Average True Range over `period` (Wilder smoothing). */
export function atr(points: OhlcvPoint[], period = 14): number | undefined {
  if (points.length <= period) return undefined;
  const tr: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const { h, l } = points[i];
    const pc = points[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = mean(tr.slice(0, period));
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Distribution (calendar grouping)
// ─────────────────────────────────────────────────────────────────────────────

/** Last close of each calendar month, ascending. */
export function monthlyCloses(series: SeriesPoint[]): SeriesPoint[] {
  const byMonth = new Map<string, SeriesPoint>();
  for (const p of series) {
    const d = new Date(p.t);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    byMonth.set(key, p); // later point in the month overwrites → last close
  }
  return [...byMonth.values()].sort((a, b) => a.t - b.t);
}

/** Last close of each calendar year, ascending. */
export function yearlyCloses(series: SeriesPoint[]): SeriesPoint[] {
  const byYear = new Map<number, SeriesPoint>();
  for (const p of series) byYear.set(new Date(p.t).getUTCFullYear(), p);
  return [...byYear.values()].sort((a, b) => a.t - b.t);
}

/** Average return (fraction) by calendar month (index 0=Jan … 11=Dec). */
export function monthlySeasonality(series: SeriesPoint[]): (number | undefined)[] {
  const buckets: number[][] = Array.from({ length: 12 }, () => []);
  const mc = monthlyCloses(series);
  for (let i = 1; i < mc.length; i++) {
    const r = mc[i].v / mc[i - 1].v - 1;
    buckets[new Date(mc[i].t).getUTCMonth()].push(r);
  }
  return buckets.map((b) => (b.length ? mean(b) : undefined));
}

function shareAbove(xs: number[], threshold = 0): number | undefined {
  if (xs.length === 0) return undefined;
  return (xs.filter((x) => x > threshold).length / xs.length) * 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// D. Technical indicators
// ─────────────────────────────────────────────────────────────────────────────

/** Trailing simple moving average over the last `period` values. */
export function sma(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  return mean(values.slice(-period));
}

/** EMA series, seeded with the SMA of the first `period`. Length = n-period+1. */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let e = mean(values.slice(0, period));
  const out = [e];
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export function ema(values: number[], period: number): number | undefined {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : undefined;
}

/** Wilder's RSI over `period` (default 14). */
export function rsi(values: number[], period = 14): number | undefined {
  if (values.length <= period) return undefined;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { macd: number; signal: number; histogram: number } | undefined {
  if (values.length < slow + signalPeriod) return undefined;
  const fastS = emaSeries(values, fast);
  const slowS = emaSeries(values, slow);
  const macdLine: number[] = [];
  for (let i = slow - 1; i < values.length; i++) {
    macdLine.push(fastS[i - (fast - 1)] - slowS[i - (slow - 1)]);
  }
  const signalS = emaSeries(macdLine, signalPeriod);
  const m = macdLine[macdLine.length - 1];
  const sig = signalS[signalS.length - 1];
  return { macd: m, signal: sig, histogram: m - sig };
}

export function bollinger(
  values: number[],
  period = 20,
  mult = 2,
): { middle: number; upper: number; lower: number } | undefined {
  if (values.length < period) return undefined;
  const window = values.slice(-period);
  const m = mean(window);
  const sd = stdev(window, false);
  return { middle: m, upper: m + mult * sd, lower: m - mult * sd };
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

export interface StatsSummary {
  asOf: number;
  price: number;
  /** Total % returns by window. */
  returns: Partial<Record<ReturnWindow, number>>;
  /** Annualized % returns (windows ≥ 1Y). */
  cagr: Partial<Record<ReturnWindow, number>>;
  performance: {
    ath?: Extreme;
    atl?: Extreme;
    pctFromAth?: number;
    fiftyTwoWeek?: ReturnType<typeof fiftyTwoWeek>;
    bestDayPct?: number;
    worstDayPct?: number;
    bestYearPct?: number;
    worstYearPct?: number;
    upDayPct?: number;
    downDayPct?: number;
    streak: ReturnType<typeof currentStreak>;
  };
  risk: {
    annualizedVolPct?: number;
    vol30Pct?: number;
    vol90Pct?: number;
    vol1YPct?: number;
    maxDrawdown?: ReturnType<typeof maxDrawdown>;
    downsideDeviationPct?: number;
    var95Pct?: number;
    var99Pct?: number;
    atr?: number;
    sharpe?: number;
    sortino?: number;
  };
  distribution: {
    meanDailyPct?: number;
    medianDailyPct?: number;
    skewness?: number;
    kurtosis?: number;
    positiveMonthsPct?: number;
    positiveYearsPct?: number;
    seasonality: (number | undefined)[];
  };
  technicals: {
    sma20?: number;
    sma50?: number;
    sma100?: number;
    sma200?: number;
    ema12?: number;
    ema26?: number;
    pctVsSma50?: number;
    pctVsSma200?: number;
    goldenCross?: boolean;
    rsi14?: number;
    macd?: ReturnType<typeof macd>;
    bollinger?: ReturnType<typeof bollinger>;
    avgVolume?: number;
    relativeVolume?: number;
  };
}

const WINDOWS: ReturnWindow[] = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', '3Y', '5Y', '10Y', 'MAX'];

function pctOrUndef(n: number | undefined): number | undefined {
  return n == null || Number.isNaN(n) ? undefined : n;
}

/**
 * Compute the full statistics summary for a daily OHLCV series.
 * `riskFreeAnnualPct` (e.g. the 3M T-bill from FRED) feeds Sharpe/Sortino.
 */
export function computeStats(
  points: OhlcvPoint[],
  nowMs: number,
  riskFreeAnnualPct = 0,
): StatsSummary | undefined {
  if (points.length < 2) return undefined;
  const series = closeSeries(points);
  const cl = closes(points);
  const dailyRets = simpleReturns(cl);
  const last = cl[cl.length - 1];

  const returns: Partial<Record<ReturnWindow, number>> = {};
  const cagrs: Partial<Record<ReturnWindow, number>> = {};
  for (const w of WINDOWS) {
    const r = pctOrUndef(periodReturn(series, w, nowMs));
    if (r != null) returns[w] = r;
    const a = pctOrUndef(annualizedReturn(series, w, nowMs));
    if (a != null) cagrs[w] = a;
  }

  const ath = allTimeHigh(series);
  const monthly = simpleReturns(monthlyCloses(series).map((p) => p.v));
  const yearly = simpleReturns(yearlyCloses(series).map((p) => p.v));
  const sma50 = sma(cl, 50);
  const sma200 = sma(cl, 200);
  const recentVol = points.slice(-20).map((p) => p.v);
  const allVol = points.map((p) => p.v);
  const avgVolume = allVol.length ? mean(allVol) : undefined;

  return {
    asOf: nowMs,
    price: last,
    returns,
    cagr: cagrs,
    performance: {
      ath,
      atl: allTimeLow(series),
      pctFromAth: ath ? ((last - ath.value) / ath.value) * 100 : undefined,
      fiftyTwoWeek: fiftyTwoWeek(series),
      bestDayPct: dailyRets.length ? Math.max(...dailyRets) * 100 : undefined,
      worstDayPct: dailyRets.length ? Math.min(...dailyRets) * 100 : undefined,
      bestYearPct: yearly.length ? Math.max(...yearly) * 100 : undefined,
      worstYearPct: yearly.length ? Math.min(...yearly) * 100 : undefined,
      upDayPct: shareAbove(dailyRets, 0),
      downDayPct: shareAbove(dailyRets.map((r) => -r), 0),
      streak: currentStreak(dailyRets),
    },
    risk: {
      annualizedVolPct: pctOrUndef(annualizedVol(dailyRets)),
      vol30Pct: pctOrUndef(realizedVol(dailyRets, 30)),
      vol90Pct: pctOrUndef(realizedVol(dailyRets, 90)),
      vol1YPct: pctOrUndef(realizedVol(dailyRets, TRADING_DAYS)),
      maxDrawdown: maxDrawdown(series),
      downsideDeviationPct: pctOrUndef(downsideDeviation(dailyRets)),
      var95Pct: pctOrUndef(historicalVar(dailyRets, 0.95)),
      var99Pct: pctOrUndef(historicalVar(dailyRets, 0.99)),
      atr: atr(points),
      sharpe: pctOrUndef(sharpe(dailyRets, riskFreeAnnualPct)),
      sortino: pctOrUndef(sortino(dailyRets, riskFreeAnnualPct)),
    },
    distribution: {
      meanDailyPct: pctOrUndef(mean(dailyRets) * 100),
      medianDailyPct: pctOrUndef(median(dailyRets) * 100),
      skewness: pctOrUndef(skewness(dailyRets)),
      kurtosis: pctOrUndef(kurtosis(dailyRets)),
      positiveMonthsPct: shareAbove(monthly, 0),
      positiveYearsPct: shareAbove(yearly, 0),
      seasonality: monthlySeasonality(series),
    },
    technicals: {
      sma20: sma(cl, 20),
      sma50,
      sma100: sma(cl, 100),
      sma200,
      ema12: ema(cl, 12),
      ema26: ema(cl, 26),
      pctVsSma50: sma50 ? ((last - sma50) / sma50) * 100 : undefined,
      pctVsSma200: sma200 ? ((last - sma200) / sma200) * 100 : undefined,
      goldenCross: sma50 != null && sma200 != null ? sma50 > sma200 : undefined,
      rsi14: rsi(cl, 14),
      macd: macd(cl),
      bollinger: bollinger(cl),
      avgVolume,
      relativeVolume: avgVolume ? mean(recentVol) / avgVolume : undefined,
    },
  };
}
