// LIVE CONFIDENCE: the win rate this kind of setup has actually had in YOUR own log, not a made-up percentage.
//
// Every setup the engines find is logged (CANDIDATE) and later settled against the next candle (SHADOW: entry = next open,
// settle = its close, the same rule as the backtester). For a new setup we look up how earlier setups of the same kind ended.
//   scope 1: same market + time frame + pattern      scope 2: same time frame + pattern (any market)      scope 3: same time frame
// The most specific scope with enough settled setups wins. Ties are left out. With too little history there is NO number:
// `pct` is null and the screen says it is still collecting data. Nothing here is a prediction; it is a measured rate with its range.
import type { LogEvent } from './tradeLog';

export const LIVE_MIN_RESOLVED = 30;

export type LiveScope = 'market+pattern' | 'timeframe+pattern' | 'timeframe' | 'none';
export interface LiveConfidence {
  pct: number | null;            // observed win rate in whole percent, null until `ready`
  ready: boolean;
  n: number;                     // settled setups (wins + losses) behind the number, or collected so far
  wins: number; losses: number;
  lo: number | null; hi: number | null;   // Wilson 95% range in percent
  scope: LiveScope;
  minN: number;
  breakEven: number;             // win rate (percent) needed to break even at the payout used
  verdict: 'above' | 'below' | 'unclear' | 'none';   // where the 95% range sits against break-even
  text: string;                  // one line for the screen
}

export interface LiveQuery { market: string; tf: number; pattern: string }

const wilson = (w: number, n: number): [number, number] => {
  const z = 1.96, p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
};

export function liveConfidence(events: LogEvent[], q: LiveQuery, payout = 0.9, minN = LIVE_MIN_RESOLVED): LiveConfidence {
  const breakEven = Math.round((1 / (1 + payout)) * 1000) / 10;
  const settled = new Map<string, 'win' | 'loss'>();
  for (const e of events) if (e.type === 'SHADOW' && e.result !== 'tie') settled.set(e.id, e.result);
  const tally = { a: [0, 0], b: [0, 0], c: [0, 0] };   // [wins, losses] per scope
  for (const e of events) {
    if (e.type !== 'CANDIDATE' || e.tf !== q.tf) continue;
    const r = settled.get(e.id); if (!r) continue;
    const i = r === 'win' ? 0 : 1;
    tally.c[i]++;
    if (e.pattern === q.pattern) { tally.b[i]++; if (e.market === q.market) tally.a[i]++; }
  }
  const scopes: [LiveScope, number[]][] = [['market+pattern', tally.a], ['timeframe+pattern', tally.b], ['timeframe', tally.c]];
  const pick = scopes.find(([, [w, l]]) => w + l >= minN);
  if (!pick) {
    // not enough history anywhere: report how much has been collected so far (the broadest scope), but no percentage
    const [w, l] = tally.c;
    return { pct: null, ready: false, n: w + l, wins: w, losses: l, lo: null, hi: null, scope: 'none', minN, breakEven, verdict: 'none',
      text: `Collecting data: ${w + l} of ${minN} settled setups on this time frame. No win rate is shown until there is enough history.` };
  }
  const [scope, [w, l]] = pick, n = w + l, [lo, hi] = wilson(w, n);
  const pct = Math.round((w / n) * 100), loP = Math.round(lo * 100), hiP = Math.round(hi * 100);
  const verdict = lo * 100 > breakEven ? 'above' : hi * 100 < breakEven ? 'below' : 'unclear';
  const where = scope === 'market+pattern' ? 'this market and pattern' : scope === 'timeframe+pattern' ? 'this pattern on this time frame' : 'this time frame';
  const vt = verdict === 'above' ? 'above break-even' : verdict === 'below' ? 'below break-even' : 'not yet distinguishable from break-even';
  return { pct, ready: true, n, wins: w, losses: l, lo: loP, hi: hiP, scope, minN, breakEven, verdict,
    text: `Live win rate ${pct}% over ${n} settled setups on ${where} (95% range ${loP}-${hiP}%, break-even ${breakEven}%): ${vt}.` };
}

/** Short form for logs and tables. */
export const liveShort = (l: LiveConfidence | null | undefined) => !l ? '' : l.ready ? `live ${l.pct}% (n=${l.n})` : `live: collecting ${l.n}/${l.minN}`;
