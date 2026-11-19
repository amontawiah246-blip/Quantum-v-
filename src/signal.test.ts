// These tests exercise the sweep-based claims of the signal path (legacy mode). The default mode is covered by src/stochRsi.test.ts.
process.env.STRATEGY_MODE = 'legacy';
// Signal pipeline basics (the older tests, updated: the AI can no longer veto a valid pattern or approve by itself).
// The detailed cases for the verification itself are in src/aiVerification.test.ts.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getSignal, merge, resetSignalCaches } from "../signalServer";
import { parseAiResponse, buildAiRequest } from "./aiVerification";
import { TF, engine, fakeAi, fakeRasterizer, market, nowAfter, withSweep } from "./aiFixtures";

beforeEach(() => resetSignalCaches());
const cs = withSweep(market("up"), "BUY");
const mk = (ai: any, o: any = {}) => ({ engines: async () => engine("BUY"), ai, rasterizer: fakeRasterizer, now: () => nowAfter(cs), ...o });

test("no engine setup means no AI call and no trade", async () => {
  const ai = fakeAi();
  const s = await getSignal(mk(ai, { engines: async () => engine("BUY", { setup: false, side: null, status: "no liquidity sweep" }) }), cs, TF, "EURUSD", "s1");
  assert.equal(ai.calls.length, 0); assert.equal(s.setup, false); assert.equal(s.tradeable, false);
});

test("AI confirms: tradeable, and the AI can only lower the ranking, never raise the engine's confidence", async () => {
  const s = await getSignal(mk(fakeAi()), cs, TF, "EURUSD", "s2");
  assert.equal(s.tradeable, true); assert.equal(s.side, "buy"); assert.ok(s.confidence <= 75);
  assert.equal(s.ai?.status, "approved");
});

test("a broken or missing AI never makes a tradeable signal and never an approval", async () => {
  for (const ai of [null, fakeAi(() => "I think buy"), async () => { throw new Error("boom"); }] as any[]) {
    resetSignalCaches();
    const s = await getSignal(mk(ai), cs, TF, "EURUSD", "s3");
    assert.equal(s.tradeable, false); assert.equal(s.setup, true); assert.equal(s.ai?.status, "unavailable"); assert.equal(s.decision, "AI_UNAVAILABLE");
  }
});

test("the same candle is only sent to the AI once", async () => {
  const ai = fakeAi();
  await getSignal(mk(ai), cs, TF, "EURUSD", "s4"); await getSignal(mk(ai), cs, TF, "EURUSD", "s4");
  assert.equal(ai.calls.length, 1);
});

test("parse + merge basics", async () => {
  const ai = fakeAi();
  await getSignal(mk(ai), cs, TF, "EURUSD", "s5");
  const req = ai.calls[0];
  assert.throws(() => parseAiResponse('{"verdict":"maybe"}', req, true));
  assert.match(req.prompt, /EURUSD/);
  assert.equal(req.prompt.split("\n").filter((l) => /^\d{10},/.test(l)).length, 60);
  assert.equal(merge(engine("BUY"), null, 0, 60).tradeable, false);
  assert.ok(typeof buildAiRequest === "function");
});
