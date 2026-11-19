// ENGINE 11: CONTINUATION CONFIRMATION.
//
// A sweep that agrees with the established trend (Engine 9: WITH_TREND) is NOT a reversal. This engine watches it and only reports a
// continuation after the ORIGINAL three-candle sweep-continuation rules (Engine 5, src/continuationEngine.ts, untouched) are met:
//   A  the sweeper (Pattern 1 / Pattern 2 against P)       B and C both close in the trade direction, all candles closed and consecutive.
// On top of that the new context rules apply at the moment C closes:
//   - the structure must still agree with the trade direction (a shift against it in between rejects the sequence),
//   - optionally the market must not be classified POSSIBLE_EXHAUSTION / CONFIRMED_STRUCTURE_REVERSAL (Engine 12), `blockOnExhaustion`.
// Invalidated sequences are dropped for good and reported in `rejected`. One watch exists per sweep, so a sequence can signal only once;
// the pipeline additionally blocks repeated entries on the same side inside `duplicateWindow` candles.
// Candle i is judged with candles <= i only (B is checked on its own candle, the full Engine 5 check runs when C has closed).
import { Candle, anatomy, geq, isUnfinished, validOhlc } from './candleMath';
import { CONTINUATION_DEFAULTS, ContinuationParams, sequenceState } from './continuationEngine';
import { ExhaustionReport } from './exhaustionEngine';
import { StructureSnapshot } from './structureEngine';
import { SweepEvent, SweepSnapshot } from './sweepIntelligence';

export interface ContinuationConfirmParams {
  rules: ContinuationParams;            // the original Engine 5 rules
  requireTrendAtConfirm: boolean;       // structure must still be BULLISH (BUY) / BEARISH (SELL) when C closes
  blockOnExhaustion: boolean;           // reject when Engine 12 says POSSIBLE_EXHAUSTION or CONFIRMED_STRUCTURE_REVERSAL
}
export const CONT_CONFIRM_DEFAULTS: ContinuationConfirmParams = { rules: CONTINUATION_DEFAULTS, requireTrendAtConfirm: true, blockOnExhaustion: true };

export interface ContinuationWatch { sweepId: number; side: 'BUY' | 'SELL'; aIndex: number; state: 'AWAITING_B' | 'AWAITING_C' }
export interface ContinuationCandidate { side: 'BUY' | 'SELL'; sweep: SweepEvent; aIndex: number; signalIndex: number; reasons: string[] }
export interface ContinuationRejection { sweepId: number; aIndex: number; index: number; reason: string }
export interface ContinuationStep { signal: ContinuationCandidate | null; rejected: ContinuationRejection[]; active: ContinuationWatch[] }

export class ContinuationConfirmer {
  readonly p: ContinuationConfirmParams;
  private watches: Array<ContinuationWatch & { sweep: SweepEvent }> = [];
  constructor(p: Partial<ContinuationConfirmParams> = {}) { this.p = { ...CONT_CONFIRM_DEFAULTS, ...p }; }

  step(cs: Candle[], i: number, sw: SweepSnapshot, st: StructureSnapshot, ex: ExhaustionReport): ContinuationStep {
    const rejected: ContinuationRejection[] = [];
    let signal: ContinuationCandidate | null = null;
    const keep: Array<ContinuationWatch & { sweep: SweepEvent }> = [];

    for (const w of this.watches) {
      const sell = w.side === 'SELL', colour = sell ? 'bearish' : 'bullish';
      const drop = (reason: string) => rejected.push({ sweepId: w.sweepId, aIndex: w.aIndex, index: i, reason });
      const wantTrend = sell ? 'BEARISH' : 'BULLISH';
      const c = cs[i];

      if (st.event && st.event.type === 'MSS' && (st.event.direction === 'BULL') === sell) { drop('structure shifted against the trade direction'); continue; }

      if (i === w.aIndex + 1) {                                   // candle B
        const ok = validOhlc(c) && !isUnfinished(c) && (sell ? c.close < c.open : c.close > c.open)
          && (this.p.rules.minConfirmBodyRatio <= 0 || geq(anatomy(c).bodyRatio, this.p.rules.minConfirmBodyRatio));
        if (!ok) { drop(`B did not close ${colour}`); continue; }
        keep.push({ ...w, state: 'AWAITING_C' });
      } else if (i === w.aIndex + 2) {                            // candle C: the original Engine 5 rule decides
        const e = sequenceState(cs, w.aIndex, w.side, this.p.rules, false);
        if (e.state !== 'CONFIRMED') { drop(`Engine 5 sequence ${e.state}: ${e.reason}`); continue; }
        if (this.p.requireTrendAtConfirm && st.trend !== wantTrend) { drop(`structure is ${st.trend} when C closed, trade needs ${wantTrend}`); continue; }
        if (this.p.blockOnExhaustion && (ex.state === 'POSSIBLE_EXHAUSTION' || ex.state === 'CONFIRMED_STRUCTURE_REVERSAL')) { drop(`exhaustion check: ${ex.state} (${ex.reason})`); continue; }
        const full = sequenceState(cs, w.aIndex, w.side, this.p.rules, true);
        signal = { side: w.side, sweep: w.sweep, aIndex: w.aIndex, signalIndex: i, reasons: [`with-trend sweep: ${w.sweep.reason}`, ...full.trace.checks.filter((x) => x.pass).map((x) => `${x.name}: ${x.detail}`)] };
      } else if (i > w.aIndex + 2) { /* finished earlier; cannot happen */ } else keep.push(w);
    }

    const ns = sw.newSweep;
    if (ns && ns.alignment === 'WITH_TREND') keep.push({ sweepId: ns.id, side: ns.side, aIndex: i, state: 'AWAITING_B', sweep: ns });
    this.watches = keep.slice(-8);
    return { signal, rejected, active: this.watches.map(({ sweep: _s, ...w }) => w) };
  }
}
