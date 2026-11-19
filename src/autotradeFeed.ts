// The counters and the live activity feed of agent-driven AutoTrade. Built ONLY from the candidate hub's events: it discovers nothing and decides nothing.
import type { CandidateHub, HubEvent } from './candidateHub';

export type FeedKind = 'info' | 'ok' | 'bad' | 'warn';
export interface FeedLine { t: number; candidateId: string; market: string; stage: string; text: string; kind: FeedKind }
export interface AgentDash {
  /** agents currently watching a market */
  agentsActive: number;
  detected: number;            // setups the agents found (since AutoTrade was switched on)
  forwarded: number;           // sent to the three engines + AI
  engineAnalyses: number;      // engine answers received
  aiAnalyses: number;          // AI / hybrid answers received
  approved: number;
  rejected: number;
  expired: number;
  executed: number;            // real orders the broker accepted
  wins: number; losses: number;
  feed: FeedLine[];
}

const ENGINE_NO: Record<string, number> = { sweep: 1, continuation: 2, momentum: 3, lscc: 4, stoch_rsi: 5, structure_sweep: 6 };
const EXPIRY = /stale|expired|too old|busy|not closed|candle close/i;
const FEED_MAX = 60;

export class AutoTradeFeed {
  private c = { detected: 0, forwarded: 0, engineAnalyses: 0, aiAnalyses: 0, approved: 0, rejected: 0, expired: 0, executed: 0 };
  private feed: FeedLine[] = [];
  private seen = new Set<string>();           // candidates that this session counted, so a late event about an older candidate is never counted
  private watchers = new Set<() => void>();
  private off: (() => void) | null = null;
  constructor(private hub: CandidateHub, private agentsActive: () => number, private now: () => number = Date.now) {}

  /** Idempotent: attaching twice keeps ONE listener (the hub replaces a listener of the same name). */
  attach() {
    this.off?.();
    this.c = { detected: 0, forwarded: 0, engineAnalyses: 0, aiAnalyses: 0, approved: 0, rejected: 0, expired: 0, executed: 0 };
    this.feed = []; this.seen.clear();
    this.off = this.hub.onEvent('autotrade:feed', (e) => this.on(e));
  }
  detach() { this.off?.(); this.off = null; }
  get attached() { return !!this.off; }
  onChange(fn: () => void) { this.watchers.add(fn); return () => this.watchers.delete(fn); }

  snapshot(): AgentDash { return { agentsActive: this.agentsActive(), ...this.c, wins: 0, losses: 0, feed: [...this.feed] }; }

  private add(id: string, market: string, stage: string, text: string, kind: FeedKind = 'info') {
    this.feed.unshift({ t: this.now(), candidateId: id, market, stage, text, kind });
    if (this.feed.length > FEED_MAX) this.feed.pop();
    this.watchers.forEach((f) => f());
  }
  private mk(id: string) { const r = this.hub.get(id); return r ? r.versions[0].market : ''; }
  private label(id: string) { return this.mk(id) || id; }

  /** counts a candidate that ended without a trade (once) */
  private end(id: string, reason: string) { /* kept for symmetry; counting is done where the outcome is known */ void id; void reason; }

  /** AutoTrade itself reports a setup it dropped after approval (an open trade, a candle too old, a setup that faded). */
  dropped(id: string, reason: string) {
    if (EXPIRY.test(reason)) this.c.expired++; else this.c.rejected++;
    this.add(id, this.mk(id), 'FINAL', `DROPPED → ${reason}`, 'warn');
  }

  private on(e: HubEvent) {
    switch (e.type) {
      case 'detected':
        this.seen.add(e.ev.candidateId); this.c.detected++;
        this.add(e.ev.candidateId, e.ev.market, 'DETECTED', `AGENT DETECTED → ${e.ev.market} → ${e.ev.direction} → ${e.ev.pattern}`, 'info');
        break;
      case 'forwarded':
        if (!this.seen.has(e.ev.candidateId)) return;
        this.c.forwarded++;
        this.add(e.ev.candidateId, e.ev.market, 'SENT', `SCREENSHOT SENT → ${e.recipients.length} recipients (engine 1, 2, 3 + Gemini) · same evidence, hash ${e.ev.candleSetHash.slice(0, 8)}`, 'info');
        break;
      case 'duplicate':
        if (this.seen.has(e.candidateId)) this.add(e.candidateId, this.mk(e.candidateId), 'DETECTED', `${e.how === 'MERGED' ? 'SAME SETUP' : 'DUPLICATE EVENT'} → ignored (${e.reason})`, 'info');
        break;
      case 'result': {
        if (!this.seen.has(e.ev.candidateId)) return;
        const r = e.result, id = e.ev.candidateId, m = e.ev.market;
        if (!e.accepted) { this.add(id, m, 'ERROR', `${String(r.recipient).toUpperCase()} → REJECTED: it answered about different evidence`, 'bad'); return; }
        if (r.kind === 'engine') {
          if (e.ev.version !== 1 || r.version !== 1) return;
          this.c.engineAnalyses++;
          const n = ENGINE_NO[r.engine] ?? 0;
          const txt = r.status === 'CONFIRMS' ? `${r.side}` : r.status === 'OPPOSITE' ? `${r.side} (OPPOSITE)` : r.status === 'SKIP' ? 'SKIP' : r.status === 'NO_SIGNAL' ? 'NO SIGNAL' : `ERROR ${r.error ?? ''}`;
          this.add(id, m, 'ENGINE', `${r.engine === 'lscc' ? 'LSCC' : `ENGINE ${n}`} → ${txt}`, r.status === 'CONFIRMS' ? 'ok' : r.status === 'OPPOSITE' || r.status === 'ERROR' ? 'bad' : 'info');
        } else if (r.kind === 'ai') {
          this.c.aiAnalyses++;
          const a = r.answer;
          if (r.status === 'DONE' && a) {
            const sigDecision = (a.signal as any)?.decision;
            if (a.tradeable && sigDecision === 'AI_UNAVAILABLE') {
              this.add(id, m, 'AI', 'GEMINI → ENGINE ONLY (AI unavailable)', 'warn');
            } else {
              this.add(id, m, 'AI', a.tradeable ? 'GEMINI → APPROVED' : `GEMINI → NOT APPROVED (${a.status}${a.reasons?.[0] ? `: ${a.reasons[0]}` : ''})`, a.tradeable ? 'ok' : 'bad');
            }
          } else this.add(id, m, 'AI', `GEMINI → ${r.status} (${r.detail})`, 'warn');
        }
        break;
      }
      case 'update':
        if (this.seen.has(e.ev.candidateId)) this.add(e.ev.candidateId, e.ev.market, 'UPDATE', `CHART UPDATED → version ${e.ev.version}, ${e.ev.validity.valid ? 'setup still valid' : `SETUP INVALIDATED: ${e.ev.validity.reasons[0]}`}`, e.ev.validity.valid ? 'info' : 'bad');
        break;
      case 'decision': {
        if (!this.seen.has(e.ev.candidateId)) return;
        const d = e.decision, id = e.ev.candidateId, m = e.ev.market;
        if (d.action === 'EXECUTE') { this.c.approved++; this.add(id, m, 'FINAL', `FINAL VALIDATION → PASSED (${d.corroboratedBy.length} engine${d.corroboratedBy.length === 1 ? '' : 's'} agree)`, 'ok'); }
        else {
          const why = d.reasons[0] ?? '';
          if (EXPIRY.test(why)) this.c.expired++; else this.c.rejected++;
          this.add(id, m, 'FINAL', `FINAL VALIDATION → ${d.action === 'CANCELLED' ? 'CANCELLED' : 'REJECTED'}: ${why}`, 'bad');
        }
        break;
      }
      case 'ordering':
        if (this.seen.has(e.candidateId)) this.add(e.candidateId, this.mk(e.candidateId), 'BROKER', `BROKER → ${e.side} ORDER SUBMITTED`, 'info');
        break;
      case 'ordered':
        if (!this.seen.has(e.candidateId)) return;
        this.c.executed++;
        this.add(e.candidateId, this.mk(e.candidateId), 'TRADE', `TRADE → EXECUTED (${e.side}${e.brokerOrderId ? `, order ${e.brokerOrderId}` : ''})`, 'ok');
        break;
      case 'order_failed':
        if (this.seen.has(e.candidateId)) this.add(e.candidateId, this.mk(e.candidateId), 'BROKER', `BROKER → ORDER NOT PLACED: ${e.reason}`, 'bad');
        break;
      case 'dropped':
        if (this.seen.has(e.candidateId)) this.dropped(e.candidateId, e.reason);
        break;
      case 'lscc':
        // confirmed setups appear through DETECTED (the candidate is published on confirmation); waiting and invalid ones are shown here
        if (e.state === 'WAITING') this.add(e.key, e.market, 'LSCC', `LSCC WAITING → ${e.market} → ${e.side} → sweep of ${e.level}, confirmation pending`, 'info');
        else if (e.state === 'INVALID') this.add(e.key, e.market, 'LSCC', `LSCC INVALID → ${e.market} → ${e.reason}`, 'warn');
        break;
      case 'refused':
        this.add('', '', 'ERROR', `EVIDENCE REFUSED → ${e.reason}`, 'bad');
        break;
    }
    this.watchers.forEach((f) => f());
  }
}
