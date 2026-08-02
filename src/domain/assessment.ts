import type { MacroSnapshot } from '../sources/fred';
import type { StatsSummary } from './stats';

/**
 * Rule-based read on where the market stands — valuation, risk, and trend —
 * derived entirely from the stats and FRED data already on screen.
 *
 * Design rule: wherever history exists, a judgement is a PERCENTILE against the
 * market's own past, not an invented threshold. "Expensive" means expensive
 * relative to the last ~80 years of the same measure. Where no distribution is
 * available (curve inversion, RSI, inflation) the thresholds are the long-standing
 * conventional ones and are named in the text so the user can disagree with them.
 *
 * This is descriptive, not advice, and every function here is pure.
 */

export type SignalLevel = 'good' | 'neutral' | 'caution' | 'warning';

export type Verdict = 'undervalued' | 'fairly valued' | 'elevated' | 'stretched' | 'unknown';

export interface Signal {
  label: string;
  /** Short display value, e.g. "27.1 · 94th pct". */
  value: string;
  level: SignalLevel;
  /** One sentence of plain-language context. */
  detail: string;
}

export interface Assessment {
  headline: string;
  verdict: Verdict;
  /** Blended "expensiveness" percentile across the valuation measures. */
  valuationPercentile?: number;
  valuation: Signal[];
  risk: Signal[];
  trend: Signal[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** 94 → "94th", 1 → "1st". */
export function ordinal(n: number): string {
  const r = Math.round(n);
  const mod100 = r % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${r}th`;
  switch (r % 10) {
    case 1:
      return `${r}st`;
    case 2:
      return `${r}nd`;
    case 3:
      return `${r}rd`;
    default:
      return `${r}th`;
  }
}

function year(t?: number): string {
  return t == null ? 'the start of the record' : String(new Date(t).getUTCFullYear());
}

/** Level for a measure where a HIGH percentile means expensive/risky. */
function levelFromPercentile(pct?: number): SignalLevel {
  if (pct == null) return 'neutral';
  if (pct >= 90) return 'warning';
  if (pct >= 70) return 'caution';
  if (pct <= 25) return 'good';
  return 'neutral';
}

function num(n?: number, digits = 2): string {
  return n == null || !Number.isFinite(n) ? 'N/A' : n.toFixed(digits);
}

function pct(n?: number): string {
  return n == null || !Number.isFinite(n) ? 'N/A' : `${n.toFixed(2)}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Valuation
// ─────────────────────────────────────────────────────────────────────────────

function valuationSignals(m?: MacroSnapshot): Signal[] {
  const v = m?.valuation;
  if (!v || v.marketPe == null) {
    return [
      {
        label: 'Valuation',
        value: 'N/A',
        level: 'neutral',
        detail: 'No FRED data loaded, so valuation cannot be assessed.',
      },
    ];
  }

  const since = year(v.historySinceT);
  const signals: Signal[] = [];

  signals.push({
    label: 'Market P/E',
    value:
      v.marketPePercentile != null
        ? `${num(v.marketPe)} · ${ordinal(v.marketPePercentile)} pct`
        : num(v.marketPe),
    level: levelFromPercentile(v.marketPePercentile),
    detail:
      v.marketPePercentile != null
        ? `Higher than ${Math.round(v.marketPePercentile)}% of quarters since ${since}. Economy-wide proxy, not the index's own P/E.`
        : `Economy-wide proxy, not the index's own P/E.`,
  });

  if (v.buffettIndicatorPct != null) {
    signals.push({
      label: 'Buffett indicator',
      value:
        v.buffettPercentile != null
          ? `${pct(v.buffettIndicatorPct)} · ${ordinal(v.buffettPercentile)} pct`
          : pct(v.buffettIndicatorPct),
      level: levelFromPercentile(v.buffettPercentile),
      detail: `Corporate equity value versus GDP, against its own range since ${since}.`,
    });
  }

  if (v.equityRiskPremiumPct != null) {
    const erp = v.equityRiskPremiumPct;
    signals.push({
      label: 'Equity risk premium',
      value: pct(erp),
      level: erp < 0 ? 'warning' : erp < 1 ? 'caution' : 'good',
      detail:
        erp < 0
          ? 'Earnings yield is below the 10Y Treasury — equities are priced to yield less than risk-free bonds.'
          : erp < 1
            ? 'A thin cushion over the 10Y Treasury for taking equity risk.'
            : 'Equities offer a clear yield premium over the 10Y Treasury.',
    });
  }

  return signals;
}

/**
 * Blend the available valuation percentiles into one "expensiveness" number.
 * The equity risk premium is inverted first: a LOW premium means expensive.
 */
export function blendedValuationPercentile(m?: MacroSnapshot): number | undefined {
  const v = m?.valuation;
  if (!v) return undefined;
  const parts = [v.marketPePercentile, v.buffettPercentile].filter(
    (p): p is number => p != null && Number.isFinite(p),
  );
  if (parts.length === 0) return undefined;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

export function verdictFrom(percentile?: number): Verdict {
  if (percentile == null) return 'unknown';
  if (percentile >= 90) return 'stretched';
  if (percentile >= 70) return 'elevated';
  if (percentile <= 25) return 'undervalued';
  return 'fairly valued';
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk
// ─────────────────────────────────────────────────────────────────────────────

function riskSignals(s: StatsSummary, m?: MacroSnapshot): Signal[] {
  const signals: Signal[] = [];

  const dd = s.performance.pctFromAth;
  if (dd != null) {
    signals.push({
      label: 'Drawdown from high',
      value: pct(dd),
      // Conventional market definitions: -10% correction, -20% bear market.
      level: dd <= -20 ? 'warning' : dd <= -10 ? 'caution' : 'neutral',
      detail:
        dd <= -20
          ? 'Bear-market territory — more than 20% below the all-time high.'
          : dd <= -10
            ? 'In a correction — more than 10% below the all-time high.'
            : 'Trading near the all-time high.',
    });
  }

  // Recent vol against the market's own long-run average, not a fixed number.
  const recent = s.risk.vol1YPct;
  const longRun = s.risk.annualizedVolPct;
  if (recent != null && longRun != null && longRun > 0) {
    const ratio = recent / longRun;
    signals.push({
      label: 'Realized volatility',
      value: `${pct(recent)} · ${num(ratio)}× normal`,
      level: ratio >= 1.5 ? 'warning' : ratio >= 1.2 ? 'caution' : ratio <= 0.8 ? 'good' : 'neutral',
      detail: `Trailing 1-year volatility versus this market's own ${pct(longRun)} long-run average.`,
    });
  }

  if (m?.vix != null) {
    signals.push({
      label: 'VIX',
      value:
        m.vixPercentile != null ? `${num(m.vix)} · ${ordinal(m.vixPercentile)} pct` : num(m.vix),
      level: levelFromPercentile(m.vixPercentile),
      detail: `Implied volatility against its trailing 10-year daily range.`,
    });
  }

  // Curve inversion: prefer 10Y-3M, the spread with the stronger track record.
  const spread = m?.spread10Y3MPct ?? m?.spread10Y2YPct;
  if (spread != null) {
    const which = m?.spread10Y3MPct != null ? '10Y − 3M' : '10Y − 2Y';
    signals.push({
      label: 'Yield curve',
      value: `${pct(spread)} (${which})`,
      level: spread < 0 ? 'warning' : spread < 0.5 ? 'caution' : 'good',
      detail:
        spread < 0
          ? 'Inverted — historically a recession signal, though it has led downturns by a year or more.'
          : spread < 0.5
            ? 'Nearly flat, leaving little margin before inversion.'
            : 'Positively sloped, the normal condition.',
    });
  }

  if (m?.cpiYoYPct != null) {
    const cpi = m.cpiYoYPct;
    signals.push({
      label: 'Inflation',
      value: pct(cpi),
      // Against the Fed's stated 2% target rather than a percentile.
      level: cpi >= 4 ? 'warning' : cpi >= 3 ? 'caution' : cpi < 0 ? 'caution' : 'good',
      detail:
        cpi >= 3
          ? `Running above the Fed's 2% target, which constrains rate cuts.`
          : cpi < 0
            ? 'Outright deflation, itself a warning sign.'
            : `Close to the Fed's 2% target.`,
    });
  }

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trend
// ─────────────────────────────────────────────────────────────────────────────

function trendSignals(s: StatsSummary): Signal[] {
  const t = s.technicals;
  const signals: Signal[] = [];

  if (t.pctVsSma200 != null) {
    signals.push({
      label: 'Price vs 200-day',
      value: pct(t.pctVsSma200),
      level: t.pctVsSma200 >= 0 ? 'good' : 'caution',
      detail:
        t.pctVsSma200 >= 0
          ? 'Above the 200-day average — the long-term trend is intact.'
          : 'Below the 200-day average — the long-term trend has broken.',
    });
  }

  if (t.goldenCross != null) {
    signals.push({
      label: 'Trend structure',
      value: t.goldenCross ? 'Golden cross' : 'Death cross',
      level: t.goldenCross ? 'good' : 'caution',
      detail: t.goldenCross
        ? '50-day average sits above the 200-day.'
        : '50-day average has fallen below the 200-day.',
    });
  }

  if (t.rsi14 != null) {
    signals.push({
      label: 'RSI (14)',
      value: num(t.rsi14),
      level: t.rsi14 >= 70 || t.rsi14 <= 30 ? 'caution' : 'neutral',
      detail:
        t.rsi14 >= 70
          ? 'Overbought on the conventional 70 threshold — stretched short term.'
          : t.rsi14 <= 30
            ? 'Oversold on the conventional 30 threshold.'
            : 'Neither overbought nor oversold.',
    });
  }

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Headline
// ─────────────────────────────────────────────────────────────────────────────

const VERDICT_PHRASE: Record<Verdict, string> = {
  stretched: 'Valuations look stretched',
  elevated: 'Valuations look elevated',
  'fairly valued': 'Valuations look about average',
  undervalued: 'Valuations look low',
  unknown: 'Valuation is unavailable',
};

function buildHeadline(verdict: Verdict, percentile: number | undefined, all: Signal[]): string {
  const head =
    verdict === 'unknown'
      ? VERDICT_PHRASE.unknown
      : percentile != null
        ? `${VERDICT_PHRASE[verdict]} (${ordinal(percentile)} percentile historically)`
        : VERDICT_PHRASE[verdict];

  const warnings = all.filter((s) => s.level === 'warning');
  if (warnings.length > 0) {
    const names = warnings.map((w) => w.label.toLowerCase()).join(', ');
    return `${head}. ${warnings.length} warning signal${warnings.length > 1 ? 's' : ''}: ${names}.`;
  }
  const cautions = all.filter((s) => s.level === 'caution');
  if (cautions.length > 0) {
    return `${head}. No warning signals, but ${cautions.length} worth watching.`;
  }
  return `${head}. No warning signals.`;
}

/** Build the full assessment. Pure — `macro` may be absent. */
export function buildAssessment(s: StatsSummary, macro?: MacroSnapshot): Assessment {
  const valuation = valuationSignals(macro);
  const risk = riskSignals(s, macro);
  const trend = trendSignals(s);
  const valuationPercentile = blendedValuationPercentile(macro);
  const verdict = verdictFrom(valuationPercentile);

  return {
    headline: buildHeadline(verdict, valuationPercentile, [...valuation, ...risk, ...trend]),
    verdict,
    valuationPercentile,
    valuation,
    risk,
    trend,
  };
}
