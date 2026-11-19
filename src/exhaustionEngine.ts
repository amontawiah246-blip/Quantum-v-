// ENGINE 12: EXHAUSTION AND REPEATED-SWEEP ANALYSIS.
//
// Measures what the recent candles and the structure are doing and classifies the market as
//   HEALTHY_CONTINUATION            the trend keeps making new extremes and few warning signs are present
//   POSSIBLE_EXHAUSTION             the trend is still in place but at least `minSigns` warning signs are present
//   CONFIRMED_STRUCTURE_REVERSAL    a market structure shift (Engine 8 MSS) happened within `mssRecent` candles
//   UNCLEAR                         neutral structure, or a mixed picture
//
// Warning signs (each a measured fact, each threshold configurable):
//   bodyDecay        recent trend-direction candles have clearly smaller body/range than the earlier ones
//   wickRejection    recent trend-direction candles carry big far-side wicks relative to their bodies
//   failedAttempts   with-trend sweeps in the window that failed (Engine 9)
//   opposingStrength opposing candles make up a large share of the total body size in the window
//   noNewExtremes    the window's directional extreme was NOT made in the last `extremeRecent` candles
//   choppyStructure  the trend changed (or shifted) `changesSign` or more times in the window
// The NUMBER OF RECENT SWEEPS IS RECORDED BUT NEVER COUNTED AS A SIGN. Six sweeps with healthy candles and new highs is still healthy.
// Uses candles <= i and the snapshots at i only.
import { Candle, anatomy } from './candleMath';
import { StructureSnapshot } from './structureEngine';
import { SweepSnapshot } from './sweepIntelligence';

export type ExhaustionState = 'HEALTHY_CONTINUATION' | 'POSSIBLE_EXHAUSTION' | 'CONFIRMED_STRUCTURE_REVERSAL' | 'UNCLEAR';

export interface ExhaustionParams {
  lookback: number;            // candles examined (12)
  recentCandles: number;       // the "recent" slice inside the lookback (4)
  bodyDecay: number;           // recent avg body/range must be at least this much lower than the earlier avg (0.10)
  wickBodyRatio: number;       // recent avg far-wick / body at or above this = rejection (0.6)
  failedAttempts: number;      // failed with-trend sweeps in the window (2)
  opposingShare: number;       // opposing body share of total body size (0.45)
  extremeRecent: number;       // the directional extreme must have been made within this many candles (4)
  changesSign: number;         // structure changes in the window that count as choppy (2)
  minSigns: number;            // signs needed for POSSIBLE_EXHAUSTION (3)
  mssRecent: number;           // an MSS this recent (candles) = CONFIRMED_STRUCTURE_REVERSAL (10)
}
export const EXHAUSTION_DEFAULTS: ExhaustionParams = {
  lookback: 12, recentCandles: 4, bodyDecay: 0.1, wickBodyRatio: 0.6, failedAttempts: 2, opposingShare: 0.45, extremeRecent: 4, changesSign: 2, minSigns: 3, mssRecent: 10,
};

export interface ExhaustionReport {
  state: ExhaustionState;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  signs: string[];                    // which warning signs fired
  metrics: {
    recentSweeps: number;             // information only
    recentBodyRatio: number | null; earlierBodyRatio: number | null;
    wickToBody: number | null;        // recent far-side wick / body (trend-direction candles)
    failedContinuations: number;
    opposingShare: number | null;     // opposing body / total body in the window
    structureChanges: number;
    makingNewExtremes: boolean | null;
  };
  reason: string;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function evaluateExhaustion(cs: Candle[], i: number, st: StructureSnapshot, sw: SweepSnapshot, p: ExhaustionParams = EXHAUSTION_DEFAULTS): ExhaustionReport {
  const trend = st.trend;
  const w = cs.slice(Math.max(0, i - p.lookback + 1), i + 1);
  const dirSign = trend === 'BULLISH' ? 1 : -1;
  const base = { recentSweeps: sw.recentCount, recentBodyRatio: null as number | null, earlierBodyRatio: null as number | null, wickToBody: null as number | null, failedContinuations: sw.failedWithTrendRecent, opposingShare: null as number | null, structureChanges: st.recentChanges, makingNewExtremes: null as boolean | null };

  if (st.lastShift && i - st.lastShift.index <= p.mssRecent && (trend === 'NEUTRAL' || (st.lastShift.direction === 'BULL') === (trend === 'BULLISH'))) {
    return { state: 'CONFIRMED_STRUCTURE_REVERSAL', trend, signs: [], metrics: base, reason: `${st.lastShift.direction === 'BEAR' ? 'bearish' : 'bullish'} structure shift ${i - st.lastShift.index} candle(s) ago (close beyond swing ${st.lastShift.level})` };
  }
  if (trend === 'NEUTRAL') return { state: 'UNCLEAR', trend, signs: [], metrics: base, reason: 'structure is neutral' };
  if (w.length < p.lookback) return { state: 'UNCLEAR', trend, signs: [], metrics: base, reason: `need ${p.lookback} candles, have ${w.length}` };

  const an = w.map(anatomy);
  const withDir = (k: number) => (dirSign > 0 ? an[k].direction === 'bull' : an[k].direction === 'bear');
  const against = (k: number) => (dirSign > 0 ? an[k].direction === 'bear' : an[k].direction === 'bull');
  const cut = w.length - p.recentCandles;
  const recentDir = an.map((a, k) => ({ a, k })).filter((x) => x.k >= cut && withDir(x.k));
  const earlierDir = an.map((a, k) => ({ a, k })).filter((x) => x.k < cut && withDir(x.k));

  const recentBody = mean(recentDir.map((x) => x.a.bodyRatio)), earlierBody = mean(earlierDir.map((x) => x.a.bodyRatio));
  const farWick = (x: { a: ReturnType<typeof anatomy> }) => (dirSign > 0 ? x.a.upperWick : x.a.lowerWick);
  const wickBody = recentDir.length ? mean(recentDir.map((x) => (x.a.body > 0 ? farWick(x) / x.a.body : 0))) : null;
  const bodyAgainst = an.reduce((s, a, k) => s + (against(k) ? a.body : 0), 0), bodyAll = an.reduce((s, a) => s + a.body, 0);
  const opposing = bodyAll > 0 ? bodyAgainst / bodyAll : null;
  const extremeNow = dirSign > 0 ? Math.max(...w.map((c) => c.high)) : Math.min(...w.map((c) => c.low));
  const lastK = w.map((c, k) => ({ c, k })).filter((x) => (dirSign > 0 ? x.c.high === extremeNow : x.c.low === extremeNow)).at(-1)!.k;
  const newExt = w.length - 1 - lastK < p.extremeRecent;

  const signs: string[] = [];
  if (recentBody !== null && earlierBody !== null && earlierBody - recentBody >= p.bodyDecay) signs.push('bodyDecay');
  if (wickBody !== null && wickBody >= p.wickBodyRatio) signs.push('wickRejection');
  if (sw.failedWithTrendRecent >= p.failedAttempts) signs.push('failedAttempts');
  if (opposing !== null && opposing >= p.opposingShare) signs.push('opposingStrength');
  if (!newExt) signs.push('noNewExtremes');
  if (st.recentChanges >= p.changesSign) signs.push('choppyStructure');

  const metrics = { ...base, recentBodyRatio: recentBody, earlierBodyRatio: earlierBody, wickToBody: wickBody, opposingShare: opposing, makingNewExtremes: newExt };
  if (signs.length >= p.minSigns) return { state: 'POSSIBLE_EXHAUSTION', trend, signs, metrics, reason: `${signs.length} warning signs: ${signs.join(', ')}` };
  if (newExt) return { state: 'HEALTHY_CONTINUATION', trend, signs, metrics, reason: `new ${dirSign > 0 ? 'highs' : 'lows'} within ${p.extremeRecent} candles, ${signs.length} warning sign(s)${signs.length ? ': ' + signs.join(', ') : ''}` };
  return { state: 'UNCLEAR', trend, signs, metrics, reason: `no new extreme, but only ${signs.length} warning sign(s): ${signs.join(', ')}` };
}
