// Classic mode trading: takes one verified signal, places the trade, follows it to the broker's result and,
// when MTG is on, re-enters the same market and side with a bigger stake after a loss. Every order is
// reported as a record so the screen can show pending / win / loss live. No React in here.
import { MtgConfig, Side, TradeRec, estimateProfit, mtgBlock, mtgStake } from "./tradeSession";

export interface ChainDeps {
  place(side: Side, stake: number, seconds: number): Promise<{ ok: boolean; msg: string; id?: string }>;
  /** The broker's verdict once the trade has run. null = could not be read. */
  result(id: string, seconds: number): Promise<{ outcome: "win" | "loss" | "draw"; profit: number | null } | null>;
  /** Called every time a record is created or changes (upsert by id). */
  onRec(rec: TradeRec): void;
  balance(): number | null;
  cancelled(): boolean;
  now?(): number;
}
export interface ChainInput {
  symbol: string; label: string; side: Side; stake: number; seconds: number; tf: number; mtg: MtgConfig; payout?: number | null;
  stopLoss?: number;       // optional cap on how much a chain may lose
}
export interface ChainOutcome { final: "win" | "loss" | "draw" | "error" | "cancelled"; steps: number; pnl: number; message: string }

/** Runs one entry plus its MTG recovery steps. Resolves when the chain has ended. */
export async function runChain(d: ChainDeps, p: ChainInput): Promise<ChainOutcome> {
  const maxStep = p.mtg.on ? Math.min(3, Math.max(0, Math.floor(p.mtg.steps))) : 0;
  const now = d.now ?? Date.now;
  let step = 0, pnl = 0, lastMsg = "";
  for (;;) {
    const stake = mtgStake(p.stake, step, p.mtg.mult);
    if (step > 0) {
      const why = mtgBlock(stake, { balance: d.balance(), lossSoFar: -pnl, stopLoss: p.stopLoss });
      if (why) return { final: "loss", steps: step, pnl, message: why };
    }
    if (d.cancelled()) return { final: "cancelled", steps: step, pnl, message: "Stopped" };
    const rec: TradeRec = { id: `${now()}-${step}-${Math.random().toString(36).slice(2, 6)}`, ts: now(), symbol: p.symbol, label: p.label, side: p.side, stake, seconds: p.seconds, tf: p.tf, step, result: "pending", profit: null };
    const placed = await d.place(p.side, stake, p.seconds).catch((e) => ({ ok: false, msg: (e as Error).message || "network error", id: undefined }));
    if (!placed.ok) {
      d.onRec({ ...rec, result: "error", note: placed.msg || "order rejected" });
      return { final: "error", steps: step, pnl, message: placed.msg || "The broker rejected the order" };
    }
    rec.contract = placed.id;
    d.onRec(rec);
    const res = placed.id ? await d.result(placed.id, p.seconds).catch(() => null) : null;
    if (d.cancelled()) { return { final: "cancelled", steps: step, pnl, message: "Stopped" }; }
    if (!res) {
      d.onRec({ ...rec, result: "error", note: "result could not be read from the broker" });
      return { final: "error", steps: step, pnl, message: "Could not read the result from the broker. Check your Deriv account history." };
    }
    const profit = res.profit ?? estimateProfit(res.outcome, stake, p.payout);
    d.onRec({ ...rec, result: res.outcome, profit });
    pnl += profit;
    lastMsg = res.outcome;
    if (res.outcome === "loss" && step < maxStep) { step++; continue; }
    return { final: res.outcome, steps: step, pnl: Math.round(pnl * 100) / 100, message: lastMsg };
  }
}

// ---------------------------------------------------------------- browser helpers (WebSocket + fetch)
export interface Candle { time: number; open: number; high: number; low: number; close: number }

/** Closed + forming candles for a market, over the same websocket the chart uses. */
export function fetchCandles(wsBase: string, broker: string, symbol: string, tf: number): Promise<{ candles: Candle[]; clockOff: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws?broker=${encodeURIComponent(broker)}&asset=${encodeURIComponent(symbol)}&tf=${tf}`);
    let done = false, candles: Candle[] | null = null, clockOff = 0;
    const finish = (err?: Error) => { if (done) return; done = true; clearTimeout(to); try { ws.close(); } catch { /* closed */ } err ? reject(err) : resolve({ candles: candles!, clockOff }); };
    const to = setTimeout(() => finish(new Error("The bridge did not answer in time")), 25000);
    ws.onerror = () => finish(new Error("Could not reach the bridge"));
    ws.onmessage = (e) => {
      let m: any; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === "history" && Array.isArray(m.candles) && !candles) {
        candles = m.candles;
        setTimeout(() => finish(), 1200);      // wait a moment for a tick: it carries the broker's clock
      } else if (m.type === "tick" && typeof m.ts === "number") {
        clockOff = m.ts - Date.now() / 1000;
        if (candles) finish();
      } else if (m.type === "error" && !candles) finish(new Error(m.msg || "Bridge error"));
    };
  });
}
