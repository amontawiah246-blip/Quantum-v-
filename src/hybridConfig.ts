// HYBRID AI PRICE-ACTION LAYER: configuration.
//
// Stage 1 (is there a legitimate candlestick setup?) is FROZEN: it always runs the original engines with their own default parameters
// (see STAGE1_FROZEN in hybridSetups.ts). Nothing in this file can loosen or tighten a candlestick rule. Everything below only
// affects Stage 2 (indicator evidence), Stage 3 (probability) and Stage 4 (the decision).
//
// Indicators evaluate the market. They never create an entry, and one disagreeing indicator never removes a valid setup by itself.
import { QuantumOverrides } from './quantumPipeline';

export type HybridMode = 'A' | 'B' | 'C' | 'D' | 'AUTO';
/** A = candlestick only. B = + indicator gate. C = + machine learning (no indicator inputs). D = full hybrid (indicator gate + model with indicator inputs). AUTO = D when a usable model is loaded, otherwise B (reported, never silent). */

export interface AdxConfig { enabled: boolean; period: number; strong: number; weak: number }
export interface AtrConfig { enabled: boolean; period: number; medianLookback: number; coreLow: number; coreHigh: number; outerLow: number; outerHigh: number }
export interface EmaConfig { enabled: boolean; fast: number; slow: number; slopeLookback: number; flatGapAtr: number }

export interface HybridConfig {
  mode: HybridMode;
  /** The chart and the trade expiry are both five minutes. These are locked by hybridEngine (a different value is rejected at construction). */
  tfSec: number;
  expirySec: number;
  indicators: { adx: AdxConfig; atr: AtrConfig; ema: EmaConfig };
  gate: {
    /** The gate can only veto when at least this many indicators are enabled and available. */
    minIndicatorsForVeto: number;
    /** Veto when this fraction (0..1) of the available indicators contradict the setup. 1 = unanimous disagreement only. */
    vetoContradictFraction: number;
    /** Extra optional rule: veto when the mean evidence (-1..1) is below this. -1 = off. */
    minQuality: number;
    /** two valid setups of opposite sides on one candle in mode B: the one with the higher evidence score wins when it leads by this much, otherwise NO_TRADE */
    conflictQualityMargin: number;
  };
  ml: {
    /** null = use the probability threshold the trainer chose on the validation period (stored in the model file). A number overrides it and is logged as an override. */
    minProbability: number | null;
    /** payout (profit per unit stake) used for the break-even probability 1 / (1 + payout). */
    payout: number;
    /** extra probability above break-even that is always required */
    marginOverBreakeven: number;
    /** two valid setups of opposite sides on one candle: the more probable one wins only when it leads by this much, otherwise NO_TRADE */
    conflictMargin: number;
    /** a model trained on synthetic data is refused unless this is true */
    allowSyntheticModel: boolean;
  };
  performance: { window: number; lagSec: number; priorWeight: number };
  warmupCandles: number;
  log: { maxRecords: number; logAllCandles: boolean; collectFunnel: boolean; keepFeatures: boolean };
  /** passed to the context pipeline (structure, sweep clusters, exhaustion). It never produces a hybrid entry. */
  pipeline: QuantumOverrides;
}

export const HYBRID_DEFAULTS: HybridConfig = {
  mode: 'AUTO',
  tfSec: 300,
  expirySec: 300,
  indicators: {
    adx: { enabled: true, period: 14, strong: 25, weak: 18 },
    atr: { enabled: true, period: 14, medianLookback: 100, coreLow: 0.7, coreHigh: 1.8, outerLow: 0.5, outerHigh: 2.5 },
    ema: { enabled: true, fast: 20, slow: 50, slopeLookback: 3, flatGapAtr: 0.1 },
  },
  gate: { minIndicatorsForVeto: 2, vetoContradictFraction: 1, minQuality: -1, conflictQualityMargin: 0.3 },
  ml: { minProbability: null, payout: 0.9, marginOverBreakeven: 0, conflictMargin: 0.05, allowSyntheticModel: false },
  performance: { window: 50, lagSec: 60, priorWeight: 10 },
  warmupCandles: 120,
  log: { maxRecords: 5000, logAllCandles: false, collectFunnel: true, keepFeatures: false },
  pipeline: {},
};

export type HybridOverrides = {
  [K in keyof HybridConfig]?: HybridConfig[K] extends object ? (K extends 'indicators' ? { [J in keyof HybridConfig['indicators']]?: Partial<HybridConfig['indicators'][J]> } : Partial<HybridConfig[K]>) : HybridConfig[K];
};

/** Overrides one or two levels deep: hybridConfig({ indicators: { adx: { enabled: false } }, ml: { payout: 0.85 } }). Every change from the defaults is returned by `diffFromDefaults` so nothing is weakened silently. */
export function hybridConfig(o: HybridOverrides = {}): HybridConfig {
  const out: any = JSON.parse(JSON.stringify(HYBRID_DEFAULTS));
  for (const k of Object.keys(o) as Array<keyof HybridConfig>) {
    const v: any = (o as any)[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (k === 'indicators') for (const j of Object.keys(v)) out.indicators[j] = { ...out.indicators[j], ...v[j] };
      else out[k] = { ...out[k], ...v };
    } else if (v !== undefined) out[k] = v;
  }
  return out as HybridConfig;
}

/** Every leaf that differs from HYBRID_DEFAULTS, as "path: default -> value". Logged by the engine and printed by the CLI. */
export function diffFromDefaults(c: HybridConfig, base: any = HYBRID_DEFAULTS, path = ''): string[] {
  const out: string[] = [];
  for (const k of Object.keys(base)) {
    const a = base[k], b = (c as any)[k], p = path ? `${path}.${k}` : k;
    if (a && typeof a === 'object' && !Array.isArray(a)) out.push(...diffFromDefaults(b, a, p));
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${p}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  }
  return out;
}

export const breakevenProbability = (payout: number) => 1 / (1 + payout);
