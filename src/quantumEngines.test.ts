import test from "node:test";
import assert from "node:assert/strict";
import { Candle } from "./candleMath";
import { classifySequence, SEQUENCE_DEFAULTS } from "./sequenceClassifier";
import { fourthCandleStats } from "./sequenceStats";
import { StructureTracker, structureSeries } from "./structureEngine";
import { SweepTracker } from "./sweepIntelligence";
import { evaluateExhaustion, EXHAUSTION_DEFAULTS } from "./exhaustionEngine";
import { ContinuationConfirmer } from "./continuationConfirmation";
import { QuantumPipeline, pipelineSeries, quantumParams, QUANTUM_DEFAULTS, Decision } from "./quantumPipeline";
import { synthCandles } from "./syntheticData";
import { detectContinuation, detectMomentum } from "./sweepEngines";

const TF = 300, T0 = 1_762_300_200;
const at = (i: number, o: number, h: number, l: number, c: number): Candle => ({ time: T0 + i * TF, open: o, high: h, low: l, close: c });
/** closes -> candles chained open = previous close; local extremes get a longer wick so swing points are strict */
const series = (closes: number[], wick = 0.2): Candle[] => {
  let prev = closes[0] - 0.5;
  return closes.map((c, i) => {
    const o = prev; prev = c;
    const up = i > 0 && i < closes.length - 1 && c > closes[i - 1] && c > closes[i + 1];
    const dn = i > 0 && i < closes.length - 1 && c < closes[i - 1] && c < closes[i + 1];
    return at(i, o, Math.max(o, c) + wick + (up ? 0.5 : 0), Math.min(o, c) - wick - (dn ? 0.5 : 0), c);
  });
};
/** a clean uptrend (HH + HL) that is BULLISH from candle 12 on, last candle index 19 */
const UP = series([100, 102, 104, 106, 104, 102, 104, 106, 108, 106, 104, 106, 108, 110, 108, 106, 108, 110, 112, 110]);
const run = (tail: Candle[], o: Parameters<typeof quantumParams>[0] = {}, head: Candle[] = UP) => {
  const p = new QuantumPipeline(quantumParams({ minHistory: 10, ...o }));
  return [...head, ...tail].map((c) => p.step(c));
};
const A_TAIL = [at(20, 110, 110.3, 108.0, 108.5), at(21, 108.6, 110.0, 107.5, 109.6), at(22, 109.6, 111, 109.5, 110.8), at(23, 110.8, 112.5, 110.7, 112.4)];
const B_TAIL = [at(20, 110, 112, 109.9, 111.8), at(21, 111.9, 113.5, 109.5, 110.5), at(22, 110.5, 110.6, 107.9, 108), at(23, 108, 108.1, 105.9, 106), at(24, 106, 106.1, 103.9, 104), at(25, 104, 104.1, 101.9, 102)];
const key = (d: Decision) => JSON.stringify([d.index, d.action, d.kind, d.state, d.trend, d.reason, d.sweepCount, d.recentSweeps, d.alignment, d.exhaustion?.state]);

// ================================================================================================ ENGINE 7
const bull = (i: number, o: number, body: number, wick = 0.1) => at(i, o, o + body + wick, o - wick, o + body);
const bear = (i: number, o: number, body: number, wick = 0.1) => at(i, o, o + wick, o - body - wick, o - body);

test("Engine 7: three strong same-direction candles are THREE_STRONG, a continuation candidate", () => {
  const cs = [bull(0, 100, 4), bull(1, 104, 4), bull(2, 108, 4)];
  const r = classifySequence(cs, 2)!;
  assert.equal(r.classification, "THREE_STRONG"); assert.equal(r.direction, "BULL");
  assert.deepEqual(r.hypothesis, { kind: "CONTINUATION", side: "BUY" });
  const s = classifySequence([bear(0, 100, 4), bear(1, 96, 4), bear(2, 92, 4)], 2)!;
  assert.equal(s.classification, "THREE_STRONG"); assert.deepEqual(s.hypothesis, { kind: "CONTINUATION", side: "SELL" });
});

test("Engine 7: weak then two strong is WEAK_STRONG_STRONG, an exhaustion/reversal CANDIDATE (opposite side), not a prediction", () => {
  const cs = [at(0, 100, 102, 99, 100.9), bull(1, 100.9, 3), bull(2, 104, 3)];       // first body/range 0.3
  const r = classifySequence(cs, 2)!;
  assert.equal(r.classification, "WEAK_STRONG_STRONG");
  assert.deepEqual(r.hypothesis, { kind: "EXHAUSTION_REVERSAL", side: "SELL" });
  assert.ok(r.reasons.join(" ").includes("weak"));
});

test("Engine 7: every other same-direction run is MIXED_STRENGTH and gets NO side", () => {
  const strongWeakStrong = [bull(0, 100, 3), at(1, 103, 105, 102, 103.8), bull(2, 103.8, 3)];
  const r = classifySequence(strongWeakStrong, 2)!;
  assert.equal(r.classification, "MIXED_STRENGTH"); assert.deepEqual(r.hypothesis, { kind: null, side: null });
  // strong, strong, weak
  assert.equal(classifySequence([bull(0, 100, 3), bull(1, 103, 3), at(2, 106, 108, 105, 106.9)], 2)!.classification, "MIXED_STRENGTH");
  // first candle neither strong nor weak (body/range 0.6)
  assert.equal(classifySequence([at(0, 100, 101.6, 99.9, 101.0), bull(1, 101, 3), bull(2, 104, 3)], 2)!.classification, "MIXED_STRENGTH");
});

test("Engine 7: three strong candles with big combined wicks are NOT forced into THREE_STRONG", () => {
  // body/range 0.667 each (strong) but combined wick ratio 0.333 > 0.30
  const c = (i: number, o: number) => at(i, o, o + 2.5, o - 0.5, o + 2);
  const r = classifySequence([c(0, 100), c(1, 102), c(2, 104)], 2)!;
  assert.equal(r.classification, "MIXED_STRENGTH");
  assert.equal(classifySequence([c(0, 100), c(1, 102), c(2, 104)], 2, { ...SEQUENCE_DEFAULTS, maxCombinedWickRatio: 0.4 })!.classification, "THREE_STRONG");   // configurable
});

test("Engine 7: not three same-direction closed, contiguous candles -> null", () => {
  assert.equal(classifySequence([bull(0, 100, 4), bear(1, 104, 4), bull(2, 100, 4)], 2), null);
  assert.equal(classifySequence([bull(0, 100, 4), at(1, 104, 105, 103, 104), bull(2, 104, 4)], 2), null);           // doji
  assert.equal(classifySequence([bull(0, 100, 4), bull(1, 104, 4), { ...bull(2, 108, 4), closed: false }], 2), null);
  assert.equal(classifySequence([bull(0, 100, 4), bull(1, 104, 4), { ...bull(3, 108, 4), time: T0 + 4 * TF }], 2), null);    // a candle is missing
  assert.equal(classifySequence([bull(0, 100, 4), bull(1, 104, 4)], 1), null);
});

test("Engine 7: reads candles <= i only", () => {
  const cs = [bull(0, 100, 4), bull(1, 104, 4), bull(2, 108, 4), bear(3, 112, 9)];
  assert.deepEqual(classifySequence(cs, 2), classifySequence(cs.slice(0, 3), 2));
});

test("Engine 7: fourth-candle statistics count continuation and reversal separately for every class", () => {
  // 20 blocks of: 3 strong bull + a bearish 4th candle, then 5 blocks with a bullish 4th candle
  const cs: Candle[] = []; let i = 0, p = 100;
  const push = (c: (i: number, o: number, b: number) => Candle, body: number) => { const k = c(i++, p, body); cs.push(k); p = k.close; };
  const doji = () => { const k = at(i++, p, p + 1, p - 1, p); cs.push(k); };
  const weakBull = () => { const k = at(i++, p, p + 1, p - 1, p + 0.3); cs.push(k); p = k.close; };   // a bullish 4th candle with a tiny body
  for (let b = 0; b < 25; b++) { for (let k = 0; k < 3; k++) push(bull, 4); if (b < 20) push(bear, 6); else weakBull(); doji(); }
  const r = fourthCandleStats([{ symbol: "S", candles: cs }]);
  assert.equal(r.byClass.THREE_STRONG.n, 25);
  assert.equal(r.byClass.THREE_STRONG.reversed, 20); assert.equal(r.byClass.THREE_STRONG.continued, 5);
  assert.equal(r.byClass.THREE_STRONG.verdict, "reverses more than 50%");
  assert.equal(r.byClass.WEAK_STRONG_STRONG.n, 0); assert.equal(r.byClass.WEAK_STRONG_STRONG.verdict, "n/a");
  assert.ok(r.byClass.ANY_THREE_SAME_COLOUR.n >= 25);
});

// ================================================================================================ ENGINE 8
test("Engine 8: swing points are confirmed pivotRight candles later and never earlier", () => {
  const t = new StructureTracker();
  const seen: Array<{ at: number; kind: string; index: number; confirmedAt: number }> = [];
  UP.forEach((c, i) => { for (const p of t.update(c).newPivots) seen.push({ at: i, kind: p.kind, index: p.index, confirmedAt: p.confirmedAt }); });
  assert.ok(seen.length >= 6);
  for (const s of seen) { assert.equal(s.confirmedAt, s.index + 2); assert.equal(s.at, s.confirmedAt); }
  assert.deepEqual(seen.slice(0, 2).map((s) => [s.kind, s.index]), [["HIGH", 3], ["LOW", 5]]);
});

test("Engine 8: higher highs + higher lows = BULLISH with HH/HL labels; before that NEUTRAL", () => {
  const snaps = structureSeries(UP);
  assert.equal(snaps[11].trend, "NEUTRAL");
  assert.equal(snaps[12].trend, "BULLISH"); assert.equal(snaps[12].trendSince, 12);
  assert.equal(snaps[19].trend, "BULLISH");
  assert.equal(snaps[19].lastHigh!.label, "HH"); assert.equal(snaps[19].lastLow!.label, "HL");
  assert.match(snaps[19].description, /Higher highs and higher lows/);
});

test("Engine 8: lower highs + lower lows = BEARISH", () => {
  const down = series([112, 110, 108, 106, 108, 110, 108, 106, 104, 106, 108, 106, 104, 102, 104, 106, 104, 102, 100, 102]);
  assert.equal(structureSeries(down).at(-1)!.trend, "BEARISH");
  assert.match(structureSeries(down).at(-1)!.description, /Lower highs and lower lows/);
});

test("Engine 8: break of structure = a CLOSE beyond the latest swing high in a bullish trend; the trend continues", () => {
  const snaps = structureSeries(UP);
  const bos = snaps.filter((s) => s.event?.type === "BOS");
  assert.ok(bos.length >= 2);
  for (const s of bos) { assert.equal(s.event!.direction, "BULL"); assert.ok(s.event!.refConfirmedAt < s.index); assert.equal(s.trend, "BULLISH"); }
  assert.equal(snaps[13].event!.type, "BOS");
});

test("Engine 8: market structure shift = a CLOSE below the protected swing low; a wick below it is not a shift", () => {
  const wickOnly = [...UP, at(20, 110, 110.1, 105.0, 109.5)];            // low 105.0 < protected low 105.3 but closes at 109.5
  assert.equal(structureSeries(wickOnly).at(-1)!.event, null); assert.equal(structureSeries(wickOnly).at(-1)!.trend, "BULLISH");
  const closed = [...UP, at(20, 110, 110.1, 104.0, 104.5)];              // closes below
  const s = structureSeries(closed).at(-1)!;
  assert.equal(s.event!.type, "MSS"); assert.equal(s.event!.direction, "BEAR"); assert.equal(s.event!.priorTrend, "BULLISH");
  assert.ok(s.event!.refConfirmedAt < s.index);
  assert.equal(s.trend, "NEUTRAL");                                   // not BEARISH until new swings confirm it
  assert.match(s.description, /shifted/);
});

test("Engine 8: after a shift the new trend needs pivots confirmed AFTER the shift", () => {
  const dn = [...UP, at(20, 110, 110.1, 104.0, 104.5), at(21, 104.5, 104.6, 101.5, 102), at(22, 102, 102.1, 99.0, 99.5), at(23, 99.5, 101.5, 99.4, 101), at(24, 101, 103.5, 100.9, 103), at(25, 103, 103.1, 100.5, 100.8), at(26, 100.8, 100.9, 98.0, 98.3), at(27, 98.3, 100.0, 98.2, 99.6), at(28, 99.6, 99.7, 97.0, 97.4), at(29, 97.4, 97.5, 95.0, 95.4), at(30, 95.4, 97, 95.3, 96.6), at(31, 96.6, 98, 96.5, 97.5)];
  const s = structureSeries(dn);
  assert.equal(s[20].trend, "NEUTRAL");
  const becameBear = s.findIndex((x, i) => i > 20 && x.trend === "BEARISH");
  assert.ok(becameBear > 24, `bearish confirmed at ${becameBear}`);
});

test("Engine 8: a lower high turns BULLISH into NEUTRAL, and a later close below the swing low still counts as the shift", () => {
  const cs = series([100, 102, 104, 106, 104, 102, 104, 106, 108, 106, 104, 106, 108, 110, 108, 106, 108, 110, 112, 110, 108, 110, 111, 110, 109.5, 109, 107, 105, 103, 101], 0.2);   // peak 112, then a LOWER high at 111, then a break down
  const s = structureSeries(cs);
  const neutralBefore = s.findIndex((x, i) => i > 19 && x.trend === "NEUTRAL" && !x.lastShift);
  const mss = s.findIndex((x) => x.event?.type === "MSS");
  assert.ok(mss > 0, "an MSS is produced");
  assert.equal(s[mss].event!.priorTrend, "BULLISH");
  assert.ok(neutralBefore > 0 && neutralBefore < mss, `neutral at ${neutralBefore} before MSS at ${mss}`);
  const off = structureSeries(cs, { mssFromNeutral: false });
  assert.ok(off.findIndex((x) => x.event?.type === "MSS") === -1 || off.findIndex((x) => x.event?.type === "MSS") >= mss);
});

test("Engine 8: sideways swings are NEUTRAL, never forced into a trend", () => {
  const range = series([100, 102, 104, 102, 100, 102, 104, 102, 100, 102, 104, 102, 100, 102, 104, 102, 100, 102, 104, 102]);
  assert.equal(structureSeries(range).at(-1)!.trend, "NEUTRAL");
  assert.equal(structureSeries(series([100, 101, 102])).at(-1)!.trend, "NEUTRAL");
});

test("Engine 8: NO LOOK-AHEAD. The snapshot at i is identical whether or not later candles exist (random data, many cut points)", () => {
  const cs = synthCandles({ n: 1500, seed: 11 });
  const full = structureSeries(cs);
  const sig = (s: (typeof full)[number]) => JSON.stringify([s.index, s.trend, s.trendSince, s.rememberedTrend, s.lastHigh, s.lastLow, s.prevHigh, s.prevLow, s.event, s.lastShift, s.recentChanges, s.newPivots]);
  for (const cut of [50, 211, 640, 1000, 1499]) {
    const part = structureSeries(cs.slice(0, cut + 1));
    assert.equal(sig(part[cut]), sig(full[cut]), `cut at ${cut}`);
  }
  // every reference swing was confirmed on an earlier candle than the break
  for (const s of full) if (s.event) assert.ok(s.event.refConfirmedAt < s.event.index);
});

test("Engine 8: the cached series is extended when candles are appended and rebuilt when the series changes", () => {
  const cs = synthCandles({ n: 300, seed: 5 });
  const live = cs.slice(0, 200);
  const a = structureSeries(live).length; live.push(...cs.slice(200, 260));
  const b = structureSeries(live);
  assert.equal(a, 200); assert.equal(b.length, 260);
  assert.equal(JSON.stringify(b.at(-1)), JSON.stringify(structureSeries(cs.slice(0, 260)).at(-1)));
  live[100] = { ...live[100], time: live[100].time + 1 }; live.length = 150;
  assert.equal(structureSeries(live).length, 150);
});

// ================================================================================================ ENGINE 9
const sweepHigh = (i: number, base: number) => [at(i, base, base + 2.1, base - 0.1, base + 2), at(i + 1, base + 2, base + 3, base + 0.5, base + 1.2)];   // P bullish, A bearish sweeping P.high, closing in P's body
const sweepLow = (i: number, base: number) => [at(i, base, base + 0.1, base - 2.1, base - 2), at(i + 1, base - 2, base - 0.5, base - 3, base - 1.2)];  // P bearish, A bullish sweeping P.low

test("Engine 9: records direction, level, timestamp, structure, alignment, counts for every sweep", () => {
  const t = new SweepTracker();
  const cs = [...sweepHigh(0, 100)];
  t.update(cs, 0, "BULLISH");
  const snap = t.update(cs, 1, "BULLISH");
  const e = snap.newSweep!;
  assert.equal(e.side, "SELL"); assert.equal(e.swept, "HIGH"); assert.equal(e.level, 102.1); assert.equal(e.extreme, 103);
  assert.equal(e.time, cs[1].time); assert.equal(e.index, 1);
  assert.equal(e.trendAtSweep, "BULLISH"); assert.equal(e.alignment, "COUNTERTREND");
  assert.equal(e.ordinal, 1); assert.equal(e.recentCount, 1); assert.equal(e.status, "MONITORING");
  const low = new SweepTracker(); const cl = sweepLow(0, 100); low.update(cl, 0, "BULLISH");
  const l = low.update(cl, 1, "BULLISH").newSweep!;
  assert.equal(l.side, "BUY"); assert.equal(l.swept, "LOW"); assert.equal(l.alignment, "WITH_TREND");
});

test("Engine 9: alignment table (with-trend / countertrend / no trend)", () => {
  const al = (mk: typeof sweepHigh, trend: "BULLISH" | "BEARISH" | "NEUTRAL") => { const t = new SweepTracker(); const cs = mk(0, 100); t.update(cs, 0, trend); return t.update(cs, 1, trend).newSweep!.alignment; };
  assert.equal(al(sweepHigh, "BEARISH"), "WITH_TREND"); assert.equal(al(sweepHigh, "BULLISH"), "COUNTERTREND");
  assert.equal(al(sweepLow, "BULLISH"), "WITH_TREND"); assert.equal(al(sweepLow, "BEARISH"), "COUNTERTREND");
  assert.equal(al(sweepHigh, "NEUTRAL"), "NO_TREND"); assert.equal(al(sweepLow, "NEUTRAL"), "NO_TREND");
});

test("Engine 9: repeated sweeps form a cluster (1st, 2nd, 3rd ...), a gap in time starts a new one; count is information only", () => {
  const cs: Candle[] = [...sweepHigh(0, 100), ...sweepHigh(2, 101), ...sweepHigh(4, 102)];           // sweeps at 1, 3, 5
  for (let k = 0; k < 20; k++) cs.push(at(6 + k, 103, 103.5, 102.5, 103.1 + (k % 2) * 0.1 - 0.05));       // quiet
  cs.push(...sweepHigh(26, 103));                                                                      // sweep at 27, far later
  const t = new SweepTracker({ clusterWindow: 6 });
  const events = cs.map((_, i) => t.update(cs, i, "BEARISH").newSweep).filter(Boolean);
  assert.deepEqual(events.map((e) => [e!.index, e!.ordinal]), [[1, 1], [3, 2], [5, 3], [27, 1]]);
  assert.equal(new Set(events.slice(0, 3).map((e) => e!.clusterId)).size, 1);
  assert.notEqual(events[3]!.clusterId, events[0]!.clusterId);
  assert.deepEqual(events.slice(0, 3).map((e) => e!.recentCount), [1, 2, 3]);
});

test("Engine 9: follow-up is judged only with candles up to now, and older snapshots never change", () => {
  const cs: Candle[] = [...sweepLow(0, 100)];                                  // BUY sweep at 1, extreme 97
  for (let k = 0; k < 8; k++) cs.push(at(2 + k, 98.8 + k * 0.5, 99.3 + k * 0.5, 98.6 + k * 0.5, 99.3 + k * 0.5));      // price rises: follow-through
  const t = new SweepTracker({ monitorCandles: 4 });
  const snaps = cs.map((_, i) => t.update(cs, i, "BULLISH"));
  assert.equal(snaps[1].newSweep!.status, "MONITORING");
  assert.equal(snaps[4].monitoring.length, 1);                                  // 3 candles after: still monitoring
  assert.equal(snaps[5].monitoring.length, 0);
  assert.equal(snaps[5].recent[0].status, "FOLLOWED_THROUGH"); assert.equal(snaps[5].recent[0].resolvedAt, 5);
  assert.equal(snaps[5].followedWithTrendRecent, 1);
  assert.equal(snaps[1].newSweep!.status, "MONITORING", "the event object handed out earlier is immutable");
  // failure: a close back through the sweep's own extreme
  const bad = [...sweepLow(0, 100), at(2, 98.8, 98.9, 95.9, 96)];
  const t2 = new SweepTracker(); bad.forEach((_, i) => t2.update(bad, i, "BULLISH"));
  const last = t2.update([...bad, at(3, 96, 96.2, 95, 95.5)], 3, "BULLISH");
  assert.equal(last.recent[0].status, "FAILED"); assert.equal(last.failedWithTrendRecent, 1);
});

test("Engine 9: unknown sweep source is refused; the wick source is available", () => {
  assert.throws(() => new SweepTracker({ sources: ["nope"] }), /unknown sweep source/);
  assert.doesNotThrow(() => new SweepTracker({ sources: ["pattern12", "wick"] }));
});

// ================================================================================================ ENGINE 10 + 11 + pipeline scenarios
test("Engine 11: a WITH-TREND sweep is a continuation candidate: sweep, B and C close with the trend, then BUY for the next candle", () => {
  const d = run(A_TAIL);
  assert.equal(d[21].sweep!.alignment, "WITH_TREND"); assert.equal(d[21].action, "NO_TRADE"); assert.equal(d[21].state, "SWEEP_DETECTED");
  assert.equal(d[22].state, "CONTINUATION_WATCH"); assert.equal(d[22].action, "NO_TRADE");
  assert.equal(d[23].action, "BUY"); assert.equal(d[23].kind, "WITH_TREND_CONTINUATION"); assert.equal(d[23].state, "CONFIRMED");
  assert.equal(d[23].signal!.sweepIndex, 21); assert.equal(d[23].signal!.trendContext, "BULLISH");
  assert.ok(d[23].reason.includes("with-trend sweep"));
  assert.equal(d.filter((x) => x.action !== "NO_TRADE").length, 1, "exactly one entry for the sequence");
});

test("Engine 11: it never calls a with-trend sweep a reversal, and the Engine 5 rule still decides (B bearish invalidates)", () => {
  const badB = [A_TAIL[0], A_TAIL[1], at(22, 109.6, 109.7, 108.4, 108.7), at(23, 108.7, 110, 108.6, 109.9)];
  const d = run(badB);
  assert.ok(d.every((x) => x.action === "NO_TRADE"));
  assert.ok(d[22].explanation.notes.some((n) => /B did not close bullish/.test(n)));
});

test("Engine 11: structure shifting against the trade rejects the sequence", () => {
  const cc = new ContinuationConfirmer();
  const cs = [...UP, ...A_TAIL];
  const stub = (trend: string, event: unknown = null) => ({ trend, event, index: 0 }) as any;
  const sw = (ns: unknown) => ({ newSweep: ns }) as any;
  const ex = { state: "HEALTHY_CONTINUATION", reason: "" } as any;
  const ev = { id: 1, alignment: "WITH_TREND", side: "BUY", ordinal: 1, reason: "r" } as any;
  cc.step(cs, 21, sw(ev), stub("BULLISH"), ex);
  const r = cc.step(cs, 22, sw(null), stub("NEUTRAL", { type: "MSS", direction: "BEAR" }), ex);
  assert.match(r.rejected[0].reason, /shifted against/);
  const c2 = new ContinuationConfirmer(); c2.step(cs, 21, sw(ev), stub("BULLISH"), ex); c2.step(cs, 22, sw(null), stub("BULLISH"), ex);
  const r2 = c2.step(cs, 23, sw(null), stub("NEUTRAL"), ex);
  assert.match(r2.rejected[0].reason, /structure is NEUTRAL/); assert.equal(r2.signal, null);
  const c3 = new ContinuationConfirmer(); c3.step(cs, 21, sw(ev), stub("BULLISH"), ex); c3.step(cs, 22, sw(null), stub("BULLISH"), ex);
  const r3 = c3.step(cs, 23, sw(null), stub("BULLISH"), { state: "POSSIBLE_EXHAUSTION", reason: "x" } as any);
  assert.match(r3.rejected[0].reason, /exhaustion/); assert.equal(r3.signal, null);
  const c4 = new ContinuationConfirmer({ blockOnExhaustion: false }); c4.step(cs, 21, sw(ev), stub("BULLISH"), ex); c4.step(cs, 22, sw(null), stub("BULLISH"), ex);
  assert.equal(c4.step(cs, 23, sw(null), stub("BULLISH"), { state: "POSSIBLE_EXHAUSTION", reason: "x" } as any).signal!.side, "BUY");
});

test("Engine 10: a COUNTERTREND sweep alone never trades; the SELL comes only on a close below the protected swing low", () => {
  const d = run(B_TAIL);
  assert.equal(d[21].sweep!.alignment, "COUNTERTREND"); assert.equal(d[21].action, "NO_TRADE"); assert.equal(d[21].state, "SWEEP_DETECTED");
  assert.equal(d[22].state, "REVERSAL_WATCH"); assert.equal(d[23].action, "NO_TRADE");
  assert.equal(d[24].action, "SELL"); assert.equal(d[24].kind, "CONFIRMED_REVERSAL");
  assert.equal(d[24].structure!.event!.type, "MSS");
  assert.ok(d[24].structure!.event!.refConfirmedAt < 24, "reference swing was confirmed before the break");
  assert.equal(d[24].signal!.trendContext, "BULLISH");
  assert.match(d[24].reason, /previous structure BULLISH/);
  assert.equal(d[25].action, "NO_TRADE", "one entry per structure shift");
  assert.equal(d.filter((x) => x.action !== "NO_TRADE").length, 1);
});

test("Engine 10: the watch expires, or is cancelled when price closes beyond the sweep extreme; later breaks then do not trade", () => {
  const expired = run(B_TAIL, { reversal: { maxCandlesToConfirm: 1 } });
  assert.ok(expired.every((x) => x.action === "NO_TRADE"));
  assert.ok(expired.some((x) => x.explanation.notes.some((n) => /no structure shift within 1 candles/.test(n))));
  const failed = [B_TAIL[0], B_TAIL[1], at(22, 110.5, 114.2, 110.4, 114), at(23, 114, 114.1, 111, 111.2), at(24, 111.2, 111.3, 105, 105.2), at(25, 105.2, 105.3, 101, 101.5)];
  const d = run(failed);
  assert.ok(d.some((x) => x.explanation.notes.some((n) => /sweep failed, trend continues/.test(n))));
  assert.ok(d.slice(20).every((x) => x.action !== "SELL" || x.kind !== "CONFIRMED_REVERSAL" || x.index > 25), "no reversal from the cancelled watch");
});

test("Engine 10: requireRefBeforeSweep demands that the protected swing pre-dates the sweep", () => {
  assert.equal(run(B_TAIL, { reversal: { requireRefBeforeSweep: true } })[24].action, "SELL");     // swing low #15 was confirmed at #17, before the sweep at #21
  const lowSwingAfter = [at(20, 110, 112, 109.9, 111.8), at(21, 111.9, 113.5, 109.5, 110.5), at(22, 110.5, 110.6, 107.0, 107.2), at(23, 107.2, 109.5, 107.0, 109), at(24, 109, 109.2, 108.0, 108.4), at(25, 108.4, 108.5, 106.5, 106.8), at(26, 106.8, 106.9, 104.0, 104.2)];
  const loose = run(lowSwingAfter), strict = run(lowSwingAfter, { reversal: { requireRefBeforeSweep: true } });
  const l = loose.find((x) => x.kind === "CONFIRMED_REVERSAL"), s = strict.find((x) => x.kind === "CONFIRMED_REVERSAL");
  if (l && s) assert.ok(s.structure!.event!.refConfirmedAt <= 21);
  if (l && !s) assert.ok(l.structure!.event!.refConfirmedAt > 21);
});

test("Engine 9 + 10: repeated countertrend sweeps are counted, never a trigger", () => {
  // three upside sweeps in a row while price keeps holding above the protected low
  const tail = [...sweepHigh(20, 111).map((c, k) => ({ ...c })), ...sweepHigh(22, 112.2), ...sweepHigh(24, 113.4)];
  const d = run(tail);
  const sweeps = d.filter((x) => x.sweep);
  assert.ok(sweeps.length >= 3);
  assert.ok(sweeps.every((x) => x.sweep!.alignment === "COUNTERTREND"));
  assert.deepEqual(sweeps.slice(0, 3).map((x) => x.sweep!.ordinal), [1, 2, 3]);
  assert.ok(d.every((x) => x.action === "NO_TRADE"), "three sweeps, no confirmed shift: no trade");
  assert.ok(d.slice(-1)[0].state === "REVERSAL_WATCH" || d.slice(-1)[0].state === "REPEATED_SWEEP_MONITOR" || d.slice(-1)[0].state === "SWEEP_DETECTED");
});

// ================================================================================================ ENGINE 12
const snapStub = (trend: string, extra: Record<string, unknown> = {}) => ({ trend, recentChanges: 0, lastShift: null, ...extra }) as any;
const sweepStub = (recentCount: number, failed = 0) => ({ recentCount, failedWithTrendRecent: failed }) as any;
const healthyWindow = () => Array.from({ length: 12 }, (_, k) => at(k, 100 + k * 2, 102.3 + k * 2, 99.9 + k * 2, 102 + k * 2));
const tiredWindow = () => [
  ...Array.from({ length: 8 }, (_, k) => at(k, 100 + k * 2, 102.2 + k * 2, 99.9 + k * 2, 102 + k * 2)),
  at(8, 116, 119.5, 115.9, 116.6), at(9, 116.6, 119.0, 116.0, 117.0), at(10, 117, 117.3, 114.5, 115), at(11, 115, 118.8, 114.9, 115.4),
];

test("Engine 12: six recent sweeps with healthy candles and new highs are STILL healthy (sweep count is never a sign)", () => {
  const r = evaluateExhaustion(healthyWindow(), 11, snapStub("BULLISH"), sweepStub(6));
  assert.equal(r.state, "HEALTHY_CONTINUATION"); assert.equal(r.metrics.recentSweeps, 6); assert.equal(r.signs.length, 0);
  const r2 = evaluateExhaustion(healthyWindow(), 11, snapStub("BULLISH"), sweepStub(0));
  assert.equal(r2.state, r.state);
});

test("Engine 12: shrinking bodies, rejection wicks, no new highs, opposing candles -> POSSIBLE_EXHAUSTION from measurements", () => {
  const r = evaluateExhaustion(tiredWindow(), 11, snapStub("BULLISH"), sweepStub(1, 2));
  assert.equal(r.state, "POSSIBLE_EXHAUSTION");
  for (const s of ["bodyDecay", "wickRejection", "failedAttempts"]) assert.ok(r.signs.includes(s), `${s} in ${r.signs}`);
  assert.ok(!r.signs.includes("noNewExtremes") && r.metrics.makingNewExtremes === true, "the high was made 3 candles ago");
  assert.ok(evaluateExhaustion(tiredWindow(), 11, snapStub("BULLISH"), sweepStub(1, 0), { ...EXHAUSTION_DEFAULTS, extremeRecent: 2 }).signs.includes("noNewExtremes"));
  const calm = evaluateExhaustion(tiredWindow(), 11, snapStub("BULLISH"), sweepStub(9, 0), { ...EXHAUSTION_DEFAULTS, minSigns: 6 });
  assert.notEqual(calm.state, "POSSIBLE_EXHAUSTION");
});

test("Engine 12: a recent structure shift = CONFIRMED_STRUCTURE_REVERSAL; neutral = UNCLEAR; short history = UNCLEAR", () => {
  const shift = { index: 9, direction: "BEAR", level: 100 };
  assert.equal(evaluateExhaustion(healthyWindow(), 11, snapStub("NEUTRAL", { lastShift: shift }), sweepStub(0)).state, "CONFIRMED_STRUCTURE_REVERSAL");
  assert.equal(evaluateExhaustion(healthyWindow(), 11, snapStub("NEUTRAL"), sweepStub(0)).state, "UNCLEAR");
  assert.equal(evaluateExhaustion(healthyWindow().slice(0, 5), 4, snapStub("BULLISH"), sweepStub(0)).state, "UNCLEAR");
  assert.equal(evaluateExhaustion(healthyWindow(), 11, snapStub("BULLISH", { lastShift: { index: 0, direction: "BEAR", level: 1 } }), sweepStub(0)).state, "HEALTHY_CONTINUATION", "an old shift against the current trend no longer counts");
});

// ================================================================================================ PIPELINE
test("Pipeline: NO LOOK-AHEAD. Decisions for the first N candles are identical with or without the rest of the data", () => {
  const cs = synthCandles({ n: 2600, seed: 21 });
  const full = pipelineSeries(cs);
  for (const cut of [400, 1234, 2000]) {
    const part = [...cs.slice(0, cut + 1)];
    const p = new QuantumPipeline(QUANTUM_DEFAULTS);
    const dec = part.map((c) => p.step(c));
    for (let i = 0; i <= cut; i++) assert.equal(key(dec[i]), key(full[i]), `index ${i} (cut ${cut})`);
  }
  assert.ok(full.some((d) => d.action !== "NO_TRADE"), "the sample contains signals, so the comparison means something");
});

test("Pipeline: validation comes first. unfinished, duplicate, out-of-order and gapped candles never reach the engines", () => {
  const p = new QuantumPipeline(quantumParams({ minHistory: 10 }));
  UP.forEach((c) => p.step(c));
  const unfinished = p.step({ ...at(20, 110, 112, 109, 111), closed: false });
  assert.equal(unfinished.action, "NO_TRADE"); assert.match(unfinished.reason, /CANDLE_NOT_CLOSED/);
  const dup = p.step(UP[19]); assert.match(dup.reason, /DUPLICATE_CANDLE/);
  const bad = new QuantumPipeline(quantumParams({ minHistory: 10 })); UP.forEach((c) => bad.step(c));
  assert.match(bad.step({ ...at(20, 110, 100, 120, 111) }).reason, /DATA_INVALID/);
  assert.match(bad.step(at(21, 110, 111, 109, 110.5)).reason, /WARMUP/, "state was reset");
  const gap = new QuantumPipeline(quantumParams({ minHistory: 10 })); UP.forEach((c) => gap.step(c));
  const g = gap.step(at(22, 110, 111, 109, 110.5));                   // candles 20 and 21 are missing
  assert.match(g.reason, /DATA_GAP: 2 candle\(s\) missing/); assert.equal(g.trend, "NEUTRAL"); assert.equal(g.runStart, 20);
  // the unfinished candle left no trace: the closed version gives the same decision as a pipeline that never saw it
  const ref = new QuantumPipeline(quantumParams({ minHistory: 10 })); UP.forEach((c) => ref.step(c));
  const closedVersion = at(20, 110, 112, 109, 111);
  const a = p.step(closedVersion), b = ref.step(closedVersion);
  assert.equal(a.action, b.action); assert.equal(a.trend, b.trend); assert.equal(a.state, b.state);
});

test("Pipeline: warm-up blocks signals; each path can be switched off", () => {
  assert.equal(run(B_TAIL, { minHistory: 100 }).filter((x) => x.action !== "NO_TRADE").length, 0);
  assert.match(run(B_TAIL, { minHistory: 100 })[24].reason, /WARMUP/);
  assert.equal(run(B_TAIL, { allowReversal: false }).filter((x) => x.action !== "NO_TRADE").length, 0);
  assert.equal(run(A_TAIL, { allowContinuation: false }).filter((x) => x.action !== "NO_TRADE").length, 0);
});

test("Pipeline: the explanation says what was seen", () => {
  const d = run(B_TAIL)[24], x = d.explanation;
  assert.equal(d.signal!.side, "SELL"); assert.equal(x.verdict, "SELL");
  assert.match(x.structureStatus, /Confirmed structure shift/);
  assert.match(x.liquiditySweeps.text, /detected/);
  const e = run(A_TAIL)[21].explanation;
  assert.equal(e.marketStructure.label, "BULLISH TREND"); assert.match(e.marketStructure.detail, /Higher highs and higher lows/);
  assert.equal(e.trendAlignment, "With trend"); assert.equal(e.verdict, "NO TRADE");
  assert.ok(e.notes[0].startsWith("sweep:"));
});

test("Pipeline: invariants over 20,000 random candles (reference swings, one entry per shift, duplicates and conflicts, original engines untouched)", () => {
  const cs = synthCandles({ n: 20000, seed: 77 });
  const ds = pipelineSeries(cs);
  const sigs = ds.filter((d) => d.action !== "NO_TRADE");
  assert.ok(sigs.length > 100);
  const p = QUANTUM_DEFAULTS;
  for (const d of sigs) {
    assert.ok(d.index >= p.minHistory - 1);
    assert.ok(d.closeTime !== null && d.closeTime === d.time + 300, "signal time is the candle CLOSE");
    if (d.kind === "CONFIRMED_REVERSAL") {                              // a reversal never exists without a confirmed shift on a previously confirmed swing
      const e = d.structure!.event!;
      assert.equal(e.type, "MSS"); assert.ok(e.refConfirmedAt < e.index);
      assert.equal(d.action, e.direction === "BEAR" ? "SELL" : "BUY");
      assert.equal(d.signal!.trendContext, e.direction === "BEAR" ? "BULLISH" : "BEARISH");
    } else {
      assert.equal(d.kind, "WITH_TREND_CONTINUATION");
      assert.equal(d.trend, d.action === "BUY" ? "BULLISH" : "BEARISH");
      assert.notEqual(d.exhaustion!.state, "POSSIBLE_EXHAUSTION");
    }
  }
  for (let a = 0; a < sigs.length; a++) for (let b = a + 1; b < sigs.length && sigs[b].index - sigs[a].index <= 3; b++) {
    assert.notEqual(sigs[a].action, sigs[b].action, "no opposite signals within the conflict window");
    assert.ok(false, "no same-side signal within the duplicate window");
  }
  // Engines 5 and 6 are context only and report exactly what the untouched engines report
  for (let i = 40; i < 3000; i += 7) {
    assert.equal(ds[i].original.continuation, detectContinuation(cs, i)?.side ?? null);
    assert.equal(ds[i].original.momentum, detectMomentum(cs, i)?.side ?? null);
  }
});

test("Pipeline: sweep count never creates a trade by itself (a long run of sweeps with no structure shift)", () => {
  const cs = synthCandles({ n: 20000, seed: 31 });
  const ds = pipelineSeries(cs);
  const heavy = ds.filter((d) => d.sweep && d.sweep.ordinal >= 4);
  assert.ok(heavy.length > 20, "the sample has deep clusters");
  assert.ok(heavy.some((d) => d.action === "NO_TRADE"));
  // a signal on a sweep candle itself can only be a continuation that completed on that candle or a structural shift, never the count
  for (const d of heavy) if (d.action !== "NO_TRADE") assert.ok(d.kind !== null && d.signal!.reasons.length > 0);
});
