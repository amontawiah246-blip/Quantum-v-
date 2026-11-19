// Test fixtures for the AI verification tests: deterministic candles, a fake Gemini that answers in the real schema, a fake rasterizer.
import type { AiCaller, AiRequest } from './aiVerification';
import type { EngineResult, Cand } from '../signalServer';

export const TF = 300;                       // five-minute binary-options candles
export const T0 = 1_700_000_100;             // multiple of 300
export type Trend = 'up' | 'down' | 'flat';

function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** 60 closed candles of a trend (or a sideways market) ending around 100. */
export function market(trend: Trend, n = 60, seed = 7): Cand[] {
  const r = rng(seed), out: Cand[] = [];
  let p = trend === 'up' ? 100 - n * 0.12 : trend === 'down' ? 100 + n * 0.12 : 100;
  for (let i = 0; i < n; i++) {
    const open = p;
    const drift = trend === 'up' ? 0.12 : trend === 'down' ? -0.12 : 0;
    const close = trend === 'flat' ? 100 + 0.25 * Math.sin(i / 2.2) + (r() - 0.5) * 0.08 : open + drift + (r() - 0.5) * 0.05;
    out.push({ time: T0 + i * TF, open, close, high: Math.max(open, close) + r() * 0.04, low: Math.min(open, close) - r() * 0.04 });
    p = close;
  }
  return out;
}

const last = (cs: Cand[]) => cs[cs.length - 1];
const next = (cs: Cand[]) => last(cs).time + TF;

/** Appends [previous candle, signal candle]. Neither engulfs the other: only the wick goes through the previous extreme. */
export function withSweep(cs: Cand[], side: 'BUY' | 'SELL', o: { touchOnly?: boolean; wrongColours?: boolean } = {}): Cand[] {
  const p = last(cs).close, t = next(cs);
  const buy = side === 'BUY';
  const s = buy ? 1 : -1;
  const prev: Cand = buy
    ? { time: t, open: p, close: p - 0.2, high: p + 0.03, low: p - 0.25 }
    : { time: t, open: p, close: p + 0.2, high: p + 0.25, low: p - 0.03 };
  const sweepExtreme = buy ? prev.low : prev.high;
  const wickTo = o.touchOnly ? sweepExtreme : sweepExtreme - s * 0.07;
  const sig: Cand = buy
    ? { time: t + TF, open: p - 0.18, close: p - 0.02, high: p + 0.0, low: wickTo }
    : { time: t + TF, open: p + 0.18, close: p + 0.02, high: wickTo, low: p - 0.0 };
  if (o.wrongColours) {
    // previous candle has the wrong colour AND the signal candle closes the wrong way
    return [...cs, { ...prev, open: prev.close, close: prev.open }, { ...sig, open: sig.close, close: sig.open }];
  }
  return [...cs, prev, sig];
}

/** "now" = a few seconds after the signal candle closed (the new candle has just started). */
export const nowAfter = (cs: Cand[], plusSec = 5) => (last(cs).time + TF + plusSec) * 1000;

export function engine(side: 'BUY' | 'SELL', o: Partial<EngineResult> = {}): EngineResult {
  return {
    status: 'setup', setup: true, side, confidence: 75, agree: 2, candles: 62,
    sweep: { side, reasons: [side === 'BUY' ? 'Green candle wicked below the previous low, body held above it' : 'Red candle wicked above the previous high, body stayed below it'] },
    indicators: null, pattern: null, continuation: null, momentum: null,
    reasons: [`Wick Sweep (${side}): wick rejection`], ...o,
  };
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const fakeRasterizer = async () => PNG;

type Patch = Record<string, unknown>;
/** A well-formed answer in the real schema. `patch` replaces whole top-level sections. */
export function reply(req: AiRequest, patch: Patch = {}): string {
  return JSON.stringify({
    requestId: req.requestId, signalCandleTime: req.signalCandleTime,
    pattern: { verdict: 'CONFIRMED', ruleResults: req.ruleIds.map((id) => ({ ruleId: id, pass: true, observed: 'ok' })), failedRuleIds: [], notes: 'rules hold' },
    market: { regime: 'RANGING', trendRelation: 'NEUTRAL', momentum: 'MIXED', volatility: 'SUITABLE', repeatedSweeps: false, exhaustionOrContinuation: 'NONE', quality: 'GOOD', warnings: [] },
    screenshot: { inspected: !!req.image, lastCandleTimeSeen: req.image ? req.expectedCandleLabel : null, matchesOhlc: req.image ? true : null, disagreement: null },
    explanation: 'Clean wick rejection of the previous extreme.', risk: 'LOW', ...patch,
  });
}

/** A fake Gemini. `make` may return a patch (or a full raw string) per request; every request is recorded. */
export function fakeAi(make: (req: AiRequest) => Patch | string = () => ({})): AiCaller & { calls: AiRequest[] } {
  const f = (async (req: AiRequest) => {
    f.calls.push(req);
    const r = make(req);
    return { text: typeof r === 'string' ? r : reply(req, r), imageSent: !!req.image };
  }) as AiCaller & { calls: AiRequest[] };
  f.calls = [];
  return f;
}
