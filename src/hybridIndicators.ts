// SUPPORTING INDICATORS: ADX(14), ATR(14), EMA(20) and EMA(50). Incremental and causal: a snapshot for candle i is a function of
// candles 0..i only (a test cuts the series and compares). They measure market conditions. Nothing here creates a BUY or a SELL.
//
// Wilder smoothing for ATR and ADX, EMA seeded with the simple average of its first `period` closes.
// A snapshot value is NaN until its warm-up is complete (ATR: period+1 candles, ADX: 2*period candles, EMA: its period, ATR median: medianLookback ATR values).
import { Candle } from './candleMath';
import { AdxConfig, AtrConfig, EmaConfig } from './hybridConfig';

export interface IndicatorSnapshot {
  adx: number; plusDI: number; minusDI: number;
  atr: number; atrMedian: number; atrRatio: number;      // atrRatio = ATR / median ATR of the last medianLookback values
  emaFast: number; emaSlow: number; emaFastSlope: number; // slope = (emaFast now - emaFast `slopeLookback` candles ago) / ATR
  ready: { adx: boolean; atr: boolean; ema: boolean };
}

export interface IndicatorParams { adx: Pick<AdxConfig, 'period'>; atr: Pick<AtrConfig, 'period' | 'medianLookback'>; ema: Pick<EmaConfig, 'fast' | 'slow' | 'slopeLookback'> }

export class IndicatorTracker {
  private n = 0;
  private prev: Candle | null = null;
  // ATR
  private atrV = NaN; private trSeed: number[] = [];
  private atrHist: number[] = [];
  // ADX
  private smTR = NaN; private smP = NaN; private smM = NaN; private dmSeed: Array<[number, number, number]> = [];
  private dxSeed: number[] = []; private adxV = NaN; private pdi = NaN; private mdi = NaN;
  // EMA
  private seedCloses: number[] = [];
  private fast = NaN; private slow = NaN; private fastHist: number[] = [];
  constructor(readonly p: IndicatorParams) {}

  /** Feed the next CLOSED candle (the caller guarantees valid, in-order, contiguous candles; the engine resets the tracker on any gap). */
  update(c: Candle): IndicatorSnapshot {
    const { adx: A, atr: R, ema: E } = this.p;
    this.n++;
    if (this.prev) {
      const pc = this.prev;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - pc.close), Math.abs(c.low - pc.close));
      const up = c.high - pc.high, dn = pc.low - c.low;
      const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
      // ATR (Wilder)
      if (Number.isNaN(this.atrV)) {
        this.trSeed.push(tr);
        if (this.trSeed.length === R.period) { this.atrV = this.trSeed.reduce((s, x) => s + x, 0) / R.period; this.atrHist.push(this.atrV); }
      } else { this.atrV = ((R.period - 1) * this.atrV + tr) / R.period; this.atrHist.push(this.atrV); }
      if (this.atrHist.length > R.medianLookback) this.atrHist.shift();
      // ADX (Wilder)
      const n = A.period;
      if (Number.isNaN(this.smTR)) {
        this.dmSeed.push([tr, pdm, mdm]);
        if (this.dmSeed.length === n) {
          this.smTR = this.dmSeed.reduce((s, x) => s + x[0], 0); this.smP = this.dmSeed.reduce((s, x) => s + x[1], 0); this.smM = this.dmSeed.reduce((s, x) => s + x[2], 0);
          this.pushDx(n);
        }
      } else {
        this.smTR = this.smTR - this.smTR / n + tr; this.smP = this.smP - this.smP / n + pdm; this.smM = this.smM - this.smM / n + mdm;
        this.pushDx(n);
      }
    }
    // EMAs: seeded with the SMA of the first `period` closes, then the usual recursion
    if (this.seedCloses.length < Math.max(E.fast, E.slow)) this.seedCloses.push(c.close);
    const step = (prev: number, period: number) =>
      Number.isNaN(prev) ? (this.n === period ? this.seedCloses.slice(0, period).reduce((s, x) => s + x, 0) / period : NaN) : prev + (2 / (period + 1)) * (c.close - prev);
    this.fast = step(this.fast, E.fast); this.slow = step(this.slow, E.slow);
    this.fastHist.push(this.fast); if (this.fastHist.length > E.slopeLookback + 1) this.fastHist.shift();
    this.prev = c;
    return this.snapshot();
  }

  private pushDx(n: number) {
    const pdi = this.smTR > 0 ? (100 * this.smP) / this.smTR : 0, mdi = this.smTR > 0 ? (100 * this.smM) / this.smTR : 0;
    this.pdi = pdi; this.mdi = mdi;
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    if (Number.isNaN(this.adxV)) { this.dxSeed.push(dx); if (this.dxSeed.length === n) this.adxV = this.dxSeed.reduce((s, x) => s + x, 0) / n; }
    else this.adxV = ((n - 1) * this.adxV + dx) / n;
  }

  private snapshot(): IndicatorSnapshot {
    const { atr: R, ema: E } = this.p;
    const medianReady = this.atrHist.length >= R.medianLookback;
    const sorted = medianReady ? [...this.atrHist].sort((a, b) => a - b) : [];
    const med = medianReady ? (sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : NaN;
    const old = this.fastHist.length > E.slopeLookback ? this.fastHist[0] : NaN;
    const slope = Number.isFinite(old) && this.atrV > 0 ? (this.fast - old) / this.atrV : NaN;
    return {
      adx: this.adxV, plusDI: this.pdi, minusDI: this.mdi, atr: this.atrV, atrMedian: med, atrRatio: medianReady && med > 0 ? this.atrV / med : NaN,
      emaFast: this.fast, emaSlow: this.slow, emaFastSlope: slope,
      ready: { adx: Number.isFinite(this.adxV), atr: Number.isFinite(this.atrV) && medianReady && med > 0, ema: Number.isFinite(this.fast) && Number.isFinite(this.slow) && Number.isFinite(slope) },
    };
  }
}

/** Convenience for tests and tools: one snapshot per candle of `cs` (candles must be valid and contiguous). */
export function indicatorSeries(cs: Candle[], p: IndicatorParams): IndicatorSnapshot[] {
  const t = new IndicatorTracker(p);
  return cs.map((c) => t.update(c));
}

/** Plain textbook references used by the tests (batch, O(n^2)-free but independent of the incremental code above). */
export function referenceEma(closes: number[], period: number): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period) return out;
  let e = closes.slice(0, period).reduce((s, x) => s + x, 0) / period;
  out[period - 1] = e;
  for (let i = period; i < closes.length; i++) { e = e + (2 / (period + 1)) * (closes[i] - e); out[i] = e; }
  return out;
}
export function referenceAtr(cs: Candle[], period: number): number[] {
  const tr = cs.map((c, i) => (i === 0 ? NaN : Math.max(c.high - c.low, Math.abs(c.high - cs[i - 1].close), Math.abs(c.low - cs[i - 1].close))));
  const out: number[] = new Array(cs.length).fill(NaN);
  let a = tr.slice(1, period + 1).reduce((s, x) => s + x, 0) / period;
  out[period] = a;
  for (let i = period + 1; i < cs.length; i++) { a = ((period - 1) * a + tr[i]) / period; out[i] = a; }
  return out;
}
