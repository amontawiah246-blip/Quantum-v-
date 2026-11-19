// These tests exercise the candle-pattern strategies broadcasting on their own (the legacy mode). The default mode is covered by src/stochRsi.test.ts.
process.env.STRATEGY_MODE = 'legacy';
import test from "node:test";
import assert from "node:assert/strict";
import {
  BROKER_EXPIRIES,
  BROKER_TIMEFRAMES,
  areMarketTimestampsSynchronized,
  canExecuteTrade,
  filterClosedCandles,
  getGlobalTiming,
  isCandleClosed,
  isSupportedExpiry,
  isSupportedTimeframe,
  markAgentSynced,
  registerRequiredAgents,
  resetGlobalTimingForTests,
  setGlobalTiming,
  validateExpiry,
  validateTimeframe,
} from "./globalConfig";
import { SweepWatcherService, WatcherDeps } from "./sweepWatcherCore";
import { buildAiRequest } from "./aiVerification";
import { verifyPattern } from "./patternVerification";
import { assessMarketQuality } from "./marketQuality";
import { backtestConfigFromGlobal } from "./engineBacktest";
import { C } from "./sweepEngines";
import { market, withSweep, TF as M5 } from "./aiFixtures";

test("1. Single central configuration holds uniform tfSec and expirySec with zero per-market overrides", () => {
  resetGlobalTimingForTests({ tfSec: 60, expirySec: 60, requiredAgents: ["frxXAUUSD", "R_100", "1HZ10V"] });
  const init = getGlobalTiming();
  assert.equal(init.tfSec, 60);
  assert.equal(init.expirySec, 60);
  assert.equal(init.transitioning, false);

  const updated = setGlobalTiming({ tfSec: 300, expirySec: 120 });
  assert.equal(updated.tfSec, 300);
  assert.equal(updated.expirySec, 120);
  assert.equal(updated.syncVersion, 2);
  assert.equal(updated.transitioning, true, "changing timeframe with registered agents triggers transition barrier");
});

test("2. Strict separation between chart timeframe (tfSec) and trade expiry (expirySec)", () => {
  resetGlobalTimingForTests({ tfSec: 60, expirySec: 60 });
  // Change only expirySec to 240s (4m) while tfSec remains 60s (1m)
  const s1 = setGlobalTiming({ expirySec: 240 });
  assert.equal(s1.tfSec, 60);
  assert.equal(s1.expirySec, 240);

  // Change only tfSec to 300s (5m) while expirySec remains 240s
  const s2 = setGlobalTiming({ tfSec: 300 });
  assert.equal(s2.tfSec, 300);
  assert.equal(s2.expirySec, 240);

  // Change only expirySec to 30s (supported expiry, NOT a supported chart timeframe)
  const s3 = setGlobalTiming({ expirySec: 30 });
  assert.equal(s3.tfSec, 300);
  assert.equal(s3.expirySec, 30);
});

test("3. Broker timeframe & expiry validation rejects unsupported intervals cleanly", () => {
  for (const tf of BROKER_TIMEFRAMES) assert.equal(isSupportedTimeframe(tf), true);
  for (const exp of BROKER_EXPIRIES) assert.equal(isSupportedExpiry(exp), true);

  assert.equal(isSupportedTimeframe(30), false, "30s is not a supported global chart timeframe");
  assert.equal(isSupportedTimeframe(240), false, "240s is an expiry, not a chart timeframe");
  assert.throws(() => validateTimeframe(45), /Unsupported broker chart timeframe/);
  assert.throws(() => validateTimeframe(240), /Unsupported broker chart timeframe/);
  assert.throws(() => validateExpiry(45), /Unsupported broker trade expiry/);
  assert.throws(() => validateExpiry(7200), /Unsupported broker trade expiry/);
});

test("4. Transition gate blocks trades while agents sync and ignores stale syncVersion acks", () => {
  resetGlobalTimingForTests({ tfSec: 60, expirySec: 60, requiredAgents: ["frxXAUUSD", "R_100", "CRASH500"] });
  assert.equal(canExecuteTrade().ok, true);

  const next = setGlobalTiming({ tfSec: 300 });
  assert.equal(next.transitioning, true);
  assert.equal(next.pendingAgents.length, 3);

  const gate1 = canExecuteTrade();
  assert.equal(gate1.ok, false);
  assert.equal(gate1.transitioning, true);
  assert.match(gate1.reason, /Configuration transition in progress/);

  // Stale ack from syncVersion 1 must be ignored
  markAgentSynced("frxXAUUSD", 1);
  assert.equal(getGlobalTiming().syncedAgents.length, 0);

  // Partial acks from syncVersion 2 keep trade gate locked
  markAgentSynced("frxXAUUSD", next.syncVersion);
  markAgentSynced("R_100", next.syncVersion);
  assert.equal(canExecuteTrade().ok, false);
  assert.equal(canExecuteTrade().pendingCount, 1);

  // Final agent ack clears transition barrier
  const done = markAgentSynced("CRASH500", next.syncVersion);
  assert.equal(done.transitioning, false);
  assert.equal(canExecuteTrade().ok, true);
});

test("5. All agents (Gold frxXAUUSD + synthetics) receive uniform tfSec without silent per-market override", async () => {
  const agents = [
    { symbol: "frxXAUUSD", name: "Agent Gold-XAU", market: "Gold / USD (XAUUSD)" },
    { symbol: "R_100", name: "Agent Omega-100", market: "Volatility 100 Index" },
    { symbol: "1HZ10V", name: "Agent Nova-10V", market: "Volatility 10 (1s) Index" },
  ];
  resetGlobalTimingForTests({ tfSec: 60, expirySec: 240, requiredAgents: agents.map((a) => a.symbol) });

  const requestedTfs: Record<string, number[]> = { frxXAUUSD: [], R_100: [], "1HZ10V": [] };
  const T0 = 1_762_300_200; // multiple of 300
  const deps: WatcherDeps = {
    now: async () => T0 + 300 * 60 + 3,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 25))),
    fetchCandles: async (sym, tf, count) => {
      requestedTfs[sym].push(tf);
      return Array.from({ length: Math.min(count, 60) }, (_, i) => ({
        time: T0 + (i + 1) * tf,
        open: 100 + i * 0.1,
        high: 100.5 + i * 0.1,
        low: 99.5 + i * 0.1,
        close: 100.2 + i * 0.1,
      }));
    },
  };

  const watcher = new SweepWatcherService({ agents, deps, tf: 60 });
  const next = setGlobalTiming({ tfSec: 300 });
  watcher.syncTimeframe(next.tfSec, next.syncVersion, 0);
  await new Promise((r) => setTimeout(r, 40));
  watcher.stop();
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(requestedTfs.frxXAUUSD.length >= 1, "Gold agent should have polled at least once");
  assert.ok(requestedTfs.frxXAUUSD.every((tf) => tf === 300), "Gold must use global 300s TF (no silent 1m override)");
  assert.ok(requestedTfs.R_100.length >= 1 && requestedTfs.R_100.every((tf) => tf === 300));
  assert.ok(requestedTfs["1HZ10V"].length >= 1 && requestedTfs["1HZ10V"].every((tf) => tf === 300));

  const snap = getGlobalTiming();
  assert.equal(snap.transitioning, false, "all 3 agents should have confirmed syncVersion");
  assert.equal(canExecuteTrade().ok, true);
});

test("6. Closed candle filtering & cross-market timestamp synchronization check", () => {
  const tf = 60;
  const now = 1_762_300_080; // exactly 60s * k
  const raw: C[] = [
    { time: now - 180, open: 10, high: 11, low: 9, close: 10.5 },
    { time: now - 120, open: 10.5, high: 11.5, low: 10, close: 11 },
    { time: now - 60, open: 11, high: 12, low: 10.5, close: 11.2 }, // closed (end === now)
    { time: now, open: 11.2, high: 13, low: 8, close: 9 },         // forming!
    { time: now - 30, open: 11, high: 11, low: 11, close: 11, closed: false } as C, // explicitly open
  ];
  const closed = filterClosedCandles(raw, tf, now);
  assert.equal(closed.length, 3);
  assert.equal(closed[closed.length - 1].time, now - 60);
  assert.equal(isCandleClosed(now, tf, now + 30), false);
  assert.equal(isCandleClosed(now, tf, now + 60), true);

  const aligned = areMarketTimestampsSynchronized(
    [
      { symbol: "frxXAUUSD", lastCandle: now - 60 },
      { symbol: "R_100", lastCandle: now - 60 },
      { symbol: "JD75", lastCandle: now - 120 },
    ],
    60,
    1
  );
  assert.equal(aligned.synchronized, true);

  const lagged = areMarketTimestampsSynchronized(
    [
      { symbol: "frxXAUUSD", lastCandle: now - 60 },
      { symbol: "R_100", lastCandle: now - 360 },
    ],
    60,
    1
  );
  assert.equal(lagged.synchronized, false);
  assert.deepEqual(lagged.laggedSymbols, ["R_100"]);
});

test("7. AI prompt builder injects active global tfSec & expirySec accurately", () => {
  resetGlobalTimingForTests({ tfSec: 300, expirySec: 240 });
  const closed = withSweep(market("up"), "BUY");
  const last = closed[closed.length - 1];
  const pattern = verifyPattern({ side: "BUY", sweep: { side: "BUY" } }, closed, last.time);
  const quality = assessMarketQuality("BUY", closed, null);
  const req = buildAiRequest({
    engine: { side: "BUY", confidence: 78, agree: 2, reasons: ["test sweep"] },
    label: "Gold / USD (XAUUSD)",
    tf: 300,
    closed,
    pattern,
    quality,
    condition: null,
    image: null,
    key: "test:frxXAUUSD",
  });
  assert.match(req.prompt, /Chart Timeframe: 300s\. Trade Expiry: 240s\./);
});

test("8. Backtest configuration helper reads central timing cleanly", () => {
  resetGlobalTimingForTests({ tfSec: 180, expirySec: 240 });
  const cfg = backtestConfigFromGlobal();
  assert.equal(cfg.tf, 180);
  assert.deepEqual(cfg.expiries, [240]);

  registerRequiredAgents([]);
  const custom = backtestConfigFromGlobal({ tf: 60, expiries: [60, 240] });
  assert.equal(custom.tf, 60);
  assert.deepEqual(custom.expiries, [60, 240]);
});
