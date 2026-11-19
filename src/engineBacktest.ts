// Backtester for Engines 5 and 6 and their comparison baselines. Pure functions: candles in, report out. No network, no indicators.
//
// How a trade is modelled
//   * A strategy looks at closed candle i (and only candles <= i) and may say BUY or SELL.
//   * The trade is entered at the OPEN of candle i + 1 (the next candle), never earlier.
//   * Expiry is separate from the chart timeframe: an expiry of k x timeframe seconds settles at the CLOSE of candle i + k.
//     Settlement price is compared with the entry price: BUY wins if close > entry, SELL wins if close < entry, equal = tie (stake returned).
//   * Win pays `payout` per unit staked, loss costs 1 unit, tie 0; `costPerTrade` (fraction of stake) is deducted from every trade.
//   * A strategy never holds two trades at once for the same instrument and expiry: a signal whose entry falls before the previous
//     trade has settled is skipped and counted (duplicate-entry protection).
//
// Out-of-sample discipline
//   * Every instrument is split chronologically: first 60% train, next 20% validation, last 20% test (configurable).
//   * A trade belongs to the segment of its entry candle; if it settles in a later segment it is embargoed (kept in the overall
//     numbers, removed from the segment numbers) so no outcome leaks across a boundary.
//   * Parameter variants are compared on every segment; `selection` picks the variant with the best VALIDATION expectancy and
//     reports its TEST result next to the rest. Many variants are compared, so a good-looking pick is still a multiple-comparison
//     result, not proof of an edge.
import { Candle, contiguous, validOhlc } from './candleMath';
import { CONTINUATION_DEFAULTS, ContinuationParams, detectContinuationSignal, sequenceState } from './continuationEngine';
import { MOMENTUM_DEFAULTS, MomentumParams, detectMomentumSignal, evaluateMomentum } from './momentumEngine';
import { SweepSide, isSweep } from './sweepPatterns';
import { detectStructureSweepSignal, StructureSweepParams } from './structureSweep';
import { getGlobalTiming } from './globalConfig';

export type Side = 'BUY' | 'SELL';
export type Segment = 'train' | 'validation' | 'test';

export interface RawSignal { side: Side; detail?: Record<string, number | string> }
export interface StrategyDef {
  id: string;
  label: string;
  group: 'engine5' | 'engine5-baseline' | 'engine6' | 'engine6-variant' | 'engine6-control' | 'engine7' | 'engine9' | 'engine10' | 'engine11' | 'pipeline' | 'research-baseline';
  detect: (cs: Candle[], i: number) => RawSignal | null;
}

/** `fine`: optional finer price series for the same market (1-minute, 1-second or tick candles). When present, entry and settlement prices are read from it at the exact execution and settlement times (see BacktestConfig.delaySec). */
export interface Dataset { symbol: string; candles: Candle[]; fine?: Candle[] }

export interface BacktestConfig {
  tf: number;                        // chart timeframe in seconds (300 = five minutes)
  expiries: number[];                // trade durations in seconds, each a multiple of tf
  payout: number;                    // profit per unit stake on a win (0.92 = 92%)
  costPerTrade: number;              // extra cost per trade as a fraction of stake
  split: { train: number; validation: number };   // fractions; the rest is the out-of-sample test
  warmup: number;                    // first candles of each series are never used as signal candles
  minTradesForSelection: number;     // validation trades needed before a variant can be "selected"
  /** Seconds between the signal candle CLOSING and the order actually being filled (latency + broker acceptance). Default 0.
   *  Without `fine` data it must be a whole number of candles (the only prices available are candle opens/closes); with `fine` data it can be any
   *  value and the fill is the first fine-series price at or after (signal close + delay). */
  delaySec: number;
  /** Payout (profit per unit stake on a win) per trade. Overrides `payout` when given, e.g. a table by market, expiry and time of day. */
  payoutFor?: (symbol: string, expirySec: number, entryTime: number) => number;
  strategies?: StrategyDef[];
  /** receives one record for each qualified setup and each near-miss (a sweep or a three-candle run that was rejected, with its arithmetic) */
  traceSink?: (rec: TraceRecord) => void;
}
export const BACKTEST_DEFAULTS: BacktestConfig = {
  tf: 300, expiries: [300, 600, 900], payout: 0.92, costPerTrade: 0, split: { train: 0.6, validation: 0.2 }, warmup: 30, minTradesForSelection: 30, delaySec: 0,
};

/** Builds a BacktestConfig aligned strictly to the active central GlobalTiming state (separate tfSec and expirySec). */
export function backtestConfigFromGlobal(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  const timing = getGlobalTiming();
  return {
    ...BACKTEST_DEFAULTS,
    tf: timing.tfSec,
    expiries: [timing.expirySec],
    ...overrides,
  };
}

export interface TraceRecord { strategy: string; symbol: string; time: number; side: Side | null; qualified: boolean; state: string; lines: string[] }

export interface Trade {
  strategy: string; symbol: string; side: Side;
  signalIndex: number; entryIndex: number; exitIndex: number;
  signalTime: number; entryTime: number; expiry: number;
  entry: number; exit: number;
  result: 'win' | 'loss' | 'tie'; pnl: number;
  session: string; segment: Segment | 'embargo';
  conflict: boolean;
  // execution record (always filled by runBacktest)
  signalCloseTime?: number;          // when the signal candle closed: the earliest moment a signal can exist
  executionTime?: number;            // when the trade was actually filled (entry price time)
  settleTime?: number;               // time of the price used for settlement: executionTime + expiry, or the first price after it
  delaySec?: number;                 // executionTime - signalCloseTime
  payout?: number;                   // payout used for this trade
  detail?: Record<string, number | string>;   // tags from the strategy (trend, sweep count ...)
}

export interface Stats {
  trades: number; wins: number; losses: number; ties: number;
  winRate: number | null; lossRate: number | null;
  expectancy: number | null;          // average profit per trade, in units of stake
  totalPnl: number; maxDrawdown: number;
  breakevenWinRate: number;           // win rate needed for zero expectancy at this payout and cost (no ties)
  ciLow: number | null; ciHigh: number | null;     // 95% Wilson interval of the win rate
  vsBreakeven: 'above' | 'below' | 'inconclusive' | 'n/a';
}

export interface ExpiryReport {
  overall: Stats;
  bySegment: Record<Segment, Stats>;
  byInstrument: Record<string, Stats>;
  bySession: Record<string, Stats>;
  embargoed: number;                  // trades left out of the segment numbers because they settled in a later segment
  skippedOverlap: number;             // signals skipped because the strategy still had a trade open (duplicate-entry protection)
  skippedIncomplete: number;          // signals whose settlement candle was missing (end of data or gap)
}
export interface StrategyReport {
  id: string; label: string; group: StrategyDef['group'];
  signals: number;                    // qualified setups, before any skipping
  buySignals: number; sellSignals: number;
  byExpiry: Record<number, ExpiryReport>;
}

export interface Comparison { title: string; note: string; rows: Array<Record<string, string | number | null>> }
export interface BacktestReport {
  config: Omit<BacktestConfig, 'strategies' | 'traceSink' | 'payoutFor'> & { payoutTable: boolean };
  instruments: Array<{ symbol: string; candles: number; from: number; to: number; issues: string[] }>;
  strategies: StrategyReport[];
  conflicts: {
    candlesWithBothEngines: number; sameSide: number; opposite: number;   // both engines firing on the very same candle
    overlappingOpposite: Record<number, number>;                         // per expiry: opposite-side signals (Engine 5 vs Engine 6) whose trades would be open at the same time
    examples: string[];
  };
  comparisons: Comparison[];
  selection: Array<{ expiry: number; chosen: string | null; validation: Stats | null; test: Stats | null; note: string }>;
  assumptions: string[];
}

// ------------------------------------------------------------------------------------------------ strategies
const mom = (over: Partial<MomentumParams>): MomentumParams => ({ ...MOMENTUM_DEFAULTS, ...over });

export function sweepSides(cs: Candle[], i: number): SweepSide | null {
  if (i < 1) return null;
  const P = cs[i - 1], A = cs[i];
  if (!validOhlc(P) || !validOhlc(A) || P.closed === false || A.closed === false || !contiguous([P, A])) return null;
  if (isSweep('SELL', P, A, CONTINUATION_DEFAULTS)) return 'SELL';
  if (isSweep('BUY', P, A, CONTINUATION_DEFAULTS)) return 'BUY';
  return null;
}

export function structureSweepStrategy(params?: Partial<StructureSweepParams>): StrategyDef {
  return {
    id: 'structure_sweep',
    label: 'Structure Bias (CHoCH/MSS/BOS) + Liquidity Sweep',
    group: 'pipeline',
    detect: (cs, i) => {
      const { signal } = detectStructureSweepSignal(cs, i, params);
      if (!signal) return null;
      return {
        side: signal.side,
        detail: {
          bias: signal.biasDirection,
          event: signal.biasEvent.type,
          breakLevel: signal.breakLevel,
        },
      };
    },
  };
}

export function defaultStrategies(cont: ContinuationParams = CONTINUATION_DEFAULTS, base: MomentumParams = MOMENTUM_DEFAULTS): StrategyDef[] {
  const defs: StrategyDef[] = [];
  // ---- Engine 5 and its baselines (same sweep definition, 0 / 1 / 2 confirmation candles)
  defs.push({
    id: 'e5_continuation', label: 'Engine 5: sweep + 2 confirming closes', group: 'engine5',
    detect: (cs, i) => { const s = detectContinuationSignal(cs, i, cont); return s ? { side: s.side } : null; },
  });
  defs.push({
    id: 'e5_base_immediate', label: 'Baseline: enter right after the sweep (0 confirmations)', group: 'engine5-baseline',
    detect: (cs, i) => { const s = sweepSides(cs, i); return s ? { side: s } : null; },
  });
  defs.push({
    id: 'e5_base_plus1', label: 'Baseline: sweep + 1 confirming close', group: 'engine5-baseline',
    detect: (cs, i) => {
      const s = sweepSides(cs, i - 1);
      if (!s || !contiguous([cs[i - 1], cs[i]]) || cs[i].closed === false || !validOhlc(cs[i])) return null;
      const ok = s === 'SELL' ? cs[i].close < cs[i].open : cs[i].close > cs[i].open;
      return ok ? { side: s } : null;
    },
  });
  // ---- Engine 6 (default: at least 2 of 3 strong) and its sub-patterns
  defs.push({
    id: 'e6_momentum', label: 'Engine 6: body-dominance momentum (>= 2 of 3 strong)', group: 'engine6',
    detect: (cs, i) => { const s = detectMomentumSignal(cs, i, base); return s ? { side: s.side, detail: { strong: s.strongCount } } : null; },
  });
  defs.push({
    id: 'e6_all3', label: 'Engine 6 pattern: all three candles strong', group: 'engine6-variant',
    detect: (cs, i) => { const s = detectMomentumSignal(cs, i, base); return s && s.strongCount === base.consecutive ? { side: s.side } : null; },
  });
  defs.push({
    id: 'e6_two_plus_one', label: 'Engine 6 pattern: two strong + one weaker', group: 'engine6-variant',
    detect: (cs, i) => { const s = detectMomentumSignal(cs, i, base); return s && s.strongCount < base.consecutive ? { side: s.side } : null; },
  });
  // ---- threshold grid (strong body ratio x median multiple; max wick ratio = 1 - body ratio)
  for (const r of [0.55, 0.65, 0.75]) for (const m of [1.0, 1.2, 1.5]) {
    const p = mom({ strongBodyRatio: r, maxWickRatio: +(1 - r).toFixed(2), strongBodyMedianMult: m });
    defs.push({
      id: `e6_grid_r${Math.round(r * 100)}_m${m.toFixed(1)}`, label: `Engine 6 thresholds: body >= ${Math.round(r * 100)}%, body >= ${m.toFixed(1)}x median`, group: 'engine6-variant',
      detect: (cs, i) => { const s = detectMomentumSignal(cs, i, p); return s ? { side: s.side } : null; },
    });
  }
  // ---- control: any three same-colour candles, no body or size requirement
  defs.push({
    id: 'ctl_streak3', label: 'Control: any 3 same-colour candles (no body or size test)', group: 'engine6-control',
    detect: (cs, i) => {
      if (i < 2) return null;
      const t = [cs[i - 2], cs[i - 1], cs[i]];
      if (!t.every(validOhlc) || t.some((c) => c.closed === false) || !contiguous(t)) return null;
      if (t.every((c) => c.close < c.open)) return { side: 'SELL' };
      if (t.every((c) => c.close > c.open)) return { side: 'BUY' };
      return null;
    },
  });
  return defs;
}

// ------------------------------------------------------------------------------------------------ statistics
export function wilson(wins: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null;
  const p = wins / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

export function normalCdf(x: number): number {   // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + (x < 0 ? -y : y));
}

export function twoProportionZ(w1: number, n1: number, w2: number, n2: number): { diff: number; z: number; p: number } | null {
  if (n1 < 1 || n2 < 1) return null;
  const p1 = w1 / n1, p2 = w2 / n2, p = (w1 + w2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return { diff: p1 - p2, z: 0, p: 1 };
  const z = (p1 - p2) / se;
  return { diff: p1 - p2, z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

export function summarize(trades: Trade[], payout: number, cost: number): Stats {
  const wins = trades.filter((t) => t.result === 'win').length;
  const losses = trades.filter((t) => t.result === 'loss').length;
  const ties = trades.length - wins - losses;
  const decided = wins + losses;
  const used = trades.filter((t) => t.payout !== undefined);
  const pay = used.length === trades.length && used.length ? used.reduce((a, t) => a + (t.payout as number), 0) / used.length : payout;   // mean payout actually used
  const be = (1 + cost) / (1 + pay);
  const ci = wilson(wins, decided);
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime || a.symbol.localeCompare(b.symbol));
  let eq = 0, peak = 0, dd = 0;
  for (const t of sorted) { eq += t.pnl; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  return {
    trades: trades.length, wins, losses, ties,
    winRate: decided ? wins / decided : null, lossRate: decided ? losses / decided : null,
    expectancy: trades.length ? total / trades.length : null,
    totalPnl: total, maxDrawdown: dd, breakevenWinRate: be,
    ciLow: ci ? ci[0] : null, ciHigh: ci ? ci[1] : null,
    vsBreakeven: !ci ? 'n/a' : ci[0] > be ? 'above' : ci[1] < be ? 'below' : 'inconclusive',
  };
}

/** UTC session of the ENTRY candle. Asia 00-07, London 07-13, New York 13-21, Late 21-24. */
export function sessionOf(epochSec: number): string {
  const h = new Date(epochSec * 1000).getUTCHours();
  return h < 7 ? 'Asia' : h < 13 ? 'London' : h < 21 ? 'NewYork' : 'Late';
}

// ------------------------------------------------------------------------------------------------ data validation
/** Chronological order, one candle per timestamp, valid OHLC. Returns clean candles and a list of what was fixed. */
export function cleanCandles(raw: Candle[]): { candles: Candle[]; issues: string[] } {
  const issues: string[] = [];
  let sorted = [...raw];
  if (sorted.some((c, k) => k > 0 && c.time < sorted[k - 1].time)) { sorted.sort((a, b) => a.time - b.time); issues.push('candles were out of order and have been sorted'); }
  const dedup: Candle[] = [];
  let dups = 0;
  for (const c of sorted) { if (dedup.length && dedup[dedup.length - 1].time === c.time) { dedup[dedup.length - 1] = c; dups++; } else dedup.push(c); }
  if (dups) issues.push(`${dups} duplicate timestamps removed (last one kept)`);
  const bad = dedup.filter((c) => !validOhlc(c)).length;
  if (bad) issues.push(`${bad} candles with invalid OHLC are kept in place; engines reject any pattern that contains one`);
  let gaps = 0; const step = dedup.length > 1 ? median2(dedup) : 0;
  for (let k = 1; k < dedup.length; k++) if (step && dedup[k].time - dedup[k - 1].time !== step) gaps++;
  if (gaps) issues.push(`${gaps} gaps or irregular spacings (patterns and trades across a gap are rejected)`);
  const unfinished = dedup.filter((c) => c.closed === false).length;
  if (unfinished) issues.push(`${unfinished} unfinished candles present (never used)`);
  return { candles: dedup, issues };
}
/** Index of the first candle with time >= t, or -1. `cs` must be sorted by time. */
export function firstAtOrAfter(cs: Candle[], t: number): number {
  let lo = 0, hi = cs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cs[m].time < t) lo = m + 1; else hi = m; }
  return lo < cs.length ? lo : -1;
}
function median2(cs: Candle[]): number {
  const d = cs.slice(1).map((c, k) => c.time - cs[k].time).sort((a, b) => a - b);
  return d[d.length >> 1];
}

// ------------------------------------------------------------------------------------------------ the backtest
interface Sig { i: number; side: Side; detail?: Record<string, number | string> }

export function runBacktest(data: Dataset[], cfg: Partial<BacktestConfig> = {}): { report: BacktestReport; trades: Trade[] } {
  const c: BacktestConfig = { ...BACKTEST_DEFAULTS, ...cfg, split: { ...BACKTEST_DEFAULTS.split, ...(cfg.split ?? {}) } };
  for (const e of c.expiries) if (!(e >= c.tf) || e % c.tf !== 0) throw new Error(`expiry ${e}s must be a multiple of the ${c.tf}s candle (settlement is read from candle closes)`);
  if (!(c.delaySec >= 0) || !Number.isFinite(c.delaySec)) throw new Error('delaySec must be >= 0');
  if (!(c.split.train > 0 && c.split.validation > 0 && c.split.train + c.split.validation < 1)) throw new Error('split must leave a non-empty test segment');
  const strategies = c.strategies ?? defaultStrategies();
  const trades: Trade[] = [];
  const counts = new Map<string, { signals: number; buy: number; sell: number }>();
  const skippedOverlap = new Map<string, number>(), skippedIncomplete = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const instruments: BacktestReport['instruments'] = [];
  const conflicts: BacktestReport['conflicts'] = { candlesWithBothEngines: 0, sameSide: 0, opposite: 0, overlappingOpposite: Object.fromEntries(c.expiries.map((e) => [e, 0])), examples: [] };
  const primaryA = 'e5_continuation', primaryB = 'e6_momentum';

  for (const ds of data) {
    const { candles: cs, issues } = cleanCandles(ds.candles);
    instruments.push({ symbol: ds.symbol, candles: cs.length, from: cs[0]?.time ?? 0, to: cs[cs.length - 1]?.time ?? 0, issues });
    const n = cs.length;
    const trainEnd = Math.floor(n * c.split.train), valEnd = Math.floor(n * (c.split.train + c.split.validation));
    const segOf = (idx: number): Segment => (idx < trainEnd ? 'train' : idx < valEnd ? 'validation' : 'test');

    // 1. signals: each strategy sees candle i and nothing after it
    const sigs = new Map<string, Sig[]>();
    for (const s of strategies) {
      const list: Sig[] = [];
      for (let i = c.warmup; i < n - 1; i++) {
        const r = s.detect(cs, i);
        if (r) list.push({ i, side: r.side, detail: r.detail });
      }
      sigs.set(s.id, list);
      const k = counts.get(s.id) ?? { signals: 0, buy: 0, sell: 0 };
      k.signals += list.length; k.buy += list.filter((x) => x.side === 'BUY').length; k.sell += list.filter((x) => x.side === 'SELL').length;
      counts.set(s.id, k);
    }

    // 2. conflicts between the two engines. On the very same candle they cannot disagree (Engine 5's A, B, C and Engine 6's last three
    //    candles are the same candles and must all close one way), so the interesting case is opposite signals on nearby candles whose
    //    trades would be open at the same time: windows [entry, entry + k - 1] overlap when the signal candles are < k apart.
    const bySig = (id: string) => new Map((sigs.get(id) ?? []).map((x) => [x.i, x.side] as const));
    const A = bySig(primaryA), B = bySig(primaryB);
    for (const [i, sa] of A) {
      const sb = B.get(i);
      if (!sb) continue;
      conflicts.candlesWithBothEngines++;
      if (sa === sb) conflicts.sameSide++; else conflicts.opposite++;
    }
    const clash = (i: number, side: Side, other: Map<number, Side>, k: number) => {
      for (let d = -(k - 1); d <= k - 1; d++) { const o = other.get(i + d); if (o && o !== side) return true; }
      return false;
    };
    for (const expiry of c.expiries) {
      const k = expiry / c.tf;
      for (const [i, sa] of A) {
        for (let d = -(k - 1); d <= k - 1; d++) {
          const sb = B.get(i + d);
          if (sb && sb !== sa) {
            conflicts.overlappingOpposite[expiry]++;
            if (conflicts.examples.length < 10) conflicts.examples.push(`${ds.symbol} ${new Date(cs[i].time * 1000).toISOString()}: Engine 5 ${sa} vs Engine 6 ${sb} at ${new Date(cs[i + d].time * 1000).toISOString()} (expiry ${expiry}s)`);
          }
        }
      }
    }

    // 3. trades. The signal exists at the CLOSE of candle i. The order is filled `delaySec` later (first available price), and settles
    //    `expiry` seconds after the ACTUAL fill. Chart-only data: fill = open of candle i + 1 + delay/tf, settlement = close of the candle that ends at fill + expiry.
    //    With `fine` data: fill = open of the first fine candle at or after (close + delay), settlement = open of the first fine candle at or after (fill + expiry).
    const fine = ds.fine ? cleanCandles(ds.fine).candles : null;
    const fineTf = fine && fine.length > 1 ? median2(fine) : 0;
    if (fine && !(fineTf > 0)) throw new Error(`${ds.symbol}: fine series needs at least two candles`);
    const dc = c.delaySec / c.tf;
    if (!fine && !Number.isInteger(dc)) throw new Error(`delaySec ${c.delaySec}s is not a whole number of ${c.tf}s candles: without a finer price series (Dataset.fine) the only available fill prices are candle opens. Supply 1-minute/1-second/tick candles, or use a whole-candle delay.`);
    for (const s of strategies) {
      for (const expiry of c.expiries) {
        const k = expiry / c.tf;
        let lastExit = -1, lastSettle = -Infinity;
        for (const sg of sigs.get(s.id)!) {
          const signalClose = cs[sg.i].time + c.tf;
          let e: number, x: number, entry: number, exit: number, execTime: number, settleTime: number;
          if (!fine) {
            e = sg.i + 1 + dc; x = e + k - 1;
            if (e <= lastExit) { bump(skippedOverlap, `${s.id}|${expiry}`); continue; }
            if (x >= n || cs[x].time - cs[e].time !== (k - 1) * c.tf || cs[e].time - cs[sg.i].time !== (1 + dc) * c.tf) { bump(skippedIncomplete, `${s.id}|${expiry}`); continue; }
            lastExit = x;
            entry = cs[e].open; exit = cs[x].close; execTime = cs[e].time; settleTime = cs[x].time + c.tf;
          } else {
            const target = signalClose + c.delaySec;
            const fe = firstAtOrAfter(fine, target);
            if (fe < 0 || fine[fe].time - target > fineTf || !contiguous([cs[sg.i], cs[Math.min(sg.i + 1, n - 1)]]) || sg.i + 1 >= n) { bump(skippedIncomplete, `${s.id}|${expiry}`); continue; }
            execTime = fine[fe].time;
            const sTarget = execTime + expiry, fx = firstAtOrAfter(fine, sTarget);
            if (fx < 0 || fine[fx].time - sTarget > fineTf) { bump(skippedIncomplete, `${s.id}|${expiry}`); continue; }
            if (execTime < lastSettle) { bump(skippedOverlap, `${s.id}|${expiry}`); continue; }
            entry = fine[fe].open; exit = fine[fx].open; settleTime = fine[fx].time; lastSettle = settleTime;
            e = Math.min(n - 1, sg.i + 1 + Math.floor((execTime - signalClose) / c.tf));
            x = Math.min(n - 1, Math.max(e, sg.i + 1 + Math.floor((settleTime - signalClose - 1) / c.tf)));
          }
          const up = exit > entry, down = exit < entry;
          const result: Trade['result'] = (sg.side === 'BUY' && up) || (sg.side === 'SELL' && down) ? 'win' : (sg.side === 'BUY' && down) || (sg.side === 'SELL' && up) ? 'loss' : 'tie';
          const payout = c.payoutFor ? c.payoutFor(ds.symbol, expiry, execTime) : c.payout;
          const pnl = (result === 'win' ? payout : result === 'loss' ? -1 : 0) - c.costPerTrade;
          const seg = segOf(e);
          trades.push({
            strategy: s.id, symbol: ds.symbol, side: sg.side, signalIndex: sg.i, entryIndex: e, exitIndex: x,
            signalTime: cs[sg.i].time, entryTime: execTime, expiry, entry, exit, result, pnl,
            session: sessionOf(execTime), segment: segOf(x) === seg ? seg : 'embargo',
            conflict: s.id === primaryA ? clash(sg.i, sg.side, B, k) : s.id === primaryB ? clash(sg.i, sg.side, A, k) : false,
            signalCloseTime: signalClose, executionTime: execTime, settleTime, delaySec: execTime - signalClose, payout, ...(sg.detail ? { detail: sg.detail } : {}),
          });
        }
      }
    }

    // 4. optional trace of qualified setups and near-misses (exact arithmetic)
    if (c.traceSink) traceInstrument(ds.symbol, cs, c.warmup, c.traceSink);
  }

  // ---- assemble
  const stratReports: StrategyReport[] = strategies.map((s) => {
    const byExpiry: Record<number, ExpiryReport> = {};
    for (const expiry of c.expiries) {
      const ts = trades.filter((t) => t.strategy === s.id && t.expiry === expiry);
      const stat = (xs: Trade[]) => summarize(xs, c.payout, c.costPerTrade);
      const group = (key: (t: Trade) => string) => { const m: Record<string, Trade[]> = {}; for (const t of ts) (m[key(t)] ??= []).push(t); return Object.fromEntries(Object.entries(m).sort().map(([k, v]) => [k, stat(v)])); };
      byExpiry[expiry] = {
        overall: stat(ts),
        bySegment: { train: stat(ts.filter((t) => t.segment === 'train')), validation: stat(ts.filter((t) => t.segment === 'validation')), test: stat(ts.filter((t) => t.segment === 'test')) },
        byInstrument: group((t) => t.symbol), bySession: group((t) => t.session),
        embargoed: ts.filter((t) => t.segment === 'embargo').length,
        skippedOverlap: skippedOverlap.get(`${s.id}|${expiry}`) ?? 0, skippedIncomplete: skippedIncomplete.get(`${s.id}|${expiry}`) ?? 0,
      };
    }
    const k = counts.get(s.id) ?? { signals: 0, buy: 0, sell: 0 };
    return { id: s.id, label: s.label, group: s.group, signals: k.signals, buySignals: k.buy, sellSignals: k.sell, byExpiry };
  });

  const report: BacktestReport = {
    config: { tf: c.tf, expiries: c.expiries, payout: c.payout, costPerTrade: c.costPerTrade, split: c.split, warmup: c.warmup, minTradesForSelection: c.minTradesForSelection, delaySec: c.delaySec, payoutTable: !!c.payoutFor },
    instruments, strategies: stratReports, conflicts, comparisons: [], selection: [],
    assumptions: ASSUMPTIONS,
  };
  report.comparisons = buildComparisons(report);
  report.selection = buildSelection(report);
  return { report, trades };
}

export const ASSUMPTIONS = [
  'The signal exists when the signal candle CLOSES. Entry is the first available price at or after (close + delaySec): the OPEN of the next candle when delaySec = 0, or a price from the optional finer series. Settlement is exactly `expiry` seconds after the ACTUAL fill: the close of the candle that ends then (chart data) or the first fine-series price at or after it. Slippage, requotes and broker rejections are not modelled; delay is only as precise as the price series given.',
  'Payout and cost are flat per trade. Real payouts differ by instrument, expiry and time of day.',
  'One trade at a time per strategy, instrument and expiry; overlapping signals are skipped and counted.',
  'Sessions are UTC hours of the entry candle: Asia 00-07, London 07-13, New York 13-21, Late 21-24.',
  'Segments are chronological per instrument (train / validation / test). Trades settling after a segment boundary are embargoed from segment statistics.',
  'Engine 5 uses the strict sweep rule (Pattern 1/2 plus wick-only); Engine 6 uses body ratio 0.65, wick ratio 0.35, 1.2x median of 20, 2 of 3 strong, weaker candle body >= 0.30 of range, combined body >= 3.0x median. The last two are my assumptions; all are configurable and untuned.',
  'Win-rate intervals are 95% Wilson intervals. "above breakeven" means the whole interval is above the break-even win rate for the chosen payout and cost.',
];

// ------------------------------------------------------------------------------------------------ comparisons
const find = (r: BacktestReport, id: string) => r.strategies.find((s) => s.id === id);
const pct = (x: number | null) => (x === null ? null : +(x * 100).toFixed(2));
const num = (x: number | null, d = 4) => (x === null ? null : +x.toFixed(d));

function row(label: string, st: Stats): Record<string, string | number | null> {
  return { strategy: label, trades: st.trades, 'win %': pct(st.winRate), 'CI low %': pct(st.ciLow), 'CI high %': pct(st.ciHigh), 'EV/trade': num(st.expectancy), 'max DD': +st.maxDrawdown.toFixed(2), vs_breakeven: st.vsBreakeven };
}

export function buildComparisons(r: BacktestReport): Comparison[] {
  const out: Comparison[] = [];
  for (const expiry of r.config.expiries) {
    // A. do the two confirmation candles help?
    const ids = ['e5_base_immediate', 'e5_base_plus1', 'e5_continuation'];
    const rows: Comparison['rows'] = [];
    for (const scope of ['overall', 'test'] as const) {
      for (const id of ids) {
        const s = find(r, id); if (!s) continue;
        const st = scope === 'overall' ? s.byExpiry[expiry].overall : s.byExpiry[expiry].bySegment.test;
        rows.push({ scope, ...row(id, st) });
      }
      const a = find(r, 'e5_continuation'), b = find(r, 'e5_base_immediate');
      if (a && b) {
        const sa = scope === 'overall' ? a.byExpiry[expiry].overall : a.byExpiry[expiry].bySegment.test;
        const sb = scope === 'overall' ? b.byExpiry[expiry].overall : b.byExpiry[expiry].bySegment.test;
        const z = twoProportionZ(sa.wins, sa.wins + sa.losses, sb.wins, sb.wins + sb.losses);
        rows.push({ scope, strategy: 'Engine 5 minus immediate (win-rate difference)', trades: null, 'win %': z ? pct(z.diff) : null, 'EV/trade': z ? num(z.z, 2) : null, 'CI low %': null, 'CI high %': null, 'max DD': null, vs_breakeven: z ? `z=${z.z.toFixed(2)}, p=${z.p.toFixed(3)}${z.p < 0.05 ? ' (differs)' : ' (no demonstrated difference)'}` : 'n/a' });
      }
    }
    out.push({
      title: `Do the two confirmation candles help? expiry ${r.config.expiries.length > 1 ? expiry + 's' : expiry + 's'}`,
      note: 'Same sweep definition with 0, 1 and 2 confirming closes. The sets overlap (Engine 5 is a subset of the others) so the z-test is only a rough guide; read it with the intervals.',
      rows,
    });
  }
  for (const expiry of r.config.expiries) {
    const rows: Comparison['rows'] = [];
    for (const id of ['e5_continuation', 'e6_momentum', 'e6_all3', 'e6_two_plus_one', 'ctl_streak3']) {
      const s = find(r, id); if (!s) continue;
      for (const scope of ['overall', 'test'] as const) rows.push({ scope, ...row(id, scope === 'overall' ? s.byExpiry[expiry].overall : s.byExpiry[expiry].bySegment.test) });
    }
    out.push({
      title: `Sweep continuation vs momentum-only; strong-candle patterns vs control. expiry ${expiry}s`,
      note: 'e6_all3 = all three candles strong, e6_two_plus_one = two strong + one weaker, ctl_streak3 = any three same-colour candles with no body test.',
      rows,
    });
  }
  const grid = r.strategies.filter((s) => s.id.startsWith('e6_grid_'));
  for (const expiry of r.config.expiries) {
    out.push({
      title: `Engine 6 threshold grid, expiry ${expiry}s (body ratio x median multiple)`,
      note: 'Every variant on every segment. Do not pick the best row by eye: use `selection`, which chooses on validation only.',
      rows: grid.flatMap((s) => (['train', 'validation', 'test'] as const).map((seg) => ({ segment: seg, ...row(s.id, s.byExpiry[expiry].bySegment[seg]) }))),
    });
  }
  return out;
}

export function buildSelection(r: BacktestReport): BacktestReport['selection'] {
  const grid = r.strategies.filter((s) => s.id.startsWith('e6_grid_'));
  return r.config.expiries.map((expiry) => {
    const cands = grid
      .map((s) => ({ s, v: s.byExpiry[expiry].bySegment.validation, t: s.byExpiry[expiry].bySegment.test }))
      .filter((x) => x.v.trades >= r.config.minTradesForSelection && x.v.expectancy !== null);
    if (!cands.length) return { expiry, chosen: null, validation: null, test: null, note: `no threshold variant reached ${r.config.minTradesForSelection} validation trades` };
    cands.sort((a, b) => (b.v.expectancy as number) - (a.v.expectancy as number));
    const best = cands[0];
    return {
      expiry, chosen: best.s.id, validation: best.v, test: best.t,
      note: `chosen on validation expectancy among ${cands.length} variants; the test numbers were not used to choose. With ${cands.length} variants compared, a good test result can still be luck.`,
    };
  });
}

// ------------------------------------------------------------------------------------------------ trace
function traceInstrument(symbol: string, cs: Candle[], warmup: number, sink: (r: TraceRecord) => void) {
  const cp = CONTINUATION_DEFAULTS;
  for (let i = warmup; i < cs.length; i++) {
    for (const side of ['SELL', 'BUY'] as const) {
      const e = sequenceState(cs, i - 2, side, cp, false);
      if (e.state === 'CONFIRMED' || e.state === 'INVALIDATED') {
        const full = sequenceState(cs, i - 2, side, cp, true);
        sink({ strategy: 'e5_continuation', symbol, time: cs[i].time, side, qualified: e.state === 'CONFIRMED', state: e.state, lines: [`${full.reason}`, ...full.trace.checks.map((x) => `${x.pass ? 'PASS' : 'FAIL'} ${x.name}: ${x.detail}`)] });
      }
    }
    const q = evaluateMomentum(cs, i, MOMENTUM_DEFAULTS, false);
    const three = i >= 2 && [cs[i - 2], cs[i - 1], cs[i]].every((x) => x.close < x.open) || i >= 2 && [cs[i - 2], cs[i - 1], cs[i]].every((x) => x.close > x.open);
    if (q.signal || three) {
      const full = evaluateMomentum(cs, i, MOMENTUM_DEFAULTS, true);
      sink({ strategy: 'e6_momentum', symbol, time: cs[i].time, side: full.signal?.side ?? null, qualified: !!q.signal, state: q.signal ? 'QUALIFIED' : `REJECTED: ${full.failed}`, lines: full.trace.checks.map((x) => `${x.pass ? 'PASS' : 'FAIL'} ${x.name}: ${x.detail}`) });
    }
  }
}

// ------------------------------------------------------------------------------------------------ text report
export function renderReport(r: BacktestReport, opts: { instrumentDetail?: boolean } = {}): string {
  const L: string[] = [];
  const f = (x: number | null, d = 1) => (x === null ? '  n/a' : (x * 100).toFixed(d) + '%');
  const ev = (x: number | null) => (x === null ? '  n/a' : (x >= 0 ? '+' : '') + x.toFixed(3));
  const line = (name: string, s: Stats) =>
    `${name.padEnd(34)} ${String(s.trades).padStart(6)} ${String(s.wins).padStart(6)} ${String(s.losses).padStart(6)} ${f(s.winRate).padStart(7)} ${f(s.lossRate).padStart(7)} ${ev(s.expectancy).padStart(7)} ${s.maxDrawdown.toFixed(1).padStart(7)}  [${f(s.ciLow)}..${f(s.ciHigh)}] ${s.vsBreakeven}`;
  const head = `${'                                  '} trades   wins losses   win%   loss%      EV  maxDD   95% CI win rate`;
  L.push(`BACKTEST  tf=${r.config.tf}s  expiries=${r.config.expiries.join('/')}s  payout=${r.config.payout}  cost=${r.config.costPerTrade}  split train/val/test=${r.config.split.train}/${r.config.split.validation}/${+(1 - r.config.split.train - r.config.split.validation).toFixed(2)}`);
  for (const i of r.instruments) L.push(`  ${i.symbol}: ${i.candles} candles ${new Date(i.from * 1000).toISOString().slice(0, 10)} .. ${new Date(i.to * 1000).toISOString().slice(0, 10)}${i.issues.length ? '  | ' + i.issues.join('; ') : ''}`);
  L.push(`Breakeven win rate at this payout/cost: ${(r.strategies[0] ? r.strategies[0].byExpiry[r.config.expiries[0]].overall.breakevenWinRate * 100 : 0).toFixed(2)}%`);
  L.push(`Conflicts: Engine 5 and Engine 6 on the same candle: both fired ${r.conflicts.candlesWithBothEngines}, same side ${r.conflicts.sameSide}, opposite ${r.conflicts.opposite} (cannot disagree on one candle by construction)`);
  L.push(`Conflicts: opposite-side signals whose trades would be open together: ${Object.entries(r.conflicts.overlappingOpposite).map(([e, n]) => `expiry ${e}s: ${n}`).join(', ')}`);
  for (const e of r.conflicts.examples) L.push(`    ${e}`);
  for (const expiry of r.config.expiries) {
    L.push('', `=== EXPIRY ${expiry}s ===`, head);
    for (const s of r.strategies) {
      const x = s.byExpiry[expiry];
      L.push(line(`${s.id} [all]`, x.overall) + `   signals=${s.signals} skipped(open)=${x.skippedOverlap}`);
      for (const seg of ['train', 'validation', 'test'] as const) L.push(line(`   ${seg}`, x.bySegment[seg]));
    }
  }
  const main = ['e5_continuation', 'e6_momentum'];
  for (const expiry of r.config.expiries) {
    for (const id of main) {
      const s = find(r, id); if (!s) continue;
      L.push('', `--- ${id}, expiry ${expiry}s: by session ---`, head);
      for (const [k, v] of Object.entries(s.byExpiry[expiry].bySession)) L.push(line(k, v));
      if (opts.instrumentDetail !== false) { L.push(`--- ${id}, expiry ${expiry}s: by instrument ---`, head); for (const [k, v] of Object.entries(s.byExpiry[expiry].byInstrument)) L.push(line(k, v)); }
    }
  }
  for (const c of r.comparisons) {
    L.push('', `### ${c.title}`, `    ${c.note}`);
    for (const rw of c.rows) L.push('    ' + Object.entries(rw).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join('  '));
  }
  L.push('', '### Threshold selection (validation only)');
  for (const s of r.selection) L.push(`    expiry ${s.expiry}s: ${s.chosen ?? 'none'}  validation EV ${ev(s.validation?.expectancy ?? null)} (${s.validation?.trades ?? 0} trades)  test EV ${ev(s.test?.expectancy ?? null)} (${s.test?.trades ?? 0} trades)  | ${s.note}`);
  L.push('', 'Assumptions:', ...r.assumptions.map((a) => `  - ${a}`));
  return L.join('\n');
}
