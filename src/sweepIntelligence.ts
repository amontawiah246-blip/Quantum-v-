// ENGINE 9: REPEATED LIQUIDITY SWEEP INTELLIGENCE.
//
// Sweeps in a strong trend happen again and again, so a sweep is CONTEXT here, never a reason to trade by itself.
// For every sweep this tracker records: direction, swept price level, timestamp, the market structure in force BEFORE the sweep candle,
// whether the sweep agrees with that trend, the recent sweep count and the cluster position (1st, 2nd, 3rd ... sweep), and then follows
// what the next candles do (FOLLOWED_THROUGH / FAILED / still MONITORING).
//
// Direction: a sweep of HIGHS has the resulting signal SELL, a sweep of LOWS has the resulting signal BUY (same convention as the
// existing sweep patterns). Alignment with the prevailing trend:
//   WITH_TREND     BULLISH trend + BUY sweep (a low taken and bought back) or BEARISH trend + SELL sweep. Continuation candidate.
//   COUNTERTREND   BULLISH trend + SELL sweep or BEARISH trend + BUY sweep. Reversal candidate. It can NOT trigger a trade alone: Engine 10 waits
//                  for a confirmed structure shift.
//   NO_TREND       structure NEUTRAL when the sweep happened. Neither candidate.
// Clusters: sweeps of the same side that follow each other within `clusterWindow` candles. The ordinal is information. Nothing here
// enters after N sweeps.
//
// Sweep sources are pluggable (`SweepSource`). Built in: 'pattern12' (the strict Pattern 1 / Pattern 2 definition used by Engine 5) and
// 'wick' (the original wick-sweep engine, TAKE and SKIP both count as a sweep for context). Add more with `registerSweepSource`.
// Candle i's sweep is detected from candles <= i only; follow-up status of a sweep is decided only from candles up to the current one,
// and every event object is immutable (a status change creates a new object), so older snapshots never see later information.
import { Candle, contiguous, validOhlc } from './candleMath';
import { CONTINUATION_DEFAULTS } from './continuationEngine';
import { isSweep } from './sweepPatterns';
import { detectWickSweep } from './sweepEngines';
import { Trend } from './structureEngine';

export type SweepSide = 'BUY' | 'SELL';
export type Alignment = 'WITH_TREND' | 'COUNTERTREND' | 'NO_TREND';
export type SweepStatus = 'MONITORING' | 'FOLLOWED_THROUGH' | 'FAILED';

export interface RawSweep { side: SweepSide; level: number; extreme: number }
export type SweepSource = (cs: Candle[], i: number) => RawSweep | null;

export interface SweepParams {
  sources: string[];               // names of registered sources to use (default ['pattern12'])
  clusterWindow: number;           // sweeps of the same side within this many candles belong to one cluster (12)
  recentWindow: number;            // window for the "recent sweep count" (20)
  monitorCandles: number;          // how many candles after the sweep are watched before it is judged (5)
}
export const SWEEP_DEFAULTS: SweepParams = { sources: ['pattern12'], clusterWindow: 12, recentWindow: 20, monitorCandles: 5 };

export interface SweepEvent {
  readonly id: number;
  readonly index: number; readonly time: number;
  readonly side: SweepSide;                       // resulting directional signal
  readonly swept: 'HIGH' | 'LOW';
  readonly level: number;                         // the swept price level
  readonly extreme: number;                       // how far the sweeper's wick went
  readonly sources: readonly string[];
  readonly trendAtSweep: Trend;                   // structure BEFORE the sweep candle
  readonly alignment: Alignment;
  readonly clusterId: number;
  readonly ordinal: number;                       // 1 = first sweep of its cluster, 2 = second ...
  readonly recentCount: number;                   // sweeps (both sides, incl. this one) in the last `recentWindow` candles
  readonly status: SweepStatus;
  readonly resolvedAt: number | null;
  readonly reason: string;
}

export interface SweepSnapshot {
  readonly index: number;
  readonly newSweep: SweepEvent | null;           // sweep that happened ON this candle
  readonly recentCount: number;                   // sweeps (both sides) in the last `recentWindow` candles
  readonly recentBySide: { BUY: number; SELL: number };
  readonly activeCluster: { side: SweepSide; ordinal: number; startIndex: number; lastIndex: number } | null;   // most recent cluster still inside its window
  readonly failedWithTrendRecent: number;         // WITH_TREND sweeps judged FAILED inside the recent window (judged by candle <= index)
  readonly followedWithTrendRecent: number;
  readonly monitoring: readonly SweepEvent[];     // sweeps still being watched
  readonly recent: readonly SweepEvent[];         // latest versions of the sweeps in the recent window
}

// ------------------------------------------------------------------------------------------------ sources
const sources = new Map<string, SweepSource>();
export const registerSweepSource = (name: string, fn: SweepSource) => { sources.set(name, fn); };

registerSweepSource('pattern12', (cs, i) => {
  if (i < 1) return null;
  const P = cs[i - 1], A = cs[i];
  if (!validOhlc(P) || !validOhlc(A) || P.closed === false || A.closed === false || !contiguous([P, A])) return null;
  if (isSweep('SELL', P, A, CONTINUATION_DEFAULTS)) return { side: 'SELL', level: P.high, extreme: A.high };
  if (isSweep('BUY', P, A, CONTINUATION_DEFAULTS)) return { side: 'BUY', level: P.low, extreme: A.low };
  return null;
});
registerSweepSource('wick', (cs, i) => {
  if (i < 10 || !contiguous(cs.slice(i - 1, i + 1))) return null;
  const v = detectWickSweep(cs, i);
  return v ? { side: v.side, level: v.sweptLevel, extreme: v.side === 'SELL' ? cs[i].high : cs[i].low } : null;
});

// ------------------------------------------------------------------------------------------------ tracker
export class SweepTracker {
  readonly p: SweepParams;
  private events: SweepEvent[] = [];
  private cluster: Record<SweepSide, { id: number; ordinal: number; startIndex: number; lastIndex: number } | null> = { BUY: null, SELL: null };
  private nextId = 1;
  private nextCluster = 1;
  constructor(p: Partial<SweepParams> = {}) {
    this.p = { ...SWEEP_DEFAULTS, ...p };
    for (const s of this.p.sources) if (!sources.has(s)) throw new Error(`unknown sweep source "${s}"`);
  }

  /** `cs` holds candles 0..i (or more: nothing past i is read). `trendBefore` = structure trend after candle i-1. */
  update(cs: Candle[], i: number, trendBefore: Trend): SweepSnapshot {
    const c = cs[i];
    this.judge(cs, i);

    let sweep: RawSweep | null = null; const names: string[] = [];
    for (const name of this.p.sources) {
      const r = sources.get(name)!(cs, i);
      if (r) { if (!sweep) sweep = r; names.push(name); }
    }

    let created: SweepEvent | null = null;
    if (sweep) {
      const side = sweep.side;
      const cl = this.cluster[side];
      const joins = !!cl && i - cl.lastIndex <= this.p.clusterWindow;
      const next = joins ? { id: cl!.id, ordinal: cl!.ordinal + 1, startIndex: cl!.startIndex, lastIndex: i } : { id: this.nextCluster++, ordinal: 1, startIndex: i, lastIndex: i };
      this.cluster[side] = next;
      const alignment: Alignment = trendBefore === 'NEUTRAL' ? 'NO_TREND'
        : (trendBefore === 'BULLISH') === (side === 'BUY') ? 'WITH_TREND' : 'COUNTERTREND';
      const recentCount = this.events.filter((e) => i - e.index < this.p.recentWindow).length + 1;
      created = {
        id: this.nextId++, index: i, time: c.time, side, swept: side === 'SELL' ? 'HIGH' : 'LOW', level: sweep.level, extreme: sweep.extreme,
        sources: names, trendAtSweep: trendBefore, alignment, clusterId: next.id, ordinal: next.ordinal, recentCount,
        status: 'MONITORING', resolvedAt: null,
        reason: `${side === 'SELL' ? 'high' : 'low'} ${sweep.level} swept (wick to ${sweep.extreme}); structure before: ${trendBefore}; ${alignment.replace('_', '-').toLowerCase()}; sweep #${next.ordinal} of its cluster, ${recentCount} recent`,
      };
      this.events.push(created);
    }
    while (this.events.length && i - this.events[0].index > Math.max(this.p.recentWindow, this.p.clusterWindow) * 3) this.events.shift();
    return this.snapshot(i, created);
  }

  /** Decide, with candles <= i only, which monitored sweeps have followed through or failed. Creates new immutable objects. */
  private judge(cs: Candle[], i: number) {
    const M = this.p.monitorCandles;
    this.events = this.events.map((e) => {
      if (e.status !== 'MONITORING' || i <= e.index) return e;
      const close = cs[i].close;
      const failedNow = e.side === 'BUY' ? close < e.extreme : close > e.extreme;     // closed back through the sweep's own extreme: the sweep failed
      if (failedNow) return { ...e, status: 'FAILED' as const, resolvedAt: i };
      if (i - e.index >= M) {
        const ref = cs[e.index].close;
        const ok = e.side === 'BUY' ? close > ref : close < ref;
        return { ...e, status: ok ? 'FOLLOWED_THROUGH' as const : 'FAILED' as const, resolvedAt: i };
      }
      return e;
    });
  }

  private snapshot(i: number, created: SweepEvent | null): SweepSnapshot {
    const recent = this.events.filter((e) => i - e.index < this.p.recentWindow);
    const wt = recent.filter((e) => e.alignment === 'WITH_TREND');
    const ac = (['BUY', 'SELL'] as const).map((s) => ({ s, c: this.cluster[s] })).filter((x) => x.c && i - x.c.lastIndex <= this.p.clusterWindow).sort((a, b) => b.c!.lastIndex - a.c!.lastIndex)[0];
    return {
      index: i, newSweep: created, recentCount: recent.length,
      recentBySide: { BUY: recent.filter((e) => e.side === 'BUY').length, SELL: recent.filter((e) => e.side === 'SELL').length },
      activeCluster: ac ? { side: ac.s, ordinal: ac.c!.ordinal, startIndex: ac.c!.startIndex, lastIndex: ac.c!.lastIndex } : null,
      failedWithTrendRecent: wt.filter((e) => e.status === 'FAILED').length,
      followedWithTrendRecent: wt.filter((e) => e.status === 'FOLLOWED_THROUGH').length,
      monitoring: this.events.filter((e) => e.status === 'MONITORING'),
      recent,
    };
  }
}
