// THE CANDIDATE HUB: the event bus between the market agents (which find setups and draw the screenshot) and everything that
// verifies them (three strategy engines, AI verification, hybrid analysis, execution).
//
//   agent finds a setup -> publish(evidence)  -> every recipient is handed the SAME frozen evidence in the same tick
//   agent sees the chart change -> update(id) -> a NEW version is stored and announced; version 1 is never replaced
//   every result carries (candidateId, version, candleSetHash) and is rejected when it does not match what was stored
//   execution asks executionCheck(): invalidated, stale, already executed or tampered candidates never pass
//
// No network, no trading and no strategy rule in here. Handlers are called without waiting for each other: a slow recipient
// delays nobody else, and nothing here waits for any market.
import { CandidateEvidence, Side, PublishInput, UpdateInput, aiRowsHashOf, candidateIdFor, datasetHashOf, freezeEvidence, patternNameOf, validateEvidence } from './candidateTypes';
import { ResultBase, revalidateSetup } from './candidateEngines';

export type CandidateStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'INVALIDATED' | 'EXPIRED';
export type DecisionAction = 'EXECUTE' | 'REJECT' | 'CANCELLED';
export type RecipientEvent = 'candidate' | 'update';
export type Handler = (ev: CandidateEvidence, event: RecipientEvent) => void | Promise<void>;

export interface CandidateDecision {
  candidateId: string;
  /** the evidence version every result in this decision looked at */
  evaluatedVersion: number;
  /** the newest version when the decision was made */
  latestVersion: number;
  candleSetHash: string;
  action: DecisionAction;
  reasons: string[];
  decidedAtMs: number;
  /** engines that confirmed the setup independently */
  corroboratedBy: string[];
  /** the verified signal the execution path reads (src/autoLook.ts); opaque here */
  signal?: unknown;
}

export interface DeliveryReport { recipient: string; event: RecipientEvent; handedOverAtMs: number; handedOverOffsetMs: number; error?: string }

export interface CandidateRecord {
  id: string; symbol: string; tf: number; signalCandleOpen: number; direction: Side;
  versions: CandidateEvidence[];
  status: CandidateStatus;
  invalidReason: string | null;
  decision: CandidateDecision | null;
  decisionHistory: CandidateDecision[];
  results: (ResultBase & { kind: string })[];
  rejectedResults: { recipient: string; version: number; reason: string }[];
  coDetectedBy: string[];
  executed: boolean;
  createdMs: number;
}

export type PublishOutcome =
  | { status: 'PUBLISHED'; candidate: CandidateEvidence; deliveries: Promise<DeliveryReport[]> }
  | { status: 'DUPLICATE' | 'MERGED'; candidateId: string; reason: string }
  | { status: 'REJECTED'; reason: string; problems: string[] };
export type UpdateOutcome =
  | { status: 'UPDATED' | 'INVALIDATED'; candidate: CandidateEvidence; deliveries: Promise<DeliveryReport[]> }
  | { status: 'UNCHANGED' | 'UNKNOWN' | 'IGNORED'; reason: string };

/** What happened to a candidate, in order. AutoTrade's live feed and counters are built from these; nothing else depends on them. */
export type HubEvent =
  | { type: 'detected'; ev: CandidateEvidence }
  | { type: 'forwarded'; ev: CandidateEvidence; recipients: string[] }
  | { type: 'duplicate'; candidateId: string; how: 'DUPLICATE' | 'MERGED'; reason: string }
  | { type: 'refused'; reason: string }
  | { type: 'result'; ev: CandidateEvidence; result: ResultBase & { kind: string } & Record<string, any>; accepted: boolean }
  | { type: 'update'; ev: CandidateEvidence }
  | { type: 'decision'; ev: CandidateEvidence; decision: CandidateDecision }
  | { type: 'ordering'; candidateId: string; side: Side }
  | { type: 'ordered'; candidateId: string; side: Side; brokerOrderId?: string }
  | { type: 'order_failed'; candidateId: string; reason: string }
  | { type: 'dropped'; candidateId: string; reason: string }
  | { type: 'lscc'; key: string; symbol: string; market: string; side: Side; state: 'WAITING' | 'CONFIRMED' | 'INVALID'; level: number; sweepTime: number; confirmTime: number | null; reason: string; candidateId?: string };

export interface ExecutionCheck { ok: boolean; reason: string; latestVersion: number | null; evaluatedVersion: number | null }

// ------------------------------------------------------------------------------------------------ latency metrics
export type Stage = 'detection' | 'screenshot' | 'broadcast' | 'engine' | 'ai' | 'aggregation' | 'execution' | string;
export class LatencyMetrics {
  private samples = new Map<string, number[]>();
  counters: Record<string, number> = { published: 0, duplicates: 0, merged: 0, rejected: 0, updates: 0, invalidated: 0, inconsistentResults: 0, decisions: 0, executed: 0 };
  record(stage: Stage, ms: number) {
    if (!Number.isFinite(ms)) return;
    const a = this.samples.get(stage) ?? [];
    a.push(ms); if (a.length > 500) a.shift();
    this.samples.set(stage, a);
  }
  count(name: string) { this.counters[name] = (this.counters[name] ?? 0) + 1; }
  summary() {
    const stages: Record<string, { count: number; min: number; p50: number; p95: number; max: number; last: number }> = {};
    for (const [k, a] of this.samples) {
      const s = [...a].sort((x, y) => x - y), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
      stages[k] = { count: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], last: a[a.length - 1] };
    }
    return { stages, counters: { ...this.counters } };
  }
}

export interface HubOptions {
  clock?: () => number;            // ms epoch
  perf?: () => number;             // ms, monotonic
  retain?: number;                 // candidates kept
  maxVersions?: number;            // versions kept per candidate (version 1 is always kept)
  /** a candidate stays "live" (its chart keeps being refreshed) until this long after its candle closed */
  liveWindowSec?: number;
  metrics?: LatencyMetrics;
}

export class CandidateHub {
  readonly metrics: LatencyMetrics;
  private recs = new Map<string, CandidateRecord>();
  private subs = new Map<string, Handler>();
  private listeners = new Map<string, (e: HubEvent) => void>();
  private waiters = new Map<string, ((d: CandidateDecision | null) => void)[]>();
  private clock: () => number;
  private perf: () => number;
  private retain: number; private maxVersions: number; private liveWindowSec: number;

  constructor(o: HubOptions = {}) {
    this.clock = o.clock ?? Date.now;
    this.perf = o.perf ?? (() => performance.now());
    this.retain = o.retain ?? 400; this.maxVersions = o.maxVersions ?? 30; this.liveWindowSec = o.liveWindowSec ?? 60;
    this.metrics = o.metrics ?? new LatencyMetrics();
  }

  // ---------------------------------------------------------------------------------------------- recipients
  subscribe(name: string, handler: Handler): () => void {
    this.subs.set(name, handler);
    return () => { if (this.subs.get(name) === handler) this.subs.delete(name); };
  }
  get recipients() { return [...this.subs.keys()]; }

  /** Event listeners are keyed by name: registering the same name again REPLACES the old listener, so switching a consumer off and on never duplicates it. */
  onEvent(name: string, fn: (e: HubEvent) => void): () => void {
    this.listeners.set(name, fn);
    return () => { if (this.listeners.get(name) === fn) this.listeners.delete(name); };
  }
  get listenerNames() { return [...this.listeners.keys()]; }
  emit(e: HubEvent) { for (const fn of this.listeners.values()) { try { fn(e); } catch { /* a listener must never break the pipeline */ } } }

  /** Hands the evidence to every recipient in the same tick. Nobody waits for anybody: each handler's promise is tracked on its own. */
  private broadcast(ev: CandidateEvidence, event: RecipientEvent): Promise<DeliveryReport[]> {
    const t0 = this.perf();
    const done: Promise<DeliveryReport>[] = [];
    for (const [recipient, handler] of this.subs) {
      const report: DeliveryReport = { recipient, event, handedOverAtMs: this.clock(), handedOverOffsetMs: this.perf() - t0 };
      let p: void | Promise<void>;
      try { p = handler(ev, event); } catch (e) { report.error = errText(e); done.push(Promise.resolve(report)); continue; }
      done.push(Promise.resolve(p).then(() => report, (e) => ({ ...report, error: errText(e) })));
    }
    this.metrics.record('broadcast', this.perf() - t0);
    return Promise.all(done);
  }

  // ---------------------------------------------------------------------------------------------- publish
  publish(input: PublishInput): PublishOutcome {
    const id = candidateIdFor(input.symbol, input.tf, input.signalCandleOpen, input.direction);
    const existing = this.recs.get(id);
    if (existing) {
      if (existing.versions[0].engine === input.engine) { this.metrics.count('duplicates'); this.emit({ type: 'duplicate', candidateId: id, how: 'DUPLICATE', reason: 'this setup was already published' }); return { status: 'DUPLICATE', candidateId: id, reason: 'this setup was already published' }; }
      if (!existing.coDetectedBy.includes(input.engine)) existing.coDetectedBy.push(input.engine);
      this.metrics.count('merged');
      const reason = `${input.engine} found the same opportunity as ${existing.versions[0].engine}: one candidate, one verification`;
      this.emit({ type: 'duplicate', candidateId: id, how: 'MERGED', reason });
      return { status: 'MERGED', candidateId: id, reason };
    }
    const now = this.clock();
    const ev: CandidateEvidence = {
      candidateId: id, version: 1, kind: 'ORIGINAL', agentId: input.agentId, symbol: input.symbol, market: input.market,
      engine: input.engine, direction: input.direction, tf: input.tf,
      signalCandleOpen: input.signalCandleOpen, signalCandleClose: input.signalCandleOpen + input.tf, patternFrom: input.patternFrom,
      tradeAtNextOpen: input.tradeAtNextOpen, pattern: patternNameOf(input.engine, input.direction), entry: input.entry, sweptLevel: input.sweptLevel, notes: [...input.notes], trace: [...input.trace],
      ohlc: input.ohlc.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
      candleSetHash: datasetHashOf(input.ohlc), aiRowsHash: aiRowsHashOf(input.ohlc), engineWindow: input.engineWindow,
      screenshot: input.screenshot, screenshotAtMs: input.screenshot.capturedAtMs,
      detectedAtMs: input.detectedAtMs, detectionLatencySec: input.detectionLatencySec, publishedAtMs: now,
      supersedes: null, reason: 'setup detected', validity: { valid: true, reasons: [] },
      ...(input.lscc ? { lscc: { ...input.lscc } } : {}),
      ...(input.stochRsi ? { stochRsi: input.stochRsi } : {}),
    };
    const problems = validateEvidence(ev);
    if (problems.length) { this.metrics.count('rejected'); this.emit({ type: 'refused', reason: problems[0] }); return { status: 'REJECTED', reason: `inconsistent evidence: ${problems[0]}`, problems }; }
    freezeEvidence(ev);
    this.recs.set(id, {
      id, symbol: ev.symbol, tf: ev.tf, signalCandleOpen: ev.signalCandleOpen, direction: ev.direction, versions: [ev], status: 'PENDING', invalidReason: null,
      decision: null, decisionHistory: [], results: [], rejectedResults: [], coDetectedBy: [], executed: false, createdMs: now,
    });
    while (this.recs.size > this.retain) this.recs.delete(this.recs.keys().next().value as string);
    this.metrics.count('published');
    if (ev.detectionLatencySec != null) this.metrics.record('detection', ev.detectionLatencySec * 1000);
    this.metrics.record('screenshot', ev.screenshot.captureMs);
    this.emit({ type: 'detected', ev });
    return { status: 'PUBLISHED', candidate: ev, deliveries: this.broadcast(ev, 'candidate') };
  }

  // ---------------------------------------------------------------------------------------------- live chart updates
  /** true when these candles differ from the newest stored version (so a new screenshot is worth taking) */
  changed(id: string, ohlc: readonly { time: number; open: number; high: number; low: number; close: number }[]): boolean {
    const r = this.recs.get(id);
    return !!r && datasetHashOf(ohlc) !== r.versions[r.versions.length - 1].candleSetHash;
  }

  update(id: string, input: UpdateInput): UpdateOutcome {
    const rec = this.recs.get(id);
    if (!rec) return { status: 'UNKNOWN', reason: 'no such candidate' };
    const latest = rec.versions[rec.versions.length - 1];
    const hash = datasetHashOf(input.ohlc);
    if (hash === latest.candleSetHash) return { status: 'UNCHANGED', reason: 'same candles as the newest version' };
    if (rec.versions.length >= this.maxVersions) return { status: 'IGNORED', reason: 'version limit reached' };
    const orig = rec.versions[0];
    const now = this.clock();
    let ev: CandidateEvidence = {
      ...orig, version: latest.version + 1, kind: 'UPDATE', ohlc: input.ohlc.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
      candleSetHash: hash, aiRowsHash: aiRowsHashOf(input.ohlc), screenshot: input.screenshot, screenshotAtMs: input.screenshot.capturedAtMs,
      detectedAtMs: input.detectedAtMs ?? now, publishedAtMs: now, supersedes: latest.version, reason: input.reason, validity: { valid: true, reasons: [] },
    };
    // an update whose data is itself inconsistent (bad OHLC, repeated candle, hash...) never keeps a setup alive
    const problems = validateEvidence(ev);
    const validity = rec.status === 'INVALIDATED' ? { valid: false, reasons: [rec.invalidReason ?? 'already invalidated'] }
      : problems.length ? { valid: false, reasons: problems } : revalidateSetup(orig, ev.ohlc);
    ev = freezeEvidence({ ...ev, validity });
    rec.versions.push(ev);
    this.metrics.count('updates');
    if (!validity.valid && rec.status !== 'INVALIDATED') {
      rec.status = 'INVALIDATED'; rec.invalidReason = validity.reasons[0] ?? 'invalidated';
      this.metrics.count('invalidated');
      this.cancel(rec, `the updated chart (version ${ev.version}) invalidates the setup: ${rec.invalidReason}`);
    }
    this.emit({ type: 'update', ev });
    return { status: validity.valid ? 'UPDATED' : 'INVALIDATED', candidate: ev, deliveries: this.broadcast(ev, 'update') };
  }

  private cancel(rec: CandidateRecord, reason: string) {
    const last = rec.versions[rec.versions.length - 1];
    const d: CandidateDecision = { candidateId: rec.id, evaluatedVersion: rec.decision?.evaluatedVersion ?? last.version, latestVersion: last.version, candleSetHash: rec.decision?.candleSetHash ?? last.candleSetHash, action: 'CANCELLED', reasons: [reason], decidedAtMs: this.clock(), corroboratedBy: [] };
    if (rec.decision) rec.decisionHistory.push(rec.decision);
    rec.decision = d;
    this.resolve(rec.id, d);
    this.emit({ type: 'decision', ev: rec.versions[0], decision: d });
  }

  // ---------------------------------------------------------------------------------------------- results + decision
  /** Stores a recipient's result only when it names a real version AND the hash of that version's candles. Anything else is rejected and kept for the audit. */
  recordResult(r: ResultBase & { kind: string }): { accepted: boolean; reason: string } {
    const rec = this.recs.get(r.candidateId);
    const refuse = (reason: string) => { this.metrics.count('inconsistentResults'); rec?.rejectedResults.push({ recipient: r.recipient, version: r.version, reason }); if (rec) this.emit({ type: 'result', ev: rec.versions[0], result: r as any, accepted: false }); return { accepted: false, reason }; };
    if (!rec) return refuse('result for an unknown candidate');
    const ev = rec.versions[r.version - 1];
    if (!Number.isInteger(r.version) || !ev) return refuse(`result names version ${r.version}, which does not exist`);
    if (ev.candleSetHash !== r.candleSetHash) return refuse(`result's candle-set hash does not match version ${r.version}`);
    rec.results.push(r);
    if (rec.results.length > 200) rec.results.shift();
    this.emit({ type: 'result', ev, result: r as any, accepted: true });
    return { accepted: true, reason: 'ok' };
  }

  setDecision(d: Omit<CandidateDecision, 'decidedAtMs' | 'latestVersion'>): CandidateDecision {
    const rec = this.recs.get(d.candidateId);
    if (!rec) throw new Error(`unknown candidate ${d.candidateId}`);
    const latest = rec.versions[rec.versions.length - 1];
    let out: CandidateDecision = { ...d, latestVersion: latest.version, decidedAtMs: this.clock() };
    if (rec.status === 'INVALIDATED') out = { ...out, action: 'CANCELLED', reasons: [`cancelled: ${rec.invalidReason}`, ...out.reasons] };   // a late approval never revives an invalidated setup
    if (rec.decision?.action === 'CANCELLED') { rec.decisionHistory.push(out); return rec.decision; }
    if (rec.decision) rec.decisionHistory.push(rec.decision);
    rec.decision = out;
    if (rec.status !== 'INVALIDATED') rec.status = out.action === 'EXECUTE' ? 'VERIFIED' : 'REJECTED';
    this.metrics.count('decisions');
    this.resolve(rec.id, out);
    this.emit({ type: 'decision', ev: rec.versions[0], decision: out });
    return out;
  }

  private resolve(id: string, d: CandidateDecision) {
    const w = this.waiters.get(id); this.waiters.delete(id);
    w?.forEach((f) => f(d));
  }

  /** Resolves with the decision as soon as there is one; null when `ms` pass first. */
  waitForDecision(id: string, ms: number): Promise<CandidateDecision | null> {
    const rec = this.recs.get(id);
    if (!rec) return Promise.resolve(null);
    if (rec.decision) return Promise.resolve(rec.decision);
    return new Promise((resolve) => {
      const t = setTimeout(() => { const l = this.waiters.get(id); if (l) this.waiters.set(id, l.filter((f) => f !== fn)); resolve(null); }, ms);
      (t as any)?.unref?.();
      const fn = (d: CandidateDecision | null) => { clearTimeout(t); resolve(d); };
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), fn]);
    });
  }

  // ---------------------------------------------------------------------------------------------- execution freshness
  /** The last word before an order: not invalidated, not stale, not executed, the decision still matches the stored evidence. */
  executionCheck(id: string, c: { nowSec: number; maxEntryDelaySec: number }): ExecutionCheck {
    const rec = this.recs.get(id);
    const no = (reason: string, rec2?: CandidateRecord): ExecutionCheck => ({ ok: false, reason, latestVersion: rec2 ? rec2.versions.length : null, evaluatedVersion: rec2?.decision?.evaluatedVersion ?? null });
    if (!rec) return no('unknown candidate');
    const latest = rec.versions[rec.versions.length - 1];
    if (rec.status === 'INVALIDATED' || !latest.validity.valid) return no(`candidate invalidated: ${rec.invalidReason ?? latest.validity.reasons[0] ?? 'the chart changed'}`, rec);
    if (rec.executed) return no('this candidate was already executed', rec);
    const age = c.nowSec - latest.signalCandleClose;
    if (age < 0) return no(`the signal candle has not closed yet (${Math.round(-age)}s left)`, rec);
    if (age > c.maxEntryDelaySec) return no(`stale: ${Math.round(age)}s after the candle close (limit ${c.maxEntryDelaySec}s)`, rec);
    const d = rec.decision;
    if (d) {
      if (d.action !== 'EXECUTE') return no(`decision is ${d.action}: ${d.reasons[0] ?? ''}`, rec);
      const ev = rec.versions[d.evaluatedVersion - 1];
      if (!ev || ev.candleSetHash !== d.candleSetHash) return no('the decision does not match the stored evidence (hash mismatch)', rec);
    }
    return { ok: true, reason: `fresh (${Math.round(age)}s) and valid on version ${latest.version}`, latestVersion: latest.version, evaluatedVersion: d?.evaluatedVersion ?? null };
  }

  /** Called when the order is really sent. Records the decision-to-order latency and blocks any second order for this candidate. */
  markExecuted(id: string): boolean {
    const rec = this.recs.get(id);
    if (!rec || rec.executed) return false;
    rec.executed = true;
    this.metrics.count('executed');
    if (rec.decision) this.metrics.record('execution', this.clock() - rec.decision.decidedAtMs);
    return true;
  }
  unmarkExecuted(id: string) { const r = this.recs.get(id); if (r) r.executed = false; }   // the broker refused the order: the candidate may be tried again

  // ---------------------------------------------------------------------------------------------- reading
  get(id: string): CandidateRecord | undefined { return this.recs.get(id); }
  list(limit = 50): CandidateRecord[] { return [...this.recs.values()].slice(-limit).reverse(); }
  findByCandle(symbol: string, tf: number, signalCandleOpen: number): CandidateRecord[] {
    return [...this.recs.values()].filter((r) => r.symbol === symbol && r.tf === tf && r.signalCandleOpen === signalCandleOpen);
  }
  /** candidates of this market whose chart is still worth refreshing: waiting for a decision, or approved and not yet traded, inside the live window */
  activeFor(symbol: string, nowSec: number): CandidateRecord[] {
    return [...this.recs.values()].filter((r) => r.symbol === symbol && (r.status === 'PENDING' || r.status === 'VERIFIED') && !r.executed && nowSec <= r.signalCandleOpen + r.tf + this.liveWindowSec);
  }
  hasActive(symbol: string, nowSec: number) { return this.activeFor(symbol, nowSec).length > 0; }
}

const errText = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 160);

/** the hub the server uses */
export const candidateHub = new CandidateHub();
