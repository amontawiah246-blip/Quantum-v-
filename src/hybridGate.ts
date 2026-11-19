// HYBRID GATE: how the hybrid engine's verdict is allowed to influence AutoTrading.
//
// The original strategy (the engines run by /api/engines + src/patternVerification.ts) is the ONLY thing that can create a setup.
// The hybrid layer can never create, loosen or re-time a trade. It can only (depending on the mode) say "no":
//   off       the hybrid verdict is ignored by AutoTrading (it is still shown on /api/engines)
//   advisory  the verdict is sent to the AI as evidence and logged, but it never blocks anything
//   veto      DEFAULT. Blocks only when the hybrid layer positively disagrees with the engine's own side (indicator gate, model
//             probability, conflict, or an opposite hybrid trade). "No opinion" (no hybrid setup, warm-up, wrong timeframe, no
//             model) never blocks and is labelled as such.
//   require   a trade also needs the hybrid layer to confirm the same side. Fewer trades, never more.
import type { HybridView } from './hybridEngine';

export type HybridGateMode = 'off' | 'advisory' | 'veto' | 'require';
export type HybridGateStatus = 'OFF' | 'CONFIRMS' | 'VETO_INDICATORS' | 'VETO_MODEL' | 'VETO_CONFLICT' | 'VETO_OPPOSITE' | 'NO_OPINION' | 'UNAVAILABLE';
export interface HybridGatePolicy { mode: HybridGateMode }
export const DEFAULT_HYBRID_GATE: HybridGatePolicy = { mode: 'veto' };

export interface HybridGateResult {
  mode: HybridGateMode;
  status: HybridGateStatus;
  /** false = AutoTrading must not trade this setup */
  allow: boolean;
  /** the hybrid layer disagreed, whatever the mode did with it (so advisory mode still shows what a veto would have done) */
  disagrees: boolean;
  reason: string;
  probability: number | null;
  qualityScore: number | null;
  patterns: string[];
  hybridMode: string | null;
  modeNote: string | null;
}

export function hybridGatePolicyFromEnv(env: Record<string, string | undefined> = process.env): HybridGatePolicy {
  const v = String(env.HYBRID_AUTOTRADE ?? '').trim().toLowerCase();
  return { mode: (['off', 'advisory', 'veto', 'require'] as const).find((m) => m === v) ?? DEFAULT_HYBRID_GATE.mode };
}

const VETO_STAGES: Record<string, HybridGateStatus> = { STAGE2_INDICATORS: 'VETO_INDICATORS', STAGE3_MODEL: 'VETO_MODEL', CONFLICT: 'VETO_CONFLICT' };

/** Pure: judges the ENGINE's side against the hybrid view of the same candle. */
export function gateHybrid(engineSide: 'BUY' | 'SELL', view: HybridView | null | undefined, policy: HybridGatePolicy = DEFAULT_HYBRID_GATE): HybridGateResult {
  const mine = view?.bySide?.[engineSide];
  const base = { mode: policy.mode, probability: mine?.probability ?? view?.probability ?? null, qualityScore: mine?.qualityScore ?? null, patterns: mine?.patterns ?? view?.patterns ?? [], hybridMode: view?.mode ?? null, modeNote: view?.modeNote ?? null };
  const done = (status: HybridGateStatus, reason: string, disagrees: boolean): HybridGateResult => {
    let allow = true;
    if (policy.mode === 'veto') allow = !disagrees;
    else if (policy.mode === 'require') allow = status === 'CONFIRMS';
    if (policy.mode === 'off') return { ...base, status: 'OFF', allow: true, disagrees: false, reason: 'hybrid gate is off' };
    return { ...base, status, allow, disagrees, reason: policy.mode === 'require' && !allow && !disagrees ? `hybrid confirmation required but: ${reason}` : reason };
  };

  if (policy.mode === 'off') return done('OFF', '', false);
  if (!view) return done('UNAVAILABLE', 'no hybrid verdict was returned for this candle', false);
  if (view.stage === 'DATA' || view.stage === 'TIMEFRAME') return done('UNAVAILABLE', view.reason, false);
  if (view.stage === 'WARMUP') return done('NO_OPINION', view.reason, false);

  if (view.action === engineSide) return done('CONFIRMS', `hybrid agrees: ${view.reason}`, false);
  if (view.action !== 'NO_TRADE') return done('VETO_OPPOSITE', `hybrid trades the opposite side (${view.action}): ${view.reason}`, true);

  if (!mine) return done('NO_OPINION', view.stage === 'NO_SETUP' ? 'the hybrid candlestick stage sees no setup for this side' : (view.reason || 'no hybrid record for this side'), false);
  const status = mine.rejectionStage ? VETO_STAGES[mine.rejectionStage] : undefined;
  if (status) return done(status, `hybrid ${mine.rejectionStage}: ${mine.rejectionReason ?? 'rejected'}`, true);
  if (mine.rejectionStage === 'MODEL_UNAVAILABLE') return done('UNAVAILABLE', `hybrid model unavailable: ${mine.rejectionReason ?? ''}`, false);
  return done('NO_OPINION', `hybrid ${mine.rejectionStage ?? 'no decision'}: ${mine.rejectionReason ?? ''}`.trim(), false);
}
