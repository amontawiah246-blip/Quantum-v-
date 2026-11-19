// How AutoTrade receives the market agents' setups. The agents are the ONLY discovery source: this adapter listens to the candidate hub's
// decisions and hands every APPROVED candidate to the autopilot. It never reads a market, never scans, never asks an engine or Gemini.
import type { CandidateHub, CandidateDecision } from './candidateHub';
import type { CandidateEvidence } from './candidateTypes';
import type { AgentSetup, AgentSource } from './autopilot';
import { AutoTradeFeed } from './autotradeFeed';
import { agentMode } from './agentMode';
import { lookFromSignal } from './autoLook';
import type { ExecutionLedger } from './aiVerification';
import type { Signal } from '../signalServer';

export interface AgentSourceOptions {
  /** the market name shown to the user */
  labelOf: (symbol: string, fallback: string) => string;
  payoutOf?: (symbol: string) => number | null;
  /** the candle size the agents watch */
  tfSec: () => number;
  agentsActive: () => number;
  nowSec: () => number;
  maxEntryDelaySec: number;
  ledger: ExecutionLedger;
  broker?: string;
}

export function makeAgentSource(hub: CandidateHub, o: AgentSourceOptions): AgentSource & { feed: AutoTradeFeed } {
  const feed = new AutoTradeFeed(hub, o.agentsActive);
  const broker = o.broker ?? 'deriv';
  const unsubs: (() => void)[] = [];
  const setupOf = (ev: CandidateEvidence, d: CandidateDecision): AgentSetup | { drop: string } => {
    // the verified signal is turned into the autopilot's verdict by the SAME function the old path used (fresh? already traded? agreement?)
    const look = lookFromSignal(d.signal as Signal, { market: `${broker}:${ev.symbol}`, label: o.labelOf(ev.symbol, ev.market), tfSec: ev.tf, clk: o.nowSec(), candles: ev.ohlc as any[], ledger: o.ledger });
    if (!('ref' in look)) return { drop: look.none };
    return { id: ev.candidateId, symbol: ev.symbol, label: o.labelOf(ev.symbol, ev.market), side: look.side, conf: look.confidence, why: `${ev.pattern}${look.why ? ' · ' + look.why : ''}`.slice(0, 120), payout: o.payoutOf?.(ev.symbol) ?? null, closeAtSec: ev.signalCandleClose, detectedAtMs: ev.detectedAtMs };
  };
  const res: AgentSource & { feed: AutoTradeFeed } = {
    feed,
    tfSec: o.tfSec,
    open() {
      agentMode.open(res);
      feed.attach();
    },
    close() {
      agentMode.close(res);
      feed.detach();
      unsubs.forEach((u) => u()); unsubs.length = 0;
    },
    /** one listener, replaced (never added) when AutoTrade is switched on again */
    subscribe(handler) {
      const off = hub.onEvent('autotrade:setups', (e) => {
        if (e.type !== 'decision' || e.decision.action !== 'EXECUTE' || !agentMode.active) return;
        const s = setupOf(e.ev, e.decision);
        if ('drop' in s) { hub.emit({ type: 'dropped', candidateId: e.ev.candidateId, reason: s.drop }); return; }
        handler(s);
      });
      unsubs.push(off);
      return off;
    },
    /** null = still tradeable. Otherwise the reason it is not (expired, invalidated, already executed ...). */
    check(s) { const c = hub.executionCheck(s.id, { nowSec: o.nowSec(), maxEntryDelaySec: o.maxEntryDelaySec }); return c.ok ? null : c.reason; },
    dropped(s, reason) { hub.emit({ type: 'dropped', candidateId: s.id, reason }); },
    stats: () => feed.snapshot(),
    onChange: (fn) => feed.onChange(fn),
  };
  return res;
}
