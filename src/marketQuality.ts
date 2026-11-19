// MARKET QUALITY: "is this a good place to take a pattern that is already valid?"
//
// It is built from the dashboard's market-condition measurements (src/conditions.ts: EMA 13/34 trend, RSI, Bollinger position, CCI,
// ATR volatility, 20-bar high/low "price action") plus a few counts over the closed candles. These are CONTEXT, not strategy evidence.
// Poor quality lowers the rank (confidence) and adds warnings. It can never make a valid pattern invalid.
import type { Condition } from './conditions';
import { isSweep } from './sweepPatterns';
import type { Bar, Side } from './patternVerification';

export type TrendAlignment = 'WITH_TREND' | 'COUNTERTREND' | 'NEUTRAL' | 'UNKNOWN';
export type Tri = 'SUPPORTIVE' | 'MIXED' | 'CONTRADICTORY' | 'UNKNOWN';
export type Grade = 'GOOD' | 'FAIR' | 'POOR' | 'UNKNOWN';

export interface MarketQuality {
  /** where the numbers come from: the dashboard's market-condition measurements, NOT the strategy engine's pattern evidence */
  source: 'dashboard-market-condition';
  regime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'UNKNOWN';
  trendStrength: number | null;
  trendAlignment: TrendAlignment;
  /** true for ANY countertrend setup. It is a risk label, never a pattern rejection. */
  countertrendRisk: boolean;
  strongCountertrend: boolean;
  indicatorAlignment: { state: Tri; supporting: string[]; contradicting: string[] };
  momentum: Tri;
  volatility: { state: 'SUITABLE' | 'HIGH' | 'LOW' | 'UNKNOWN'; label: string };
  /** sweeps of the PREVIOUS candle (the engine's definition) among the 12 candles before the signal candle */
  repeatedSweeps: { count: number; window: number };
  /** the dashboard's own 20-bar high/low measurement. This is NOT the previous-candle sweep the engine uses. */
  twentyBarHighLowPriceAction: string | null;
  exhaustionOrContinuation: 'EXHAUSTION_SIGNS' | 'CONTINUATION_SIGNS' | 'NONE';
  score: number;
  grade: Grade;
  warnings: string[];
  /** points taken off the confidence (ranking). 0..20 */
  confidencePenalty: number;
}

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

function atr14(bars: Bar[]): number {
  const tr = bars.map((b, i) => Math.max(b.high - b.low, i ? Math.abs(b.high - bars[i - 1].close) : 0, i ? Math.abs(b.low - bars[i - 1].close) : 0));
  return avg(tr.slice(-14)) || 1e-9;
}

export function assessMarketQuality(side: Side, closed: Bar[], c: Condition | null): MarketQuality {
  const buy = side === 'BUY';
  const warnings: string[] = [];
  const window = 12;

  // previous-candle sweeps (Pattern 1/2 definition) before the signal candle, either direction: a level swept again and again is weak
  let count = 0;
  for (let i = Math.max(1, closed.length - 1 - window); i < closed.length - 1; i++) {
    if (isSweep('BUY', closed[i - 1], closed[i]) || isSweep('SELL', closed[i - 1], closed[i])) count++;
  }
  const repeated = { count, window };
  if (count >= 2) warnings.push(`REPEATED SWEEPS: ${count} previous-candle sweeps in the last ${window} candles; the level may be giving way`);

  if (!c) {
    warnings.push('Market context unavailable (fewer than 40 closed candles): trend, RSI, Bollinger, CCI and volatility were not measured');
    return {
      source: 'dashboard-market-condition', regime: 'UNKNOWN', trendStrength: null, trendAlignment: 'UNKNOWN', countertrendRisk: false, strongCountertrend: false,
      indicatorAlignment: { state: 'UNKNOWN', supporting: [], contradicting: [] }, momentum: 'UNKNOWN', volatility: { state: 'UNKNOWN', label: 'unknown' },
      repeatedSweeps: repeated, twentyBarHighLowPriceAction: null, exhaustionOrContinuation: 'NONE',
      score: count >= 2 ? 40 : 60, grade: 'UNKNOWN', warnings, confidencePenalty: count >= 2 ? 6 : 3,
    };
  }

  const atr = atr14(closed);
  const regime = c.trend === 'Up' ? 'TRENDING_UP' : c.trend === 'Down' ? 'TRENDING_DOWN' : 'RANGING';

  // trend relation
  let trendAlignment: TrendAlignment = 'NEUTRAL';
  if ((buy && c.trend === 'Up') || (!buy && c.trend === 'Down')) trendAlignment = 'WITH_TREND';
  else if ((buy && c.trend === 'Down') || (!buy && c.trend === 'Up')) trendAlignment = 'COUNTERTREND';
  const countertrendRisk = trendAlignment === 'COUNTERTREND';
  const strongCountertrend = countertrendRisk && c.trendStrength >= 40;
  if (countertrendRisk) warnings.push(`COUNTERTREND RISK: ${side} against ${c.trend === 'Up' ? 'an uptrend' : 'a downtrend'} (strength ${c.trendStrength}/100)${strongCountertrend ? ', a strong move' : ''}. The pattern itself stays valid`);

  // indicators (dashboard values): which ones support the side, which contradict it
  const supporting: string[] = [], contradicting: string[] = [];
  const put = (cond: boolean | null, label: string) => { if (cond === true) supporting.push(label); else if (cond === false) contradicting.push(label); };
  put(buy ? (c.rsi <= 45 ? true : c.rsi >= 65 ? false : null) : (c.rsi >= 55 ? true : c.rsi <= 35 ? false : null), `RSI ${c.rsi}`);
  put(buy ? (c.bbPos <= 30 ? true : c.bbPos >= 85 ? false : null) : (c.bbPos >= 70 ? true : c.bbPos <= 15 ? false : null), `Bollinger position ${c.bbPos}`);
  put(buy ? (c.cci <= -50 ? true : c.cci >= 150 ? false : null) : (c.cci >= 50 ? true : c.cci <= -150 ? false : null), `CCI ${c.cci}`);
  put(c.ema.state === 'Flat' ? null : (c.ema.state === 'Rising') === buy, `EMA ${c.ema.state}`);
  const state: Tri = !supporting.length && !contradicting.length ? 'MIXED'
    : !contradicting.length && supporting.length >= 2 ? 'SUPPORTIVE'
      : !supporting.length && contradicting.length >= 2 ? 'CONTRADICTORY' : 'MIXED';
  if (state === 'CONTRADICTORY') warnings.push(`INDICATORS CONTRADICT the ${side}: ${contradicting.join(', ')}`);
  else if (state === 'MIXED' && contradicting.length) warnings.push(`Mixed indicators: ${supporting.length ? `support ${supporting.join(', ')}; ` : ''}against ${contradicting.join(', ')}`);

  // momentum: net move of the last 5 closes, in ATR, signed toward the trade
  const n = closed.length;
  const net = n > 5 ? ((closed[n - 1].close - closed[n - 6].close) / atr) * (buy ? 1 : -1) : 0;
  const momentum: Tri = net > 0.5 ? 'SUPPORTIVE' : net < -1 ? 'CONTRADICTORY' : 'MIXED';
  if (momentum === 'CONTRADICTORY') warnings.push(`Momentum runs against the ${side} (${net.toFixed(1)} ATR over 5 candles)`);

  // volatility
  const volatility = c.volatility === 'Normal' ? { state: 'SUITABLE' as const, label: 'normal' }
    : c.volatility === 'High' ? { state: 'HIGH' as const, label: 'high: candles larger than usual, moves can overshoot' }
      : { state: 'LOW' as const, label: 'low: candles smaller than usual, moves may be slow' };
  if (volatility.state !== 'SUITABLE') warnings.push(`Volatility ${volatility.label}`);

  // exhaustion vs continuation
  const net8 = n > 8 ? ((closed[n - 1].close - closed[n - 9].close) / atr) * (buy ? -1 : 1) : 0;   // size of the move INTO the setup, positive = against the side
  const stretched = buy ? (c.rsi <= 30 || c.bbPos <= 10) : (c.rsi >= 70 || c.bbPos >= 90);
  const exhaustion = net8 >= 2 && stretched;
  const continuation = !exhaustion && strongCountertrend;
  const exhaustionOrContinuation = exhaustion ? 'EXHAUSTION_SIGNS' : continuation ? 'CONTINUATION_SIGNS' : 'NONE';
  if (continuation) warnings.push('CONTINUATION SIGNS: a strong trend against the setup with no sign of exhaustion');

  // score
  let score = 100;
  if (countertrendRisk) score -= strongCountertrend ? 25 : 12;
  score -= state === 'CONTRADICTORY' ? 20 : state === 'MIXED' && contradicting.length ? 8 : 0;
  if (momentum === 'CONTRADICTORY') score -= 15;
  if (volatility.state === 'HIGH') score -= 10; else if (volatility.state === 'LOW') score -= 6;
  if (count >= 2) score -= 10;
  if (continuation) score -= 10;
  if (exhaustion) score += 5;
  score = Math.max(0, Math.min(100, score));
  const grade: Grade = score >= 70 ? 'GOOD' : score >= 45 ? 'FAIR' : 'POOR';

  return {
    source: 'dashboard-market-condition', regime, trendStrength: c.trendStrength, trendAlignment, countertrendRisk, strongCountertrend,
    indicatorAlignment: { state, supporting, contradicting }, momentum, volatility, repeatedSweeps: repeated,
    twentyBarHighLowPriceAction: c.priceAction, exhaustionOrContinuation, score, grade, warnings,
    confidencePenalty: Math.min(20, Math.round((100 - score) / 5)),
  };
}
