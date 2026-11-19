// The candlestick-pattern engine (pinbar / hammer / shooting star, engulfing).
//
// These are the SAME rules that used to live inline in src/engineEvaluator.ts (thresholds untouched). They are moved here so the
// indicator strategy (src/stochRsi.ts) can use them as a candle-pattern CONFIRMATION on any recent closed candle, not only on the newest one.
// Pure function: candles in, verdict out. Reads closed candles only and nothing after index i.
type Side = 'BUY' | 'SELL';

export interface PatC { time: number; open: number; high: number; low: number; close: number }

export interface CandlestickHit {
  side: Side;
  /** human names, e.g. "Bullish Pinbar / Hammer" */
  patterns: string[];
  /** stable ids used by the pattern verification rules */
  kind: 'PINBAR' | 'ENGULFING';
  /** index (in the array that was passed) of the candle the pattern completed on */
  index: number;
}

export const PINBAR_WICK_RATIO = 0.6;
export const PINBAR_MAX_BODY = 0.3;

/** Reads the pattern that completes on candle `i`. Order is the original one: pinbar first, then engulfing. */
export function detectCandlestick(cs: PatC[], i: number): CandlestickHit | null {
  const cur = cs[i];
  if (!cur) return null;
  const prev = i > 0 ? cs[i - 1] : undefined;
  const range = Math.max(0.00001, cur.high - cur.low);
  const body = Math.abs(cur.close - cur.open);
  const lowerWick = Math.min(cur.open, cur.close) - cur.low;
  const upperWick = cur.high - Math.max(cur.open, cur.close);

  if (lowerWick / range >= PINBAR_WICK_RATIO && body / range <= PINBAR_MAX_BODY) return { side: 'BUY', patterns: ['Bullish Pinbar / Hammer'], kind: 'PINBAR', index: i };
  if (upperWick / range >= PINBAR_WICK_RATIO && body / range <= PINBAR_MAX_BODY) return { side: 'SELL', patterns: ['Bearish Shooting Star'], kind: 'PINBAR', index: i };
  if (prev && cur.close > cur.open && prev.close < prev.open && cur.close > prev.open && cur.open < prev.close) return { side: 'BUY', patterns: ['Bullish Engulfing Pattern'], kind: 'ENGULFING', index: i };
  if (prev && cur.close < cur.open && prev.close > prev.open && cur.close < prev.close && cur.open > prev.open) return { side: 'SELL', patterns: ['Bearish Engulfing Pattern'], kind: 'ENGULFING', index: i };
  return null;
}
