// Watches every agent's market (the logic; sweepWatcher.ts plugs in the live Deriv data). When a candle CLOSES, the three engines (src/sweepEngines.ts) look at it; every real setup gets a
// screenshot (src/sweepChart.ts) that the Menu and the agent cards show. Nothing else is ever posted: no filler "snapshot" charts.
import { C, EngineName, StochRsiMeta, Verdict, VerdictStructureMeta, detectAll, detectStochRsi, isFlat } from './sweepEngines';
import { renderIndicatorSvg } from './indicatorChart';
import { STOCH_RSI_WINDOW } from './stochRsi';
import { findLsccSweep, lsccOutcome } from './lscc';
import { renderAlertSvg } from './sweepChart';
import { renderPlainSvg } from './screenshot';
import type { CandidateHub } from './candidateHub';
import { screenshotOf, candidateIdFor } from './candidateTypes';
import { ENGINE_WINDOW } from './candidateEngines';
import { Semaphore, withTimeout } from './concurrency';
import { StructureSweepSnapshot, analyzeStructureSweep } from './structureSweep';
import { areMarketTimestampsSynchronized, filterClosedCandles, getGlobalTiming, isConfigTransitioning, isSupportedTimeframe, markAgentSynced } from './globalConfig';

export interface SweepAlertData {
  id: number;
  symbol: string;
  name: string;
  market: string;
  tf: number;
  candle_time: number;          // open time of the last closed candle of the pattern
  engine: EngineName;           // sweep | continuation | momentum
  side: 'BUY' | 'SELL';
  ok: boolean;                  // TAKE (true) or SKIP (false)
  block: string | null;
  notes: string[];
  entry: number;
  swept_level: number;
  trade_at_next_open: boolean;  // continuation + momentum: the trade opens on the next candle
  conflict: boolean;            // another engine fired the opposite side on the same candle (both alerts are flagged)
  trace: string[];              // continuation + momentum: the exact arithmetic of every check that qualified the setup
  created: number;
  live: boolean;                // false = found while loading recent history
  svg: string;
  /** set when the setup was broadcast to the verification recipients (src/candidateHub.ts); the id of that candidate */
  candidate_id?: string;
  /** LSCC only: where this liquidity-sweep setup stands, and the exact candles it is made of (sweep and confirmation times are kept from detection) */
  lscc?: LsccAlertInfo;
  /** Structure-confirmed sweep metadata */
  structureMeta?: VerdictStructureMeta;
  /** Stochastic + RSI strategy: the two crossings and the candle pattern(s) that confirmed them */
  stochRsi?: StochRsiMeta;
  /** the alert that this one replaced (an LSCC alert is updated in place when its confirmation arrives or fails: same candidate, new id, new screenshot) */
  replaces?: number;
}
export interface LsccAlertInfo {
  state: 'WAITING' | 'CONFIRMED' | 'INVALID';
  level: number; levelTime: number; sweepTime: number;
  confirmTime: number | null; entryTime: number | null;
  /** when the sweep was first seen (ms epoch): the waiting alert's screenshot is from that moment */
  sweepDetectedAtMs: number | null;
  reason?: string;
}
interface LsccTrack { symbol: string; tf: number; sweepTime: number; side: 'BUY' | 'SELL'; alert: SweepAlertData; state: 'WAITING' | 'CONFIRMED' | 'INVALID'; sweepAtMs: number; sha: string | null }

export interface SweepAgent { symbol: string; name: string; market: string; tf?: number }



const PATTERN_LEN: Record<EngineName, number> = { sweep: 2, momentum: 3, continuation: 4, lscc: 2, structure_sweep: 2, stoch_rsi: 3 };
import { candlePatternsTradeAlone } from './strategyMode';
export { candlePatternsTradeAlone };
const FETCH = 250;           // candles read per market and check (the hybrid / indicator evidence needs more than the engines' 45)
const WINDOW = ENGINE_WINDOW; // candles an engine gets to look at
const KEEP = 600;            // alerts kept in memory
const DELAY_SEC = 2.5;       // wait after a candle boundary so the broker has published the closed candle
const CONCURRENCY = 6;        // markets checked at once by a backfill pass
const FETCH_SLOTS = 8;        // broker requests in flight at once, shared by all agents (controlled concurrency, never a barrier)
const FETCH_TIMEOUT_MS = 20000;
const REFRESH_MS = 5000;      // while a candidate of this market is being verified, its chart is re-read this often

export interface WatcherDeps {
  fetchCandles: (symbol: string, tf: number, count: number) => Promise<C[]>;
  now: () => Promise<number>;          // BROKER clock in seconds: candle times follow it, so closed/forming is decided with it
  sleep: (ms: number) => Promise<void>;
}

export class SweepWatcherService {
  private alerts: SweepAlertData[] = [];
  private seenKeys = new Set<string>();
  private nextId = 1;
  private token = 0;                    // changes on every start/stop so an old loop ends itself
  private running = false;
  private tf = 60;
  private syncVersion = 1;
  private lastRun = 0;
  private status = new Map<string, { lastCandle: number; error: string; syncedTf: number; syncedVersion: number }>();
  private structureStates = new Map<string, { market: string; name: string; tf: number; snapshot: StructureSweepSnapshot }>();

  private fetchSlots = new Semaphore(FETCH_SLOTS);
  private lscc = new Map<string, LsccTrack>();

  constructor(private opts: {
    agents: SweepAgent[]; deps: WatcherDeps; autostart?: boolean | number;
    /** where live setups are broadcast (omitted = the watcher only posts its own alerts, as before) */
    hub?: CandidateHub;
    /** SVG -> PNG for the screenshot every recipient shares; omitted or null = the AI reports the screenshot as NOT_SENT */
    rasterize?: (svg: string) => Promise<Uint8Array | null>;
    tf?: number; refreshMs?: number; perf?: () => number; wallMs?: () => number;
  }) {
    const initTf = opts.tf && (isSupportedTimeframe(opts.tf) || opts.tf === 30) ? opts.tf : 60;
    this.tf = initTf;
    this.agents.forEach((a) => this.status.set(a.symbol, { lastCandle: 0, error: '', syncedTf: initTf, syncedVersion: 0 }));
    if (opts.autostart) this.start(typeof opts.autostart === 'number' ? opts.autostart : initTf, 60);
  }

  private get hub() { return this.opts.hub; }
  private perf = () => (this.opts.perf ?? (() => performance.now()))();
  private wall = () => (this.opts.wallMs ?? Date.now)();

  private get agents(): SweepAgent[] { return this.opts.agents; }
  private get deps(): WatcherDeps { return this.opts.deps; }

  /** backfill = also look through that many recent closed candles (shown as "earlier", never as live). */
  public start(tf = 60, backfill = 0, syncVersion?: number) {
    this.stop();
    this.tf = isSupportedTimeframe(tf) || tf === 30 ? tf : 60;
    if (typeof syncVersion === 'number') this.syncVersion = syncVersion;
    this.status.forEach((s) => { s.syncedTf = 0; s.lastCandle = 0; s.error = ''; });
    this.structureStates.clear();
    this.running = true;
    const token = ++this.token;
    console.log(`[SweepWatcher] watching ${this.agents.length} markets on uniform ${this.tf}s candles (sync v${this.syncVersion})`);
    // ONE INDEPENDENT LOOP PER MARKET. All agents strictly use the global `this.tf` (no per-agent silent overrides).
    const back = Math.max(0, Math.min(Math.floor(backfill), 300));
    for (const a of this.agents) this.agentLoop(a, token, back, this.syncVersion).catch((e) => console.warn(`[SweepWatcher] ${a.symbol} loop stopped:`, e));
  }

  public syncTimeframe(tf: number, syncVersion: number, backfill = 60) {
    this.start(tf, backfill, syncVersion);
  }

  public stop() {
    this.token++;
    this.running = false;
  }

  public clear() {
    this.alerts = [];                   // seenKeys stays on purpose: cleared setups do not come back
  }

  private async agentLoop(a: SweepAgent, token: number, backfill: number, loopSyncVersion: number) {
    const tf = this.tf;                 // Strict single central timeframe — no per-agent silent override
    let done = 0;                       // open time of the newest closed candle this agent has already examined
    const st = this.status.get(a.symbol)!;
    while (token === this.token) {
      let wakeMs = 2000;
      try {
        const now = await this.deps.now();
        const closedOpen = Math.floor((now - DELAY_SEC) / tf) * tf - tf;       // the candle that should have just closed and been published
        if (closedOpen > done) {
          const first = done === 0;
          done = closedOpen;
          await this.checkAgent(a, tf, first ? backfill : 0, loopSyncVersion);
        } else if (this.hub?.hasActive(a.symbol, now)) {
          await this.refreshCandidates(a, tf);
        }
        const now2 = await this.deps.now();
        const toNext = (Math.floor((now2 - DELAY_SEC) / tf) + 1) * tf + DELAY_SEC - now2;
        const live = !!this.hub?.hasActive(a.symbol, now2);
        wakeMs = Math.max(500, Math.min(toNext * 1000, live ? (this.opts.refreshMs ?? REFRESH_MS) : Infinity));
      } catch (e) {
        st.error = (e instanceof Error ? e.message : String(e)).slice(0, 120) || 'error';
      }
      if (token !== this.token) return;
      await this.deps.sleep(wakeMs);
    }
  }

  public getAlerts(since = 0, limit = 60) {
    const list = this.alerts.filter((a) => a.id > since);
    list.sort((a, b) => b.candle_time - a.candle_time || b.id - a.id);
    return list.slice(0, Math.max(1, Math.min(600, limit))).map(({ svg: _svg, ...rest }) => rest);
  }

  public getAlertSvg(id: number): string | null {
    return this.alerts.find((a) => a.id === id)?.svg ?? null;
  }

  public getStructureStates() {
    const timing = getGlobalTiming();
    const list = this.agents.map((a) => {
      const entry = this.structureStates.get(a.symbol);
      const st = this.status.get(a.symbol);
      const snap = entry?.snapshot ?? null;
      return {
        symbol: a.symbol,
        name: a.name,
        market: a.market,
        tf: this.tf,
        lastCandle: st?.lastCandle ?? 0,
        error: st?.error ?? '',
        syncedTf: st?.syncedTf ?? 0,
        syncedVersion: st?.syncedVersion ?? 0,
        classificationState: snap?.state ?? 'WAITING_FOR_STRUCTURE',
        directionalBias: snap?.directionalBias ?? 'NONE',
        priorMarketStructure: snap?.priorMarketStructure ?? 'NONE',
        activeBias: snap?.activeBias ?? null,
        latestSwingEvent: snap?.latestSwingEvent ?? null,
        lastInvalidation: snap?.lastInvalidation ?? null,
        rejectionReason: snap?.rejectionReason ?? null,
      };
    });
    const timestampSync = areMarketTimestampsSynchronized(
      list.map((m) => ({ symbol: m.symbol, lastCandle: m.lastCandle })),
      this.tf
    );
    return {
      tf: this.tf,
      expirySec: timing.expirySec,
      transitioning: timing.transitioning,
      syncVersion: this.syncVersion,
      timestampSync,
      markets: list,
    };
  }

  public getState() {
    const failed = this.agents.filter((a) => this.status.get(a.symbol)?.error).map((a) => a.symbol);
    const timing = getGlobalTiming();
    const timestampSync = areMarketTimestampsSynchronized(
      this.agents.map((a) => ({ symbol: a.symbol, lastCandle: this.status.get(a.symbol)?.lastCandle ?? 0 })),
      this.tf
    );
    return {
      running: this.running,
      tf: this.tf,
      expirySec: timing.expirySec,
      transitioning: timing.transitioning,
      syncVersion: this.syncVersion,
      timestampSync,
      agents: this.agents.length,
      last_run: this.lastRun,
      last_id: this.alerts.length ? Math.max(...this.alerts.map((a) => a.id)) : 0,
      total: this.alerts.length,
      now: Math.floor(Date.now() / 1000),
      failed,
      markets: this.agents.map((a) => ({
        symbol: a.symbol,
        name: a.name,
        tf: this.tf,
        syncedTf: this.status.get(a.symbol)?.syncedTf ?? this.tf,
        last_candle: this.status.get(a.symbol)?.lastCandle ?? 0,
        error: this.status.get(a.symbol)?.error ?? '',
      })),
    };
  }

  /** One check of all markets. Public so the tests can drive it. */
  public async runPass(backfill: number, syncVersion = this.syncVersion) {
    this.lastRun = Math.floor(await this.deps.now());
    const uniformTf = this.tf;
    const queue = [...this.agents];
    const worker = async () => {
      for (let a = queue.shift(); a; a = queue.shift()) {
        try { await this.checkAgent(a, uniformTf, backfill, syncVersion); }
        catch (e) { const s = this.status.get(a.symbol)!; s.error = (e instanceof Error ? e.message : String(e)).slice(0, 120) || 'error'; }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  private async checkAgent(a: SweepAgent, tf: number, backfill: number, syncVersion = this.syncVersion) {
    let closed: C[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {         // the broker can publish the closed candle a moment late
      const now = await this.deps.now();
      const want = Math.floor(now / tf) * tf - tf;           // open time of the candle that should have just closed
      const raw = await this.fetch(a.symbol, tf, FETCH + backfill);
      closed = filterClosedCandles(raw.slice().sort((x, y) => x.time - y.time), tf, now);   // completed closed candles only
      if (closed.length && closed[closed.length - 1].time >= want) break;
      if (attempt < 3) await this.deps.sleep(2000);
    }
    if (closed.length < 15) throw new Error(closed.length ? 'not enough candles' : 'no candles');
    const st = this.status.get(a.symbol)!;
    st.lastCandle = closed[closed.length - 1].time;
    st.error = '';
    st.syncedTf = tf;
    st.syncedVersion = syncVersion;
    if (syncVersion > 0 && isConfigTransitioning()) {
      markAgentSynced(a.symbol, syncVersion);
    }
    const detectedAt = await this.deps.now();

    const structSnap = analyzeStructureSweep(closed, closed.length - 1);
    if (structSnap) {
      this.structureStates.set(a.symbol, { market: a.market, name: a.name, tf, snapshot: structSnap });
    }

    const start = backfill > 0 ? Math.max(12, closed.length - backfill) : closed.length - 1;
    for (let i = start; i < closed.length; i++) {
      const win = closed.slice(Math.max(0, i - WINDOW + 1), i + 1);
      if (win.slice(-8).some(isFlat)) continue;               // broker filler candles are not price action
      const found = detectAll(win, win.length - 1);
      const conflict = new Set(found.filter((v) => v.ok).map((v) => v.side)).size > 1;   // BUY and SELL from different engines on one candle
      for (const v of found) {
        const made = this.emit(a, tf, win, v, backfill === 0, conflict);
        // a LIVE, qualifying setup is broadcast only when not in a mid-transition config change; backfill never broadcasts.
        // In the default mode a candle pattern alone is not traded: it is the confirmation the indicator trigger looks back for.
        if (made && this.hub && backfill === 0 && v.ok && !isConfigTransitioning() && candlePatternsTradeAlone()) {
          await this.publishCandidate(a, tf, closed, v, made.alert, made.renderMs, detectedAt);
        }
      }
      // THE INDICATOR STRATEGY: every agent reads the same Stochastic + RSI on its own market. When they confirm a new direction on this candle,
      // the engine looks back for a candle pattern; with one the setup is broadcast (screenshot with the indicators drawn) to the engines + Gemini.
      const lw = closed.slice(Math.max(0, i - STOCH_RSI_WINDOW + 1), i + 1);
      if (!lw.slice(-8).some(isFlat)) {
        const sr = detectStochRsi(lw, lw.length - 1);
        if (sr && sr.ok) {          // a trigger with no candle pattern behind it is not a setup: no alert, no screenshot, nothing broadcast
          const made = this.emit(a, tf, lw, sr, backfill === 0, conflict);
          if (made && this.hub && backfill === 0 && sr.ok && !isConfigTransitioning() && !candlePatternsTradeAlone()) {   // legacy mode = the old candle-pattern-only behaviour
            await this.publishCandidate(a, tf, closed, sr, made.alert, made.renderMs, detectedAt);
          }
        }
      }
    }
    // the chart of this market may have changed since an earlier candidate was published: tell the recipients (new version, original kept)
    if (this.hub && backfill === 0) await this.applyUpdates(a, tf, closed, detectedAt, 'new candle data on the next check');
    if (backfill === 0) await this.trackLscc(a, tf, closed);
  }

  /** Broker request with controlled concurrency and a timeout, so a hung market can never hold a request slot forever. */
  private fetch(symbol: string, tf: number, count: number): Promise<C[]> {
    return this.fetchSlots.run(() => withTimeout(this.deps.fetchCandles(symbol, tf, count), FETCH_TIMEOUT_MS, `candles of ${symbol}`));
  }

  /** Reads the chart again while a candidate of this market is being verified, and publishes an update when anything changed. */
  public async refreshCandidates(a: SweepAgent, tf = this.tf) {
    const now = await this.deps.now();
    if (!this.hub || !this.hub.hasActive(a.symbol, now)) return;
    const raw = await this.fetch(a.symbol, tf, FETCH);
    const closed = raw.filter((c) => c.time + tf <= now).sort((x, y) => x.time - y.time);
    await this.applyUpdates(a, tf, closed, now, 'live chart refresh during verification');
  }

  private async applyUpdates(a: SweepAgent, tf: number, closed: C[], nowSec: number, reason: string) {
    if (!this.hub || !closed.length) return;
    const rows = closed.slice(-FETCH);
    for (const rec of this.hub.activeFor(a.symbol, nowSec)) {
      if (rec.tf !== tf || !this.hub.changed(rec.id, rows)) continue;
      const t0 = this.perf();
      const o1 = rec.versions[0];
      const svg = o1.engine === 'stoch_rsi'
        ? renderIndicatorSvg(rows.slice(-STOCH_RSI_WINDOW), { side: rec.direction, ok: true, tf, market: a.market, symbol: a.symbol, meta: o1.stochRsi ?? null, notes: o1.notes, signalTime: o1.signalCandleOpen })
        : renderPlainSvg(rows.slice(-16), rec.direction, a.market, tf);       // the chart as it looks NOW (no pattern annotation: the pattern is the original's)
      const png = await this.raster(svg);
      const shot = screenshotOf(svg, png, this.wall(), this.perf() - t0);
      this.hub.update(rec.id, { ohlc: rows, screenshot: shot, reason, detectedAtMs: this.wall() });
    }
  }

  private async raster(svg: string): Promise<Uint8Array | null> {
    try { return this.opts.rasterize ? await this.opts.rasterize(svg) : null; } catch { return null; }
  }

  /** Packages the agent's own screenshot with its OHLC rows and hands it to the hub, which broadcasts it to every recipient at once. */
  private async publishCandidate(a: SweepAgent, tf: number, closed: C[], v: Verdict, alert: SweepAlertData, renderMs: number, detectedAtSec: number) {
    const t0 = this.perf();
    const png = await this.raster(alert.svg);                                       // the SAME svg that the Menu shows: no second screenshot pipeline
    const shot = screenshotOf(alert.svg, png, this.wall(), renderMs + (this.perf() - t0));
    const out = this.hub!.publish({
      agentId: a.name, symbol: a.symbol, market: a.market, engine: v.engine, direction: v.side, tf, signalCandleOpen: alert.candle_time,
      patternFrom: closed[closed.length - 1 - (v.signalIndex - v.from)]?.time ?? alert.candle_time, tradeAtNextOpen: v.tradeAtNextOpen,
      entry: v.entry, sweptLevel: v.sweptLevel, notes: v.notes, trace: v.trace ?? [],
      lscc: v.lscc ? { ...v.lscc, sweepDetectedAtMs: this.lscc.get(`${a.symbol}|${tf}|${v.lscc.sweepTime}`)?.sweepAtMs ?? null, sweepScreenshotSha256: this.lscc.get(`${a.symbol}|${tf}|${v.lscc.sweepTime}`)?.sha ?? null } : undefined,
      structureSweep: v.structureMeta ? {
        biasDirection: v.structureMeta.biasDirection,
        eventType: v.structureMeta.eventType,
        breakLevel: v.structureMeta.breakLevel,
        eventTime: v.structureMeta.eventTime,
        bosCount: v.structureMeta.bosCount,
        pullbackTime: v.structureMeta.pullbackTime,
        sweepTime: v.structureMeta.sweepTime,
      } : undefined,
      stochRsi: v.stochRsi,
      ohlc: closed.slice(-FETCH), engineWindow: v.engine === 'stoch_rsi' ? STOCH_RSI_WINDOW : WINDOW, screenshot: shot,
      detectedAtMs: this.wall(), detectionLatencySec: detectedAtSec - (alert.candle_time + tf),
    });
    if (out.status === 'PUBLISHED') alert.candidate_id = out.candidate.candidateId;
    else if (out.status === 'DUPLICATE' || out.status === 'MERGED') alert.candidate_id = out.candidateId;
    else console.warn(`[SweepWatcher] ${a.symbol}: candidate refused: ${out.reason}`);
  }

  private lsccBase(a: SweepAgent, tf: number, sweepTime: number, side: 'BUY' | 'SELL', level: number, levelTime: number, svg: string, state: LsccAlertInfo['state'], reason: string, candleTime: number, sweepAtMs: number): SweepAlertData {
    return {
      id: this.nextId++, symbol: a.symbol, name: a.name, market: a.market, tf, candle_time: candleTime, engine: 'lscc', side, ok: false, block: reason,
      notes: [], entry: 0, swept_level: level, trade_at_next_open: true, conflict: false, trace: [], created: Math.floor(Date.now() / 1000), live: true, svg,
      lscc: { state, level, levelTime, sweepTime, confirmTime: null, entryTime: null, sweepDetectedAtMs: sweepAtMs, reason },
    };
  }

  private lsccInvalid(rec: LsccTrack, win: C[], reason: string) {
    rec.state = 'INVALID';
    const idx = win.findIndex((c) => c.time === rec.sweepTime);
    const sub = idx >= 0 ? win.slice(0, Math.min(idx + 2, win.length)) : win;
    const al = rec.alert;
    const svg = renderAlertSvg(sub, { engine: 'lscc', side: rec.side, ok: false, swept_level: al.swept_level, tf: rec.tf, market: al.market, symbol: al.symbol, block: reason, patternLen: 2, lsccState: 'INVALID' });
    const old = al.id;
    Object.assign(al, { id: this.nextId++, replaces: old, svg, ok: false, block: reason, lscc: { ...al.lscc!, state: 'INVALID', reason } });
    this.hub?.emit({ type: 'lscc', key: `${rec.symbol}|${rec.tf}|${rec.sweepTime}`, symbol: rec.symbol, market: al.market, side: rec.side, state: 'INVALID', level: al.swept_level, sweepTime: rec.sweepTime, confirmTime: null, reason });
  }

  /**
   * LSCC lifecycle on top of the per-candle detection. The agent that sees a SWEEP registers it (WAITING) with its own screenshot and goes on
   * watching: the very next candle either confirms it (detectAll then publishes the candidate, see emit) or the setup is INVALID.
   * A sweep alone is never published for verification and never traded.
   */
  private async trackLscc(a: SweepAgent, tf: number, closed: C[]) {
    const win = closed.slice(-WINDOW);
    if (win.length < 15 || win.slice(-8).some(isFlat)) return;
    const last = win.length - 1;
    for (const rec of this.lscc.values()) {
      if (rec.symbol !== a.symbol || rec.tf !== tf || rec.state !== 'WAITING') continue;
      if (rec.sweepTime === win[last - 1].time) { const out = lsccOutcome(win, last); if (out && out.state === 'INVALID') this.lsccInvalid(rec, win, out.reason); }
      else if (rec.sweepTime < win[last - 1].time) this.lsccInvalid(rec, win, 'confirmation window passed: the candle after the sweep was not checked in time');
    }
    const sw = findLsccSweep(win, last);
    if (!sw) return;
    const key = `${a.symbol}|${tf}|${sw.sweepTime}`;
    if (this.lscc.has(key)) return;
    const t0 = this.perf();
    const svg = renderAlertSvg(win, { engine: 'lscc', side: sw.side, ok: false, swept_level: sw.level, tf, market: a.market, symbol: a.symbol, block: 'sweep detected, waiting for the confirmation candle', notes: sw.reasons, patternLen: 2, lsccState: 'WAITING' });
    const png = await this.raster(svg);
    const shot = screenshotOf(svg, png, this.wall(), this.perf() - t0);
    const alert = this.lsccBase(a, tf, sw.sweepTime, sw.side, sw.level, sw.levelTime, svg, 'WAITING', 'sweep detected, waiting for the confirmation candle', win[last].time, this.wall());
    alert.notes = sw.reasons;
    this.lscc.set(key, { symbol: a.symbol, tf, sweepTime: sw.sweepTime, side: sw.side, alert, state: 'WAITING', sweepAtMs: this.wall(), sha: shot.pngSha256 ?? shot.svgSha256 });
    if (this.lscc.size > 600) this.lscc.delete(this.lscc.keys().next().value as string);
    this.alerts.push(alert);
    if (this.alerts.length > KEEP) this.alerts.shift();
    this.hub?.emit({ type: 'lscc', key, symbol: a.symbol, market: a.market, side: sw.side, state: 'WAITING', level: sw.level, sweepTime: sw.sweepTime, confirmTime: null, reason: 'sweep detected, confirmation pending' });
  }

  /** The LSCC setups the agents are tracking right now (waiting, confirmed or invalid), newest first. */
  public getLscc(limit = 50) {
    return [...this.lscc.values()].reverse().slice(0, limit).map((r) => ({ key: `${r.symbol}|${r.tf}|${r.sweepTime}`, symbol: r.symbol, tf: r.tf, side: r.side, state: r.state, alertId: r.alert.id, sweepTime: r.sweepTime, level: r.alert.swept_level, market: r.alert.market, candidateId: r.alert.candidate_id ?? null }));
  }

  private emit(a: SweepAgent, tf: number, win: C[], v: Verdict, live: boolean, conflict = false): { alert: SweepAlertData; renderMs: number } | null {
    const sig = win[win.length - 1];
    const key = `${a.symbol}|${tf}|${v.engine}|${sig.time}`;
    if (this.seenKeys.has(key)) return null;
    this.seenKeys.add(key);
    if (this.seenKeys.size > 20000) this.seenKeys.delete(this.seenKeys.values().next().value as string);
    const r0 = this.perf();
    const svg = v.engine === 'stoch_rsi'
      ? renderIndicatorSvg(win, { side: v.side, ok: v.ok, tf, market: a.market, symbol: a.symbol, meta: v.stochRsi ?? null, block: v.block, notes: v.notes, signalTime: sig.time })
      : renderAlertSvg(win, {
      engine: v.engine, side: v.side, ok: v.ok, swept_level: v.sweptLevel, tf, market: a.market, symbol: a.symbol,
      block: v.block, notes: v.notes, patternLen: PATTERN_LEN[v.engine], lsccState: v.engine === 'lscc' ? 'CONFIRMED' : undefined,
      structureMeta: v.structureMeta,
    });
    const renderMs = this.perf() - r0;
    const track = v.engine === 'lscc' && v.lscc ? this.lscc.get(`${a.symbol}|${tf}|${v.lscc.sweepTime}`) : undefined;
    const lscc: LsccAlertInfo | undefined = v.lscc ? { state: 'CONFIRMED', ...v.lscc, sweepDetectedAtMs: track?.sweepAtMs ?? null } : undefined;
    const alert: SweepAlertData = {
      id: this.nextId++, symbol: a.symbol, name: a.name, market: a.market, tf, candle_time: sig.time, engine: v.engine, side: v.side,
      ok: v.ok, block: v.block, notes: v.notes, entry: v.entry, swept_level: v.sweptLevel, trade_at_next_open: v.tradeAtNextOpen,
      conflict, trace: v.trace ?? [],
      created: Math.floor(Date.now() / 1000), live, svg, lscc, structureMeta: v.structureMeta, stochRsi: v.stochRsi,
    };
    if (track) {          // the waiting alert becomes the confirmed one: same candidate, new screenshot, the sweep time is kept
      track.state = 'CONFIRMED';
      const old = track.alert.id;
      Object.assign(track.alert, { ...alert, id: alert.id, replaces: old });
      this.hub?.emit({ type: 'lscc', key: `${a.symbol}|${tf}|${v.lscc!.sweepTime}`, symbol: a.symbol, market: a.market, side: v.side, state: 'CONFIRMED', level: v.lscc!.level, sweepTime: v.lscc!.sweepTime, confirmTime: v.lscc!.confirmTime, reason: 'confirmed by the next candle', candidateId: candidateIdFor(a.symbol, tf, sig.time, v.side) });
      if (!this.alerts.includes(track.alert)) this.alerts.push(track.alert);
      return { alert: track.alert, renderMs };
    }
    this.alerts.push(alert);
    if (this.alerts.length > KEEP) this.alerts.shift();
    return { alert, renderMs };
  }
}

