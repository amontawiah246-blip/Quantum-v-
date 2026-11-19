// THE INDICATOR STRATEGY (Stochastic + RSI trigger, confirmed by a candle pattern): the default mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STOCH_RSI_DEFAULTS, computeStochRsi, findTrigger, rsiEvent, stochEvent, type StochRsiSeries } from './stochRsi';
import { detectStochRsi, findConfirmations, type C } from './sweepEngines';
import { detectCandlestick } from './candlePatterns';
import { RULE_TEXT, verifyPattern } from './patternVerification';
import { evaluateEngines } from './engineEvaluator';
import { renderIndicatorSvg } from './indicatorChart';
import { SweepWatcherService, WatcherDeps } from './sweepWatcherCore';
import { CandidateHub } from './candidateHub';
import { SYSTEM_PROMPT, boundedConfidence, buildAiRequest, parseAiResponse, indicatorEvidence } from './aiVerification';
import { assessMarketQuality } from './marketQuality';
import { marketCondition } from './conditions';

delete process.env.STRATEGY_MODE;          // the default mode

const TF = 300;
const raw = fs.readFileSync(new URL('../fixtures/r75_m5_live_slice.csv', import.meta.url), 'utf8').trim().split('\n').slice(1);
const CS: C[] = raw.map((l) => { const f = l.trim().split(','); return { time: +f[0], open: +f[1], high: +f[2], low: +f[3], close: +f[4] }; });
const P = STOCH_RSI_DEFAULTS;
const win = (i: number) => CS.slice(Math.max(0, i - 149), i + 1);

/** every candle of the fixture on which the indicator strategy fires */
function hits() {
  const out: { i: number; v: NonNullable<ReturnType<typeof detectStochRsi>> }[] = [];
  for (let i = 60; i < 900; i++) { const w = win(i); const v = detectStochRsi(w, w.length - 1); if (v) out.push({ i, v }); }
  return out;
}
const HITS = hits();

// ------------------------------------------------------------------------------------------------ the indicators
test('Stochastic (14,3,3) and RSI (14): values stay in range, a steady climb gives RSI 100 and %K near 100', () => {
  const up: C[] = Array.from({ length: 60 }, (_, i) => ({ time: i * 60, open: 100 + i, high: 101 + i, low: 99.5 + i, close: 100.8 + i }));
  const s = computeStochRsi(up);
  assert.equal(s.rsi[59], 100);
  assert.ok((s.k[59] as number) > 80 && (s.k[59] as number) <= 100);
  const real = computeStochRsi(CS.slice(0, 400));
  for (const arr of [real.k, real.d, real.rsi]) for (const v of arr) if (v != null) assert.ok(v >= 0 && v <= 100);
  assert.equal(real.k[12], null);          // 14 candles + 3 smoothing needed before the first %K
  assert.ok(real.k[15] != null);
  assert.equal(real.rsi[13], null);
  assert.ok(real.rsi[14] != null);
});

test('no look-ahead: the result on candle i is the same whether or not later candles exist', () => {
  for (const { i } of HITS.slice(0, 25)) {
    const a = detectStochRsi(CS.slice(0, i + 1), i), b = detectStochRsi(CS.slice(0, i + 400), i);
    assert.deepEqual(a, b);
  }
});

// ------------------------------------------------------------------------------------------------ the trigger
const fakeSeries = (n: number, k: Record<number, number>, rsi: Record<number, number>, kd = 50, rd = 40): StochRsiSeries => ({
  k: Array.from({ length: n }, (_, i) => k[i] ?? kd), d: Array.from({ length: n }, () => 50), rsi: Array.from({ length: n }, (_, i) => rsi[i] ?? rd),
});
const dummy: C[] = Array.from({ length: 80 }, (_, i) => ({ time: i * 60, open: 1, high: 1, low: 1, close: 1 }));

test('BUY trigger: %K crosses UP through 20 AND RSI crosses UP through 30 or 50; the second crossing completes on the signal candle', () => {
  const i = 70;
  let s = fakeSeries(80, { 69: 15, 70: 22 }, { 69: 28, 70: 33 });
  const t = findTrigger(dummy, i, P, s)!;
  assert.equal(t.side, 'BUY'); assert.equal(t.index, i); assert.equal(t.stoch.level, 20); assert.equal(t.rsi.level, 30);
  s = fakeSeries(80, { 69: 15, 70: 22 }, { 69: 46, 70: 52 });                    // RSI through 50 also counts
  assert.equal(findTrigger(dummy, i, P, s)!.rsi.level, 50);
  s = fakeSeries(80, { 69: 15, 70: 22 }, { 69: 36, 70: 44 });                    // RSI crossed nothing: no trigger
  assert.equal(findTrigger(dummy, i, P, s), null);
  s = fakeSeries(80, { 69: 25, 70: 27 }, { 69: 28, 70: 33 });                    // %K was already above 20: no cross
  assert.equal(findTrigger(dummy, i, P, s), null);
});

test('SELL trigger: %K crosses DOWN through 80 AND RSI crosses DOWN through 70 or 50', () => {
  const s = fakeSeries(80, { 69: 85, 70: 77 }, { 69: 72, 70: 68 }, 50, 60);
  const t = findTrigger(dummy, 70, P, s)!;
  assert.equal(t.side, 'SELL'); assert.equal(t.stoch.level, 80); assert.equal(t.rsi.level, 70);
  const s2 = fakeSeries(80, { 69: 85, 70: 77 }, { 69: 55, 70: 48 }, 50, 60);
  assert.equal(findTrigger(dummy, 70, P, s2)!.rsi.level, 50);
});

test('the two crossings may be a few candles apart (alignment window) but not further', () => {
  // %K crossed on candle 68, RSI crosses on candle 70: two candles apart, inside the window of 3
  const near = fakeSeries(80, { 67: 15, 68: 22, 69: 30 }, { 69: 28, 70: 33 });
  assert.equal(findTrigger(dummy, 70, P, near)?.side, 'BUY');
  // %K crossed on candle 66, RSI on 70: four candles apart
  const far = fakeSeries(80, { 65: 15, 66: 22, 67: 30 }, { 69: 28, 70: 33 });
  assert.equal(findTrigger(dummy, 70, P, far), null);
  // the trigger fires on the candle where the SECOND crossing completes, not before
  assert.equal(findTrigger(dummy, 69, P, near), null);
});

test('a trigger that already fired on the previous candle is not a new direction', () => {
  // RSI crosses 30 on candle 69 and 50 on candle 70, %K crossed on 69: it fired on 69, so 70 is a repeat
  const s = fakeSeries(80, { 68: 15, 69: 22, 70: 30 }, { 68: 28, 69: 33, 70: 52 }, 50, 40);
  s.rsi[69] = 33; s.rsi[68] = 28; s.rsi[70] = 52;
  assert.equal(findTrigger(dummy, 69, P, s)?.side, 'BUY');
  assert.equal(findTrigger(dummy, 70, P, s), null);
});

test('stochEvent / rsiEvent report the exact crossing', () => {
  const s = fakeSeries(80, { 10: 19.9, 11: 20 }, { 10: 49.9, 11: 50.1 });
  assert.deepEqual(stochEvent(s, 11, 'BUY'), { index: 11, from: 19.9, to: 20, level: 20 });
  assert.equal(stochEvent(s, 11, 'SELL'), null);
  assert.equal(rsiEvent(s, 11, 'BUY')?.level, 50);
  assert.equal(rsiEvent(s, 11, 'SELL'), null);
});

// ------------------------------------------------------------------------------------------------ the candle-pattern confirmation
test('the indicator trigger needs a candle pattern in the same direction in the last candles; without one it is SKIPPED and never traded', () => {
  assert.ok(HITS.length > 10, `fixture has plenty of triggers (${HITS.length})`);
  const ok = HITS.filter((h) => h.v.ok), skipped = HITS.filter((h) => !h.v.ok);
  assert.ok(ok.length > 5 && skipped.length >= 1, `confirmed ${ok.length}, unconfirmed ${skipped.length}`);
  for (const { i, v } of ok) {
    assert.ok(v.stochRsi && v.stochRsi.confirmations.length >= 1);
    for (const c of v.stochRsi.confirmations) {
      const age = (CS[i].time - c.time) / TF;
      assert.ok(age >= 0 && age < P.confirmLookback, `confirmation ${age} candles old`);
    }
    assert.equal(v.tradeAtNextOpen, true);
    assert.ok(v.trace!.some((t) => /Stochastic %K crossed/.test(t)) && v.trace!.some((t) => /RSI crossed/.test(t)));
  }
  for (const { v } of skipped) { assert.equal(v.ok, false); assert.match(v.block!, /no candle pattern confirms/); assert.equal(v.stochRsi, undefined); }
});

test('every candle-pattern strategy can confirm: wick sweep, continuation, momentum, LSCC, structure sweep and the candlestick pattern', () => {
  const seen = new Set<string>();
  for (let i = 60; i < CS.length; i += 1) {
    const w = win(i);
    for (const side of ['BUY', 'SELL'] as const) for (const c of findConfirmations(w, w.length - 1, side, 5)) seen.add(c.engine);
  }
  assert.ok(seen.has('sweep') && seen.has('candlestick') && seen.has('momentum') && seen.has('continuation'), [...seen].join(','));
});

test('the candlestick-pattern engine keeps its rules (pinbar / hammer, shooting star, engulfing)', () => {
  const mk = (o: number, h: number, l: number, c: number, t = 0): C => ({ time: t, open: o, high: h, low: l, close: c });
  assert.equal(detectCandlestick([mk(10, 10.2, 8, 10.1)], 0)?.patterns[0], 'Bullish Pinbar / Hammer');
  assert.equal(detectCandlestick([mk(10, 12, 9.8, 9.9)], 0)?.patterns[0], 'Bearish Shooting Star');
  assert.equal(detectCandlestick([mk(10, 10.1, 9, 9.2), mk(9, 10.8, 8.9, 10.6, 60)], 1)?.patterns[0], 'Bullish Engulfing Pattern');
  assert.equal(detectCandlestick([mk(10, 11, 9.9, 10.9), mk(11.2, 11.3, 9.5, 9.7, 60)], 1)?.patterns[0], 'Bearish Engulfing Pattern');
});

// ------------------------------------------------------------------------------------------------ the engine result (default mode)
test('default mode: a setup exists ONLY when the indicator trigger is confirmed; the old RSI < 32 / EMA votes are gone', () => {
  const good = HITS.find((h) => h.v.ok)!;
  const r = evaluateEngines(CS.slice(0, good.i + 1), TF, 1, 'R_75');
  assert.equal(r.setup, true); assert.equal(r.side, good.v.side); assert.ok(r.stochRsi);
  assert.ok(r.reasons.some((x) => /Stochastic \+ RSI/.test(x)) && r.reasons.some((x) => /Candle confirmation/.test(x)));
  assert.ok(r.confidence >= 70 && r.confidence <= 85);
  const bad = HITS.find((h) => !h.v.ok)!;
  const r2 = evaluateEngines(CS.slice(0, bad.i + 1), TF, 1, 'R_75');
  assert.equal(r2.setup, false); assert.match(r2.reasons[0], /no candle pattern confirms/);
  // a candle with no trigger: no setup, even when a candle pattern or an oversold RSI is present
  const none = [...Array(300).keys()].map((k) => k + 60).find((i) => !detectStochRsi(win(i), win(i).length - 1));
  const r3 = evaluateEngines(CS.slice(0, none! + 1), TF, 1, 'R_75');
  assert.equal(r3.setup, false);
});

// ------------------------------------------------------------------------------------------------ server-side rule check
test('pattern verification recomputes the indicator rules from the candles; they pass on a real setup and fail when the candles change', () => {
  const { i, v } = HITS.find((h) => h.v.ok)!;
  const closed = CS.slice(0, i + 1);
  const pv = verifyPattern({ side: v.side, stoch_rsi: { side: v.side } }, closed, closed[closed.length - 1].time);
  assert.equal(pv.status, 'VALID', pv.failedRules.join(','));
  for (const id of ['IND_STOCH_CROSS', 'IND_RSI_CROSS', 'IND_ALIGNED_ON_SIGNAL', 'IND_NEW_DIRECTION', 'IND_CANDLE_CONFIRMATION']) { assert.ok(pv.allowedRuleIds.includes(id), id); assert.ok(RULE_TEXT[id], `rule text for ${id}`); }
  assert.ok(pv.rules.some((r) => !r.id.startsWith('IND_')), 'the confirming candle pattern is checked with its own rule ids');
  // the same trigger, but the signal candle closes where it started: the crossing disappears
  const tampered = closed.map((c) => ({ ...c }));
  const last = tampered[tampered.length - 1];
  // the signal candle ends the opposite way (far beyond the old extreme): the crossing disappears
  if (v.side === 'BUY') { last.close = last.low = last.low * 0.98; last.open = Math.max(last.open, last.close); }
  else { last.close = last.high = last.high * 1.02; last.open = Math.min(last.open, last.close); }
  const bad = verifyPattern({ side: v.side, stoch_rsi: { side: v.side } }, tampered, last.time);
  assert.equal(bad.status, 'INVALID');
  assert.ok(bad.failedRules.some((id) => id.startsWith('IND_') || id.startsWith('SWEEP_') || id.startsWith('CANDLE_')), bad.failedRules.join(','));
  // an unconfirmed trigger is INVALID because IND_CANDLE_CONFIRMATION fails
  const u = HITS.find((h) => !h.v.ok)!;
  const uc = CS.slice(0, u.i + 1);
  const pu = verifyPattern({ side: u.v.side, stoch_rsi: { side: u.v.side } }, uc, uc[uc.length - 1].time);
  assert.equal(pu.status, 'INVALID'); assert.ok(pu.failedRules.includes('IND_CANDLE_CONFIRMATION'));
});

// ------------------------------------------------------------------------------------------------ the chart
test('the agent screenshot carries the Stochastic and RSI panels, the trigger, the framed candle pattern and the entry arrow', () => {
  const { i, v } = HITS.find((h) => h.v.ok)!;
  const w = win(i);
  const svg = renderIndicatorSvg(w, { side: v.side, ok: true, tf: TF, market: 'Volatility 75 Index', symbol: 'R_75', meta: v.stochRsi, notes: v.notes, signalTime: w[w.length - 1].time });
  for (const t of ['Stochastic (14,3,3)', 'RSI (14)', 'TRIGGER', 'last closed candle', v.side === 'BUY' ? 'BUY' : 'SELL', 'next open', '>80<', '>20<', '>70<', '>50<', '>30<']) assert.ok(svg.includes(t.startsWith('>') ? t : t), t);
  assert.match(svg, /<\/svg>$/);
  // every agent draws the same indicator: identical candles give an identical picture
  assert.equal(svg, renderIndicatorSvg(w, { side: v.side, ok: true, tf: TF, market: 'Volatility 75 Index', symbol: 'R_75', meta: v.stochRsi, notes: v.notes, signalTime: w[w.length - 1].time }));
});

test('the chart after the trade shades the trade window, marks WIN / LOSS, and never invents an exit price', () => {
  const { i, v } = HITS.find((h) => h.v.ok)!;
  const w = CS.slice(Math.max(0, i - 149), i + 3);
  const entry = CS[i].time + TF;
  const base = { side: v.side, ok: true, tf: TF, market: 'M', symbol: 'S', meta: v.stochRsi, signalTime: CS[i].time, compact: true, levels: true } as const;
  const pending = renderIndicatorSvg(w, { ...base, trade: { time: entry, price: CS[i].close, expirySec: TF, result: 'PENDING' } });
  assert.match(pending, /trade running/); assert.doesNotMatch(pending, />WIN<|>LOSS</);
  const win_ = renderIndicatorSvg(w, { ...base, trade: { time: entry, price: CS[i].close, expirySec: TF, result: 'WIN' } });
  assert.match(win_, />WIN</); assert.match(win_, /fill="#6f8cff"/);
  const loss = renderIndicatorSvg(w, { ...base, trade: { time: entry, price: CS[i].close, expirySec: TF, result: 'LOSS', exitPrice: CS[i].close - 1 } });
  assert.match(loss, />LOSS</);
  assert.match(win_, />R \d/); assert.match(win_, />S \d/);            // key levels on the signal card
});

// ------------------------------------------------------------------------------------------------ Gemini
test('the Gemini request states the indicator strategy, hands over the server readings, lists only strategy rule ids and asks for a confidence', () => {
  const { i, v } = HITS.find((h) => h.v.ok)!;
  const closed = CS.slice(0, i + 1);
  const pattern = verifyPattern({ side: v.side, stoch_rsi: { side: v.side } }, closed, closed[closed.length - 1].time);
  const cond = marketCondition(closed);
  const quality = assessMarketQuality(v.side, closed, cond);
  const req = buildAiRequest({ engine: { side: v.side, confidence: 75, agree: 2, reasons: v.notes }, label: 'Volatility 75', tf: TF, expirySec: 300, closed, pattern, quality, condition: cond, image: null, key: 'deriv:R_75' });
  assert.match(SYSTEM_PROMPT, /Do not add, relax or replace any condition/);
  assert.match(SYSTEM_PROMPT, /confidence from 0 to 100/);
  assert.match(req.prompt, /IND_STOCH_CROSS/); assert.match(req.prompt, /Server-computed readings/); assert.match(req.prompt, /"confidence": <integer 0-100/);
  assert.deepEqual([...req.ruleIds].sort(), [...pattern.allowedRuleIds].sort());
  assert.ok(indicatorEvidence(closed, v.side).split('\n').length >= 8);
});

test('the AI confidence is read strictly and capped by the server\'s market-condition read', () => {
  const { i, v } = HITS.find((h) => h.v.ok)!;
  const closed = CS.slice(0, i + 1);
  const pattern = verifyPattern({ side: v.side, stoch_rsi: { side: v.side } }, closed, closed[closed.length - 1].time);
  const cond = marketCondition(closed), quality = assessMarketQuality(v.side, closed, cond);
  const req = buildAiRequest({ engine: { side: v.side, confidence: 75, agree: 2, reasons: [] }, label: 'x', tf: TF, expirySec: 300, closed, pattern, quality, condition: cond, image: null, key: 'k' });
  const reply = (extra: object) => JSON.stringify({ requestId: req.requestId, signalCandleTime: req.signalCandleTime, pattern: { verdict: 'CONFIRMED', ruleResults: [], failedRuleIds: [], notes: '' }, market: { regime: 'RANGING', trendRelation: 'NEUTRAL', momentum: 'MIXED', volatility: 'SUITABLE', repeatedSweeps: false, exhaustionOrContinuation: 'NONE', quality: 'GOOD', warnings: [] }, screenshot: { inspected: false, lastCandleTimeSeen: null, matchesOhlc: null, disagreement: null }, explanation: 'ok', risk: 'LOW', ...extra });
  assert.equal(parseAiResponse(reply({ confidence: 81, confidenceBasis: 'rules met, calm market' }), req, false).confidence, 81);
  assert.equal(parseAiResponse(reply({ confidence: 250 }), req, false).confidence, 100);
  assert.equal(parseAiResponse(reply({}), req, false).confidence, null);
  const q = (o: object) => ({ ...quality, ...o }) as typeof quality;
  assert.equal(boundedConfidence(95, q({ grade: 'GOOD', countertrendRisk: false, strongCountertrend: false, repeatedSweeps: { count: 0, window: 12 } })), 90);
  assert.equal(boundedConfidence(95, q({ grade: 'POOR' })), 55);
  assert.equal(boundedConfidence(95, q({ grade: 'GOOD', strongCountertrend: true, countertrendRisk: true })), 62);
});

// ------------------------------------------------------------------------------------------------ the agents
test('every agent reads the same indicator; in the default mode only the confirmed indicator setup is broadcast, the candle patterns keep posting their own alerts', async () => {
  const data: C[] = CS.slice(0, 700);
  const st = { now: 0 };
  const deps: WatcherDeps = {
    now: async () => st.now, sleep: async () => {},
    fetchCandles: async (_s, _tf, count) => data.filter((c) => c.time <= st.now).map((c) => ({ ...c })).slice(-count),
  };
  const agents = ['A1', 'A2'].map((s) => ({ symbol: s, name: `Agent ${s}`, market: `Market ${s}` }));
  const hub = new CandidateHub();
  const w = new SweepWatcherService({ agents, deps, hub, rasterize: async () => null, tf: TF });
  // both agents watch the SAME series, so they must reach the identical conclusion
  for (let i = 100; i < 520; i++) { st.now = data[i].time + TF + 3; await w.runPass(0); }
  const cands = hub.list(200);
  assert.ok(cands.length > 3, `candidates ${cands.length}`);
  assert.ok(cands.every((c) => c.versions[0].engine === 'stoch_rsi'), 'only the indicator strategy is broadcast');
  assert.ok(cands.every((c) => c.versions[0].stochRsi && c.versions[0].screenshot.svg.includes('Stochastic (14,3,3)') && c.versions[0].screenshot.svg.includes('RSI (14)')));
  const alerts = w.getAlerts(0, 600);
  assert.ok(alerts.some((a) => a.engine !== 'stoch_rsi'), 'the candle-pattern strategies still post their alerts');
  const bySym = (s: string) => alerts.filter((a) => a.symbol === s && a.engine === 'stoch_rsi').map((a) => `${a.candle_time}|${a.side}`).sort();
  assert.deepEqual(bySym('A1'), bySym('A2'));
  assert.ok(bySym('A1').length > 3);
});
