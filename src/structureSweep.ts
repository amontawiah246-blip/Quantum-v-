// MARKET STRUCTURE DIRECTIONAL BIAS + LIQUIDITY SWEEP CONFIRMATION ENGINE.
//
// Addition-only strategy module (does NOT alter or disable any existing engines).
// Evaluates CLOSED candles strictly chronologically with zero future-candle lookahead:
//   1. Tracks objective Swing Pivots (HH, HL, LH, LL) separately from minor Internal Pivots.
//   2. Confirms Swing CHoCH/MSS (structural reversal) and Swing BOS (trend continuation),
//      ignoring minor internal breaks so noise never flips major directional bias.
//   3. Enforces a directional bias state machine with exact breakLevel + timestamp + deduplication
//      and automatic invalidation on opposing CHoCH/MSS.
//   4. Requires pullback + liquidity sweep strictly aligned with valid active directional bias
//      before emitting an actionable STRUCTURE_CONFIRMED_SWEEP candidate.

import { Candle, validOhlc } from './candleMath';

export type BiasDirection = 'BULLISH' | 'BEARISH' | 'NONE';
export type SwingClass = 'SWING' | 'INTERNAL';
export type PivotLabel = 'FIRST' | 'HH' | 'HL' | 'LH' | 'LL' | 'EQ';
export type StructureEventType = 'CHoCH' | 'MSS' | 'BOS';

export type StructureClassificationState =
  | 'STRUCTURE_DETECTED'
  | 'BULLISH_BIAS'
  | 'BEARISH_BIAS'
  | 'SWEEP_DETECTED'
  | 'STRUCTURE_CONFIRMED_SWEEP'
  | 'WAITING_FOR_STRUCTURE'
  | 'WAITING_FOR_SWEEP'
  | 'BIAS_INVALIDATED'
  | 'CANDIDATE_EXPIRED';

export interface StructureSweepParams {
  swingLeft: number;
  swingRight: number;
  internalLeft: number;
  internalRight: number;
  breakBuffer: number;
  maxBiasAgeCandles: number;
  bodyInsideRequired: boolean;
  oneSignalPerBiasEvent: boolean;
  minSweepWickRatio: number;
}

export const STRUCTURE_SWEEP_DEFAULTS: StructureSweepParams = {
  swingLeft: 3,
  swingRight: 3,
  internalLeft: 1,
  internalRight: 1,
  breakBuffer: 0,
  maxBiasAgeCandles: 60,
  bodyInsideRequired: false,
  oneSignalPerBiasEvent: false,
  minSweepWickRatio: 0,
};

export interface StructurePivot {
  readonly kind: 'HIGH' | 'LOW';
  readonly swingClass: SwingClass;
  readonly index: number;
  readonly time: number;
  readonly price: number;
  readonly confirmedAt: number;
  readonly label: PivotLabel;
}

export interface BiasStructureEvent {
  readonly id: string;
  readonly type: StructureEventType;
  readonly alias?: 'MSS' | 'CHoCH';
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly swingClass: SwingClass;
  readonly breakLevel: number;
  readonly refIndex: number;
  readonly refTime: number;
  readonly refConfirmedAt: number;
  readonly eventIndex: number;
  readonly timestamp: number;
  readonly priorStructure: BiasDirection;
  readonly description: string;
}

export interface DetectedRawSweep {
  readonly side: 'BUY' | 'SELL';
  readonly pullbackIndex: number;
  readonly pullbackTime: number;
  readonly sweepIndex: number;
  readonly sweepTime: number;
  readonly sweptLevel: number;
  readonly sweepExtreme: number;
  readonly sweepClose: number;
}

export interface ActiveBiasInfo {
  readonly direction: 'BULLISH' | 'BEARISH';
  readonly establishedAtIndex: number;
  readonly establishedAtTime: number;
  readonly breakLevel: number;
  readonly eventType: StructureEventType;
  readonly swingClass: 'SWING';
  readonly bosCount: number;
  readonly lastBosTime: number | null;
  readonly valid: boolean;
  readonly invalidatedAtIndex: number | null;
  readonly invalidatedAtTime: number | null;
  readonly invalidationReason: string | null;
}

export interface StructureSweepSnapshot {
  readonly index: number;
  readonly time: number;
  readonly state: StructureClassificationState;
  readonly priorMarketStructure: BiasDirection;
  readonly directionalBias: BiasDirection;
  readonly activeBias: ActiveBiasInfo | null;
  readonly previousBiasInvalidated: boolean;
  readonly lastInvalidation: {
    direction: 'BULLISH' | 'BEARISH';
    atIndex: number;
    atTime: number;
    breakLevel: number;
    reason: string;
  } | null;
  readonly newSwingPivots: readonly StructurePivot[];
  readonly swingHighs: readonly StructurePivot[];
  readonly swingLows: readonly StructurePivot[];
  readonly swingEvents: readonly BiasStructureEvent[];
  readonly newSwingEvents: readonly BiasStructureEvent[];
  readonly newInternalEvents: readonly BiasStructureEvent[];
  readonly latestSwingEvent: BiasStructureEvent | null;
  readonly rawSweep: DetectedRawSweep | null;
  readonly confirmedSignal: StructureConfirmedSweepSignal | null;
  readonly candidateExpired: boolean;
  readonly rejectionReason: string | null;
  readonly reasons: readonly string[];
}

export interface StructureConfirmedSweepSignal {
  readonly side: 'BUY' | 'SELL';
  readonly index: number;
  readonly time: number;
  readonly entryReference: number;
  readonly sweptLevel: number;
  readonly pullbackIndex: number;
  readonly pullbackTime: number;
  readonly sweepIndex: number;
  readonly sweepTime: number;
  readonly biasDirection: 'BULLISH' | 'BEARISH';
  readonly biasEvent: BiasStructureEvent;
  readonly breakLevel: number;
  readonly bosCount: number;
  readonly priorStructure: BiasDirection;
  readonly swingPoints: readonly StructurePivot[];
  readonly classificationState: 'STRUCTURE_CONFIRMED_SWEEP';
  readonly reasons: readonly string[];
}

const isFlat = (c: Candle) => c.open === c.high && c.high === c.low && c.low === c.close;

export class StructureSweepTracker {
  readonly p: StructureSweepParams;
  private cs: Candle[] = [];
  private swingHighs: StructurePivot[] = [];
  private swingLows: StructurePivot[] = [];
  private internalHighs: StructurePivot[] = [];
  private internalLows: StructurePivot[] = [];
  private brokenSwingHighs = new Set<number>();
  private brokenSwingLows = new Set<number>();
  private brokenInternalHighs = new Set<number>();
  private brokenInternalLows = new Set<number>();
  private swingEvents: BiasStructureEvent[] = [];
  private seenEventKeys = new Set<string>();
  private priorStructure: BiasDirection = 'NONE';
  private activeBias: {
    direction: 'BULLISH' | 'BEARISH';
    establishedAtIndex: number;
    establishedAtTime: number;
    breakLevel: number;
    eventType: StructureEventType;
    event: BiasStructureEvent;
    bosCount: number;
    lastBosTime: number | null;
    valid: boolean;
  } | null = null;
  private lastInvalidation: StructureSweepSnapshot['lastInvalidation'] = null;
  private lastConfirmedIndex: number | null = null;
  private consumedBiasEventIds = new Set<string>();

  constructor(p: Partial<StructureSweepParams> = {}) {
    this.p = { ...STRUCTURE_SWEEP_DEFAULTS, ...p };
    if (this.p.swingLeft < 1 || this.p.swingRight < 1) {
      throw new Error('swingLeft and swingRight must be at least 1');
    }
    if (this.p.internalLeft < 1 || this.p.internalRight < 1) {
      throw new Error('internalLeft and internalRight must be at least 1');
    }
  }

  get length(): number {
    return this.cs.length;
  }

  private isPivotAt(k: number, maxIdx: number, left: number, kind: 'HIGH' | 'LOW'): boolean {
    if (k - left < 0 || k >= maxIdx) return false;
    const val = (idx: number) => (kind === 'HIGH' ? this.cs[idx].high : -this.cs[idx].low);
    const center = val(k);
    for (let j = k - left; j < k; j++) {
      if (!(center > val(j))) return false;
    }
    for (let j = k + 1; j <= maxIdx; j++) {
      if (!(center > val(j))) return false;
    }
    return true;
  }

  private labelFor(list: StructurePivot[], kind: 'HIGH' | 'LOW', price: number): PivotLabel {
    const prev = list.at(-1);
    if (!prev) return 'FIRST';
    if (price === prev.price) return 'EQ';
    if (kind === 'HIGH') return price > prev.price ? 'HH' : 'LH';
    return price > prev.price ? 'HL' : 'LL';
  }

  private inferSwingTrend(): BiasDirection {
    const h2 = this.swingHighs.at(-1);
    const h1 = this.swingHighs.at(-2);
    const l2 = this.swingLows.at(-1);
    const l1 = this.swingLows.at(-2);
    if (!h2 || !h1 || !l2 || !l1) return this.priorStructure;
    if (h2.price > h1.price && l2.price > l1.price) return 'BULLISH';
    if (h2.price < h1.price && l2.price < l1.price) return 'BEARISH';
    return this.priorStructure;
  }

  private detectRawSweepAt(i: number): DetectedRawSweep | null {
    if (i < 1) return null;
    const prev = this.cs[i - 1];
    const curr = this.cs[i];
    if (isFlat(prev) || isFlat(curr)) return null;

    const rng = Math.max(1e-12, curr.high - curr.low);

    // Bullish sweep: red pullback candle -> green candle sweeps strictly below prev.low & closes back above prev.low
    if (prev.close < prev.open && curr.close > curr.open && curr.low < prev.low && curr.close > prev.low) {
      const lowerWickRatio = (Math.min(curr.open, curr.close) - curr.low) / rng;
      if (
        (!this.p.bodyInsideRequired || Math.min(curr.open, curr.close) >= prev.low) &&
        lowerWickRatio >= this.p.minSweepWickRatio
      ) {
        return {
          side: 'BUY',
          pullbackIndex: i - 1,
          pullbackTime: prev.time,
          sweepIndex: i,
          sweepTime: curr.time,
          sweptLevel: prev.low,
          sweepExtreme: curr.low,
          sweepClose: curr.close,
        };
      }
    }

    // Bearish sweep: green pullback candle -> red candle sweeps strictly above prev.high & closes back below prev.high
    if (prev.close > prev.open && curr.close < curr.open && curr.high > prev.high && curr.close < prev.high) {
      const upperWickRatio = (curr.high - Math.max(curr.open, curr.close)) / rng;
      if (
        (!this.p.bodyInsideRequired || Math.max(curr.open, curr.close) <= prev.high) &&
        upperWickRatio >= this.p.minSweepWickRatio
      ) {
        return {
          side: 'SELL',
          pullbackIndex: i - 1,
          pullbackTime: prev.time,
          sweepIndex: i,
          sweepTime: curr.time,
          sweptLevel: prev.high,
          sweepExtreme: curr.high,
          sweepClose: curr.close,
        };
      }
    }

    return null;
  }

  /** Step one closed candle at a time. Never reads beyond index i. */
  step(c: Candle): StructureSweepSnapshot {
    if (!validOhlc(c)) throw new Error('StructureSweepTracker requires valid OHLC');
    if (c.closed === false) throw new Error('StructureSweepTracker refuses unclosed candles');
    if (this.cs.length > 0 && c.time <= this.cs[this.cs.length - 1].time) {
      throw new Error(`StructureSweepTracker requires strictly increasing timestamps (${c.time} <= ${this.cs[this.cs.length - 1].time})`);
    }

    const i = this.cs.length;
    this.cs.push({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, closed: c.closed });

    const newSwingEvents: BiasStructureEvent[] = [];
    const newInternalEvents: BiasStructureEvent[] = [];
    const reasons: string[] = [];
    let invalidatedNow = false;
    let rejectionReason: string | null = null;

    const latestSwingHigh = this.swingHighs.at(-1) ?? null;
    const latestSwingLow = this.swingLows.at(-1) ?? null;
    const buf = this.p.breakBuffer;

    // 1A. Check Major SWING structure breaks against swings confirmed on EARLIER candles (never current pivot)
    const swingHighBreakable =
      !!latestSwingHigh &&
      latestSwingHigh.confirmedAt < i &&
      !this.brokenSwingHighs.has(latestSwingHigh.index) &&
      c.close > latestSwingHigh.price * (1 + buf);

    const swingLowBreakable =
      !!latestSwingLow &&
      latestSwingLow.confirmedAt < i &&
      !this.brokenSwingLows.has(latestSwingLow.index) &&
      c.close < latestSwingLow.price * (1 - buf);

    const effectiveBearContext =
      this.priorStructure === 'BEARISH' ||
      (this.activeBias?.valid && this.activeBias.direction === 'BEARISH');

    const effectiveBullContext =
      this.priorStructure === 'BULLISH' ||
      (this.activeBias?.valid && this.activeBias.direction === 'BULLISH');

    if (swingHighBreakable && latestSwingHigh) {
      const evKey = `SWING|BULLISH|${latestSwingHigh.index}`;
      if (!this.seenEventKeys.has(evKey)) {
        this.seenEventKeys.add(evKey);
        this.brokenSwingHighs.add(latestSwingHigh.index);
        if (effectiveBearContext && !(this.activeBias?.valid && this.activeBias.direction === 'BULLISH')) {
          const wasBearBias = this.activeBias?.valid && this.activeBias.direction === 'BEARISH';
          if (wasBearBias) {
            invalidatedNow = true;
            this.lastInvalidation = {
              direction: 'BEARISH',
              atIndex: i,
              atTime: c.time,
              breakLevel: latestSwingHigh.price,
              reason: `Opposing Bullish CHoCH/MSS broke swing high ${latestSwingHigh.price.toFixed(5)}`,
            };
          }
          const ev: BiasStructureEvent = {
            id: evKey,
            type: 'CHoCH',
            alias: 'MSS',
            direction: 'BULLISH',
            swingClass: 'SWING',
            breakLevel: latestSwingHigh.price,
            refIndex: latestSwingHigh.index,
            refTime: latestSwingHigh.time,
            refConfirmedAt: latestSwingHigh.confirmedAt,
            eventIndex: i,
            timestamp: c.time,
            priorStructure: this.activeBias?.valid ? this.activeBias.direction : this.priorStructure,
            description: `Bullish CHoCH/MSS confirmed by close ${c.close.toFixed(5)} above prior LH swing high ${latestSwingHigh.price.toFixed(5)}`,
          };
          this.swingEvents.push(ev);
          newSwingEvents.push(ev);
          this.activeBias = {
            direction: 'BULLISH',
            establishedAtIndex: i,
            establishedAtTime: c.time,
            breakLevel: latestSwingHigh.price,
            eventType: 'CHoCH',
            event: ev,
            bosCount: 0,
            lastBosTime: null,
            valid: true,
          };
          reasons.push(ev.description);
        } else if (effectiveBullContext) {
          const ev: BiasStructureEvent = {
            id: evKey,
            type: 'BOS',
            direction: 'BULLISH',
            swingClass: 'SWING',
            breakLevel: latestSwingHigh.price,
            refIndex: latestSwingHigh.index,
            refTime: latestSwingHigh.time,
            refConfirmedAt: latestSwingHigh.confirmedAt,
            eventIndex: i,
            timestamp: c.time,
            priorStructure: this.activeBias?.valid ? this.activeBias.direction : this.priorStructure,
            description: `Bullish BOS continuation confirmed by close ${c.close.toFixed(5)} above swing high ${latestSwingHigh.price.toFixed(5)}`,
          };
          this.swingEvents.push(ev);
          newSwingEvents.push(ev);
          if (this.activeBias && this.activeBias.valid && this.activeBias.direction === 'BULLISH') {
            this.activeBias.bosCount += 1;
            this.activeBias.lastBosTime = c.time;
            this.activeBias.event = ev;
            this.activeBias.breakLevel = latestSwingHigh.price;
            this.activeBias.eventType = 'BOS';
          } else {
            this.activeBias = {
              direction: 'BULLISH',
              establishedAtIndex: i,
              establishedAtTime: c.time,
              breakLevel: latestSwingHigh.price,
              eventType: 'BOS',
              event: ev,
              bosCount: 1,
              lastBosTime: c.time,
              valid: true,
            };
          }
          reasons.push(ev.description);
        }
      }
    }

    if (swingLowBreakable && latestSwingLow) {
      const evKey = `SWING|BEARISH|${latestSwingLow.index}`;
      if (!this.seenEventKeys.has(evKey)) {
        this.seenEventKeys.add(evKey);
        this.brokenSwingLows.add(latestSwingLow.index);
        if (effectiveBullContext && !(this.activeBias?.valid && this.activeBias.direction === 'BEARISH')) {
          const wasBullBias = this.activeBias?.valid && this.activeBias.direction === 'BULLISH';
          if (wasBullBias) {
            invalidatedNow = true;
            this.lastInvalidation = {
              direction: 'BULLISH',
              atIndex: i,
              atTime: c.time,
              breakLevel: latestSwingLow.price,
              reason: `Opposing Bearish CHoCH/MSS broke swing low ${latestSwingLow.price.toFixed(5)}`,
            };
          }
          const ev: BiasStructureEvent = {
            id: evKey,
            type: 'CHoCH',
            alias: 'MSS',
            direction: 'BEARISH',
            swingClass: 'SWING',
            breakLevel: latestSwingLow.price,
            refIndex: latestSwingLow.index,
            refTime: latestSwingLow.time,
            refConfirmedAt: latestSwingLow.confirmedAt,
            eventIndex: i,
            timestamp: c.time,
            priorStructure: this.activeBias?.valid ? this.activeBias.direction : this.priorStructure,
            description: `Bearish CHoCH/MSS confirmed by close ${c.close.toFixed(5)} below prior HL swing low ${latestSwingLow.price.toFixed(5)}`,
          };
          this.swingEvents.push(ev);
          newSwingEvents.push(ev);
          this.activeBias = {
            direction: 'BEARISH',
            establishedAtIndex: i,
            establishedAtTime: c.time,
            breakLevel: latestSwingLow.price,
            eventType: 'CHoCH',
            event: ev,
            bosCount: 0,
            lastBosTime: null,
            valid: true,
          };
          reasons.push(ev.description);
        } else if (effectiveBearContext) {
          const ev: BiasStructureEvent = {
            id: evKey,
            type: 'BOS',
            direction: 'BEARISH',
            swingClass: 'SWING',
            breakLevel: latestSwingLow.price,
            refIndex: latestSwingLow.index,
            refTime: latestSwingLow.time,
            refConfirmedAt: latestSwingLow.confirmedAt,
            eventIndex: i,
            timestamp: c.time,
            priorStructure: this.activeBias?.valid ? this.activeBias.direction : this.priorStructure,
            description: `Bearish BOS continuation confirmed by close ${c.close.toFixed(5)} below swing low ${latestSwingLow.price.toFixed(5)}`,
          };
          this.swingEvents.push(ev);
          newSwingEvents.push(ev);
          if (this.activeBias && this.activeBias.valid && this.activeBias.direction === 'BEARISH') {
            this.activeBias.bosCount += 1;
            this.activeBias.lastBosTime = c.time;
            this.activeBias.event = ev;
            this.activeBias.breakLevel = latestSwingLow.price;
            this.activeBias.eventType = 'BOS';
          } else {
            this.activeBias = {
              direction: 'BEARISH',
              establishedAtIndex: i,
              establishedAtTime: c.time,
              breakLevel: latestSwingLow.price,
              eventType: 'BOS',
              event: ev,
              bosCount: 1,
              lastBosTime: c.time,
              valid: true,
            };
          }
          reasons.push(ev.description);
        }
      }
    }

    // 1B. Check minor INTERNAL breaks separately (never establishes or reverses major Swing directional bias)
    const lastIntHigh = this.internalHighs.at(-1) ?? null;
    const lastIntLow = this.internalLows.at(-1) ?? null;
    if (
      lastIntHigh &&
      lastIntHigh.confirmedAt < i &&
      !this.brokenInternalHighs.has(lastIntHigh.index) &&
      (!latestSwingHigh || lastIntHigh.index !== latestSwingHigh.index) &&
      c.close > lastIntHigh.price * (1 + buf)
    ) {
      this.brokenInternalHighs.add(lastIntHigh.index);
      newInternalEvents.push({
        id: `INTERNAL|BULLISH|${lastIntHigh.index}`,
        type: 'CHoCH',
        direction: 'BULLISH',
        swingClass: 'INTERNAL',
        breakLevel: lastIntHigh.price,
        refIndex: lastIntHigh.index,
        refTime: lastIntHigh.time,
        refConfirmedAt: lastIntHigh.confirmedAt,
        eventIndex: i,
        timestamp: c.time,
        priorStructure: this.priorStructure,
        description: `Minor internal high break at ${lastIntHigh.price.toFixed(5)} (ignored for major reversal bias)`,
      });
    }
    if (
      lastIntLow &&
      lastIntLow.confirmedAt < i &&
      !this.brokenInternalLows.has(lastIntLow.index) &&
      (!latestSwingLow || lastIntLow.index !== latestSwingLow.index) &&
      c.close < lastIntLow.price * (1 - buf)
    ) {
      this.brokenInternalLows.add(lastIntLow.index);
      newInternalEvents.push({
        id: `INTERNAL|BEARISH|${lastIntLow.index}`,
        type: 'CHoCH',
        direction: 'BEARISH',
        swingClass: 'INTERNAL',
        breakLevel: lastIntLow.price,
        refIndex: lastIntLow.index,
        refTime: lastIntLow.time,
        refConfirmedAt: lastIntLow.confirmedAt,
        eventIndex: i,
        timestamp: c.time,
        priorStructure: this.priorStructure,
        description: `Minor internal low break at ${lastIntLow.price.toFixed(5)} (ignored for major reversal bias)`,
      });
    }

    // 1C. Expire stale bias if unchanged for longer than maxBiasAgeCandles
    if (this.activeBias && this.activeBias.valid) {
      const refIdx = Math.max(
        this.activeBias.establishedAtIndex,
        this.activeBias.event.eventIndex
      );
      if (i - refIdx > this.p.maxBiasAgeCandles) {
        this.activeBias.valid = false;
        invalidatedNow = true;
        this.lastInvalidation = {
          direction: this.activeBias.direction,
          atIndex: i,
          atTime: c.time,
          breakLevel: this.activeBias.breakLevel,
          reason: `${this.activeBias.direction} bias expired after ${i - refIdx} candles without fresh BOS`,
        };
      }
    }

    // 2. Confirm new pivots whose confirmation window closed ON candle i
    const newSwingPivots: StructurePivot[] = [];
    const sk = i - this.p.swingRight;
    if (sk >= 0) {
      if (this.isPivotAt(sk, i, this.p.swingLeft, 'HIGH')) {
        const pv: StructurePivot = {
          kind: 'HIGH',
          swingClass: 'SWING',
          index: sk,
          time: this.cs[sk].time,
          price: this.cs[sk].high,
          confirmedAt: i,
          label: this.labelFor(this.swingHighs, 'HIGH', this.cs[sk].high),
        };
        this.swingHighs.push(pv);
        newSwingPivots.push(pv);
      }
      if (this.isPivotAt(sk, i, this.p.swingLeft, 'LOW')) {
        const pv: StructurePivot = {
          kind: 'LOW',
          swingClass: 'SWING',
          index: sk,
          time: this.cs[sk].time,
          price: this.cs[sk].low,
          confirmedAt: i,
          label: this.labelFor(this.swingLows, 'LOW', this.cs[sk].low),
        };
        this.swingLows.push(pv);
        newSwingPivots.push(pv);
      }
    }

    const ik = i - this.p.internalRight;
    if (ik >= 0) {
      if (this.isPivotAt(ik, i, this.p.internalLeft, 'HIGH')) {
        this.internalHighs.push({
          kind: 'HIGH',
          swingClass: 'INTERNAL',
          index: ik,
          time: this.cs[ik].time,
          price: this.cs[ik].high,
          confirmedAt: i,
          label: this.labelFor(this.internalHighs, 'HIGH', this.cs[ik].high),
        });
      }
      if (this.isPivotAt(ik, i, this.p.internalLeft, 'LOW')) {
        this.internalLows.push({
          kind: 'LOW',
          swingClass: 'INTERNAL',
          index: ik,
          time: this.cs[ik].time,
          price: this.cs[ik].low,
          confirmedAt: i,
          label: this.labelFor(this.internalLows, 'LOW', this.cs[ik].low),
        });
      }
    }

    if (newSwingPivots.length > 0) {
      this.priorStructure = this.inferSwingTrend();
    }

    // 3. Evaluate liquidity sweep at candle i against validated directional bias
    const rawSweep = this.detectRawSweepAt(i);
    let confirmedSignal: StructureConfirmedSweepSignal | null = null;
    const candidateExpired =
      this.lastConfirmedIndex !== null && i === this.lastConfirmedIndex + 1;

    const currentBiasDir: BiasDirection =
      this.activeBias && this.activeBias.valid ? this.activeBias.direction : 'NONE';

    if (rawSweep) {
      if (currentBiasDir === 'NONE') {
        rejectionReason = this.lastInvalidation
          ? `BIAS_INVALIDATED: ${this.lastInvalidation.reason}`
          : 'WAITING_FOR_STRUCTURE: sweep has no confirmed CHoCH/MSS/BOS directional bias';
        reasons.push(rejectionReason);
      } else if (
        (rawSweep.side === 'BUY' && currentBiasDir === 'BEARISH') ||
        (rawSweep.side === 'SELL' && currentBiasDir === 'BULLISH')
      ) {
        rejectionReason =
          this.lastInvalidation &&
          ((rawSweep.side === 'BUY' && this.lastInvalidation.direction === 'BULLISH') ||
            (rawSweep.side === 'SELL' && this.lastInvalidation.direction === 'BEARISH'))
            ? `BIAS_INVALIDATED: old ${this.lastInvalidation.direction} bias invalidated; current bias is ${currentBiasDir}`
            : `AGAINST_STRUCTURE_BIAS: ${rawSweep.side} sweep conflicts with active ${currentBiasDir} bias`;
        reasons.push(rejectionReason);
      } else if (this.p.oneSignalPerBiasEvent && this.consumedBiasEventIds.has(this.activeBias!.event.id)) {
        rejectionReason = `CANDIDATE_EXPIRED: bias event ${this.activeBias!.event.id} already produced a sweep signal; waiting for fresh BOS/CHoCH`;
        reasons.push(rejectionReason);
      } else {
        // Structure-confirmed sweep!
        const bias = this.activeBias!;
        this.consumedBiasEventIds.add(bias.event.id);
        const sigReasons = [
          `${bias.direction} directional bias active (${bias.event.type} break level ${bias.breakLevel.toFixed(5)} at t=${bias.event.timestamp})`,
          bias.bosCount > 0 ? `${bias.bosCount} confirming BOS break(s) maintained ${bias.direction} bias` : `Confirmed structural shift (${bias.event.type}/MSS) validated`,
          rawSweep.side === 'BUY'
            ? `Red pullback candle followed by green candle sweeping below ${rawSweep.sweptLevel.toFixed(5)} (wick low ${rawSweep.sweepExtreme.toFixed(5)}) and closing above at ${rawSweep.sweepClose.toFixed(5)}`
            : `Green pullback candle followed by red candle sweeping above ${rawSweep.sweptLevel.toFixed(5)} (wick high ${rawSweep.sweepExtreme.toFixed(5)}) and closing below at ${rawSweep.sweepClose.toFixed(5)}`,
          `STRUCTURE_CONFIRMED_SWEEP ${rawSweep.side} ready for next candle entry`,
        ];
        confirmedSignal = {
          side: rawSweep.side,
          index: i,
          time: c.time,
          entryReference: c.close,
          sweptLevel: rawSweep.sweptLevel,
          pullbackIndex: rawSweep.pullbackIndex,
          pullbackTime: rawSweep.pullbackTime,
          sweepIndex: rawSweep.sweepIndex,
          sweepTime: rawSweep.sweepTime,
          biasDirection: bias.direction,
          biasEvent: bias.event,
          breakLevel: bias.breakLevel,
          bosCount: bias.bosCount,
          priorStructure: this.priorStructure,
          swingPoints: [...this.swingHighs.slice(-4), ...this.swingLows.slice(-4)].sort((a, b) => a.index - b.index),
          classificationState: 'STRUCTURE_CONFIRMED_SWEEP',
          reasons: sigReasons,
        };
        this.lastConfirmedIndex = i;
        reasons.push(...sigReasons);
      }
    }

    // 4. Determine exact StructureClassificationState
    let state: StructureClassificationState;
    if (confirmedSignal) {
      state = 'STRUCTURE_CONFIRMED_SWEEP';
    } else if (rawSweep) {
      state = 'SWEEP_DETECTED';
    } else if (invalidatedNow && currentBiasDir === 'NONE') {
      state = 'BIAS_INVALIDATED';
    } else if (newSwingEvents.length > 0) {
      state = 'STRUCTURE_DETECTED';
    } else if (candidateExpired) {
      state = 'CANDIDATE_EXPIRED';
    } else if (currentBiasDir === 'BULLISH') {
      state = c.close < c.open ? 'WAITING_FOR_SWEEP' : 'BULLISH_BIAS';
    } else if (currentBiasDir === 'BEARISH') {
      state = c.close > c.open ? 'WAITING_FOR_SWEEP' : 'BEARISH_BIAS';
    } else if (this.lastInvalidation && !this.activeBias?.valid) {
      state = 'BIAS_INVALIDATED';
    } else {
      state = 'WAITING_FOR_STRUCTURE';
    }

    const activeBiasSnap: ActiveBiasInfo | null = this.activeBias
      ? {
          direction: this.activeBias.direction,
          establishedAtIndex: this.activeBias.establishedAtIndex,
          establishedAtTime: this.activeBias.establishedAtTime,
          breakLevel: this.activeBias.breakLevel,
          eventType: this.activeBias.eventType,
          swingClass: 'SWING',
          bosCount: this.activeBias.bosCount,
          lastBosTime: this.activeBias.lastBosTime,
          valid: this.activeBias.valid,
          invalidatedAtIndex: !this.activeBias.valid && this.lastInvalidation ? this.lastInvalidation.atIndex : null,
          invalidatedAtTime: !this.activeBias.valid && this.lastInvalidation ? this.lastInvalidation.atTime : null,
          invalidationReason: !this.activeBias.valid && this.lastInvalidation ? this.lastInvalidation.reason : null,
        }
      : null;

    return {
      index: i,
      time: c.time,
      state,
      priorMarketStructure: this.priorStructure,
      directionalBias: currentBiasDir,
      activeBias: activeBiasSnap,
      previousBiasInvalidated: invalidatedNow || (this.lastInvalidation !== null && !this.activeBias?.valid),
      lastInvalidation: this.lastInvalidation ? { ...this.lastInvalidation } : null,
      newSwingPivots,
      swingHighs: this.swingHighs.slice(-6),
      swingLows: this.swingLows.slice(-6),
      swingEvents: this.swingEvents.slice(-8),
      newSwingEvents,
      newInternalEvents,
      latestSwingEvent: this.swingEvents.at(-1) ?? null,
      rawSweep,
      confirmedSignal,
      candidateExpired,
      rejectionReason,
      reasons,
    };
  }
}

/**
 * Pure non-repainting chronological evaluation of closed candles up to index `i`.
 * Never inspects candles after index `i`.
 */
export function analyzeStructureSweep(
  cs: readonly Candle[],
  i: number,
  params: Partial<StructureSweepParams> = {},
  windowSize = 0
): StructureSweepSnapshot | null {
  if (i < 0 || i >= cs.length) return null;
  const start = windowSize > 0 ? Math.max(0, i - windowSize + 1) : 0;
  const tracker = new StructureSweepTracker(params);
  let snap: StructureSweepSnapshot | null = null;
  for (let k = start; k <= i; k++) {
    const c = cs[k];
    if (!validOhlc(c) || c.closed === false) return null;
    if (k > start && c.time <= cs[k - 1].time) return null;
    snap = tracker.step(c);
  }
  return snap;
}

/**
 * Emits a confirmed signal strictly when STRUCTURE_CONFIRMED_SWEEP triggers at closed candle i.
 */
export function detectStructureSweepSignal(
  cs: readonly Candle[],
  i: number,
  params: Partial<StructureSweepParams> = {},
  windowSize = 45
): { signal: StructureConfirmedSweepSignal | null; snapshot: StructureSweepSnapshot | null } {
  const snap = analyzeStructureSweep(cs, i, params, windowSize);
  if (!snap) return { signal: null, snapshot: null };
  return { signal: snap.confirmedSignal, snapshot: snap };
}
