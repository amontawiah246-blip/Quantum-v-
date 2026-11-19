// THE HYBRID ENGINE: four stages, fed one CLOSED candle at a time (per instrument).
//
//   Stage 1  Is there a legitimate candlestick setup?    The original engines, frozen thresholds (src/hybridSetups.ts). Only this stage creates a setup.
//   Stage 2  How good is the evidence around it?         ADX / ATR / EMA evidence (src/hybridFeatures.ts). Each indicator can be switched off.
//                                                        A single disagreeing indicator never removes a valid setup; the gate is configurable and logged.
//   Stage 3  What is the probability that the 5-minute trade wins?   Calibrated model trained in Python (ml/train.py), evaluated here.
//   Stage 4  BUY, SELL or NO_TRADE.                      Needs Stage 1, the Stage 2 gate (modes B, D), and probability >= max(validated threshold, break-even + margin) (modes C, D).
//
// Modes (so the four variants can be compared on identical setups): A candlestick only | B + indicator gate | C + model (no indicator inputs) |
// D full hybrid | AUTO = D when a usable model is loaded, otherwise B (the chosen mode and the reason are always reported).
//
// Rules that do not bend: the chart is 5 minutes and so is the expiry (construction fails otherwise); a signal exists only after its candle
// closed (the earliest order time is the candle's close); an indicator or a model can never invent a setup; with no usable model there is
// no probability (null), never a made-up one; every candidate gets a DecisionRecord with the reason for its fate.
import { Candle } from './candleMath';
import { HYBRID_DEFAULTS, HybridConfig, breakevenProbability, diffFromDefaults } from './hybridConfig';
import { Diagnostics, DecisionRecord, RejectionStage } from './hybridDiagnostics';
import { PerformanceTracker, buildFeatures, evaluateEvidence, instrumentFeatures } from './hybridFeatures';
import { IndicatorTracker } from './hybridIndicators';
import { HybridModel, ModelKind } from './hybridModel';
import { Side, detectStage1, groupBySide } from './hybridSetups';
import { Decision, QuantumPipeline, quantumParams } from './quantumPipeline';
import './equalLevelSweeps';

export type EffectiveMode = 'A' | 'B' | 'C' | 'D';
export interface HybridDecision {
  index: number; time: number; closeTime: number | null; symbol: string;
  action: Side | 'NO_TRADE';
  stage: 'DATA' | 'TIMEFRAME' | 'WARMUP' | 'NO_SETUP' | 'REJECTED' | 'TRADE';
  mode: EffectiveMode | null; modeNote: string | null;
  reason: string;
  probability: number | null;
  expirySec: number;
  /** earliest moment the order may be sent: the close of the signal candle */
  executeAfter: number | null;
  records: DecisionRecord[];
}

const REJECT = /^(DATA_INVALID|CANDLE_NOT_CLOSED|DUPLICATE_CANDLE)/;

export class HybridEngine {
  readonly cfg: HybridConfig;
  readonly diag: Diagnostics;
  readonly log: DecisionRecord[] = [];
  readonly configChanges: string[];
  private pipe: QuantumPipeline;
  private cs: Candle[] = [];
  private ind!: IndicatorTracker;
  private perf: PerformanceTracker;
  private runStart = -1;
  private n = 0;
  private lastAccepted: Candle | null = null;
  private pending: Array<{ side: Side; key: string }> = [];
  private openUntil = -Infinity;

  constructor(readonly symbol: string, cfg: HybridConfig = HYBRID_DEFAULTS, readonly model: HybridModel | null = null) {
    if (cfg.tfSec !== 300 || cfg.expirySec !== 300) throw new Error(`the hybrid engine is locked to a 5-minute chart and a 5-minute expiry (got tf ${cfg.tfSec}s, expiry ${cfg.expirySec}s)`);
    this.cfg = cfg;
    this.configChanges = diffFromDefaults(cfg);
    this.diag = new Diagnostics(cfg.tfSec);
    this.perf = new PerformanceTracker(cfg.performance.window, cfg.performance.lagSec, cfg.performance.priorWeight);
    this.pipe = new QuantumPipeline(quantumParams({ sweep: { sources: ['pattern12', 'equal_wick'] }, minHistory: 30, ...(cfg.pipeline as any) }));
    this.resetRun();
  }

  private resetRun() {
    this.cs = [];
    this.ind = new IndicatorTracker({ adx: this.cfg.indicators.adx, atr: this.cfg.indicators.atr, ema: this.cfg.indicators.ema });
    this.pending = [];
  }

  /** Mode used for the current decision, and why. AUTO never degrades silently: the note says which and why. */
  resolveMode(): { mode: EffectiveMode; note: string | null } {
    const m = this.cfg.mode;
    if (m !== 'AUTO') return { mode: m, note: null };
    if (!this.model) return { mode: 'B', note: 'AUTO: no trained model file, running B (candlestick + indicator evidence, no probability)' };
    const p = this.model.problems('D', this.cfg, this.symbol);
    return p.length ? { mode: 'B', note: `AUTO: model not usable (${p.join('; ')}), running B` } : { mode: 'D', note: null };
  }

  private noTrade(g: number, c: Candle, stage: HybridDecision['stage'], reason: string, mode: { mode: EffectiveMode | null; note: string | null } = { mode: null, note: null }): HybridDecision {
    return { index: g, time: c?.time ?? 0, closeTime: c ? c.time + this.cfg.tfSec : null, symbol: this.symbol, action: 'NO_TRADE', stage, mode: mode.mode, modeNote: mode.note, reason, probability: null, expirySec: this.cfg.expirySec, executeAfter: null, records: [] };
  }

  /** Feed the next candle. Returns the decision for the candle that has just closed. */
  step(c: Candle): HybridDecision {
    const g = this.n++;
    const H = this.diag.health;
    const tf = this.cfg.tfSec;
    H.candlesSeen++;
    if (c && Number.isFinite(c.time) && c.time % tf !== 0) H.misalignedTimestamps++;
    if (c && c.open === c.high && c.high === c.low && c.low === c.close) H.flatCandles++;

    const d = this.pipe.step(c);                          // validates the candle and resets its own state on a gap
    const bad = REJECT.exec(d.reason);
    if (bad) {
      if (bad[1] === 'DATA_INVALID') { H.invalidOhlc++; H.resets++; this.resetRun(); this.runStart = -1; this.lastAccepted = null; }
      else if (bad[1] === 'CANDLE_NOT_CLOSED') H.unfinished++;
      else H.duplicates++;
      return this.noTrade(g, c, 'DATA', d.reason);
    }
    // accepted candle
    H.accepted++;
    const gap = /^DATA_GAP: (\d+)/.exec(d.reason);
    if (gap) { H.gapEvents++; H.missingCandles += Number(gap[1]); }
    if (/^OUT_OF_ORDER/.test(d.reason)) H.outOfOrder++;
    if (this.lastAccepted) {
      const dt = c.time - this.lastAccepted.time;
      if (H.observedTfSec === null && dt > 0) H.observedTfSec = dt;
      if (dt > 0 && dt % tf !== 0) H.wrongSpacing++;
    }
    this.lastAccepted = c;
    if (d.runStart !== this.runStart) { if (this.runStart !== -1) H.resets++; this.resetRun(); this.runStart = d.runStart; }

    this.cs.push(c);
    if (this.cs.length > 600) this.cs = this.cs.slice(-300);
    const i = this.cs.length - 1;
    const snap = this.ind.update(c);
    // outcomes of the setups seen on the previous candle (entry = this open, settle = this close): they become usable for the performance features after the lag
    for (const p of this.pending) {
      const win = p.side === 'BUY' ? (c.close > c.open ? true : c.close < c.open ? false : null) : (c.close < c.open ? true : c.close > c.open ? false : null);
      this.perf.record(p.key, c.time + tf, win);
    }
    this.pending = [];

    if (H.observedTfSec !== null && H.observedTfSec !== tf) return this.noTrade(g, c, 'TIMEFRAME', `TIMEFRAME_MISMATCH: candles are ${H.observedTfSec} s apart, the engine is locked to ${tf} s`);
    if (this.cs.length < this.cfg.warmupCandles) { H.warmupCandles++; return this.noTrade(g, c, 'WARMUP', `WARMUP: ${this.cs.length} of ${this.cfg.warmupCandles} candles`); }

    this.diag.candlesEvaluated++;
    const closeTime = c.time + tf;
    const s1 = detectStage1(this.cs, i, d.sweep, this.cfg.log.collectFunnel);
    if (this.cfg.log.collectFunnel) this.diag.addFunnel(s1.funnel);
    const cands = groupBySide(s1.hits);
    const md = this.resolveMode();
    if (!cands.length) return this.noTrade(g, c, 'NO_SETUP', 'no candlestick setup', md);
    this.diag.candlesWithCandidate++;

    const records: DecisionRecord[] = [];
    for (const cand of cands) {
      const f = buildFeatures({ cs: this.cs, i, cand, hits: s1.hits, d, ind: snap, perf: this.perf.stats(cand.primary, closeTime), execTime: closeTime });
      const ev = evaluateEvidence(f, cand.family, this.cfg);
      const gating = md.mode === 'B' || md.mode === 'D';
      const kind: ModelKind | null = md.mode === 'C' ? 'C' : md.mode === 'D' ? 'D' : null;
      const be = breakevenProbability(this.cfg.ml.payout);
      const rec: DecisionRecord = {
        symbol: this.symbol, time: c.time, closeTime, side: cand.side, patterns: cand.patterns, primary: cand.primary, family: cand.family,
        stage1: { valid: true, notes: cand.notes }, stage2: { gating, evidence: ev },
        stage3: { model: kind, rawProbability: null, probability: null, threshold: null, breakeven: be, required: null, pass: null, problems: [] },
        mode: md.mode, decision: cand.side, rejectionStage: null, rejectionReason: null,
        ...(this.cfg.log.keepFeatures ? { features: f } : {}),
      };
      const reject = (stage: RejectionStage, why: string) => { rec.decision = 'NO_TRADE'; rec.rejectionStage = stage; rec.rejectionReason = why; };
      if (gating && !ev.gatePass) reject('STAGE2_INDICATORS', ev.veto ?? 'indicator gate');
      if (kind) {
        const problems = this.model ? this.model.problems(kind, this.cfg, this.symbol) : ['no trained model file loaded'];
        rec.stage3.problems = problems;
        if (problems.length) { if (!rec.rejectionStage) reject('MODEL_UNAVAILABLE', problems.join('; ')); }
        else {
          const spec = this.model!.spec(kind)!;
          const sc = this.model!.score(kind, { ...f, ...instrumentFeatures(this.symbol, spec.featureNames) })!;
          const threshold = this.cfg.ml.minProbability ?? spec.threshold;
          rec.stage3.rawProbability = sc.raw; rec.stage3.probability = sc.probability; rec.stage3.threshold = threshold;
          if (threshold === null) { rec.stage3.pass = false; if (!rec.rejectionStage) reject('STAGE3_MODEL', `the model found no probability threshold with positive validation expectancy (${spec.thresholdNote})`); }
          else {
            const required = Math.max(threshold, be + this.cfg.ml.marginOverBreakeven);
            rec.stage3.required = required; rec.stage3.pass = sc.probability >= required;
            if (!rec.stage3.pass && !rec.rejectionStage) reject('STAGE3_MODEL', `probability ${sc.probability.toFixed(4)} < required ${required.toFixed(4)} (validated threshold ${threshold.toFixed(4)}, break-even ${be.toFixed(4)})`);
          }
        }
      }
      records.push(rec);
      this.pending.push({ side: cand.side, key: cand.primary });
    }

    // ---- Stage 4: conflicts, open trade, final choice
    const live = records.filter((r) => r.decision !== 'NO_TRADE');
    let winner: DecisionRecord | null = null;
    if (live.length === 1) winner = live[0];
    else if (live.length === 2) {
      const [a, b] = live;
      const pa = a.stage3.probability, pb = b.stage3.probability;
      const qa = a.stage2.evidence.qualityScore, qb = b.stage2.evidence.qualityScore;
      let how = '';
      if (pa !== null && pb !== null) { if (Math.abs(pa - pb) >= this.cfg.ml.conflictMargin) { winner = pa > pb ? a : b; how = `probability ${Math.max(pa, pb).toFixed(4)} vs ${Math.min(pa, pb).toFixed(4)}`; } }
      else if (md.mode === 'B' && qa !== null && qb !== null && Math.abs(qa - qb) >= this.cfg.gate.conflictQualityMargin) { winner = qa > qb ? a : b; how = `indicator evidence ${Math.max(qa, qb).toFixed(2)} vs ${Math.min(qa, qb).toFixed(2)}`; }
      const loser = winner === a ? b : a;
      if (winner) { loser.decision = 'NO_TRADE'; loser.rejectionStage = 'CONFLICT'; loser.rejectionReason = `the opposite setup on the same candle ranks higher (${how})`; }
      else for (const r of live) { r.decision = 'NO_TRADE'; r.rejectionStage = 'CONFLICT'; r.rejectionReason = pa === null && md.mode !== 'B' ? 'BUY and SELL setups on the same candle and nothing to rank them (mode A has no quality measure)' : 'BUY and SELL setups on the same candle are too close to rank'; }
    }
    if (winner && closeTime < this.openUntil) { winner.decision = 'NO_TRADE'; winner.rejectionStage = 'TRADE_OPEN'; winner.rejectionReason = `a previous trade is still open until ${this.openUntil}`; winner = null; }
    if (winner) this.openUntil = closeTime + this.cfg.expirySec;
    for (const r of records) { this.diag.addRecord(r); if (this.log.length < this.cfg.log.maxRecords) this.log.push(r); }

    const probability = winner?.stage3.probability ?? null;
    const reason = winner
      ? `${winner.side} ${winner.patterns.join('+')}: stage 1 valid; ${md.mode === 'B' || md.mode === 'D' ? `indicators ${winner.stage2.evidence.qualityScore === null ? 'n/a' : `score ${winner.stage2.evidence.qualityScore.toFixed(2)}`}; ` : ''}${probability !== null ? `P(win) ${probability.toFixed(4)} >= ${winner.stage3.required!.toFixed(4)}` : 'no probability in this mode'}`
      : records.map((r) => `${r.side} ${r.primary}: ${r.rejectionStage} ${r.rejectionReason}`).join(' | ');
    return {
      index: g, time: c.time, closeTime, symbol: this.symbol, action: winner ? winner.side : 'NO_TRADE', stage: winner ? 'TRADE' : 'REJECTED', mode: md.mode, modeNote: md.note,
      reason, probability, expirySec: this.cfg.expirySec, executeAfter: winner ? closeTime : null, records,
    };
  }
}

/** Replays `candles` (closed, oldest first) and returns every decision. */
export function runHybrid(candles: Candle[], symbol: string, cfg: HybridConfig = HYBRID_DEFAULTS, model: HybridModel | null = null): { decisions: HybridDecision[]; engine: HybridEngine } {
  const engine = new HybridEngine(symbol, cfg, model);
  return { decisions: candles.map((c) => engine.step(c)), engine };
}

// ------------------------------------------------------------------------------------------------ view for the API / UI
export interface HybridView {
  action: Side | 'NO_TRADE'; mode: EffectiveMode | null; modeNote: string | null; stage: HybridDecision['stage']; reason: string;
  probability: number | null; patterns: string[]; indicators: { adx: string; atr: string; ema: string; score: number | null } | null;
  rejection: { stage: string | null; reason: string | null } | null;
  /** what the hybrid layer decided for EACH side of the newest candle (used by the AutoTrading gate: it must judge the engine's own side, not the other one) */
  bySide: Partial<Record<Side, { decision: Side | 'NO_TRADE'; rejectionStage: string | null; rejectionReason: string | null; probability: number | null; qualityScore: number | null; patterns: string[] }>>;
  expirySec: number; signalCandleTime: number | null; executeAfter: number | null;
  model: { id: string; synthetic: boolean; source: string } | null;
  note: string;
}
export const HYBRID_NOTE = 'AutoTrading reads this only through src/hybridGate.ts (default: veto-only, it can never create or loosen a trade). A probability exists only when a trained, validated model is loaded; nothing here says any setup is profitable.';

export function viewOf(d: HybridDecision | null, model: HybridModel | null): HybridView {
  const best = d?.records.find((r) => r.decision !== 'NO_TRADE') ?? d?.records[0] ?? null;
  return {
    action: d?.action ?? 'NO_TRADE', mode: d?.mode ?? null, modeNote: d?.modeNote ?? null, stage: d?.stage ?? 'DATA', reason: d?.reason ?? 'no candles', probability: d?.probability ?? null,
    patterns: best?.patterns ?? [],
    indicators: best ? { adx: best.stage2.evidence.adx, atr: best.stage2.evidence.atr, ema: best.stage2.evidence.ema, score: best.stage2.evidence.qualityScore } : null,
    rejection: best && best.decision === 'NO_TRADE' ? { stage: best.rejectionStage, reason: best.rejectionReason } : null,
    bySide: Object.fromEntries((d?.records ?? []).map((r) => [r.side, { decision: r.decision, rejectionStage: r.rejectionStage, rejectionReason: r.rejectionReason, probability: r.stage3.probability, qualityScore: r.stage2.evidence.qualityScore, patterns: r.patterns as string[] }])),
    expirySec: d?.expirySec ?? 300, signalCandleTime: d && d.action !== 'NO_TRADE' ? d.time : null, executeAfter: d?.executeAfter ?? null,
    model: model ? { id: model.bundle.modelId, synthetic: model.bundle.synthetic, source: model.source } : null, note: HYBRID_NOTE,
  };
}
