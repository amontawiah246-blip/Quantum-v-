// QUANTUM SIGNAL PIPELINE: puts Engines 7 to 12 (and the untouched original engines) in the required order.
//
//   1. validate market data        invalid / unfinished / duplicate / out-of-order / gapped candles never reach an engine
//   2. establish market structure  Engine 8
//   3. detect candlestick patterns Engine 7 classification, Pattern 1/2 sweeps (Engine 9 source), Engine 5 and 6 as context
//   4. classify trend alignment    Engine 9: WITH_TREND / COUNTERTREND / NO_TREND, sweep count and cluster position
//   5. validate continuation or reversal   Engine 11 (with-trend) or Engine 10 (countertrend + confirmed structure shift); Engine 12 gates continuation
//   6. check duplicate and conflicting signals
//   7. produce BUY, SELL or NO_TRADE, with an explanation of exactly what was seen
//
// The pipeline is fed ONE CLOSED candle at a time (`step`). A decision for candle i can only use candles 0..i, and the signal is for the
// NEXT candle's open. It does not replace or weaken the original engines: those keep running through src/sweepEngines.ts.
// A gap in the candle times (or any invalid candle) resets all state: structure and sweeps are not carried across missing data.
import { Candle, validOhlc } from './candleMath';
import { detectContinuationSignal } from './continuationEngine';
import { ContinuationConfirmParams, ContinuationConfirmer } from './continuationConfirmation';
import { EXHAUSTION_DEFAULTS, ExhaustionParams, ExhaustionReport, evaluateExhaustion } from './exhaustionEngine';
import { MOMENTUM_DEFAULTS, detectMomentumSignal } from './momentumEngine';
import { ReversalConfirmer, ReversalParams } from './reversalConfirmation';
import { SEQUENCE_DEFAULTS, SequenceParams, SequenceResult, classifySequence } from './sequenceClassifier';
import { STRUCTURE_DEFAULTS, StructureParams, StructureSnapshot, StructureTracker, Trend } from './structureEngine';
import { SWEEP_DEFAULTS, SweepEvent, SweepParams, SweepSnapshot, SweepTracker } from './sweepIntelligence';
import { CONT_CONFIRM_DEFAULTS } from './continuationConfirmation';
import { REVERSAL_DEFAULTS } from './reversalConfirmation';

export type Action = 'BUY' | 'SELL' | 'NO_TRADE';
export type SignalKind = 'WITH_TREND_CONTINUATION' | 'CONFIRMED_REVERSAL';
export type MachineState = 'NORMAL' | 'SWEEP_DETECTED' | 'CONTINUATION_WATCH' | 'REVERSAL_WATCH' | 'REPEATED_SWEEP_MONITOR' | 'CONFIRMED' | 'NO_TRADE';

export interface QuantumParams {
  structure: StructureParams; sweep: SweepParams; sequence: SequenceParams; exhaustion: ExhaustionParams;
  continuation: ContinuationConfirmParams; reversal: ReversalParams;
  minHistory: number;            // candles before the first possible signal (30)
  duplicateWindow: number;       // a second signal on the same side within this many candles is blocked (3)
  conflictWindow: number;        // an opposite signal within this many candles of a previous one is blocked (3)
  allowContinuation: boolean;    // Engine 11 path on/off
  allowReversal: boolean;        // Engine 10 path on/off
  resetOnGap: boolean;           // a missing candle resets all state (true)
}
export const QUANTUM_DEFAULTS: QuantumParams = {
  structure: STRUCTURE_DEFAULTS, sweep: SWEEP_DEFAULTS, sequence: SEQUENCE_DEFAULTS, exhaustion: EXHAUSTION_DEFAULTS,
  continuation: CONT_CONFIRM_DEFAULTS, reversal: REVERSAL_DEFAULTS,
  minHistory: 30, duplicateWindow: 3, conflictWindow: 3, allowContinuation: true, allowReversal: true, resetOnGap: true,
};

/** Overrides one level deep, e.g. quantumParams({ exhaustion: { minSigns: 2 }, minHistory: 40 }). */
export type QuantumOverrides = { [K in keyof QuantumParams]?: QuantumParams[K] extends object ? Partial<QuantumParams[K]> : QuantumParams[K] };
export function quantumParams(o: QuantumOverrides = {}): QuantumParams {
  const out: any = { ...QUANTUM_DEFAULTS };
  for (const k of Object.keys(o) as Array<keyof QuantumParams>) {
    const v = (o as any)[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(QUANTUM_DEFAULTS as any)[k], ...v } : v;
  }
  return out as QuantumParams;
}

export interface Explanation {
  marketStructure: { label: string; detail: string };
  liquiditySweeps: { recent: number; text: string };
  trendAlignment: string;
  candleMomentum: string;
  structureStatus: string;
  verdict: string;
  reason: string;
  notes: string[];                  // watches opened / dropped, rejected sequences
}

export interface Decision {
  index: number; time: number; closeTime: number | null;     // index = position in the input stream; closeTime = when this candle closed (null when unknown)
  runStart: number;                        // stream index of the first candle of the current valid run. Indexes inside `structure` and `sweep` are local to the run: stream index = runStart + local index
  action: Action;
  kind: SignalKind | null;
  reason: string;
  state: MachineState;
  trend: Trend;
  structure: StructureSnapshot | null;
  sweep: SweepEvent | null;                // a sweep ON this candle
  sweepCount: number;                      // the count that belongs to the signal / sweep: cluster ordinal, or sweeps in the reversal watch
  recentSweeps: number;
  alignment: SweepEvent['alignment'] | null;
  exhaustion: ExhaustionReport | null;
  sequence: SequenceResult | null;
  original: { continuation: 'BUY' | 'SELL' | null; momentum: 'BUY' | 'SELL' | null };   // what Engines 5 and 6 say on this candle (context only)
  signal: { side: 'BUY' | 'SELL'; kind: SignalKind; reasons: string[]; sweepIndex: number | null; entryReference: number; trendContext: Trend } | null;   // trendContext: the trend the signal was judged against (for a reversal, the trend that was shifted away from)
  explanation: Explanation;
}

const empty = (r: string): Explanation => ({ marketStructure: { label: 'UNKNOWN', detail: '' }, liquiditySweeps: { recent: 0, text: 'none' }, trendAlignment: 'n/a', candleMomentum: 'n/a', structureStatus: 'n/a', verdict: 'NO TRADE', reason: r, notes: [] });

export class QuantumPipeline {
  readonly p: QuantumParams;
  private n = 0;                                   // candles fed so far (decision index)
  private cs: Candle[] = [];                       // current valid run
  private tf = 0;
  private structure!: StructureTracker; private sweeps!: SweepTracker; private cont!: ContinuationConfirmer; private rev!: ReversalConfirmer;
  private lastSnap: StructureSnapshot | null = null;
  private recent: Array<{ side: 'BUY' | 'SELL'; index: number }> = [];
  constructor(p: QuantumParams = QUANTUM_DEFAULTS) { this.p = p; this.reset(); }

  private reset() {
    this.cs = []; this.lastSnap = null; this.recent = [];
    this.structure = new StructureTracker(this.p.structure); this.sweeps = new SweepTracker(this.p.sweep);
    this.cont = new ContinuationConfirmer(this.p.continuation); this.rev = new ReversalConfirmer(this.p.reversal);
  }

  private reject(index: number, c: Candle, reason: string): Decision {
    return {
      index, time: c?.time ?? 0, closeTime: null, runStart: index, action: 'NO_TRADE', kind: null, reason, state: 'NO_TRADE', trend: 'NEUTRAL', structure: null, sweep: null, sweepCount: 0, recentSweeps: 0,
      alignment: null, exhaustion: null, sequence: null, original: { continuation: null, momentum: null }, signal: null, explanation: empty(reason),
    };
  }

  /** Feed the next candle. Returns the decision for the candle that has just CLOSED. */
  step(c: Candle): Decision {
    const g = this.n++;
    // ---- 1. validate market data
    if (!c || !validOhlc(c)) { this.reset(); return this.reject(g, c, 'DATA_INVALID: candle has invalid OHLC (state reset)'); }
    if (c.closed === false) return this.reject(g, c, 'CANDLE_NOT_CLOSED: signals are only produced from completed candles');
    const last = this.cs.at(-1);
    if (last) {
      if (c.time === last.time) return this.reject(g, c, 'DUPLICATE_CANDLE: same timestamp as the previous candle (ignored)');
      if (c.time < last.time) { this.reset(); return this.finishFirst(g, c, 'OUT_OF_ORDER: candle older than the previous one (state reset)'); }
      if (!this.tf) this.tf = c.time - last.time;
      if (this.p.resetOnGap && c.time - last.time !== this.tf) { this.reset(); return this.finishFirst(g, c, `DATA_GAP: ${(c.time - last.time) / this.tf - 1} candle(s) missing (state reset)`); }
    }
    return this.process(g, c);
  }

  private finishFirst(g: number, c: Candle, why: string): Decision { const d = this.process(g, c); return { ...d, reason: `${why}; ${d.reason}` }; }

  private process(g: number, c: Candle): Decision {
    const p = this.p;
    this.cs.push(c);
    const li = this.cs.length - 1;
    const cs = this.cs;
    const closeTime = this.tf ? c.time + this.tf : null;

    // ---- 2. market structure
    const trendBefore: Trend = this.lastSnap?.trend ?? 'NEUTRAL';
    const st = this.structure.update(c); this.lastSnap = st;

    // ---- 3. candlestick patterns and sweeps
    const seq = classifySequence(cs, li, p.sequence);
    const e5 = detectContinuationSignal(cs, li, p.continuation.rules)?.side ?? null;
    const e6 = detectMomentumSignal(cs, li, MOMENTUM_DEFAULTS)?.side ?? null;

    // ---- 4. trend alignment (sweep tracker uses the structure BEFORE this candle)
    const sw: SweepSnapshot = this.sweeps.update(cs, li, trendBefore);
    const ex = evaluateExhaustion(cs, li, st, sw, p.exhaustion);

    // ---- 5. continuation / reversal validation
    const cStep = this.cont.step(cs, li, sw, st, ex);
    const rStep = this.rev.step(li, c, sw, st);
    const cand: Array<{ kind: SignalKind; side: 'BUY' | 'SELL'; reasons: string[]; sweepIndex: number | null; sweepCount: number; trendContext: Trend }> = [];
    if (p.allowContinuation && cStep.signal) cand.push({ kind: 'WITH_TREND_CONTINUATION', side: cStep.signal.side, reasons: cStep.signal.reasons, sweepIndex: cStep.signal.aIndex, sweepCount: cStep.signal.sweep.ordinal, trendContext: st.trend });
    if (p.allowReversal && rStep.signal) cand.push({ kind: 'CONFIRMED_REVERSAL', side: rStep.signal.side, reasons: rStep.signal.reasons, sweepIndex: rStep.signal.watch.lastSweepIndex, sweepCount: rStep.signal.watch.sweeps, trendContext: rStep.signal.mss.priorTrend });

    // ---- 6. duplicates and conflicts
    this.recent = this.recent.filter((x) => g - x.index <= Math.max(p.duplicateWindow, p.conflictWindow));
    const notes: string[] = [];
    let chosen: (typeof cand)[number] | null = null;
    if (cand.length === 2 && cand[0].side !== cand[1].side) notes.push(`CONFLICT: continuation ${cand[0].side} and reversal ${cand[1].side} on the same candle, no trade`);
    else if (cand.length) {
      const pick = cand.find((x) => x.kind === 'CONFIRMED_REVERSAL') ?? cand[0];
      if (this.recent.some((x) => x.side === pick.side && g - x.index <= p.duplicateWindow)) notes.push(`DUPLICATE: a ${pick.side} signal was already given within ${p.duplicateWindow} candles`);
      else if (this.recent.some((x) => x.side !== pick.side && g - x.index <= p.conflictWindow)) notes.push(`CONFLICT: opposite signal within the last ${p.conflictWindow} candles`);
      else chosen = pick;
    }
    if (chosen) this.recent.push({ side: chosen.side, index: g });

    // ---- 7. decision
    for (const r of cStep.rejected) notes.push(`continuation sequence from sweep at #${r.aIndex} rejected: ${r.reason}`);
    for (const d of rStep.dropped) notes.push(`${d.side === 'SELL' ? 'bearish' : 'bullish'} reversal watch closed: ${d.reason}`);
    if (sw.newSweep) notes.unshift(`sweep: ${sw.newSweep.reason}`);

    const warm = li + 1 < p.minHistory;
    const action: Action = chosen && !warm ? chosen.side : 'NO_TRADE';
    const watching = cStep.active.length > 0 || rStep.active.length > 0;
    const state: MachineState = action !== 'NO_TRADE' ? 'CONFIRMED'
      : sw.newSweep ? 'SWEEP_DETECTED'
      : watching && sw.activeCluster && sw.activeCluster.ordinal >= 2 ? 'REPEATED_SWEEP_MONITOR'
      : rStep.active.length ? 'REVERSAL_WATCH' : cStep.active.length ? 'CONTINUATION_WATCH' : 'NORMAL';

    const reason = warm ? `WARMUP: ${li + 1} of ${p.minHistory} candles`
      : action !== 'NO_TRADE' ? `${chosen!.kind === 'CONFIRMED_REVERSAL' ? 'Reversal confirmed by structure shift' : 'With-trend sweep continuation confirmed'}: ${chosen!.reasons.join('; ')}`
      : notes.find((x) => /^(CONFLICT|DUPLICATE)/.test(x)) ?? (watching ? 'watching: confirmation not complete' : 'no setup');

    const decision: Decision = {
      index: g, time: c.time, closeTime, runStart: g - li, action, kind: action === 'NO_TRADE' ? null : chosen!.kind, reason, state, trend: st.trend, structure: st,
      sweep: sw.newSweep, sweepCount: chosen ? chosen.sweepCount : sw.newSweep ? sw.newSweep.ordinal : sw.activeCluster?.ordinal ?? 0,
      recentSweeps: sw.recentCount, alignment: sw.newSweep?.alignment ?? null, exhaustion: ex, sequence: seq, original: { continuation: e5, momentum: e6 },
      signal: action === 'NO_TRADE' ? null : { side: action, kind: chosen!.kind, reasons: chosen!.reasons, sweepIndex: chosen!.sweepIndex === null ? null : chosen!.sweepIndex + (g - li), entryReference: c.close, trendContext: chosen!.trendContext },
      explanation: this.explain(st, sw, ex, seq, action, chosen?.kind ?? null, reason, notes, cs, li),
    };
    return decision;
  }

  private explain(st: StructureSnapshot, sw: SweepSnapshot, ex: ExhaustionReport, seq: SequenceResult | null, action: Action, kind: SignalKind | null, reason: string, notes: string[], cs: Candle[], li: number): Explanation {
    const label = st.trend === 'NEUTRAL' ? 'NEUTRAL / UNCLEAR' : `${st.trend} TREND`;
    const lastSweep = sw.activeCluster ? `${sw.activeCluster.ordinal} in the current ${sw.activeCluster.side === 'SELL' ? 'upside' : 'downside'} cluster` : 'no active cluster';
    const al = sw.newSweep ? sw.newSweep.alignment : null;
    const alignText = al === 'WITH_TREND' ? 'With trend' : al === 'COUNTERTREND' ? 'Against trend (reversal watch only)' : al === 'NO_TREND' ? 'No established trend' : sw.recent.length ? `Last sweep ${sw.recent.at(-1)!.alignment.replace('_', '-').toLowerCase()}` : 'No recent sweep';
    const a = cs[li];
    const momentum = seq ? (seq.classification === 'THREE_STRONG' ? `Three strong ${seq.direction === 'BULL' ? 'bullish' : 'bearish'} bodies` : seq.classification === 'WEAK_STRONG_STRONG' ? `Weak then two strong ${seq.direction === 'BULL' ? 'bullish' : 'bearish'} bodies (hypothesis only)` : `Mixed-strength ${seq.direction === 'BULL' ? 'bullish' : 'bearish'} run`) : `Last candle ${a.close > a.open ? 'bullish' : a.close < a.open ? 'bearish' : 'flat'}, mixed recent candles`;
    const status = ex.state === 'CONFIRMED_STRUCTURE_REVERSAL' ? `Confirmed structure shift: ${ex.reason}` : st.trend === 'NEUTRAL' ? 'Structure unclear' : `No confirmed reversal (${ex.state.toLowerCase().replace(/_/g, ' ')})`;
    return {
      marketStructure: { label, detail: st.description },
      liquiditySweeps: { recent: sw.recentCount, text: `${sw.recentCount} detected in the last ${this.p.sweep.recentWindow} candles; ${lastSweep}` },
      trendAlignment: alignText, candleMomentum: momentum, structureStatus: status,
      verdict: action === 'NO_TRADE' ? 'NO TRADE' : action, reason: action === 'NO_TRADE' ? reason : `${kind === 'CONFIRMED_REVERSAL' ? 'Reversal' : 'Continuation'} confirmed. ${reason}`, notes,
    };
  }
}

// ------------------------------------------------------------------------------------------------ series helper (cached, incremental)
interface Cached { pipe: QuantumPipeline; out: Decision[]; lastTime: number }
const cache = new WeakMap<Candle[], Map<string, Cached>>();

/** Decision for every candle of `cs`, produced one candle at a time (decision[i] uses cs[0..i] only). Cached per array and parameter set. */
export function pipelineSeries(cs: Candle[], p: QuantumParams = QUANTUM_DEFAULTS): Decision[] {
  const key = JSON.stringify(p);
  let m = cache.get(cs); if (!m) { m = new Map(); cache.set(cs, m); }
  let e = m.get(key);
  if (e && (e.out.length > cs.length || (e.out.length && cs[e.out.length - 1].time !== e.lastTime))) e = undefined;
  if (!e) { e = { pipe: new QuantumPipeline(p), out: [], lastTime: 0 }; m.set(key, e); }
  for (let i = e.out.length; i < cs.length; i++) e.out.push(e.pipe.step(cs[i]));
  if (e.out.length) e.lastTime = cs[e.out.length - 1].time;
  return e.out;
}
export const decisionAt = (cs: Candle[], i: number, p: QuantumParams = QUANTUM_DEFAULTS): Decision | null => (i >= 0 && i < cs.length ? pipelineSeries(cs, p)[i] ?? null : null);

