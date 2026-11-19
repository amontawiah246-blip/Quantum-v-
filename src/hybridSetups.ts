// STAGE 1: IS THERE A LEGITIMATE CANDLESTICK SETUP?
//
// Runs every original pattern with its ORIGINAL parameters and reports which ones fired on the newest closed candle. No indicator, no
// model and no configuration option can create, remove or alter a setup here. (`STAGE1_FROZEN` is the single place the parameters are
// taken from; a test asserts it equals the defaults of the original engines and that the hits equal the original detectors' output.)
//
//   BEARISH_SWEEP           Pattern 1 (SELL)            src/sweepPatterns.ts
//   BULLISH_SWEEP           Pattern 2 (BUY)             src/sweepPatterns.ts
//   EQ_UPPER_WICK_SWEEP     equal-highs wick sweep (SELL)   src/equalLevelSweeps.ts   (new in this layer, see its header)
//   EQ_LOWER_WICK_SWEEP     equal-lows wick sweep (BUY)     src/equalLevelSweeps.ts
//   SWEEP_CONTINUATION      Engine 5: sweep + two confirming closes
//   MOMENTUM_BODY_DOMINANCE Engine 6: three-candle body dominance
//   WEAK_STRONG_STRONG      Engine 7: weak first candle, strong second and third (side = Engine 7's exhaustion/reversal hypothesis)
//   REPEATED_SWEEP          Engine 9: this candle is the 2nd or later sweep of its cluster
// Several patterns can fire on one candle for the same side; that is ONE observation with several pattern flags.
import { Candle, Tracer, contiguous, validOhlc } from './candleMath';
import { CONTINUATION_DEFAULTS, detectContinuationSignal, sequenceState } from './continuationEngine';
import { MOMENTUM_DEFAULTS, detectMomentumSignal, evaluateMomentum } from './momentumEngine';
import { SEQUENCE_DEFAULTS, classifySequence } from './sequenceClassifier';
import { checkSweep } from './sweepPatterns';
import { EQUAL_LEVEL_DEFAULTS, checkEqualLevelSweep } from './equalLevelSweeps';
import { SweepEvent } from './sweepIntelligence';

export type Side = 'BUY' | 'SELL';
export type PatternId =
  | 'BEARISH_SWEEP' | 'BULLISH_SWEEP' | 'EQ_UPPER_WICK_SWEEP' | 'EQ_LOWER_WICK_SWEEP'
  | 'SWEEP_CONTINUATION' | 'MOMENTUM_BODY_DOMINANCE' | 'WEAK_STRONG_STRONG' | 'REPEATED_SWEEP';

/** Order = priority when one pattern has to be named as the "primary" one (most specific first). */
export const PATTERN_IDS: PatternId[] = ['SWEEP_CONTINUATION', 'MOMENTUM_BODY_DOMINANCE', 'WEAK_STRONG_STRONG', 'EQ_UPPER_WICK_SWEEP', 'EQ_LOWER_WICK_SWEEP', 'REPEATED_SWEEP', 'BEARISH_SWEEP', 'BULLISH_SWEEP'];
export const CONTINUATION_FAMILY: PatternId[] = ['SWEEP_CONTINUATION', 'MOMENTUM_BODY_DOMINANCE'];

export const STAGE1_FROZEN = Object.freeze({
  sweepDefinition: CONTINUATION_DEFAULTS,       // Pattern 1/2 incl. the wick-only rule, exactly as Engine 5 uses it
  continuation: CONTINUATION_DEFAULTS,
  momentum: MOMENTUM_DEFAULTS,
  sequence: SEQUENCE_DEFAULTS,
  equalLevel: EQUAL_LEVEL_DEFAULTS,
});

export interface PatternHit { id: PatternId; side: Side; notes: string[]; level: number | null }
export interface FunnelEntry { pattern: PatternId; side: Side | '-'; /** null = the pattern fired */ firstFailed: string | null }
export interface Stage1Result { hits: PatternHit[]; funnel: FunnelEntry[] }

/** Sweep path common to Patterns 1/2: both candles valid, closed and consecutive, then the sweep checks (first failure recorded). */
function pattern12(cs: Candle[], i: number, side: Side): { ok: boolean; failed: string | null } {
  if (i < 1) return { ok: false, failed: 'not enough candles' };
  const P = cs[i - 1], A = cs[i];
  if (!validOhlc(P) || !validOhlc(A) || P.closed === false || A.closed === false) return { ok: false, failed: 'candle invalid or unfinished' };
  if (!contiguous([P, A])) return { ok: false, failed: 'candles not consecutive' };
  const t = new Tracer(false);
  const ok = checkSweep(t, side === 'SELL' ? 'SELL' : 'BUY', P, A, STAGE1_FROZEN.sweepDefinition);
  return { ok, failed: ok ? null : t.result().failed };
}

export function detectStage1(cs: Candle[], i: number, sweepOnCandle: SweepEvent | null, collectFunnel = false): Stage1Result {
  const hits: PatternHit[] = [];
  const funnel: FunnelEntry[] = [];
  const note = (e: FunnelEntry) => { if (collectFunnel) funnel.push(e); };

  // ---- Patterns 1 and 2
  for (const [id, side] of [['BEARISH_SWEEP', 'SELL'], ['BULLISH_SWEEP', 'BUY']] as const) {
    const r = pattern12(cs, i, side);
    if (r.ok) hits.push({ id, side, notes: [side === 'SELL' ? 'bullish candle swept by a bearish candle that wicked above its high and closed inside its body' : 'bearish candle swept by a bullish candle that wicked below its low and closed inside its body'], level: side === 'SELL' ? cs[i - 1].high : cs[i - 1].low });
    note({ pattern: id, side, firstFailed: r.failed });
  }
  // ---- equal-level wick sweeps
  for (const [id, side] of [['EQ_UPPER_WICK_SWEEP', 'SELL'], ['EQ_LOWER_WICK_SWEEP', 'BUY']] as const) {
    const t = new Tracer(false);
    const h = checkEqualLevelSweep(t, side, cs, i, STAGE1_FROZEN.equalLevel);
    if (h) hits.push({ id, side, notes: [`${h.touches} equal ${side === 'SELL' ? 'highs' : 'lows'} at ${h.level} swept`], level: h.level });
    note({ pattern: id, side, firstFailed: h ? null : t.result().failed });
  }
  // ---- Engine 5 (three-candle sweep continuation)
  const cont = detectContinuationSignal(cs, i, STAGE1_FROZEN.continuation);
  if (cont) hits.push({ id: 'SWEEP_CONTINUATION', side: cont.side, notes: ['sweep + two confirming closes'], level: cont.sweptLevel });
  if (collectFunnel && !cont) {
    // the more informative of the two directions: the one that got furthest
    const order = ['NO_SWEEP', 'AWAITING_B', 'AWAITING_C', 'INVALIDATED'];
    const evs = (['SELL', 'BUY'] as const).map((s) => sequenceState(cs, i - 2, s, STAGE1_FROZEN.continuation, false));
    const e = evs.sort((a, b) => order.indexOf(b.state) - order.indexOf(a.state))[0];
    note({ pattern: 'SWEEP_CONTINUATION', side: '-', firstFailed: e.state === 'NO_SWEEP' ? `no sweep: ${e.trace.failed ?? e.reason}` : `${e.state.toLowerCase()}: ${e.reason}` });
  } else if (cont) note({ pattern: 'SWEEP_CONTINUATION', side: cont.side, firstFailed: null });
  // ---- Engine 6 (three-candle body dominance)
  const mom = detectMomentumSignal(cs, i, STAGE1_FROZEN.momentum);
  if (mom) hits.push({ id: 'MOMENTUM_BODY_DOMINANCE', side: mom.side, notes: [`${mom.strongCount} of 3 strong candles`], level: mom.startLevel });
  if (collectFunnel) note({ pattern: 'MOMENTUM_BODY_DOMINANCE', side: mom ? mom.side : '-', firstFailed: mom ? null : evaluateMomentum(cs, i, STAGE1_FROZEN.momentum, false).failed ?? 'rejected' });
  // ---- Engine 7 weak-strong-strong
  const seq = classifySequence(cs, i, STAGE1_FROZEN.sequence);
  if (seq && seq.classification === 'WEAK_STRONG_STRONG' && seq.hypothesis.side) hits.push({ id: 'WEAK_STRONG_STRONG', side: seq.hypothesis.side, notes: seq.reasons, level: null });
  if (collectFunnel) note({ pattern: 'WEAK_STRONG_STRONG', side: seq?.classification === 'WEAK_STRONG_STRONG' && seq.hypothesis.side ? seq.hypothesis.side : '-', firstFailed: !seq ? 'not three same-direction candles' : seq.classification === 'WEAK_STRONG_STRONG' ? null : `classified ${seq.classification}` });
  // ---- Engine 9 repeated sweep (needs the sweep tracker's cluster ordinal)
  if (sweepOnCandle && sweepOnCandle.ordinal >= 2) hits.push({ id: 'REPEATED_SWEEP', side: sweepOnCandle.side, notes: [`sweep #${sweepOnCandle.ordinal} of its cluster (${sweepOnCandle.alignment.replace('_', '-').toLowerCase()})`], level: sweepOnCandle.level });
  if (collectFunnel) note({ pattern: 'REPEATED_SWEEP', side: sweepOnCandle ? sweepOnCandle.side : '-', firstFailed: !sweepOnCandle ? 'no sweep on this candle' : sweepOnCandle.ordinal >= 2 ? null : 'first sweep of its cluster' });
  return { hits, funnel };
}

/** One candidate per side: all patterns that fired for that side on this candle. */
export interface SideCandidate { side: Side; patterns: PatternId[]; primary: PatternId; notes: string[]; family: 'CONTINUATION' | 'REVERSAL' }
export function groupBySide(hits: PatternHit[]): SideCandidate[] {
  const out: SideCandidate[] = [];
  for (const side of ['BUY', 'SELL'] as const) {
    const hs = hits.filter((h) => h.side === side);
    if (!hs.length) continue;
    const patterns = PATTERN_IDS.filter((id) => hs.some((h) => h.id === id));
    const primary = patterns[0];
    out.push({ side, patterns, primary, notes: hs.flatMap((h) => h.notes), family: CONTINUATION_FAMILY.includes(primary) ? 'CONTINUATION' : 'REVERSAL' });
  }
  return out;
}
