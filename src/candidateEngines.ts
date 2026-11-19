// The three strategy engines as RECIPIENTS of a candidate. Each one reads the identical evidence (the candidate's candles) with
// its own unchanged rules from src/sweepEngines.ts and answers on its own. Nothing here invents a rule.
import { validOhlc } from './candleMath';
import { C, EngineName, Verdict, detectContinuation, detectLscc, detectMomentum, detectStochRsi, detectStructureSweep, detectWickSweep, isFlat } from './sweepEngines';
import type { Bar } from './patternVerification';
import type { CandidateEvidence, Side, Validity } from './candidateTypes';

/** the number of candles an engine gets to look at: the same window the market agents use */
export const ENGINE_WINDOW = 45;
export const ENGINE_NAMES: EngineName[] = ['sweep', 'continuation', 'momentum'];

export function runEngine(engine: EngineName, win: C[]): Verdict | null {
  if (win.length < 2 || win.slice(-8).some(isFlat)) return null;      // broker filler candles are not price action
  const i = win.length - 1;
  if (engine === 'sweep') return detectWickSweep(win, i);
  if (engine === 'continuation') return detectContinuation(win, i);
  if (engine === 'lscc') return detectLscc(win, i);
  if (engine === 'stoch_rsi') return detectStochRsi(win, i);
  if (engine === 'structure_sweep') return detectStructureSweep(win, i);
  return detectMomentum(win, i);
}

/** the engine window that ends on the signal candle (null = that candle is not in the data) */
export function windowAt(ohlc: readonly Bar[], signalOpen: number, size = ENGINE_WINDOW): C[] | null {
  const idx = ohlc.findIndex((c) => c.time === signalOpen);
  return idx < 0 ? null : (ohlc.slice(Math.max(0, idx - size + 1), idx + 1) as C[]);
}

export interface ResultBase {
  candidateId: string;
  /** which evidence version this result looked at, and the hash of that exact candle set */
  version: number;
  candleSetHash: string;
  recipient: string;
  durationMs: number;
  atMs: number;
}

export type EngineStatus = 'CONFIRMS' | 'NO_SIGNAL' | 'SKIP' | 'OPPOSITE' | 'ERROR';
export interface EngineConsumerResult extends ResultBase {
  kind: 'engine';
  engine: EngineName;
  status: EngineStatus;
  side: Side | null;
  ok: boolean | null;
  trace: string[];
  error?: string;
}

/** One engine reads one evidence version. CONFIRMS = it fires TAKE in the candidate's direction. OPPOSITE = it fires TAKE the other way. */
export function evaluateEngine(engine: EngineName, ev: CandidateEvidence, now: () => number, perf: () => number): EngineConsumerResult {
  const t0 = perf();
  const base = { kind: 'engine' as const, candidateId: ev.candidateId, version: ev.version, candleSetHash: ev.candleSetHash, recipient: `engine:${engine}`, engine };
  const done = (r: Pick<EngineConsumerResult, 'status' | 'side' | 'ok' | 'trace'> & { error?: string }): EngineConsumerResult => ({ ...base, ...r, durationMs: perf() - t0, atMs: now() });
  try {
    const win = windowAt(ev.ohlc, ev.signalCandleOpen, ev.engineWindow);
    if (!win) return done({ status: 'ERROR', side: null, ok: null, trace: [], error: 'the signal candle is not in the candle set' });
    const v = runEngine(engine, win);
    if (!v) return done({ status: 'NO_SIGNAL', side: null, ok: null, trace: [] });
    if (!v.ok) return done({ status: 'SKIP', side: v.side, ok: false, trace: [v.block ?? 'skipped'] });
    return done({ status: v.side === ev.direction ? 'CONFIRMS' : 'OPPOSITE', side: v.side, ok: true, trace: v.trace ?? v.notes });
  } catch (e) {
    return done({ status: 'ERROR', side: null, ok: null, trace: [], error: ((e as Error)?.message ?? String(e)).slice(0, 160) });
  }
}

/**
 * Does the ORIGINAL setup still stand on this newer candle set? It must, at the same time:
 *  - contain the signal candle and keep every candle of the pattern exactly as it was (a revised candle changes the pattern),
 *  - be a clean candle sequence (valid OHLC, strictly increasing times, no repeated candle),
 *  - still make the original engine fire TAKE in the original direction, on the window that ends on the signal candle.
 * Newer candles after the signal candle do NOT cancel a setup by themselves: how late is too late is the freshness check.
 */
export function revalidateSetup(orig: CandidateEvidence, ohlc: readonly Bar[]): Validity {
  const reasons: string[] = [];
  for (let i = 0; i < ohlc.length; i++) {
    if (!validOhlc(ohlc[i] as any)) { reasons.push(`invalid OHLC at ${ohlc[i].time}`); break; }
    if (i && ohlc[i].time <= ohlc[i - 1].time) { reasons.push(`candle times are not increasing at ${ohlc[i].time}`); break; }
  }
  const idx = ohlc.findIndex((c) => c.time === orig.signalCandleOpen);
  if (idx < 0) reasons.push('the signal candle is missing from the updated chart');
  else {
    for (const was of orig.ohlc) {
      if (was.time < orig.patternFrom || was.time > orig.signalCandleOpen) continue;
      const now = ohlc.find((c) => c.time === was.time);
      if (!now) reasons.push(`pattern candle ${was.time} is missing`);
      else if (now.open !== was.open || now.high !== was.high || now.low !== was.low || now.close !== was.close) reasons.push(`pattern candle ${was.time} was revised (${was.open}/${was.high}/${was.low}/${was.close} -> ${now.open}/${now.high}/${now.low}/${now.close})`);
    }
    if (!reasons.length) {
      const win = windowAt(ohlc, orig.signalCandleOpen, orig.engineWindow)!;
      const v = runEngine(orig.engine, win);
      if (!v) reasons.push(`the ${orig.engine} engine no longer finds the setup on the updated candles`);
      else if (!v.ok) reasons.push(`the ${orig.engine} engine now SKIPS the setup: ${v.block ?? 'no reason'}`);
      else if (v.side !== orig.direction) reasons.push(`the ${orig.engine} engine now points ${v.side}, not ${orig.direction}`);
    }
  }
  return { valid: reasons.length === 0, reasons };
}
