// THE VERIFICATION COORDINATOR. It is one of the hub's recipients groups: when a candidate is published it receives the evidence
// as three strategy-engine recipients plus the AI/hybrid pipeline recipient, all at once. Each answers independently, tagged with the
// candidate version and the candle-set hash it read. The coordinator collects the answers, aggregates them, revalidates the original
// setup, and records ONE decision (EXECUTE | REJECT | CANCELLED).
//
// It never trades, never changes a strategy rule and never lets an answer about different evidence count.
// One slow engine or AI request only delays its own candidate: every candidate is its own asynchronous task, the AI is called through
// a freshest-first limiter that skips candidates that can no longer be traded, and every wait has a timeout.
import { CandidateHub, CandidateDecision } from './candidateHub';
import type { CandidateEvidence, Side } from './candidateTypes';
import { ENGINE_NAMES, EngineConsumerResult, ResultBase, evaluateEngine } from './candidateEngines';
import type { EngineName } from './sweepEngines';
import { PriorityLimiter, withTimeout } from './concurrency';

/** What the AI / hybrid pipeline says about one candidate (the live wiring maps src/../signalServer.ts's Signal onto this). */
export interface PipelineAnswer {
  tradeable: boolean;
  side: Side | null;
  status: string;
  reasons: string[];
  /** sha256 of the PNG the model was really given (null = no image) and the hash printed on that request */
  imageSha256: string | null;
  aiRowsHash: string | null;
  /** the full signal, kept for the execution path */
  signal?: unknown;
}
export type PipelineRunner = (ev: CandidateEvidence, ctx: { nowSec: number }) => Promise<PipelineAnswer>;
export type EngineRunner = (engine: EngineName, ev: CandidateEvidence) => Promise<EngineConsumerResult>;

export interface AiConsumerResult extends ResultBase {
  kind: 'ai';
  status: 'DONE' | 'ERROR' | 'TIMEOUT' | 'SKIPPED';
  answer: PipelineAnswer | null;
  detail: string;
}

export interface CoordinatorOptions {
  pipeline: PipelineRunner;
  /** the broker's clock in seconds */
  nowSec: () => number;
  maxEntryDelaySec?: number;
  aiTimeoutMs?: number;
  aiConcurrency?: number;
  /** replace the default engine recipients (tests make them slow); must read only the evidence they are given */
  engineRunner?: EngineRunner;
  perf?: () => number;
  /** false = nothing is verified (no engine runs, no AI request is made). AutoTrade switches this on and off; the agents keep publishing either way. */
  enabled?: () => boolean;
}

export interface Collected {
  candidateId: string;
  engines: Map<EngineName, EngineConsumerResult>;
  ai: AiConsumerResult | null;
  decided: boolean;
  lastResultPerf: number;
}

/** Pure aggregation of the independent answers about ONE evidence version. */
export function aggregate(ev: CandidateEvidence, engines: Map<EngineName, EngineConsumerResult>, ai: AiConsumerResult | null): { action: 'EXECUTE' | 'REJECT'; reasons: string[]; corroboratedBy: string[]; signal?: unknown } {
  const reasons: string[] = [];
  const evalNames: EngineName[] =
    ev.engine === 'stoch_rsi'
      ? [...ENGINE_NAMES, 'stoch_rsi']
      : ev.engine === 'lscc'
      ? [...ENGINE_NAMES, 'lscc']
      : ev.engine === 'structure_sweep'
        ? [...ENGINE_NAMES, 'structure_sweep']
        : ENGINE_NAMES;
  const corroboratedBy: EngineName[] = evalNames.filter((n) => engines.get(n)?.status === 'CONFIRMS');
  const primary = engines.get(ev.engine);
  if (!primary) reasons.push(`the ${ev.engine} engine gave no answer`);
  else if (primary.status !== 'CONFIRMS') reasons.push(`the ${ev.engine} engine does not reconfirm the setup (${primary.status}${primary.error ? `: ${primary.error}` : ''})`);
  // an engine that failed or answered about different evidence is not an engine that agreed: the candidate is not traded on a partial verification
  for (const n of ENGINE_NAMES) { const r = engines.get(n); if (r && n !== ev.engine && r.status === 'ERROR') reasons.push(`the ${n} engine failed: ${r.error ?? 'error'}`); }
  const opposite = ENGINE_NAMES.filter((n) => engines.get(n)?.status === 'OPPOSITE');
  if (opposite.length) reasons.push(`conflict: ${opposite.join(', ')} signal${opposite.length > 1 ? '' : 's'} the opposite side on the same candle`);
  const answer = ai?.answer ?? null;
  if (!ai) reasons.push('no AI / hybrid answer');
  else if (ai.status !== 'DONE' || !answer) reasons.push(`AI / hybrid verification ${ai.status.toLowerCase()}: ${ai.detail}`);
  else {
    if (!answer.tradeable) reasons.push(`AI / hybrid verification does not allow it: ${answer.status}${answer.reasons.length ? ` (${answer.reasons[0]})` : ''}`);
    if (answer.side && answer.side !== ev.direction) reasons.push(`direction mismatch: candidate ${ev.direction}, AI pipeline ${answer.side}`);
    // the model must have been given THIS candidate's screenshot and candles
    if (answer.imageSha256 && ev.screenshot.pngSha256 && answer.imageSha256 !== ev.screenshot.pngSha256) reasons.push('the AI inspected a different screenshot than the candidate evidence');
    if (answer.aiRowsHash && answer.aiRowsHash !== ev.aiRowsHash) reasons.push('the AI request used a different candle set than the candidate evidence');
  }
  return reasons.length ? { action: 'REJECT', reasons, corroboratedBy } : { action: 'EXECUTE', reasons: ['all independent checks agree on this evidence version'], corroboratedBy, signal: answer?.signal };
}

export class VerificationCoordinator {
  private collected = new Map<string, Collected>();
  private limiter: PriorityLimiter;
  private perf: () => number;
  private maxDelay: number; private aiTimeout: number;
  private engineRunner: EngineRunner;
  private unsub: (() => void)[] = [];

  constructor(private hub: CandidateHub, private o: CoordinatorOptions) {
    this.perf = o.perf ?? (() => performance.now());
    this.limiter = new PriorityLimiter(o.aiConcurrency ?? 2);
    this.maxDelay = o.maxEntryDelaySec ?? 45;
    this.aiTimeout = o.aiTimeoutMs ?? 60000;
    this.engineRunner = o.engineRunner ?? (async (engine, ev) => evaluateEngine(engine, ev, Date.now, this.perf));
  }

  /** Registers the four recipients (three engines + the AI/hybrid pipeline) with the hub. */
  start() {
    for (const name of ENGINE_NAMES) this.unsub.push(this.hub.subscribe(`engine:${name}`, (ev, event) => this.onEngine(name, ev, event)));
    this.unsub.push(this.hub.subscribe('ai', (ev, event) => this.onAi(ev, event)));
    return this;
  }
  stop() { this.unsub.forEach((u) => u()); this.unsub = []; }
  get(id: string) { return this.collected.get(id); }

  private slot(id: string): Collected {
    let c = this.collected.get(id);
    if (!c) { c = { candidateId: id, engines: new Map(), ai: null, decided: false, lastResultPerf: 0 }; this.collected.set(id, c); if (this.collected.size > 400) this.collected.delete(this.collected.keys().next().value as string); }
    return c;
  }

  private on() { return this.o.enabled ? this.o.enabled() : true; }

  private async onEngine(name: EngineName, ev: CandidateEvidence, event: 'candidate' | 'update') {
    if (event === 'candidate' && ev.version === 1 && name === ENGINE_NAMES[0] && this.on()) this.hub.emit({ type: 'forwarded', ev, recipients: this.hub.recipients });
    if (!this.on()) return;
    await null;                                                 // start after the broadcast loop, so all recipients really run side by side
    const r = await this.engineRunner(name, ev);
    this.hub.metrics.record(`engine:${name}`, r.durationMs);
    const ok = this.hub.recordResult(r);
    if (event !== 'candidate' || ev.version !== 1) return;     // updates are audited, only the original evidence is decided on
    const c = this.slot(ev.candidateId);
    // a result that does not match the stored evidence is never used: it counts as a failed engine, so the candidate is rejected
    c.engines.set(name, ok.accepted ? r : { ...r, status: 'ERROR', side: null, ok: null, error: `inconsistent result: ${ok.reason}` });
    c.lastResultPerf = this.perf();
    this.maybeDecide(ev);
  }

  private async onAi(ev: CandidateEvidence, event: 'candidate' | 'update') {
    if (event !== 'candidate' || ev.version !== 1 || !this.on()) return;      // the AI is asked once per candidate; updates are checked by revalidation, not by a new AI call
    await null;
    const t0 = this.perf();
    const base = { kind: 'ai' as const, candidateId: ev.candidateId, version: ev.version, candleSetHash: ev.candleSetHash, recipient: 'ai' };
    const fin = (status: AiConsumerResult['status'], answer: PipelineAnswer | null, detail: string): AiConsumerResult => ({ ...base, status, answer, detail, durationMs: this.perf() - t0, atMs: Date.now() });
    let res: AiConsumerResult;
    try {
      const out = await this.limiter.run(
        ev.signalCandleClose,                                       // freshest candle first
        () => withTimeout(this.o.pipeline(ev, { nowSec: this.o.nowSec() }), this.aiTimeout, 'AI / hybrid verification'),
        () => { const chk = this.hub.executionCheck(ev.candidateId, { nowSec: this.o.nowSec(), maxEntryDelaySec: this.maxDelay }); return chk.ok ? null : `not sent to the AI: ${chk.reason}`; },
      );
      res = 'value' in out ? fin('DONE', out.value, 'answered') : fin('SKIPPED', null, out.reason);
    } catch (e) {
      const m = ((e as Error)?.message ?? String(e)).slice(0, 160);
      res = fin(/timed out/.test(m) ? 'TIMEOUT' : 'ERROR', null, m);
    }
    this.hub.metrics.record('ai', res.durationMs);
    const ok = this.hub.recordResult(res);
    const c = this.slot(ev.candidateId);
    c.ai = ok.accepted ? res : { ...res, status: 'ERROR', answer: null, detail: `inconsistent result: ${ok.reason}` };
    c.lastResultPerf = this.perf();
    this.maybeDecide(ev);
  }

  private maybeDecide(ev: CandidateEvidence) {
    const c = this.slot(ev.candidateId);
    if (c.decided || !c.ai || !ENGINE_NAMES.every((n) => c.engines.has(n))) return;
    c.decided = true;
    const rec = this.hub.get(ev.candidateId)!;
    const v1 = rec.versions[0];
    // LSCC & Structure Sweep: each setup's own rules are re-run on the frozen evidence like an engine's (the three strategy engines above still read the same screenshot and candles)
    if (v1.engine === 'lscc' || v1.engine === 'structure_sweep' || v1.engine === 'stoch_rsi') {
      const lr = evaluateEngine(v1.engine, v1, Date.now, this.perf);
      this.hub.metrics.record(`engine:${v1.engine}`, lr.durationMs);
      const ok = this.hub.recordResult(lr);
      c.engines.set(v1.engine, ok.accepted ? lr : { ...lr, status: 'ERROR', side: null, ok: null, error: `inconsistent result: ${ok.reason}` });
    }
    const agg = aggregate(v1, c.engines, c.ai);
    let action: CandidateDecision['action'] = agg.action;
    const reasons = [...agg.reasons];
    if (action === 'EXECUTE') {
      // revalidate the ORIGINAL setup against the newest chart and the clock right before the decision
      const chk = this.hub.executionCheck(ev.candidateId, { nowSec: this.o.nowSec(), maxEntryDelaySec: this.maxDelay });
      if (!chk.ok) { action = 'REJECT'; reasons.splice(0, reasons.length, `execution check failed: ${chk.reason}`); }
    }
    this.hub.setDecision({ candidateId: ev.candidateId, evaluatedVersion: v1.version, candleSetHash: v1.candleSetHash, action, reasons, corroboratedBy: agg.corroboratedBy, signal: action === 'EXECUTE' ? agg.signal : undefined });
    this.hub.metrics.record('aggregation', this.perf() - c.lastResultPerf);   // from the last answer arriving to the decision being stored
  }
}
