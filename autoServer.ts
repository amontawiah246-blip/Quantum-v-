// Server-side AI Trading: the same engine as the Pro mode screen (src/autopilot.ts), but it runs here,
// so it keeps trading when the phone is locked or the app is closed. The app only starts, stops and watches it.
import type { Express, Request, Response, NextFunction } from 'express';
import { WebSocket } from 'ws';
import { Autopilot, AutoConfig, DEFAULT_CFG, Deps, Watch } from './src/autopilot';
import { splitName, Asset } from './src/assets';
import type { Candle } from './src/analysis';
import { getSignal, ledger, liveDeps, tradeLog } from './signalServer';
import { AutoRef, lookFromSignal } from './src/autoLook';
import { candidateHub } from './src/candidateHub';
import { lookFromAgents } from './src/candidateLook';
import { makeAgentSource } from './src/agentSource';
import { sweepWatcher, brokerNowSync } from './src/sweepWatcher';
import { runExecutionGate } from './src/executionGate';
import { EXPIRY_DEFAULTS, resolveExpiry } from './src/executionConfig';
import { ANALYSIS_TFS, EXPIRIES, MTG_DEFAULT_MULT, MTG_MAX_STEPS } from './src/tradeSession';
import { derivBridge } from './src/derivBridge';
import { telegramReporter } from './src/telegramReporter';
import { BROKER_TIMEFRAMES, canExecuteTrade, getGlobalTiming, isSupportedExpiry } from './src/globalConfig';

const AUTO_BROKERS = ['pocket', 'quotex', 'iqoption', 'deriv'];   // every broker the bridge can place orders on
const DERIV_TRADABLE = ['risefall'];   // Deriv trade types the bridge can place so far

interface Run { ap: Autopilot; broker: string; cfg: AutoConfig }
let run: Run | null = null;

const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
export function cleanCfg(raw: Record<string, unknown> = {}): AutoConfig {
  const tf = Number(raw.tfSec);
  const exp = Number(raw.expirySec);
  const allowedTfs = new Set<number>([30, ...ANALYSIS_TFS, ...BROKER_TIMEFRAMES]);
  return {
    stake: num(raw.stake, DEFAULT_CFG.stake, 0.01, 100000),
    tfSec: allowedTfs.has(tf) ? tf : getGlobalTiming().tfSec,
    minConf: num(raw.minConf, DEFAULT_CFG.minConf, 55, 95),
    maxTrades: Math.round(num(raw.maxTrades, DEFAULT_CFG.maxTrades, 1, 500)),
    maxLossStreak: Math.round(num(raw.maxLossStreak, DEFAULT_CFG.maxLossStreak, 1, 20)),
    stopLoss: num(raw.stopLoss, DEFAULT_CFG.stopLoss, 1, 1000000),
    minPayout: num(raw.minPayout, DEFAULT_CFG.minPayout, 0, 100),
    scanCount: Math.round(num(raw.scanCount, DEFAULT_CFG.scanCount, 1, 200)),
    mtg: raw.mtg === true || raw.mtg === 'true',
    mtgSteps: Math.round(num(raw.mtgSteps, DEFAULT_CFG.mtgSteps ?? 2, 1, MTG_MAX_STEPS)),
    mtgMult: num(raw.mtgMult, DEFAULT_CFG.mtgMult ?? MTG_DEFAULT_MULT, 1.5, 4),
    autoTiming: raw.autoTiming === true || raw.autoTiming === 'true',
    expirySec: (EXPIRIES.includes(exp) || isSupportedExpiry(exp)) ? exp : 0,
  };
}

const envNum = (name: string, d: number) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : d; };
/** Pre-trade safety limits (all configurable; see .env.example). */
export const safetyFromEnv = () => ({
  maxDeviationAtr: envNum('MAX_ENTRY_DEVIATION_ATR', 0.35),       // price may move this many ATR(14) from the signal candle's close before the setup is cancelled
  maxEntryDelaySec: envNum('MAX_ENTRY_DELAY_SEC', 90),            // seconds after the candle close within which the order must be sent (AI time included)
  maxStake: process.env.MAX_STAKE ? envNum('MAX_STAKE', 0) || null : null,
});

export function makeServerDeps(port: number, broker: string, initial: Asset[], agentSource?: Deps['agentSource']): Deps {
  const base = `http://127.0.0.1:${port}`;
  const pending = new Map<string, { ref: AutoRef; entry: number | null; requestedAtSec: number; why?: string; reasons?: string[]; explanation?: string; aiConfidence?: number | null; aiBasis?: string }>();   // gate-approved setups waiting for their order
  const orderToSignal = new Map<string, string>();
  const lastAnalyze = new Map<string, { why?: string; reasons?: string[]; explanation?: string; aiConfidence?: number | null; aiBasis?: string }>();
  let list = initial, at = Date.now(), loading = false;
  const refresh = () => {
    if (loading || Date.now() - at < 60000) return;
    loading = true;
    fetch(`${base}/api/assets?broker=${encodeURIComponent(broker)}`).then((r) => r.json()).then((a) => {
      if (Array.isArray(a) && a.length) { list = a; at = Date.now(); }
    }).catch(() => { /* keep the old list */ }).finally(() => { loading = false; });
  };
  return {
    agentSource,
    assets: () => {
      refresh();
      return list.map((a) => { const n = splitName(a); return { symbol: a.symbol, label: n.label + (n.otc ? ' OTC' : ''), payout: broker === 'deriv' && !((a.payout ?? 0) > 0) ? 100 : a.payout, active: a.active }; });   // Deriv prices the payout per contract, so it has no fixed percent
    },
    stakeLimit: () => safetyFromEnv().maxStake,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    // The engines + pattern check + AI verification decide, and the execution controller (policy) has the last word: `tradeable`.
    // REJECTED, REVIEW and (unless the user's policy allows engine-only trading) AI_UNAVAILABLE never trade. A setup older than 40% of a candle, or one already traded, never trades.
    analyze: async (symbol, candles, tfSec, nowSec) => {
      const label = splitName(list.find((a) => a.symbol === symbol) ?? ({ symbol } as Asset)).label;
      const clk = nowSec ?? Date.now() / 1000;
      // AGENT MODE (Deriv): the market agents are the only discovery source. This only READS the decision the engines + AI already made on the agent's
      // candidate. It never fetches, scans, draws a screenshot or calls Gemini; no agent setup for this candle = no trade.
      if (agentSource) {
        const res = await lookFromAgents(candidateHub, { symbol, market: `${broker}:${symbol}`, label, tfSec, clk, candles, ledger, waitMs: 5000, maxEntryDelaySec: safetyFromEnv().maxEntryDelaySec });
        if ('ref' in res) lastAnalyze.set(`${symbol}|${res.side}`, { why: res.why });
        return res;
      }
      const sig = await getSignal(liveDeps(port), candles, tfSec, label, `${broker}:${symbol}`, clk);
      // The pure part (is it tradeable, fresh, not already traded?) lives in src/autoLook.ts. Scanning only READS the ledger: the candle is claimed when an order is really sent.
      const res = lookFromSignal(sig, { market: `${broker}:${symbol}`, label, tfSec, clk, candles, ledger });
      if ('ref' in res) {
        lastAnalyze.set(`${symbol}|${res.side}`, {
          why: res.why,
          reasons: sig.reasons,
          explanation: sig.verification?.explanation ?? '',
          aiConfidence: sig.aiConfidence,
          aiBasis: sig.aiConfidenceBasis,
        });
      }
      return res;
    },
    // THE INDEPENDENT EXECUTION SAFETY GATE: runs right before the order, from fresh data. The AI's approval is only one of its inputs.
    preflight: async ({ symbol, side, stake, seconds, tf, expiryByUser, entry, ref, candles, clock, stats, cfg }) => {
      const syncGate = canExecuteTrade();
      if (!syncGate.ok) {
        tradeLog.failure('GATE', syncGate.reason);
        return { ok: false, reason: syncGate.reason };
      }
      const r = ref as AutoRef | undefined;
      if (!r) { tradeLog.failure('GATE', 'order refused: the setup carried no verified signal reference'); return { ok: false, reason: 'no verified signal reference' }; }
      const nowSec = clock ?? Date.now() / 1000;
      const closed = candles.filter((c) => c.time + tf <= nowSec);
      let connected: boolean | null = null;
      try { const st: any = await (await fetch(`${base}/api/status?broker=${encodeURIComponent(broker)}`, { signal: AbortSignal.timeout(5000) })).json(); connected = !!st.ready; } catch { connected = null; }
      // The engine's own choice follows executionConfig (5-minute chart = 5-minute expiry, others one candle). An expiry YOU picked in
      // the app is your decision: it is accepted as long as ALLOW_CUSTOM_EXPIRY is not 0. Set ALLOW_CUSTOM_EXPIRY=0 to restore the strict policy.
      const byUser = expiryByUser && process.env.ALLOW_CUSTOM_EXPIRY !== '0';
      const ex = byUser ? { expirySec: seconds, ok: true } : resolveExpiry(tf, null, EXPIRY_DEFAULTS);
      const rf = broker === 'deriv' ? derivBridge.supportsRiseFall(symbol, ex.expirySec) : { ok: ex.ok };
      const sf = safetyFromEnv();
      const g = runExecutionGate({
        nowSec, tf, expirySec: ex.expirySec, expiryChosenByUser: byUser, engineSide: side === 'buy' ? 'BUY' : 'SELL',
        aiDecision: r.aiDecision, aiDirection: r.aiDirection, engineOnlyByPolicy: r.engineOnly,
        controllerEligible: r.controllerEligible, controllerReason: r.controllerReason, hybridAllow: r.hybridAllow, hybridReason: r.hybridReason,
        closed, signalCandleTime: r.candleTime, screenshotCandleTime: r.screenshotCandleTime, requireScreenshot: r.requireScreenshot,
        entryRef: Number.isFinite(r.refPrice) ? r.refPrice : null, currentPrice: entry, atr: r.atr, maxDeviationAtr: sf.maxDeviationAtr, maxEntryDelaySec: sf.maxEntryDelaySec,
        duplicate: ledger.has(`${r.signalKey}|${r.side}`), conflicting: ledger.has(`${r.signalKey}|${r.side === 'BUY' ? 'SELL' : 'BUY'}`),
        brokerConnected: connected, expiryOffered: ex.ok && rf.ok,
        stake, maxStake: sf.maxStake,
        risk: { tradesTaken: stats.trades, maxTrades: cfg.maxTrades, lossStreak: stats.streak, maxLossStreak: cfg.maxLossStreak, pnl: stats.pnl, stopLoss: cfg.stopLoss },
      });
      // The candidate this setup came from must still be valid and fresh at the moment of the order: an updated chart that invalidated it cancels the trade.
      if (r.candidateId) {
        const cc = candidateHub.executionCheck(r.candidateId, { nowSec, maxEntryDelaySec: sf.maxEntryDelaySec });
        if (!cc.ok) { tradeLog.failure('GATE', `candidate ${r.candidateId}: ${cc.reason}`, r.signalId); return { ok: false, reason: `candidate: ${cc.reason}`.slice(0, 160) }; }
      }
      tradeLog.gate(r.signalId, g.action, g.failed.map((c) => c.id), g.reason);
      if (g.action === 'NO_TRADE') { tradeLog.failure('GATE', g.reason, r.signalId); return { ok: false, reason: g.reason.slice(0, 160) }; }
      const extra = lastAnalyze.get(`${symbol}|${side}`);
      pending.set(`${symbol}|${side}`, { ref: r, entry, requestedAtSec: nowSec, ...extra });
      return { ok: true, reason: g.reason };
    },
    watch: (symbol, tfSec) => new Promise<Watch>((resolve, reject) => {
      let price: number | null = null, got = false, clock: number | null = null;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?broker=${encodeURIComponent(broker)}&asset=${encodeURIComponent(symbol)}&tf=${tfSec}`);
      const fail = (m: string) => { if (!got) { got = true; clearTimeout(to); try { ws.close(); } catch { /* closed */ } reject(new Error(m)); } };
      const to = setTimeout(() => fail('The bridge did not answer in time'), 30000);
      ws.on('error', () => fail('Could not reach the bridge'));
      ws.on('close', () => fail('The bridge closed the connection'));
      ws.on('message', (raw) => {
        let m: any; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type === 'history' && !got && Array.isArray(m.candles) && m.candles.length) {
          got = true; clearTimeout(to);
          const history = m.candles as Candle[];
          const w: Watch = { candles: history, price: () => price, clock: () => clock, close: () => { try { ws.close(); } catch { /* closed */ } } };
          // wait (briefly) for a live tick: its timestamp is the broker's clock, which decides which candle is still forming
          const t0 = Date.now(); const iv = setInterval(() => {
            if (clock != null || Date.now() - t0 > 4000) {
              clearInterval(iv);
              if (price == null && history.length) {
                const newest = history[history.length - 1];
                const estNow = clock ?? brokerNowSync();
                if (newest.time + tfSec > estNow) price = newest.close;
              }
              resolve(w);
            }
          }, 100);
        } else if (m.type === 'tick' && typeof m.price === 'number') { price = m.price; if (typeof m.ts === 'number') clock = m.ts; }
        else if (m.type === 'error') fail(m.msg || 'Bridge error');
      });
    }),
    place: async (symbol, side, stake, seconds) => {
      const p = pending.get(`${symbol}|${side}`);
      pending.delete(`${symbol}|${side}`);
      // The duplicate ledger is claimed HERE, when an order is really about to be sent, atomically: two orders for one candle and side cannot both pass.
      const ledgerKey = p ? `${p.ref.signalKey}|${p.ref.side}` : null;
      if (ledgerKey && !ledger.claim(ledgerKey)) { tradeLog.failure('ORDER', 'duplicate order blocked', p!.ref.signalId); return { ok: false, msg: 'duplicate order blocked' }; }
      if (p?.ref.candidateId && !candidateHub.markExecuted(p.ref.candidateId)) { if (ledgerKey) ledger.release(ledgerKey); tradeLog.failure('ORDER', 'candidate already executed', p.ref.signalId); return { ok: false, msg: 'this candidate was already executed' }; }
      if (p?.ref.candidateId) candidateHub.emit({ type: 'ordering', candidateId: p.ref.candidateId, side: p.ref.side });
      try {
        const cand = p?.ref.candidateId ? candidateHub.get(p.ref.candidateId) : undefined;
        const candSig = cand?.decision?.signal as any;
        const meta = p ? {
          mode: 'pro',
          candidateId: p.ref.candidateId,
          tf: p.ref.tf,
          label: p.ref.label,
          why: p.why,
          reasons: p.reasons ?? candSig?.reasons,
          explanation: p.explanation ?? candSig?.verification?.explanation,
          aiConfidence: p.aiConfidence ?? candSig?.aiConfidence,
          aiBasis: p.aiBasis ?? candSig?.aiConfidenceBasis,
          engines: cand ? [cand.versions[0]?.engine, ...cand.coDetectedBy].filter(Boolean) : undefined,
          notes: cand?.versions[0]?.notes,
          stochRsi: cand?.versions[0]?.stochRsi ?? null,
          signalCandleOpen: p.ref.candleTime,
          entryPrice: p.entry,
          candles: p.ref.closed,
        } : undefined;
        const r = await fetch(`${base}/api/trade`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ broker, asset: symbol, side, amount: stake, seconds, meta }), signal: AbortSignal.timeout(40000) });
        const d: any = await r.json();
        const ok = d.status === 'ok';
        const placedAtSec = Date.now() / 1000;
        if (p) {
          if (ok) {
            if (d.id) orderToSignal.set(String(d.id), p.ref.signalId);
            if (p.ref.candidateId) candidateHub.emit({ type: 'ordered', candidateId: p.ref.candidateId, side: p.ref.side, brokerOrderId: d.id ? String(d.id) : undefined });
            tradeLog.order({ id: p.ref.signalId, brokerOrderId: d.id ? String(d.id) : null, market: p.ref.market, side: p.ref.side, stake, expirySec: seconds, signalCloseTime: p.ref.closeTime, requestedAtSec: p.requestedAtSec, placedAtSec, delaySec: placedAtSec - p.ref.closeTime, entryRef: Number.isFinite(p.ref.refPrice) ? p.ref.refPrice : null, priceAtOrder: p.entry, settleAtSec: placedAtSec + seconds });
          } else { if (ledgerKey) ledger.release(ledgerKey); if (p.ref.candidateId) { candidateHub.unmarkExecuted(p.ref.candidateId); candidateHub.emit({ type: 'order_failed', candidateId: p.ref.candidateId, reason: `broker refused: ${d.msg || 'no reason'}` }); } tradeLog.failure('ORDER', `broker refused: ${d.msg || 'no reason'}`, p.ref.signalId); }
        }
        return { ok, msg: d.msg || '', id: d.id ? String(d.id) : undefined };
      } catch { if (ledgerKey) ledger.release(ledgerKey); if (p?.ref.candidateId) { candidateHub.unmarkExecuted(p.ref.candidateId); candidateHub.emit({ type: 'order_failed', candidateId: p.ref.candidateId, reason: 'could not reach the bridge' }); } if (p) tradeLog.failure('ORDER', 'could not reach the bridge', p.ref.signalId); return { ok: false, msg: 'Could not reach the bridge' }; }
    },
    onOutcome: (info) => {
      if (info.contractId) {
        void telegramReporter.handleTradeOutcome({
          contractId: info.contractId,
          outcome: info.outcome,
          profit: info.profit,
        });
      }
    },
    result: async (id, seconds) => {
      await new Promise((r) => setTimeout(r, seconds * 1000 + 500));          // let the trade run out first
      try {
        const r = await fetch(`${base}/api/trade-result?broker=${encodeURIComponent(broker)}&id=${encodeURIComponent(id)}&seconds=30`, { signal: AbortSignal.timeout(90000) });
        const d: any = await r.json();
        if (d.status !== 'ok' || !['win', 'loss', 'draw'].includes(d.result)) { tradeLog.failure('OUTCOME', `broker result unreadable for order ${id}`, orderToSignal.get(id)); return null; }
        const sid = orderToSignal.get(id);
        if (sid) tradeLog.outcome({ id: sid, brokerOrderId: id, outcome: d.result, profit: typeof d.profit === 'number' ? d.profit : null });
        return { outcome: d.result, profit: typeof d.profit === 'number' ? d.profit : null };
      } catch { return null; }
    },
  };
}

/** Optional protection: when TRADE_PIN is set, anything that can place trades needs the header x-pin. */
function pinGuard(req: Request, res: Response, next: NextFunction) {
  const pin = process.env.TRADE_PIN;
  if (!pin || req.headers['x-pin'] === pin) return next();
  res.status(401).json({ status: 'error', msg: 'PIN required' });
}

export function registerAutoRoutes(app: Express, bridgePort: number) {
  app.use(['/api/trade', '/api/auto', '/api/account'], pinGuard);

  app.get('/api/auto/state', (_req, res) => {
    res.json({ active: !!run?.ap.running, broker: run?.broker ?? '', cfg: run?.cfg ?? null, state: run?.ap.state ?? null, now: Date.now() });
  });

  app.post('/api/auto/start', async (req, res) => {
    const syncGate = canExecuteTrade();
    if (!syncGate.ok) return res.status(409).json({ status: 'error', msg: syncGate.reason, transitioning: true });
    if (run?.ap.running) return res.status(409).json({ status: 'error', msg: 'AI Trading is already running' });
    const broker = String(req.body?.broker ?? '');
    if (!AUTO_BROKERS.includes(broker)) return res.json({ status: 'error', msg: 'AI Trading does not support this broker' });
    const derivType = String(req.body?.derivType ?? req.body?.cfg?.derivType ?? 'risefall');
    if (broker === 'deriv' && !DERIV_TRADABLE.includes(derivType)) return res.json({ status: 'error', msg: 'On Deriv, AI Trading can place Rise/Fall trades only for now. Pick Rise/Fall as the trade type.' });
    const central = getGlobalTiming();
    const cfg = cleanCfg(req.body?.cfg);
    if (!cfg.expirySec) cfg.expirySec = central.expirySec;
    if (broker === 'iqoption' && cfg.tfSec === 30) cfg.tfSec = 60;   // IQ Option expiries sit on whole minutes
    try {
      if (broker === 'deriv' && !derivBridge.tradable) {
        await derivBridge.ensureAuthConnected(6000).catch(() => {});
      }
      const base = `http://127.0.0.1:${bridgePort}`;
      const st: any = await (await fetch(`${base}/api/status?broker=${broker}`, { signal: AbortSignal.timeout(15000) })).json();
      if (!st.ready) return res.json({ status: 'error', msg: st.error || 'The broker is not connected yet' });
      // market data alone is not enough to trade: Deriv orders need the logged-in account (PAT). Refuse here, not after a setup was approved.
      if (broker === 'deriv' && st.tradable === false) return res.json({ status: 'error', msg: st.error || 'Deriv account not connected. Please enter your Deriv PAT Token on the API screen, then start AI Trading.' });
      const assets = await (await fetch(`${base}/api/assets?broker=${broker}`, { signal: AbortSignal.timeout(20000) })).json();
      if (!Array.isArray(assets) || !assets.length) return res.json({ status: 'error', msg: 'No markets loaded yet, try again in a moment' });
      // Deriv: the existing market agents are the ONLY discovery source. AutoTrade subscribes to their approved setups; it starts no scanner,
      // and switching it on or off never starts, stops or touches the agents. (Other brokers have no agents: they keep the original scan loop.)
      let source: ReturnType<typeof makeAgentSource> | undefined;
      if (broker === 'deriv') {
        if (!sweepWatcher.getState().running) sweepWatcher.start(central.tfSec, 0);          // the agents are the scanner: Pro mode starts them itself on the chosen time frame
        const sw = sweepWatcher.getState();
        if (!sw.running) return res.json({ status: 'error', msg: 'The market agents could not be started.' });
        cfg.tfSec = central.tfSec;                            // AutoTrade trades the global central timeframe
        source = makeAgentSource(candidateHub, {
          labelOf: (sym, fb) => { const a = (assets as Asset[]).find((x) => x.symbol === sym); return a ? splitName(a).label : fb; },
          tfSec: () => getGlobalTiming().tfSec,
          agentsActive: () => { const st = sweepWatcher.getState(); return st.running ? st.agents - st.failed.length : 0; },
          nowSec: brokerNowSync, maxEntryDelaySec: safetyFromEnv().maxEntryDelaySec, ledger,
        });
      }
      const ap = new Autopilot(makeServerDeps(bridgePort, broker, assets, source), cfg);
      run = { ap, broker, cfg };
      console.log(`[Auto] started on ${broker}: ${JSON.stringify(cfg)}`);
      ap.start().catch((e) => ap.stop(`Engine error: ${(e as Error).message}`));
      res.json({ status: 'ok' });
    } catch (e) {
      res.json({ status: 'error', msg: `Could not start: ${(e as Error).message}` });
    }
  });

  app.post('/api/auto/stop', (_req, res) => {
    run?.ap.stop('Stopped by you');
    res.json({ status: 'ok' });
  });

  app.post('/api/auto/clear', (_req, res) => {
    if (run && !run.ap.running) run = null;
    res.json({ status: 'ok' });
  });
}
