// Classic mode, server side: the chart that is generated under every signal.
//
//   GET /api/classic/chart/:candidateId                      the setup chart BEFORE the trade: candles, Stochastic panel, RSI panel, the candle pattern that confirmed it, key levels,
//                                                            the entry arrow in the next candle slot (the same chart the agent drew for Gemini, in the signal-card layout)
//   GET /api/classic/chart/:candidateId?entryTime=..&entryPrice=..&expiry=..[&result=win|loss|draw][&exitPrice=..]
//                                                            the same chart AFTER the trade: later candles added, the trade window shaded from entry to expiry, entry and exit marks,
//                                                            WIN / LOSS tag. Called again when the result arrives, so the picture follows the trade.
// SVG is returned (an <img> shows it directly); no rasterizer is needed.
import type { Express } from 'express';
import { candidateHub } from './src/candidateHub';
import { derivBridge } from './src/derivBridge';
import { renderIndicatorSvg, type IndicatorTrade } from './src/indicatorChart';
import { STOCH_RSI_WINDOW } from './src/stochRsi';

const num = (v: unknown): number | null => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : null; };

export function registerClassicRoutes(app: Express) {
  app.get('/api/classic/chart/:id', async (req, res) => {
    try {
      const rec = candidateHub.get(String(req.params.id));
      if (!rec) return res.status(404).json({ status: 'error', msg: 'unknown or expired setup' });
      const o = rec.versions[0], latest = rec.versions[rec.versions.length - 1];
      let candles = latest.ohlc.map((c) => ({ ...c })).filter((c) => c.time <= o.signalCandleOpen || false);
      const entryTime = num(req.query.entryTime), entryPrice = num(req.query.entryPrice), expiry = num(req.query.expiry);
      let trade: IndicatorTrade | null = null;
      if (entryTime != null && entryPrice != null && expiry != null && expiry > 0) {
        const r = String(req.query.result ?? '').toLowerCase();
        trade = { time: entryTime, price: entryPrice, expirySec: expiry, result: r === 'win' ? 'WIN' : r === 'loss' ? 'LOSS' : r === 'draw' ? 'DRAW' : 'PENDING', exitPrice: num(req.query.exitPrice) };
        try {
          // the candles after the signal candle, up to the one the trade expires in (only what really happened is drawn)
          const more = await derivBridge.getCandles(o.symbol, o.tf, STOCH_RSI_WINDOW + 20);
          candles = more.filter((c) => c.time < entryTime + expiry && c.time + o.tf > candles[0].time).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
        } catch { /* keep the setup candles */ }
      }
      const svg = renderIndicatorSvg(candles.slice(-STOCH_RSI_WINDOW), {
        side: o.direction, ok: true, tf: o.tf, market: o.market, symbol: o.symbol, meta: o.stochRsi ?? null, notes: o.notes, signalTime: o.signalCandleOpen,
        compact: true, levels: true, trade, visible: trade ? 34 : 36,
      });
      res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'no-store');
      res.end(svg);
    } catch (e) { res.status(500).json({ status: 'error', msg: (e as Error).message }); }
  });
}
