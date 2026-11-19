import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEngines, evaluateIntelligence } from "./engineEvaluator";
import { synthCandles } from "./syntheticData";

test("evaluator: the Engines 7-12 view is additive and leaves the existing setup/votes unchanged", () => {
  const cs = synthCandles({ n: 300, seed: 3 });
  const r = evaluateEngines(cs, 300);
  assert.ok(r.intelligence);
  const { intelligence, ...rest } = r;
  const again = evaluateEngines(cs, 300);
  delete (again as any).intelligence;
  assert.deepEqual(rest, again);
  assert.equal(r.intelligence!.expirySec, 300, "5-minute chart: 5-minute expiry");
  assert.equal(evaluateEngines(cs, 900).intelligence!.expirySec, 900);
});

test("evaluator: a signal is only offered for after the signal candle has closed", () => {
  const cs = synthCandles({ n: 6000, seed: 21 });
  let found = 0;
  for (let end = 300; end <= 6000 && found < 5; end += 7) {
    const v = evaluateIntelligence(cs.slice(end - 300, end), 300);
    if (v.action !== "NO_TRADE") { found++; assert.equal(v.executeAfter, v.signalCandleTime! + 300); assert.equal(v.signalCandleTime, cs[end - 1].time); assert.ok(v.explanation); }
    else { assert.equal(v.executeAfter, null); }
  }
  assert.ok(found > 0);
});
