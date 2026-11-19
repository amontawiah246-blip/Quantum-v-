// LSCC: Liquidity Sweep Confirmation Candle. Pure functions: candles in, verdict out. They read CLOSED candles only and nothing after index i.
//
//   BUY  (bullish)  1. an established liquidity level (a swing low) sits below price
//                   2. the SWEEP candle wicks below that level (low STRICTLY below) while its body stays at or above it
//                   3. the sweep candle closes back above the level
//                   4. the NEXT completed candle is the CONFIRMATION candle: bullish AND it closes above the sweep candle's high
//                   5. the candle after the confirmation candle is the ENTRY candle: trade its open
//   SELL (bearish)  the exact mirror: swing high, upper wick, close back below, bearish candle closing below the sweep candle's low.
//
// Liquidity = a swing extreme with `swing` strictly higher (lower) candles on each side. A swing is only known once its `swing` right-hand candles
// have closed, and those must all close BEFORE the sweep candle, so the level never uses a candle that comes after it (no repainting).
// A level that any later candle already traded through is spent and is never used again. Entry never happens on the sweep or the confirmation candle.
export interface Bar { time: number; open: number; high: number; low: number; close: number }
export type Side = 'BUY' | 'SELL';

export interface LsccParams {
  /** candles on each side that make a swing extreme (a "liquidity level") */
  swing: number;
  /** how many candles before the sweep candle may hold the swing */
  lookback: number;
}
export const LSCC_DEFAULTS: LsccParams = { swing: 2, lookback: 40 };

export interface LsccSweep {
  side: Side;
  /** the exact liquidity level that was swept, and the candle that formed it */
  level: number;
  levelTime: number;
  levelIndex: number;
  sweepIndex: number;
  sweepTime: number;
  reasons: string[];
}
export interface LsccSignal extends LsccSweep {
  confirmIndex: number;
  confirmTime: number;
  /** open time of the candle the trade is placed on (the candle after the confirmation candle) */
  entryTime: number;
  /** close of the confirmation candle: the price the entry follows */
  entryReference: number;
}

const f = (x: number) => String(+x.toPrecision(10));
const mirror = (c: Bar): Bar => ({ time: c.time, open: -c.open, high: -c.low, low: -c.high, close: -c.close });

/** Bullish sweep on candle `i` (the candle that just closed). null = candle i is not a bullish LSCC sweep. */
function bullishSweep(cs: Bar[], i: number, p: LsccParams): LsccSweep | null {
  if (i < p.swing * 2 + 2 || i >= cs.length) return null;
  const sw = cs[i], prev = cs[i - 1];
  const bodyLo = Math.min(sw.open, sw.close);
  if (!(sw.low < bodyLo || sw.low < sw.close)) return null;                 // a lower wick must exist at all
  let best: { j: number; level: number } | null = null;
  const first = Math.max(p.swing, i - p.lookback);
  for (let j = i - 1 - p.swing; j >= first; j--) {                           // right-hand candles j+1..j+swing must all be before the sweep candle
    const lv = cs[j].low;
    let swing = true;
    for (let k = 1; k <= p.swing && swing; k++) if (!(cs[j - k].low > lv) || !(cs[j + k].low > lv)) swing = false;
    if (!swing) continue;
    let spent = false;                                                       // already traded through by a candle between the swing and the sweep candle
    for (let m = j + 1; m < i; m++) if (cs[m].low < lv) { spent = true; break; }
    if (spent) continue;
    if (!(prev.close > lv)) continue;                                        // the level must lie below price
    if (!(sw.low < lv)) continue;                                            // wick penetration, STRICT (equal = a touch, not a sweep)
    if (!(bodyLo >= lv)) continue;                                           // only the wick goes through: a body below the level is a breakout
    if (!(sw.close > lv)) continue;                                          // and the candle closes back above the level
    if (!best || lv > best.level) best = { j, level: lv };                   // the level nearest to price
  }
  if (!best) return null;
  const lv = best.level;
  return {
    side: 'BUY', level: lv, levelTime: cs[best.j].time, levelIndex: best.j, sweepIndex: i, sweepTime: sw.time,
    reasons: [
      `liquidity level ${f(lv)} (swing low of ${new Date(cs[best.j].time * 1000).toISOString().slice(11, 16)} UTC, untouched since)`,
      `sweep candle low ${f(sw.low)} < level ${f(lv)} (wick penetration)`,
      `sweep body low ${f(bodyLo)} >= level, close ${f(sw.close)} back above ${f(lv)}`,
    ],
  };
}

/** Sweep candle = cs[i]. BUY sweeps a swing low, SELL sweeps a swing high. */
export function findLsccSweep(cs: Bar[], i: number, p: LsccParams = LSCC_DEFAULTS): LsccSweep | null {
  const b = bullishSweep(cs, i, p);
  if (b) return b;
  const win = cs.slice(0, i + 1).map(mirror);
  const s = bullishSweep(win, i, p);
  if (!s) return null;
  return {
    ...s, side: 'SELL', level: -s.level,
    reasons: [
      `liquidity level ${f(-s.level)} (swing high of ${new Date(cs[s.levelIndex].time * 1000).toISOString().slice(11, 16)} UTC, untouched since)`,
      `sweep candle high ${f(cs[i].high)} > level ${f(-s.level)} (wick penetration)`,
      `sweep body high ${f(Math.max(cs[i].open, cs[i].close))} <= level, close ${f(cs[i].close)} back below ${f(-s.level)}`,
    ],
  };
}

/** Confirmation candle = cs[i]; the sweep candle is cs[i-1]. Returns the setup only when the confirmation is genuine. Entry = the candle after i. */
export function detectLsccSignal(cs: Bar[], i: number, p: LsccParams = LSCC_DEFAULTS): LsccSignal | null {
  if (i < 1 || i >= cs.length) return null;
  const sweep = findLsccSweep(cs, i - 1, p);
  if (!sweep) return null;
  const sw = cs[i - 1], cf = cs[i];
  const gap = sw.time - cs[i - 2].time;
  if (!(gap > 0) || cf.time - sw.time !== gap) return null;                  // the confirmation candle must be the very next candle
  const buy = sweep.side === 'BUY';
  const colour = buy ? cf.close > cf.open : cf.close < cf.open;
  const beyond = buy ? cf.close > sw.high : cf.close < sw.low;               // the strict confirmation: a CLOSE beyond the sweep candle's extreme
  if (!colour || !beyond) return null;
  return {
    ...sweep, confirmIndex: i, confirmTime: cf.time, entryTime: cf.time + gap, entryReference: cf.close,
    reasons: [
      ...sweep.reasons,
      `confirmation candle is ${buy ? 'bullish' : 'bearish'} (close ${f(cf.close)} ${buy ? '>' : '<'} open ${f(cf.open)})`,
      `confirmation close ${f(cf.close)} ${buy ? '>' : '<'} sweep candle ${buy ? 'high' : 'low'} ${f(buy ? sw.high : sw.low)}`,
      'trade on the next candle open (not the sweep candle, not the confirmation candle)',
    ],
  };
}

export type LsccState = 'WAITING' | 'BUY' | 'SELL' | 'INVALID' | 'EXPIRED';

/** What happened to a sweep once the candle after it has closed. cs[i] = that next candle. */
export function lsccOutcome(cs: Bar[], i: number, p: LsccParams = LSCC_DEFAULTS): { state: 'CONFIRMED'; signal: LsccSignal } | { state: 'INVALID'; reason: string } | null {
  const sweep = findLsccSweep(cs, i - 1, p);
  if (!sweep) return null;
  const sig = detectLsccSignal(cs, i, p);
  if (sig) return { state: 'CONFIRMED', signal: sig };
  const sw = cs[i - 1], cf = cs[i], buy = sweep.side === 'BUY';
  const why = !(buy ? cf.close > cf.open : cf.close < cf.open) ? `confirmation candle is not ${buy ? 'bullish' : 'bearish'}`
    : `confirmation close ${f(cf.close)} did not close ${buy ? 'above the sweep high' : 'below the sweep low'} ${f(buy ? sw.high : sw.low)}`;
  return { state: 'INVALID', reason: `confirmation failed: ${why}` };
}
