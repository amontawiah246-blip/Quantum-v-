// What does the FOURTH candle do after each Engine 7 classification? Pure statistics on closed candles, no trading assumptions.
//
// For every classification (THREE_STRONG, WEAK_STRONG_STRONG, MIXED_STRENGTH) and for a control (any three same-colour candles) it counts
// how often the fourth candle closed in the same direction as the three (continuation), the other way (reversal) or flat, with a 95%
// Wilson interval on the continuation share among decided candles, and the same split on the chronological train / validation / test
// segments of each instrument. This is NOT a trade result: the trade result (entry at the next open, expiry, payout) is in the backtester.
// A fourth-candle rate near 50% with an interval that contains 50% means no demonstrated tendency either way.
import { Candle, contiguous, validOhlc } from './candleMath';
import { cleanCandles, wilson, Dataset, Segment } from './engineBacktest';
import { SEQUENCE_DEFAULTS, SequenceClass, SequenceParams, classifySequence } from './sequenceClassifier';

export type SeqKey = SequenceClass | 'ANY_THREE_SAME_COLOUR';
export interface FourthStats {
  n: number; continued: number; reversed: number; flat: number;
  continuationRate: number | null;       // continued / (continued + reversed)
  ciLow: number | null; ciHigh: number | null;
  verdict: 'continues more than 50%' | 'reverses more than 50%' | 'no demonstrated tendency' | 'n/a';
}
export interface FourthCandleReport {
  byClass: Record<SeqKey, FourthStats>;
  bySegment: Record<SeqKey, Record<Segment, FourthStats>>;
  byInstrument: Record<string, Record<SeqKey, FourthStats>>;
  note: string;
}

const KEYS: SeqKey[] = ['THREE_STRONG', 'WEAK_STRONG_STRONG', 'MIXED_STRENGTH', 'ANY_THREE_SAME_COLOUR'];
type Acc = { c: number; r: number; f: number };
const blank = (): Acc => ({ c: 0, r: 0, f: 0 });
function finish(a: Acc): FourthStats {
  const dec = a.c + a.r, ci = wilson(a.c, dec);
  return {
    n: a.c + a.r + a.f, continued: a.c, reversed: a.r, flat: a.f,
    continuationRate: dec ? a.c / dec : null, ciLow: ci ? ci[0] : null, ciHigh: ci ? ci[1] : null,
    verdict: !ci ? 'n/a' : ci[0] > 0.5 ? 'continues more than 50%' : ci[1] < 0.5 ? 'reverses more than 50%' : 'no demonstrated tendency',
  };
}

export function fourthCandleStats(data: Dataset[], p: SequenceParams = SEQUENCE_DEFAULTS, split = { train: 0.6, validation: 0.2 }): FourthCandleReport {
  const total = Object.fromEntries(KEYS.map((k) => [k, blank()])) as Record<SeqKey, Acc>;
  const seg = Object.fromEntries(KEYS.map((k) => [k, { train: blank(), validation: blank(), test: blank() }])) as Record<SeqKey, Record<Segment, Acc>>;
  const inst: Record<string, Record<SeqKey, Acc>> = {};
  for (const ds of data) {
    const { candles: cs } = cleanCandles(ds.candles);
    const n = cs.length, trainEnd = Math.floor(n * split.train), valEnd = Math.floor(n * (split.train + split.validation));
    const per = (inst[ds.symbol] = Object.fromEntries(KEYS.map((k) => [k, blank()])) as Record<SeqKey, Acc>);
    for (let i = 2; i < n - 1; i++) {
      const r = classifySequence(cs, i, p);
      if (!r) continue;
      const d = cs[i + 1];
      if (!validOhlc(d) || d.closed === false || !contiguous([cs[i], d])) continue;
      const same = r.direction === 'BULL' ? d.close > d.open : d.close < d.open;
      const opp = r.direction === 'BULL' ? d.close < d.open : d.close > d.open;
      const s: Segment = i + 1 < trainEnd ? 'train' : i + 1 < valEnd ? 'validation' : 'test';
      for (const k of [r.classification, 'ANY_THREE_SAME_COLOUR'] as SeqKey[]) {
        for (const a of [total[k], seg[k][s], per[k]]) { if (same) a.c++; else if (opp) a.r++; else a.f++; }
      }
    }
  }
  return {
    byClass: Object.fromEntries(KEYS.map((k) => [k, finish(total[k])])) as Record<SeqKey, FourthStats>,
    bySegment: Object.fromEntries(KEYS.map((k) => [k, { train: finish(seg[k].train), validation: finish(seg[k].validation), test: finish(seg[k].test) }])) as Record<SeqKey, Record<Segment, FourthStats>>,
    byInstrument: Object.fromEntries(Object.entries(inst).map(([s, v]) => [s, Object.fromEntries(KEYS.map((k) => [k, finish(v[k])]))])) as Record<string, Record<SeqKey, FourthStats>>,
    note: 'Fourth candle = the candle right after the three. Continuation rate = share closing the same way as the three among candles that closed up or down. Hypotheses are tested separately; none is assumed true.',
  };
}

export function renderFourthCandle(r: FourthCandleReport): string {
  const L: string[] = ['FOURTH-CANDLE OUTCOMES (Engine 7)'];
  const f = (x: number | null) => (x === null ? 'n/a' : (x * 100).toFixed(1) + '%');
  const row = (name: string, s: FourthStats) => `${name.padEnd(26)} n=${String(s.n).padStart(6)}  continued ${String(s.continued).padStart(6)}  reversed ${String(s.reversed).padStart(6)}  flat ${String(s.flat).padStart(4)}  continuation ${f(s.continuationRate).padStart(6)} [${f(s.ciLow)}..${f(s.ciHigh)}]  ${s.verdict}`;
  for (const k of KEYS) {
    L.push(row(k, r.byClass[k]));
    for (const sg of ['train', 'validation', 'test'] as const) L.push(row(`   ${sg}`, r.bySegment[k][sg]));
  }
  L.push(r.note);
  return L.join('\n');
}
