// "Auto" on the Signals page: scans every open market of the broker with the three engines + the AI check,
// and stops at the best verified setup. It runs here on the server, so the chart is never touched.
import type { Express } from 'express';
import type { Asset } from './src/assets';
import { getSignal, liveDeps } from './signalServer';
import { makeServerDeps } from './autoServer';
import { candidateHub } from './src/candidateHub';
import { makePipeline } from './src/candidatePipeline';
import { sweepWatcher, brokerNowSync } from './src/sweepWatcher';
import { safetyFromEnv } from './autoServer';
import { derivBridge } from './src/derivBridge';
import { canExecuteTrade, getGlobalTiming, isSupportedExpiry, isSupportedTimeframe, setGlobalTiming } from './src/globalConfig';

const BROKERS = ['pocket', 'quotex', 'iqoption', 'deriv'];

interface Top {
  symbol: string; label: string; side: 'buy' | 'sell'; confidence: number; verified: boolean;
  /** agent mode only: the candidate this setup came from (its chart: GET /api/classic/chart/:candidateId), and what the AI said about it */
  candidateId?: string; aiConfidence?: number | null; aiBasis?: string; explanation?: string; risk?: string | null; decision?: string | null;
  reasons?: string[]; tf?: number; expirySec?: number; signalCloseTime?: number; entry?: number; engines?: string[]; blocked?: string;
}
export interface ScanState {
  running: boolean; found: boolean; broker: string; tfSec: number; pass: number;
  total: number; done: number; failed: number; message: string; best: Top | null; top: Top[]; at: number;
}
const blank = (): ScanState => ({ running: false, found: false, broker: '', tfSec: getGlobalTiming().tfSec, pass: 0, total: 0, done: 0, failed: 0, message: '', best: null, top: [], at: Date.now() });
let state = blank();
let token = 0;

const CONCURRENCY = 6;

async function loop(port: number, broker: string, tfSec: number, minPayout: number, initial: Asset[], my: number) {
  const deps = makeServerDeps(port, broker, initial);
  const sig = liveDeps(port);
  const alive = () => my === token;
  while (alive()) {
    const syncGate = canExecuteTrade();
    if (syncGate.transitioning) {
      state = { ...state, message: syncGate.reason, at: Date.now() };
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    const pool = deps.assets().filter((a) => a.active !== false && (a.payout ?? 0) >= minPayout).sort((a, b) => (b.payout ?? 0) - (a.payout ?? 0));
    state = { ...state, pass: state.pass + 1, total: pool.length, done: 0, failed: 0, top: [], best: null, message: pool.length ? `Scanning ${pool.length} markets` : 'No open markets match', at: Date.now() };
    const hits: (Top & { age: number; payout: number; aiOff: boolean })[] = [];
    let next = 0, aiOff = false;
    const worker = async () => {
      while (alive()) {
        const i = next++; if (i >= pool.length) return;
        const m = pool[i];
        try {
          const w = await deps.watch(m.symbol, tfSec);
          try {
            const clk = w.clock?.() ?? Date.now() / 1000;
            const s = await getSignal(sig, w.candles, tfSec, m.label, `${broker}:${m.symbol}`, clk);
            if (s.setup && s.side) {
              if (!s.tradeable) aiOff = aiOff || s.ai?.status === 'unavailable';
              const age = clk - (s.candleTime + tfSec);
              if (age <= Math.max(20, tfSec * 0.5) || !s.tradeable) hits.push({ symbol: m.symbol, label: m.label, side: s.side, confidence: s.confidence, verified: s.tradeable, age, payout: m.payout ?? 0, aiOff });
            }
          } finally { w.close(); }
          state = { ...state, done: state.done + 1 };
        } catch { state = { ...state, done: state.done + 1, failed: state.failed + 1 }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, pool.length)) }, worker));
    if (!alive()) return;
    const ranked = hits.filter((h) => h.verified).sort((a, b) => b.confidence - a.confidence || b.payout - a.payout);
    const top = ranked.slice(0, 5).map(({ symbol, label, side, confidence, verified }) => ({ symbol, label, side, confidence, verified }));
    if (ranked.length) {
      const b = top[0];
      state = { ...state, running: false, found: true, best: b, top, message: `Best of ${state.done - state.failed} markets: ${b.label}`, at: Date.now() };
      return;
    }
    const unver = hits.length && aiOff ? 'The engines found setups but the AI verification is unavailable (check GEMINI_API_KEY, quota and screenshot support); they are not traded unless your policy allows engine-only trading. ' : '';
    state = { ...state, message: `${unver}No verified setup in ${state.done - state.failed} markets. Scanning again after the next candle.`, at: Date.now() };
    const ms = (tfSec - ((Date.now() / 1000) % tfSec)) * 1000 + 3000;
    const end = Date.now() + ms;
    while (alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
  }
}

/** Deriv Auto scan: no market is fetched or drawn here. It reads the setups the market agents already published, with the screenshot each agent drew,
 *  and runs the normal signal check (engines + AI + hybrid) on that same picture. Waits for the agents until a verified setup shows up. */
async function agentLoop(port: number, my: number) {
  const alive = () => my === token;
  const run = makePipeline(() => liveDeps(port));
  const maxDelay = safetyFromEnv().maxEntryDelaySec;
  const done = new Map<string, Top & { age: number }>();
  const rankOf = (h: Top) => (h.aiConfidence ?? h.confidence);
  state = { ...state, pass: 1, message: 'Listening to the market agents' };
  while (alive()) {
    const syncGate = canExecuteTrade();
    if (syncGate.transitioning) {
      state = { ...state, message: syncGate.reason, at: Date.now() };
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    const sw = sweepWatcher.getState();
    if (!sw.running) { state = { ...state, running: false, message: 'The market agents are not running. Start them in the Menu, then try Auto again.' }; return; }
    const now = brokerNowSync();
    const expirySec = getGlobalTiming().expirySec;
    const fresh = candidateHub.list(200).filter((r) => r.tf === sw.tf && r.status !== 'INVALIDATED' && !r.executed && candidateHub.executionCheck(r.id, { nowSec: now, maxEntryDelaySec: maxDelay }).reason.indexOf('decision is') < 0
      && now - r.versions[0].signalCandleClose >= 0 && now - r.versions[0].signalCandleClose <= maxDelay);
    const rejected = [...done.values()].filter((h) => !h.verified).length;
    state = { ...state, total: fresh.length, done: done.size, message: fresh.length ? `Checking ${fresh.length} agent setup${fresh.length > 1 ? 's' : ''}` : `Listening to ${sw.agents - sw.failed.length} market agents for a setup${rejected ? ` (${rejected} setup${rejected > 1 ? 's' : ''} not verified or unsupported for ${expirySec}s Rise/Fall)` : ''}`, at: Date.now() };
    await Promise.all(fresh.filter((r) => !done.has(r.id)).map(async (r) => {
      const v1 = r.versions[0];
      const rf = derivBridge.supportsRiseFall(r.symbol, expirySec);
      if (!rf.ok) {
        done.set(r.id, {
          symbol: r.symbol, label: v1.market, side: r.direction === 'SELL' ? 'sell' : 'buy', confidence: 0, verified: false,
          age: now - v1.signalCandleClose, candidateId: r.id, blocked: rf.reason || `${v1.market} does not support ${expirySec}s Rise/Fall`,
        });
        return;
      }
      try {
        const a = await run(v1, { nowSec: brokerNowSync() });
        const g: any = a.signal;
        done.set(r.id, {
          symbol: r.symbol, label: v1.market, side: a.side === 'SELL' ? 'sell' : 'buy', confidence: g?.confidence ?? 0, verified: a.tradeable, age: now - v1.signalCandleClose,
          candidateId: r.id, aiConfidence: g?.aiConfidence ?? null, aiBasis: g?.aiConfidenceBasis ?? '', explanation: g?.verification?.explanation ?? '', risk: g?.verification?.risk ?? null,
          decision: g?.decision ?? null, reasons: Array.isArray(g?.reasons) ? g.reasons.slice(-4) : [], tf: v1.tf, expirySec, signalCloseTime: v1.signalCandleClose,
          entry: v1.entry, engines: [v1.engine, ...r.coDetectedBy], blocked: a.tradeable ? undefined : String(g?.verification?.execution?.reason ?? a.status ?? '').slice(0, 160),
        });
      } catch { done.set(r.id, { symbol: r.symbol, label: v1.market, side: r.direction === 'SELL' ? 'sell' : 'buy', confidence: 0, verified: false, age: 0, candidateId: r.id, blocked: 'the AI check failed' }); }
    }));
    const ranked = [...done.values()].filter((h) => h.verified).sort((a, b) => rankOf(b) - rankOf(a));
    if (ranked.length) {
      const top = ranked.slice(0, 5).map(({ age: _age, ...rest }) => rest);
      state = { ...state, running: false, found: true, best: top[0], top, message: `Best agent setup: ${top[0].label}`, at: Date.now() };
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function registerScanRoutes(app: Express, port: number) {
  app.get('/api/scan/state', (_q, res) => res.json({ ...state, now: Date.now() }));
  app.post('/api/scan/stop', (_q, res) => { token++; state = { ...state, running: false }; res.json({ status: 'ok' }); });
  app.post('/api/scan/start', async (req, res) => {
    // Classic mode sends the chosen time frame and expiry with the scan: every agent switches to that chart and the trade uses that expiry.
    const wantTf = Number(req.body?.tfSec ?? req.body?.tf ?? NaN), wantExp = Number(req.body?.expirySec ?? NaN);
    if ((isSupportedTimeframe(wantTf) && wantTf !== getGlobalTiming().tfSec) || (isSupportedExpiry(wantExp) && wantExp !== getGlobalTiming().expirySec)) {
      try { setGlobalTiming({ ...(isSupportedTimeframe(wantTf) ? { tfSec: wantTf } : {}), ...(isSupportedExpiry(wantExp) ? { expirySec: wantExp } : {}) }); }
      catch (e) { return res.status(400).json({ status: 'error', msg: (e as Error).message }); }
      for (let i = 0; i < 40 && !canExecuteTrade().ok; i++) await new Promise((r) => setTimeout(r, 500));      // wait (up to 20 s) until every agent is on the new chart
    }
    const syncGate = canExecuteTrade();
    if (!syncGate.ok) return res.status(409).json({ status: 'error', msg: syncGate.reason, transitioning: true });
    const broker = String(req.body?.broker ?? '');
    if (!BROKERS.includes(broker)) return res.json({ status: 'error', msg: 'Unknown broker' });
    const rawTf = req.body?.tf !== undefined ? Number(req.body.tf) : getGlobalTiming().tfSec;
    const tfSec = isSupportedTimeframe(rawTf) || rawTf === 30 ? rawTf : getGlobalTiming().tfSec;
    const minPayout = Math.min(100, Math.max(0, Number(req.body?.minPayout) || 0));
    try {
      if (broker === 'deriv' && !derivBridge.tradable) {
        await derivBridge.ensureAuthConnected(6000).catch(() => {});
      }
      const base = `http://127.0.0.1:${port}`;
      const st: any = await (await fetch(`${base}/api/status?broker=${broker}`, { signal: AbortSignal.timeout(15000) })).json();
      if (!st.ready) return res.json({ status: 'error', msg: st.error || 'The broker is not connected yet' });
      if (broker === 'deriv' && req.body?.auto && st.tradable === false) {
        return res.json({ status: 'error', msg: st.error || 'Deriv account not connected. Please enter your Deriv PAT Token on the API screen.' });
      }
      if (broker === 'deriv' && !sweepWatcher.getState().running) sweepWatcher.start(getGlobalTiming().tfSec, 0);   // the agents are the scanner: start them when they are off
      if (broker === 'deriv' && sweepWatcher.getState().running) {
        const my = ++token;
        state = { ...blank(), running: true, broker, tfSec: sweepWatcher.getState().tf };
        void agentLoop(port, my).catch((e) => { if (my === token) state = { ...state, running: false, message: `Scan failed: ${(e as Error).message}` }; });
        return res.json({ status: 'ok' });
      }
      const assets = await (await fetch(`${base}/api/assets?broker=${broker}`, { signal: AbortSignal.timeout(20000) })).json();
      if (!Array.isArray(assets) || !assets.length) return res.json({ status: 'error', msg: 'No markets loaded yet, try again in a moment' });
      const my = ++token;
      state = { ...blank(), running: true, broker, tfSec };
      void loop(port, broker, tfSec, minPayout, assets, my).catch((e) => { if (my === token) state = { ...state, running: false, message: `Scan failed: ${(e as Error).message}` }; });
      res.json({ status: 'ok' });
    } catch (e) { res.json({ status: 'error', msg: `Could not start: ${(e as Error).message}` }); }
  });
}
