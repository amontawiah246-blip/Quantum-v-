// How AutoTrading reads a candidate's verification instead of repeating it. Pure apart from the hub it is given.
//
// The market agents already published the setup, and the coordinator already ran the three engines, the AI and the hybrid analysis on it
// in parallel. When the autopilot looks at that market, it waits for THAT decision (it does not send a second screenshot to Gemini).
// null = no agent candidate exists for this candle: the caller then uses the older scan-and-verify path unchanged.
import type { Signal } from '../signalServer';
import type { CandidateHub } from './candidateHub';
import type { AutoLook } from './autoLook';
import { lookFromSignal } from './autoLook';
import type { ExecutionLedger } from './aiVerification';

export async function lookFromCandidate(hub: CandidateHub, c: {
  symbol: string; market: string; label: string; tfSec: number; clk: number;
  candles: { time: number; open: number; high: number; low: number; close: number }[];
  ledger: ExecutionLedger; waitMs: number; maxEntryDelaySec: number;
}): Promise<AutoLook | null> {
  const closed = c.candles.filter((x) => x.time + c.tfSec <= c.clk);
  const last = closed[closed.length - 1];
  if (!last) return null;
  const recs = hub.findByCandle(c.symbol, c.tfSec, last.time);
  if (!recs.length) return null;
  const decisions = await Promise.all(recs.map(async (r) => ({ r, d: await hub.waitForDecision(r.id, c.waitMs) })));
  const why: string[] = [];
  for (const { r, d } of decisions) {
    if (!d) { why.push(`${r.direction}: verification still running`); continue; }
    if (d.action !== 'EXECUTE') { why.push(`${r.direction}: ${d.action.toLowerCase()}: ${d.reasons[0] ?? ''}`); continue; }
    const chk = hub.executionCheck(r.id, { nowSec: c.clk, maxEntryDelaySec: c.maxEntryDelaySec });
    if (!chk.ok) { why.push(`${r.direction}: ${chk.reason}`); continue; }
    const look = lookFromSignal(d.signal as Signal, { market: c.market, label: c.label, tfSec: c.tfSec, clk: c.clk, candles: c.candles, ledger: c.ledger });
    if ('ref' in look) { look.ref.candidateId = r.id; look.ref.candidateVersion = chk.latestVersion ?? d.evaluatedVersion; return look; }
    why.push(`${r.direction}: ${look.none}`);
  }
  return { none: why.join(' | ').slice(0, 90) || 'no verified candidate' };
}

/** What AutoTrade's analyser answers in agent mode: the agents' decision for this candle, or a plain "no agent setup". It never scans and never calls an engine or Gemini. */
export async function lookFromAgents(hub: CandidateHub, c: Parameters<typeof lookFromCandidate>[1]): Promise<AutoLook> {
  return (await lookFromCandidate(hub, c)) ?? { none: 'no market-agent setup for this candle' };
}
