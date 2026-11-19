// The "ai" recipient of the candidate hub: the EXISTING signal pipeline (signalServer.getSignal = pattern arithmetic, market quality,
// Gemini with the screenshot, hybrid gate, execution policy), fed with the candidate's own evidence. It draws no screenshot of its own:
// Gemini receives the picture the market agent drew, with the candles that picture was drawn from.
import { getSignal, type Cand, type SignalDeps } from '../signalServer';
import { ScreenshotImage, candleLabel } from './aiVerification';
import type { CandidateEvidence } from './candidateTypes';
import type { PipelineAnswer, PipelineRunner } from './verificationCoordinator';

/** The candidate's own screenshot in the shape the AI request carries. null when no PNG could be made (the AI then reports NOT_SENT honestly). */
export function imageOf(ev: CandidateEvidence): ScreenshotImage | null {
  const s = ev.screenshot;
  if (!s.png || !s.png.length || !s.pngSha256) return null;
  return { mimeType: 'image/png', base64: Buffer.from(s.png).toString('base64'), sha256: s.pngSha256, lastCandleTime: ev.signalCandleOpen, lastCandleLabel: candleLabel(ev.signalCandleOpen), renderedAt: Math.floor(s.capturedAtMs / 1000), candleSetHash: ev.aiRowsHash };
}

export function makePipeline(deps: () => SignalDeps, keyOf: (ev: CandidateEvidence) => string = (ev) => `deriv:${ev.symbol}`): PipelineRunner {
  return async (ev, ctx): Promise<PipelineAnswer> => {
    const sig = await getSignal({ ...deps(), image: imageOf(ev) }, ev.ohlc as Cand[], ev.tf, ev.market, keyOf(ev), ctx.nowSec);
    const sv = sig.verification?.screenshotVerification;
    return {
      tradeable: sig.tradeable, side: sig.side === 'buy' ? 'BUY' : sig.side === 'sell' ? 'SELL' : null, status: sig.status, reasons: sig.reasons.slice(-3),
      imageSha256: sv?.imageSha256 ?? null, aiRowsHash: sv?.candleSetHash ?? null, signal: sig,
    };
  };
}
