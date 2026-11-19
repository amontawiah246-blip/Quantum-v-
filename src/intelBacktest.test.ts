import test from "node:test";
import assert from "node:assert/strict";
import { Candle } from "./candleMath";
import { StrategyDef, runBacktest, summarize, Trade } from "./engineBacktest";
import { allStrategies, breakdown, intelligenceStrategies, resampleCandles, runTimeframes, sweepBucket } from "./intelBacktest";
import { FIVE_MINUTES, EXPIRY_DEFAULTS, QUANTUM_EXECUTION, planTrade, recordFill, resolveExpiry, settle } from "./executionConfig";
import { synthCandles } from "./syntheticData";

const fireAt = (id: string, side: "BUY" | "SELL", idx: number[], detail?: Record<string, string>): StrategyDef => ({ id, label: id, group: "engine5", detect: (_c, i) => (idx.includes(i) ? { side, detail } : null) });
const fine10 = synthCandles({ n: 30 * 70, tf: 10, seed: 9, baseVol: 0.0003 });          // 10-second candles, 70 five-minute candles worth
const chart = resampleCandles(fine10, 10, 300);

test("execution: every trade records signal close, ACTUAL execution time, entry price, settlement time and payout", () => {
  const { trades } = runBacktest([{ symbol: "S", candles: chart }], { expiries: [300], strategies: [fireAt("a", "BUY", [40], { trend: "BULLISH" })] });
  const t = trades[0];
  assert.equal(t.signalCloseTime, chart[40].time + 300); assert.equal(t.executionTime, chart[41].time); assert.equal(t.delaySec, 0);
  assert.equal(t.entry, chart[41].open); assert.equal(t.exit, chart[41].close);
  assert.equal(t.settleTime, t.executionTime + 300); assert.equal(t.payout, 0.92); assert.deepEqual(t.detail, { trend: "BULLISH" });
});

test("execution: a whole-candle delay moves the fill and the settlement; 5-minute trade still runs exactly 5 minutes after the fill", () => {
  const { trades } = runBacktest([{ symbol: "S", candles: chart }], { expiries: [300], delaySec: 300, strategies: [fireAt("a", "SELL", [40])] });
  const t = trades[0];
  assert.equal(t.executionTime, chart[42].time); assert.equal(t.delaySec, 300); assert.equal(t.entry, chart[42].open);
  assert.equal(t.exit, chart[42].close); assert.equal((t.settleTime ?? 0) - (t.executionTime ?? 0), 300);
});

test("execution: a delay that is not a whole number of candles needs finer data (no invented prices)", () => {
  assert.throws(() => runBacktest([{ symbol: "S", candles: chart }], { expiries: [300], delaySec: 7, strategies: [fireAt("a", "BUY", [40])] }), /finer price series/);
});

test("execution: with fine data the fill is the first price at/after close + delay and settlement is exactly expiry after the actual fill", () => {
  const sig = 40, close = chart[sig].time + 300;
  const { trades } = runBacktest([{ symbol: "S", candles: chart, fine: fine10 }], { expiries: [300], delaySec: 7, strategies: [fireAt("a", "BUY", [sig])] });
  const t = trades[0];
  const fill = fine10.find((c) => c.time >= close + 7)!;                       // 10s granularity: first print is close + 10
  assert.equal(fill.time, close + 10);
  assert.equal(t.executionTime, fill.time); assert.equal(t.entry, fill.open); assert.equal(t.delaySec, 10);
  const exit = fine10.find((c) => c.time >= fill.time + 300)!;
  assert.equal(t.settleTime, exit.time); assert.equal(t.exit, exit.open); assert.equal(t.settleTime, t.executionTime + 300);
  const win = t.exit > t.entry;
  assert.equal(t.result, win ? "win" : t.exit < t.entry ? "loss" : "tie");
  // with delay 0 the fine-data trade equals the chart trade (same prices)
  const zero = runBacktest([{ symbol: "S", candles: chart, fine: fine10 }], { expiries: [300], strategies: [fireAt("a", "BUY", [sig])] }).trades[0];
  assert.equal(zero.entry, chart[sig + 1].open); assert.equal(zero.executionTime, chart[sig + 1].time);
});

test("execution: a delayed 5-minute trade is NOT the colour of the next candle (it can differ from it)", () => {
  let differs = 0, n = 0;
  const data = synthCandles({ n: 30 * 600, tf: 10, seed: 4, baseVol: 0.0004 }), ch = resampleCandles(data, 10, 300);
  const idx = Array.from({ length: 100 }, (_, k) => 30 + k * 4);
  const base = runBacktest([{ symbol: "S", candles: ch }], { expiries: [300], strategies: [fireAt("a", "BUY", idx)] }).trades;
  const late = runBacktest([{ symbol: "S", candles: ch, fine: data }], { expiries: [300], delaySec: 120, strategies: [fireAt("a", "BUY", idx)] }).trades;
  for (const t of late) { const b = base.find((x) => x.signalIndex === t.signalIndex); if (b) { n++; if (b.result !== t.result) differs++; } }
  assert.ok(n > 80); assert.ok(differs > 5, `delayed results differ from next-candle colour on ${differs} of ${n}`);
});

test("execution: incomplete fine data skips the trade and counts it", () => {
  const short = fine10.slice(0, 30 * 41 + 5);
  const { report } = runBacktest([{ symbol: "S", candles: chart, fine: short }], { expiries: [300], strategies: [fireAt("a", "BUY", [40])] });
  assert.equal(report.strategies[0].byExpiry[300].overall.trades, 0); assert.equal(report.strategies[0].byExpiry[300].skippedIncomplete, 1);
});

test("payout: a per-market/expiry table is used per trade and the break-even uses the payouts actually used", () => {
  const { trades, report } = runBacktest([{ symbol: "S", candles: chart }], { expiries: [300], payoutFor: (s, e) => (s === "S" && e === 300 ? 0.8 : 0.9), strategies: [fireAt("a", "BUY", [30, 40, 50])] });
  assert.ok(trades.every((t) => t.payout === 0.8));
  const win = trades.find((t) => t.result === "win"); if (win) assert.ok(Math.abs(win.pnl - 0.8) < 1e-12);
  const st = report.strategies[0].byExpiry[300].overall;
  assert.ok(Math.abs(st.breakevenWinRate - 1 / 1.8) < 1e-12);
  assert.equal(report.config.payoutTable, true);
  const flat = summarize(trades.map((t) => ({ ...t, payout: undefined })) as Trade[], 0.92, 0);
  assert.ok(Math.abs(flat.breakevenWinRate - 1 / 1.92) < 1e-12);
});

test("5-minute rule: a 5-minute chart ALWAYS gets a 5-minute expiry, whatever the market condition or policy says", () => {
  assert.deepEqual(resolveExpiry(300).expirySec, 300);
  for (const c of ["HEALTHY_CONTINUATION", "POSSIBLE_EXHAUSTION", "CONFIRMED_STRUCTURE_REVERSAL", "UNCLEAR"] as const) {
    const r = resolveExpiry(300, c, { ...EXPIRY_DEFAULTS, defaultMultiple: 3, byCondition: { [c]: 6 } });
    assert.equal(r.expirySec, FIVE_MINUTES); assert.ok(r.locked && r.ok);
  }
  const noOffer = resolveExpiry(300, null, EXPIRY_DEFAULTS, [60, 180, 600]);
  assert.equal(noOffer.ok, false); assert.equal(noOffer.expirySec, 300); assert.match(noOffer.reason, /no trade/);
  assert.equal(resolveExpiry(300, null, EXPIRY_DEFAULTS, [60, 300]).ok, true);
});

test("expiry policy: other timeframes follow the condition-based policy, snap to what the broker offers and stay in bounds", () => {
  assert.equal(resolveExpiry(900).expirySec, 900);                                        // default: one candle
  const pol = { ...EXPIRY_DEFAULTS, byCondition: { POSSIBLE_EXHAUSTION: 1, HEALTHY_CONTINUATION: 2 } };
  assert.equal(resolveExpiry(900, "HEALTHY_CONTINUATION", pol).expirySec, 1800);
  assert.equal(resolveExpiry(900, "HEALTHY_CONTINUATION", pol, [900, 1500, 2400]).expirySec, 1500);
  assert.equal(resolveExpiry(1800, "HEALTHY_CONTINUATION", pol).expirySec, 3600);
  assert.equal(resolveExpiry(30).expirySec, 60); assert.equal(resolveExpiry(0).ok, false);
});

test("lifecycle: signals wait for the candle to close; a stale signal is dropped; settlement runs from the ACTUAL fill", () => {
  const sig = { symbol: "S", side: "BUY" as const, signalCandleTime: 1000 };
  assert.equal(planTrade(sig, QUANTUM_EXECUTION, 1299).plan, null);
  assert.match(planTrade(sig, QUANTUM_EXECUTION, 1299).reason, /not closed/);
  assert.match(planTrade(sig, QUANTUM_EXECUTION, 1311).reason, /stale/);
  const { plan } = planTrade(sig, QUANTUM_EXECUTION, 1302);
  assert.ok(plan); assert.equal(plan!.signalCloseTime, 1300); assert.equal(plan!.expirySec, 300);
  const rec = recordFill(plan!, { executionTime: 1304, entryPrice: 50 });
  assert.equal(rec.delaySec, 4); assert.equal(rec.settleAt, 1604);                           // not 1600
  assert.deepEqual(settle(rec, 50.1, 0.9), { result: "win", pnl: 0.9 });
  assert.deepEqual(settle(rec, 49.9, 0.9), { result: "loss", pnl: -1 });
  assert.deepEqual(settle(rec, 50, 0.9), { result: "tie", pnl: 0 });
  assert.deepEqual(settle({ ...rec, side: "SELL" }, 49.9, 0.9), { result: "win", pnl: 0.9 });
});

test("resample: buckets are OHLC aggregates; incomplete or gapped buckets are dropped", () => {
  const base = synthCandles({ n: 30, seed: 2, t0: 1_760_000_100 - (1_760_000_100 % 900) });
  const r = resampleCandles(base, 300, 900);
  assert.equal(r.length, 10);
  assert.equal(r[0].open, base[0].open); assert.equal(r[0].close, base[2].close);
  assert.equal(r[0].high, Math.max(base[0].high, base[1].high, base[2].high)); assert.equal(r[0].low, Math.min(base[0].low, base[1].low, base[2].low));
  assert.equal(r[0].time % 900, 0);
  const holes = base.filter((_, k) => k !== 4);
  assert.equal(resampleCandles(holes, 300, 900).length, 9);
  assert.throws(() => resampleCandles(base, 300, 450), /cannot resample/);
});

test("timeframes: a 5-minute run uses the 5-minute expiry only; a 15-minute run uses 15 minutes; explicit expiries are research overrides", () => {
  const data = [{ symbol: "S", candles: synthCandles({ n: 3000, seed: 8 }) }];
  const runs = runTimeframes(data, 300, [300, 900]);
  assert.deepEqual(runs.map((r) => r.expiries), [[300], [900]]);
  assert.ok(runs[0].trades.every((t) => t.expiry === 300) && runs[1].trades.every((t) => t.expiry === 900));
  assert.ok(runs[0].trades.length > 0);
  assert.deepEqual(runTimeframes(data, 300, [300], { expiries: [300, 600] })[0].expiries, [300, 600]);
});

test("backtest: Engines 7-12 strategies run side by side, each hypothesis separately, trades carry tags, breakdown by sweep count and trend", () => {
  const cs = synthCandles({ n: 12000, seed: 5 });
  const { trades, report } = runBacktest([{ symbol: "S", candles: cs }], { expiries: [300, 600], strategies: intelligenceStrategies() });
  const ids = report.strategies.map((s) => s.id);
  for (const id of ["e7_three_strong_as_continuation", "e7_three_strong_as_reversal", "e7_wss_as_reversal", "e7_wss_as_continuation", "e9_single_sweep", "e9_repeated_cluster", "e9_with_trend_sweep", "e9_countertrend_sweep", "e10_reversal_confirmed", "e11_continuation_confirmed", "pipeline_all"]) assert.ok(ids.includes(id), id);
  const n = (id: string) => report.strategies.find((s) => s.id === id)!.signals;
  assert.equal(n("e7_three_strong_as_continuation"), n("e7_three_strong_as_reversal"));                 // the same setups, opposite sides
  assert.ok(n("e9_single_sweep") > 0 && n("e9_repeated_cluster") > 0);
  const byCount = breakdown(trades, "e9_repeated_cluster", 300, "sweepCount", 0.92);
  assert.deepEqual(Object.keys(byCount).filter((k) => !["2", "3", "4+"].includes(k)), []);
  assert.equal(Object.values(byCount).reduce((a, s) => a + s.trades, 0), trades.filter((t) => t.strategy === "e9_repeated_cluster" && t.expiry === 300).length);
  const byTrend = breakdown(trades, "e9_single_sweep", 300, "alignment", 0.92);
  assert.ok(["COUNTERTREND", "NO_TREND", "WITH_TREND"].every((k) => k in byTrend));
  assert.equal(sweepBucket(1), "1"); assert.equal(sweepBucket(7), "4+");
  const bothExpiries = report.strategies[0].byExpiry; assert.ok(bothExpiries[300] && bothExpiries[600]);
});

test("backtest: strategy signals use only data up to the signal candle (cut the series anywhere, same signals before the cut)", () => {
  const cs = synthCandles({ n: 3000, seed: 14 });
  const strategies = allStrategies();
  for (const s of strategies) {
    const full: string[] = []; for (let i = 40; i < 2000; i++) { const r = s.detect(cs, i); if (r) full.push(`${i}:${r.side}`); }
    const cut = cs.slice(0, 2000), part: string[] = []; for (let i = 40; i < 2000; i++) { const r = s.detect(cut, i); if (r) part.push(`${i}:${r.side}`); }
    assert.deepEqual(part, full, s.id);
  }
});

test("backtest: chronological out-of-sample segments hold for the new strategies (train < validation < test, no trade crosses a boundary)", () => {
  const cs = synthCandles({ n: 12000, seed: 6 });
  const { trades } = runBacktest([{ symbol: "S", candles: cs }], { expiries: [300], strategies: intelligenceStrategies() });
  const order = { train: 0, validation: 1, test: 2 } as const;
  const lastOf = (seg: "train" | "validation" | "test") => Math.max(...trades.filter((t) => t.segment === seg).map((t) => t.exitIndex));
  const firstOf = (seg: "train" | "validation" | "test") => Math.min(...trades.filter((t) => t.segment === seg).map((t) => t.entryIndex));
  assert.ok(lastOf("train") < firstOf("validation") && lastOf("validation") < firstOf("test"));
  assert.ok(order.train < order.test);
});
