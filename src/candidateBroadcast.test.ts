// These tests exercise the candle-pattern strategies broadcasting on their own (the legacy mode). The default mode is covered by src/stochRsi.test.ts.
process.env.STRATEGY_MODE = 'legacy';
// Multi-agent continuous surveillance with immediate evidence broadcast (see docs/CANDIDATE_BROADCAST.md).
// Real market agents (SweepWatcherService) + real engines + the real signal pipeline; only the broker feed, the clock, the rasterizer and Gemini are fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { SweepWatcherService, WatcherDeps } from "./sweepWatcherCore";
import { CandidateHub } from "./candidateHub";
import { VerificationCoordinator, PipelineAnswer, PipelineRunner, aggregate } from "./verificationCoordinator";
import { CandidateEvidence, PublishInput, candidateIdFor, screenshotOf, validateEvidence } from "./candidateTypes";
import { ENGINE_NAMES, EngineConsumerResult, evaluateEngine, revalidateSetup } from "./candidateEngines";
import { PriorityLimiter } from "./concurrency";
import { lookFromCandidate } from "./candidateLook";
import { makePipeline, imageOf } from "./candidatePipeline";
import { getSignal, resetSignalCaches } from "../signalServer";
import { ExecutionLedger } from "./aiVerification";
import { C, detectAll } from "./sweepEngines";
import { PNG, TF, engine, fakeAi, fakeRasterizer, market, withSweep } from "./aiFixtures";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const flush = () => sleep(25);

// ------------------------------------------------------------------------------------------------ fixtures
const SETUP: C[] = withSweep(market("up"), "BUY");                 // 62 closed M5 candles; the engines find a TAKE sweep BUY on the last one
const SIGNAL = SETUP[SETUP.length - 1];
const CLOSE = SIGNAL.time + TF;
const NOW = CLOSE + 3;                                              // broker clock: the candle has just closed

/** a fake broker: candles up to the clock, the newest one "forming" with garbage values until its period is over */
function feed(data: Record<string, C[]>, o: { hang?: string[]; fail?: string[] } = {}) {
  const st = { now: NOW, fetches: 0 };
  const deps: WatcherDeps = {
    now: async () => st.now,
    sleep: async () => {},
    fetchCandles: async (symbol, _tf, count) => {
      st.fetches++;
      if (o.hang?.includes(symbol)) return new Promise<C[]>(() => {});
      if (o.fail?.includes(symbol)) throw new Error("boom");
      const cs = data[symbol].filter((c) => c.time <= st.now).map((c) => ({ ...c }));
      const last = cs[cs.length - 1];
      if (last && last.time + TF > st.now) Object.assign(last, { open: last.open + 50, close: last.close - 50, high: last.high + 80, low: last.low - 80 });
      return cs.slice(-count);
    },
  };
  return { st, deps };
}
const agents = (n: number) => Array.from({ length: n }, (_, i) => ({ symbol: `M${i + 1}`, name: `Agent ${i + 1}`, market: `Market ${i + 1}` }));
const dataFor = (n: number) => Object.fromEntries(agents(n).map((a) => [a.symbol, SETUP.map((c) => ({ ...c }))]));
const rasterize = async () => PNG;

function rig(n = 1, o: { pipeline?: PipelineRunner; hubOpts?: ConstructorParameters<typeof CandidateHub>[0]; coord?: Partial<ConstructorParameters<typeof VerificationCoordinator>[1]>; data?: Record<string, C[]>; feedOpts?: Parameters<typeof feed>[1] } = {}) {
  const hub = new CandidateHub(o.hubOpts);
  const f = feed(o.data ?? dataFor(n), o.feedOpts);
  const watcher = new SweepWatcherService({ agents: agents(n), deps: f.deps, hub, rasterize, tf: TF });
  const calls: CandidateEvidence[] = [];
  const pipeline: PipelineRunner = o.pipeline ?? (async (ev) => { calls.push(ev); return approve(ev); });
  const coord = new VerificationCoordinator(hub, { pipeline, nowSec: () => f.st.now, maxEntryDelaySec: 45, ...o.coord }).start();
  return { hub, watcher, coord, st: f.st, calls };
}
const approve = (ev: CandidateEvidence): PipelineAnswer => ({ tradeable: true, side: ev.direction, status: "Verified by the AI", reasons: [], imageSha256: ev.screenshot.pngSha256, aiRowsHash: ev.aiRowsHash, signal: { fake: true } });
const input = (o: Partial<PublishInput> = {}): PublishInput => ({
  agentId: "Agent 1", symbol: "M1", market: "Market 1", engine: "sweep", direction: "BUY", tf: TF, signalCandleOpen: SIGNAL.time, patternFrom: SETUP[SETUP.length - 2].time,
  tradeAtNextOpen: false, entry: SIGNAL.close, sweptLevel: 1, notes: [], trace: [], ohlc: SETUP.map((c) => ({ ...c })), engineWindow: 45,
  screenshot: screenshotOf("<svg/>", PNG, Date.now(), 1), detectedAtMs: Date.now(), detectionLatencySec: 3, ...o,
});
async function decided(hub: CandidateHub, id: string, ms = 2000) { const d = await hub.waitForDecision(id, ms); assert.ok(d, "a decision was made"); return d!; }

// ------------------------------------------------------------------------------------------------ 1. multiple agents, simultaneously
test("1. many agents detect setups at the same moment: every one becomes its own candidate and is verified", async () => {
  const r = rig(12);
  await r.watcher.runPass(0);
  const list = r.hub.list(50);
  assert.equal(list.length, 12);
  assert.equal(new Set(list.map((c) => c.id)).size, 12, "unique candidate ids");
  assert.equal(new Set(list.map((c) => c.versions[0].agentId)).size, 12, "one per agent");
  await Promise.all(list.map((c) => decided(r.hub, c.id)));
  assert.ok(list.every((c) => c.decision?.action === "EXECUTE"));
  assert.equal(r.calls.length, 12, "the AI pipeline got each candidate once");
});

// ------------------------------------------------------------------------------------------------ 2. immediate screenshot broadcast (and no second pipeline)
test("2. the agent's own screenshot + OHLC is broadcast the moment the setup is found; nothing draws a second screenshot", async () => {
  const hub = new CandidateHub();
  const got: { at: number; ev: CandidateEvidence }[] = [];
  hub.subscribe("probe", (ev) => { got.push({ at: Date.now(), ev }); });
  const f = feed(dataFor(1));
  const w = new SweepWatcherService({ agents: agents(1), deps: f.deps, hub, rasterize, tf: TF });
  await w.runPass(0);
  assert.equal(got.length, 1);
  const ev = got[0].ev, alert = w.getAlerts(0, 10)[0];
  assert.equal(ev.screenshot.svg, w.getAlertSvg(alert.id), "the candidate carries the very svg the Menu shows");
  assert.equal(alert.candidate_id, ev.candidateId);
  assert.equal(ev.screenshot.png, PNG);
  assert.ok(ev.ohlc.length >= 60 && ev.ohlc[ev.ohlc.length - 1].time === ev.signalCandleOpen, "OHLC package ends on the signal candle");
  assert.equal(ev.signalCandleClose, ev.signalCandleOpen + TF);
  assert.ok(ev.screenshotAtMs > 0 && got[0].at - ev.screenshotAtMs < 250, "delivered right after the screenshot was taken");
  assert.match(ev.candidateId, /^cand-[0-9a-f]{16}$/);
  assert.equal(ev.version, 1); assert.equal(ev.kind, "ORIGINAL"); assert.equal(ev.agentId, "Agent 1"); assert.equal(ev.direction, "BUY");
  const s = hub.metrics.summary();
  assert.ok(s.stages.broadcast && s.stages.screenshot && s.stages.detection, "latencies measured");
  assert.ok(s.stages.broadcast.max < 50, `broadcast took ${s.stages.broadcast.max} ms`);
  assert.equal(Math.round(s.stages.detection.last), 3000, "detection latency = broker seconds after the candle closed");
});

// ------------------------------------------------------------------------------------------------ 3. identical evidence for all recipients
test("3. the three engines and the AI receive identical evidence and each answer names the version and hash it read", async () => {
  const seen = new Map<string, CandidateEvidence>();
  const r = rig(1, { pipeline: async (ev) => { seen.set("ai", ev); return approve(ev); } });
  r.hub.subscribe("probe", (ev) => { seen.set("probe", ev); });
  const engineRunner = async (name: any, ev: CandidateEvidence) => { seen.set(`engine:${name}`, ev); return evaluateEngine(name, ev, Date.now, () => performance.now()); };
  r.coord.stop();
  new VerificationCoordinator(r.hub, { pipeline: async (ev) => { seen.set("ai", ev); return approve(ev); }, nowSec: () => r.st.now, engineRunner }).start();
  await r.watcher.runPass(0);
  const rec = r.hub.list(1)[0];
  const d = await decided(r.hub, rec.id);
  assert.deepEqual([...seen.keys()].sort(), ["ai", "engine:continuation", "engine:momentum", "engine:sweep", "probe"]);
  const first = seen.get("probe")!;
  for (const ev of seen.values()) assert.equal(ev, first, "the very same frozen object");
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.ohlc));
  assert.throws(() => { (first as any).direction = "SELL"; }, TypeError);
  for (const x of rec.results) { assert.equal(x.candidateId, first.candidateId); assert.equal(x.version, 1); assert.equal(x.candleSetHash, first.candleSetHash); }
  assert.deepEqual(rec.results.map((x) => x.recipient).sort(), ["ai", "engine:continuation", "engine:momentum", "engine:sweep"]);
  assert.equal(d.action, "EXECUTE");
  assert.deepEqual(d.corroboratedBy, ["sweep"], "only the sweep engine fires on this chart; the others are independent 'no signal' answers");
});

// ------------------------------------------------------------------------------------------------ 4. Gemini gets the same screenshot
test("4. Gemini receives the candidate's screenshot (same PNG bytes), the same candles, and no second screenshot is drawn", async () => {
  resetSignalCaches();
  const ai = fakeAi();
  let rasterCalls = 0;
  const deps = () => ({ engines: async () => engine("BUY"), ai, rasterizer: async () => { rasterCalls++; return PNG; }, now: () => NOW * 1000 });
  const r = rig(1, { pipeline: makePipeline(deps, (ev) => `deriv:${ev.symbol}`) });
  await r.watcher.runPass(0);
  const rec = r.hub.list(1)[0], ev = rec.versions[0];
  const d = await decided(r.hub, rec.id);
  assert.equal(ai.calls.length, 1);
  const req = ai.calls[0];
  assert.equal(req.image?.sha256, ev.screenshot.pngSha256, "Gemini was given the candidate's screenshot");
  assert.equal(req.image?.base64, Buffer.from(ev.screenshot.png!).toString("base64"));
  assert.equal(req.image?.candleSetHash, ev.aiRowsHash);
  assert.equal(req.image?.lastCandleTime, ev.signalCandleOpen);
  assert.equal(req.prompt.split("\n").filter((l) => /^\d{10},/.test(l)).length, 60, "and the same 60 OHLC rows");
  assert.equal(rasterCalls, 0, "no second screenshot pipeline ran");
  assert.equal(d.action, "EXECUTE", d.reasons.join("; "));
  // the pipeline's own record of what Gemini saw
  const ai1 = rec.results.find((x) => x.recipient === "ai") as any;
  assert.equal(ai1.answer.imageSha256, ev.screenshot.pngSha256);

  // the autopilot reads that decision instead of asking again
  const ledger = new ExecutionLedger();
  const look = await lookFromCandidate(r.hub, { symbol: "M1", market: "deriv:M1", label: "Market 1", tfSec: TF, clk: NOW, candles: SETUP, ledger, waitMs: 100, maxEntryDelaySec: 45 });
  assert.ok(look && "ref" in look, JSON.stringify(look));
  if (look && "ref" in look) { assert.equal(look.ref.candidateId, ev.candidateId); assert.equal(look.side, "buy"); }
  assert.equal(ai.calls.length, 1, "still one Gemini call");
  ledger.claim(`deriv:M1|${TF}|${SIGNAL.time}|BUY`);
  const again = await lookFromCandidate(r.hub, { symbol: "M1", market: "deriv:M1", label: "Market 1", tfSec: TF, clk: NOW, candles: SETUP, ledger, waitMs: 100, maxEntryDelaySec: 45 });
  assert.ok(again && "none" in again && /already traded/.test(again.none));
  assert.equal(await lookFromCandidate(r.hub, { symbol: "OTHER", market: "deriv:OTHER", label: "x", tfSec: TF, clk: NOW, candles: SETUP, ledger, waitMs: 10, maxEntryDelaySec: 45 }), null, "no agent candidate: the older path is used");
});

// ------------------------------------------------------------------------------------------------ 5. parallel engines
test("5. the three engines and the AI run side by side, not one after the other", async () => {
  const log: { who: string; start: number; end: number }[] = [];
  const t0 = Date.now();
  const timed = async (who: string, fn: () => Promise<any>) => { const start = Date.now() - t0; const v = await fn(); log.push({ who, start, end: Date.now() - t0 }); return v; };
  const r = rig(1, {
    pipeline: (ev) => timed("ai", async () => { await sleep(60); return approve(ev); }),
    coord: { engineRunner: (name, ev) => timed(name, async () => { await sleep(60); return evaluateEngine(name, ev, Date.now, () => performance.now()); }) },
  });
  await r.watcher.runPass(0);
  const d = await decided(r.hub, r.hub.list(1)[0].id);
  assert.equal(log.length, 4);
  const lastStart = Math.max(...log.map((l) => l.start)), firstEnd = Math.min(...log.map((l) => l.end));
  assert.ok(lastStart < firstEnd, `all four started (${lastStart} ms) before any finished (${firstEnd} ms)`);
  assert.ok(Math.max(...log.map((l) => l.end)) < 60 * 4 - 40, "total time is about one answer, not four in a row");
  assert.equal(d.action, "EXECUTE");
});

// ------------------------------------------------------------------------------------------------ 6. slow AI never blocks other markets
test("6a. a slow AI request for one market does not delay another market's decision", async () => {
  const r = rig(2, { pipeline: async (ev) => { await sleep(ev.symbol === "M1" ? 300 : 5); return approve(ev); } });
  await r.watcher.runPass(0);
  const [m2, m1] = [r.hub.findByCandle("M2", TF, SIGNAL.time)[0], r.hub.findByCandle("M1", TF, SIGNAL.time)[0]];
  const d2 = await decided(r.hub, m2.id);
  assert.equal(m1.decision, null, "M1 is still waiting for its AI");
  assert.equal(d2.action, "EXECUTE");
  const d1 = await decided(r.hub, m1.id);
  assert.ok(d1.decidedAtMs - d2.decidedAtMs > 150);
});

test("6b. agents keep watching while verification is running (a new candle is read and its setup published meanwhile)", async () => {
  const next = (c: C[], k: number): C[] => c.map((x, i) => ({ ...x, time: x.time + k * TF * 1000 }));      // a different, later period for another market
  void next;
  const data = { M1: SETUP.map((c) => ({ ...c })), M2: SETUP.slice(0, -2).map((c) => ({ ...c })) };           // M2 has no setup yet
  const r = rig(2, { data, pipeline: async (ev) => { await sleep(250); return approve(ev); } });
  await r.watcher.runPass(0);                                  // M1's setup is published, its AI takes 250 ms
  assert.equal(r.hub.list(10).length, 1);
  const m1 = r.hub.list(1)[0];
  // while M1's AI is still running, M2's market moves and the agent finds its setup
  data.M2 = SETUP.map((c) => ({ ...c }));
  await r.watcher.runPass(0);
  assert.equal(r.hub.list(10).length, 2, "M2 was examined and its setup published while M1 was still being verified");
  assert.equal(m1.decision, null);
  await Promise.all(r.hub.list(10).map((c) => decided(r.hub, c.id)));
});

test("6c. a hung or failing market delays nobody: each agent runs its own loop", async () => {
  const sleepers: (() => void)[] = [];
  const f = feed(dataFor(3), { hang: ["M1"], fail: ["M2"] });
  f.deps.sleep = () => new Promise<void>((res) => { sleepers.push(res); });
  const hub = new CandidateHub();
  const w = new SweepWatcherService({ agents: agents(3), deps: f.deps, hub, rasterize, tf: TF });
  w.start(TF, 0);
  await flush();
  assert.equal(hub.list(10).length, 1, "M3 published although M1 never answers and M2 errors");
  assert.equal(hub.list(1)[0].symbol, "M3");
  const st = w.getState();
  assert.ok(st.markets.find((m) => m.symbol === "M2")!.error, "M2's failure is reported");
  w.stop(); sleepers.splice(0).forEach((s) => s());
});

// ------------------------------------------------------------------------------------------------ 7. live chart updates
test("7. live chart updates during verification become new versions; the original screenshot and candles are preserved", async () => {
  const r = rig(1, { pipeline: async (ev) => { await sleep(120); return approve(ev); } });
  await r.watcher.runPass(0);
  const rec = r.hub.list(1)[0], v1 = rec.versions[0];
  const v1Svg = v1.screenshot.svg, v1Hash = v1.candleSetHash;
  // the broker re-sends the chart with an older (context) candle corrected: the setup itself is untouched
  const data2 = SETUP.map((c) => ({ ...c }));
  data2[3] = { ...data2[3], close: data2[3].close + 0.01, high: data2[3].high + 0.02 };
  const f2 = feed({ M1: data2 });
  const w2 = new SweepWatcherService({ agents: agents(1), deps: f2.deps, hub: r.hub, rasterize, tf: TF });
  await w2.refreshCandidates(agents(1)[0]);
  assert.equal(rec.versions.length, 2, "version 2 stored");
  const v2 = rec.versions[1];
  assert.equal(v2.kind, "UPDATE"); assert.equal(v2.supersedes, 1); assert.notEqual(v2.candleSetHash, v1Hash);
  assert.ok(v2.validity.valid);
  assert.equal(rec.versions[0], v1, "version 1 is untouched");
  assert.equal(v1.screenshot.svg, v1Svg); assert.equal(v1.candleSetHash, v1Hash);
  assert.ok(v2.screenshot.svg !== v1Svg && v2.screenshotAtMs >= v1.screenshotAtMs, "the updated chart has its own screenshot and timestamp");
  assert.equal(r.hub.metrics.summary().counters.updates, 1);
  // a second look at identical data publishes nothing new
  await w2.refreshCandidates(agents(1)[0]);
  assert.equal(rec.versions.length, 2);
  const d = await decided(r.hub, rec.id);
  assert.equal(d.evaluatedVersion, 1, "the AI judged version 1");
  assert.equal(d.latestVersion, 2, "and the decision knows version 2 exists");
  assert.equal(d.action, "EXECUTE", "the update did not change the setup, so the decision stands (revalidated)");
  // the engine recipients read version 2 as well, each result tagged with it
  await flush();
  const v2Results = rec.results.filter((x) => x.version === 2);
  assert.deepEqual(v2Results.map((x) => x.recipient).sort(), ["engine:continuation", "engine:momentum", "engine:sweep"]);
  assert.ok(v2Results.every((x) => x.candleSetHash === v2.candleSetHash));
  assert.equal(r.hub.executionCheck(rec.id, { nowSec: NOW, maxEntryDelaySec: 45 }).latestVersion, 2);
});

// ------------------------------------------------------------------------------------------------ 8. version consistency
test("8. results that name a wrong version or a wrong candle-set hash are rejected and never counted", async () => {
  const hub = new CandidateHub();
  const out = hub.publish(input());
  assert.equal(out.status, "PUBLISHED");
  const ev = (out as any).candidate as CandidateEvidence;
  const base = { kind: "engine", candidateId: ev.candidateId, durationMs: 1, atMs: 1, recipient: "x" };
  assert.equal(hub.recordResult({ ...base, version: 1, candleSetHash: ev.candleSetHash }).accepted, true);
  assert.equal(hub.recordResult({ ...base, version: 2, candleSetHash: ev.candleSetHash }).accepted, false, "version that does not exist");
  assert.equal(hub.recordResult({ ...base, version: 1, candleSetHash: "0".repeat(64) }).accepted, false, "hash of other candles");
  assert.equal(hub.recordResult({ ...base, candidateId: "cand-unknown", version: 1, candleSetHash: ev.candleSetHash }).accepted, false);
  assert.equal(hub.get(ev.candidateId)!.rejectedResults.length, 2);
  assert.equal(hub.metrics.summary().counters.inconsistentResults, 3);

  // a recipient that answers about the wrong evidence makes the candidate fail instead of passing
  const r = rig(1, { coord: { engineRunner: async (name, ev2) => ({ ...evaluateEngine(name, ev2, Date.now, () => 0), candleSetHash: name === "momentum" ? "f".repeat(64) : ev2.candleSetHash }) } });
  await r.watcher.runPass(0);
  const d = await decided(r.hub, r.hub.list(1)[0].id);
  assert.equal(d.action, "REJECT");
  assert.match(d.reasons.join(" "), /inconsistent result/);
});

// ------------------------------------------------------------------------------------------------ 9. candle-set hash validation
test("9a. evidence whose hash, candles or timing are inconsistent is refused before anybody sees it", async () => {
  const hub = new CandidateHub();
  let heard = 0; hub.subscribe("probe", () => { heard++; });
  const bad = (patch: Partial<PublishInput>) => hub.publish(input(patch));
  const invalid = SETUP.map((c) => ({ ...c })); invalid[10] = { ...invalid[10], high: invalid[10].low - 1 };
  assert.equal(bad({ ohlc: invalid }).status, "REJECTED", "invalid OHLC");
  assert.equal(bad({ ohlc: SETUP.slice(-10).map((c) => ({ ...c })) }).status, "REJECTED", "too few candles");
  assert.equal(bad({ signalCandleOpen: SIGNAL.time - TF }).status, "REJECTED", "the last candle is not the signal candle");
  const dup = SETUP.map((c) => ({ ...c })); dup[20] = { ...dup[19] };
  assert.equal(bad({ ohlc: dup }).status, "REJECTED", "repeated candle");
  assert.equal(heard, 0, "no recipient was told");
  const ok = hub.publish(input()) as any;
  const ev: CandidateEvidence = ok.candidate;
  assert.deepEqual(validateEvidence(ev), []);
  assert.match(validateEvidence({ ...ev, candleSetHash: "a".repeat(64) }).join(), /candle-set hash/);
  assert.match(validateEvidence({ ...ev, ohlc: ev.ohlc.map((c, i) => (i === 30 ? { ...c, close: c.close + 1 } : c)) }).join(), /candle-set hash/);
  assert.match(validateEvidence({ ...ev, candidateId: "cand-0000000000000000" }).join(), /candidate id/);
  assert.match(validateEvidence({ ...ev, screenshot: { ...ev.screenshot, png: new Uint8Array([1, 2, 3]) } }).join(), /png hash/);
  assert.equal(ev.candidateId, candidateIdFor("M1", TF, SIGNAL.time, "BUY"));
});

test("9b. the AI refuses a screenshot that was drawn from other candles (never an approval, and Gemini is not called)", async () => {
  resetSignalCaches();
  const ai = fakeAi();
  const hub = new CandidateHub();
  const ev = (hub.publish(input()) as any).candidate as CandidateEvidence;
  const deps = { engines: async () => engine("BUY"), ai, rasterizer: fakeRasterizer, now: () => NOW * 1000 };
  const img = imageOf(ev)!;
  const wrongSet = await getSignal({ ...deps, image: { ...img, candleSetHash: "b".repeat(64) } }, ev.ohlc as any[], TF, "M", "deriv:M1", NOW);
  assert.equal(wrongSet.tradeable, false); assert.equal(wrongSet.decision, "AI_UNAVAILABLE");
  assert.match(wrongSet.verification!.aiError!.message, /different candle set/);
  const wrongCandle = await getSignal({ ...deps, image: { ...img, lastCandleTime: img.lastCandleTime - TF } }, ev.ohlc as any[], TF, "M", "deriv:M1", NOW);
  assert.equal(wrongCandle.tradeable, false); assert.match(wrongCandle.verification!.aiError!.message, /ends on/);
  assert.equal(ai.calls.length, 0);
  const good = await getSignal({ ...deps, image: img }, ev.ohlc as any[], TF, "M", "deriv:M1", NOW);
  assert.equal(good.tradeable, true); assert.equal(ai.calls.length, 1);

  // and the coordinator refuses an answer that says it inspected a different picture
  const eng = new Map(ENGINE_NAMES.map((n) => [n, evaluateEngine(n, ev, Date.now, () => 0)] as const));
  const aiRes = { kind: "ai", candidateId: ev.candidateId, version: 1, candleSetHash: ev.candleSetHash, recipient: "ai", durationMs: 1, atMs: 1, status: "DONE", detail: "", answer: { ...approve(ev), imageSha256: "c".repeat(64) } } as any;
  const agg = aggregate(ev, eng, aiRes);
  assert.equal(agg.action, "REJECT"); assert.match(agg.reasons.join(), /different screenshot/);
  assert.equal(aggregate(ev, eng, { ...aiRes, answer: approve(ev) }).action, "EXECUTE");
  assert.match(aggregate(ev, eng, { ...aiRes, answer: { ...approve(ev), aiRowsHash: "d".repeat(64) } }).reasons.join(), /different candle set/);
});

// ------------------------------------------------------------------------------------------------ 10. invalidation during verification
test("10a. an updated chart that revises the setup's candle cancels it, even if the AI approves later", async () => {
  const r = rig(1, { pipeline: async (ev) => { await sleep(150); return approve(ev); } });
  await r.watcher.runPass(0);
  const rec = r.hub.list(1)[0];
  // the broker corrects the signal candle: it now closes as a bearish candle
  const data2 = SETUP.map((c) => ({ ...c }));
  const s = data2[data2.length - 1]; data2[data2.length - 1] = { ...s, close: s.open - 0.1 };
  const w2 = new SweepWatcherService({ agents: agents(1), deps: feed({ M1: data2 }).deps, hub: r.hub, rasterize, tf: TF });
  await w2.refreshCandidates(agents(1)[0]);
  assert.equal(rec.status, "INVALIDATED");
  assert.match(rec.invalidReason!, /revised|no longer|SKIPS/);
  assert.equal(rec.decision?.action, "CANCELLED", "cancelled at once, without waiting for the AI");
  assert.equal(rec.versions[0].validity.valid, true, "version 1 still reads exactly as it was");
  assert.equal(rec.versions[1].validity.valid, false);
  await sleep(250);                                                    // the AI has now answered "approved" for version 1
  assert.equal(rec.decision?.action, "CANCELLED", "a late approval does not revive it");
  assert.ok(rec.decisionHistory.some((d) => d.action === "CANCELLED" || d.action === "EXECUTE"));
  const chk = r.hub.executionCheck(rec.id, { nowSec: NOW, maxEntryDelaySec: 45 });
  assert.equal(chk.ok, false); assert.match(chk.reason, /invalidated/);
  const look = await lookFromCandidate(r.hub, { symbol: "M1", market: "deriv:M1", label: "M", tfSec: TF, clk: NOW, candles: SETUP, ledger: new ExecutionLedger(), waitMs: 50, maxEntryDelaySec: 45 });
  assert.ok(look && "none" in look && /cancelled/.test(look.none), JSON.stringify(look));
});

test("10b. an approved setup is cancelled when the chart changes before the order; a harmless update is not", async () => {
  const r = rig(1);
  await r.watcher.runPass(0);
  const rec = r.hub.list(1)[0];
  assert.equal((await decided(r.hub, rec.id)).action, "EXECUTE");
  assert.equal(r.hub.executionCheck(rec.id, { nowSec: NOW, maxEntryDelaySec: 45 }).ok, true);
  // newer candles are not an invalidation by themselves
  const later: C = { time: SIGNAL.time + TF, open: SIGNAL.close, high: SIGNAL.close + 0.05, low: SIGNAL.close - 0.05, close: SIGNAL.close + 0.02 };
  const upd = r.hub.update(rec.id, { ohlc: [...SETUP, later], screenshot: screenshotOf("<svg/>", PNG, Date.now(), 1), reason: "next candle" });
  assert.equal(upd.status, "UPDATED");
  assert.equal(r.hub.executionCheck(rec.id, { nowSec: NOW, maxEntryDelaySec: 45 }).ok, true);
  assert.deepEqual(revalidateSetup(rec.versions[0], [...SETUP, later]), { valid: true, reasons: [] });
  // the candle vanishes from the data
  const gone = r.hub.update(rec.id, { ohlc: SETUP.slice(0, -1), screenshot: screenshotOf("<svg/>", PNG, Date.now(), 1), reason: "data gap" });
  assert.equal(gone.status, "INVALIDATED");
  assert.equal(rec.decision?.action, "CANCELLED");
  const chk = r.hub.executionCheck(rec.id, { nowSec: NOW, maxEntryDelaySec: 45 });
  assert.equal(chk.ok, false);
  assert.equal(r.hub.markExecuted(rec.id), true, "markExecuted itself never decides: the execution check does");
});

// ------------------------------------------------------------------------------------------------ 11. duplicates
test("11. the same setup is published once; a second engine on the same candle is merged; one verification, one order", async () => {
  const hub = new CandidateHub();
  let heard = 0; hub.subscribe("probe", () => { heard++; });
  const a = hub.publish(input()) as any;
  const b = hub.publish(input());
  assert.equal(a.status, "PUBLISHED"); assert.equal(b.status, "DUPLICATE");
  const c = hub.publish(input({ engine: "continuation" }));
  assert.equal(c.status, "MERGED");
  assert.equal(hub.list(10).length, 1); assert.deepEqual(hub.get(a.candidate.candidateId)!.coDetectedBy, ["continuation"]);
  assert.equal(heard, 1, "recipients were told once");
  // a different direction on the same candle is a separate opportunity (the engines then flag the conflict)
  assert.equal(hub.publish(input({ direction: "SELL" })).status, "PUBLISHED");

  // through the agents: passes repeated over the same candle publish and verify once
  const r = rig(1);
  await r.watcher.runPass(0); await r.watcher.runPass(0); await r.watcher.runPass(0);
  assert.equal(r.hub.list(10).length, 1);
  await decided(r.hub, r.hub.list(1)[0].id);
  assert.equal(r.calls.length, 1, "the AI was asked once");
  const id = r.hub.list(1)[0].id;
  assert.equal(r.hub.markExecuted(id), true);
  assert.equal(r.hub.markExecuted(id), false, "a second order for the same candidate is refused");
  assert.match(r.hub.executionCheck(id, { nowSec: NOW, maxEntryDelaySec: 45 }).reason, /already executed/);
  r.hub.unmarkExecuted(id);
  assert.equal(r.hub.executionCheck(id, { nowSec: NOW, maxEntryDelaySec: 45 }).ok, true, "a broker refusal gives the candidate back");
});

test("11b. opposite directions on the same candle: the engines flag the conflict and the candidate is rejected", async () => {
  // the engines read the same evidence; an OPPOSITE answer from any engine rejects the candidate
  const hub = new CandidateHub();
  const ev = (hub.publish(input()) as any).candidate as CandidateEvidence;
  const engines = new Map(ENGINE_NAMES.map((n) => [n, evaluateEngine(n, ev, Date.now, () => 0)] as const));
  engines.set("momentum", { ...engines.get("momentum")!, status: "OPPOSITE", side: "SELL", ok: true } as EngineConsumerResult);
  const ai = { kind: "ai", candidateId: ev.candidateId, version: 1, candleSetHash: ev.candleSetHash, recipient: "ai", durationMs: 1, atMs: 1, status: "DONE", detail: "", answer: approve(ev) } as any;
  const agg = aggregate(ev, engines, ai);
  assert.equal(agg.action, "REJECT"); assert.match(agg.reasons.join(), /conflict: momentum/);
});

// ------------------------------------------------------------------------------------------------ 12. freshness
test("12a. a stale candidate is never executed, and the AI is not asked about one that can no longer be traded", async () => {
  const hub = new CandidateHub();
  const ev = (hub.publish(input()) as any).candidate as CandidateEvidence;
  assert.equal(hub.executionCheck(ev.candidateId, { nowSec: CLOSE - 2, maxEntryDelaySec: 45 }).ok, false, "not closed yet");
  assert.equal(hub.executionCheck(ev.candidateId, { nowSec: CLOSE + 10, maxEntryDelaySec: 45 }).ok, true);
  const late = hub.executionCheck(ev.candidateId, { nowSec: CLOSE + 46, maxEntryDelaySec: 45 });
  assert.equal(late.ok, false); assert.match(late.reason, /stale/);

  // a late candidate: the clock says 60 s after the close when the AI would be called
  const r = rig(1, { coord: { nowSec: () => CLOSE + 60 } });
  await r.watcher.runPass(0);
  const d = await decided(r.hub, r.hub.list(1)[0].id);
  assert.equal(r.calls.length, 0, "Gemini was not called for evidence that cannot be traded any more");
  assert.equal(d.action, "REJECT"); assert.match(d.reasons.join(), /stale/);
});

test("12b. decisions made too late are not executable, and the freshest candidate is verified first", async () => {
  let t = NOW;
  const r = rig(1, { coord: { nowSec: () => t }, pipeline: async (ev) => { t = CLOSE + 50; return approve(ev); } });   // the AI answers 50 s after the close
  await r.watcher.runPass(0);
  const d = await decided(r.hub, r.hub.list(1)[0].id);
  assert.equal(d.action, "REJECT"); assert.match(d.reasons.join(), /execution check failed: stale/);

  const order: string[] = [];
  const lim = new PriorityLimiter(1);
  const gate = new Promise<void>((res) => setTimeout(res, 30));
  const running = lim.run(1, async () => { await gate; order.push("running"); });
  const jobs = [100, 300, 200].map((p) => lim.run(p, async () => { order.push(`p${p}`); }));
  const vetoed = lim.run(400, async () => { order.push("p400"); }, () => "too old");
  await Promise.all([running, ...jobs]);
  assert.deepEqual(await vetoed, { ran: false, reason: "too old" });
  assert.deepEqual(order, ["running", "p300", "p200", "p100"], "newest first");
});

// ------------------------------------------------------------------------------------------------ latency measurements
test("latency of every stage is measured: detection, screenshot, broadcast, each engine, AI, aggregation and execution", async () => {
  const r = rig(2, { pipeline: async (ev) => { await sleep(20); return approve(ev); } });
  await r.watcher.runPass(0);
  for (const c of r.hub.list(10)) await decided(r.hub, c.id);
  r.hub.markExecuted(r.hub.list(1)[0].id);
  const s = r.hub.metrics.summary();
  for (const k of ["detection", "screenshot", "broadcast", "engine:sweep", "engine:continuation", "engine:momentum", "ai", "aggregation", "execution"]) {
    assert.ok(s.stages[k] && s.stages[k].count >= 1, `stage ${k}`);
    assert.ok(s.stages[k].min >= 0 && s.stages[k].p95 >= s.stages[k].p50, `stage ${k} statistics`);
  }
  assert.ok(s.stages.ai.min >= 18, "the AI stage includes the AI time");
  assert.equal(s.counters.published, 2); assert.equal(s.counters.decisions, 2); assert.equal(s.counters.executed, 1);
});

test("the engine recipients use the unchanged engine rules on the candidate's candles (same answer as the agent's detectAll)", () => {
  const hub = new CandidateHub();
  const ev = (hub.publish(input()) as any).candidate as CandidateEvidence;
  const win = SETUP.slice(-45);
  const want = detectAll(win, win.length - 1).map((v) => `${v.engine}:${v.side}:${v.ok}`);
  const got = ENGINE_NAMES.map((n) => evaluateEngine(n, ev, Date.now, () => 0)).filter((x) => x.status !== "NO_SIGNAL").map((x) => `${x.engine}:${x.side}:${x.ok}`);
  assert.deepEqual(got, want);
  assert.equal(evaluateEngine("sweep", ev, Date.now, () => 0).status, "CONFIRMS");
  assert.equal(evaluateEngine("momentum", ev, Date.now, () => 0).status, "NO_SIGNAL");
});
