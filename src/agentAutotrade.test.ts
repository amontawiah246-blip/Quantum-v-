// These tests exercise the candle-pattern strategies broadcasting on their own (the legacy mode). The default mode is covered by src/stochRsi.test.ts.
process.env.STRATEGY_MODE = 'legacy';
// AutoTrade is driven ONLY by the market agents' setups (docs/AGENT_AUTOTRADE.md).
// Real: the agents (SweepWatcherService), candidate hub, coordinator + three engines, the signal pipeline (getSignal) and the autopilot.
// Fake: the broker feed and order call, the clock, the rasterizer and Gemini.
import test from "node:test";
import assert from "node:assert/strict";
import { SweepWatcherService, WatcherDeps } from "./sweepWatcherCore";
import { CandidateHub } from "./candidateHub";
import { VerificationCoordinator, PipelineRunner } from "./verificationCoordinator";
import { evaluateEngine } from "./candidateEngines";
import { makePipeline } from "./candidatePipeline";
import { lookFromAgents } from "./candidateLook";
import { makeAgentSource } from "./agentSource";
import { agentMode } from "./agentMode";
import { Autopilot, DEFAULT_CFG, Deps } from "./autopilot";
import { AutoRef } from "./autoLook";
import { screenshotOf, CandidateEvidence } from "./candidateTypes";
import { ExecutionLedger } from "./aiVerification";
import { resetSignalCaches } from "../signalServer";
import { C } from "./sweepEngines";
import { PNG, TF, engine, fakeAi, fakeRasterizer, market, withSweep } from "./aiFixtures";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(5); } };

const SETUP: C[] = withSweep(market("up"), "BUY");
const SIGNAL = SETUP[SETUP.length - 1];
const CLOSE = SIGNAL.time + TF;
const NOW = CLOSE + 3;
const rasterize = async () => PNG;

function rig(n = 1, o: { pipeline?: (base: PipelineRunner) => PipelineRunner; coordNow?: () => number; watchHook?: () => void; engineRunner?: any } = {}) {
  agentMode.active = false; resetSignalCaches();
  const st = { now: NOW, fetches: 0 };
  const agents = Array.from({ length: n }, (_, i) => ({ symbol: `M${i + 1}`, name: `Agent ${i + 1}`, market: `Market ${i + 1}` }));
  const wdeps: WatcherDeps = {
    now: async () => st.now, sleep: async () => {},
    fetchCandles: async (sym, _tf, count) => { st.fetches++; return SETUP.filter((c) => c.time <= st.now).slice(-count).map((c) => ({ ...c })); },
  };
  const hub = new CandidateHub();
  const watcher = new SweepWatcherService({ agents, deps: wdeps, hub, rasterize, tf: TF });
  const ai = fakeAi();
  const base = makePipeline(() => ({ engines: async () => engine("BUY"), ai, rasterizer: fakeRasterizer, now: () => st.now * 1000 }));
  const pipeline = o.pipeline ? o.pipeline(base) : base;
  const ledger = new ExecutionLedger();
  const evs: CandidateEvidence[] = [];
  const coord = new VerificationCoordinator(hub, {
    pipeline: async (ev, c) => { evs.push(ev); return pipeline(ev, c); }, nowSec: o.coordNow ?? (() => st.now), maxEntryDelaySec: 45, enabled: () => agentMode.active,
    engineRunner: o.engineRunner,
  }).start();
  const source = makeAgentSource(hub, { labelOf: (_s, fb) => fb, tfSec: () => TF, agentsActive: () => n, nowSec: () => st.now, maxEntryDelaySec: 45, ledger });

  const calls = { assets: 0, watch: 0, analyze: 0 };
  const placed: { symbol: string; side: string; at: number }[] = [];
  const pending = new Map<string, AutoRef>();
  const deps: Deps = {
    agentSource: source,
    assets: () => { calls.assets++; return []; },
    watch: async () => { calls.watch++; o.watchHook?.(); return { candles: SETUP.map((c) => ({ ...c })), price: () => SIGNAL.close, clock: () => st.now, close() {} }; },
    analyze: (symbol, candles, tf, now) => { calls.analyze++; return lookFromAgents(hub, { symbol, market: `deriv:${symbol}`, label: symbol, tfSec: tf, clk: now ?? st.now, candles, ledger, waitMs: 300, maxEntryDelaySec: 45 }); },
    // the same checks as autoServer.preflight / place for the candidate: still valid and fresh, ledger claim, one order per candidate
    preflight: async ({ symbol, side, ref }) => {
      const r = ref as AutoRef;
      const c = hub.executionCheck(r.candidateId!, { nowSec: st.now, maxEntryDelaySec: 45 });
      if (!c.ok) return { ok: false, reason: `candidate: ${c.reason}` };
      pending.set(`${symbol}|${side}`, r);
      return { ok: true, reason: "" };
    },
    place: async (symbol, side) => {
      const r = pending.get(`${symbol}|${side}`); pending.delete(`${symbol}|${side}`);
      if (!r) return { ok: false, msg: "no verified reference" };
      if (!ledger.claim(`${r.signalKey}|${r.side}`)) return { ok: false, msg: "duplicate order blocked" };
      if (!hub.markExecuted(r.candidateId!)) { ledger.release(`${r.signalKey}|${r.side}`); return { ok: false, msg: "candidate already executed" }; }
      hub.emit({ type: "ordering", candidateId: r.candidateId!, side: r.side });
      placed.push({ symbol, side, at: Date.now() });
      hub.emit({ type: "ordered", candidateId: r.candidateId!, side: r.side, brokerOrderId: `B${placed.length}` });
      return { ok: true, msg: "", id: `B${placed.length}` };
    },
    result: async () => ({ outcome: "win", profit: 8 }),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  };
  const mk = () => new Autopilot(deps, { ...DEFAULT_CFG, minConf: 55, maxTrades: 10, stake: 10, expirySec: 0 });
  return { st, hub, watcher, coord, source, deps, calls, placed, ai, evs, ledger, mk, agents };
}

// ------------------------------------------------------------------------------------------------ 1-3
test("1. switching AutoTrade ON starts no scanner: no market list, no watch, no analyse, no engines request", async () => {
  const r = rig(3);
  await r.watcher.runPass(0);                                  // the agents have been watching all along
  const fetchesBefore = r.st.fetches;
  const ap = r.mk(); void ap.start();
  await sleep(60);
  assert.equal(ap.state.phase, "listening");
  assert.deepEqual(r.calls, { assets: 0, watch: 0, analyze: 0 }, "no scan of any kind");
  assert.deepEqual(ap.state.scan, []);
  assert.equal(r.st.fetches, fetchesBefore, "switching ON did not make the agents fetch anything extra, and AutoTrade fetched nothing itself");
  assert.equal(r.watcher.getState().agents, 3);
  ap.stop();
});

test("2. the agents keep monitoring their markets whether AutoTrade is off, on, or off again", async () => {
  const r = rig(2);
  await r.watcher.runPass(0);                                  // OFF
  const a = r.st.fetches; assert.ok(a >= 2);
  const ap = r.mk(); void ap.start(); await sleep(30);
  r.st.now += TF; await r.watcher.runPass(0);                  // ON: next candle
  const b = r.st.fetches; assert.ok(b >= a + 2, "agents fetched again while AutoTrade is on");
  ap.stop(); await sleep(20);
  r.st.now += TF; await r.watcher.runPass(0);                  // OFF again
  assert.ok(r.st.fetches >= b + 2);
  assert.equal(r.watcher.getState().agents, 2, "same agents, none added or restarted");
});

test("3. an agent-detected setup enters AutoTrade by itself and is traded, with no scan and no manual step", async () => {
  const r = rig(1);
  const ap = r.mk(); void ap.start(); await sleep(20);
  await r.watcher.runPass(0);
  await until(() => r.placed.length === 1);
  assert.deepEqual(r.placed.map((p) => [p.symbol, p.side]), [["M1", "buy"]]);
  assert.deepEqual(r.calls.assets, 0); assert.equal(r.calls.watch, 1, "one watch, only to follow the order it is about to place");
  await until(() => ap.state.stats.wins === 1);
  const d = ap.state.agent!;
  assert.deepEqual([d.agentsActive, d.detected, d.forwarded, d.engineAnalyses, d.aiAnalyses, d.approved, d.rejected, d.expired, d.executed, d.wins, d.losses], [1, 1, 1, 3, 1, 1, 0, 0, 1, 1, 0]);
  const stages = d.feed.map((f) => f.stage).reverse();
  assert.deepEqual(stages.filter((s, i) => stages.indexOf(s) === i), ["DETECTED", "SENT", "ENGINE", "AI", "FINAL", "BROKER", "TRADE"]);
  assert.match(d.feed[d.feed.length - 1].text, /AGENT DETECTED → Market 1 → BUY → Buy .* /, "pattern name shown");
  assert.ok(d.feed.some((f) => /GEMINI → APPROVED/.test(f.text)) && d.feed.some((f) => /ENGINE 1 → BUY/.test(f.text)));
  ap.stop();
});

// ------------------------------------------------------------------------------------------------ 4-6
test("4+5. all three engines and Gemini receive the same screenshot the agent drew", async () => {
  const seen = new Map<string, CandidateEvidence>();
  const r = rig(1, { engineRunner: async (n: any, ev: CandidateEvidence) => { seen.set(`engine:${n}`, ev); return evaluateEngine(n, ev, Date.now, () => performance.now()); } });
  const ap = r.mk(); void ap.start(); await sleep(10);
  await r.watcher.runPass(0);
  await until(() => r.placed.length === 1);
  const rec = r.hub.list(1)[0], ev = rec.versions[0];
  assert.deepEqual([...seen.keys()].sort(), ["engine:continuation", "engine:momentum", "engine:sweep"]);
  for (const e of seen.values()) { assert.equal(e, ev); assert.equal(e.screenshot.pngSha256, ev.screenshot.pngSha256); }
  assert.equal(r.evs[0], ev, "the AI recipient got the same object");
  assert.equal(r.ai.calls.length, 1);
  assert.equal(r.ai.calls[0].image?.sha256, ev.screenshot.pngSha256, "Gemini was given the agent's screenshot");
  assert.equal(ev.screenshot.svg, r.watcher.getAlertSvg(r.watcher.getAlerts(0, 5)[0].id), "which is the agent's own chart");
  ap.stop();
});

test("6. the four analyses run concurrently, and the decision comes after all of them", async () => {
  const log: { who: string; start: number; end: number }[] = []; const t0 = Date.now();
  const timed = async (who: string, f: () => Promise<any>) => { const start = Date.now() - t0; const v = await f(); log.push({ who, start, end: Date.now() - t0 }); return v; };
  const r = rig(1, {
    pipeline: (base) => (ev, c) => timed("ai", async () => { await sleep(60); return base(ev, c); }),
    engineRunner: (n: any, ev: CandidateEvidence) => timed(n, async () => { await sleep(60); return evaluateEngine(n, ev, Date.now, () => 0); }),
  });
  const ap = r.mk(); void ap.start(); await sleep(10);
  await r.watcher.runPass(0);
  await until(() => r.placed.length === 1);
  assert.equal(log.length, 4);
  assert.ok(Math.max(...log.map((l) => l.start)) < Math.min(...log.map((l) => l.end)), "all four were running at the same time");
  ap.stop();
});

// ------------------------------------------------------------------------------------------------ 7-9
test("7. a slow analysis for one agent does not block another agent's trade", async () => {
  const r = rig(2, { pipeline: (base) => async (ev, c) => { if (ev.symbol === "M1") await sleep(300); return base(ev, c); } });
  const ap = r.mk(); void ap.start(); await sleep(10);
  await r.watcher.runPass(0);
  await until(() => r.placed.length >= 1);
  assert.equal(r.placed[0].symbol, "M2", "the fast market traded first");
  assert.equal(r.hub.findByCandle("M1", TF, SIGNAL.time)[0].decision, null, "M1 was still being analysed");
  await until(() => r.placed.length === 2);
  assert.deepEqual(r.placed.map((p) => p.symbol), ["M2", "M1"]);
  ap.stop();
});

test("8. approved candidates reach the broker order automatically (ledger claimed, candidate marked executed)", async () => {
  const r = rig(1);
  const ap = r.mk(); void ap.start(); await sleep(10);
  await r.watcher.runPass(0);
  await until(() => r.placed.length === 1);
  const rec = r.hub.list(1)[0];
  assert.equal(rec.decision?.action, "EXECUTE"); assert.equal(rec.executed, true);
  assert.equal(r.ledger.has(`deriv:M1|${TF}|${SIGNAL.time}|BUY`), true);
  assert.equal(r.hub.metrics.summary().counters.executed, 1);
  assert.ok(r.hub.metrics.summary().stages.execution, "decision → order latency measured");
  ap.stop();
});

test("9. rejected candidates never reach the broker, and the exact reason is recorded", async () => {
  const r = rig(1, { pipeline: () => async (ev) => ({ tradeable: false, side: ev.direction, status: "REJECTED", reasons: ["the AI found the sweep did not hold"], imageSha256: ev.screenshot.pngSha256, aiRowsHash: ev.aiRowsHash }) });
  const ap = r.mk(); void ap.start(); await sleep(10);
  await r.watcher.runPass(0);
  const rec = r.hub.list(1)[0];
  await r.hub.waitForDecision(rec.id, 2000); await sleep(60);
  assert.equal(rec.decision?.action, "REJECT"); assert.match(rec.decision!.reasons.join(), /does not allow it: REJECTED/);
  assert.equal(r.placed.length, 0); assert.equal(r.calls.watch, 0, "not even a market read: nothing was approved");
  const d = ap.state.agent!;
  assert.deepEqual([d.detected, d.approved, d.rejected, d.executed], [1, 0, 1, 0]);
  assert.ok(d.feed.some((f) => /FINAL VALIDATION → REJECTED: .*REJECTED/.test(f.text)));
  ap.stop();
});

// ------------------------------------------------------------------------------------------------ 10-12
test("10. duplicate agent events cannot create duplicate trades", async () => {
  const r = rig(1);
  const ap = r.mk(); void ap.start(); await sleep(10);
  await r.watcher.runPass(0); await r.watcher.runPass(0);
  const ev = r.hub.list(1)[0].versions[0];
  for (let i = 0; i < 3; i++) r.hub.publish({ ...ev, ohlc: [...ev.ohlc], screenshot: screenshotOf(ev.screenshot.svg, PNG, Date.now(), 1), detectedAtMs: Date.now(), detectionLatencySec: 3, engineWindow: 45 } as any);   // the agent event arrives again and again
  await until(() => r.placed.length === 1);
  await sleep(150);
  assert.equal(r.hub.list(10).length, 1); assert.equal(r.placed.length, 1); assert.equal(r.ai.calls.length, 1);
  // even a hand-made second order for the same candle is refused
  assert.equal(r.ledger.claim(`deriv:M1|${TF}|${SIGNAL.time}|BUY`), false);
  assert.equal(r.hub.markExecuted(r.hub.list(1)[0].id), false);
  assert.equal(ap.state.agent!.detected, 1);
  ap.stop();
});

test("11. stale candidates are rejected: never sent to Gemini, never traded, counted as expired", async () => {
  const r = rig(1, { coordNow: () => CLOSE + 60 });
  const ap = r.mk(); void ap.start(); await sleep(10);
  await r.watcher.runPass(0);
  const rec = r.hub.list(1)[0];
  await r.hub.waitForDecision(rec.id, 2000); await sleep(40);
  assert.equal(rec.decision?.action, "REJECT"); assert.match(rec.decision!.reasons.join(), /stale/);
  assert.equal(r.ai.calls.length, 0); assert.equal(r.placed.length, 0);
  assert.equal(ap.state.agent!.expired, 1);
  // and one that goes stale AFTER approval, before AutoTrade gets to it
  const r2 = rig(1, { watchHook: () => { /* the clock runs on while AutoTrade reads the market for its order */ r2.st.now = CLOSE + 60; } });
  const ap2 = r2.mk(); void ap2.start(); await sleep(10);
  await r2.watcher.runPass(0);
  await until(() => r2.calls.watch === 1); await sleep(80);
  assert.equal(r2.placed.length, 0, "an approved but now-expired candidate is not traded");
  assert.ok(ap2.state.log.some((l) => /faded|stale|NO TRADE/.test(l.text)));
  ap.stop(); ap2.stop();
});

test("12. a faded setup cannot execute: an updated chart that invalidates it cancels the order", async () => {
  let r!: ReturnType<typeof rig>;
  r = rig(1, { watchHook: () => {
    // between approval and order the broker corrects the signal candle
    const rec = r.hub.list(1)[0]; const rows = SETUP.map((c) => ({ ...c })); const s = rows[rows.length - 1];
    rows[rows.length - 1] = { ...s, close: s.open - 0.1 };
    r.hub.update(rec.id, { ohlc: rows, screenshot: screenshotOf("<svg/>", PNG, Date.now(), 1), reason: "chart changed" });
  } });
  const ap = r.mk(); void ap.start(); await sleep(10);
  await r.watcher.runPass(0);
  await until(() => r.calls.watch === 1); await sleep(80);
  assert.equal(r.placed.length, 0);
  assert.equal(r.hub.list(1)[0].status, "INVALIDATED");
  assert.ok(ap.state.agent!.feed.some((f) => /SETUP INVALIDATED/.test(f.text)));
  assert.ok(ap.state.agent!.rejected + ap.state.agent!.expired >= 1, "counted as not traded");
  ap.stop();
});

// ------------------------------------------------------------------------------------------------ 13-14
test("13. switching AutoTrade OFF stops new orders and Gemini requests at once; the agents keep monitoring", async () => {
  const r = rig(1);
  const ap = r.mk(); void ap.start(); await sleep(20);
  assert.equal(agentMode.active, true);
  ap.stop(); await sleep(20);
  assert.equal(agentMode.active, false);
  assert.deepEqual(r.hub.listenerNames, [], "AutoTrade left no listener behind");
  const f0 = r.st.fetches;
  await r.watcher.runPass(0);
  await sleep(80);
  assert.equal(r.hub.list(10).length, 1, "the agent still detected and published the setup");
  assert.ok(r.st.fetches > f0, "agents are still watching");
  assert.equal(r.ai.calls.length, 0, "but nothing was sent to Gemini"); assert.equal(r.placed.length, 0);
  assert.equal(r.hub.list(1)[0].decision, null);
});

test("14. switching AutoTrade ON again creates no duplicate subscription, agent or trade", async () => {
  const r = rig(1);
  for (let i = 0; i < 3; i++) { const ap = r.mk(); void ap.start(); await sleep(15); ap.stop(); await sleep(15); }
  const ap = r.mk(); void ap.start(); await sleep(15);
  assert.deepEqual(r.hub.listenerNames.sort(), ["autotrade:feed", "autotrade:setups"], "exactly one listener each");
  const again = r.mk(); void again.start(); await sleep(15);        // a second start while one is already running (same shared source)
  assert.deepEqual(r.hub.listenerNames.sort(), ["autotrade:feed", "autotrade:setups"]);
  again.stop(); await sleep(15);
  void ap;                                                          // `again` closing the shared source also switched ON mode off; restart cleanly
  const live = r.mk(); void live.start(); await sleep(15);
  await r.watcher.runPass(0);
  await until(() => r.placed.length >= 1); await sleep(100);
  assert.equal(r.placed.length, 1, "one candidate, one trade");
  assert.equal(r.watcher.getState().agents, 1);
  assert.equal(live.state.agent!.detected, 1);
  live.stop(); ap.stop();
});
