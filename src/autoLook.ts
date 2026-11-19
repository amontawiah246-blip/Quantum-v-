// What AutoTrading does with a Signal while SCANNING. Pure (no network), so it is unit-tested.
//
// Scanning never "uses up" a candle: the duplicate-order ledger is only claimed when an order is actually sent (autoServer.place).
// (Claiming it during the scan made the autopilot's second look, right before the trade, answer "already traded" and skip every setup.)
import type { Signal } from '../signalServer';
import type { ExecutionLedger } from './aiVerification';
import { maxAgeFor } from './aiVerification';
import { atr14 } from './executionGate';

import { liveShort } from './liveConfidence';
export interface AutoRef {
  signalId: string; signalKey: string; market: string; label: string; tf: number; candleTime: number; closeTime: number;
  side: 'BUY' | 'SELL'; refPrice: number; atr: number | null; closed: { time: number; open: number; high: number; low: number; close: number }[];
  aiDecision: 'APPROVE' | 'REJECT' | 'ABSTAIN' | 'RETRY' | null; aiDirection: 'BUY' | 'SELL' | 'NO_TRADE' | null;
  controllerEligible: boolean; controllerReason: string; hybridAllow: boolean; hybridReason: string;
  screenshotCandleTime: number | null; requireScreenshot: boolean; engineOnly: boolean;
  /** set when the setup came from the candidate hub (src/candidateHub.ts): the order is cancelled if that candidate was invalidated, went stale or was already traded */
  candidateId?: string; candidateVersion?: number;
}

export type AutoLook = { side: 'buy' | 'sell'; confidence: number; why: string; ref: AutoRef } | { none: string };

export function lookFromSignal(sig: Signal, c: { market: string; label: string; tfSec: number; clk: number; candles: { time: number; open: number; high: number; low: number; close: number }[]; ledger: ExecutionLedger }): AutoLook {
  if (!sig.tradeable || !sig.side) return { none: (sig.verification && !sig.verification.execution.eligible && sig.setup ? `${sig.decision}: ${sig.verification.execution.reason}` : sig.status).slice(0, 90) };
  const tf = c.tfSec;
  const age = c.clk - (sig.candleTime + tf);
  const v = sig.verification;
  const policy = v?.execution.policy;
  if (age > (policy ? maxAgeFor(policy, tf) : Math.max(20, tf * 0.5))) return { none: `setup is ${Math.round(age)}s old, too late to enter` };
  const side = sig.side === 'buy' ? 'BUY' : 'SELL';
  const signalKey = `${c.market}|${tf}|${sig.candleTime}`;
  if (c.ledger.has(`${signalKey}|${side}`)) return { none: 'this candle was already traded' };

  const closed = c.candles.filter((x) => x.time + tf <= c.clk);
  const last = closed[closed.length - 1];
  const how = v?.execution.engineOnly ? 'engine only (AI unavailable, your policy allows it; NOT visually verified)' : `AI ${sig.decision}${v?.visualVerification ? ' with screenshot' : ''}`;
  const hy = sig.hybrid && sig.hybrid.mode !== 'off' ? ` · hybrid ${sig.hybrid.status.toLowerCase()}${sig.hybrid.probability != null ? ` P=${sig.hybrid.probability.toFixed(3)}` : ''}` : '';
  return {
    side: sig.side, confidence: sig.confidence,
    why: `${sig.setupName}${sig.condition ? ` · ${sig.condition.trend.toLowerCase()} · RSI ${sig.condition.rsi}` : ''} · ${sig.engine.agree}/3 engines, ${how}${hy}${sig.live ? ` · ${liveShort(sig.live)}` : ''}`,
    ref: {
      signalId: `${c.market}|${tf}|${sig.candleTime}|${side}`, signalKey, market: c.market, label: c.label, tf, candleTime: sig.candleTime, closeTime: sig.candleTime + tf, side,
      refPrice: last && last.time === sig.candleTime ? last.close : NaN, atr: atr14(closed), closed: closed.slice(-60),
      aiDecision: sig.contract?.decision ?? null, aiDirection: sig.contract?.direction ?? null,
      controllerEligible: !!v?.execution.eligible, controllerReason: v?.execution.reason ?? '',
      hybridAllow: sig.hybrid ? sig.hybrid.allow : true, hybridReason: sig.hybrid?.reason ?? '',
      screenshotCandleTime: v?.screenshotVerification.status === 'VERIFIED' ? sig.candleTime : null, requireScreenshot: !!policy?.requireScreenshot, engineOnly: !!v?.execution.engineOnly,
    },
  };
}
