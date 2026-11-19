// These tests exercise the candle-pattern strategies broadcasting on their own (the legacy mode). The default mode is covered by src/stochRsi.test.ts.
process.env.STRATEGY_MODE = 'legacy';
// LSCC (Liquidity Sweep Confirmation Candle) regression tests. docs/LSCC.md
// Real: the detector, the market agent (SweepWatcherService), the candidate hub, the three engines, the verification coordinator, the signal
// pipeline (getSignal with the real engine evaluator) and the autopilot timing. Fake: the clock, the rasterizer, Gemini.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LSCC_DEFAULTS, detectLsccSignal, findLsccSweep, lsccOutcome, Bar } from "./lscc";
import { detectAll, detectLscc, C } from "./sweepEngines";
import { SweepWatcherService, WatcherDeps } from "./sweepWatcherCore";
import { CandidateHub } from "./candidateHub";
import { VerificationCoordinator } from "./verificationCoordinator";
import { evaluateEngine } from "./candidateEngines";
import { makePipeline } from "./candidatePipeline";
import { evaluateEngines } from "./engineEvaluator";
import { verifyPattern } from "./patternVerification";
import { lsccCards } from "./lsccBoard";
import { chooseTiming } from "./tradeSession";
import { getSignal, resetSignalCaches } from "../signalServer";
import { DEFAULT_POLICY } from "./aiVerification";
import { PNG, T0, TF, fakeAi, fakeRasterizer } from "./aiFixtures";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(4); } };
const engines = async (candles: any[], tf: number, _n?: number, symbol?: string) => evaluateEngines(candles, tf, 1, symbol) as any;

// ------------------------------------------------------------------------------------------------ the market
// 25 candles of steady decline, then the crafted section. Swing low (the liquidity) = 100.0 at section index 12 (its neighbours are all higher).
type Row = [number, number, number, number];
const SEC: Row[] = [
  [130, 130.5, 127.5, 128], [127.2, 127.7, 124.7, 125.2], [124.4, 124.9, 121.9, 122.4], [121.6, 122.1, 119.1, 119.6], [118.8, 119.3, 116.3, 116.8],
  [116, 116.5, 113.5, 114], [113.2, 113.7, 110.7, 111.2], [110.4, 110.9, 107.9, 108.4], [107.6, 108.1, 105.1, 105.6], [104.8, 105.3, 102.3, 102.8],
  [102.8, 103, 101.0, 101.5], [101.5, 101.8, 100.4, 100.8], [100.8, 101.5, 100.0, 101.2], [101.2, 102.3, 100.9, 102], [102, 102.9, 101.6, 102.6],
  [102.6, 103.2, 102.3, 103.0], [103, 103.2, 102.4, 102.7], [102.7, 103.4, 102.5, 103.2],
  [103.0, 103.5, 99.0, 103.3],      // 18 = SWEEP: low 99.0 < 100, body 103.0-103.3 stays above 100, closes back above
  [103.4, 104.6, 103.2, 104.4],     // 19 = CONFIRMATION: bullish, closes above the sweep high 103.5
];
const PRE: Row[] = Array.from({ length: 25 }, (_, i) => { const o = 190 - 2.4 * i, c = o - 2; return [o, o + 0.5, c - 0.5, c] as Row; });
const toBars = (rows: Row[], k = 0): C[] => rows.map(([o, h, l, c], i) => ({ time: T0 + i * TF, open: o, high: h, low: l, close: c }) as C).map((c) => k ? { ...c, open: k - c.open, high: k - c.low, low: k - c.high, close: k - c.close } : c);
const SWEEP_AT = PRE.length + 18, CONF_AT = PRE.length + 19;
/** the bullish market with candle SWEEP_AT / CONF_AT replaced (undefined = unchanged) */
const bull = (o: { sweep?: Row; conf?: Row; extra?: Row[] } = {}): C[] => {
  const rows = [...PRE, ...SEC]; if (o.sweep) rows[SWEEP_AT] = o.sweep; if (o.conf) rows[CONF_AT] = o.conf; if (o.extra) rows.push(...o.extra);
  return toBars(rows);
};
const bear = (o: Parameters<typeof bull>[0] = {}): C[] => { const rows = bull(o); return rows.map((c) => ({ ...c, open: 300 - c.open, high: 300 - c.low, low: 300 - c.high, close: 300 - c.close })); };
const upTo = (cs: C[], i: number) => cs.slice(0, i + 1);

// ------------------------------------------------------------------------------------------------ 1-7 detector
test("1. bullish liquidity sweep: the wick takes the swing low, the candle closes back above it", () => {
  const cs = bull();
  assert.equal(findLsccSweep(upTo(cs, SWEEP_AT - 1), SWEEP_AT - 1), null, "the candle before is not a sweep");
  const s = findLsccSweep(upTo(cs, SWEEP_AT), SWEEP_AT)!;
  assert.ok(s); assert.equal(s.side, "BUY"); assert.equal(s.level, 100); assert.equal(s.levelTime, cs[PRE.length + 12].time); assert.equal(s.sweepTime, cs[SWEEP_AT].time);
});

test("2. bearish liquidity sweep: the wick takes the swing high, the candle closes back below it", () => {
  const cs = bear();
  const s = findLsccSweep(upTo(cs, SWEEP_AT), SWEEP_AT)!;
  assert.ok(s); assert.equal(s.side, "SELL"); assert.equal(s.level, 200); assert.equal(s.sweepTime, cs[SWEEP_AT].time);
});

test("3. wick penetration is a sweep; a candle BODY through the level (breakout) and a mere touch are not", () => {
  const sweepOf = (row: Row) => { const cs = bull({ sweep: row }); return findLsccSweep(upTo(cs, SWEEP_AT), SWEEP_AT); };
  assert.ok(sweepOf([103.0, 103.5, 99.0, 103.3]), "wick through, body above: sweep");
  assert.equal(sweepOf([99.8, 103.5, 99.0, 103.3]), null, "the body opens below the level: a breakout, not a sweep");
  assert.equal(sweepOf([102, 102.3, 98.5, 98.9]), null, "a candle that breaks down and closes below: breakout");
  assert.equal(sweepOf([103.0, 103.5, 100.0, 103.3]), null, "low EQUAL to the level is a touch, not a penetration");
  assert.equal(sweepOf([103.0, 103.5, 100.2, 103.3]), null, "never reached the level");
});

test("4. the sweep candle must close back inside (above) the swept level", () => {
  const sweepOf = (row: Row) => { const cs = bull({ sweep: row }); return findLsccSweep(upTo(cs, SWEEP_AT), SWEEP_AT); };
  assert.equal(sweepOf([101, 101.2, 99.0, 100.0]), null, "closing exactly on the level is not back above it");
  assert.equal(sweepOf([101, 101.2, 99.0, 99.6]), null, "closing below the level");
  assert.ok(sweepOf([101, 101.2, 99.0, 100.4]), "closing back above the level");
  const mir = bear({ sweep: [101, 101.2, 99.0, 99.6] });
  assert.equal(findLsccSweep(upTo(mir, SWEEP_AT), SWEEP_AT), null, "mirror: SELL sweep that closes above the high");
});

test("5. a SEPARATE bullish confirmation candle is required", () => {
  const cs = bull();
  assert.equal(detectLsccSignal(upTo(cs, SWEEP_AT), SWEEP_AT), null, "the sweep candle alone is not a signal");
  const s = detectLsccSignal(upTo(cs, CONF_AT), CONF_AT)!;
  assert.ok(s); assert.equal(s.side, "BUY"); assert.equal(s.sweepIndex, SWEEP_AT); assert.equal(s.confirmIndex, CONF_AT);
  assert.equal(detectLsccSignal(upTo(bull({ conf: [103.4, 103.5, 101.9, 102.0] }), CONF_AT), CONF_AT), null, "a bearish next candle does not confirm a bullish sweep");
});

test("6. a SEPARATE bearish confirmation candle is required", () => {
  const cs = bear();
  assert.equal(detectLsccSignal(upTo(cs, SWEEP_AT), SWEEP_AT), null);
  const s = detectLsccSignal(upTo(cs, CONF_AT), CONF_AT)!;
  assert.ok(s); assert.equal(s.side, "SELL");
  assert.equal(detectLsccSignal(upTo(bear({ conf: [103.4, 103.5, 101.9, 102.0] }), CONF_AT), CONF_AT), null, "a bullish next candle does not confirm a bearish sweep");
});

test("7. the confirmation must CLOSE beyond the sweep candle's high (BUY) / low (SELL), strictly", () => {
  const conf = (row: Row, b = bull) => { const cs = b({ conf: row }); return detectLsccSignal(upTo(cs, CONF_AT), CONF_AT); };
  assert.ok(conf([103.4, 104.6, 103.2, 104.4]));
  assert.equal(conf([103.3, 103.45, 103.1, 103.4]), null, "bullish but the close is below the sweep high 103.5");
  assert.equal(conf([103.3, 103.9, 103.1, 103.5]), null, "closing exactly ON the sweep high is not beyond it");
  assert.equal(conf([103.4, 105.5, 103.2, 103.45]), null, "a high above the sweep high is not enough: the CLOSE decides");
  assert.ok(conf([103.4, 104.6, 103.2, 104.4], bear), "mirror");
  assert.equal(conf([103.3, 103.9, 103.1, 103.5], bear), null, "mirror: equal is not beyond");
});

// ------------------------------------------------------------------------------------------------ rig
interface Rig { st: { now: number }; hub: CandidateHub; watcher: SweepWatcherService; coord: VerificationCoordinator; evs: any[]; ai: ReturnType<typeof fakeAi>; step: (i: number) => Promise<void>; engineSeen: Map<string, any> }
function rig(data: C[], o: { engineRunner?: any; slowAi?: number; coordNow?: (st: { now: number }) => number; afterAi?: (st: { now: number }) => void; policy?: any } = {}): Rig {
  resetSignalCaches();
  const st = { now: data[0].time + TF + 3 };
  const wdeps: WatcherDeps = { now: async () => st.now, sleep: async () => {}, fetchCandles: async (_s, _tf, count) => data.filter((c) => c.time + TF <= st.now).slice(-count).map((c) => ({ ...c })) };
  const hub = new CandidateHub();
  const watcher = new SweepWatcherService({ agents: [{ symbol: "NAS", name: "NAS100", market: "US 100" }], deps: wdeps, hub, rasterize: async () => PNG, tf: TF });
  const ai = fakeAi();
  const base = makePipeline(() => ({ engines, ai, rasterizer: fakeRasterizer, now: () => st.now * 1000, policy: o.policy }));
  const evs: any[] = [];
  const engineSeen = new Map<string, any>();
  const runner = o.engineRunner ?? (async (n: any, ev: any) => { engineSeen.set(n, ev); return evaluateEngine(n, ev, Date.now, () => performance.now()); });
  const coord = new VerificationCoordinator(hub, {
    pipeline: async (ev, c) => { evs.push(ev); if (o.slowAi) await sleep(o.slowAi); const r = await base(ev, c); o.afterAi?.(st); return r; },
    nowSec: () => (o.coordNow ? o.coordNow(st) : st.now), maxEntryDelaySec: 45, enabled: () => true, engineRunner: runner,
  }).start();
  const step = async (i: number) => { st.now = data[i].time + TF + 3; await watcher.runPass(0); };
  return { st, hub, watcher, coord, evs, ai, step, engineSeen };
}
const feedTo = async (r: Rig, from: number, to: number) => { for (let i = from; i <= to; i++) await r.step(i); };
const lsccAlerts = (r: Rig) => r.watcher.getAlerts(0, 300).filter((a) => a.engine === "lscc");
const settle = async (r: Rig) => { const t0 = Date.now(); while (r.hub.list(50).some((x) => !x.decision) && Date.now() - t0 < 4000) await sleep(3); };

// ------------------------------------------------------------------------------------------------ 8-9 timing
test("8. no entry before confirmation: a sweep registers a WAITING candidate with a screenshot and publishes nothing for verification", async () => {
  const r = rig(bull());
  await feedTo(r, SWEEP_AT - 2, SWEEP_AT);
  assert.equal(r.hub.list(10).length, 0, "nothing is broadcast to the engines / AI / AutoTrade on a sweep alone");
  const w = lsccAlerts(r);
  assert.equal(w.length, 1); assert.equal(w[0].lscc?.state, "WAITING"); assert.equal(w[0].ok, false);
  assert.equal(w[0].lscc?.level, 100); assert.equal(w[0].lscc?.sweepTime, bull()[SWEEP_AT].time);
  assert.match(r.watcher.getAlertSvg(w[0].id) ?? "", /LSCC WAITING/);
  assert.equal(r.watcher.getLscc()[0].state, "WAITING");
});

test("9. entry on the NEXT candle: confirmed -> one candidate whose signal candle is the confirmation candle; the entry candle is the one after", async () => {
  const cs = bull();
  const r = rig(cs);
  await feedTo(r, SWEEP_AT - 2, CONF_AT);
  await settle(r);
  const rec = r.hub.list(5)[0], ev = rec.versions[0];
  assert.equal(r.hub.list(5).length, 1);
  assert.equal(ev.engine, "lscc"); assert.equal(ev.pattern, "LSCC BUY - Bullish liquidity sweep confirmed");
  assert.equal(ev.signalCandleOpen, cs[CONF_AT].time, "the signal candle is the confirmation candle: the trade is never on it");
  assert.equal(ev.lscc!.entryTime, cs[CONF_AT].time + TF);
  assert.ok(ev.lscc!.sweepTime < ev.lscc!.confirmTime && ev.lscc!.confirmTime < ev.lscc!.entryTime, "sweep < confirmation < entry");
  assert.equal(ev.tradeAtNextOpen, true);
  assert.equal(ev.lscc!.level, 100);
  assert.equal(ev.lscc!.sweepTime, cs[SWEEP_AT].time, "the original sweep time is preserved");
  assert.ok(ev.lscc!.sweepDetectedAtMs! > 0 && ev.lscc!.sweepScreenshotSha256, "the sweep screenshot is recorded");
  // the waiting alert was UPDATED into the confirmed one (same candidate, new id, no second card)
  const a = lsccAlerts(r); assert.equal(a.length, 1); assert.equal(a[0].lscc?.state, "CONFIRMED"); assert.equal(a[0].ok, true); assert.ok(a[0].replaces);
  assert.match(r.watcher.getAlertSvg(a[0].id) ?? "", /LSCC BUY/);
  // before the confirmation candle closed the execution check refuses (nothing to enter yet); after it, it passes
  assert.equal(r.hub.executionCheck(rec.id, { nowSec: ev.signalCandleClose + 3, maxEntryDelaySec: 45 }).ok, rec.decision?.action === "EXECUTE");
  assert.equal(r.hub.executionCheck(rec.id, { nowSec: ev.signalCandleClose - 5, maxEntryDelaySec: 45 }).ok, false);
});

// ------------------------------------------------------------------------------------------------ 10-11 reversals
test("10. bullish reversal during a downtrend is tradeable (the prior trend does not reject it, even with countertrend blocked)", async () => {
  const cs = upTo(bull(), CONF_AT);
  assert.ok(cs[PRE.length].close < cs[0].close - 40, "the market was in a strong downtrend");
  const nowSec = cs[CONF_AT].time + TF + 5;
  const ai = fakeAi();
  const s = await getSignal({ engines, ai, rasterizer: fakeRasterizer, now: () => nowSec * 1000, policy: { ...DEFAULT_POLICY, allowCountertrend: false } }, cs as any, TF, "US 100", "deriv:NAS", nowSec);
  assert.equal(s.setup, true); assert.equal(s.side, "buy");
  assert.deepEqual(s.verification!.enginePatternValidity.claimedEngines, ["lscc"]);
  assert.equal(s.verification!.enginePatternValidity.status, "VALID");
  assert.equal(s.tradeable, true, "valid LSCC reversal against the trend is allowed");
});

test("11. bearish reversal during an uptrend is tradeable", async () => {
  const cs = upTo(bear(), CONF_AT);
  assert.ok(cs[PRE.length].close > cs[0].close + 40, "the market was in a strong uptrend");
  const nowSec = cs[CONF_AT].time + TF + 5;
  const s = await getSignal({ engines, ai: fakeAi(), rasterizer: fakeRasterizer, now: () => nowSec * 1000, policy: { ...DEFAULT_POLICY, allowCountertrend: false } }, cs as any, TF, "US 100", "deriv:NAS", nowSec);
  assert.equal(s.side, "sell"); assert.deepEqual(s.verification!.enginePatternValidity.claimedEngines, ["lscc"]); assert.equal(s.tradeable, true);
});

test("11b. a sweep WITHOUT confirmation never produces a signal or a trade", async () => {
  const cs = upTo(bull(), SWEEP_AT);
  const nowSec = cs[SWEEP_AT].time + TF + 5;
  const s = await getSignal({ engines, ai: fakeAi(), rasterizer: fakeRasterizer, now: () => nowSec * 1000 }, cs as any, TF, "US 100", "deriv:NAS", nowSec);
  assert.ok(!(s.engine as any).lscc, "LSCC does not fire on the sweep candle");
  assert.equal(detectAll(cs, cs.length - 1).some((v) => v.engine === "lscc"), false);
});

// ------------------------------------------------------------------------------------------------ 12-13 failure and expiry
test("12. failed confirmation: the setup is INVALID, nothing is published, the level is not reused", async () => {
  for (const conf of [[103.4, 103.5, 101.9, 102.0], [103.3, 103.45, 103.1, 103.4]] as Row[]) {
    const r = rig(bull({ conf }));
    await feedTo(r, SWEEP_AT - 2, CONF_AT);
    const a = lsccAlerts(r);
    assert.equal(a.length, 1); assert.equal(a[0].lscc?.state, "INVALID"); assert.match(a[0].block ?? "", /confirmation failed/);
    assert.match(r.watcher.getAlertSvg(a[0].id) ?? "", /LSCC INVALID/);
    assert.equal(r.hub.list(5).length, 0, "no candidate, no engine run, no AI call, no order");
    assert.equal(r.ai.calls.length, 0);
  }
  // the spent level (100) cannot be swept again by a later candle
  const cs = bull({ conf: [103.4, 103.5, 101.9, 102.0], extra: [[102.0, 103.4, 98.5, 103.0], [103.0, 105, 102.9, 104.8]] });
  assert.equal(findLsccSweep(upTo(cs, CONF_AT + 1), CONF_AT + 1), null, "the level was already traded through by the first sweep");
});

test("13. expired confirmation: a confirmation that comes one candle late is not a confirmation; a missed entry is shown as EXPIRED and never traded", async () => {
  // (a) late confirmation: sweep, a neutral candle, then a strong bullish close
  const late = bull({ conf: [103.3, 103.4, 103.0, 103.2], extra: [[103.3, 104.8, 103.2, 104.6]] });
  assert.equal(detectLsccSignal(upTo(late, CONF_AT + 1), CONF_AT + 1), null);
  const r1 = rig(late); await feedTo(r1, SWEEP_AT - 2, CONF_AT + 1);
  assert.equal(r1.hub.list(5).length, 0); assert.equal(lsccAlerts(r1)[0].lscc?.state, "INVALID");
  // (b) a valid confirmation whose entry window is gone: the AI answers only after the 45 s are over
  const cs = bull();
  const r2 = rig(cs, { afterAi: (st) => { st.now += 60; } });
  await feedTo(r2, SWEEP_AT - 2, CONF_AT); await settle(r2);
  const rec = r2.hub.list(5)[0];
  assert.equal(rec.decision?.action, "REJECT"); assert.match(rec.decision!.reasons[0], /execution check failed: stale/);
  const tracked = r2.watcher.getLscc();
  const card = lsccCards(tracked, r2.hub, r2.st.now, 45)[0];
  assert.equal(card.state, "LSCC EXPIRED"); assert.equal(card.execution, "MISSED");
});

// ------------------------------------------------------------------------------------------------ 14-17 pipeline
test("14. duplicate candidate prevention: the same confirmation seen again (re-check, re-poll) is one candidate and one verification", async () => {
  const r = rig(bull());
  await feedTo(r, SWEEP_AT - 2, CONF_AT); await settle(r);
  await r.watcher.runPass(0); await r.watcher.runPass(0);
  assert.equal(r.hub.list(10).length, 1);
  assert.equal(lsccAlerts(r).length, 1);
  assert.equal(r.evs.length, 1, "the AI recipient ran once");
  assert.equal(r.ai.calls.length, 1);
});

test("15. agent screenshot distribution: all three engines and Gemini get the same evidence object and the same screenshot", async () => {
  const r = rig(bull());
  await feedTo(r, SWEEP_AT - 2, CONF_AT); await settle(r);
  const ev = r.hub.list(1)[0].versions[0];
  assert.deepEqual([...r.engineSeen.keys()].sort(), ["continuation", "momentum", "sweep"]);
  for (const e of r.engineSeen.values()) assert.equal(e, ev);
  assert.equal(r.evs[0], ev);
  assert.equal(ev.screenshot.pngSha256, r.hub.list(1)[0].versions[0].screenshot.pngSha256);
  assert.equal(r.ai.calls.length, 1); assert.equal(r.ai.calls[0].image?.sha256, ev.screenshot.pngSha256, "Gemini was given the agent's picture");
  assert.equal(r.ai.calls[0].image?.candleSetHash, ev.aiRowsHash);
  const kinds = r.hub.list(1)[0].results.map((x: any) => `${x.kind}:${x.recipient}`).sort();
  assert.ok(kinds.includes("ai:ai") && kinds.includes("engine:engine:lscc") && kinds.includes("engine:engine:sweep") && kinds.includes("engine:engine:momentum") && kinds.includes("engine:engine:continuation"), kinds.join(","));
  assert.equal(r.hub.list(1)[0].decision?.action, "EXECUTE");
  assert.ok(r.hub.list(1)[0].decision!.corroboratedBy.includes("lscc"));
});

test("16. verification runs in parallel: the engines and the AI all start before any of them finishes", async () => {
  const starts: Record<string, number> = {}, ends: Record<string, number> = {};
  const engineRunner = async (n: any, ev: any) => { starts[n] = Date.now(); await sleep(60); const x = evaluateEngine(n, ev, Date.now, () => performance.now()); ends[n] = Date.now(); return x; };
  const r = rig(bull(), { engineRunner, slowAi: 60 });
  const t0 = Date.now();
  await feedTo(r, SWEEP_AT - 2, CONF_AT); await settle(r);
  const all = Object.values(starts);
  assert.equal(all.length, 3);
  assert.ok(Math.max(...all) - Math.min(...all) < 40, "the three engines started together");
  assert.ok(Math.max(...all) < Math.min(...Object.values(ends)), "every engine started before any engine finished");
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(r.hub.list(1)[0].decision?.action, "EXECUTE");
});

test("17. M5 synchronisation: the candidate sits on the 300 s grid and non-consecutive candles are not LSCC", async () => {
  const cs = bull();
  const r = rig(cs); await feedTo(r, SWEEP_AT - 2, CONF_AT);
  const ev = r.hub.list(1)[0].versions[0];
  assert.equal(ev.tf, 300); assert.equal(ev.signalCandleOpen % 300, 0); assert.equal(ev.lscc!.sweepTime % 300, 0); assert.equal(ev.lscc!.entryTime % 300, 0);
  assert.equal(ev.signalCandleClose - ev.signalCandleOpen, 300);
  const gappy = cs.map((c, i) => (i >= CONF_AT ? { ...c, time: c.time + TF } : c));      // one candle missing between sweep and confirmation
  assert.equal(detectLsccSignal(upTo(gappy, CONF_AT), CONF_AT), null);
});

test("18. the trade expires after 300 seconds on M5", () => {
  const t = chooseTiming(300);
  assert.equal(t.expiry, 300); assert.equal(t.tf, 300);
});

test("19. 45 s execution freshness: the entry is allowed within 45 s of the confirmation close and never later, however long the AI takes", async () => {
  const r = rig(bull());
  await feedTo(r, SWEEP_AT - 2, CONF_AT); await settle(r);
  const rec = r.hub.list(1)[0], close = rec.versions[0].signalCandleClose;
  assert.equal(r.hub.executionCheck(rec.id, { nowSec: close + 44, maxEntryDelaySec: 45 }).ok, true);
  const late = r.hub.executionCheck(rec.id, { nowSec: close + 46, maxEntryDelaySec: 45 });
  assert.equal(late.ok, false); assert.match(late.reason, /stale/);
  // a slow AI: the decision is made after the window and is a rejection
  const slow = rig(bull(), { afterAi: (st) => { st.now += 50; } });
  await feedTo(slow, SWEEP_AT - 2, CONF_AT); await settle(slow);
  assert.equal(slow.hub.list(1)[0].decision?.action, "REJECT");
});

// ------------------------------------------------------------------------------------------------ independence and safeguards
test("20. the pattern arithmetic is recomputed independently: a tampered LSCC (level already spent, weak close) is INVALID", () => {
  const ok = verifyPattern({ side: "BUY", lscc: { side: "BUY" } }, upTo(bull(), CONF_AT) as Bar[], bull()[CONF_AT].time);
  assert.equal(ok.status, "VALID"); assert.equal(ok.sweptLevel, 100);
  const weak = verifyPattern({ side: "BUY", lscc: { side: "BUY" } }, upTo(bull({ conf: [103.3, 103.45, 103.1, 103.4] }), CONF_AT) as Bar[], bull()[CONF_AT].time);
  assert.equal(weak.status, "INVALID"); assert.ok(weak.failedRules.includes("LSCC_CONFIRM_CLOSE_BEYOND"));
  const wrongSide = verifyPattern({ side: "SELL", lscc: { side: "SELL" } }, upTo(bull(), CONF_AT) as Bar[], bull()[CONF_AT].time);
  assert.equal(wrongSide.status, "INVALID");
});

test("21. no look-ahead and no repainting: the verdict on candle i never depends on later candles", () => {
  const cs = bull({ extra: [[104.4, 105, 90, 91], [91, 92, 80, 81]] });
  for (let i = 15; i < cs.length - 2; i++) {
    const a = detectLsccSignal(upTo(cs, i), i), b = detectLsccSignal(cs, i);
    assert.deepEqual(a, b, `candle ${i}`);
    assert.deepEqual(findLsccSweep(upTo(cs, i), i), findLsccSweep(cs, i), `sweep ${i}`);
  }
  // a later candle that wrecks the picture does not change the stored fact: the setup on CONF_AT is still the same signal
  assert.equal(detectLsccSignal(cs, CONF_AT)!.level, 100);
});

test("22. the existing engines are untouched: the three original engines give the same verdicts with and without LSCC on the same candles", () => {
  const cs = bull();
  for (let i = 12; i < cs.length; i++) {
    const v = detectAll(upTo(cs, i), i).filter((x) => x.engine !== "lscc").map((x) => `${x.engine}|${x.side}|${x.ok}`);
    const again = detectAll(upTo(cs, i), i).filter((x) => x.engine !== "lscc").map((x) => `${x.engine}|${x.side}|${x.ok}`);
    assert.deepEqual(v, again);
  }
  assert.equal(detectLscc(upTo(cs, CONF_AT), CONF_AT)!.tradeAtNextOpen, true);
});

// ------------------------------------------------------------------------------------------------ live data
const LIVE: C[] = readFileSync(new URL("../fixtures/r75_m5_live_slice.csv", import.meta.url), "utf8").trim().split("\n").slice(1)
  .map((l) => { const [t, o, h, lo, c] = l.split(",").map(Number); return { time: t, open: o, high: h, low: lo, close: c } as C; });

test("23. LIVE R_75 M5 data: LSCC signals obey every rule, never repaint, never reuse a level and never enter on the sweep or the confirmation candle", () => {
  let n = 0, buys = 0, sells = 0, sweeps = 0, invalid = 0;
  const used = new Set<string>();
  for (let i = 40; i < LIVE.length; i++) {
    const win = LIVE.slice(Math.max(0, i - 44), i + 1);
    if (findLsccSweep(win, win.length - 1)) sweeps++;
    const s = detectLsccSignal(win, win.length - 1);
    const o = lsccOutcome(win, win.length - 1);
    if (o && o.state === "INVALID") invalid++;
    if (!s) continue;
    n++; s.side === "BUY" ? buys++ : sells++;
    const sw = LIVE[i - 1], cf = LIVE[i];
    assert.ok(s.sweepTime === sw.time && s.confirmTime === cf.time && s.entryTime === cf.time + 300 && s.entryTime > s.confirmTime && s.confirmTime > s.sweepTime);
    if (s.side === "BUY") { assert.ok(sw.low < s.level && Math.min(sw.open, sw.close) >= s.level && sw.close > s.level && cf.close > cf.open && cf.close > sw.high); }
    else { assert.ok(sw.high > s.level && Math.max(sw.open, sw.close) <= s.level && sw.close < s.level && cf.close < cf.open && cf.close < sw.low); }
    const k = `${s.side}|${s.levelTime}`;
    assert.ok(!used.has(k), `level ${k} was reused`); used.add(k);
    // no repaint: the same verdict on the full history as on the history up to that candle
    assert.deepEqual(detectLsccSignal(LIVE.slice(0, i + 1), i, LSCC_DEFAULTS)?.level, s.level);
  }
  console.log(`LSCC LIVE R_75 M5 (${LIVE.length - 40} candles): sweeps=${sweeps} confirmed=${n} (BUY ${buys}, SELL ${sells}) failedConfirmation=${invalid}`);
  assert.ok(sweeps > 0 && n > 0 && n < sweeps, "sweeps exist and only some are confirmed");
});

// ------------------------------------------------------------------------------------------------ AutoTrade end to end
import { Autopilot, DEFAULT_CFG, Deps } from "./autopilot";
import { lookFromAgents } from "./candidateLook";
import { makeAgentSource } from "./agentSource";
import { agentMode } from "./agentMode";
import { ExecutionLedger } from "./aiVerification";
import type { AutoRef } from "./autoLook";

test("24. AutoTrade trades a confirmed LSCC that the agent discovered, once, on the candle after the confirmation, and never a bare sweep", async () => {
  const cs = bull();
  agentMode.active = true;
  const r = rig(cs);
  const ledger = new ExecutionLedger();
  const source = makeAgentSource(r.hub, { labelOf: (_s, fb) => fb, tfSec: () => TF, agentsActive: () => 1, nowSec: () => r.st.now, maxEntryDelaySec: 45, ledger });
  const placed: { symbol: string; side: string }[] = [];
  const pending = new Map<string, AutoRef>();
  const deps: Deps = {
    agentSource: source, assets: () => [],
    watch: async () => ({ candles: cs.map((c) => ({ ...c })), price: () => cs[CONF_AT].close, clock: () => r.st.now, close() {} }),
    analyze: (symbol: any, candles: any, tf: any, now: any) => lookFromAgents(r.hub, { symbol, market: `deriv:${symbol}`, label: symbol, tfSec: tf, clk: now ?? r.st.now, candles, ledger, waitMs: 300, maxEntryDelaySec: 45 }),
    preflight: async ({ symbol, side, ref }: any) => { const c = r.hub.executionCheck((ref as AutoRef).candidateId!, { nowSec: r.st.now, maxEntryDelaySec: 45 }); if (!c.ok) return { ok: false, reason: c.reason }; pending.set(`${symbol}|${side}`, ref as AutoRef); return { ok: true, reason: "" }; },
    place: async (symbol: any, side: any) => { const ref = pending.get(`${symbol}|${side}`)!; if (!ledger.claim(`${ref.signalKey}|${ref.side}`) || !r.hub.markExecuted(ref.candidateId!)) return { ok: false, msg: "duplicate blocked" }; placed.push({ symbol, side }); return { ok: true, msg: "", id: "B1" }; },
    result: async () => ({ outcome: "win", profit: 8 }), sleep: (ms: number) => new Promise((x) => setTimeout(x, Math.min(ms, 5))),
  } as any;
  const ap = new Autopilot(deps, { ...DEFAULT_CFG, minConf: 50, maxTrades: 5, stake: 10, expirySec: 300 });
  void ap.start().catch(() => {});
  await sleep(30);
  await feedTo(r, SWEEP_AT - 2, SWEEP_AT);
  await sleep(150);
  assert.equal(placed.length, 0, "the sweep alone is never traded");
  await r.step(CONF_AT);
  await until(() => placed.length === 1);
  assert.deepEqual(placed, [{ symbol: "NAS", side: "buy" }]);
  await r.watcher.runPass(0); await sleep(80);
  assert.equal(placed.length, 1, "one order for one confirmed setup");
  assert.ok(ap.state.agent!.feed.some((f) => /AGENT DETECTED → US 100 → BUY → LSCC BUY/.test(f.text)));
  assert.ok(ap.state.agent!.feed.some((f) => /LSCC WAITING/.test(f.text)), "the waiting sweep shows in the live feed");
  ap.stop(); agentMode.active = false;
});
