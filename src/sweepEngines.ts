// The three price-action engines. Pure functions: candles in, verdict out. Every function reads CLOSED candles only,
// and reads nothing after index i (no look-ahead).
//
//  1. wickSweep      your original rule (ported 1:1 from bridge/engines/wick_sweep_engine.py, checked against it in the tests):
//                    a candle wicks past the previous candle's extreme, its body stays inside, then the context check decides TAKE or SKIP.
//  2. continuation   ENGINE 5 (src/continuationEngine.ts): sweeper (Pattern 1/2), then TWO fully closed candles in the trade direction. Trade the NEXT candle's open.
//  3. momentum       ENGINE 6 (src/momentumEngine.ts): three same-direction candles, at least two of them STRONG (body dominance). No sweep needed. Trade the NEXT candle's open.

import { ContinuationParams, CONTINUATION_DEFAULTS, detectContinuationSignal } from './continuationEngine';
import { LsccParams, LSCC_DEFAULTS, LsccSignal, detectLsccSignal } from './lscc';
import { MomentumParams, MOMENTUM_DEFAULTS, detectMomentumSignal } from './momentumEngine';
import { StructureSweepParams, detectStructureSweepSignal } from './structureSweep';
import { detectCandlestick } from './candlePatterns';
import { IndicatorTrigger, STOCH_RSI_DEFAULTS, StochRsiParams, computeStochRsi, describeTrigger, findTrigger } from './stochRsi';

export interface C { time: number; open: number; high: number; low: number; close: number; closed?: boolean }
export type Side = 'BUY' | 'SELL';
export type EngineName = 'sweep' | 'continuation' | 'momentum' | 'lscc' | 'structure_sweep' | 'stoch_rsi';
/** the candle-pattern engines that may CONFIRM the Stochastic + RSI trigger (the candlestick-pattern engine is one of them) */
export type ConfirmEngine = 'sweep' | 'continuation' | 'momentum' | 'lscc' | 'structure_sweep' | 'candlestick';

export interface VerdictStructureMeta {
  biasDirection: 'BULLISH' | 'BEARISH';
  eventType: 'CHoCH' | 'MSS' | 'BOS';
  breakLevel: number;
  eventTime: number;
  bosCount: number;
  pullbackTime: number;
  sweepTime: number;
  swingPoints: Array<{ kind: 'HIGH' | 'LOW'; label: string; time: number; price: number }>;
}

export interface Verdict {
  engine: EngineName;
  side: Side;
  ok: boolean;                 // true = TAKE, false = SKIP
  block: string | null;        // why it was skipped
  notes: string[];
  entry: number;               // close of the signal candle (reference price)
  sweptLevel: number;          // the extreme that was swept (or the momentum start level)
  from: number;                // index of the first candle that belongs to the pattern (for highlighting)
  signalIndex: number;         // index of the last candle of the pattern (the candle that just closed)
  tradeAtNextOpen: boolean;    // continuation + momentum: the trade opens on the next candle
  trace?: string[];            // continuation + momentum: the exact arithmetic of every check that qualified the setup
  lscc?: LsccInfo;             // LSCC only: the swept level and the sweep / confirmation / entry candles
  structureMeta?: VerdictStructureMeta;
  stochRsi?: StochRsiMeta;      // indicator strategy only: the trigger and the candle pattern(s) that confirmed it
}

export interface StochRsiConfirmation {
  engine: ConfirmEngine;
  /** open time of the candle the pattern completed on, and of its first candle */
  time: number; fromTime: number;
  notes: string[];
  level: number | null;
}
export interface StochRsiMeta {
  side: Side;
  signalTime: number;
  stochTime: number; stochFrom: number; stochTo: number; stochLevel: number;
  rsiTime: number; rsiFrom: number; rsiTo: number; rsiLevel: number;
  /** the confirmations found, newest first; `confirm` is the one the setup is built on */
  confirmations: StochRsiConfirmation[];
  confirm: StochRsiConfirmation;
  lookback: number;
}

export interface LsccInfo { level: number; levelTime: number; sweepTime: number; confirmTime: number; entryTime: number }

const EPS = 1e-12;
const range = (c: C) => Math.max(c.high - c.low, EPS);
const body = (c: C) => Math.abs(c.close - c.open);
const bodyRatio = (c: C) => body(c) / range(c);
const mirror = (c: C): C => ({ time: c.time, open: -c.open, high: -c.low, low: -c.high, close: -c.close });

/** A broker "filler" candle (no movement at all) is not real price action. Windows containing one are not evaluated. */
export const isFlat = (c: C) => c.open === c.high && c.high === c.low && c.low === c.close;

// ------------------------------------------------------------------------------------------------ 1. wick sweep
export interface WickParams { lookback: number; minEvidence: number; maxStrength: number; strongBody: number; wickRatio: number }
export const WICK_DEFAULTS: WickParams = { lookback: 6, minEvidence: 2, maxStrength: 0.5, strongBody: 0.6, wickRatio: 0.4 };
const wickWindow = (p: WickParams) => p.lookback + 3;
const SELL_NOTES: Record<string, string> = { 'low swept and bought back': 'high swept and sold back' };

function checkLong(cs: C[], p: WickParams): { ok: boolean; block: string | null; notes: string[] } | null {
  const i = cs.length - 1;
  if (i < wickWindow(p) - 1) return null;
  const cur = cs[i], sw = cs[i - 1];
  if (!(sw.close < sw.open && cur.close > cur.open)) return null;      // swept candle bearish, sweeper bullish
  if (!(cur.low < sw.low)) return null;                                // the wick goes below the swept low
  if (Math.min(cur.open, cur.close) < sw.low) return null;             // but the BODY stays at or above it

  const zone = cs.slice(i - 1 - p.lookback, i);
  let tried = 0, firm = 0;
  const notes: string[] = [];
  zone.forEach((c, k) => {
    const pv = k ? zone[k - 1] : zone[0];
    const r = range(c);
    const lw = (Math.min(c.open, c.close) - c.low) / r;
    const b = Math.abs(c.close - c.open) / r;
    if (lw >= p.wickRatio) { tried++; notes.push('wick rejection'); }
    else if (c.close > c.open && b >= p.strongBody) { tried++; notes.push('strong push'); }
    else if (c.low < pv.low && c.close > pv.close) { tried++; notes.push('low swept and bought back'); }
    if (c.close < c.open && b >= p.strongBody && c.close <= c.low + 0.2 * r) firm++;
  });
  let strength = firm / zone.length;
  const swr = range(sw);
  if (Math.abs(sw.close - sw.open) / swr >= 0.8 && sw.close <= sw.low + 0.1 * swr) strength += 0.25;

  if (tried < p.minEvidence) return { ok: false, block: 'initiating side never really tried', notes };
  if (strength > p.maxStrength) return { ok: false, block: 'opposing side still in firm control', notes };
  return { ok: true, block: null, notes };
}

export function detectWickSweep(cs: C[], i: number, p: WickParams = WICK_DEFAULTS): Verdict | null {
  const w = wickWindow(p);
  if (i < w - 1 || i >= cs.length) return null;
  const win = cs.slice(i - w + 1, i + 1);
  const make = (side: Side, r: { ok: boolean; block: string | null; notes: string[] }, level: number): Verdict => ({
    engine: 'sweep', side, ok: r.ok, block: r.block, notes: [...new Set(r.notes)], entry: cs[i].close, sweptLevel: level,
    from: i - 1, signalIndex: i, tradeAtNextOpen: false,
  });
  const buy = checkLong(win, p);
  if (buy) return make('BUY', buy, win[w - 2].low);
  const sell = checkLong(win.map(mirror), p);
  if (sell) return make('SELL', { ...sell, notes: sell.notes.map((n) => SELL_NOTES[n] ?? n) }, win[w - 2].high);
  return null;
}

// ------------------------------------------------------------------------------------------------ 2. sweep continuation (ENGINE 5)
// The rules live in src/continuationEngine.ts: sweeper that satisfies Pattern 1 / 2, then TWO fully closed candles in the trade
// direction. These adapters only translate the engine's signal into the Verdict shape the watcher, charts and UI already use.
export type ContParams = ContinuationParams;
export const CONT_DEFAULTS: ContParams = CONTINUATION_DEFAULTS;

/** Signal candle = i, the SECOND confirming candle. Pattern = [prior, sweeper, confirm 1, confirm 2]. Trade = next candle's open. */
export function detectContinuation(cs: C[], i: number, p: ContParams = CONT_DEFAULTS): Verdict | null {
  const s = detectContinuationSignal(cs, i, p);
  if (!s) return null;
  const sell = s.side === 'SELL';
  const colour = sell ? 'red' : 'green';
  return {
    engine: 'continuation', side: s.side, ok: true, block: null,
    notes: [
      sell ? 'red candle swept the high of the green candle' : 'green candle swept the low of the red candle',
      `next two candles closed ${colour}`,
      'trade on the next candle open',
    ],
    trace: s.reasons,
    entry: s.entryReference, sweptLevel: s.sweptLevel, from: i - 3, signalIndex: i, tradeAtNextOpen: true,
  };
}

// ------------------------------------------------------------------------------------------------ 3. momentum (ENGINE 6)
// Body-dominance rules live in src/momentumEngine.ts (no sweep needed, no indicators).
export type MomParams = MomentumParams;
export const MOM_DEFAULTS: MomParams = MOMENTUM_DEFAULTS;

/** Signal candle = i, the THIRD candle. At least 2 of the 3 same-direction candles must be strong (big body, small wicks, big vs the recent median). */
export function detectMomentum(cs: C[], i: number, p: MomParams = MOM_DEFAULTS): Verdict | null {
  const s = detectMomentumSignal(cs, i, p);
  if (!s) return null;
  const up = s.side === 'BUY';
  const n = p.consecutive;
  return {
    engine: 'momentum', side: s.side, ok: true, block: null,
    notes: [
      `${s.strongCount} of ${n} ${up ? 'green' : 'red'} candles strong, ${n} in a row`,
      `avg body ${(s.avgBodyRatio * 100).toFixed(0)}% / wick ${(s.avgWickRatio * 100).toFixed(0)}% of range, combined body ${s.combinedVsMedian.toFixed(1)}x median`,
      'trade on the next candle open',
    ],
    trace: s.reasons,
    entry: s.entryReference, sweptLevel: s.startLevel, from: i - n + 1, signalIndex: i, tradeAtNextOpen: true,
  };
}

// ------------------------------------------------------------------------------------------------ 4. LSCC (src/lscc.ts)
export type LsccP = LsccParams;
export const LSCC_P: LsccP = LSCC_DEFAULTS;

/** Signal candle = i, the CONFIRMATION candle (the one after the sweep candle). Pattern = [sweep, confirmation]. Trade = the next candle's open. */
export function detectLscc(cs: C[], i: number, p: LsccP = LSCC_P): Verdict | null {
  const s: LsccSignal | null = detectLsccSignal(cs, i, p);
  if (!s) return null;
  const buy = s.side === 'BUY';
  return {
    engine: 'lscc', side: s.side, ok: true, block: null,
    notes: [
      buy ? 'liquidity below price was swept by a wick and the candle closed back above it' : 'liquidity above price was swept by a wick and the candle closed back below it',
      `a separate candle confirmed the ${buy ? 'upward' : 'downward'} reversal`,
      'trade on the next candle open',
    ],
    trace: s.reasons, entry: s.entryReference, sweptLevel: s.level, from: s.sweepIndex, signalIndex: i, tradeAtNextOpen: true,
    lscc: { level: s.level, levelTime: s.levelTime, sweepTime: s.sweepTime, confirmTime: s.confirmTime, entryTime: s.entryTime },
  };
}

// ------------------------------------------------------------------------------------------------ 5. Structure-Confirmed Sweep (src/structureSweep.ts)
export type StructSweepP = StructureSweepParams;

/** Signal candle = i (sweep candle), valid ONLY when confirmed major Swing CHoCH/MSS/BOS directional bias agrees. */
export function detectStructureSweep(cs: C[], i: number, p?: Partial<StructSweepP>): Verdict | null {
  const { signal } = detectStructureSweepSignal(
    cs,
    i,
    {
      swingLeft: 5,
      swingRight: 5,
      oneSignalPerBiasEvent: true,
      bodyInsideRequired: true,
      minSweepWickRatio: 0.45,
      ...p,
    },
    45
  );
  if (!signal) return null;
  const buy = signal.side === 'BUY';
  return {
    engine: 'structure_sweep',
    side: signal.side,
    ok: true,
    block: null,
    notes: [
      `${signal.biasDirection} bias (${signal.biasEvent.type} @ ${signal.breakLevel.toFixed(5)})`,
      buy ? 'red pullback swept below low & closed back above' : 'green pullback swept above high & closed back below',
      'trade on the next candle open',
    ],
    trace: [...signal.reasons],
    entry: signal.entryReference,
    sweptLevel: signal.sweptLevel,
    from: Math.max(0, signal.pullbackIndex),
    signalIndex: i,
    tradeAtNextOpen: true,
    structureMeta: {
      biasDirection: signal.biasDirection,
      eventType: signal.biasEvent.type,
      breakLevel: signal.biasEvent.breakLevel,
      eventTime: signal.biasEvent.timestamp,
      bosCount: signal.bosCount,
      pullbackTime: signal.pullbackTime,
      sweepTime: signal.sweepTime,
      swingPoints: signal.swingPoints.map((sp) => ({
        kind: sp.kind,
        label: sp.label,
        time: sp.time,
        price: sp.price,
      })),
    },
  };
}

/** Everything that fires on closed candle i. */
export function detectAll(cs: C[], i: number): Verdict[] {
  const out: Verdict[] = [];
  const w = detectWickSweep(cs, i); if (w) out.push(w);
  const c = detectContinuation(cs, i); if (c) out.push(c);
  const m = detectMomentum(cs, i); if (m) out.push(m);
  const l = detectLscc(cs, i); if (l) out.push(l);
  const ss = detectStructureSweep(cs, i); if (ss) out.push(ss);
  return out;
}

// ------------------------------------------------------------------------------------------------ 6. Stochastic + RSI trigger, confirmed by a candle pattern (src/stochRsi.ts)
// THE INDICATOR STRATEGY. The indicators (Stochastic %K through 20 / 80 and RSI through 30 / 50 / 70) decide WHEN. When they confirm a new direction on a
// closed candle, the engine looks BACK over the last few candles for any of the candle-pattern strategies (wick sweep, sweep continuation, momentum, LSCC,
// structure sweep, candlestick pattern) pointing the same way. No pattern = no trade. The candle-pattern engines above are used exactly as they are.
export const CONFIRM_WINDOW = 45;           // candles each candle-pattern engine looks at (the same window the market agents give them)
const CONFIRM_ORDER: ConfirmEngine[] = ['sweep', 'lscc', 'structure_sweep', 'continuation', 'momentum', 'candlestick'];

const SIDE_WORD: Record<Side, string> = { BUY: 'bullish', SELL: 'bearish' };

/** Every candle-pattern confirmation pointing `side` that completed on one of the last `lookback` candles (ending on candle i). Newest first. */
export function findConfirmations(cs: C[], i: number, side: Side, lookback: number): StochRsiConfirmation[] {
  const out: StochRsiConfirmation[] = [];
  for (let j = i; j > i - lookback && j >= 1; j--) {
    const win = cs.slice(Math.max(0, j - CONFIRM_WINDOW + 1), j + 1);
    if (win.length < 2 || win.slice(-8).some(isFlat)) continue;           // broker filler candles are not price action
    const at = win.length - 1;
    const add = (engine: ConfirmEngine, notes: string[], fromIdx: number, level: number | null) =>
      out.push({ engine, time: cs[j].time, fromTime: win[Math.max(0, fromIdx)]?.time ?? cs[j].time, notes, level });
    const found: Partial<Record<ConfirmEngine, () => void>> = {
      sweep: () => { const v = detectWickSweep(win, at); if (v && v.ok && v.side === side) add('sweep', [`wick sweep: ${v.notes.join(', ') || (side === 'BUY' ? 'wick below the previous low, body held above it' : 'wick above the previous high, body stayed below it')}`], v.from, v.sweptLevel); },
      lscc: () => { const v = detectLscc(win, at); if (v && v.ok && v.side === side) add('lscc', [`LSCC: ${v.notes[0]}`], v.from, v.sweptLevel); },
      structure_sweep: () => { const v = detectStructureSweep(win, at); if (v && v.ok && v.side === side) add('structure_sweep', [`structure sweep: ${v.notes.slice(0, 2).join('; ')}`], v.from, v.sweptLevel); },
      continuation: () => { const v = detectContinuation(win, at); if (v && v.ok && v.side === side) add('continuation', [`sweep continuation: ${v.notes.slice(0, 2).join('; ')}`], v.from, v.sweptLevel); },
      momentum: () => { const v = detectMomentum(win, at); if (v && v.side === side) add('momentum', [`momentum: ${v.notes[0]}`], v.from, null); },
      candlestick: () => { const h = detectCandlestick(cs, j); if (h && h.side === side) add('candlestick', [`candlestick pattern: ${h.patterns.join(', ')}`], h.kind === 'ENGULFING' ? at - 1 : at, null); },
    };
    for (const name of CONFIRM_ORDER) found[name]?.();
  }
  return out;
}

/** Signal candle = i (the candle on which the Stochastic + RSI trigger completed). Trade = the next candle's open. TAKE only when a candle pattern confirms it. */
export function detectStochRsi(cs: C[], i: number, p: StochRsiParams = STOCH_RSI_DEFAULTS): Verdict | null {
  if (i < p.warmup || i >= cs.length) return null;
  const series = computeStochRsi(cs.slice(0, i + 1), p);
  const t: IndicatorTrigger | null = findTrigger(cs, i, p, series);
  if (!t) return null;
  const sig = cs[i];
  const confs = findConfirmations(cs, i, t.side, p.confirmLookback);
  const trace = describeTrigger(t, cs);
  const idxOf = (time: number) => { const k = cs.findIndex((c) => c.time === time); return k < 0 ? i : k; };
  if (!confs.length) {
    return {
      engine: 'stoch_rsi', side: t.side, ok: false, block: `no candle pattern confirms the indicator trigger in the last ${p.confirmLookback} candles`,
      notes: trace.slice(0, 2), entry: sig.close, sweptLevel: sig.close, from: Math.min(t.stoch.index, t.rsi.index), signalIndex: i, tradeAtNextOpen: true, trace,
    };
  }
  const confirm = confs[0];
  const meta: StochRsiMeta = {
    side: t.side, signalTime: sig.time,
    stochTime: cs[t.stoch.index].time, stochFrom: t.stoch.from, stochTo: t.stoch.to, stochLevel: t.stoch.level,
    rsiTime: cs[t.rsi.index].time, rsiFrom: t.rsi.from, rsiTo: t.rsi.to, rsiLevel: t.rsi.level,
    confirmations: confs, confirm, lookback: p.confirmLookback,
  };
  const from = Math.min(t.stoch.index, t.rsi.index, idxOf(confirm.fromTime));
  return {
    engine: 'stoch_rsi', side: t.side, ok: true, block: null,
    notes: [
      `Stochastic %K crossed ${t.side === 'BUY' ? 'up' : 'down'} through ${t.stoch.level} and RSI crossed ${t.side === 'BUY' ? 'up' : 'down'} through ${t.rsi.level}`,
      `${SIDE_WORD[t.side]} candle pattern confirms: ${confs.map((c) => c.engine.replace('_', ' ')).filter((v, k, a) => a.indexOf(v) === k).join(', ')}`,
      'trade on the next candle open',
    ],
    trace: [...trace, ...confs.slice(0, 3).map((c) => `${c.notes[0]} (candle ${c.time})`)],
    entry: sig.close, sweptLevel: confirm.level ?? sig.close, from, signalIndex: i, tradeAtNextOpen: true, stochRsi: meta,
  };
}
