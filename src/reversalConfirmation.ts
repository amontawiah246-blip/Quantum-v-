// ENGINE 10: REVERSAL CONFIRMATION.
//
// A countertrend sweep (Engine 9) only ARMS a watch. It never trades. The watch produces a signal when, and only when, Engine 8 reports a
// market structure shift in the reversal direction on a later candle:
//   bearish reversal: structure was BULLISH, an upside sweep (highs taken) was recorded, then a candle CLOSES below the protected swing low
//   bullish reversal: structure was BEARISH, a downside sweep (lows taken) was recorded, then a candle CLOSES above the protected swing high
// The reference swing must have been confirmed on an earlier candle than the break (Engine 8 guarantees it; the check is repeated here and
// can be tightened with `requireRefBeforeSweep` so the swing must also pre-date the sweep).
// The watch is dropped when it expires (`maxCandlesToConfirm` after the latest sweep) or when a candle closes beyond the sweep's extreme in
// the old trend's direction (the sweep simply failed and the trend goes on). A repeated countertrend sweep in the same direction keeps the
// same watch, updates its extreme and counts the sweep: the count is reported, it is not a trigger.
// Candle i is judged with information up to i only.
import { Candle } from './candleMath';
import { StructureEvent, StructureSnapshot, Trend } from './structureEngine';
import { SweepEvent, SweepSnapshot } from './sweepIntelligence';

export interface ReversalParams {
  maxCandlesToConfirm: number;               // 20
  invalidateOnCloseBeyondExtreme: boolean;   // true
  requireRefBeforeSweep: boolean;            // false
}
export const REVERSAL_DEFAULTS: ReversalParams = { maxCandlesToConfirm: 20, invalidateOnCloseBeyondExtreme: true, requireRefBeforeSweep: false };

export interface ReversalWatch {
  side: 'BUY' | 'SELL';                      // the reversal trade direction
  priorTrend: Trend;                         // BULLISH for a SELL watch
  firstSweepIndex: number; lastSweepIndex: number;
  extreme: number;                           // highest sweep wick (SELL watch) / lowest (BUY watch)
  sweeps: number;                            // countertrend sweeps seen by this watch
  sweepIds: number[];
}
export interface ReversalCandidate { side: 'BUY' | 'SELL'; watch: ReversalWatch; mss: StructureEvent; signalIndex: number; reasons: string[] }
export interface ReversalDrop { side: 'BUY' | 'SELL'; index: number; reason: string }
export interface ReversalStep { signal: ReversalCandidate | null; dropped: ReversalDrop[]; active: ReversalWatch[] }

export class ReversalConfirmer {
  readonly p: ReversalParams;
  private watches: ReversalWatch[] = [];
  constructor(p: Partial<ReversalParams> = {}) { this.p = { ...REVERSAL_DEFAULTS, ...p }; }

  step(i: number, c: Candle, sw: SweepSnapshot, st: StructureSnapshot): ReversalStep {
    const dropped: ReversalDrop[] = [];
    let signal: ReversalCandidate | null = null;
    const keep: ReversalWatch[] = [];

    for (const w of this.watches) {                       // watches created BEFORE this candle
      const sell = w.side === 'SELL';
      if (i - w.lastSweepIndex > this.p.maxCandlesToConfirm) { dropped.push({ side: w.side, index: i, reason: `no structure shift within ${this.p.maxCandlesToConfirm} candles of the last sweep` }); continue; }
      if (this.p.invalidateOnCloseBeyondExtreme && (sell ? c.close > w.extreme : c.close < w.extreme)) {
        dropped.push({ side: w.side, index: i, reason: `closed ${sell ? 'above' : 'below'} the sweep extreme ${w.extreme}: the sweep failed, trend continues` }); continue;
      }
      const e = st.event;
      const shifted = !!e && e.type === 'MSS' && e.direction === (sell ? 'BEAR' : 'BULL') && e.priorTrend === w.priorTrend && e.index === i
        && e.refConfirmedAt < i && (!this.p.requireRefBeforeSweep || e.refConfirmedAt <= w.firstSweepIndex);
      if (shifted && e) {
        signal = {
          side: w.side, watch: w, mss: e, signalIndex: i,
          reasons: [
            `previous structure ${w.priorTrend}`,
            `${sell ? 'upside' : 'downside'} liquidity sweep recorded (${w.sweeps} countertrend sweep${w.sweeps > 1 ? 's' : ''}, extreme ${w.extreme})`,
            `close ${c.close} ${sell ? 'below' : 'above'} protected swing ${sell ? 'low' : 'high'} ${e.level} (swing candle #${e.refIndex}, confirmed at #${e.refConfirmedAt})`,
          ],
        };
        continue;                                           // watch is used up: one entry per structure shift
      }
      keep.push(w);
    }

    const ns: SweepEvent | null = sw.newSweep;
    if (ns && ns.alignment === 'COUNTERTREND') {
      const w = keep.find((x) => x.side === ns.side);
      if (w) {
        w.lastSweepIndex = i; w.sweeps++; w.sweepIds.push(ns.id);
        w.extreme = ns.side === 'SELL' ? Math.max(w.extreme, ns.extreme) : Math.min(w.extreme, ns.extreme);
      } else keep.push({ side: ns.side, priorTrend: ns.trendAtSweep, firstSweepIndex: i, lastSweepIndex: i, extreme: ns.extreme, sweeps: 1, sweepIds: [ns.id] });
    }
    this.watches = keep;
    return { signal, dropped, active: this.watches.map((w) => ({ ...w })) };
  }
}
