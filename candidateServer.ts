// Live wiring of the candidate hub: the recipients that verify every setup the market agents publish, and the audit routes.
//
//   market agent (src/sweepWatcherCore.ts)  ->  candidateHub.publish(screenshot + OHLC)
//        -> engine:sweep | engine:continuation | engine:momentum | ai   (all at once, the same frozen evidence)
//        -> coordinator collects the independent answers  ->  ONE decision per candidate  ->  AutoTrading reads it (autoServer.ts)
//
// The "ai" recipient is the EXISTING signal pipeline (signalServer.getSignal: pattern arithmetic, market quality, Gemini with the screenshot,
// hybrid gate, execution policy). It is given the agent's screenshot instead of drawing its own, so Gemini sees what the agents saw.
import type { Express } from 'express';
import { candidateHub } from './src/candidateHub';
import { VerificationCoordinator } from './src/verificationCoordinator';
import { makePipeline } from './src/candidatePipeline';
import { liveDeps } from './signalServer';
import { agentMode } from './src/agentMode';
import { safetyFromEnv } from './autoServer';
import { brokerNow, brokerNowSync } from './src/sweepWatcher';

const envNum = (n: string, d: number) => { const v = Number(process.env[n]); return Number.isFinite(v) && v > 0 ? v : d; };

export function registerCandidateRoutes(app: Express, port: number) {
  const pipeline = makePipeline(() => liveDeps(port));
  const coordinator = new VerificationCoordinator(candidateHub, {
    pipeline, nowSec: brokerNowSync, maxEntryDelaySec: safetyFromEnv().maxEntryDelaySec,
    enabled: () => agentMode.active, aiConcurrency: envNum('CANDIDATE_AI_CONCURRENCY', 2), aiTimeoutMs: envNum('CANDIDATE_AI_TIMEOUT_MS', 60000),
  }).start();
  // the freshness clock is the broker's; measure its offset now so brokerNowSync() is exact from the first candidate
  brokerNow().then((n) => { if (n > 1e9) console.log(`[Candidates] ready, broker clock ${new Date(n * 1000).toISOString()}`); }).catch(() => { /* the local clock is used until then */ });

  const summary = (r: ReturnType<typeof candidateHub.get>) => {
    const v = r!.versions, first = v[0], last = v[v.length - 1];
    return {
      candidateId: r!.id, agentId: first.agentId, symbol: first.symbol, market: first.market, engine: first.engine, coDetectedBy: r!.coDetectedBy, direction: first.direction, tf: first.tf,
      signalCandleOpen: first.signalCandleOpen, signalCandleClose: first.signalCandleClose, screenshotAtMs: first.screenshotAtMs, status: r!.status, invalidReason: r!.invalidReason,
      versions: v.length, latestVersion: last.version, candleSetHash: first.candleSetHash, latestCandleSetHash: last.candleSetHash, executed: r!.executed,
      decision: r!.decision ? { action: r!.decision.action, evaluatedVersion: r!.decision.evaluatedVersion, reasons: r!.decision.reasons, corroboratedBy: r!.decision.corroboratedBy, decidedAtMs: r!.decision.decidedAtMs } : null,
    };
  };

  app.get('/api/candidates', (req, res) => res.json({ status: 'ok', candidates: candidateHub.list(Math.min(200, Number(req.query.limit) || 50)).map(summary) }));
  app.get('/api/candidates/metrics', (_req, res) => res.json({ status: 'ok', recipients: candidateHub.recipients, ...candidateHub.metrics.summary() }));
  app.get('/api/candidates/:id', (req, res) => {
    const r = candidateHub.get(String(req.params.id));
    if (!r) return res.status(404).json({ status: 'error', msg: 'unknown candidate' });
    res.json({
      ...summary(r),
      versionLog: r.versions.map((v) => ({ version: v.version, kind: v.kind, candleSetHash: v.candleSetHash, aiRowsHash: v.aiRowsHash, screenshotAtMs: v.screenshotAtMs, screenshotSha256: v.screenshot.pngSha256 ?? v.screenshot.svgSha256, validity: v.validity, reason: v.reason, rows: v.ohlc.length, lastCandle: v.ohlc[v.ohlc.length - 1]?.time })),
      results: r.results.map(({ ...x }) => { const o: any = { ...x }; if (o.answer) o.answer = { ...o.answer, signal: undefined }; return o; }), rejectedResults: r.rejectedResults,
      decisionHistory: r.decisionHistory.map((d) => ({ ...d, signal: undefined })),
    });
  });
  app.get('/api/candidates/:id/screenshot', (req, res) => {
    const r = candidateHub.get(String(req.params.id));
    const v = r?.versions[(Number(req.query.version) || 1) - 1];
    if (!v) return res.status(404).json({ status: 'error', msg: 'unknown candidate or version' });
    if (req.query.format !== 'svg' && v.screenshot.png) { res.setHeader('Content-Type', 'image/png'); return res.end(Buffer.from(v.screenshot.png)); }
    res.setHeader('Content-Type', 'image/svg+xml'); res.end(v.screenshot.svg);
  });
  return coordinator;
}
