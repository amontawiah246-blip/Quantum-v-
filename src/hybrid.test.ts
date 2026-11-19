import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { Candle } from "./candleMath";
import { synthCandles } from "./syntheticData";
import { IndicatorTracker, indicatorSeries, referenceAtr, referenceEma } from "./hybridIndicators";
import { HYBRID_DEFAULTS, hybridConfig, diffFromDefaults } from "./hybridConfig";
import { CONTINUATION_DEFAULTS, detectContinuationSignal } from "./continuationEngine";
import { MOMENTUM_DEFAULTS, detectMomentumSignal } from "./momentumEngine";
import { SEQUENCE_DEFAULTS } from "./sequenceClassifier";
import { isSweep } from "./sweepPatterns";
import { STAGE1_FROZEN, detectStage1 } from "./hybridSetups";
import { detectEqualLevelSweep } from "./equalLevelSweeps";
import { HybridEngine, runHybrid } from "./hybridEngine";
import { HybridModel, ModelBundle, loadModel, scoreWith, ScoreModelSpec } from "./hybridModel";
import { evaluateEvidence } from "./hybridFeatures";
import { buildDataset } from "./hybridDataset";
import { crossCheckDetectors } from "./hybridDiagnostics";
import { evaluateEngines } from "./engineEvaluator";

const TF = 300, T0 = 1_762_300_200;
const SYN = synthCandles({ n: 6000, seed: 11, tf: TF });
const ind = { adx: { period: 14 }, atr: { period: 14, medianLookback: 100 }, ema: { fast: 20, slow: 50, slopeLookback: 3 } };

test("indicators: EMA and ATR match independent textbook references", () => {
  const s = indicatorSeries(SYN.slice(0, 500), ind);
  const e20 = referenceEma(SYN.slice(0, 500).map((c) => c.close), 20), e50 = referenceEma(SYN.slice(0, 500).map((c) => c.close), 50), a = referenceAtr(SYN.slice(0, 500), 14);
  for (let i = 60; i < 500; i += 7) { assert.ok(Math.abs(s[i].emaFast - e20[i]) < 1e-9); assert.ok(Math.abs(s[i].emaSlow - e50[i]) < 1e-9); assert.ok(Math.abs(s[i].atr - a[i]) < 1e-9); }
});

test("indicators: ADX is high in a steady trend and low in a range; every snapshot depends on candles <= i only", () => {
  const trend: Candle[] = Array.from({ length: 120 }, (_, i) => ({ time: T0 + i * TF, open: 100 + i, high: 101.2 + i, low: 99.9 + i, close: 101 + i }));
  const range: Candle[] = Array.from({ length: 120 }, (_, i) => ({ time: T0 + i * TF, open: 100, high: 101.1, low: 98.9, close: 100 + (i % 2 ? 0.4 : -0.4) }));
  assert.ok(indicatorSeries(trend, ind).at(-1)!.adx > 50);
  assert.ok(indicatorSeries(range, ind).at(-1)!.adx < 20);
  const full = indicatorSeries(SYN.slice(0, 400), ind), cut = indicatorSeries(SYN.slice(0, 250), ind);
  for (let i = 0; i < 250; i++) assert.deepEqual(cut[i], full[i]);
  const t = new IndicatorTracker(ind); assert.ok(Number.isNaN(t.update(SYN[0]).adx), "no value before warm-up");
});

test("configuration: every change from the defaults is listed; a 5-minute chart and expiry are locked", () => {
  assert.deepEqual(diffFromDefaults(HYBRID_DEFAULTS), []);
  const c = hybridConfig({ indicators: { adx: { enabled: false } }, ml: { payout: 0.85 } });
  assert.deepEqual(diffFromDefaults(c).sort(), ["indicators.adx.enabled: true -> false", "ml.payout: 0.9 -> 0.85"]);
  assert.throws(() => new HybridEngine("X", { ...HYBRID_DEFAULTS, tfSec: 60 }), /5-minute/);
  assert.throws(() => new HybridEngine("X", { ...HYBRID_DEFAULTS, expirySec: 600 }), /5-minute/);
});

test("Stage 1 is frozen: parameters equal the originals and hits equal the original detectors on 6000 candles", () => {
  assert.equal(STAGE1_FROZEN.continuation, CONTINUATION_DEFAULTS); assert.equal(STAGE1_FROZEN.momentum, MOMENTUM_DEFAULTS); assert.equal(STAGE1_FROZEN.sequence, SEQUENCE_DEFAULTS);
  assert.deepEqual(STAGE1_FROZEN.sweepDefinition, { ...CONTINUATION_DEFAULTS });
  let seen = 0;
  for (let i = 150; i < SYN.length; i++) {
    const h = detectStage1(SYN, i, null).hits;
    const c = detectContinuationSignal(SYN, i), m = detectMomentumSignal(SYN, i);
    assert.equal(h.find((x) => x.id === "SWEEP_CONTINUATION")?.side ?? null, c?.side ?? null);
    assert.equal(h.find((x) => x.id === "MOMENTUM_BODY_DOMINANCE")?.side ?? null, m?.side ?? null);
    assert.equal(h.some((x) => x.id === "BEARISH_SWEEP"), isSweep("SELL", SYN[i - 1], SYN[i], CONTINUATION_DEFAULTS));
    assert.equal(h.some((x) => x.id === "BULLISH_SWEEP"), isSweep("BUY", SYN[i - 1], SYN[i], CONTINUATION_DEFAULTS));
    seen += h.length;
  }
  assert.ok(seen > 200);
});

test("equal-level sweeps: a hand-built equal-highs sweep fires, a plain touch or a body break does not; brute-force cross-check agrees on 6000 candles", () => {
  const base: Candle[] = Array.from({ length: 16 }, (_, i) => ({ time: T0 + i * TF, open: 100, high: 101, low: 99, close: 100.2 + (i % 2) * 0.1 }));
  base[5] = { ...base[5], high: 102 }; base[9] = { ...base[9], high: 102.02 };           // two equal highs near 102
  const sw: Candle = { time: T0 + 16 * TF, open: 101, high: 103, low: 100.6, close: 100.8 };    // bearish, wicks above 102.02, closes back below, open below the level
  const cs = [...base, sw];
  assert.ok(detectEqualLevelSweep(cs, 16, "SELL"));
  assert.equal(detectEqualLevelSweep(cs, 16, "BUY"), null);
  assert.equal(detectEqualLevelSweep([...base, { ...sw, high: 102.01 }], 16, "SELL"), null, "does not exceed the level");
  assert.equal(detectEqualLevelSweep([...base, { ...sw, close: 102.5, open: 101.5 }], 16, "SELL"), null, "bullish body break is not a sweep");
  const r = runHybrid(SYN, "SYN", hybridConfig({ mode: "A" }));
  const hits = r.decisions.map((d) => new Set(d.records.flatMap((x) => x.patterns)));
  const x = crossCheckDetectors(SYN, (i) => hits[i]);
  assert.ok(x.checked > 5000); assert.deepEqual(x.mismatches, []);
});

test("indicators and the model can NOT create, remove or change a setup: candidates are identical in every mode and indicator switch", () => {
  const sig = (cfg: ReturnType<typeof hybridConfig>) => runHybrid(SYN.slice(0, 3000), "SYN", cfg).decisions.flatMap((d) => d.records.map((r) => `${r.time}|${r.side}|${r.patterns.join("+")}`));
  const a = sig(hybridConfig({ mode: "A" }));
  assert.ok(a.length > 100);
  assert.deepEqual(sig(hybridConfig({ mode: "B" })), a);
  assert.deepEqual(sig(hybridConfig({ mode: "B", indicators: { adx: { enabled: false }, atr: { enabled: false }, ema: { enabled: false } } })), a);
  assert.deepEqual(sig(hybridConfig({ mode: "D" })), a);                         // no model: still the same candidates, just no trades
});

test("features are causal: the record for candle i is identical when the series is cut right after i", () => {
  const cfg = hybridConfig({ mode: "A", log: { keepFeatures: true, maxRecords: 1e9 } as any });
  const full = runHybrid(SYN.slice(0, 1500), "SYN", cfg).engine.log;
  const cut = runHybrid(SYN.slice(0, 900), "SYN", cfg).engine.log;
  assert.ok(cut.length > 20);
  const key = (r: (typeof full)[number]) => JSON.stringify([r.time, r.side, r.patterns, r.features, r.stage2.evidence.qualityScore]);
  for (let k = 0; k < cut.length; k++) assert.equal(key(cut[k]), key(full[k]));
});

test("Stage 2 gate: one disagreeing indicator never vetoes; unanimous disagreement does; a switched-off indicator is not counted", () => {
  const cfg = hybridConfig();
  const f = (adx: number, atrRatio: number, gap: number, slope: number) => ({ adx, di_diff: -5, atr_ratio: atrRatio, ema_gap_atr: gap, ema_slope_atr: slope });
  const one = evaluateEvidence(f(10, 1, 0.5, 0.2), "CONTINUATION", cfg);          // ADX weak -> contradicts, ATR and EMA support
  assert.equal(one.adx, "CONTRADICTS"); assert.equal(one.gatePass, true);
  const all = evaluateEvidence(f(10, 3, -0.5, -0.2), "CONTINUATION", cfg);
  assert.equal(all.contradicting, 3); assert.equal(all.gatePass, false); assert.ok(all.veto);
  const off = evaluateEvidence(f(10, 3, -0.5, -0.2), "CONTINUATION", hybridConfig({ indicators: { ema: { enabled: false } } }));
  assert.equal(off.ema, "DISABLED"); assert.equal(off.available, 2); assert.equal(off.gatePass, false);
  const solo = evaluateEvidence(f(10, 3, -0.5, -0.2), "CONTINUATION", hybridConfig({ indicators: { ema: { enabled: false }, atr: { enabled: false } } }));
  assert.equal(solo.gatePass, true, "a single available indicator cannot veto");
  const nan = evaluateEvidence({ adx: NaN, di_diff: NaN, atr_ratio: NaN, ema_gap_atr: NaN, ema_slope_atr: NaN }, "REVERSAL", cfg);
  assert.equal(nan.available, 0); assert.equal(nan.gatePass, true);
});

test("engine: no model means no probability; AUTO says it runs B; explicit C/D without a model never trades", () => {
  const rs = (mode: any) => runHybrid(SYN.slice(0, 3000), "SYN", hybridConfig({ mode }));
  const auto = rs("AUTO").decisions.filter((d) => d.records.length);
  assert.ok(auto.length > 50);
  assert.ok(auto.every((d) => d.mode === "B" && d.probability === null && /no trained model/.test(d.modeNote ?? "")));
  assert.ok(auto.some((d) => d.action !== "NO_TRADE"));
  for (const m of ["C", "D"]) {
    const ds = rs(m).decisions;
    assert.ok(ds.every((d) => d.action === "NO_TRADE" && d.probability === null));
    assert.ok(ds.flatMap((d) => d.records).every((r) => r.rejectionStage === "MODEL_UNAVAILABLE" || r.rejectionStage === "STAGE2_INDICATORS"));
  }
});

test("engine: unfinished, duplicate, invalid and gapped candles are rejected or reset, and every setup keeps a logged reason", () => {
  const e = new HybridEngine("SYN", hybridConfig({ mode: "A" }));
  SYN.slice(0, 200).forEach((c) => e.step(c));
  assert.match(e.step({ ...SYN[200], closed: false }).reason, /CANDLE_NOT_CLOSED/);
  assert.match(e.step({ ...SYN[199] }).reason, /DUPLICATE/);
  assert.match(e.step({ ...SYN[200], high: SYN[200].low - 1 }).reason, /DATA_INVALID/);
  const g = new HybridEngine("SYN", hybridConfig({ mode: "A" }));
  SYN.slice(0, 200).forEach((c) => g.step(c));
  const after = g.step(SYN[205]);                                              // 5 candles missing
  assert.equal(after.stage, "WARMUP"); assert.equal(g.diag.health.gapEvents, 1); assert.equal(g.diag.health.missingCandles, 5);
  const r = runHybrid(SYN.slice(0, 2500), "SYN", hybridConfig({ mode: "B" }));
  for (const rec of r.engine.log) if (rec.decision === "NO_TRADE") assert.ok(rec.rejectionStage && rec.rejectionReason);
  const d = r.engine.diag.report();
  assert.equal(d.candidates, d.traded + Object.values(d.rejectedBy).reduce((s, x) => s + (x ?? 0), 0), "funnel adds up");
});

test("engine: wrong timeframe is refused instead of being treated as 5-minute data", () => {
  const e = new HybridEngine("SYN", hybridConfig({ mode: "A" }));
  const m1 = synthCandles({ n: 300, seed: 3, tf: 60 });
  const last = m1.map((c) => e.step(c)).at(-1)!;
  assert.match(last.reason, /TIMEFRAME_MISMATCH/);
});

test("model runtime: tree walk, missing values, calibration, synthetic-model refusal, instrument check", () => {
  const spec: ScoreModelSpec = { kind: "lightgbm", featureNames: ["a", "b"], indicatorsUsed: [], calibration: { type: "none" }, threshold: 0.6, thresholdNote: "",
    lightgbm: { trees: [{ f: 0, t: 1, dl: true, mt: 2, l: { v: -1 }, r: { f: 1, t: 0, dl: false, mt: 0, l: { v: 0.5 }, r: { v: 2 } } }] } };
  const sg = (z: number) => 1 / (1 + Math.exp(-z));
  assert.ok(Math.abs(scoreWith(spec, { a: 0.5, b: 3 }).raw - sg(-1)) < 1e-12);
  assert.ok(Math.abs(scoreWith(spec, { a: 2, b: -1 }).raw - sg(0.5)) < 1e-12);
  assert.ok(Math.abs(scoreWith(spec, { a: 2, b: 1 }).raw - sg(2)) < 1e-12);
  assert.ok(Math.abs(scoreWith(spec, { a: NaN, b: 1 }).raw - sg(-1)) < 1e-12, "NaN follows default_left");
  const platt = scoreWith({ ...spec, calibration: { type: "platt", a: 2, b: 0 } }, { a: 0.5, b: 3 });
  assert.ok(Math.abs(platt.probability - sg(2 * -1)) < 1e-9);
  const iso = scoreWith({ ...spec, calibration: { type: "isotonic", x: [0, 0.5, 1], y: [0.1, 0.4, 0.9] } }, { a: 2, b: 1 });
  assert.ok(iso.probability > 0.4 && iso.probability < 0.9);
  const bundle: ModelBundle = { schema: "quantum-hybrid-model/1", createdAt: "", modelId: "t", synthetic: true, instruments: ["EURUSD"], payout: 0.9, data: { rows: 0, from: 0, to: 0, splits: {} }, models: { D: { ...spec, indicatorsUsed: ["adx"] } } };
  const m = new HybridModel(bundle);
  assert.ok(m.problems("D", hybridConfig(), "EURUSD").some((p) => /SYNTHETIC/.test(p)));
  assert.ok(m.problems("D", hybridConfig({ ml: { allowSyntheticModel: true } as any, indicators: { adx: { enabled: false } } }), "GBPUSD").length >= 2);
  assert.ok(m.problems("C", hybridConfig()).some((p) => /no C model/.test(p)));
});

const DEMO = "docs/hybrid/synthetic_demo";
test("cross-language parity: TypeScript scores equal the Python model on the exported fixture rows", { skip: !existsSync(`${DEMO}/hybrid_model.json`) }, () => {
  const model = loadModel(`${DEMO}/hybrid_model.json`)!;
  const fix = JSON.parse(readFileSync(`${DEMO}/parity_fixture.json`, "utf8")) as Record<"C" | "D", Array<{ features: Record<string, number | null>; raw: number; probability: number }>>;
  let n = 0;
  for (const kind of ["C", "D"] as const) for (const row of fix[kind] ?? []) {
    const f = Object.fromEntries(Object.entries(row.features).map(([k, v]) => [k, v === null ? NaN : v]));
    const s = model.score(kind, f)!;
    assert.ok(Math.abs(s.raw - row.raw) < 1e-9, `${kind} raw ${s.raw} vs ${row.raw}`);
    assert.ok(Math.abs(s.probability - row.probability) < 1e-9);
    n++;
  }
  assert.ok(n >= 100);
});

test("a trained (synthetic-demo) model is used only when explicitly allowed, and then produces probabilities and trades", { skip: !existsSync(`${DEMO}/hybrid_model.json`) }, () => {
  const model = loadModel(`${DEMO}/hybrid_model.json`)!;
  const cs = synthCandles({ n: 4000, seed: 2002, tf: TF, persistence: 0.3 });
  const symbol = model.bundle.instruments[0];
  const blocked = runHybrid(cs, symbol, hybridConfig({ mode: "D" }), model).decisions.flatMap((d) => d.records);
  assert.ok(blocked.length > 0 && blocked.every((r) => r.decision === "NO_TRADE" && /SYNTHETIC/.test(r.stage3.problems.join())));
  const ok = runHybrid(cs, symbol, hybridConfig({ mode: "D", ml: { allowSyntheticModel: true } as any }), model).decisions;
  const withP = ok.flatMap((d) => d.records).filter((r) => r.stage3.probability !== null);
  assert.ok(withP.length > 100);
  assert.ok(withP.every((r) => r.stage3.probability! > 0 && r.stage3.probability! < 1));
  for (const d of ok) if (d.action !== "NO_TRADE") { assert.ok(d.probability! >= d.records.find((r) => r.decision !== "NO_TRADE")!.stage3.required!); assert.equal(d.executeAfter, d.time + TF); assert.equal(d.expirySec, 300); }
});

test("dataset: one row per (instrument, candle, side); outcome = next open vs next close; identical instruments are refused; warm-up rows excluded", () => {
  const a = synthCandles({ n: 1500, seed: 5, tf: TF }), b = synthCandles({ n: 1500, seed: 6, tf: TF });
  const { rows, meta } = buildDataset([{ symbol: "A", candles: a }, { symbol: "B", candles: b }], { synthetic: true, payout: 0.9 });
  assert.ok(rows.length > 100); assert.equal(meta.rows, rows.length); assert.equal(meta.synthetic, true);
  assert.equal(new Set(rows.map((r) => `${r.symbol}|${r.signal_time}|${r.side}`)).size, rows.length);
  const idx = new Map(a.map((c, i) => [c.time, i]));
  for (const r of rows.filter((x) => x.symbol === "A").slice(0, 200)) {
    const i = idx.get(r.signal_time)!; assert.ok(i >= 119);
    assert.equal(r.entry, a[i + 1].open); assert.equal(r.exit, a[i + 1].close); assert.equal(r.settle_time - r.entry_time, 300);
    const win = r.side === "BUY" ? a[i + 1].close > a[i + 1].open : a[i + 1].close < a[i + 1].open;
    assert.equal(r.result === "win", win);
    for (const v of Object.values(r.features)) assert.ok(typeof v === "number");
  }
  assert.throws(() => buildDataset([{ symbol: "A", candles: a }, { symbol: "A2", candles: a }]), /identical candles/);
});

test("evaluateEngines exposes the hybrid verdict additively (and never changes the existing result fields)", () => {
  const cs = SYN.slice(0, 400).map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
  const r = evaluateEngines(cs, 300);
  assert.ok(r.hybrid, "hybrid view present for a 5-minute chart");
  assert.match(r.hybrid!.note, /hybridGate\.ts/);   // AutoTrading now reads the verdict, only through the gate
  assert.equal(typeof r.hybrid!.bySide, "object");
  const r60 = evaluateEngines(cs, 60);
  assert.equal(r60.hybrid?.action ?? "NO_TRADE", "NO_TRADE");
});
