// Backtest for Engines 7 to 12. Built on the same trade simulator as Engines 5 and 6 (src/engineBacktest.ts): a signal exists when the signal
// candle closes, the order fills at the first available price (optionally after a delay, optionally from a finer price series), and the
// trade settles `expiry` seconds after the ACTUAL fill. For a 5-minute chart with a 5-minute expiry and no delay, on candle data alone, that is
// necessarily the same as comparing the next candle's open and close; the execution model (delaySec + `fine` data) is what makes the
// 5-minute duration differ from "colour of the next candle".
//
// Every hypothesis is its own strategy, so none is assumed:
//   Engine 7   three strong candles (as continuation AND, separately, as reversal); weak-strong-strong (as reversal AND as continuation)
//   Engine 9   single sweeps, repeated-sweep clusters, with-trend sweeps, countertrend sweeps, sweeps with no trend: each entered right after the
//              sweep candle closes. These are research baselines that show what the sweep alone does. They are NOT trading rules.
//   Engine 11  with-trend sweep continuation after confirmation (with and without the exhaustion gate)
//   Engine 10  confirmed structure reversals
//   Pipeline   everything the pipeline would actually trade
// Trades carry tags (trend, sweep count, alignment, exhaustion state) so results can be cut by trend condition and sweep count.
import { Candle, contiguous } from './candleMath';
import { BacktestConfig, BacktestReport, Dataset, Stats, StrategyDef, Trade, defaultStrategies, runBacktest, summarize } from './engineBacktest';
import { QUANTUM_DEFAULTS, QuantumParams, pipelineSeries, quantumParams } from './quantumPipeline';
import { SEQUENCE_DEFAULTS, SequenceParams, classifySequence } from './sequenceClassifier';
import { FourthCandleReport, fourthCandleStats, renderFourthCandle } from './sequenceStats';
import { resolveExpiry } from './executionConfig';

type Side = 'BUY' | 'SELL';
const flip = (s: Side): Side => (s === 'BUY' ? 'SELL' : 'BUY');
export const sweepBucket = (n: number) => (n >= 4 ? '4+' : String(n));

export function intelligenceStrategies(qp: QuantumParams = QUANTUM_DEFAULTS, seq: SequenceParams = SEQUENCE_DEFAULTS): StrategyDef[] {
  const noGate = quantumParams({ ...(qp as any), continuation: { ...qp.continuation, blockOnExhaustion: false } });
  const seqStrat = (id: string, label: string, cls: 'THREE_STRONG' | 'WEAK_STRONG_STRONG', mode: 'hypothesis' | 'opposite-of-hypothesis'): StrategyDef => ({
    id, label, group: 'engine7',
    detect: (cs, i) => {
      const r = classifySequence(cs, i, seq);
      if (!r || r.classification !== cls || !r.hypothesis.side) return null;
      return { side: mode === 'hypothesis' ? r.hypothesis.side : flip(r.hypothesis.side), detail: { class: cls, direction: r.direction } };
    },
  });
  const sweepStrat = (id: string, label: string, pick: (a: NonNullable<ReturnType<typeof pipelineSeries>[number]['sweep']>) => boolean): StrategyDef => ({
    id, label, group: 'engine9',
    detect: (cs, i) => {
      const d = pipelineSeries(cs, qp)[i];
      if (!d?.sweep || !pick(d.sweep)) return null;
      return { side: d.sweep.side, detail: { trend: d.sweep.trendAtSweep, alignment: d.sweep.alignment, sweepCount: sweepBucket(d.sweep.ordinal), recent: d.sweep.recentCount } };
    },
  });
  const pipeStrat = (id: string, label: string, group: StrategyDef['group'], params: QuantumParams, kind: 'WITH_TREND_CONTINUATION' | 'CONFIRMED_REVERSAL' | null): StrategyDef => ({
    id, label, group,
    detect: (cs, i) => {
      const d = pipelineSeries(cs, params)[i];
      if (!d || d.action === 'NO_TRADE' || (kind && d.kind !== kind)) return null;
      return { side: d.action, detail: { kind: d.kind ?? '', trend: d.signal?.trendContext ?? d.trend, sweepCount: sweepBucket(Math.max(1, d.sweepCount)), exhaustion: d.exhaustion?.state ?? '' } };
    },
  });
  return [
    seqStrat('e7_three_strong_as_continuation', 'Engine 7: THREE_STRONG, traded as continuation', 'THREE_STRONG', 'hypothesis'),
    seqStrat('e7_three_strong_as_reversal', 'Engine 7: THREE_STRONG, traded against (tests the opposite hypothesis)', 'THREE_STRONG', 'opposite-of-hypothesis'),
    seqStrat('e7_wss_as_reversal', 'Engine 7: WEAK_STRONG_STRONG, traded as exhaustion/reversal', 'WEAK_STRONG_STRONG', 'hypothesis'),
    seqStrat('e7_wss_as_continuation', 'Engine 7: WEAK_STRONG_STRONG, traded with the sequence (tests the opposite hypothesis)', 'WEAK_STRONG_STRONG', 'opposite-of-hypothesis'),
    sweepStrat('e9_single_sweep', 'Engine 9 baseline: first sweep of a cluster, entered after the sweep candle', (s) => s.ordinal === 1),
    sweepStrat('e9_repeated_cluster', 'Engine 9 baseline: 2nd or later sweep of a cluster', (s) => s.ordinal >= 2),
    sweepStrat('e9_with_trend_sweep', 'Engine 9 baseline: with-trend sweep, no confirmation', (s) => s.alignment === 'WITH_TREND'),
    sweepStrat('e9_countertrend_sweep', 'Engine 9 baseline: countertrend sweep, no confirmation (must not be a trading rule)', (s) => s.alignment === 'COUNTERTREND'),
    sweepStrat('e9_no_trend_sweep', 'Engine 9 baseline: sweep while structure neutral', (s) => s.alignment === 'NO_TREND'),
    pipeStrat('e11_continuation_confirmed', 'Engine 11: with-trend sweep + original 3-candle rule + structure + exhaustion gate', 'engine11', qp, 'WITH_TREND_CONTINUATION'),
    pipeStrat('e11_continuation_no_exhaustion_gate', 'Engine 11 without the Engine 12 exhaustion gate', 'engine11', noGate, 'WITH_TREND_CONTINUATION'),
    pipeStrat('e10_reversal_confirmed', 'Engine 10: countertrend sweep + confirmed structure shift', 'engine10', qp, 'CONFIRMED_REVERSAL'),
    pipeStrat('pipeline_all', 'Pipeline: every BUY/SELL the pipeline would take', 'pipeline', qp, null),
  ];
}

export function allStrategies(qp: QuantumParams = QUANTUM_DEFAULTS, seq: SequenceParams = SEQUENCE_DEFAULTS): StrategyDef[] {
  return [...defaultStrategies(), ...intelligenceStrategies(qp, seq)];
}

// ------------------------------------------------------------------------------------------------ breakdowns
export type BreakdownKey = 'sweepCount' | 'trend' | 'alignment' | 'exhaustion' | 'kind' | 'class' | 'symbol' | 'session';

/** Statistics of one strategy at one expiry, grouped by a tag (sweep count, trend condition, ...). */
export function breakdown(trades: Trade[], strategy: string, expiry: number, key: BreakdownKey, payout: number, cost = 0): Record<string, Stats> {
  const groups: Record<string, Trade[]> = {};
  for (const t of trades) {
    if (t.strategy !== strategy || t.expiry !== expiry) continue;
    const g = key === 'symbol' ? t.symbol : key === 'session' ? t.session : String(t.detail?.[key] ?? 'n/a');
    (groups[g] ??= []).push(t);
  }
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([k, v]) => [k, summarize(v, payout, cost)]));
}

// ------------------------------------------------------------------------------------------------ timeframes
/** Builds higher-timeframe candles from lower ones. A bucket is kept only when every candle in it is present and contiguous. */
export function resampleCandles(cs: Candle[], fromTf: number, toTf: number): Candle[] {
  if (!(toTf > fromTf) || toTf % fromTf !== 0) throw new Error(`cannot resample ${fromTf}s candles to ${toTf}s (must be a larger whole multiple)`);
  const per = toTf / fromTf, out: Candle[] = [];
  let bucket: Candle[] = [], key = NaN;
  const flush = () => {
    if (bucket.length === per && contiguous(bucket)) {
      out.push({ time: key, open: bucket[0].open, high: Math.max(...bucket.map((c) => c.high)), low: Math.min(...bucket.map((c) => c.low)), close: bucket[per - 1].close });
    }
    bucket = [];
  };
  for (const c of cs) {
    if (c.closed === false) continue;
    const k = Math.floor(c.time / toTf) * toTf;
    if (k !== key) { flush(); key = k; }
    bucket.push(c);
  }
  flush();
  return out;
}

export interface TimeframeRun { tf: number; expiries: number[]; report: BacktestReport; trades: Trade[] }

/** One backtest per timeframe. Expiries default to the live policy: a 5-minute chart is tested with the 5-minute expiry only. */
export function runTimeframes(data: Dataset[], baseTf: number, tfs: number[], cfg: Partial<BacktestConfig> = {}, qp: QuantumParams = QUANTUM_DEFAULTS): TimeframeRun[] {
  return tfs.map((tf) => {
    const ds: Dataset[] = tf === baseTf ? data : data.map((d) => ({ symbol: d.symbol, candles: resampleCandles(d.candles, baseTf, tf), fine: d.fine }));
    const expiries = cfg.expiries && cfg.expiries.length ? cfg.expiries.filter((e) => e % tf === 0) : [resolveExpiry(tf).expirySec];
    const { report, trades } = runBacktest(ds, { ...cfg, tf, expiries, strategies: allStrategies(qp) });
    return { tf, expiries, report, trades };
  });
}

// ------------------------------------------------------------------------------------------------ text report
export function renderIntel(run: TimeframeRun, fourth: FourthCandleReport | null, qp: QuantumParams = QUANTUM_DEFAULTS): string {
  const { report, trades } = run, L: string[] = [];
  const f = (x: number | null, d = 1) => (x === null ? ' n/a' : (x * 100).toFixed(d) + '%');
  const ev = (x: number | null) => (x === null ? ' n/a' : (x >= 0 ? '+' : '') + x.toFixed(3));
  const line = (name: string, s: Stats) => `${name.padEnd(36)} ${String(s.trades).padStart(6)} ${f(s.winRate).padStart(7)} ${ev(s.expectancy).padStart(7)} ${s.maxDrawdown.toFixed(1).padStart(7)}  [${f(s.ciLow)}..${f(s.ciHigh)}] ${s.vsBreakeven}`;
  const head = `${''.padEnd(36)} trades    win%      EV   maxDD   95% CI win rate`;
  const ids = report.strategies.filter((s) => /^(e7_|e9_|e10_|e11_|pipeline_|e5_continuation$)/.test(s.id));
  L.push(`ENGINES 7-12 BACKTEST  tf=${run.tf}s  expiry=${run.expiries.join('/')}s  delay=${report.config.delaySec}s  payout=${report.config.payoutTable ? 'table' : report.config.payout}  cost=${report.config.costPerTrade}`);
  for (const expiry of run.expiries) {
    L.push('', `=== EXPIRY ${expiry}s: all / validation / test (chronological) ===`, head);
    for (const s of ids) {
      const x = s.byExpiry[expiry];
      L.push(line(s.id, x.overall), line('   validation', x.bySegment.validation), line('   test (out of sample)', x.bySegment.test));
    }
    for (const [id, keys] of [['e9_single_sweep', ['alignment', 'sweepCount']], ['e9_repeated_cluster', ['sweepCount', 'trend']], ['e11_continuation_confirmed', ['trend', 'sweepCount', 'exhaustion']], ['e10_reversal_confirmed', ['trend', 'sweepCount']], ['pipeline_all', ['kind', 'trend']]] as Array<[string, BreakdownKey[]]>) {
      for (const k of keys) {
        const b = breakdown(trades, id, expiry, k, report.config.payout, report.config.costPerTrade);
        if (!Object.keys(b).length) continue;
        L.push('', `--- ${id} by ${k} (expiry ${expiry}s) ---`, head);
        for (const [g, st] of Object.entries(b)) L.push(line(g, st));
      }
    }
  }
  if (fourth) L.push('', renderFourthCandle(fourth));
  L.push('', `Pipeline parameters (all configurable): ${JSON.stringify(qp)}`, '', 'Assumptions:', ...report.assumptions.map((a) => `  - ${a}`),
    '  - Engine 9 baselines enter straight after the sweep candle to show what a sweep does on its own; they are not trading rules.',
    '  - Many strategies and breakdown cells are compared here. A cell that looks good in one segment is a multiple-comparison result, not proof of an edge; look at the out-of-sample test rows and the intervals.',
    '  - No result in this report guarantees that any sweep count or candle sequence leads to a reversal or a continuation.');
  return L.join('\n');
}

export const fourthFor = (data: Dataset[], seq: SequenceParams = SEQUENCE_DEFAULTS) => fourthCandleStats(data, seq);
