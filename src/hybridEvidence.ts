// EVIDENCE PACKAGE (the structured, numerical part): everything the vision model and the execution log need to know about a candidate,
// computed from the same closed candles that the screenshot is drawn from. Nothing here decides anything; it is context + audit.
import type { Bar, PatternVerification } from './patternVerification';
import type { MarketQuality } from './marketQuality';
import type { HybridGateResult } from './hybridGate';
import { candleLabel, candleSetHash, sha256 } from './aiVerification';

export interface HybridEvidence {
  market: string; timeframeSec: number; proposedSide: 'BUY' | 'SELL'; expirySec: number;
  signalCandle: { time: number; iso: string; open: number; high: number; low: number; close: number; bodyToRange: number | null };
  previousCandle: { time: number; iso: string; open: number; high: number; low: number; close: number; bodyToRange: number | null } | null;
  /** measurement against the previous candle's extreme (BUY: prev.low - signal.low, SELL: signal.high - prev.high). Positive = the wick went through. Context only. */
  wickPenetration: { price: number; fractionOfSignalRange: number | null } | null;
  sweptLevel: number | null;
  patternIds: string[];
  claimedEngines: string[];
  sweepCountLast12: number;
  marketStructure: { regime: string; trendAlignment: string; countertrendRisk: boolean };
  hybrid: { mode: string; hybridMode: string | null; status: string; allow: boolean; reason: string; patterns: string[]; probability: number | null; indicatorScore: number | null; note: string | null };
  dataFreshness: { signalAgeSec: number; maxAgeSec: number; candleSetHash: string; lastCandleLabel: string };
}

const r = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;
const bodyRange = (c: Bar) => (c.high > c.low ? r(Math.abs(c.close - c.open) / (c.high - c.low), 4) : null);

export function buildHybridEvidence(i: {
  label: string; tf: number; side: 'BUY' | 'SELL'; closed: Bar[]; pattern: PatternVerification; quality: MarketQuality; gate: HybridGateResult;
  ageSec: number; maxAgeSec: number; expirySec?: number;
}): HybridEvidence | null {
  const rows = i.closed.slice(-60), sig = rows[rows.length - 1], prev = rows[rows.length - 2];
  if (!sig) return null;
  const pen = prev ? (i.side === 'BUY' ? prev.low - sig.low : sig.high - prev.high) : null;
  const range = sig.high - sig.low;
  const snap = (c: Bar) => ({ time: c.time, iso: new Date(c.time * 1000).toISOString(), open: c.open, high: c.high, low: c.low, close: c.close, bodyToRange: bodyRange(c) });
  return {
    market: i.label, timeframeSec: i.tf, proposedSide: i.side, expirySec: i.expirySec ?? 300,
    signalCandle: snap(sig), previousCandle: prev ? snap(prev) : null,
    wickPenetration: pen == null ? null : { price: r(pen), fractionOfSignalRange: range > 0 ? r(pen / range, 4) : null },
    sweptLevel: i.pattern.sweptLevel, patternIds: [...new Set([...i.pattern.claimed.map((c) => c.engine), ...i.gate.patterns])], claimedEngines: i.pattern.claimed.map((c) => c.engine),
    sweepCountLast12: i.quality.repeatedSweeps.count,
    marketStructure: { regime: i.quality.regime, trendAlignment: i.quality.trendAlignment, countertrendRisk: i.quality.countertrendRisk },
    hybrid: { mode: i.gate.mode, hybridMode: i.gate.hybridMode, status: i.gate.status, allow: i.gate.allow, reason: i.gate.reason.slice(0, 240), patterns: i.gate.patterns, probability: i.gate.probability, indicatorScore: i.gate.qualityScore, note: i.gate.modeNote },
    dataFreshness: { signalAgeSec: Math.round(i.ageSec), maxAgeSec: Math.round(i.maxAgeSec), candleSetHash: candleSetHash(rows), lastCandleLabel: candleLabel(sig.time) },
  };
}

/** The text block added to the AI prompt. It is labelled context: the AI may add warnings from it, never invent or drop a strategy rule. */
export function hybridPromptSection(e: HybridEvidence | null): string {
  if (!e) return 'HYBRID ENGINE EVIDENCE: not available for this candidate.';
  return [
    'HYBRID ENGINE EVIDENCE (context only, computed by the server from the same OHLC rows; it is NOT a strategy rule and cannot make the pattern invalid):',
    JSON.stringify({ ...e, hybrid: { ...e.hybrid, probability: e.hybrid.probability ?? 'none: no validated model is loaded, no probability exists' } }, null, 1),
    'Check that the numbers above agree with the screenshot (candle colours, which wick goes through which level). Report any disagreement in screenshot.disagreement.',
  ].join('\n');
}

export const hybridEvidenceHash = (e: HybridEvidence | null) => (e ? sha256(JSON.stringify(e)).slice(0, 16) : 'none');
