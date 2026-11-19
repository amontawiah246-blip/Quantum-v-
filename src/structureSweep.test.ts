// These tests exercise the candle-pattern strategies broadcasting on their own (the legacy mode). The default mode is covered by src/stochRsi.test.ts.
process.env.STRATEGY_MODE = 'legacy';
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeStructureSweep, detectStructureSweepSignal, StructureSweepTracker } from "./structureSweep";
import { C, detectAll, detectContinuation, detectMomentum, detectStructureSweep, detectWickSweep } from "./sweepEngines";
import { SweepWatcherService, WatcherDeps } from "./sweepWatcherCore";
import { CandidateHub } from "./candidateHub";
import { VerificationCoordinator, PipelineAnswer } from "./verificationCoordinator";
import { PNG } from "./aiFixtures";

const TF = 60;
const T0 = 1_762_300_020;

function mkCandle(idx: number, open: number, close: number, high?: number, low?: number): C {
  const top = Math.max(open, close);
  const bot = Math.min(open, close);
  return {
    time: T0 + idx * TF,
    open,
    close,
    high: high ?? top + 0.3,
    low: low ?? bot - 0.3,
  };
}

/** Builds a clean series of closed candles from (open, close, highOffset, lowOffset) specs. */
function buildFromSpecs(specs: Array<[number, number, number?, number?]>): C[] {
  return specs.map(([o, c, ho, lo], i) => {
    const top = Math.max(o, c);
    const bot = Math.min(o, c);
    return mkCandle(i, o, c, top + (ho ?? 0.2), bot - (lo ?? 0.2));
  });
}

/**
 * Clean Downtrend (LH/LL) -> Bullish CHoCH (breaking LH) -> Red pullback -> Green sweep & close back above low.
 */
function buildDowntrendThenBullishChochSweep(): { candles: C[]; chochLevel: number; sweepIdx: number } {
  // Using swingLeft=3, swingRight=3:
  // Need clear swing high #1 around i=3, swing low #1 around i=7, lower high #2 around i=11, lower low #2 around i=15
  // Then rally breaks above lower high #2 to confirm BULLISH CHoCH!
  const specs: Array<[number, number, number?, number?]> = [
    // Build first swing high at i=3 (peak high ~110)
    [104, 105, 0.5, 0.3], // 0
    [105, 106, 0.5, 0.3], // 1
    [106, 108, 0.5, 0.3], // 2
    [108, 109, 1.0, 0.3], // 3 -> SWING HIGH #1 = 110.0
    [109, 107, 0.4, 0.3], // 4
    [107, 104, 0.3, 0.3], // 5
    [104, 101, 0.3, 0.4], // 6
    [101, 99, 0.3, 1.0],  // 7 -> SWING LOW #1 = 98.0
    [99, 101, 0.3, 0.4],  // 8
    [101, 103, 0.3, 0.3], // 9
    [103, 104, 0.3, 0.3], // 10
    [104, 105, 1.0, 0.3], // 11 -> SWING HIGH #2 (LH) = 106.0 (confirmed at i=14)
    [105, 102, 0.3, 0.3], // 12
    [102, 98, 0.3, 0.4],  // 13
    [98, 95, 0.3, 0.4],   // 14
    [95, 93, 0.3, 1.0],   // 15 -> SWING LOW #2 (LL) = 92.0 (confirmed at i=18)
    [93, 96, 0.3, 0.3],   // 16
    [96, 99, 0.3, 0.3],   // 17
    [99, 103, 0.3, 0.3],  // 18 -> Prior structure is BEARISH (LH + LL confirmed)
    [103, 105.5, 0.2, 0.2], // 19
    [105.5, 108.5, 0.4, 0.2], // 20 -> Closes 108.5 > LH(106.0) => BULLISH CHoCH!
    // Pullback red candle then green sweep below pullback low & close back above
    [108.5, 107.0, 0.2, 0.5], // 21 -> Red pullback candle (low = 106.5)
    [107.1, 108.4, 0.3, 1.6], // 22 -> Green candle: low = 105.5 (< 106.5), close = 108.4 (> 106.5), lowerWick = 1.6 / range 3.2 = 0.50!
  ];
  return { candles: buildFromSpecs(specs), chochLevel: 106.0, sweepIdx: specs.length - 1 };
}

/**
 * Clean Uptrend (HH/HL) -> Bearish CHoCH (breaking HL) -> Green pullback -> Red sweep & close back below high.
 */
function buildUptrendThenBearishChochSweep(): { candles: C[]; chochLevel: number; sweepIdx: number } {
  const specs: Array<[number, number, number?, number?]> = [
    [96, 95, 0.3, 0.5],   // 0
    [95, 94, 0.3, 0.5],   // 1
    [94, 92, 0.3, 0.5],   // 2
    [92, 91, 0.3, 1.0],   // 3 -> SWING LOW #1 = 90.0
    [91, 93, 0.3, 0.3],   // 4
    [93, 96, 0.3, 0.3],   // 5
    [96, 99, 0.4, 0.3],   // 6
    [99, 101, 1.0, 0.3],  // 7 -> SWING HIGH #1 = 102.0
    [101, 99, 0.3, 0.3],  // 8
    [99, 97, 0.3, 0.3],   // 9
    [97, 96, 0.3, 0.3],   // 10
    [96, 95, 0.3, 1.0],   // 11 -> SWING LOW #2 (HL) = 94.0 (confirmed at i=14)
    [95, 98, 0.3, 0.3],   // 12
    [98, 102, 0.4, 0.3],  // 13
    [102, 105, 0.4, 0.3], // 14
    [105, 107, 1.0, 0.3], // 15 -> SWING HIGH #2 (HH) = 108.0 (confirmed at i=18)
    [107, 104, 0.3, 0.3], // 16
    [104, 101, 0.3, 0.3], // 17
    [101, 97, 0.3, 0.3],  // 18 -> Prior structure is BULLISH (HL + HH)
    [97, 94.5, 0.2, 0.2], // 19
    [94.5, 91.5, 0.2, 0.4], // 20 -> Closes 91.5 < HL(94.0) => BEARISH CHoCH!
    // Pullback green candle then red sweep above pullback high & close back below
    [91.5, 93.0, 0.5, 0.2], // 21 -> Green pullback (high = 93.5)
    [92.9, 91.6, 1.6, 0.3], // 22 -> Red candle: high = 94.5 (> 93.5), close = 91.6 (< 93.5), upperWick = 1.6 / range 3.2 = 0.50!
  ];
  return { candles: buildFromSpecs(specs), chochLevel: 94.0, sweepIdx: specs.length - 1 };
}

/**
 * Clean Uptrend with Bullish BOS continuation + Red pullback + Green sweep BUY.
 */
/**
 * Clean Uptrend (2 SH + 2 SL: HH/HL) with Bullish BOS continuation + Red pullback + Green sweep BUY.
 */
function buildBullishBosSweep(): C[] {
  const specs: Array<[number, number, number?, number?]> = [
    [96, 94, 0.3, 0.3],   // 0
    [94, 93, 0.3, 0.3],   // 1
    [93, 92, 0.3, 0.3],   // 2
    [92, 91, 0.3, 1.0],   // 3 -> SL #1 = 90.0
    [91, 93, 0.3, 0.3],   // 4
    [93, 95, 0.3, 0.3],   // 5
    [95, 96, 0.3, 0.3],   // 6
    [96, 97, 1.0, 0.3],   // 7 -> SH #1 = 98.0
    [97, 96, 0.3, 0.3],   // 8
    [96, 95, 0.3, 0.3],   // 9
    [95, 94.5, 0.3, 0.3], // 10
    [94.5, 94, 0.3, 1.0], // 11 -> HL #1 = 93.0
    [94, 96, 0.3, 0.3],   // 12
    [96, 98, 0.3, 0.3],   // 13
    [98, 100, 0.3, 0.3],  // 14
    [100, 101, 1.0, 0.3], // 15 -> HH #1 = 102.0 (confirmed at 18)
    [101, 99.5, 0.3, 0.3],// 16
    [99.5, 98, 0.3, 0.3], // 17
    [98, 97.2, 0.3, 0.3], // 18
    [97.2, 97, 0.3, 1.0], // 19 -> HL #2 = 96.0 (confirmed at 22)
    [97, 98.5, 0.3, 0.3], // 20
    [98.5, 100, 0.3, 0.3],// 21
    [100, 101.2, 0.3, 0.3],// 22 -> Prior structure confirmed BULLISH (HH #1=102 > SH #1=98, HL #1=93 > SL #1=90)
    [101.2, 104, 0.3, 0.2],// 23 -> Closes 104 > HH #1 (102.0) => Bullish BOS!
    // Pullback + sweep BUY
    [104, 102.5, 0.2, 0.5], // 24 -> Red pullback (low = 102.0)
    [102.6, 104.2, 0.2, 1.6], // 25 -> Green candle sweeps low (101.0 < 102.0), closes above (104.2)
  ];
  return buildFromSpecs(specs);
}

/**
 * Clean Downtrend (2 SH + 2 SL: LH/LL) with Bearish BOS continuation + Green pullback + Red sweep SELL.
 */
function buildBearishBosSweep(): C[] {
  const specs: Array<[number, number, number?, number?]> = [
    [104, 106, 0.3, 0.3], // 0
    [106, 107, 0.3, 0.3], // 1
    [107, 108, 0.3, 0.3], // 2
    [108, 109, 1.0, 0.3], // 3 -> SH #1 = 110.0
    [109, 107, 0.3, 0.3], // 4
    [107, 105, 0.3, 0.3], // 5
    [105, 104, 0.3, 0.3], // 6
    [104, 103, 0.3, 1.0], // 7 -> SL #1 = 102.0
    [103, 104, 0.3, 0.3], // 8
    [104, 105, 0.3, 0.3], // 9
    [105, 105.5, 0.3, 0.3],// 10
    [105.5, 106, 1.0, 0.3],// 11 -> LH #1 = 107.0
    [106, 104, 0.3, 0.3], // 12
    [104, 102, 0.3, 0.3], // 13
    [102, 100, 0.3, 0.3], // 14
    [100, 99, 0.3, 1.0],  // 15 -> LL #1 = 98.0 (confirmed at 18)
    [99, 100.5, 0.3, 0.3],// 16
    [100.5, 102, 0.3, 0.3],// 17
    [102, 102.8, 0.3, 0.3],// 18
    [102.8, 103, 1.0, 0.3],// 19 -> LH #2 = 104.0 (confirmed at 22)
    [103, 101.5, 0.3, 0.3],// 20
    [101.5, 100, 0.3, 0.3],// 21
    [100, 98.8, 0.3, 0.3], // 22 -> Prior structure confirmed BEARISH (LH #1=107 < SH #1=110, LL #1=98 < SL #1=102)
    [98.8, 96, 0.2, 0.3],  // 23 -> Closes 96 < LL #1 (98.0) => Bearish BOS!
    // Pullback + sweep SELL
    [96, 97.5, 0.5, 0.2], // 24 -> Green pullback (high = 98.0)
    [97.4, 95.8, 1.6, 0.2], // 25 -> Red candle sweeps high (99.0 > 98.0), closes below (95.8)
  ];
  return buildFromSpecs(specs);
}

test("1. Downtrend + Bullish CHoCH/MSS + red pullback + green sweep produces STRUCTURE_CONFIRMED_SWEEP BUY", () => {
  const { candles, chochLevel, sweepIdx } = buildDowntrendThenBullishChochSweep();
  const { signal, snapshot } = detectStructureSweepSignal(candles, sweepIdx, { swingLeft: 3, swingRight: 3 });
  assert.ok(snapshot, "snapshot should be produced");
  assert.equal(snapshot.state, "STRUCTURE_CONFIRMED_SWEEP");
  assert.equal(snapshot.directionalBias, "BULLISH");
  assert.ok(signal, "confirmed signal must fire");
  assert.equal(signal.side, "BUY");
  assert.equal(signal.biasEvent.type, "CHoCH");
  assert.equal(signal.breakLevel, chochLevel);
});

test("2. Uptrend + Bearish CHoCH/MSS + green pullback + red sweep produces STRUCTURE_CONFIRMED_SWEEP SELL", () => {
  const { candles, chochLevel, sweepIdx } = buildUptrendThenBearishChochSweep();
  const { signal, snapshot } = detectStructureSweepSignal(candles, sweepIdx, { swingLeft: 3, swingRight: 3 });
  assert.ok(snapshot);
  assert.equal(snapshot.state, "STRUCTURE_CONFIRMED_SWEEP");
  assert.equal(snapshot.directionalBias, "BEARISH");
  assert.ok(signal);
  assert.equal(signal.side, "SELL");
  assert.equal(signal.biasEvent.type, "CHoCH");
  assert.equal(signal.breakLevel, chochLevel);
});

test("3. Bullish BOS trend continuation + red pullback + green sweep produces STRUCTURE_CONFIRMED_SWEEP BUY", () => {
  const candles = buildBullishBosSweep();
  const { signal, snapshot } = detectStructureSweepSignal(candles, candles.length - 1, { swingLeft: 3, swingRight: 3 });
  assert.ok(snapshot);
  assert.equal(snapshot.state, "STRUCTURE_CONFIRMED_SWEEP");
  assert.equal(snapshot.directionalBias, "BULLISH");
  assert.ok(signal);
  assert.equal(signal.side, "BUY");
  assert.ok(signal.biasEvent.type === "BOS" || signal.bosCount >= 1);
});

test("4. Bearish BOS trend continuation + green pullback + red sweep produces STRUCTURE_CONFIRMED_SWEEP SELL", () => {
  const candles = buildBearishBosSweep();
  const { signal, snapshot } = detectStructureSweepSignal(candles, candles.length - 1, { swingLeft: 3, swingRight: 3 });
  assert.ok(snapshot);
  assert.equal(snapshot.state, "STRUCTURE_CONFIRMED_SWEEP");
  assert.equal(snapshot.directionalBias, "BEARISH");
  assert.ok(signal);
  assert.equal(signal.side, "SELL");
  assert.ok(signal.biasEvent.type === "BOS" || signal.bosCount >= 1);
});

test("5. Liquidity sweep WITHOUT prior structure bias is rejected and never generates BUY/SELL structure signal", () => {
  const flatThenSweep = buildFromSpecs([
    [100, 100.2, 0.1, 0.1],
    [100.2, 100.0, 0.1, 0.1],
    [100.0, 100.1, 0.1, 0.1],
    [100.1, 99.9, 0.1, 0.1],
    [99.9, 98.8, 0.1, 0.4],   // Red pullback (low = 98.4)
    [98.9, 100.3, 0.2, 1.5],  // Green sweep below 98.4 and close above
  ]);
  const { signal, snapshot } = detectStructureSweepSignal(flatThenSweep, flatThenSweep.length - 1, { swingLeft: 3, swingRight: 3 });
  assert.equal(signal, null, "sweep without prior CHoCH/MSS/BOS must not confirm");
  assert.ok(snapshot);
  assert.equal(snapshot.state, "SWEEP_DETECTED");
  assert.equal(snapshot.directionalBias, "NONE");
  assert.match(snapshot.rejectionReason ?? "", /WAITING_FOR_STRUCTURE/i);
});

test("6. Liquidity sweep AGAINST active directional bias is rejected with AGAINST_STRUCTURE_BIAS", () => {
  const { candles } = buildDowntrendThenBullishChochSweep();
  // Replace tail after bullish CHoCH (index 20) with a bearish sweep against BULLISH bias
  const modified = candles.slice(0, 21);
  modified.push(mkCandle(21, 108.5, 109.8, 110.2, 108.3)); // green pullback
  modified.push(mkCandle(22, 109.7, 108.2, 111.5, 108.0)); // red sweep above 110.2, close below
  const { signal, snapshot } = detectStructureSweepSignal(modified, modified.length - 1, { swingLeft: 3, swingRight: 3 });
  assert.equal(signal, null, "SELL sweep during BULLISH bias must be rejected");
  assert.ok(snapshot);
  assert.equal(snapshot.directionalBias, "BULLISH");
  assert.match(snapshot.rejectionReason ?? "", /AGAINST_STRUCTURE_BIAS/);
});

test("7. Opposing structural break invalidates prior directional bias (BIAS_INVALIDATED / new opposite bias)", () => {
  const { candles } = buildDowntrendThenBullishChochSweep();
  // Establish BULLISH CHoCH up to index 20, rally to build a clean Higher Low at index 24 (low=107.8 < 21's low 108.3), confirm at 27, then break below HL!
  const extended = candles.slice(0, 21);
  const tail: Array<[number, number, number?, number?]> = [
    [108.5, 111.0, 0.3, 0.2], // 21 (low 108.3)
    [111.0, 112.0, 0.3, 0.2], // 22 (low 110.8)
    [112.0, 110.5, 0.2, 0.3], // 23 (low 110.2)
    [110.5, 108.8, 0.2, 1.0], // 24 -> SWING LOW (HL) = 107.8 (strictly lowest across 21..27!)
    [108.8, 111.0, 0.2, 0.2], // 25 (low 108.6)
    [111.0, 112.5, 0.2, 0.2], // 26 (low 110.8)
    [112.5, 113.0, 0.2, 0.2], // 27 -> confirms HL=107.8 at 24
    [113.0, 109.0, 0.2, 0.2], // 28
    [109.0, 106.0, 0.2, 0.3], // 29 -> Closes 106.0 < HL(107.8) -> invalidates BULLISH bias!
  ];
  const all = extended.concat(
    tail.map(([o, c, ho, lo], k) => mkCandle(21 + k, o, c, Math.max(o, c) + (ho ?? 0.2), Math.min(o, c) - (lo ?? 0.2)))
  );
  const snap = analyzeStructureSweep(all, all.length - 1, { swingLeft: 3, swingRight: 3 });
  assert.ok(snap);
  assert.equal(snap.previousBiasInvalidated, true);
  assert.notEqual(snap.directionalBias, "BULLISH");
  assert.ok(snap.lastInvalidation && snap.lastInvalidation.direction === "BULLISH");
});

test("8. Minor internal structure break does NOT trigger major swing CHoCH/MSS reversal", () => {
  const { candles } = buildDowntrendThenBullishChochSweep();
  // Take up to index 18 (BEARISH prior structure, LH=106.0)
  // Add a tiny 1-bar micro-bounce high at 96.5 and break 96.6 (< major LH 106.0)
  const sub = candles.slice(0, 19);
  sub.push(mkCandle(19, 99.0, 97.0, 99.2, 96.8));
  sub.push(mkCandle(20, 97.0, 98.5, 98.6, 96.8)); // internal high around 99.2
  sub.push(mkCandle(21, 98.5, 97.2, 98.6, 97.0));
  sub.push(mkCandle(22, 97.2, 99.6, 99.8, 97.1)); // breaks internal 99.2, still far below major LH 106.0!
  const snap = analyzeStructureSweep(sub, sub.length - 1, { swingLeft: 3, swingRight: 3, internalLeft: 1, internalRight: 1 });
  assert.ok(snap);
  assert.notEqual(snap.directionalBias, "BULLISH", "minor internal break must not establish major BULLISH bias");
  assert.ok(!snap.swingEvents.some((e) => e.type === "CHoCH" && e.direction === "BULLISH"));
});

test("9. Duplicate structure break suppression emits CHoCH/BOS once per broken pivot level", () => {
  const { candles } = buildDowntrendThenBullishChochSweep();
  const extra = candles.slice(0, 21);
  // Two extra closes staying above LH=106 without creating a new swing high pivot
  extra.push(mkCandle(21, 108.5, 109.0, 109.2, 108.1));
  extra.push(mkCandle(22, 109.0, 109.3, 109.5, 108.8));
  const tracker = new StructureSweepTracker({ swingLeft: 3, swingRight: 3 });
  const eventsByBar: number[] = [];
  for (const c of extra) {
    const s = tracker.step(c);
    eventsByBar.push(s.newSwingEvents.filter((e) => e.type === "CHoCH" && e.direction === "BULLISH").length);
  }
  const totalChoch = eventsByBar.reduce((a, b) => a + b, 0);
  assert.equal(totalChoch, 1, "Bullish CHoCH against the same LH pivot must emit exactly once");
});

test("10. Zero lookahead & non-repainting: output at candle i is identical regardless of future candles", () => {
  const { candles, sweepIdx } = buildDowntrendThenBullishChochSweep();
  const truncated = candles.slice(0, sweepIdx + 1);
  const withFutureCrash = [
    ...candles,
    mkCandle(sweepIdx + 1, 108.4, 70.0, 108.5, 69.0),
    mkCandle(sweepIdx + 2, 70.0, 55.0, 71.0, 54.0),
  ];
  const snapA = analyzeStructureSweep(truncated, sweepIdx, { swingLeft: 3, swingRight: 3 });
  const snapB = analyzeStructureSweep(withFutureCrash, sweepIdx, { swingLeft: 3, swingRight: 3 });
  assert.deepEqual(snapA, snapB, "future candles must never change historical structure or signal evaluation");
});

test("11. CandidateHub + VerificationCoordinator + fake AI receive identical candidateId, pngSha256 & OHLC hash for structure_sweep", async () => {
  // Build a sequence matching detectStructureSweep's strict default swingLeft=5, swingRight=5 inside a 45-candle window
  // 0..5 down to swing high at 5, 10 swing low, 15 lower high, 20 lower low, 25 break LH => bullish CHoCH, then red pullback + green sweep at 44!
  const specs: Array<[number, number, number?, number?]> = [];
  for (let i = 0; i <= 42; i++) {
    if (i < 5) specs.push([105 + i * 1.2, 106 + i * 1.2]);
    else if (i === 5) specs.push([111, 112, 1.5, 0.2]); // Swing High #1 ~113.5
    else if (i < 11) specs.push([112 - (i - 5) * 2.2, 110 - (i - 5) * 2.2]);
    else if (i === 11) specs.push([98.8, 97.5, 0.2, 1.5]); // Swing Low #1 ~96
    else if (i < 17) specs.push([97.5 + (i - 11) * 1.5, 99 + (i - 11) * 1.5]);
    else if (i === 17) specs.push([106.5, 107.2, 1.0, 0.2]); // Lower High #2 ~108.2 (confirmed by i=22)
    else if (i < 23) specs.push([107.2 - (i - 17) * 2.8, 104.5 - (i - 17) * 2.8]);
    else if (i === 23) specs.push([90.5, 89.2, 0.2, 1.5]); // Lower Low #2 ~87.7 (confirmed by i=28)
    else if (i <= 34) specs.push([89.2 + (i - 23) * 1.8, 91.0 + (i - 23) * 1.8]); // crosses above 108.2 around i=34 => CHoCH!
    else specs.push([110 + (i - 34) * 0.2, 110.2 + (i - 34) * 0.2]);
  }
  specs.push([111.8, 110.4, 0.1, 0.4]); // 43: Red pullback (low = 110.0)
  specs.push([110.5, 111.7, 0.2, 1.8]); // 44: Green sweep (low = 108.7 < 110.0, close = 111.7 > 110.0, wickRatio = 1.8/3.2 = 0.5625)
  const cs = buildFromSpecs(specs);
  const directVerdict = detectStructureSweep(cs, cs.length - 1);
  assert.ok(directVerdict && directVerdict.engine === "structure_sweep", "strict detectStructureSweep must fire on test fixture");

  const sig = cs[cs.length - 1];
  const nowSec = sig.time + TF + 3;
  const hub = new CandidateHub();
  const seenAi: Array<{ id: string; pngSha: string | null; rowsHash: string }> = [];
  const watcher = new SweepWatcherService({
    agents: [{ symbol: "frxXAUUSD", name: "Agent Gold-XAU", market: "Gold / USD (XAUUSD)" }],
    deps: {
      now: async () => nowSec,
      sleep: async () => {},
      fetchCandles: async () => cs.map((c) => ({ ...c })),
    },
    hub,
    rasterize: async () => PNG,
    tf: TF,
  });
  const coord = new VerificationCoordinator(hub, {
    nowSec: () => nowSec,
    pipeline: async (ev): Promise<PipelineAnswer> => {
      seenAi.push({ id: ev.candidateId, pngSha: ev.screenshot.pngSha256, rowsHash: ev.aiRowsHash });
      return {
        tradeable: true,
        side: ev.direction,
        status: "Verified by fake AI",
        reasons: ["structure_sweep confirmed"],
        imageSha256: ev.screenshot.pngSha256,
        aiRowsHash: ev.aiRowsHash,
        signal: { ok: true },
      };
    },
  }).start();

  await watcher.runPass(0);
  const structCand = hub.list(20).find((c) => c.versions[0].engine === "structure_sweep");
  assert.ok(structCand, "CandidateHub must receive structure_sweep candidate");
  const decision = await hub.waitForDecision(structCand.id, 2000);
  assert.ok(decision);
  assert.equal(decision.action, "EXECUTE");
  assert.ok(decision.corroboratedBy.includes("structure_sweep"));
  const matched = seenAi.find((x) => x.id === structCand.id);
  assert.ok(matched, "AI pipeline must inspect the exact same candidateId");
  assert.equal(matched.pngSha, structCand.versions[0].screenshot.pngSha256);
  assert.equal(matched.rowsHash, structCand.versions[0].aiRowsHash);
  coord.stop();
});

test("12. Existing strategy engines remain intact & multi-agent SweepWatcher tracks structure telemetry independently", async () => {
  // Verify all existing engines remain exported & callable alongside structure_sweep
  assert.equal(typeof detectWickSweep, "function");
  assert.equal(typeof detectContinuation, "function");
  assert.equal(typeof detectMomentum, "function");
  assert.equal(typeof detectAll, "function");

  const specs: Array<[number, number, number?, number?]> = [];
  for (let i = 0; i <= 42; i++) {
    if (i < 5) specs.push([105 + i * 1.2, 106 + i * 1.2]);
    else if (i === 5) specs.push([111, 112, 1.5, 0.2]);
    else if (i < 11) specs.push([112 - (i - 5) * 2.2, 110 - (i - 5) * 2.2]);
    else if (i === 11) specs.push([98.8, 97.5, 0.2, 1.5]);
    else if (i < 17) specs.push([97.5 + (i - 11) * 1.5, 99 + (i - 11) * 1.5]);
    else if (i === 17) specs.push([106.5, 107.2, 1.0, 0.2]);
    else if (i < 23) specs.push([107.2 - (i - 17) * 2.8, 104.5 - (i - 17) * 2.8]);
    else if (i === 23) specs.push([90.5, 89.2, 0.2, 1.5]);
    else if (i <= 34) specs.push([89.2 + (i - 23) * 1.8, 91.0 + (i - 23) * 1.8]);
    else specs.push([110 + (i - 34) * 0.2, 110.2 + (i - 34) * 0.2]);
  }
  specs.push([111.8, 110.4, 0.1, 0.4]);
  specs.push([110.5, 111.7, 0.2, 1.8]);
  const cs = buildFromSpecs(specs);
  const nowSec = cs[cs.length - 1].time + TF + 3;

  const deps: WatcherDeps = {
    now: async () => nowSec,
    sleep: async () => {},
    fetchCandles: async (sym) => cs.map((c) => ({ ...c, time: c.time })),
  };
  const watcher = new SweepWatcherService({
    agents: [
      { symbol: "frxXAUUSD", name: "Agent Gold", market: "Gold" },
      { symbol: "R_100", name: "Agent R100", market: "Volatility 100" },
    ],
    deps,
    tf: TF,
  });
  await watcher.runPass(0);
  const structStates = watcher.getStructureStates();
  assert.equal(structStates.markets.length, 2);
  assert.ok(structStates.markets.every((m) => m.classificationState === "STRUCTURE_CONFIRMED_SWEEP" && m.directionalBias === "BULLISH"));
  const alerts = watcher.getAlerts(0, 50).filter((a) => a.engine === "structure_sweep");
  assert.equal(alerts.length, 2, "both agents should emit structure_sweep alerts independently");
});
