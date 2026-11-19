// These tests exercise the candle-pattern strategies broadcasting on their own (the legacy mode). The default mode is covered by src/stochRsi.test.ts.
process.env.STRATEGY_MODE = 'legacy';
// LIVE-DATA REPLAY. The real Deriv R_75 five-minute candles (fixtures/r75_m5_live_slice.csv, the last 3000 candles of the user's export)
// are fed candle by candle through the REAL market agent, candidate hub, three engines, coordinator and signal pipeline.
// Fake: the clock, the rasterizer and Gemini (no network here). Nothing is mocked about the engines or the agent.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SweepWatcherService, WatcherDeps } from "./sweepWatcherCore";
import { CandidateHub } from "./candidateHub";
import { VerificationCoordinator } from "./verificationCoordinator";
import { makePipeline } from "./candidatePipeline";
import { validateEvidence } from "./candidateTypes";
import { evaluateEngines } from "./engineEvaluator";
import { getSignal, resetSignalCaches, Cand } from "../signalServer";
import { Autopilot, ACCOUNT_REFUSAL, DEFAULT_CFG, Deps } from "./autopilot";
import { PNG, fakeAi, fakeRasterizer } from "./aiFixtures";

const TF = 300;
const ALL: Cand[] = readFileSync(new URL("../fixtures/r75_m5_live_slice.csv", import.meta.url), "utf8").trim().split("\n").slice(1)
  .map((l) => { const [t, o, h, lo, c] = l.split(",").map(Number); return { time: t, open: o, high: h, low: lo, close: c }; });
const STEPS = 400;                                   // the newest 400 candles (about 33 hours of live R_75)
const START = ALL.length - STEPS;
const engines = async (candles: Cand[], tf: number, _n?: number, symbol?: string) => evaluateEngines(candles as any, tf, 1, symbol) as any;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("the live CSV is clean and sorted", () => {
  assert.equal(ALL.length, 3000);
  for (let i = 1; i < ALL.length; i++) assert.ok(ALL[i].time > ALL[i - 1].time);
  for (const c of ALL) assert.ok(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close));
});

test("replay: agent -> hub -> 3 engines + AI on 400 real candles; nothing breaks, nothing is traded on bad evidence", async () => {
  resetSignalCaches();
  let now = ALL[START].time + TF + 3;
  const wdeps: WatcherDeps = { now: async () => now, sleep: async () => {}, fetchCandles: async (_s, _tf, count) => ALL.filter((c) => c.time + TF <= now).slice(-count).map((c) => ({ ...c })) };
  const hub = new CandidateHub();
  const watcher = new SweepWatcherService({ agents: [{ symbol: "R_75", name: "Volatility 75", market: "Volatility 75 Index" }], deps: wdeps, hub, rasterize: async () => PNG, tf: TF });
  const ai = fakeAi();
  const pipeline = makePipeline(() => ({ engines, ai, rasterizer: fakeRasterizer, now: () => now * 1000 }));
  const errors: string[] = [];
  const coord = new VerificationCoordinator(hub, { pipeline: async (ev, c) => { try { return await pipeline(ev, c); } catch (e) { errors.push((e as Error).message); throw e; } }, nowSec: () => now, maxEntryDelaySec: 45, enabled: () => true }).start();
  for (let i = 0; i < STEPS; i++) {
    now = ALL[START + i].time + TF + 3;
    await watcher.runPass(0);
    const t0 = Date.now();
    while (hub.list(500).some((r) => !r.decision) && Date.now() - t0 < 4000) await sleep(2);
  }
  const recs = hub.list(500);
  const byEngine: Record<string, number> = {}, byDir: Record<string, number> = {};
  let executes = 0, rejects = 0;
  for (const r of recs) {
    const v = r.versions[0];
    byEngine[v.engine] = (byEngine[v.engine] ?? 0) + 1; byDir[v.direction] = (byDir[v.direction] ?? 0) + 1;
    assert.deepEqual(validateEvidence(v), [], `evidence for ${r.id} is consistent`);
    assert.ok(r.decision, `candidate ${r.id} got a decision`);
    assert.equal(r.results.filter((x) => x.kind === "engine").length >= 3, true, "all three engines answered");
    assert.ok(r.results.some((x) => x.kind === "ai"), "the AI answered");
    if (r.decision!.action === "EXECUTE") { executes++; assert.equal(r.decision!.candleSetHash, v.candleSetHash); } else rejects++;
  }
  assert.equal(new Set(recs.map((r) => r.id)).size, recs.length, "no duplicate candidates");
  assert.deepEqual(errors, [], "no pipeline errors");
  console.log(`LIVE REPLAY ${STEPS} candles: candidates=${recs.length} byEngine=${JSON.stringify(byEngine)} byDirection=${JSON.stringify(byDir)} approved=${executes} rejected=${rejects} geminiCalls=${ai.calls.length}`);
  assert.ok(recs.length > 0, "the agents found setups in real data");
  coord.stop();
});

test("manual signals: getSignal on 300 real windows never throws and always returns a well-formed answer", async () => {
  resetSignalCaches();
  const ai = fakeAi();
  let setups = 0, tradeable = 0, noSetup = 0;
  for (let i = 0; i < 300; i++) {
    const end = START + i + 40;
    const win = ALL.slice(Math.max(0, end - 250), end);
    const clk = win[win.length - 1].time + TF + 5;
    const s = await getSignal({ engines, ai, rasterizer: fakeRasterizer, now: () => clk * 1000 }, win, TF, "Volatility 75 Index", "deriv:R_75", clk);
    assert.ok(typeof s.status === "string" && Array.isArray(s.reasons));
    if (s.setup) { setups++; assert.ok(s.side === "buy" || s.side === "sell"); if (s.tradeable) tradeable++; } else { noSetup++; assert.equal(s.tradeable, false); }
  }
  console.log(`MANUAL SIGNAL 300 windows: setups=${setups} tradeable=${tradeable} noSetup=${noSetup}`);
  assert.equal(setups + noSetup, 300);
});

test("PAT: an account refusal is recognised, and AutoTrade stops on the first one instead of approving more orders", async () => {
  assert.ok(ACCOUNT_REFUSAL.test("broker refused: Deriv account not connected. Please enter your Deriv PAT Token on the API screen."));
  assert.ok(!ACCOUNT_REFUSAL.test("The contract expired"));
  const cs = ALL.slice(0, 60);
  let placed = 0;
  const deps: Deps = {
    assets: () => [{ symbol: "R_75", label: "Volatility 75", payout: 90, active: true } as any],
    watch: async () => ({ candles: cs.map((c) => ({ ...c })), price: () => cs[cs.length - 1].close, clock: () => cs[cs.length - 1].time + TF + 2, close() {} }),
    analyze: async () => ({ side: "buy", confidence: 80, why: "test", ref: { signalKey: "k", side: "buy" } as any }) as any,
    place: async () => { placed++; return { ok: false, msg: "broker refused: Deriv account not connected. Please enter your Deriv PAT Token on the API screen." }; },
    result: async () => ({ outcome: "win", profit: 1 }),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 3))),
  } as any;
  const ap = new Autopilot(deps, { ...DEFAULT_CFG, minConf: 50, maxTrades: 10, stake: 1, expirySec: 0 });
  void ap.start().catch(() => {});
  const t0 = Date.now();
  while (ap.state.phase !== "stopped" && Date.now() - t0 < 4000) await sleep(10);
  assert.equal(ap.state.phase, "stopped");
  assert.equal(placed, 1, "exactly one refused attempt, then stop");
  assert.match(ap.state.stopReason ?? "", /Deriv account not connected/);
});
