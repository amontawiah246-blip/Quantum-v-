// REJECTION INSTRUMENTATION AND LOW-FREQUENCY ATTRIBUTION.
//
// Every candidate setup that the hybrid engine sees is written to a DecisionRecord: which pattern fired, what the validation said, why
// it was rejected (stage and reason), the indicator conditions, the model probability and the final decision. On top of the records this
// module keeps counters (the "funnel") and data-health counts so that a low number of signals can be traced to ONE of:
//   1. overly restrictive thresholds        2. incorrect candle detection      3. timeframe synchronisation
//   4. missing historical candles           5. incorrect OHLC data             6. an actual absence of qualifying opportunities
// The attribution is evidence, not a verdict: each finding carries the numbers it is based on and says LIKELY / UNLIKELY / NOT_MEASURED.
// Nothing in here changes a trading rule. The "what-if" counts for looser candlestick thresholds are measurement only.
import { Candle, Tracer, contiguous, median, validOhlc } from './candleMath';
import { CONTINUATION_DEFAULTS } from './continuationEngine';
import { MOMENTUM_DEFAULTS, MomentumParams, detectMomentumSignal } from './momentumEngine';
import { SEQUENCE_DEFAULTS, SequenceParams, classifySequence } from './sequenceClassifier';
import { isSweep } from './sweepPatterns';
import { EQUAL_LEVEL_DEFAULTS, EqualLevelParams, checkEqualLevelSweep } from './equalLevelSweeps';
import { EvidenceReport } from './hybridFeatures';
import { FunnelEntry, PatternId, Side } from './hybridSetups';

export type RejectionStage = 'DATA' | 'WARMUP' | 'TIMEFRAME' | 'STAGE2_INDICATORS' | 'STAGE3_MODEL' | 'MODEL_UNAVAILABLE' | 'CONFLICT' | 'TRADE_OPEN';

export interface DecisionRecord {
  symbol: string;
  time: number;                 // open time of the signal candle
  closeTime: number;            // when it closed = earliest moment the order may be sent
  side: Side;
  patterns: PatternId[];        // every original pattern that fired for this side
  primary: PatternId;
  family: 'CONTINUATION' | 'REVERSAL';
  stage1: { valid: true; notes: string[] };
  stage2: { gating: boolean; evidence: EvidenceReport };
  stage3: { model: 'C' | 'D' | null; rawProbability: number | null; probability: number | null; threshold: number | null; breakeven: number; required: number | null; pass: boolean | null; problems: string[] };
  mode: 'A' | 'B' | 'C' | 'D';
  decision: Side | 'NO_TRADE';
  rejectionStage: RejectionStage | null;
  rejectionReason: string | null;
  features?: Record<string, number>;
}

export interface DataHealth {
  candlesSeen: number; accepted: number;
  invalidOhlc: number; unfinished: number; duplicates: number; outOfOrder: number;
  gapEvents: number; missingCandles: number;
  misalignedTimestamps: number;       // time is not a multiple of the timeframe
  wrongSpacing: number;               // distance to the previous accepted candle is not the timeframe and is not a whole number of missing candles
  flatCandles: number;                // open = high = low = close (broker filler)
  observedTfSec: number | null; expectedTfSec: number;
  resets: number;                     // times all state was dropped (gap / invalid / out of order)
  warmupCandles: number;              // accepted candles that could not be evaluated because history was too short (after the start or a reset)
}

export const emptyHealth = (tf: number): DataHealth => ({ candlesSeen: 0, accepted: 0, invalidOhlc: 0, unfinished: 0, duplicates: 0, outOfOrder: 0, gapEvents: 0, missingCandles: 0, misalignedTimestamps: 0, wrongSpacing: 0, flatCandles: 0, observedTfSec: null, expectedTfSec: tf, resets: 0, warmupCandles: 0 });

export class Diagnostics {
  health: DataHealth;
  candlesEvaluated = 0;                                   // accepted, past warm-up, timeframe OK
  candlesWithCandidate = 0;
  fired: Partial<Record<PatternId, number>> = {};
  /** per pattern: first failed check -> number of candles. The key 'FIRED' counts the candles where the pattern fired. */
  funnel: Record<string, Record<string, number>> = {};
  candidates = 0;                                         // (candle, side) observations after Stage 1
  rejectedBy: Partial<Record<RejectionStage, number>> = {};
  reasons: Record<string, number> = {};
  traded = 0;
  byMode: Record<string, number> = {};
  byPattern: Record<string, { candidates: number; traded: number; rejected: Record<string, number> }> = {};
  constructor(tf: number) { this.health = emptyHealth(tf); }

  addFunnel(entries: FunnelEntry[]) {
    for (const e of entries) {
      const m = (this.funnel[e.pattern] ??= {});
      const k = e.firstFailed === null ? 'FIRED' : e.firstFailed;
      m[k] = (m[k] ?? 0) + 1;
    }
  }
  addRecord(r: DecisionRecord) {
    this.candidates++;
    for (const p of r.patterns) this.fired[p] = (this.fired[p] ?? 0) + 1;
    const bp = (this.byPattern[r.primary] ??= { candidates: 0, traded: 0, rejected: {} });
    bp.candidates++;
    this.byMode[r.mode] = (this.byMode[r.mode] ?? 0) + 1;
    if (r.decision === 'NO_TRADE') {
      const st = r.rejectionStage ?? 'STAGE3_MODEL';
      this.rejectedBy[st] = (this.rejectedBy[st] ?? 0) + 1;
      const why = `${st}: ${r.rejectionReason ?? ''}`.slice(0, 160);
      this.reasons[why] = (this.reasons[why] ?? 0) + 1;
      bp.rejected[st] = (bp.rejected[st] ?? 0) + 1;
    } else { this.traded++; bp.traded++; }
  }
  report() {
    return { health: this.health, candlesEvaluated: this.candlesEvaluated, candlesWithCandidate: this.candlesWithCandidate, candidates: this.candidates, traded: this.traded, rejectedBy: this.rejectedBy, reasons: this.reasons, fired: this.fired, funnel: this.funnel, byPattern: this.byPattern, byMode: this.byMode };
  }
}

// ------------------------------------------------------------------------------------------------ sensitivity (measurement only)
export interface SensitivityRow { pattern: string; frozen: number; looser: number; looserDescription: string }

/** How many MORE setups a looser candlestick definition would find. Never used for trading: it only shows whether the frozen thresholds are what limits the signal count. */
export function stage1Sensitivity(cs: Candle[], warmup = 120): SensitivityRow[] {
  const loose: { mom: MomentumParams; seq: SequenceParams; eq: EqualLevelParams } = {
    mom: { ...MOMENTUM_DEFAULTS, strongBodyRatio: 0.55, maxWickRatio: 0.45, minCombinedBodyMult: 2 },
    seq: { ...SEQUENCE_DEFAULTS, strongBodyRatio: 0.55 },
    eq: { ...EQUAL_LEVEL_DEFAULTS, tolMult: 0.2, minWickRatio: 0.25 },
  };
  const n = { sweepF: 0, sweepL: 0, momF: 0, momL: 0, wssF: 0, wssL: 0, eqF: 0, eqL: 0 };
  for (let i = Math.max(warmup, 25); i < cs.length; i++) {
    const P = cs[i - 1], A = cs[i];
    if (validOhlc(P) && validOhlc(A) && contiguous([P, A])) {
      for (const s of ['SELL', 'BUY'] as const) { if (isSweep(s, P, A, CONTINUATION_DEFAULTS)) n.sweepF++; if (isSweep(s, P, A, { ...CONTINUATION_DEFAULTS, requireWickOnlySweep: false })) n.sweepL++; }
    }
    if (detectMomentumSignal(cs, i, MOMENTUM_DEFAULTS)) n.momF++;
    if (detectMomentumSignal(cs, i, loose.mom)) n.momL++;
    if (classifySequence(cs, i, SEQUENCE_DEFAULTS)?.classification === 'WEAK_STRONG_STRONG') n.wssF++;
    if (classifySequence(cs, i, loose.seq)?.classification === 'WEAK_STRONG_STRONG') n.wssL++;
    for (const s of ['SELL', 'BUY'] as const) { if (checkEqualLevelSweep(new Tracer(false), s, cs, i, EQUAL_LEVEL_DEFAULTS)) n.eqF++; if (checkEqualLevelSweep(new Tracer(false), s, cs, i, loose.eq)) n.eqL++; }
  }
  return [
    { pattern: 'BEARISH/BULLISH_SWEEP', frozen: n.sweepF, looser: n.sweepL, looserDescription: 'literal Pattern 1/2 text (open may be beyond the swept level)' },
    { pattern: 'MOMENTUM_BODY_DOMINANCE', frozen: n.momF, looser: n.momL, looserDescription: 'strong body ratio 0.55, wick ratio 0.45, combined body 2.0x median' },
    { pattern: 'WEAK_STRONG_STRONG', frozen: n.wssF, looser: n.wssL, looserDescription: 'strong body ratio 0.55' },
    { pattern: 'EQ_UPPER/LOWER_WICK_SWEEP', frozen: n.eqF, looser: n.eqL, looserDescription: 'tolerance 0.2 x median range, rejection wick 0.25' },
  ];
}

// ------------------------------------------------------------------------------------------------ independent detector cross-check
/** Re-implements Pattern 1/2 and the equal-level sweeps with plain loops (no Tracer, no shared helpers) and compares every candle with the engine's answer. Mismatches point at a detection bug. */
export function crossCheckDetectors(cs: Candle[], hitsAt: (i: number) => Set<string>, from = 120): { checked: number; mismatches: string[] } {
  const mism: string[] = [];
  let checked = 0;
  for (let i = from; i < cs.length; i++) {
    const P = cs[i - 1], A = cs[i];
    if (!(contiguous(cs.slice(i - 12, i + 1)) && cs.slice(i - 12, i + 1).every((c) => validOhlc(c) && c.closed !== false))) continue;
    checked++;
    const bodyLo = Math.min(P.open, P.close), bodyHi = Math.max(P.open, P.close);
    const bearish = P.close > P.open && A.close < A.open && A.high > P.high && A.close >= bodyLo && A.close <= bodyHi && A.open <= P.high;
    const bullish = P.close < P.open && A.close > A.open && A.low < P.low && A.close >= bodyLo && A.close <= bodyHi && A.open >= P.low;
    const h = hitsAt(i);
    if (bearish !== h.has('BEARISH_SWEEP')) mism.push(`#${i} BEARISH_SWEEP brute=${bearish} engine=${h.has('BEARISH_SWEEP')}`);
    if (bullish !== h.has('BULLISH_SWEEP')) mism.push(`#${i} BULLISH_SWEEP brute=${bullish} engine=${h.has('BULLISH_SWEEP')}`);
    const p = EQUAL_LEVEL_DEFAULTS;
    const zone = cs.slice(i - p.lookback, i);
    const tol = p.tolMult * median(cs.slice(i - p.tolRangeWindow, i).map((c) => c.high - c.low));
    const H = Math.max(...zone.map((c) => c.high)), L = Math.min(...zone.map((c) => c.low));
    const rng = A.high - A.low;
    const eqUp = zone.filter((c) => c.high >= H - tol).length >= p.touches && A.close < A.open && A.high > H && A.close < H && A.open <= H && rng > 0 && (A.high - Math.max(A.open, A.close)) / rng >= p.minWickRatio;
    const eqLo = zone.filter((c) => c.low <= L + tol).length >= p.touches && A.close > A.open && A.low < L && A.close > L && A.open >= L && rng > 0 && (Math.min(A.open, A.close) - A.low) / rng >= p.minWickRatio;
    if (eqUp !== h.has('EQ_UPPER_WICK_SWEEP')) mism.push(`#${i} EQ_UPPER_WICK_SWEEP brute=${eqUp} engine=${h.has('EQ_UPPER_WICK_SWEEP')}`);
    if (eqLo !== h.has('EQ_LOWER_WICK_SWEEP')) mism.push(`#${i} EQ_LOWER_WICK_SWEEP brute=${eqLo} engine=${h.has('EQ_LOWER_WICK_SWEEP')}`);
  }
  return { checked, mismatches: mism.slice(0, 50) };
}

// ------------------------------------------------------------------------------------------------ attribution
export type Verdict = 'LIKELY' | 'UNLIKELY' | 'NOT_MEASURED';
export interface Finding { cause: string; verdict: Verdict; evidence: string }
export interface Attribution {
  summary: string;
  findings: Finding[];
  perThousandCandles: Record<string, number>;
}

export function attribute(rep: ReturnType<Diagnostics['report']>, sens: SensitivityRow[] | null, cross: { checked: number; mismatches: string[] } | null): Attribution {
  const h = rep.health;
  const seen = Math.max(1, h.candlesSeen);
  const pct = (x: number, d = seen) => `${((100 * x) / d).toFixed(2)}%`;
  const f: Finding[] = [];
  const evalN = Math.max(1, rep.candlesEvaluated);
  const rejected = Object.values(rep.rejectedBy).reduce((s, x) => s + (x ?? 0), 0);
  const post = (rep.rejectedBy.STAGE2_INDICATORS ?? 0) + (rep.rejectedBy.STAGE3_MODEL ?? 0);

  // 1. thresholds
  const looseGain = sens ? sens.map((s) => `${s.pattern}: ${s.frozen} -> ${s.looser} (${s.looserDescription})`).join('; ') : '';
  const postShare = rep.candidates ? post / rep.candidates : 0;
  const stage1Binding = sens ? sens.some((s) => s.looser >= 3 * Math.max(1, s.frozen)) : false;
  f.push({
    cause: 'Overly restrictive thresholds',
    verdict: rep.candidates === 0 ? (stage1Binding ? 'LIKELY' : 'UNLIKELY') : postShare >= 0.6 || stage1Binding ? 'LIKELY' : 'UNLIKELY',
    evidence: `${rep.candidates} candidate setups; ${post} (${(postShare * 100).toFixed(1)}%) rejected after Stage 1 by indicators or the model. ` +
      (sens ? `Counts with looser candlestick definitions (measurement only, never traded): ${looseGain}.` : 'Looser-threshold counts not measured.') +
      ' Candlestick thresholds are frozen; only Stage 2 and Stage 3 settings can be changed, and only through a logged configuration change.',
  });
  // 2. detection
  f.push(cross
    ? { cause: 'Incorrect candle detection', verdict: cross.mismatches.length ? 'LIKELY' : 'UNLIKELY', evidence: `independent re-implementation of the sweep and equal-level rules compared on ${cross.checked} candles: ${cross.mismatches.length} mismatches${cross.mismatches.length ? ` (${cross.mismatches.slice(0, 3).join('; ')})` : ''}` }
    : { cause: 'Incorrect candle detection', verdict: 'NOT_MEASURED', evidence: 'cross-check not run' });
  // 3. timeframe sync
  const tfBad = h.observedTfSec !== null && h.observedTfSec !== h.expectedTfSec;
  f.push({
    cause: 'Timeframe synchronisation',
    verdict: tfBad || h.misalignedTimestamps / seen > 0.01 || h.wrongSpacing / seen > 0.005 ? 'LIKELY' : 'UNLIKELY',
    evidence: `observed spacing ${h.observedTfSec ?? 'n/a'} s vs expected ${h.expectedTfSec} s; ${h.misalignedTimestamps} candles (${pct(h.misalignedTimestamps)}) not on a ${h.expectedTfSec} s boundary; ${h.wrongSpacing} irregular spacings`,
  });
  // 4. missing candles
  f.push({
    cause: 'Missing historical candles',
    verdict: h.missingCandles / seen > 0.005 || h.warmupCandles / seen > 0.25 ? 'LIKELY' : 'UNLIKELY',
    evidence: `${h.gapEvents} gaps, ${h.missingCandles} candles missing (${pct(h.missingCandles)}), ${h.resets} state resets, ${h.warmupCandles} accepted candles (${pct(h.warmupCandles)}) spent re-warming after the start or a reset`,
  });
  // 5. OHLC
  f.push({
    cause: 'Incorrect OHLC data',
    verdict: h.invalidOhlc / seen > 0.001 || h.flatCandles / seen > 0.01 || h.duplicates / seen > 0.001 || h.outOfOrder / seen > 0.001 ? 'LIKELY' : 'UNLIKELY',
    evidence: `${h.invalidOhlc} invalid OHLC (${pct(h.invalidOhlc)}), ${h.flatCandles} flat filler candles (${pct(h.flatCandles)}), ${h.duplicates} duplicates, ${h.outOfOrder} out of order, ${h.unfinished} unfinished`,
  });
  // 6. absence
  const dataOk = f.filter((x) => ['Timeframe synchronisation', 'Missing historical candles', 'Incorrect OHLC data', 'Incorrect candle detection'].includes(x.cause)).every((x) => x.verdict !== 'LIKELY');
  const per1000: Record<string, number> = {};
  for (const [k, v] of Object.entries(rep.fired)) per1000[k] = +(((v ?? 0) * 1000) / evalN).toFixed(2);
  const anyHits = rep.candidates > 0;
  f.push({
    cause: 'Actual absence of qualifying opportunities',
    verdict: dataOk && !stage1Binding && postShare < 0.6 && (1000 * rep.candidates) / evalN < 20 ? 'LIKELY' : 'UNLIKELY',
    evidence: `${rep.candidates} Stage 1 candidates in ${rep.candlesEvaluated} evaluated candles (${((1000 * rep.candidates) / evalN).toFixed(1)} per 1000). Data checks ${dataOk ? 'found nothing wrong' : 'found problems (see above)'}. ${anyHits ? ((1000 * rep.candidates) / evalN < 20 ? 'Setups are rare on this data.' : 'Setups are plentiful, so a low trade count would come from the later stages or from the data checks above, not from a shortage of setups.') : 'No pattern fired at all.'}`,
  });
  const likely = f.filter((x) => x.verdict === 'LIKELY').map((x) => x.cause);
  const summary = likely.length ? `Most likely contributors to the signal count: ${likely.join('; ')}.` : `No data or threshold problem was measured; the signal count looks like what these rules produce on this data (${((1000 * rep.traded) / evalN).toFixed(1)} trades per 1000 candles; ${rejected} candidate rejections).`;
  return { summary, findings: f, perThousandCandles: per1000 };
}

export function renderDiagnostics(rep: ReturnType<Diagnostics['report']>, att: Attribution, sens: SensitivityRow[] | null): string {
  const L: string[] = [];
  const h = rep.health;
  L.push('HYBRID ENGINE: REJECTION DIAGNOSTICS', '',
    `Data health: ${h.candlesSeen} candles seen, ${h.accepted} accepted | invalid OHLC ${h.invalidOhlc}, unfinished ${h.unfinished}, duplicates ${h.duplicates}, out of order ${h.outOfOrder}, flat ${h.flatCandles} | gaps ${h.gapEvents} (${h.missingCandles} missing candles), resets ${h.resets} | misaligned ${h.misalignedTimestamps}, irregular spacing ${h.wrongSpacing} | spacing ${h.observedTfSec ?? 'n/a'} s (expected ${h.expectedTfSec} s)`,
    `Funnel: ${rep.candlesEvaluated} candles evaluated -> ${rep.candlesWithCandidate} with a Stage 1 setup -> ${rep.candidates} candidate (candle, side) observations -> ${rep.traded} traded`,
    `Rejections by stage: ${Object.entries(rep.rejectedBy).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`, '', 'Top rejection reasons:');
  for (const [k, v] of Object.entries(rep.reasons).sort((a, b) => b[1] - a[1]).slice(0, 12)) L.push(`  ${String(v).padStart(7)}  ${k}`);
  L.push('', 'Pattern funnel (first check each candle failed; FIRED = pattern found):');
  for (const [p, m] of Object.entries(rep.funnel)) {
    L.push(`  ${p}`);
    for (const [k, v] of Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8)) L.push(`    ${String(v).padStart(7)}  ${k}`);
  }
  L.push('', 'By primary pattern:', '  pattern                    candidates  traded  rejected');
  for (const [p, v] of Object.entries(rep.byPattern)) L.push(`  ${p.padEnd(26)} ${String(v.candidates).padStart(10)} ${String(v.traded).padStart(7)}  ${Object.entries(v.rejected).map(([k, n]) => `${k}:${n}`).join(' ')}`);
  if (sens) { L.push('', 'Stage 1 sensitivity (measurement only, frozen rules are what trades):'); for (const s of sens) L.push(`  ${s.pattern.padEnd(28)} frozen ${String(s.frozen).padStart(6)}  looser ${String(s.looser).padStart(6)}  (${s.looserDescription})`); }
  L.push('', 'ATTRIBUTION OF THE SIGNAL COUNT', att.summary);
  for (const x of att.findings) L.push(`  [${x.verdict.padEnd(12)}] ${x.cause}: ${x.evidence}`);
  return L.join('\n');
}
