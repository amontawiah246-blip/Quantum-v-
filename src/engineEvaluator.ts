import { detectContinuation, detectLscc, detectMomentum, detectStochRsi, detectStructureSweep, detectWickSweep, StochRsiMeta } from './sweepEngines';
import { detectCandlestick } from './candlePatterns';
import { STOCH_RSI_DEFAULTS, computeStochRsi } from './stochRsi';
import { candlePatternsTradeAlone } from './strategyMode';
import { getGlobalTiming } from './globalConfig';
import { QuantumPipeline, QUANTUM_DEFAULTS } from './quantumPipeline';
import { resolveExpiry } from './executionConfig';
import { HybridEngine, HybridView, viewOf } from './hybridEngine';
import { hybridConfig } from './hybridConfig';
import { HybridModel, loadModel } from './hybridModel';

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface EngineResultData {
  status: string;
  state: string;
  setup: boolean;
  side: 'BUY' | 'SELL' | null;
  confidence: number;
  agree: number;
  candles: number;
  sweep: { side: 'BUY' | 'SELL'; reasons: string[] } | null;
  indicators: { side: 'BUY' | 'SELL'; strategies: string[]; count: number; info: Record<string, number> } | null;
  pattern: { side: 'BUY' | 'SELL'; patterns: string[]; counted: boolean } | null;
  continuation?: { side: 'BUY' | 'SELL'; reasons: string[] } | null;   // sweep + 2 same-colour candles: trade the next open
  momentum?: { side: 'BUY' | 'SELL'; reasons: string[] } | null;       // 3 strong candles in a row: trade the next open
  lscc?: { side: 'BUY' | 'SELL'; reasons: string[] } | null;           // liquidity sweep + a separate confirmation candle: trade the next open
  structureSweep?: { side: 'BUY' | 'SELL'; reasons: string[]; biasDirection?: string; eventType?: string; breakLevel?: number } | null;
  /** THE INDICATOR STRATEGY: Stochastic + RSI trigger confirmed by a candle pattern (src/stochRsi.ts, detectStochRsi). This is what creates a setup. */
  stochRsi?: { side: 'BUY' | 'SELL'; reasons: string[]; meta: StochRsiMeta } | null;
  reasons: string[];
  /** Engines 7-12 (structure, repeated sweeps, confirmation). Additive: it never changes `setup`, `side`, `confidence` or the votes above. */
  intelligence?: IntelligenceView;
  /** Hybrid price-action layer (candlestick setup + ADX/ATR/EMA evidence + calibrated probability). Never changes `setup`, `side`, `confidence` or the votes. AutoTrading consumes it only through src/hybridGate.ts (veto-only by default). */
  hybrid?: HybridView;
  rsi?: number;
  trend?: string;
}

export interface IntelligenceView {
  action: 'BUY' | 'SELL' | 'NO_TRADE';
  kind: string | null;
  state: string;
  reason: string;
  trend: string;
  sweepCount: number;
  recentSweeps: number;
  exhaustion: string | null;
  sequence: string | null;
  /** seconds the trade must run: always 300 on a 5-minute chart, chosen from the market condition on other timeframes */
  expirySec: number;
  signalCandleTime: number | null;
  /** earliest moment the order may be sent: the close of the signal candle */
  executeAfter: number | null;
  explanation: unknown;
}

/** Runs the Engines 7-12 pipeline over the closed candles and reports the decision for the newest one. */
export function evaluateIntelligence(candles: CandleData[], tf: number = getGlobalTiming().tfSec): IntelligenceView {
  const pipe = new QuantumPipeline(QUANTUM_DEFAULTS);
  let d = null as ReturnType<QuantumPipeline['step']> | null;
  for (const c of candles.slice(-300)) d = pipe.step({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
  const ex = d?.exhaustion?.state ?? null;
  const exp = resolveExpiry(tf, ex);
  return {
    action: d?.action ?? 'NO_TRADE', kind: d?.kind ?? null, state: d?.state ?? 'NORMAL', reason: d?.reason ?? 'no candles', trend: d?.trend ?? 'NEUTRAL',
    sweepCount: d?.sweepCount ?? 0, recentSweeps: d?.recentSweeps ?? 0, exhaustion: ex, sequence: d?.sequence?.classification ?? null,
    expirySec: exp.expirySec, signalCandleTime: d?.action && d.action !== 'NO_TRADE' ? d.time : null, executeAfter: d?.action && d.action !== 'NO_TRADE' ? d.time + tf : null,
    explanation: d?.explanation ?? null,
  };
}

let cachedModel: { path: string; model: HybridModel | null } | null = null;
function hybridModel(): HybridModel | null {
  const path = process.env.HYBRID_MODEL_PATH || 'models/hybrid_model.json';
  if (!cachedModel || cachedModel.path !== path) { let m: HybridModel | null = null; try { m = loadModel(path); } catch { m = null; } cachedModel = { path, model: m }; }
  return cachedModel.model;
}

/** Hybrid verdict for the newest CLOSED candle. 5-minute charts only (the layer is locked to 5-minute candles and a 5-minute expiry). */
export function evaluateHybrid(candles: CandleData[], tf = 300, symbol = 'LIVE'): HybridView {
  const model = hybridModel();
  if (tf !== 300) return { ...viewOf(null, model), reason: `chart timeframe is ${tf}s: the hybrid layer only runs on 5-minute candles`, stage: 'TIMEFRAME' };
  const allow = process.env.HYBRID_ALLOW_SYNTHETIC_MODEL === '1';
  const eng = new HybridEngine(symbol, hybridConfig({ mode: (process.env.HYBRID_MODE as any) || 'AUTO', ml: { allowSyntheticModel: allow } as any, log: { maxRecords: 50, collectFunnel: false } as any }), model);
  let d = null as ReturnType<HybridEngine['step']> | null;
  for (const c of candles.slice(-300)) d = eng.step({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
  return viewOf(d, model);
}

export function evaluateEngines(candles: CandleData[], tf: number = getGlobalTiming().tfSec, minInd = 1, symbol?: string): EngineResultData {
  const result = evaluateEnginesCore(candles, tf, minInd);
  try { result.intelligence = evaluateIntelligence(candles, tf); } catch { /* the new engines must never break the existing evaluation */ }
  try { result.hybrid = evaluateHybrid(candles, tf, symbol); } catch { /* neither must the hybrid layer */ }
  return result;
}

function evaluateEnginesCore(candles: CandleData[], tf: number = getGlobalTiming().tfSec, minInd = 1): EngineResultData {
  const cs = candles.slice(-300);
  if (cs.length < 30) {
    return {
      status: 'ok',
      state: `need 30 candles, have ${cs.length}`,
      setup: false,
      side: null,
      confidence: 0,
      agree: 0,
      candles: cs.length,
      sweep: null,
      indicators: null,
      pattern: null,
      structureSweep: null,
      reasons: ['Not enough market history']
    };
  }

  const lastIdx = cs.length - 1;
  const cur = cs[lastIdx];
  const prev = cs[lastIdx - 1];

  // 1. Wick sweep: your original rule (same code the screenshots use). A sweep the context check SKIPS gets no vote.
  const ws = detectWickSweep(cs, lastIdx);
  const sweep: { side: 'BUY' | 'SELL'; reasons: string[] } | null = ws && ws.ok
    ? { side: ws.side, reasons: [ws.side === 'BUY' ? 'Green candle wicked below the previous low, body held above it' : 'Red candle wicked above the previous high, body stayed below it', ...ws.notes] }
    : null;

  // 1b. Sweep continuation (sweep + 2 same-colour candles), 1c. momentum (3 strong candles), 1d. LSCC, 1e. Structure Sweep.
  const co = detectContinuation(cs, lastIdx);
  const continuation = co && co.ok ? { side: co.side, reasons: co.notes } : null;
  const mo = detectMomentum(cs, lastIdx);
  const momentum = mo ? { side: mo.side, reasons: mo.notes } : null;
  const ls = detectLscc(cs, lastIdx);
  const lscc = ls && ls.ok ? { side: ls.side, reasons: ls.trace ?? ls.notes } : null;
  const ss = detectStructureSweep(cs, lastIdx);
  const structureSweep = ss && ss.ok
    ? {
        side: ss.side,
        reasons: ss.trace ?? ss.notes,
        biasDirection: ss.structureMeta?.biasDirection,
        eventType: ss.structureMeta?.eventType,
        breakLevel: ss.structureMeta?.breakLevel,
      }
    : null;

  // 2. THE INDICATOR STRATEGY: Stochastic (14,3,3) + RSI (14). They decide WHEN; a candle pattern in the last candles must confirm (detectStochRsi).
  const sr = detectStochRsi(cs, lastIdx);
  const series = computeStochRsi(cs, STOCH_RSI_DEFAULTS);
  const kNow = series.k[lastIdx], dNow = series.d[lastIdx], rsiNow = series.rsi[lastIdx];
  const stochRsi = sr && sr.ok && sr.stochRsi ? { side: sr.side, reasons: sr.trace ?? sr.notes, meta: sr.stochRsi } : null;
  const indicators = sr ? {
    side: sr.side,
    strategies: [`Stochastic %K cross ${sr.side === 'BUY' ? 'up' : 'down'} through ${sr.stochRsi?.stochLevel ?? (sr.side === 'BUY' ? 20 : 80)}`, `RSI cross ${sr.side === 'BUY' ? 'up' : 'down'} through ${sr.stochRsi?.rsiLevel ?? 50}`],
    count: 2,
    info: { k: Number((kNow ?? 0).toFixed(1)), d: Number((dNow ?? 0).toFixed(1)), rsi: Number((rsiNow ?? 0).toFixed(1)) },
  } : null;
  const rsi = rsiNow ?? 50;

  // market trend label for the dashboard only (context, never a strategy rule)
  let emaFast = 0, emaSlow = 0;
  for (let i = lastIdx - 12; i <= lastIdx; i++) emaFast += cs[i].close;
  for (let i = lastIdx - 26; i <= lastIdx; i++) emaSlow += cs[i].close;
  emaFast /= 13;
  emaSlow /= 27;

  // 3. Candlestick Pattern Engine (pinbar / hammer / shooting star, engulfing): unchanged rules, now in src/candlePatterns.ts
  const cp = detectCandlestick(cs, lastIdx);
  const pattern = cp ? { side: cp.side, patterns: cp.patterns, counted: true } : null;

  // Decision & Confidence logic
  // DEFAULT (confirmed mode): a setup exists ONLY when the Stochastic + RSI trigger is confirmed by a candle pattern. The candle-pattern engines above
  // are the confirmation; on their own they no longer create a trade. STRATEGY_MODE=legacy restores the old behaviour (every engine may vote on its own).
  const legacy = candlePatternsTradeAlone();
  if (!legacy) {
    const trendLabel = emaFast > emaSlow ? 'Bullish' : emaFast < emaSlow ? 'Bearish' : 'Consolidating';
    if (!stochRsi) {
      const why = sr && !sr.ok ? `Stochastic + RSI triggered ${sr.side} but ${sr.block}` : 'waiting for the Stochastic + RSI trigger';
      return {
        status: 'ok', state: sr ? 'indicator triggered, no candle confirmation' : 'no setup', setup: false, side: null, confidence: 0, agree: 0, candles: cs.length,
        sweep, indicators, pattern, continuation, momentum, lscc, structureSweep, stochRsi: null, reasons: [why], rsi: Number(rsi.toFixed(1)), trend: trendLabel,
      };
    }
    const kinds = new Set(stochRsi.meta.confirmations.map((c) => c.engine));
    // NOT a probability of winning: the indicator (1) + how many different candle-pattern strategies confirm it
    const confidence = Math.min(85, 70 + 5 * (kinds.size - 1));
    return {
      status: 'ok', state: 'setup', setup: true, side: stochRsi.side, confidence, agree: 1 + kinds.size, candles: cs.length,
      sweep, indicators, pattern, continuation, momentum, lscc, structureSweep, stochRsi,
      reasons: [`Stochastic + RSI (${stochRsi.side}): ${stochRsi.reasons.slice(0, 2).join('; ')}`, ...stochRsi.meta.confirmations.slice(0, 3).map((c) => `Candle confirmation (${stochRsi.side}): ${c.notes[0]}`)],
      rsi: Number(rsi.toFixed(1)), trend: trendLabel,
    };
  }

  const agreeSides: string[] = [];
  if (sweep) agreeSides.push(sweep.side);
  if (continuation) agreeSides.push(continuation.side);
  if (momentum) agreeSides.push(momentum.side);
  if (lscc) agreeSides.push(lscc.side);
  if (structureSweep) agreeSides.push(structureSweep.side);
  if (stochRsi) agreeSides.push(stochRsi.side);
  if (pattern) agreeSides.push(pattern.side);

  if (agreeSides.length === 0) {
    return {
      status: 'ok', state: 'no setup', setup: false, side: null, confidence: 0, agree: 0, candles: cs.length,
      sweep: null, indicators: null, pattern: null, continuation: null, momentum: null, lscc: null, structureSweep: null, stochRsi: null, reasons: ['Scanning live price action'],
    };
  }

  const buyVotes = agreeSides.filter(s => s === 'BUY').length;
  const sellVotes = agreeSides.filter(s => s === 'SELL').length;
  if (buyVotes > 0 && sellVotes > 0) {
    return {
      status: 'ok', state: 'conflicting signals', setup: false, side: null, confidence: 0, agree: 0, candles: cs.length,
      sweep, indicators, pattern, continuation, momentum, lscc, structureSweep, stochRsi,
      reasons: [`Engines disagree on direction: ${[['sweep', sweep], ['continuation', continuation], ['momentum', momentum], ['LSCC', lscc], ['structureSweep', structureSweep], ['stochRsi', stochRsi], ['pattern', pattern]].filter(([, v]: any) => v).map(([n, v]: any) => `${n} ${v.side}`).join(' vs ')}`],
    };
  }

  const side = buyVotes > 0 ? 'BUY' : 'SELL';
  const agreeCount = agreeSides.length;
  // NOT a probability of winning: only a count of agreeing engines. The measured win rate is src/liveConfidence.ts.
  let confidence = 60;
  if (agreeCount >= 3) confidence = 85;
  else if (agreeCount === 2) confidence = 75;
  else confidence = 65;

  const reasons: string[] = [];
  if (sweep) reasons.push(`Wick Sweep (${side}): ${sweep.reasons.join(', ')}`);
  if (continuation) reasons.push(`Sweep Continuation (${side}): ${continuation.reasons.join(', ')}`);
  if (momentum) reasons.push(`Momentum (${side}): ${momentum.reasons.join(', ')}`);
  if (lscc) reasons.push(`LSCC (${side}): liquidity sweep confirmed by the next candle`);
  if (structureSweep) reasons.push(`Structure Sweep (${side}): ${structureSweep.reasons.join(', ')}`);
  if (stochRsi) reasons.push(`Stochastic + RSI (${side}): ${stochRsi.reasons.slice(0, 2).join('; ')}`);
  if (pattern) reasons.push(`Pattern (${side}): ${pattern.patterns.join(', ')}`);

  const trend = emaFast > emaSlow ? 'Bullish' : emaFast < emaSlow ? 'Bearish' : 'Consolidating';

  return {
    status: 'ok',
    state: 'setup',
    setup: true,
    side,
    confidence,
    agree: agreeCount,
    candles: cs.length,
    sweep,
    indicators,
    pattern,
    continuation,
    momentum,
    lscc,
    structureSweep,
    stochRsi,
    reasons,
    rsi: Number(rsi.toFixed(1)),
    trend
  };
}
