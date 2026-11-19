// EQUAL-LEVEL WICK SWEEPS (the "equal highs / equal lows" liquidity sweeps).
//
// NOTE ON PROVENANCE: the uploaded project did not contain these two patterns (docs/ENGINES_5_6.md: "Patterns 3 and 4 (equal-level sweeps)
// are not in this repo"). This file is a new, candle-only implementation written from the plain description, so the exact thresholds are MY
// ASSUMPTION. They are configurable here, they are frozen for trading (the hybrid never changes them), and they do not touch Patterns 1/2,
// Engines 5/6 or the wick-sweep engine. If you have your original rule for these two, replace `checkEqualLevelSweep` and keep the signature.
//
// SELL (equal-highs sweep, "upper-wick sweep"):
//   The `lookback` candles before the sweeper have a range high H. At least `touches` of them have a high within `tol` of H (an equal-high
//   pool: resting buy-stops above it). tol = tolMult x median candle range of the `tolRangeWindow` candles before the sweeper.
//   The sweeper candle A: bearish, high strictly above H, closes back below H, its OPEN is not above H (only the wick goes through),
//   upper wick / range >= minWickRatio.
// BUY (equal-lows sweep, "lower-wick sweep") is the exact mirror: equal lows, bullish sweeper, low strictly below L, closes back above L.
// Signal exists when A has closed; the trade is for the next candle's open. Uses candles <= i only. No indicators (tol comes from candle ranges).
import { Candle, Tracer, contiguous, fmt, isUnfinished, median, validOhlc } from './candleMath';
import { registerSweepSource } from './sweepIntelligence';

export interface EqualLevelParams { lookback: number; touches: number; tolMult: number; tolRangeWindow: number; minWickRatio: number }
export const EQUAL_LEVEL_DEFAULTS: EqualLevelParams = { lookback: 12, touches: 2, tolMult: 0.1, tolRangeWindow: 14, minWickRatio: 0.35 };

export type EqualSide = 'SELL' | 'BUY';
export interface EqualLevelHit { side: EqualSide; level: number; touches: number; tol: number; extreme: number }

const mirrorC = (c: Candle): Candle => ({ time: c.time, open: -c.open, high: -c.low, low: -c.high, close: -c.close, closed: c.closed });

/** Writes every check into `t`. Returns the hit or null. `i` is the sweeper candle. */
export function checkEqualLevelSweep(t: Tracer, side: EqualSide, cs: Candle[], i: number, p: EqualLevelParams = EQUAL_LEVEL_DEFAULTS): EqualLevelHit | null {
  const need = Math.max(p.lookback, p.tolRangeWindow);
  if (!t.step('enough history', i >= need && i < cs.length, () => `need ${need} candles before the sweeper, have ${i}`)) return null;
  const raw = cs.slice(i - need, i + 1);
  if (!t.step('candles valid, closed and consecutive', raw.every((c) => validOhlc(c) && !isUnfinished(c)) && contiguous(raw), () => 'data check on the window')) return null;
  const w = side === 'SELL' ? raw : raw.map(mirrorC);           // BUY = SELL on mirrored prices
  const A = w[w.length - 1];
  const zone = w.slice(w.length - 1 - p.lookback, w.length - 1);
  const H = Math.max(...zone.map((c) => c.high));
  const tol = p.tolMult * median(w.slice(w.length - 1 - p.tolRangeWindow, w.length - 1).map((c) => c.high - c.low));
  const touches = zone.filter((c) => c.high >= H - tol).length;
  const sg = side === 'SELL' ? 1 : -1;                          // maps mirrored prices back to real ones
  const real = (x: number) => sg * x;
  const noun = side === 'SELL' ? 'highs' : 'lows';
  if (!t.step(`equal ${noun} pool`, touches >= p.touches && tol >= 0,
    () => `${touches} of ${p.lookback} candles within ${fmt(tol)} of the range ${side === 'SELL' ? 'high' : 'low'} ${fmt(real(H))}, need >= ${p.touches}`)) return null;
  if (!t.step(`sweeper ${side === 'SELL' ? 'bearish' : 'bullish'}`, A.close < A.open, () => `A.close ${fmt(real(A.close))} vs A.open ${fmt(real(A.open))}`)) return null;
  if (!t.step(`${side === 'SELL' ? 'high strictly above' : 'low strictly below'} the equal level`, A.high > H, () => `A ${side === 'SELL' ? 'high' : 'low'} ${fmt(real(A.high))} vs level ${fmt(real(H))}`)) return null;
  if (!t.step('closes back inside', A.close < H, () => `A.close ${fmt(real(A.close))} vs level ${fmt(real(H))}`)) return null;
  if (!t.step('open not beyond the level (wick-only sweep)', A.open <= H, () => `A.open ${fmt(real(A.open))} vs level ${fmt(real(H))}`)) return null;
  const range = A.high - A.low;
  const wick = range > 0 ? (A.high - Math.max(A.open, A.close)) / range : 0;
  if (!t.step('rejection wick', wick >= p.minWickRatio, () => `${side === 'SELL' ? 'upper' : 'lower'} wick / range ${fmt(wick)} >= ${fmt(p.minWickRatio)}`)) return null;
  return t.passed ? { side, level: real(H), touches, tol, extreme: real(A.high) } : null;
}

export function detectEqualLevelSweep(cs: Candle[], i: number, side: EqualSide, p: EqualLevelParams = EQUAL_LEVEL_DEFAULTS): EqualLevelHit | null {
  return checkEqualLevelSweep(new Tracer(false), side, cs, i, p);
}

/** Verbose arithmetic for a log or a chart note. */
export function explainEqualLevelSweep(cs: Candle[], i: number, side: EqualSide, p: EqualLevelParams = EQUAL_LEVEL_DEFAULTS): { hit: EqualLevelHit | null; lines: string[] } {
  const t = new Tracer(true);
  const hit = checkEqualLevelSweep(t, side, cs, i, p);
  return { hit, lines: t.result().checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`) };
}

// Sweep source for Engine 9 (repeated-sweep counting). The engine's default sources stay ['pattern12']; the hybrid asks for 'equal_wick' too.
registerSweepSource('equal_wick', (cs, i) => {
  const s = detectEqualLevelSweep(cs, i, 'SELL'); if (s) return { side: 'SELL', level: s.level, extreme: s.extreme };
  const b = detectEqualLevelSweep(cs, i, 'BUY'); if (b) return { side: 'BUY', level: b.level, extreme: b.extreme };
  return null;
});
