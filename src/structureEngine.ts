// ENGINE 8: MARKET STRUCTURE CLASSIFIER. OHLC only, no indicators, no look-ahead.
//
// Swing points are CONFIRMED pivots: candle k is a swing high when its high is strictly above the `pivotLeft` highs before it and the
// `pivotRight` highs after it (same idea mirrored for lows). Because it needs `pivotRight` candles after k, the pivot only exists from
// candle k + pivotRight onward (`confirmedAt`). The tracker is fed one closed candle at a time, so a snapshot for candle i can never
// contain anything from a later candle. A test checks that cutting the series at i gives the same snapshot as running past it.
//
// Trend:
//   BULLISH  last two confirmed swing highs rise (HH) AND last two confirmed swing lows rise (HL).
//   BEARISH  last two highs fall (LH) AND last two lows fall (LL).
//   NEUTRAL  anything else (sideways, mixed, not enough pivots, or right after a structure shift before new pivots confirm the new direction).
// Events (always by candle CLOSE, always against an already confirmed swing; the swing must be confirmed on an earlier candle):
//   BOS  in a BULLISH trend a close above the latest unbroken swing high (BEARISH: below the latest swing low). The trend continues.
//   MSS  in a BULLISH trend a close below the latest confirmed swing low (the protected low); BEARISH: above the latest swing high.
//        After an MSS the trend is NEUTRAL until new pivots confirm the new direction.
//        If a trend has gone NEUTRAL (e.g. a lower high formed) its direction is remembered, so a later close through the protected swing
//        still counts as the shift (`mssFromNeutral`, on by default).
import { Candle, validOhlc } from './candleMath';

export type Trend = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type PivotLabel = 'FIRST' | 'HH' | 'LH' | 'HL' | 'LL' | 'EQ';

export interface StructureParams {
  pivotLeft: number;          // candles to the left that must be lower (highs) / higher (lows)
  pivotRight: number;         // candles to the right that must be lower / higher: also the confirmation delay in candles
  breakBuffer: number;        // a close must pass the swing by this fraction of the swing price (0 = any close beyond it)
  mssFromNeutral: boolean;    // a NEUTRAL market that was bullish/bearish before can still produce the shift
}
export const STRUCTURE_DEFAULTS: StructureParams = { pivotLeft: 2, pivotRight: 2, breakBuffer: 0, mssFromNeutral: true };

export interface Pivot {
  readonly kind: 'HIGH' | 'LOW';
  readonly index: number; readonly time: number; readonly price: number;
  readonly confirmedAt: number;           // index of the candle on which the pivot became known
  readonly label: PivotLabel;             // relation to the previous pivot of the same kind
}

export interface StructureEvent {
  readonly type: 'BOS' | 'MSS';
  readonly direction: 'BULL' | 'BEAR';    // BULL = broke up, BEAR = broke down
  readonly index: number; readonly time: number;
  readonly level: number;                 // the swing price that was broken
  readonly refIndex: number;              // index of the reference swing candle
  readonly refConfirmedAt: number;        // when that swing was confirmed (always < index)
  readonly priorTrend: Trend;             // the trend that was in force before the event
}

export interface StructureSnapshot {
  readonly index: number; readonly time: number;
  readonly trend: Trend;
  readonly trendSince: number | null;     // index at which the current trend was established
  readonly rememberedTrend: Trend;        // last non-neutral trend not yet shifted away from (BULLISH/BEARISH/NEUTRAL when none)
  readonly lastHigh: Pivot | null; readonly prevHigh: Pivot | null;
  readonly lastLow: Pivot | null; readonly prevLow: Pivot | null;
  readonly event: StructureEvent | null;  // event produced by THIS candle
  readonly lastShift: StructureEvent | null;
  readonly recentChanges: number;         // trend changes (incl. shifts) in the last `changeWindow` candles
  readonly newPivots: readonly Pivot[];   // pivots that were confirmed on this candle
  readonly description: string;           // e.g. "Higher highs and higher lows detected."
}

const CHANGE_WINDOW = 20;

export class StructureTracker {
  readonly p: StructureParams;
  private cs: Candle[] = [];
  private highs: Pivot[] = [];
  private lows: Pivot[] = [];
  private brokenHigh = new Set<number>();    // pivot indexes already taken out by a BOS / MSS
  private brokenLow = new Set<number>();
  private trend: Trend = 'NEUTRAL';
  private trendSince: number | null = null;
  private remembered: Trend = 'NEUTRAL';
  private lock: { index: number } | null = null;   // set by an MSS: new direction needs pivots confirmed AFTER it
  private lastShift: StructureEvent | null = null;
  private changeIdx: number[] = [];

  constructor(p: Partial<StructureParams> = {}) {
    this.p = { ...STRUCTURE_DEFAULTS, ...p };
    if (!(this.p.pivotLeft >= 1 && this.p.pivotRight >= 1)) throw new Error('pivotLeft and pivotRight must be at least 1');
  }

  get length() { return this.cs.length; }

  private pivotAt(k: number, i: number, kind: 'HIGH' | 'LOW'): boolean {
    const { pivotLeft: L } = this.p;
    if (k - L < 0) return false;
    const v = (j: number) => (kind === 'HIGH' ? this.cs[j].high : -this.cs[j].low);
    const x = v(k);
    for (let j = k - L; j < k; j++) if (!(x > v(j))) return false;
    for (let j = k + 1; j <= i; j++) if (!(x > v(j))) return false;
    return true;
  }

  private label(kind: 'HIGH' | 'LOW', price: number): PivotLabel {
    const prev = (kind === 'HIGH' ? this.highs : this.lows).at(-1);
    if (!prev) return 'FIRST';
    if (price === prev.price) return 'EQ';
    if (kind === 'HIGH') return price > prev.price ? 'HH' : 'LH';
    return price > prev.price ? 'HL' : 'LL';
  }

  /** Feed the next CLOSED candle. Candles must be valid and in order; the caller (pipeline) guarantees that. */
  update(c: Candle): StructureSnapshot {
    if (!validOhlc(c)) throw new Error('StructureTracker needs valid OHLC');
    const i = this.cs.length;
    this.cs.push(c);
    const { breakBuffer: buf } = this.p;

    // 1. break checks use only swings confirmed on EARLIER candles (new pivots are added in step 2)
    let event: StructureEvent | null = null;
    const lastHigh = this.highs.at(-1) ?? null, lastLow = this.lows.at(-1) ?? null;
    const mk = (type: 'BOS' | 'MSS', direction: 'BULL' | 'BEAR', ref: Pivot): StructureEvent =>
      ({ type, direction, index: i, time: c.time, level: ref.price, refIndex: ref.index, refConfirmedAt: ref.confirmedAt, priorTrend: this.trend === 'NEUTRAL' ? this.remembered : this.trend });
    const eff: Trend = this.trend !== 'NEUTRAL' ? this.trend : this.p.mssFromNeutral ? this.remembered : 'NEUTRAL';
    const brokeUp = (ref: Pivot | null) => !!ref && ref.confirmedAt < i && c.close > ref.price * (1 + buf);
    const brokeDown = (ref: Pivot | null) => !!ref && ref.confirmedAt < i && c.close < ref.price * (1 - buf);

    if (eff === 'BULLISH' && brokeDown(lastLow)) event = mk('MSS', 'BEAR', lastLow!);
    else if (eff === 'BEARISH' && brokeUp(lastHigh)) event = mk('MSS', 'BULL', lastHigh!);
    else if (this.trend === 'BULLISH' && brokeUp(lastHigh) && !this.brokenHigh.has(lastHigh!.index)) event = mk('BOS', 'BULL', lastHigh!);
    else if (this.trend === 'BEARISH' && brokeDown(lastLow) && !this.brokenLow.has(lastLow!.index)) event = mk('BOS', 'BEAR', lastLow!);

    if (event) {
      if (event.direction === 'BULL') this.brokenHigh.add(event.refIndex); else this.brokenLow.add(event.refIndex);
      if (event.type === 'MSS') {
        this.setTrend('NEUTRAL', i);
        this.remembered = 'NEUTRAL';
        this.lock = { index: i };
        this.lastShift = event;
        this.changeIdx.push(i);
      }
    }

    // 2. pivots that become known on this candle
    const fresh: Pivot[] = [];
    const k = i - this.p.pivotRight;
    if (k >= 0) {
      if (this.pivotAt(k, i, 'HIGH')) { const pv: Pivot = { kind: 'HIGH', index: k, time: this.cs[k].time, price: this.cs[k].high, confirmedAt: i, label: this.label('HIGH', this.cs[k].high) }; this.highs.push(pv); fresh.push(pv); }
      if (this.pivotAt(k, i, 'LOW')) { const pv: Pivot = { kind: 'LOW', index: k, time: this.cs[k].time, price: this.cs[k].low, confirmedAt: i, label: this.label('LOW', this.cs[k].low) }; this.lows.push(pv); fresh.push(pv); }
    }

    // 3. trend from the pivot sequence
    if (fresh.length) this.reassess(i);

    return this.snapshot(i, c, event, fresh);
  }

  private implied(): Trend {
    const [h2, h1] = [this.highs.at(-1), this.highs.at(-2)], [l2, l1] = [this.lows.at(-1), this.lows.at(-2)];
    if (!h2 || !h1 || !l2 || !l1) return 'NEUTRAL';
    if (h2.price > h1.price && l2.price > l1.price) return 'BULLISH';
    if (h2.price < h1.price && l2.price < l1.price) return 'BEARISH';
    return 'NEUTRAL';
  }

  private setTrend(t: Trend, i: number) {
    if (t === this.trend) return;
    this.trend = t;
    this.trendSince = t === 'NEUTRAL' ? null : i;
    if (t !== 'NEUTRAL') this.remembered = t;
  }

  private reassess(i: number) {
    const imp = this.implied();
    if (this.trend === 'NEUTRAL') {
      if (imp === 'NEUTRAL') return;
      if (this.lock && !(this.highs.at(-1)!.confirmedAt > this.lock.index && this.lows.at(-1)!.confirmedAt > this.lock.index)) return;
      this.setTrend(imp, i); this.lock = null; this.changeIdx.push(i);
    } else if (imp !== this.trend) {
      this.setTrend('NEUTRAL', i);       // the HH+HL (or LH+LL) evidence is gone: unclear, but the old direction is remembered
      this.changeIdx.push(i);
    }
  }

  private snapshot(i: number, c: Candle, event: StructureEvent | null, fresh: Pivot[]): StructureSnapshot {
    const h = this.highs, l = this.lows;
    const recentChanges = this.changeIdx.filter((x) => i - x < CHANGE_WINDOW).length;
    while (this.changeIdx.length && i - this.changeIdx[0] >= CHANGE_WINDOW * 4) this.changeIdx.shift();
    const description = this.trend === 'BULLISH' ? 'Higher highs and higher lows detected.'
      : this.trend === 'BEARISH' ? 'Lower highs and lower lows detected.'
      : h.length < 2 || l.length < 2 ? 'Not enough confirmed swings yet.' : this.lock ? 'Structure shifted; waiting for new swings to confirm the new direction.' : 'Mixed or sideways swings: structure unclear.';
    return {
      index: i, time: c.time, trend: this.trend, trendSince: this.trendSince, rememberedTrend: this.remembered,
      lastHigh: h.at(-1) ?? null, prevHigh: h.at(-2) ?? null, lastLow: l.at(-1) ?? null, prevLow: l.at(-2) ?? null,
      event, lastShift: this.lastShift, recentChanges, newPivots: fresh, description,
    };
  }
}

// ------------------------------------------------------------------------------------------------ series helper (cached, incremental)
interface Cached { tracker: StructureTracker; snaps: StructureSnapshot[]; lastTime: number }
const cache = new WeakMap<Candle[], Map<string, Cached>>();

/**
 * Snapshot for every candle of `cs`. Candles are processed in order and one at a time, so snapshot[i] depends only on cs[0..i].
 * The result is cached per array and extended in place if candles were appended; if the series changed it is rebuilt.
 */
export function structureSeries(cs: Candle[], p: Partial<StructureParams> = {}): StructureSnapshot[] {
  const full = { ...STRUCTURE_DEFAULTS, ...p };
  const key = JSON.stringify(full);
  let m = cache.get(cs); if (!m) { m = new Map(); cache.set(cs, m); }
  let e = m.get(key);
  if (e && (e.snaps.length > cs.length || (e.snaps.length && cs[e.snaps.length - 1].time !== e.lastTime))) e = undefined;
  if (!e) { e = { tracker: new StructureTracker(full), snaps: [], lastTime: 0 }; m.set(key, e); }
  for (let i = e.snaps.length; i < cs.length; i++) e.snaps.push(e.tracker.update(cs[i]));
  if (e.snaps.length) e.lastTime = cs[e.snaps.length - 1].time;
  return e.snaps;
}

/** Structure as known after closed candle i (uses candles 0..i only). */
export const structureAt = (cs: Candle[], i: number, p: Partial<StructureParams> = {}): StructureSnapshot | null => {
  if (i < 0 || i >= cs.length) return null;
  return structureSeries(cs, p)[i] ?? null;
};
