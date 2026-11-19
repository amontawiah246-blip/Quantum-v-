// The evidence package of one setup candidate. Every recipient (the three strategy engines, the AI verification and the hybrid
// analysis) gets THE SAME frozen object: same candidate id, same version, same candles, same screenshot, same hash.
import { candleSetHash, sha256 } from './aiVerification';
import { validOhlc } from './candleMath';
import type { Bar } from './patternVerification';
import type { EngineName, StochRsiMeta } from './sweepEngines';

export type Side = 'BUY' | 'SELL';

export interface CandidateScreenshot {
  /** the chart exactly as the market agent drew it (src/sweepChart.ts); the picture every recipient is given */
  svg: string;
  svgSha256: string;
  /** PNG of that same svg (the Gemini API does not read SVG). null = no rasterizer is installed: the AI then reports NOT_SENT honestly */
  png: Uint8Array | null;
  pngSha256: string | null;
  /** when the screenshot was taken (ms epoch) and how long drawing + rasterizing took */
  capturedAtMs: number;
  captureMs: number;
}

export interface Validity { valid: boolean; reasons: string[] }

export interface CandidateEvidence {
  candidateId: string;
  /** 1 = the original evidence. Later versions are chart updates; they never replace version 1. */
  version: number;
  kind: 'ORIGINAL' | 'UPDATE';
  agentId: string;
  symbol: string;
  market: string;
  /** the engine that found the setup, and the direction */
  engine: EngineName;
  direction: Side;
  tf: number;
  /** open and close time (epoch seconds) of the candle the setup completed on */
  signalCandleOpen: number;
  signalCandleClose: number;
  patternFrom: number;
  tradeAtNextOpen: boolean;
  /** e.g. "Buy Momentum - 3 Green Candles, Body Dominance" (the same names as the agents' chart titles) */
  pattern: string;
  entry: number;
  sweptLevel: number;
  notes: string[];
  trace: string[];
  /** closed candles, oldest first, the last one is the signal candle (or newer, in an update) */
  ohlc: readonly Bar[];
  /** hash of ALL the rows in `ohlc`: every result must echo it */
  candleSetHash: string;
  /** hash of the last 60 rows: the rows the AI prompt carries, and the hash printed on the screenshot request (ScreenshotImage.candleSetHash) */
  aiRowsHash: string;
  /** candles the engines look at, ending on the signal candle */
  engineWindow: number;
  screenshot: CandidateScreenshot;
  screenshotAtMs: number;
  detectedAtMs: number;
  /** seconds between the candle close and the detection, by the broker's clock (null = unknown) */
  detectionLatencySec: number | null;
  publishedAtMs: number;
  supersedes: number | null;
  reason: string;
  /** does the ORIGINAL setup still stand on this version's candles? */
  validity: Validity;
  /** LSCC only: the swept liquidity level and the exact sweep / confirmation / entry candle times (kept from detection, never rewritten) */
  lscc?: { level: number; levelTime: number; sweepTime: number; confirmTime: number; entryTime: number; sweepDetectedAtMs: number | null; sweepScreenshotSha256: string | null };
  /** Indicator strategy: the Stochastic + RSI crossings and the candle pattern(s) that confirmed them */
  stochRsi?: StochRsiMeta;
  /** Structure-confirmed sweep metadata (CHoCH/MSS/BOS breakLevel, bias, swing context) */
  structureSweep?: {
    biasDirection: 'BULLISH' | 'BEARISH';
    eventType: 'CHoCH' | 'MSS' | 'BOS';
    breakLevel: number;
    eventTime: number;
    bosCount: number;
    pullbackTime: number;
    sweepTime: number;
  };
}

export interface PublishInput {
  agentId: string; symbol: string; market: string; engine: EngineName; direction: Side; tf: number;
  signalCandleOpen: number; patternFrom: number; tradeAtNextOpen: boolean; entry: number; sweptLevel: number;
  notes: string[]; trace: string[]; ohlc: Bar[]; engineWindow: number; screenshot: CandidateScreenshot;
  detectedAtMs: number; detectionLatencySec: number | null;
  lscc?: CandidateEvidence['lscc'];
  structureSweep?: CandidateEvidence['structureSweep'];
  stochRsi?: StochRsiMeta;
}

export interface UpdateInput { ohlc: Bar[]; screenshot: CandidateScreenshot; reason: string; detectedAtMs?: number }

/** One setup opportunity = one market, one timeframe, one signal candle, one direction. Engines that fire on it share the id. */
export const candidateIdFor = (symbol: string, tf: number, signalCandleOpen: number, direction: Side) =>
  `cand-${sha256(`${symbol}|${tf}|${signalCandleOpen}|${direction}`).slice(0, 16)}`;

export function patternNameOf(engine: EngineName, direction: Side): string {
  if (engine === 'stoch_rsi') return direction === 'BUY' ? 'Stochastic + RSI BUY - up-cross confirmed by a candle pattern' : 'Stochastic + RSI SELL - down-cross confirmed by a candle pattern';
  if (engine === 'structure_sweep') return direction === 'BUY' ? 'Structure-Confirmed Sweep BUY - Bullish Bias + Liquidity Sweep' : 'Structure-Confirmed Sweep SELL - Bearish Bias + Liquidity Sweep';
  if (engine === 'lscc') return direction === 'BUY' ? 'LSCC BUY - Bullish liquidity sweep confirmed' : 'LSCC SELL - Bearish liquidity sweep confirmed';
  const buy = direction === 'BUY', s = buy ? 'Buy' : 'Sell', col = buy ? 'Green' : 'Red';
  if (engine === 'sweep') return `${s} Setup - Liquidity Sweep of Prior ${buy ? 'Low' : 'High'}`;
  if (engine === 'continuation') return `${s} Continuation - Sweep + 2 ${col} Candles`;
  return `${s} Momentum - 3 ${col} Candles, Body Dominance`;
}

export const AI_ROWS = 60;
export const aiRowsHashOf = (ohlc: readonly Bar[]) => candleSetHash(ohlc.slice(-AI_ROWS) as Bar[]);
export const datasetHashOf = (ohlc: readonly Bar[]) => candleSetHash(ohlc as Bar[]);

export function screenshotOf(svg: string, png: Uint8Array | null, capturedAtMs: number, captureMs: number): CandidateScreenshot {
  return { svg, svgSha256: sha256(svg), png, pngSha256: png && png.length ? sha256(png) : null, capturedAtMs, captureMs };
}

/** Everything that must be true of an evidence package before anybody may use it. Returns the problems (empty = consistent). */
export function validateEvidence(e: CandidateEvidence): string[] {
  const p: string[] = [];
  if (e.candidateId !== candidateIdFor(e.symbol, e.tf, e.signalCandleOpen, e.direction)) p.push('candidate id does not match market / timeframe / candle / direction');
  if (!Number.isInteger(e.version) || e.version < 1) p.push('bad evidence version');
  if (e.direction !== 'BUY' && e.direction !== 'SELL') p.push('direction must be BUY or SELL');
  if (!(e.tf > 0)) p.push('bad timeframe');
  if (e.signalCandleClose !== e.signalCandleOpen + e.tf) p.push('signal candle close time is not open + timeframe');
  if (!e.ohlc.length) p.push('no candles');
  else {
    if (e.ohlc.length < 15) p.push(`only ${e.ohlc.length} candles`);
    const bad = e.ohlc.findIndex((c) => !validOhlc(c as any));
    if (bad >= 0) p.push(`invalid OHLC at ${e.ohlc[bad].time}`);
    for (let i = 1; i < e.ohlc.length; i++) if (e.ohlc[i].time <= e.ohlc[i - 1].time) { p.push(`candle times are not strictly increasing at ${e.ohlc[i].time}`); break; }
    if (e.kind === 'ORIGINAL' && e.ohlc[e.ohlc.length - 1].time !== e.signalCandleOpen) p.push('the last candle is not the signal candle');
    if (e.kind === 'ORIGINAL' && !e.ohlc.some((c) => c.time === e.signalCandleOpen)) p.push('the signal candle is not in the candle set');   // an UPDATE without it is not malformed, it invalidates the setup (revalidateSetup)
    if (datasetHashOf(e.ohlc) !== e.candleSetHash) p.push('candle-set hash does not match the candles');
    if (aiRowsHashOf(e.ohlc) !== e.aiRowsHash) p.push('AI-rows hash does not match the candles');
  }
  const s = e.screenshot;
  if (!s || !s.svg) p.push('no screenshot');
  else {
    if (sha256(s.svg) !== s.svgSha256) p.push('screenshot svg hash mismatch');
    if (s.png && s.png.length && sha256(s.png) !== s.pngSha256) p.push('screenshot png hash mismatch');
    if (!(s.capturedAtMs > 0)) p.push('no screenshot timestamp');
  }
  return p;
}

/** Freezes the evidence so no recipient can change what another recipient reads. (The PNG bytes cannot be frozen; they are never written to.) */
export function freezeEvidence<T extends CandidateEvidence>(e: T): Readonly<T> {
  e.ohlc.forEach((c) => Object.freeze(c));
  Object.freeze(e.ohlc); Object.freeze(e.notes); Object.freeze(e.trace);
  Object.freeze(e.validity.reasons); Object.freeze(e.validity); Object.freeze(e.screenshot);
  return Object.freeze(e);
}
