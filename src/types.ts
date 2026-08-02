/** A single point in a historical price/return series. */
export interface SeriesPoint {
  /** Unix epoch milliseconds. */
  t: number;
  /** Value at this point (price, or cumulative % return depending on context). */
  v: number;
}

/**
 * A daily OHLCV bar. Used by the SP500 deep-dive data layer (Stooq/Yahoo) and
 * the stats engine; charting still consumes the lighter SeriesPoint (close-only)
 * via `closeSeries()`.
 */
export interface OhlcvPoint {
  /** Unix epoch milliseconds (bar date, UTC midnight). */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume; 0 when the source omits it. */
  v: number;
}
