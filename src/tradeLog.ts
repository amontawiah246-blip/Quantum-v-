// EXECUTION LOG + PERFORMANCE ANALYTICS (append-only JSONL, one event per line).
//
// Nothing here is invented: a CANDIDATE is written when the strategy engine found a setup, an ORDER only when the broker accepted one,
// an OUTCOME only when the broker (or, labelled, the price) settled it. Candidates that were never traded get a SHADOW outcome
// (entry = open of the next candle, settle = its close, the same rule as the backtester) so strategy-only, AI-approved, AI-rejected and
// hybrid-vetoed cohorts can be compared on identical setups. Shadow results are labelled `shadow`, never mixed with broker results.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AiContract } from './aiContract';

export interface CandidateEvent {
  type: 'CANDIDATE'; id: string; ts: number; market: string; label: string; tf: number; candleTime: number; side: 'BUY' | 'SELL';
  pattern: string; engineConfidence: number; decision: string; aiContract: AiContract | null; hybridStatus: string | null; hybridAllow: boolean | null; hybridProbability: number | null;
  screenshotStatus: string | null; visualDisagreement: boolean; tradeable: boolean; aiError: string | null;
}
export interface ShadowEvent { type: 'SHADOW'; id: string; ts: number; result: 'win' | 'loss' | 'tie'; entry: number; exit: number }
export interface GateEvent { type: 'GATE'; id: string; ts: number; action: 'TRADE' | 'NO_TRADE'; failed: string[]; reason: string }
export interface OrderEvent { type: 'ORDER'; id: string; ts: number; brokerOrderId: string | null; market: string; side: 'BUY' | 'SELL'; stake: number; expirySec: number; signalCloseTime: number; requestedAtSec: number | null; placedAtSec: number; delaySec: number | null; entryRef: number | null; priceAtOrder: number | null; settleAtSec: number }
export interface OutcomeEvent { type: 'OUTCOME'; id: string; ts: number; brokerOrderId: string | null; outcome: 'win' | 'loss' | 'draw'; profit: number | null }
export interface FailureEvent { type: 'FAILURE'; ts: number; stage: string; reason: string; id?: string }
export type LogEvent = CandidateEvent | ShadowEvent | GateEvent | OrderEvent | OutcomeEvent | FailureEvent;

export class TradeLog {
  private mem: LogEvent[] = [];
  private loaded = false;
  private shadowPending = new Map<string, { id: string; side: 'BUY' | 'SELL'; candleTime: number; tf: number; market: string }>();
  constructor(private path: string | null = process.env.HYBRID_LOG_PATH || 'data/hybrid_log.jsonl') {}

  private load() {
    if (this.loaded) return; this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    for (const line of readFileSync(this.path, 'utf8').split('\n')) { if (!line.trim()) continue; try { this.mem.push(JSON.parse(line)); } catch { /* skip a damaged line */ } }
    const shadowed = new Set(this.mem.filter((e) => e.type === 'SHADOW').map((e) => (e as ShadowEvent).id));
    for (const e of this.mem) if (e.type === 'CANDIDATE' && !shadowed.has(e.id)) this.shadowPending.set(e.id, { id: e.id, side: e.side, candleTime: e.candleTime, tf: e.tf, market: e.market });
  }
  events(): LogEvent[] { this.load(); return this.mem; }
  private write(e: LogEvent) {
    this.load(); this.mem.push(e);
    if (this.mem.length > 50000) this.mem.splice(0, this.mem.length - 50000);
    if (!this.path) return;
    try { mkdirSync(dirname(this.path), { recursive: true }); appendFileSync(this.path, JSON.stringify(e) + '\n'); } catch { /* a log problem must never stop trading logic */ }
  }

  /** one CANDIDATE per (market, tf, candle, side): scanning the same candle again does not add a second one */
  candidate(e: Omit<CandidateEvent, 'type' | 'ts' | 'id'>, now = Date.now()): string {
    this.load();
    const id = `${e.market}|${e.tf}|${e.candleTime}|${e.side}`;
    if (this.mem.some((x) => x.type === 'CANDIDATE' && x.id === id)) return id;
    this.write({ ...e, type: 'CANDIDATE', id, ts: now });
    this.shadowPending.set(id, { id, side: e.side, candleTime: e.candleTime, tf: e.tf, market: e.market });
    return id;
  }
  gate(id: string, action: 'TRADE' | 'NO_TRADE', failed: string[], reason: string, now = Date.now()) { this.write({ type: 'GATE', id, ts: now, action, failed, reason }); }
  order(e: Omit<OrderEvent, 'type' | 'ts'>, now = Date.now()) { this.write({ ...e, type: 'ORDER', ts: now }); }
  outcome(e: Omit<OutcomeEvent, 'type' | 'ts'>, now = Date.now()) { this.write({ ...e, type: 'OUTCOME', ts: now }); }
  failure(stage: string, reason: string, id?: string, now = Date.now()) { this.write({ type: 'FAILURE', ts: now, stage, reason: reason.slice(0, 300), id }); }

  /** Settles pending candidates of this market once their entry candle has closed. `candles` = closed candles of that market. */
  resolveShadows(market: string, candles: { time: number; open: number; close: number }[], now = Date.now()) {
    this.load();
    for (const p of [...this.shadowPending.values()]) {
      if (p.market !== market) continue;
      const entryCandle = candles.find((c) => c.time === p.candleTime + p.tf);
      if (!entryCandle) continue;
      const up = entryCandle.close > entryCandle.open, down = entryCandle.close < entryCandle.open;
      const result = p.side === 'BUY' ? (up ? 'win' : down ? 'loss' : 'tie') : (down ? 'win' : up ? 'loss' : 'tie');
      this.write({ type: 'SHADOW', id: p.id, ts: now, result, entry: entryCandle.open, exit: entryCandle.close });
      this.shadowPending.delete(p.id);
    }
  }
}

// ------------------------------------------------------------------------------------------------ analytics
export interface Cohort { n: number; resolved: number; wins: number; losses: number; ties: number; winRate: number | null; wilson95: [number, number] | null; evPerUnit: number | null; totalUnits: number | null }
const wilson = (w: number, n: number): [number, number] | null => {
  if (!n) return null; const z = 1.96, p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
};
function cohort(results: ('win' | 'loss' | 'tie' | null)[], payout: number): Cohort {
  const r = results.filter((x): x is 'win' | 'loss' | 'tie' => x !== null);
  const wins = r.filter((x) => x === 'win').length, losses = r.filter((x) => x === 'loss').length, ties = r.length - wins - losses;
  const decided = wins + losses, total = wins * payout - losses;
  return { n: results.length, resolved: r.length, wins, losses, ties, winRate: decided ? wins / decided : null, wilson95: wilson(wins, decided), evPerUnit: r.length ? total / r.length : null, totalUnits: r.length ? total : null };
}
export interface Analytics {
  payout: number; breakEvenWinRate: number; events: number;
  cohorts: Record<string, Cohort>;
  byPattern: Record<string, Cohort>; byMarket: Record<string, Cohort>;
  broker: Cohort & { orders: number };
  visualDisagreements: number; aiFailures: number; entryDelaySec: { n: number; mean: number | null; max: number | null };
  outOfSample: { split: number; first: Record<string, Cohort>; last: Record<string, Cohort> } | null;
  note: string;
}

export function analyze(events: LogEvent[], payout = 0.9, split = 0.6): Analytics {
  const cands = events.filter((e): e is CandidateEvent => e.type === 'CANDIDATE').sort((a, b) => a.candleTime - b.candleTime);
  const shadow = new Map(events.filter((e): e is ShadowEvent => e.type === 'SHADOW').map((e) => [e.id, e.result]));
  const res = (c: CandidateEvent) => shadow.get(c.id) ?? null;
  const groups: Record<string, (c: CandidateEvent) => boolean> = {
    strategyOnly: () => true,
    aiApproved: (c) => c.decision === 'APPROVED' || c.decision === 'VALID_WITH_RISK',
    aiRejected: (c) => c.decision === 'REJECTED',
    aiAbstained: (c) => c.decision === 'REVIEW' || c.decision === 'AI_UNAVAILABLE',
    hybridVetoed: (c) => c.hybridAllow === false,
    finalTradeable: (c) => c.tradeable,
  };
  const build = (list: CandidateEvent[]) => Object.fromEntries(Object.entries(groups).map(([k, f]) => [k, cohort(list.filter(f).map(res), payout)]));
  const by = (key: (c: CandidateEvent) => string, pred: (c: CandidateEvent) => boolean) => {
    const m = new Map<string, CandidateEvent[]>(); for (const c of cands.filter(pred)) m.set(key(c), [...(m.get(key(c)) ?? []), c]);
    return Object.fromEntries([...m].map(([k, v]) => [k, cohort(v.map(res), payout)]));
  };
  const orders = events.filter((e): e is OrderEvent => e.type === 'ORDER');
  const outcomes = new Map(events.filter((e): e is OutcomeEvent => e.type === 'OUTCOME').map((e) => [e.id, e]));
  const brokerResults = orders.map((o) => { const x = outcomes.get(o.id); return x ? (x.outcome === 'draw' ? 'tie' : x.outcome) : null; });
  const brokerCohort = cohort(brokerResults, payout);
  const delays = orders.map((o) => o.delaySec).filter((x): x is number => x != null);
  const cut = Math.floor(cands.length * split);
  return {
    payout, breakEvenWinRate: 1 / (1 + payout), events: events.length,
    cohorts: build(cands), byPattern: by((c) => c.pattern, () => true), byMarket: by((c) => c.label, () => true),
    broker: { ...brokerCohort, orders: orders.length },
    visualDisagreements: cands.filter((c) => c.visualDisagreement).length,
    aiFailures: cands.filter((c) => c.aiError).length,
    entryDelaySec: { n: delays.length, mean: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null, max: delays.length ? Math.max(...delays) : null },
    outOfSample: cands.length >= 20 ? { split, first: build(cands.slice(0, cut)), last: build(cands.slice(cut)) } : null,
    note: 'Cohorts use SHADOW results (next-candle open to close) so rejected setups can be compared on equal terms; `broker` uses real broker settlements only. A cohort with few resolved trades says nothing: read wilson95. AI verification helps only if aiApproved beats strategyOnly in the LAST (out-of-sample) block with a higher evPerUnit, not merely fewer trades.',
  };
}
