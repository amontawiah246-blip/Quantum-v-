// ENGINE 7: THREE-CANDLE SEQUENCE CLASSIFIER.
//
// Looks at the last three CLOSED candles ending at index i. If all three close the same way it labels the sequence:
//   THREE_STRONG        all three strong-bodied, small combined wicks          -> a CONTINUATION candidate
//   WEAK_STRONG_STRONG  first candle comparatively weak, 2nd and 3rd strong     -> a possible EXHAUSTION / REVERSAL candidate
//   MIXED_STRENGTH      any other same-direction run                             -> no hypothesis, no BUY/SELL
// Anything that is not three same-direction candles (a doji or an opposite candle inside) returns null.
//
// The labels are HYPOTHESES, not predictions. Nothing here says WSS reverses or that three strong candles continue. `hypothesis` only
// names which side each label would be tested on; the backtester tests the hypothesis side AND the opposite side for every label,
// and `fourthCandleStats` (sequenceStats.ts) reports what the fourth candle really did. Reads candles <= i only. No indicators.
import { Anatomy, Candle, anatomy, contiguous, fmt, geq, isUnfinished, leq, validOhlc } from './candleMath';

export type SequenceClass = 'THREE_STRONG' | 'WEAK_STRONG_STRONG' | 'MIXED_STRENGTH';
export type SeqDirection = 'BULL' | 'BEAR';

export interface SequenceParams {
  strongBodyRatio: number;          // body/range at or above this = strong body (0.65)
  maxCombinedWickRatio: number;     // THREE_STRONG: (sum of wicks)/(sum of ranges) at or below this (0.30)
  weakBodyRatioMax: number;         // WSS: first candle body/range at or below this (0.50)
  weakBodyRatioMin: number;         // WSS: and at least this, so a doji-like sliver is not called "weak but directional" (0.10)
  weakVsStrongBodyMult: number;     // WSS: first body <= this x the smaller of the 2nd and 3rd bodies (0.75)
  requireContiguousTimes: boolean;
}
export const SEQUENCE_DEFAULTS: SequenceParams = {
  strongBodyRatio: 0.65, maxCombinedWickRatio: 0.3, weakBodyRatioMax: 0.5, weakBodyRatioMin: 0.1, weakVsStrongBodyMult: 0.75, requireContiguousTimes: true,
};

export interface SequenceResult {
  classification: SequenceClass;
  direction: SeqDirection;                       // the colour of the three candles
  hypothesis: { kind: 'CONTINUATION' | 'EXHAUSTION_REVERSAL' | null; side: 'BUY' | 'SELL' | null };  // side the hypothesis would trade; null for MIXED
  signalIndex: number; signalTime: number;
  strong: [boolean, boolean, boolean];
  bodyRatios: [number, number, number];
  combinedWickRatio: number;
  reasons: string[];
}

export function classifySequence(cs: Candle[], i: number, p: SequenceParams = SEQUENCE_DEFAULTS): SequenceResult | null {
  if (i < 2 || i >= cs.length) return null;
  const seq = [cs[i - 2], cs[i - 1], cs[i]];
  if (!seq.every((c) => validOhlc(c) && !isUnfinished(c))) return null;
  if (p.requireContiguousTimes && !contiguous(seq)) return null;
  const an = seq.map(anatomy);
  const bull = an.every((a) => a.direction === 'bull'), bear = an.every((a) => a.direction === 'bear');
  if (!bull && !bear) return null;
  const direction: SeqDirection = bull ? 'BULL' : 'BEAR';
  const strong = an.map((a) => geq(a.bodyRatio, p.strongBodyRatio)) as [boolean, boolean, boolean];
  const sumRange = an.reduce((s, a) => s + a.range, 0);
  const combinedWickRatio = sumRange > 0 ? an.reduce((s, a) => s + a.totalWick, 0) / sumRange : 1;
  const bodyRatios = an.map((a) => a.bodyRatio) as [number, number, number];

  let classification: SequenceClass = 'MIXED_STRENGTH';
  const reasons: string[] = [];
  const dirWord = bull ? 'bullish' : 'bearish';

  if (strong.every(Boolean) && leq(combinedWickRatio, p.maxCombinedWickRatio)) {
    classification = 'THREE_STRONG';
    reasons.push(`three ${dirWord} candles, body/range ${bodyRatios.map(fmt).join(' / ')} all >= ${fmt(p.strongBodyRatio)}`, `combined wick ${fmt(combinedWickRatio)} <= ${fmt(p.maxCombinedWickRatio)}`);
  } else if (isWeakStrongStrong(an, strong, p)) {
    classification = 'WEAK_STRONG_STRONG';
    reasons.push(`first ${dirWord} candle weak (body/range ${fmt(bodyRatios[0])}, body ${fmt(an[0].body)} <= ${fmt(p.weakVsStrongBodyMult)} x ${fmt(Math.min(an[1].body, an[2].body))})`, `2nd and 3rd strong (${fmt(bodyRatios[1])}, ${fmt(bodyRatios[2])} >= ${fmt(p.strongBodyRatio)})`);
  } else {
    reasons.push(`three ${dirWord} candles, strength ${strong.map((s) => (s ? 'strong' : 'not strong')).join(' / ')}, body/range ${bodyRatios.map(fmt).join(' / ')}: not THREE_STRONG or WEAK_STRONG_STRONG`);
  }

  const side = (d: SeqDirection) => (d === 'BULL' ? 'BUY' : 'SELL') as 'BUY' | 'SELL';
  const opposite = (d: SeqDirection) => side(d === 'BULL' ? 'BEAR' : 'BULL');
  const hypothesis = classification === 'THREE_STRONG' ? { kind: 'CONTINUATION' as const, side: side(direction) }
    : classification === 'WEAK_STRONG_STRONG' ? { kind: 'EXHAUSTION_REVERSAL' as const, side: opposite(direction) }
    : { kind: null, side: null };
  return { classification, direction, hypothesis, signalIndex: i, signalTime: cs[i].time, strong, bodyRatios, combinedWickRatio, reasons };
}

function isWeakStrongStrong(an: Anatomy[], strong: boolean[], p: SequenceParams): boolean {
  if (strong[0] || !strong[1] || !strong[2]) return false;
  if (!(leq(an[0].bodyRatio, p.weakBodyRatioMax) && geq(an[0].bodyRatio, p.weakBodyRatioMin))) return false;
  return leq(an[0].body, p.weakVsStrongBodyMult * Math.min(an[1].body, an[2].body));
}
