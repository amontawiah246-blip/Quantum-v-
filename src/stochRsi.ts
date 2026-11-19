// THE INDICATOR STRATEGY: Stochastic oscillator + RSI, used as the TRIGGER. A candle pattern must then confirm it (src/sweepEngines.ts: detectStochRsi).
//
// Pure functions: candles in, numbers out. Closed candles only, nothing after index i is ever read (no look-ahead).
// This is the ONE definition of the indicators. The market agents' screenshots (src/indicatorChart.ts), the server-side pattern check
// (src/patternVerification.ts) and the engine all call these functions, so every agent draws and reads exactly the same indicator.
//
// BUY  trigger: Stochastic %K crosses UP through 20 (it was below 20, it is now at or above 20)
//               AND RSI crosses UP through 30 or through 50.
// SELL trigger: Stochastic %K crosses DOWN through 80 (it was above 80, it is now at or below 80)
//               AND RSI crosses DOWN through 70 or through 50.
// The two crossings may happen on different candles, at most `alignWindow` candles apart; the trigger fires on the candle where the SECOND one
// completes ("the indicators now confirm a new direction"). One trigger per direction per alignment window.

export type Side = 'BUY' | 'SELL';
export interface IC { time: number; open: number; high: number; low: number; close: number }

export interface StochRsiParams {
  kPeriod: number;        // look-back of the raw %K
  kSmooth: number;        // SMA smoothing of raw %K  -> %K (the slow stochastic)
  dSmooth: number;        // SMA of %K -> %D (drawn on the chart; the trigger uses %K crossing the 20 / 80 lines)
  rsiPeriod: number;      // Wilder RSI
  oversold: number;       // %K crossing UP through this line = BUY half of the trigger
  overbought: number;     // %K crossing DOWN through this line = SELL half of the trigger
  rsiBuyLevels: number[]; // RSI crossing UP through ANY of these
  rsiSellLevels: number[];// RSI crossing DOWN through ANY of these
  alignWindow: number;    // candles within which both crossings must have happened (1 = on the same candle)
  confirmLookback: number;// candles (ending on the trigger candle) in which a candle pattern must exist
  warmup: number;         // candles needed before the indicator values are trusted
}

const envInt = (name: string, d: number, lo: number, hi: number) => {
  const raw = typeof process !== 'undefined' ? Number(process.env?.[name]) : NaN;
  return Number.isFinite(raw) && raw >= lo && raw <= hi ? Math.round(raw) : d;
};

export const STOCH_RSI_DEFAULTS: StochRsiParams = {
  kPeriod: 14, kSmooth: 3, dSmooth: 3, rsiPeriod: 14,
  oversold: 20, overbought: 80,
  rsiBuyLevels: [30, 50], rsiSellLevels: [70, 50],
  alignWindow: envInt('STOCHRSI_ALIGN_WINDOW', 3, 1, 6),
  confirmLookback: envInt('STOCHRSI_CONFIRM_LOOKBACK', 5, 1, 12),
  warmup: 50,
};

/** candles an agent should hand the indicator so the RSI has settled (Wilder smoothing keeps a long memory) */
export const STOCH_RSI_WINDOW = 150;

export interface StochRsiSeries {
  k: (number | null)[];
  d: (number | null)[];
  rsi: (number | null)[];
}

const sma = (xs: (number | null)[], i: number, n: number): number | null => {
  if (i < n - 1) return null;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) { const v = xs[j]; if (v == null) return null; s += v; }
  return s / n;
};

/** Slow stochastic (kPeriod, kSmooth, dSmooth) and Wilder RSI over the candles, aligned index by index. null = not enough data yet. */
export function computeStochRsi(cs: IC[], p: StochRsiParams = STOCH_RSI_DEFAULTS): StochRsiSeries {
  const n = cs.length;
  const raw: (number | null)[] = new Array(n).fill(null);
  for (let i = p.kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - p.kPeriod + 1; j <= i; j++) { if (cs[j].high > hh) hh = cs[j].high; if (cs[j].low < ll) ll = cs[j].low; }
    raw[i] = hh > ll ? (100 * (cs[i].close - ll)) / (hh - ll) : 50;
  }
  const k: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) k[i] = sma(raw, i, p.kSmooth);
  const d: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) d[i] = sma(k, i, p.dSmooth);

  const rsi: (number | null)[] = new Array(n).fill(null);
  if (n > p.rsiPeriod) {
    let ag = 0, al = 0;
    for (let i = 1; i <= p.rsiPeriod; i++) { const ch = cs[i].close - cs[i - 1].close; if (ch > 0) ag += ch; else al -= ch; }
    ag /= p.rsiPeriod; al /= p.rsiPeriod;
    rsi[p.rsiPeriod] = al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
    for (let i = p.rsiPeriod + 1; i < n; i++) {
      const ch = cs[i].close - cs[i - 1].close;
      ag = (ag * (p.rsiPeriod - 1) + (ch > 0 ? ch : 0)) / p.rsiPeriod;
      al = (al * (p.rsiPeriod - 1) + (ch < 0 ? -ch : 0)) / p.rsiPeriod;
      rsi[i] = al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
    }
  }
  return { k, d, rsi };
}

// ------------------------------------------------------------------------------------------------ crossing events
export interface CrossEvent { index: number; from: number; to: number; level: number }

/** %K crossed UP through `oversold` on candle i (BUY half) / DOWN through `overbought` (SELL half) */
export function stochEvent(s: StochRsiSeries, i: number, side: Side, p: StochRsiParams = STOCH_RSI_DEFAULTS): CrossEvent | null {
  const a = s.k[i - 1], b = s.k[i];
  if (i < 1 || a == null || b == null) return null;
  if (side === 'BUY' && a < p.oversold && b >= p.oversold) return { index: i, from: a, to: b, level: p.oversold };
  if (side === 'SELL' && a > p.overbought && b <= p.overbought) return { index: i, from: a, to: b, level: p.overbought };
  return null;
}

/** RSI crossed UP through one of the buy levels (30 / 50) on candle i, or DOWN through one of the sell levels (70 / 50). The highest level crossed is reported for BUY, the lowest for SELL. */
export function rsiEvent(s: StochRsiSeries, i: number, side: Side, p: StochRsiParams = STOCH_RSI_DEFAULTS): CrossEvent | null {
  const a = s.rsi[i - 1], b = s.rsi[i];
  if (i < 1 || a == null || b == null) return null;
  if (side === 'BUY') {
    const hit = p.rsiBuyLevels.filter((L) => a < L && b >= L).sort((x, y) => y - x)[0];
    return hit == null ? null : { index: i, from: a, to: b, level: hit };
  }
  const hit = p.rsiSellLevels.filter((L) => a > L && b <= L).sort((x, y) => x - y)[0];
  return hit == null ? null : { index: i, from: a, to: b, level: hit };
}

export interface IndicatorTrigger {
  side: Side;
  /** the candle on which the second crossing completed (the signal candle) */
  index: number;
  stoch: CrossEvent;
  rsi: CrossEvent;
}

const latestEvent = (fn: (i: number) => CrossEvent | null, i: number, window: number): CrossEvent | null => {
  for (let j = i; j > i - window && j >= 1; j--) { const e = fn(j); if (e) return e; }
  return null;
};

/** The raw trigger on candle i, ignoring the "already fired a moment ago" rule. */
function rawTrigger(s: StochRsiSeries, i: number, side: Side, p: StochRsiParams): IndicatorTrigger | null {
  const st = latestEvent((j) => stochEvent(s, j, side, p), i, p.alignWindow);
  const rs = latestEvent((j) => rsiEvent(s, j, side, p), i, p.alignWindow);
  if (!st || !rs) return null;
  if (Math.max(st.index, rs.index) !== i) return null;     // the second crossing must complete on THIS candle
  return { side, index: i, stoch: st, rsi: rs };
}

/**
 * Does the indicator confirm a NEW direction on candle i (the newest closed candle)?
 * A trigger that already fired for the same side within the last `alignWindow` candles is not a new direction: it is skipped.
 * Both sides firing on one candle is contradictory and returns null.
 */
export function findTrigger(cs: IC[], i: number = cs.length - 1, p: StochRsiParams = STOCH_RSI_DEFAULTS, series?: StochRsiSeries): IndicatorTrigger | null {
  if (i < p.warmup || i >= cs.length) return null;
  const s = series ?? computeStochRsi(cs.slice(0, i + 1), p);
  const out: IndicatorTrigger[] = [];
  for (const side of ['BUY', 'SELL'] as Side[]) {
    const t = rawTrigger(s, i, side, p);
    if (!t) continue;
    let repeat = false;
    for (let j = i - 1; j > i - p.alignWindow && j >= p.warmup; j--) if (rawTrigger(s, j, side, p)) { repeat = true; break; }
    if (!repeat) out.push(t);
  }
  return out.length === 1 ? out[0] : null;
}

/** Plain text of the exact arithmetic, shown in the evidence and on the chart. */
export function describeTrigger(t: IndicatorTrigger, cs: IC[]): string[] {
  const f = (x: number) => x.toFixed(1);
  const buy = t.side === 'BUY';
  return [
    `Stochastic %K crossed ${buy ? 'UP' : 'DOWN'} through ${t.stoch.level} (${f(t.stoch.from)} -> ${f(t.stoch.to)}) on candle ${cs[t.stoch.index]?.time ?? t.stoch.index}`,
    `RSI crossed ${buy ? 'UP' : 'DOWN'} through ${t.rsi.level} (${f(t.rsi.from)} -> ${f(t.rsi.to)}) on candle ${cs[t.rsi.index]?.time ?? t.rsi.index}`,
    `both crossings completed on the signal candle ${cs[t.index]?.time ?? t.index} (alignment window ${STOCH_RSI_DEFAULTS.alignWindow} candle${STOCH_RSI_DEFAULTS.alignWindow > 1 ? 's' : ''})`,
  ];
}
