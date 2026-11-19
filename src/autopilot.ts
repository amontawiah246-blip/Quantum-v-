// Pro mode "AI Trading": scans markets, picks the strongest setup, places the trade, follows the result,
// and stops itself when a risk limit is hit. Pure logic: everything outside world goes through Deps,
// so it can run in the browser today and move to the server later.
import { Candle, Outcome, Side, analyze, outcomeOf } from "./analysis";
import type { AgentDash } from "./autotradeFeed";
import { TradeRec, autoTfForRound, chooseTiming, isGoldSymbol, mtgBlock, mtgStake } from "./tradeSession";

export interface AutoConfig {
  stake: number;          // amount per trade
  tfSec: number;          // candle timeframe analysed, also the trade expiry
  minConf: number;        // only trade setups at or above this confidence
  maxTrades: number;      // stop after this many trades
  maxLossStreak: number;  // stop after this many losses in a row
  stopLoss: number;       // stop when the session is this far down (in account currency)
  minPayout: number;      // ignore markets paying less than this percent
  scanCount: number;      // markets checked per scan
  mtg?: boolean;          // martingale: after a loss, re-enter the same market and side with a bigger stake
  mtgSteps?: number;      // recovery steps after the first entry (1-3)
  mtgMult?: number;       // stake multiplier per recovery step
  autoTiming?: boolean;   // let the engine pick the candle time frame and the expiry (M5 primary, expiry per executionConfig)
  expirySec?: number;     // your own expiry in seconds; 0 / unset = same as the time frame
}
export const DEFAULT_CFG: AutoConfig = { stake: 10, tfSec: 300, minConf: 60, maxTrades: 10, maxLossStreak: 3, stopLoss: 50, minPayout: 90, scanCount: 60, mtg: false, mtgSteps: 2, mtgMult: 2.2, autoTiming: false, expirySec: 0 };

/** What an analyser says about a market: the side, how sure it is, and why (shown in the log). */
export interface Verdict { side: Side; confidence: number; why?: string; /** opaque reference to the verified signal (the server's pre-trade gate reads it) */ ref?: unknown }
export interface Watch { candles: Candle[]; price(): number | null; /** the broker's clock in seconds, from the latest tick */ clock?(): number | null; close(): void }
/** An analyser answer: a setup, or { none } with the reason there is no setup. null = the market could not be read. */
export type Look = Verdict | { none: string } | null;
export interface MarketRef { symbol: string; label: string; payout?: number | null; active?: boolean }
/** A setup the market agents found, verified by the three engines + AI, and approved. The ONLY way a trade starts in agent mode. */
export interface AgentSetup { id: string; symbol: string; label: string; side: Side; conf: number; why: string; payout?: number | null; closeAtSec: number; detectedAtMs: number }
/** The market agents as AutoTrade sees them. There is no scanning behind this: setups arrive as events. */
export interface AgentSource {
  /** the candle size the agents watch (AutoTrade follows it) */
  tfSec(): number;
  /** AutoTrade switched on / off. Opening twice never duplicates anything. */
  open(): void; close(): void;
  /** approved setups, as they are decided. Returns the unsubscribe. */
  subscribe(handler: (s: AgentSetup) => void): () => void;
  /** null = the setup can still be traded, otherwise why not (expired, invalidated, already executed) */
  check(s: AgentSetup): string | null;
  /** AutoTrade did not trade this approved setup */
  dropped(s: AgentSetup, reason: string): void;
  stats(): AgentDash;
  onChange(fn: () => void): () => void;
}
export interface Deps {
  /** When present, AutoTrade does not scan: it trades what the market agents approve (see AgentSource). */
  agentSource?: AgentSource;
  assets(): MarketRef[];
  watch(symbol: string, tfSec: number): Promise<Watch>;
  place(symbol: string, side: Side, stake: number, seconds: number): Promise<{ ok: boolean; msg: string; id?: string }>;
  /** The broker's own verdict on a placed trade. Resolve null when it cannot be read; the engine then estimates from the price. */
  result?(id: string, seconds: number): Promise<{ outcome: Outcome; profit: number | null } | null>;
  /** Reads a market (all candles, the last may still be forming). Resolve null when there is no setup. Default: the local indicator model. */
  analyze?(symbol: string, candles: Candle[], tfSec: number, nowSec?: number | null): Promise<Look>;
  /** Last check before an order is sent (the independent execution gate). ok:false = the trade is cancelled and the reason is logged. Optional: without it nothing changes. */
  preflight?(c: { symbol: string; side: Side; stake: number; /** the trade expiry */ seconds: number; /** the candle time frame the setup came from */ tf: number; /** true when you chose the expiry yourself (not the engine) */ expiryByUser: boolean; entry: number | null; ref: unknown; candles: Candle[]; clock: number | null; stats: AutoStats; cfg: AutoConfig }): Promise<{ ok: boolean; reason: string }>;
  /** Hard cap on one stake (MAX_STAKE). MTG recovery steps stop rather than go past it. */
  stakeLimit?(): number | null;
  onLoss?(info: { contractId?: string; symbol: string; label: string; side: Side; stake: number; seconds: number; tf: number; profit: number }): void;
  onOutcome?(info: { contractId?: string; outcome: 'win' | 'loss' | 'draw'; symbol: string; label: string; side: Side; stake: number; seconds: number; tf: number; profit: number }): void;
  sleep(ms: number): Promise<void>;
  onPick?(symbol: string): void;
}

export type Phase = "idle" | "scanning" | "listening" | "confirming" | "running" | "cooldown" | "stopped";
export interface ScanRow { symbol: string; label: string; payout?: number | null; state: "wait" | "scan" | "done" | "fail"; side?: Side; conf?: number; why?: string }
export interface TradeInfo { symbol: string; label: string; side: Side; conf: number; stake: number; seconds: number; endsAt: number; step?: number }
export interface AutoStats { trades: number; wins: number; losses: number; draws: number; streak: number; pnl: number; estimated: number; recovered?: number }
export interface LogLine { t: number; text: string; kind: "info" | "win" | "loss" | "warn" }
export interface AutoState { phase: Phase; round: number; scan: ScanRow[]; trade: TradeInfo | null; stats: AutoStats; log: LogLine[]; stopReason: string; focus: string; startedAt: number; trades?: TradeRec[]; tf?: number; timing?: string; /** agent mode: counters and the live activity feed */ agent?: AgentDash }

const RESCAN_MS = 20000, COOLDOWN_MS = 5000, SETTLE_MS = 1500, CONCURRENCY = 6;
const clean = (cs: Candle[]) => cs.slice(0, -1); // the last candle is still forming

/** broker refusals that no retry can fix: the account is not connected / logged in */
export const ACCOUNT_REFUSAL = /account not connected|PAT token|api token|not authori[sz]ed|unauthori[sz]ed|authoriz|invalid token/i;

export class Autopilot {
  state: AutoState = { phase: "idle", round: 0, scan: [], trade: null, stats: { trades: 0, wins: 0, losses: 0, draws: 0, streak: 0, pnl: 0, estimated: 0, recovered: 0 }, log: [], stopReason: "", focus: "", startedAt: Date.now(), trades: [], tf: 0, timing: "" };
  private subs = new Set<() => void>();
  private stopped = false;
  private stopR!: () => void;
  private stopP = new Promise<void>((r) => { this.stopR = r; });
  private recent: string[] = [];
  private tf: number;
  private seq = 0;

  constructor(private deps: Deps, public cfg: AutoConfig) { this.tf = cfg.tfSec; }

  subscribe(fn: () => void) { this.subs.add(fn); return () => this.subs.delete(fn); }
  private set(p: Partial<AutoState>) { this.state = { ...this.state, ...p }; this.subs.forEach((f) => f()); }
  private log(text: string, kind: LogLine["kind"] = "info") { this.set({ log: [{ t: Date.now(), text, kind }, ...this.state.log].slice(0, 40) }); }
  private async wait(ms: number) {
    await Promise.race([this.deps.sleep(ms), this.stopP]);
  }

  get running() { return !this.stopped && this.state.phase !== "idle" && this.state.phase !== "stopped"; }

  stop(reason = "Stopped by you") {
    if (this.state.phase === "stopped") return;
    this.stopped = true;
    this.stopR();
    this.deps.agentSource?.close();           // OFF: no new automated order, immediately. The agents themselves are not touched.
    this.set({ phase: "stopped", trade: null, stopReason: reason });
    this.log(reason, "warn");
  }

  /** Agent mode: no pool, no scan, no rotation. Waits for the market agents' approved setups and trades them one at a time. */
  private async startAgentDriven() {
    const src = this.deps.agentSource!;
    this.tf = src.tfSec();
    this.set({ phase: "listening", tf: this.tf, scan: [] });
    this.log(`AI Trading on: listening to the market agents (${this.tf}s candles, ${this.cfg.expirySec || this.tf}s expiry), min engine agreement ${this.cfg.minConf}, MTG ${this.cfg.mtg ? `on (${this.cfg.mtgSteps ?? 2} steps x${this.cfg.mtgMult ?? 2.2})` : "off"}. The agents find the setups; nothing is scanned here.`);
    src.open();
    const queue: AgentSetup[] = [];
    const activeSymbols = new Set<string>();
    const activeTrades = new Map<string, Promise<void>>();
    const MAX_CONCURRENT = 3;
    let wake: (() => void) | null = null;
    const offs = [src.subscribe((s) => { queue.push(s); wake?.(); }), src.onChange(() => this.pushAgent())];
    this.pushAgent();
    let badPlaces = 0;
    try {
      while (!this.stopped) {
        const lim = this.limit();
        if (lim && activeTrades.size === 0) return this.stop(lim);
        // anything that expired, was invalidated or was already traded while we waited is dropped with its exact reason
        for (let i = queue.length - 1; i >= 0; i--) {
          const why = src.check(queue[i]) ?? (queue[i].conf < this.cfg.minConf ? `agreement ${queue[i].conf} is below your minimum ${this.cfg.minConf}` : null);
          if (why) { src.dropped(queue[i], why); this.log(`${queue[i].label}: not traded, ${why}`, "warn"); queue.splice(i, 1); }
        }
        queue.sort((a, b) => b.conf - a.conf || b.closeAtSec - a.closeAtSec);

        const idx = activeTrades.size < MAX_CONCURRENT && !lim
          ? queue.findIndex((item) => !activeSymbols.has(item.symbol))
          : -1;

        if (idx === -1) {
          if (activeTrades.size === 0) {
            this.set({ phase: "listening", trade: null });
          }
          await Promise.race([
            new Promise<void>((r) => { wake = r; }),
            this.stopP,
            activeTrades.size > 0 ? Promise.race(Array.from(activeTrades.values())) : this.deps.sleep(1000)
          ]);
          wake = null;
          continue;
        }

        const s = queue.splice(idx, 1)[0];
        activeSymbols.add(s.symbol);
        const pick: ScanRow = { symbol: s.symbol, label: s.label, payout: s.payout, state: "done", side: s.side, conf: s.conf, why: s.why };

        const tradePromise = (async () => {
          try {
            const res = await this.execute(pick);
            if (this.stopped) return;
            if (res === "skipped") src.dropped(s, "the setup faded or the final safety check refused it");
            if (res === "error") {
              if (++badPlaces >= 3) this.stop("The broker rejected 3 trades in a row. Check the account and try again.");
            } else if (res === "placed") {
              badPlaces = 0;
            }
          } finally {
            activeSymbols.delete(s.symbol);
            activeTrades.delete(s.symbol);
            if (activeTrades.size === 0 && !this.stopped) {
              this.set({ phase: "cooldown", trade: null });
            }
            if (typeof wake === 'function') (wake as () => void)();
          }
        })();

        activeTrades.set(s.symbol, tradePromise);
        await this.deps.sleep(20);
      }
    } finally {
      offs.forEach((o) => o());
      src.close();
      if (activeTrades.size > 0) {
        await Promise.race([Promise.allSettled(Array.from(activeTrades.values())), this.deps.sleep(5000)]);
      }
    }
  }

  private pushAgent() {
    const src = this.deps.agentSource; if (!src) return;
    const st = this.state.stats;
    this.set({ agent: { ...src.stats(), wins: st.wins, losses: st.losses } });
  }

  async start() {
    if (this.state.phase !== "idle") return;
    if (this.deps.agentSource) return this.startAgentDriven();
    this.set({ phase: "scanning" });
    this.log(`AI Trading on: ${this.cfg.autoTiming ? "automatic time frame and expiry" : `${this.cfg.tfSec}s candles, ${this.cfg.expirySec || this.cfg.tfSec}s expiry`}, min engine agreement ${this.cfg.minConf}, MTG ${this.cfg.mtg ? `on (${this.cfg.mtgSteps ?? 2} steps x${this.cfg.mtgMult ?? 2.2})` : "off"}`);
    let badScans = 0, badPlaces = 0;
    while (!this.stopped) {
      const lim = this.limit();
      if (lim) return this.stop(lim);
      const pool = this.pool();
      this.tf = this.cfg.autoTiming ? autoTfForRound(this.state.round + 1) : this.cfg.tfSec;
      this.set({ tf: this.tf, phase: "scanning", round: this.state.round + 1, trade: null, scan: pool.map((m) => ({ symbol: m.symbol, label: m.label, payout: m.payout, state: "wait" as const })) });
      if (!pool.length) { this.log("No open markets match your payout filter", "warn"); await this.wait(RESCAN_MS); continue; }

      const rows = await this.scan(pool);
      if (this.stopped) return;
      const ok = rows.filter((r) => r.state === "done");
      if (!ok.length) {
        if (++badScans >= 5) return this.stop("Could not read market data 5 times in a row. Check the bridge.");
        this.log("Could not read any market this round, retrying", "warn");
        await this.wait(RESCAN_MS); continue;
      }
      badScans = 0;
      const best = ok.filter((r) => (r.conf ?? 0) >= this.cfg.minConf).sort((a, b) => (b.conf ?? 0) - (a.conf ?? 0))[0];
      if (!best) {
        const top = Math.max(...ok.map((r) => r.conf ?? 0));
        this.log(top <= 0
          ? `Checked ${ok.length} markets, no tradeable setup. ${ok.slice(0, 3).map((r) => `${r.label}: ${r.why ?? "-"}`).join(" | ")}`
          : `Best setup is ${top}%, below your ${this.cfg.minConf}% minimum. Checking again soon`);
        this.set({ phase: "cooldown" });
        await this.wait(RESCAN_MS); continue;
      }

      const res = await this.execute(best);
      if (this.stopped) return;
      if (res === "error") { if (++badPlaces >= 3) return this.stop("The broker rejected 3 trades in a row. Check the account and try again."); }
      else if (res === "placed") badPlaces = 0;
      this.set({ phase: "cooldown", trade: null });
      await this.wait(COOLDOWN_MS);
    }
  }

  private limit(): string {
    const s = this.state.stats, c = this.cfg;
    if (s.trades >= c.maxTrades) return `Reached the limit of ${c.maxTrades} trades`;
    if (s.streak >= c.maxLossStreak) return `${s.streak} losses in a row, stopping to protect your balance`;
    if (s.pnl <= -c.stopLoss) return `Loss limit of ${c.stopLoss} reached`;
    return "";
  }

  private pool(): MarketRef[] {
    const open = this.deps.assets()
      .filter((a) => a.active !== false && (a.payout ?? 0) >= this.cfg.minPayout)   // unknown payout counts as too low
      .sort((a, b) => (b.payout ?? 0) - (a.payout ?? 0));
    const fresh = open.filter((a) => !this.recent.includes(a.symbol));   // rest the two markets traded last, unless nothing else is open
    const el = fresh.length ? fresh : open;
    if (!el.length) return [];
    const n = Math.min(this.cfg.scanCount, el.length), start = (this.state.round * this.cfg.scanCount) % el.length;   // rotate so every market gets looked at
    return Array.from({ length: n }, (_, i) => el[(start + i) % el.length]);
  }

  private async look(symbol: string, candles: Candle[], nowSec?: number | null): Promise<Look> {
    if (this.deps.analyze) return this.deps.analyze(symbol, candles, this.tf, nowSec);
    return analyze(clean(candles));
  }

  private async scan(pool: MarketRef[]): Promise<ScanRow[]> {
    const rows = this.state.scan.map((r) => ({ ...r }));
    const upd = (i: number, p: Partial<ScanRow>) => { Object.assign(rows[i], p); this.set({ scan: rows.map((r) => ({ ...r })) }); };
    let next = 0;
    const worker = async () => {
      while (!this.stopped) {
        const i = next++; if (i >= pool.length) return;
        upd(i, { state: "scan" });
        let w: Watch | null = null;
        try {
          w = await this.deps.watch(pool[i].symbol, this.tf);
          const a = await this.look(pool[i].symbol, w.candles, w.clock?.());
          if (!a) upd(i, { state: "fail" });
          else if ("none" in a) upd(i, { state: "done", conf: 0, why: a.none });
          else upd(i, { state: "done", side: a.side, conf: a.confidence, why: a.why });
        } catch { upd(i, { state: "fail" }); }
        finally { w?.close(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pool.length) }, worker));
    return rows;
  }

  private addRec(t: TradeRec) { this.set({ trades: [t, ...(this.state.trades ?? [])].slice(0, 80) }); }
  private updRec(id: string, p: Partial<TradeRec>) { this.set({ trades: (this.state.trades ?? []).map((t) => (t.id === id ? { ...t, ...p } : t)) }); }

  /** Places one order and follows it to its result. ok=false means the broker refused it (nothing was traded). */
  private async oneTrade(pick: ScanRow, side: Side, stake: number, seconds: number, step: number, w: Watch): Promise<{ ok: boolean; out: Outcome | "unknown" | "stopped" }> {
    const entry = w.price() ?? w.candles[w.candles.length - 1].close;
    const placed = await this.deps.place(pick.symbol, side, stake, seconds);
    if (!placed.ok) {
      this.log(`${step ? `MTG ${step} ` : ""}trade not placed: ${placed.msg}`, "warn");
      // an account / login refusal will repeat on every setup: stop now with the real reason instead of approving more trades that cannot be placed
      if (ACCOUNT_REFUSAL.test(placed.msg ?? "")) this.stop(`AI Trading stopped: ${placed.msg}`);
      return { ok: false, out: "unknown" };
    }
    this.recent = [pick.symbol, ...this.recent].slice(0, 2);
    const id = `${Date.now()}-${++this.seq}`;
    this.addRec({ id, ts: Date.now(), symbol: pick.symbol, label: pick.label, side, stake, seconds, tf: this.tf, step, result: "pending", profit: null, contract: placed.id });
    const info: TradeInfo = { symbol: pick.symbol, label: pick.label, side, conf: pick.conf ?? 0, stake, seconds, endsAt: Date.now() + seconds * 1000, step };
    this.set({ phase: "running", trade: info, stats: { ...this.state.stats, trades: this.state.stats.trades + 1 } });
    this.log(`Placed ${step ? `MTG ${step} ` : ""}${side === "buy" ? "BUY" : "SELL"} ${pick.label} · ${stake} · ${seconds}s`);
    // Ask the broker for its own verdict first; it answers once the trade has settled.
    let official: { outcome: Outcome; profit: number | null } | null = null;
    if (placed.id && this.deps.result) {
      official = await Promise.race([this.deps.result(placed.id, seconds).catch(() => null), this.stopP.then(() => null)]);
    }
    if (this.stopped) return { ok: true, out: "stopped" };
    if (official) { this.settle(id, official.outcome, pick, official.profit, true, stake); return { ok: true, out: official.outcome }; }
    // No official answer: wait out the expiry and compare the live price with the entry price.
    await this.wait(Math.max(0, info.endsAt + SETTLE_MS - Date.now()));
    if (this.stopped) return { ok: true, out: "stopped" };
    const exit = w.price();
    const out: Outcome | "unknown" = exit != null ? outcomeOf(side, entry, exit) : "unknown";
    this.settle(id, out, pick, null, false, stake);
    return { ok: true, out };
  }

  private async execute(pick: ScanRow): Promise<"placed" | "skipped" | "error"> {
    const { stake, minConf } = this.cfg;
    const tf = this.tf;
    this.set({ phase: "confirming" });
    this.set({ focus: pick.symbol });
    this.deps.onPick?.(pick.symbol);
    this.log(`Best setup: ${pick.label} ${pick.side === "buy" ? "BUY" : "SELL"} agreement ${pick.conf}${pick.why ? " · " + pick.why : ""}`);
    let w: Watch | null = null;
    try {
      w = await this.deps.watch(pick.symbol, tf);
      const a0 = await this.look(pick.symbol, w.candles, w.clock?.());      // look again right before the trade
      const a = a0 && "side" in a0 ? a0 : null;
      if (!a || a.side !== pick.side || a.confidence < minConf - 5) {
        this.log(`${pick.label}: the setup faded, skipping`, "warn");
        this.recent = [pick.symbol, ...this.recent].slice(0, 2);
        return "skipped";
      }
      // expiry: automatic (executionConfig policy), your own choice, or chart timeframe
      const byUser = !this.cfg.autoTiming && (this.cfg.expirySec ?? 0) > 0;
      const timing = this.cfg.autoTiming ? chooseTiming(tf, pick.symbol) : { tf, expiry: this.cfg.expirySec || tf, why: "" };
      this.set({ timing: this.cfg.autoTiming ? `${tf >= 60 ? "M" + tf / 60 : "S" + tf} candles · ${timing.expiry}s expiry · ${timing.why}` : "" });
      if (this.cfg.autoTiming) this.log(`Auto timing: ${tf}s candles, ${timing.expiry}s expiry (${timing.why})`);

      // the independent execution gate runs before the FIRST order of a setup
      if (this.deps.preflight) {
        let pf: { ok: boolean; reason: string };
        try { pf = await this.deps.preflight({ symbol: pick.symbol, side: a.side, stake, seconds: timing.expiry, tf, expiryByUser: byUser, entry: w.price(), ref: a.ref, candles: w.candles, clock: w.clock?.() ?? null, stats: this.state.stats, cfg: this.cfg }); }
        catch (e) { pf = { ok: false, reason: `safety gate error: ${(e as Error).message}` }; }
        if (!pf.ok) {
          this.log(`${pick.label}: NO TRADE, ${pf.reason}`, "warn");
          this.recent = [pick.symbol, ...this.recent].slice(0, 2);
          return "skipped";
        }
      }

      const maxStep = this.cfg.mtg ? Math.min(3, Math.max(1, Math.floor(this.cfg.mtgSteps ?? 2))) : 0;
      const mult = this.cfg.mtgMult ?? 2.2;
      let step = 0, placedAny = false;
      for (;;) {
        const amount = mtgStake(stake, step, mult);
        if (step > 0) {
          let why = mtgBlock(amount, { lossSoFar: Math.max(0, -this.state.stats.pnl), stopLoss: this.cfg.stopLoss });
          const cap = this.deps.stakeLimit?.();
          if (!why && cap != null && amount > cap) why = `MTG stopped: next stake ${amount} is over your MAX_STAKE of ${cap}`;
          if (why) { this.log(why, "warn"); break; }
        }
        const r = await this.oneTrade(pick, a.side, amount, timing.expiry, step, w);
        if (!r.ok) return placedAny ? "placed" : "error";
        placedAny = true;
        if (r.out === "stopped") return "placed";
        if (r.out === "loss" && step < maxStep) {
          step++;
          this.log(`MTG: recovering with step ${step} of ${maxStep} (stake ${mtgStake(stake, step, mult)})`, "info");
          continue;
        }
        break;
      }
      return placedAny ? "placed" : "skipped";
    } catch (e) {
      this.log(`Trade step failed: ${(e as Error).message || "error"}`, "warn");
      return "error";
    } finally { w?.close(); }
  }

  private settle(id: string, out: Outcome | "unknown", pick: ScanRow, profit: number | null, official: boolean, stake: number) {
    const s = { ...this.state.stats };
    const pay = (pick.payout && pick.payout > 0 ? pick.payout : 80) / 100;
    const tag = official ? "" : " (estimated)";
    const rec = (this.state.trades ?? []).find((t) => t.id === id);
    if (!official) s.estimated++;
    if (out === "win") {
      const g = profit != null && profit > 0 ? profit : stake * pay;
      s.wins++; s.streak = 0; s.pnl += g; if (rec && rec.step > 0) s.recovered = (s.recovered ?? 0) + 1;
      this.log(`WIN ${pick.label} +${g.toFixed(2)}${tag}`, "win");
      const winProfit = Math.round(g * 100) / 100;
      this.updRec(id, { result: "win", profit: winProfit });
      try {
        this.deps.onOutcome?.({
          contractId: rec?.contract,
          outcome: "win",
          symbol: pick.symbol,
          label: pick.label,
          side: rec?.side ?? "buy",
          stake,
          seconds: rec?.seconds ?? this.tf,
          tf: this.tf,
          profit: winProfit,
        });
      } catch { /* reporting must never break settle */ }
    } else if (out === "loss") {
      const l = profit != null && profit < 0 ? -profit : stake;
      s.losses++; s.streak++; s.pnl -= l; this.log(`LOSS ${pick.label} -${l.toFixed(2)}${tag}`, "loss");
      const lossProfit = -Math.round(l * 100) / 100;
      this.updRec(id, { result: "loss", profit: lossProfit });
      try {
        this.deps.onOutcome?.({
          contractId: rec?.contract,
          outcome: "loss",
          symbol: pick.symbol,
          label: pick.label,
          side: rec?.side ?? "buy",
          stake,
          seconds: rec?.seconds ?? this.tf,
          tf: this.tf,
          profit: lossProfit,
        });
        this.deps.onLoss?.({
          contractId: rec?.contract,
          symbol: pick.symbol,
          label: pick.label,
          side: rec?.side ?? "buy",
          stake,
          seconds: rec?.seconds ?? this.tf,
          tf: this.tf,
          profit: lossProfit,
        });
      } catch { /* reporting must never break settle */ }
    } else if (out === "draw") { s.draws++; this.log(`DRAW ${pick.label}, stake returned${tag}`); this.updRec(id, { result: "draw", profit: 0 }); }
    else { this.log(`Could not read the result of ${pick.label}`, "warn"); this.updRec(id, { result: "error", note: "result unreadable" }); }
    s.pnl = Math.round(s.pnl * 100) / 100;
    this.set({ stats: s, trade: null });
    this.pushAgent();
  }
}
