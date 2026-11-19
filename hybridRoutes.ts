// Read-only endpoints for the hybrid AutoTrading layer: what is configured, what was logged, how the cohorts compare.
// Nothing here can place a trade.
import type { Express } from 'express';
import { existsSync } from 'node:fs';
import { analyze } from './src/tradeLog';
import { hybridGatePolicyFromEnv } from './src/hybridGate';
import { policyFromEnv } from './src/aiVerification';
import { safetyFromEnv } from './autoServer';
import { tradeLog } from './signalServer';

export function registerHybridRoutes(app: Express) {
  app.get('/api/hybrid/status', (_req, res) => {
    const path = process.env.HYBRID_MODEL_PATH || 'models/hybrid_model.json';
    res.json({
      status: 'ok',
      hybridGate: hybridGatePolicyFromEnv(), executionPolicy: policyFromEnv(), safety: safetyFromEnv(),
      hybridMode: process.env.HYBRID_MODE || 'AUTO', modelFile: path, modelFilePresent: existsSync(path),
      note: 'Without a trained, validated model file there is no probability: the hybrid layer runs mode B (candlestick + indicator evidence).',
    });
  });
  app.get('/api/hybrid/log', (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const type = typeof req.query.type === 'string' ? req.query.type.toUpperCase() : '';
    const ev = tradeLog.events().filter((e) => !type || e.type === type);
    res.json({ status: 'ok', total: ev.length, events: ev.slice(-limit).reverse() });
  });
  app.get('/api/hybrid/analytics', (req, res) => {
    const payout = Math.min(2, Math.max(0.1, Number(req.query.payout) || 0.9));
    res.json({ status: 'ok', analytics: analyze(tradeLog.events(), payout) });
  });
}
