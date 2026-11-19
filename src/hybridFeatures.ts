// FEATURES for the probability model, and Stage 2 indicator evidence.
//
// Every feature for the setup on candle i is computed from candles 0..i, the structure/sweep state after candle i, the indicator snapshot at
// i, and outcomes of earlier setups that had ALREADY SETTLED (plus a lag) when candle i closed. A test cuts the series at i and checks that
// the features do not change. Labels (what happened after) are never an input here.
//
// Side-relative features: positive means "in the direction of the proposed trade" (BUY: up, SELL: down), so a BUY and a SELL share one scale.
import { Candle, anatomy, median } from './candleMath';
import { HybridConfig } from './hybridConfig';
import { IndicatorSnapshot } from './hybridIndicators';
import { PATTERN_IDS, PatternHit, PatternId, Side, SideCandidate } from './hybridSetups';
import { Decision } from './quantumPipeline';

export const PATTERN_FLAG: Record<PatternId, string> = {
  BEARISH_SWEEP: 'pat_bearish_sweep', BULLISH_SWEEP: 'pat_bullish_sweep', EQ_UPPER_WICK_SWEEP: 'pat_eq_upper_wick', EQ_LOWER_WICK_SWEEP: 'pat_eq_lower_wick',
  SWEEP_CONTINUATION: 'pat_sweep_continuation', MOMENTUM_BODY_DOMINANCE: 'pat_momentum', WEAK_STRONG_STRONG: 'pat_weak_strong_strong', REPEATED_SWEEP: 'pat_repeated_sweep',
};

export type FeatureGroup = 'pattern' | 'candle' | 'sweep' | 'structure' | 'adx' | 'atr' | 'ema' | 'perf' | 'time' | 'instrument';
export const FEATURE_GROUPS: Record<Exclude<FeatureGroup, 'instrument'>, string[]> = {
  pattern: ['side_buy', ...PATTERN_IDS.map((p) => PATTERN_FLAG[p]), 'pat_count'],
  candle: ['c0_body_ratio', 'c0_upper_wick', 'c0_lower_wick', 'c0_rej_wick', 'c0_opp_wick', 'c0_dir', 'c1_body_ratio', 'c1_dir', 'c2_body_ratio', 'c2_dir',
    'rel_body_c0', 'rel_range_c0', 'rel_body_mean3', 'mom3_strength', 'n_strong3', 'n_strong3_dir'],
  sweep: ['sweep_recent', 'sweep_cluster_ordinal', 'sweep_on_candle', 'sweep_depth'],
  structure: ['struct_trend', 'struct_trend_abs', 'struct_recent_changes', 'struct_event_bos', 'struct_event_mss', 'struct_age', 'exh_healthy', 'exh_possible', 'exh_reversal'],
  adx: ['adx', 'di_diff'],
  atr: ['atr_pct', 'atr_ratio'],
  ema: ['ema_gap_atr', 'ema_slope_atr', 'price_vs_ema_atr', 'ema_aligned'],
  perf: ['perf_pat_wr', 'perf_pat_n', 'perf_all_wr', 'perf_all_n'],
  time: ['hour_sin', 'hour_cos', 'dow_sin', 'dow_cos', 'sess_asia', 'sess_london', 'sess_ny'],
};
export const INDICATOR_GROUPS: FeatureGroup[] = ['adx', 'atr', 'ema'];

/** Feature names for a model kind. C = candlestick + context + performance + time + instrument (NO indicator inputs). D = all groups. */
export function featureNamesFor(kind: 'C' | 'D', instruments: string[]): string[] {
  const groups = (Object.keys(FEATURE_GROUPS) as Array<keyof typeof FEATURE_GROUPS>).filter((g) => kind === 'D' || !INDICATOR_GROUPS.includes(g));
  return [...groups.flatMap((g) => FEATURE_GROUPS[g]), ...instruments.map((s) => `inst_${s}`)];
}
export const ALL_BASE_FEATURES: string[] = (Object.values(FEATURE_GROUPS) as string[][]).flat();
export const EMA_FLAT_GAP_FEATURE = 0.1;      // |ema gap| below this many ATRs = not aligned (feature definition; the rule evidence uses config.indicators.ema.flatGapAtr)
export const instrumentFeatures = (symbol: string, names: string[]): Record<string, number> => Object.fromEntries(names.filter((n) => n.startsWith('inst_')).map((n) => [n, n === `inst_${symbol}` ? 1 : 0]));

// ------------------------------------------------------------------------------------------------ recent pattern performance
export interface PerfStats { patWr: number; patN: number; allWr: number; allN: number }

/**
 * Win rate of the last `window` RESOLVED setups: for the same primary pattern and for all patterns, per instrument.
 * A setup's outcome becomes usable only when settleAt + lagSec <= now (the broker's result is not known to the system at the very second
 * the trade settles). Win rate is shrunk toward 50% with `priorWeight` pseudo-observations so tiny samples do not look extreme.
 */
export class PerformanceTracker {
  private pending: Array<{ key: string; settleAt: number; win: boolean | null }> = [];
  private byKey = new Map<string, boolean[]>();
  private all: boolean[] = [];
  constructor(private window: number, private lagSec: number, private priorWeight: number) {}
  record(key: string, settleAt: number, win: boolean | null) { this.pending.push({ key, settleAt, win }); }
  private resolve(now: number) {
    while (this.pending.length && this.pending[0].settleAt + this.lagSec <= now) {
      const p = this.pending.shift()!;
      if (p.win === null) continue;                                   // ties carry no information about direction
      const a = this.byKey.get(p.key) ?? []; a.push(p.win); if (a.length > this.window) a.shift(); this.byKey.set(p.key, a);
      this.all.push(p.win); if (this.all.length > this.window) this.all.shift();
    }
  }
  stats(key: string, now: number): PerfStats {
    this.resolve(now);
    const rate = (a: boolean[]) => (a.filter(Boolean).length + 0.5 * this.priorWeight) / (a.length + this.priorWeight);
    const k = this.byKey.get(key) ?? [];
    return { patWr: rate(k), patN: k.length, allWr: rate(this.all), allN: this.all.length };
  }
}

// ------------------------------------------------------------------------------------------------ the feature vector
export interface FeatureContext {
  cs: Candle[]; i: number;                 // the run of closed candles and the index of the signal candle (the last one)
  cand: SideCandidate; hits: PatternHit[];
  d: Decision;                             // pipeline decision for candle i (structure, sweeps, exhaustion)
  ind: IndicatorSnapshot;
  perf: PerfStats;
  execTime: number;                        // (expected) execution time, epoch seconds: signal close + delay
}

const sessionOf = (h: number) => (h < 7 ? 'asia' : h < 13 ? 'london' : h < 21 ? 'ny' : 'late');

export function buildFeatures(x: FeatureContext): Record<string, number> {
  const { cs, i, cand, d, ind, perf } = x;
  const sg = cand.side === 'BUY' ? 1 : -1;
  const f: Record<string, number> = {};
  const c0 = cs[i], c1 = cs[i - 1], c2 = cs[i - 2];
  const a0 = anatomy(c0), a1 = anatomy(c1), a2 = anatomy(c2);
  const dirRel = (a: ReturnType<typeof anatomy>) => (a.direction === 'doji' ? 0 : (a.direction === 'bull' ? 1 : -1) * sg);
  const bodies20 = cs.slice(i - 20, i).map((c) => Math.abs(c.close - c.open));
  const ranges20 = cs.slice(i - 20, i).map((c) => c.high - c.low);
  const medBody = median(bodies20), medRange = median(ranges20);

  // pattern flags
  f.side_buy = cand.side === 'BUY' ? 1 : 0;
  for (const id of PATTERN_IDS) f[PATTERN_FLAG[id]] = cand.patterns.includes(id) ? 1 : 0;
  f.pat_count = cand.patterns.length;

  // signal candle and the two before it
  f.c0_body_ratio = a0.bodyRatio; f.c0_upper_wick = a0.range > 0 ? a0.upperWick / a0.range : 0; f.c0_lower_wick = a0.range > 0 ? a0.lowerWick / a0.range : 0;
  f.c0_rej_wick = cand.side === 'BUY' ? f.c0_lower_wick : f.c0_upper_wick; f.c0_opp_wick = cand.side === 'BUY' ? f.c0_upper_wick : f.c0_lower_wick;
  f.c0_dir = dirRel(a0); f.c1_body_ratio = a1.bodyRatio; f.c1_dir = dirRel(a1); f.c2_body_ratio = a2.bodyRatio; f.c2_dir = dirRel(a2);
  f.rel_body_c0 = medBody > 0 ? a0.body / medBody : NaN; f.rel_range_c0 = medRange > 0 ? a0.range / medRange : NaN;
  f.rel_body_mean3 = medBody > 0 ? (a0.body + a1.body + a2.body) / (3 * medBody) : NaN;
  f.mom3_strength = medBody > 0 ? (sg * ((c0.close - c0.open) + (c1.close - c1.open) + (c2.close - c2.open))) / (3 * medBody) : NaN;
  const strong = [a0, a1, a2].map((a) => a.bodyRatio >= 0.65);
  f.n_strong3 = strong.filter(Boolean).length;
  f.n_strong3_dir = [a0, a1, a2].filter((a, k) => strong[k] && dirRel(a) === 1).length;

  // sweeps (Engine 9 state after this candle)
  f.sweep_recent = d.recentSweeps; f.sweep_cluster_ordinal = d.sweepCount; f.sweep_on_candle = d.sweep ? 1 : 0;
  const sweepHit = x.hits.find((h) => h.side === cand.side && h.level !== null && ['BEARISH_SWEEP', 'BULLISH_SWEEP', 'EQ_UPPER_WICK_SWEEP', 'EQ_LOWER_WICK_SWEEP', 'REPEATED_SWEEP'].includes(h.id));
  f.sweep_depth = sweepHit && medRange > 0 ? Math.abs((cand.side === 'SELL' ? c0.high : c0.low) - (sweepHit.level as number)) / medRange : 0;

  // market structure (Engine 8) and exhaustion (Engine 12)
  const trendNum = d.trend === 'BULLISH' ? 1 : d.trend === 'BEARISH' ? -1 : 0;
  f.struct_trend = sg * trendNum; f.struct_trend_abs = Math.abs(trendNum);
  f.struct_recent_changes = d.structure?.recentChanges ?? NaN;
  const ev = d.structure?.event ?? null;
  f.struct_event_bos = ev?.type === 'BOS' ? sg * (ev.direction === 'BULL' ? 1 : -1) : 0; f.struct_event_mss = ev?.type === 'MSS' ? sg * (ev.direction === 'BULL' ? 1 : -1) : 0;
  const since = d.structure?.trendSince; f.struct_age = since === null || since === undefined ? NaN : Math.min(100, d.index - d.runStart - since);
  f.exh_healthy = d.exhaustion?.state === 'HEALTHY_CONTINUATION' ? 1 : 0; f.exh_possible = d.exhaustion?.state === 'POSSIBLE_EXHAUSTION' ? 1 : 0; f.exh_reversal = d.exhaustion?.state === 'CONFIRMED_STRUCTURE_REVERSAL' ? 1 : 0;

  // indicators: measurements of the market, side-relative where a direction matters
  f.adx = ind.adx; f.di_diff = sg * (ind.plusDI - ind.minusDI);
  f.atr_pct = ind.atr / c0.close * 100; f.atr_ratio = ind.atrRatio;
  const gap = sg * (ind.emaFast - ind.emaSlow) / ind.atr, slope = sg * ind.emaFastSlope;
  f.ema_gap_atr = gap; f.ema_slope_atr = slope; f.price_vs_ema_atr = sg * (c0.close - ind.emaFast) / ind.atr;
  f.ema_aligned = Number.isFinite(gap) && Number.isFinite(slope) ? (gap > EMA_FLAT_GAP_FEATURE && slope > 0 ? 1 : gap < -EMA_FLAT_GAP_FEATURE && slope < 0 ? -1 : 0) : NaN;

  // recent performance of earlier, already settled setups
  f.perf_pat_wr = perf.patWr; f.perf_pat_n = perf.patN; f.perf_all_wr = perf.allWr; f.perf_all_n = perf.allN;

  // actual (expected) execution time, UTC
  const t = x.execTime, h = (t / 3600) % 24, dow = Math.floor(t / 86400 + 4) % 7;
  f.hour_sin = Math.sin((2 * Math.PI * h) / 24); f.hour_cos = Math.cos((2 * Math.PI * h) / 24);
  f.dow_sin = Math.sin((2 * Math.PI * dow) / 7); f.dow_cos = Math.cos((2 * Math.PI * dow) / 7);
  const s = sessionOf(Math.floor(h)); f.sess_asia = s === 'asia' ? 1 : 0; f.sess_london = s === 'london' ? 1 : 0; f.sess_ny = s === 'ny' ? 1 : 0;
  return f;
}

// ------------------------------------------------------------------------------------------------ STAGE 2: indicator evidence
export type Evidence = 'SUPPORTS' | 'NEUTRAL' | 'CONTRADICTS' | 'UNAVAILABLE' | 'DISABLED';
export interface EvidenceReport {
  adx: Evidence; atr: Evidence; ema: Evidence;
  values: { adx: number; diDiff: number; atrRatio: number; emaGapAtr: number; emaSlopeAtr: number };
  qualityScore: number | null;       // mean of +1 / 0 / -1 over the enabled, available indicators
  available: number; contradicting: number;
  gatePass: boolean;
  veto: string | null;               // why the gate said no (null when it passed)
  details: string[];
}
const NUM: Record<Evidence, number> = { SUPPORTS: 1, NEUTRAL: 0, CONTRADICTS: -1, UNAVAILABLE: 0, DISABLED: 0 };

/**
 * The indicators judge the setup; they do not create it. Starting hypotheses (NOT tuned, NOT validated; the model, not these rules, learns
 * what really matters):
 *   ADX  continuation family: strong trend in the trade direction supports, strong trend against it or no trend contradicts.
 *        reversal family:     a strong trend running against the trade contradicts, a weak trend (range) supports.
 *   ATR  volatility relative to its own 100-value median: inside the core band supports, outside the outer band contradicts.
 *   EMA  20/50 ordering and EMA20 slope: the trade direction agrees with both supports, disagrees with both contradicts.
 * The gate vetoes a valid setup only when the configured share of the available indicators contradict it (default: all of them, and at
 * least two available), or when the mean evidence falls below `gate.minQuality` (default off).
 */
export function evaluateEvidence(f: Record<string, number>, family: 'CONTINUATION' | 'REVERSAL', cfg: HybridConfig): EvidenceReport {
  const { adx: A, atr: R, ema: E } = cfg.indicators;
  const v = { adx: f.adx, diDiff: f.di_diff, atrRatio: f.atr_ratio, emaGapAtr: f.ema_gap_atr, emaSlopeAtr: f.ema_slope_atr };
  const details: string[] = [];
  const ev = (enabled: boolean, ok: boolean, fn: () => [Evidence, string]): Evidence => {
    if (!enabled) return 'DISABLED';
    if (!ok) return 'UNAVAILABLE';
    const [e, why] = fn(); details.push(why); return e;
  };
  const adx = ev(A.enabled, Number.isFinite(v.adx) && Number.isFinite(v.diDiff), () => {
    const strong = v.adx >= A.strong, weak = v.adx < A.weak, withDir = v.diDiff > 0;
    if (family === 'CONTINUATION') {
      const e: Evidence = strong ? (withDir ? 'SUPPORTS' : 'CONTRADICTS') : weak ? 'CONTRADICTS' : 'NEUTRAL';
      return [e, `ADX ${v.adx.toFixed(1)} (${strong ? 'strong' : weak ? 'weak' : 'moderate'}), DI ${withDir ? 'with' : 'against'} the trade: ${e}`];
    }
    const e: Evidence = strong && !withDir ? 'CONTRADICTS' : weak ? 'SUPPORTS' : 'NEUTRAL';
    return [e, `ADX ${v.adx.toFixed(1)} (${strong ? 'strong' : weak ? 'weak' : 'moderate'}), DI ${withDir ? 'with' : 'against'} the trade: ${e}`];
  });
  const atr = ev(R.enabled, Number.isFinite(v.atrRatio), () => {
    const e: Evidence = v.atrRatio >= R.coreLow && v.atrRatio <= R.coreHigh ? 'SUPPORTS' : v.atrRatio < R.outerLow || v.atrRatio > R.outerHigh ? 'CONTRADICTS' : 'NEUTRAL';
    return [e, `ATR ${v.atrRatio.toFixed(2)}x its median (core ${R.coreLow}-${R.coreHigh}, outer ${R.outerLow}-${R.outerHigh}): ${e}`];
  });
  const ema = ev(E.enabled, Number.isFinite(v.emaGapAtr) && Number.isFinite(v.emaSlopeAtr), () => {
    const up = v.emaGapAtr > E.flatGapAtr && v.emaSlopeAtr > 0, down = v.emaGapAtr < -E.flatGapAtr && v.emaSlopeAtr < 0;
    const e: Evidence = up ? 'SUPPORTS' : down ? 'CONTRADICTS' : 'NEUTRAL';
    return [e, `EMA${E.fast}/${E.slow} gap ${v.emaGapAtr.toFixed(2)} ATR, slope ${v.emaSlopeAtr.toFixed(2)} ATR (trade-relative): ${e}`];
  });
  const used = [adx, atr, ema].filter((e) => e !== 'DISABLED' && e !== 'UNAVAILABLE');
  const contradicting = used.filter((e) => e === 'CONTRADICTS').length;
  const quality = used.length ? used.reduce((s, e) => s + NUM[e], 0) / used.length : null;
  let veto: string | null = null;
  if (used.length >= cfg.gate.minIndicatorsForVeto && contradicting / used.length >= cfg.gate.vetoContradictFraction) veto = `${contradicting} of ${used.length} indicators contradict the setup (veto at >= ${cfg.gate.vetoContradictFraction * 100}%)`;
  else if (cfg.gate.minQuality > -1 && quality !== null && quality < cfg.gate.minQuality) veto = `evidence score ${quality.toFixed(2)} < minimum ${cfg.gate.minQuality}`;
  return { adx, atr, ema, values: v, qualityScore: quality, available: used.length, contradicting, gatePass: veto === null, veto, details };
}
