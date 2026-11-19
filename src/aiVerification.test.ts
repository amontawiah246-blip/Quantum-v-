// These tests exercise the sweep-based claims of the signal path (legacy mode). The default mode is covered by src/stochRsi.test.ts.
process.env.STRATEGY_MODE = 'legacy';
// Tests for the AI verification pipeline: the 12 cases from the task, plus the transport and authority rules behind them.
// Run:  npx tsx --test src/aiVerification.test.ts
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSignal, resetSignalCaches, ledger, SignalDeps } from '../signalServer';
import { AiAssessment, AiRequest, DEFAULT_POLICY, ExecutionPolicy, buildAiRequest, candleLabel, parseAiResponse, policyFromEnv } from './aiVerification';
import { assessMarketQuality } from './marketQuality';
import { verifyPattern } from './patternVerification';
import { createGeminiCaller, geminiBody } from './geminiVision';
import { buildScreenshot, renderSignalSvg } from './screenshot';
import { marketCondition, Condition } from './conditions';
import { detectContinuationSignal } from './continuationEngine';
import { detectWickSweep } from './sweepEngines';
import { TF, engine, fakeAi, fakeRasterizer, market, nowAfter, PNG, reply, withSweep } from './aiFixtures';

beforeEach(() => resetSignalCaches());
let n = 0;
const key = () => `t${++n}`;
const deps = (cs: ReturnType<typeof market>, side: 'BUY' | 'SELL', ai: SignalDeps['ai'], o: Partial<SignalDeps> = {}, eng = engine(side)): SignalDeps =>
  ({ engines: async () => eng, ai, rasterizer: fakeRasterizer, now: () => nowAfter(cs), policy: DEFAULT_POLICY, ...o });
const run = (cs: ReturnType<typeof market>, side: 'BUY' | 'SELL', ai: SignalDeps['ai'], o: Partial<SignalDeps> = {}, eng = engine(side)) =>
  getSignal(deps(cs, side, ai, o, eng), cs, TF, 'EURUSD', key());

// what the old AI used to "veto" valid sweeps for. None of these is a rule of the strategy.
const INVENTED = { pattern: { verdict: 'CONTRADICTED', ruleResults: [{ ruleId: 'MUST_ENGULF_PREVIOUS', pass: false, observed: 'signal candle does not engulf the previous candle' }], failedRuleIds: ['MUST_ENGULF_PREVIOUS', 'STRONG_MOMENTUM_REQUIRED'], notes: 'no engulfing, weak momentum, choppy market, not high probability' } };

// ---------------------------------------------------------------------------------------------------------- 1 + 2
test('1. valid bearish sweep without engulfing stays valid even when the AI objects with invented rules', async () => {
  const cs = withSweep(market('flat', 63), 'SELL');
  const s = await run(cs, 'SELL', fakeAi(() => INVENTED));
  const v = s.verification!;
  assert.equal(v.enginePatternValidity.status, 'VALID');
  assert.deepEqual(v.enginePatternValidity.failedRules, []);
  assert.notEqual(s.decision, 'REJECTED');
  assert.ok(s.decision === 'APPROVED' || s.decision === 'VALID_WITH_RISK');
  assert.equal(s.tradeable, true);
  assert.deepEqual(v.aiPatternVerification.authorizedFailedRules, []);
  assert.ok(v.aiPatternVerification.ignoredObjections.length >= 2, 'the invented objections are recorded, not obeyed');
  assert.ok(v.marketQuality.warnings.some((w) => /AI objection ignored/.test(w)), 'and shown as warnings');
  assert.deepEqual(v.aiRejectionReasons, []);
});

test('2. valid bullish sweep without engulfing stays valid even when the AI objects with invented rules', async () => {
  const cs = withSweep(market('flat'), 'BUY');
  const s = await run(cs, 'BUY', fakeAi(() => INVENTED));
  assert.equal(s.verification!.enginePatternValidity.status, 'VALID');
  assert.notEqual(s.decision, 'REJECTED');
  assert.equal(s.tradeable, true);
  assert.equal(s.side, 'buy');
  // the signal candle really does not engulf the previous one (the test would prove nothing otherwise)
  const [prev, sig] = cs.slice(-2);
  assert.ok(!(sig.close > prev.open && sig.open < prev.close));
});

// ---------------------------------------------------------------------------------------------------------- 3 + 4
test('3. sweep against a strong trend: COUNTERTREND RISK, valid pattern, lower ranking, policy decides execution', async () => {
  const cs = withSweep(market('down'), 'BUY');
  const s = await run(cs, 'BUY', fakeAi(() => ({ market: { regime: 'TRENDING_DOWN', trendRelation: 'COUNTERTREND', momentum: 'CONTRADICTORY', volatility: 'SUITABLE', repeatedSweeps: false, exhaustionOrContinuation: 'CONTINUATION', quality: 'POOR', warnings: ['strong downtrend'] } })));
  const v = s.verification!;
  assert.equal(v.enginePatternValidity.status, 'VALID');
  assert.equal(s.decision, 'VALID_WITH_RISK');
  assert.equal(v.countertrendWarning, true);
  assert.equal(v.trendAlignment, 'COUNTERTREND');
  assert.ok(v.marketQuality.warnings.some((w) => /COUNTERTREND RISK/.test(w)));
  assert.ok(s.confidence < engine('BUY').confidence, 'ranking is lowered');
  assert.equal(s.tradeable, true, 'default policy allows it');
  const strict = await run(cs, 'BUY', fakeAi(), { policy: { ...DEFAULT_POLICY, allowCountertrend: false } });
  assert.equal(strict.decision, 'VALID_WITH_RISK');
  assert.equal(strict.tradeable, false, 'a policy that forbids countertrend blocks execution, not validity');
  const none = await run(cs, 'BUY', fakeAi(), { policy: { ...DEFAULT_POLICY, allowValidWithRisk: false } });
  assert.equal(none.tradeable, false);
});

test('4. sweep with a supporting trend: WITH_TREND, no countertrend warning, APPROVED', async () => {
  const cs = withSweep(market('up'), 'BUY');
  const s = await run(cs, 'BUY', fakeAi());
  const v = s.verification!;
  assert.equal(v.trendAlignment, 'WITH_TREND');
  assert.equal(v.countertrendWarning, false);
  assert.equal(s.decision, 'APPROVED');
  assert.equal(s.tradeable, true);
  assert.equal(v.visualVerification, true);
  assert.equal(v.screenshotVerification.status, 'VERIFIED');
});

// ---------------------------------------------------------------------------------------------------------- 5
test('5. valid sweep during sideways conditions is valid; chop never invalidates it', async () => {
  const cs = withSweep(market('flat'), 'BUY');
  const s = await run(cs, 'BUY', fakeAi(() => ({ market: { regime: 'RANGING', trendRelation: 'NEUTRAL', momentum: 'MIXED', volatility: 'SUITABLE', repeatedSweeps: false, exhaustionOrContinuation: 'NONE', quality: 'FAIR', warnings: ['choppy, overlapping candles'] }, pattern: { verdict: 'CONTRADICTED', ruleResults: [], failedRuleIds: ['MARKET_IS_CHOPPY'], notes: 'choppy market' } })));
  const v = s.verification!;
  assert.equal(v.marketQuality.regime, 'RANGING');
  assert.equal(v.trendAlignment, 'NEUTRAL');
  assert.equal(v.enginePatternValidity.status, 'VALID');
  assert.notEqual(s.decision, 'REJECTED');
  assert.ok(v.aiPatternVerification.ignoredObjections.some((x) => /MARKET_IS_CHOPPY/.test(x)));
});

// ---------------------------------------------------------------------------------------------------------- 6 + 7
test('6. a wick that only touches the previous extreme is not a sweep: REJECTED by the arithmetic, AI not even asked', async () => {
  for (const side of ['BUY', 'SELL'] as const) {
    const cs = withSweep(market('flat'), side, { touchOnly: true });
    const ai = fakeAi();
    const s = await run(cs, side, ai);
    assert.equal(s.decision, 'REJECTED');
    assert.deepEqual(s.verification!.enginePatternValidity.failedRules, ['SWEEP_WICK_PENETRATION']);
    assert.equal(s.tradeable, false);
    assert.equal(s.setup, false);
    assert.equal(ai.calls.length, 0);
    assert.match(s.verification!.enginePatternValidity.rules.find((r) => r.id === 'SWEEP_WICK_PENETRATION')!.detail, /touch only/);
  }
});

test('7. incorrect candle colours: REJECTED, naming the direction rules', async () => {
  for (const side of ['BUY', 'SELL'] as const) {
    const cs = withSweep(market('flat'), side, { wrongColours: true });
    const s = await run(cs, side, fakeAi());
    assert.equal(s.decision, 'REJECTED');
    const failed = s.verification!.enginePatternValidity.failedRules;
    assert.ok(failed.includes('SWEEP_PREV_DIRECTION') && failed.includes('SWEEP_CANDLE_DIRECTION'), failed.join());
    assert.equal(s.tradeable, false);
  }
});

// ---------------------------------------------------------------------------------------------------------- 8
test('8. valid pattern with mixed indicators: flagged as mixed, never rejected', async () => {
  const cs = withSweep(market('up'), 'BUY');                       // EMA supports the BUY, RSI / Bollinger are stretched against it
  const s = await run(cs, 'BUY', fakeAi());
  const v = s.verification!;
  assert.equal(v.indicatorAlignment.state, 'MIXED');
  assert.ok(v.indicatorAlignment.supporting.length >= 1 && v.indicatorAlignment.contradicting.length >= 1);
  assert.ok(v.marketQuality.warnings.some((w) => /Mixed indicators/.test(w)));
  assert.equal(v.enginePatternValidity.status, 'VALID');
  assert.notEqual(s.decision, 'REJECTED');
  assert.equal(s.tradeable, true);
  // and the same arithmetic on a hand-made Condition
  const c: Condition = { trend: 'Sideways', trendStrength: 10, volatility: 'Normal', rsi: 70, bbPos: 20, cci: 160, ema: { state: 'Falling', text: 'x' }, priceAction: 'Normal', support: 1, resistance: 2, notes: [] };
  const q = assessMarketQuality('BUY', cs, c);
  assert.equal(q.indicatorAlignment.state, 'MIXED');
});

// ---------------------------------------------------------------------------------------------------------- 9
test('9. screenshot and OHLC disagreement: REVIEW, never executed, status MISMATCH', async () => {
  const cs = withSweep(market('up'), 'BUY');
  const s = await run(cs, 'BUY', fakeAi((req) => ({ screenshot: { inspected: true, lastCandleTimeSeen: req.expectedCandleLabel, matchesOhlc: false, disagreement: 'image shows a red signal candle, the numbers say green' } })));
  const v = s.verification!;
  assert.equal(s.decision, 'REVIEW');
  assert.equal(v.screenshotVerification.status, 'MISMATCH');
  assert.match(v.screenshotVerification.note, /red signal candle/);
  assert.equal(v.visualVerification, false);
  assert.equal(s.tradeable, false);
  assert.equal(s.setup, true, 'the setup is kept for a person to look at');
});

// ---------------------------------------------------------------------------------------------------------- 10
test('10. Gemini failure: AI_UNAVAILABLE, engine result kept, no approval, no visual claim, policy decides', async () => {
  const cs = withSweep(market('up'), 'BUY');
  const failures: [string, SignalDeps['ai']][] = [
    ['HTTP 429', createGeminiCaller({ apiKey: 'k', minIntervalMs: 0, fetchImpl: (async () => new Response('{}', { status: 429 })) as typeof fetch })],
    ['HTTP 503', createGeminiCaller({ apiKey: 'k', minIntervalMs: 0, fetchImpl: (async () => new Response('{}', { status: 503 })) as typeof fetch })],
    ['network down', createGeminiCaller({ apiKey: 'k', minIntervalMs: 0, fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch })],
    ['no key', createGeminiCaller({ apiKey: '' })],
    ['placeholder key', createGeminiCaller({ apiKey: 'MY_GEMINI_API_KEY' })],
    ['no AI configured', null],
    ['garbage reply', fakeAi(() => 'I think buy')],
    ['old approve/veto shape', fakeAi(() => '{"verdict":"approve","confidenceAdjust":5,"reason":"looks good"}')],
  ];
  for (const [name, ai] of failures) {
    resetSignalCaches();
    const s = await run(cs, 'BUY', ai);
    assert.equal(s.decision, 'AI_UNAVAILABLE', name);
    assert.equal(s.ai?.status, 'unavailable', name);
    assert.equal(s.tradeable, false, name);
    assert.equal(s.setup, true, `${name}: the engine result is preserved`);
    assert.equal(s.side, 'buy', name);
    assert.equal(s.confidence, engine('BUY').confidence, `${name}: confidence untouched`);
    assert.equal(s.verification!.visualVerification, false, name);
    assert.notEqual(s.verification!.screenshotVerification.status, 'VERIFIED', name);
    assert.ok(!/AI approved|Verified by the AI/.test(s.reasons.join() + s.status), `${name}: no approval wording`);
  }
  // only an explicit, user-configured policy can trade on the engine alone
  const opted = await run(cs, 'BUY', null, { policy: { ...DEFAULT_POLICY, aiUnavailable: 'allow_engine_only' } });
  assert.equal(opted.decision, 'AI_UNAVAILABLE');
  assert.equal(opted.tradeable, true);
  assert.equal(opted.verification!.execution.engineOnly, true);
  assert.equal(opted.verification!.visualVerification, false);
  assert.equal(policyFromEnv({}).aiUnavailable, 'block');
  assert.equal(policyFromEnv({ AI_UNAVAILABLE_POLICY: 'allow_engine_only' }).aiUnavailable, 'allow_engine_only');
});

// ---------------------------------------------------------------------------------------------------------- 11
test('11. duplicate AI responses: one call per candle, replayed answers refused, one trade per candle', async () => {
  const cs = withSweep(market('up'), 'BUY');
  const k = key();
  const ai = fakeAi();
  const d = deps(cs, 'BUY', ai);
  // concurrent identical requests share one AI call, later ones hit the cache
  const [a, b] = await Promise.all([getSignal(d, cs, TF, 'EURUSD', k), getSignal(d, cs, TF, 'EURUSD', k)]);
  const c = await getSignal(d, cs, TF, 'EURUSD', k);
  assert.equal(ai.calls.length, 1);
  assert.equal(a.decision, 'APPROVED'); assert.equal(b.decision, 'APPROVED'); assert.equal(c.decision, 'APPROVED');
  assert.equal(c.verification!.cacheHit, true);

  // a reply that belongs to an earlier request / other candle is not accepted
  let stored = '';
  const first = await getSignal(deps(cs.slice(0, -2).concat(withSweep(market('up', 60, 9), 'BUY').slice(-2)), 'BUY', fakeAi((r) => { stored = reply(r); return stored; })), cs, TF, 'EURUSD', key());
  assert.ok(first && stored);
  resetSignalCaches();
  const replay = await run(cs, 'BUY', fakeAi(() => stored));
  assert.equal(replay.decision, 'AI_UNAVAILABLE');
  assert.equal(replay.verification!.aiError?.kind, 'WRONG_REQUEST');
  assert.equal(replay.tradeable, false);

  // a failed call is not cached: the next attempt asks again
  resetSignalCaches();
  let calls = 0;
  const flaky = fakeAi(() => { calls++; return calls === 1 ? 'oops' : {}; });
  const kk = key();
  const f1 = await getSignal(deps(cs, 'BUY', flaky), cs, TF, 'EURUSD', kk);
  const f2 = await getSignal(deps(cs, 'BUY', flaky), cs, TF, 'EURUSD', kk);
  assert.equal(f1.decision, 'AI_UNAVAILABLE'); assert.equal(f2.decision, 'APPROVED'); assert.equal(calls, 2);

  // the executor claims a candle once
  assert.equal(ledger.claim('x|300|1|buy'), true);
  assert.equal(ledger.claim('x|300|1|buy'), false);
});

// ---------------------------------------------------------------------------------------------------------- 12
test('12. stale signal or stale screenshot: REVIEW, never executed', async () => {
  const cs = withSweep(market('up'), 'BUY');
  // stale signal: it is now 5 minutes after the candle closed; the AI is not called
  const ai = fakeAi();
  const old = await run(cs, 'BUY', ai, { now: () => nowAfter(cs, 300) });
  assert.equal(old.decision, 'REVIEW');
  assert.match(old.status, /Stale/);
  assert.equal(old.tradeable, false);
  assert.equal(ai.calls.length, 0);

  // stale screenshot: the image shows an earlier candle than the signal candle
  const earlier = candleLabel(cs[cs.length - 3].time);
  const s = await run(cs, 'BUY', fakeAi(() => ({ screenshot: { inspected: true, lastCandleTimeSeen: earlier, matchesOhlc: true, disagreement: null } })));
  assert.equal(s.verification!.screenshotVerification.status, 'STALE');
  assert.equal(s.decision, 'REVIEW');
  assert.equal(s.tradeable, false);

  // the execution controller re-checks age even when everything else is fine
  const policy: ExecutionPolicy = { ...DEFAULT_POLICY, maxSignalAgeSec: 10 };
  const late = await run(cs, 'BUY', fakeAi(), { policy, now: () => nowAfter(cs, 30) });
  assert.equal(late.tradeable, false);
});

// ---------------------------------------------------------------------------------------------------------- screenshot honesty
test('no rasterizer: the screenshot is NOT_SENT, no visual verification is claimed, and a required screenshot blocks execution', async () => {
  const cs = withSweep(market('up'), 'BUY');
  const ai = fakeAi();
  const s = await run(cs, 'BUY', ai, { rasterizer: null });
  assert.equal(ai.calls[0].image, null);
  assert.match(ai.calls[0].prompt, /NO image is attached/);
  assert.equal(s.verification!.screenshotVerification.status, 'NOT_SENT');
  assert.equal(s.verification!.visualVerification, false);
  assert.equal(s.decision, 'REVIEW');
  assert.equal(s.tradeable, false);
  // when the user turns the requirement off, the setup can go ahead but it is still not called a visual verification
  resetSignalCaches();
  const relaxed = await run(cs, 'BUY', fakeAi(), { rasterizer: null, policy: { ...DEFAULT_POLICY, requireScreenshot: false } });
  assert.equal(relaxed.decision, 'APPROVED');
  assert.equal(relaxed.tradeable, true);
  assert.equal(relaxed.verification!.visualVerification, false);
  assert.match(relaxed.verification!.decisionReasons.join(' '), /NOT a visual verification/);
});

test('the image is really part of the Gemini request, and the AI saying "inspected" without it proves nothing', async () => {
  const cs = withSweep(market('up'), 'BUY');
  let body: any;
  const caller = createGeminiCaller({
    apiKey: 'k', minIntervalMs: 0,
    fetchImpl: (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      const req = JSON.parse(String(init.body)).contents[0].parts[0].text.match(/REQUEST (\w+)/)![1];
      const t = cs[cs.length - 1].time;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: reply({ requestId: req, signalCandleTime: t, ruleIds: ['SWEEP_PREV_DIRECTION', 'SWEEP_CANDLE_DIRECTION', 'SWEEP_WICK_PENETRATION', 'SWEEP_CLOSE_LOCATION'], image: {} as any, expectedCandleLabel: candleLabel(t) } as AiRequest) }] } }] }), { status: 200 });
    }) as typeof fetch,
  });
  const s = await run(cs, 'BUY', caller);
  assert.equal(s.decision, 'APPROVED');
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[1].inlineData.mimeType, 'image/png');
  assert.equal(parts[1].inlineData.data, Buffer.from(PNG).toString('base64'));
  assert.match(parts[0].text, /D\. OHLC/);
  assert.equal(s.verification!.screenshotVerification.status, 'VERIFIED');
  assert.equal(s.verification!.screenshotVerification.imageSha256, (await import('./aiVerification')).sha256(PNG));

  // a transport that did not attach the image cannot yield VERIFIED, whatever the model says
  resetSignalCaches();
  const noImg = async (r: AiRequest) => ({ text: reply(r), imageSent: false });
  const t = await run(cs, 'BUY', noImg);
  assert.equal(t.verification!.screenshotVerification.status, 'NOT_SENT');
  assert.equal(t.verification!.visualVerification, false);
  assert.equal(t.tradeable, false);
});

// ---------------------------------------------------------------------------------------------------------- request contents
test('the request carries OHLC, engine findings, indicator context, structure and the signal timestamp, with the dashboard clearly separated', () => {
  const cs = withSweep(market('down'), 'BUY');
  const closed = cs;
  const e = engine('BUY', { indicators: { side: 'BUY', strategies: ['RSI Oversold (10.1)'], count: 1, info: { rsi: 10.1 } } });
  const pattern = verifyPattern(e as any, closed, closed[closed.length - 1].time);
  const cond = marketCondition(closed);
  const q = assessMarketQuality('BUY', closed, cond);
  const req = buildAiRequest({ engine: { side: 'BUY', confidence: 75, agree: 2, reasons: e.reasons, indicators: { strategies: ['RSI Oversold (10.1)'], info: { rsi: 10.1 } } }, label: 'EURUSD', tf: TF, closed, pattern, quality: q, condition: cond, image: null, key: 'k' });
  const p = req.prompt;
  for (const needle of ['A. STRATEGY ENGINE EVIDENCE', 'B. DASHBOARD MARKET-CONDITION MEASUREMENTS', 'C. SCREENSHOT', 'D. OHLC', 'signalCandleTime', String(closed[closed.length - 1].time),
    'trendStrength0to100', 'rsi14', 'bollingerPosition0to100', 'cci20', 'ema13vs34', 'volatility', 'support30', 'resistance30', 'lastSwingLow10', 'RSI Oversold',
    'NOT the previous-candle sweep', 'SWEEP_WICK_PENETRATION', 'SWEEP_CLOSE_LOCATION', 'SWEEP_PREV_DIRECTION', 'SWEEP_CANDLE_DIRECTION']) assert.ok(p.includes(needle), `missing: ${needle}`);
  assert.equal(p.split('\n').filter((l) => /^\d{10},/.test(l)).length, 60);
  assert.deepEqual(req.ruleIds.sort(), ['SWEEP_CANDLE_DIRECTION', 'SWEEP_CLOSE_LOCATION', 'SWEEP_PREV_DIRECTION', 'SWEEP_WICK_PENETRATION']);
  // engulfing / momentum / chop are named only as things that are NOT conditions
  assert.match(req.system, /Never treat any of these as a pattern condition: engulfing/);
  assert.ok(!req.ruleIds.some((id) => /ENGULF|MOMENTUM|CHOP|PROBAB/i.test(id)));
  assert.equal(geminiBody(req).imageSent, false);
});

test('the screenshot is drawn from the same closed candles and carries the signal candle time', async () => {
  const cs = withSweep(market('up'), 'SELL');
  const pattern = verifyPattern(engine('SELL') as any, cs, cs[cs.length - 1].time);
  const svg = renderSignalSvg(cs, 'SELL', pattern, 'EURUSD', 'EURUSD', TF);
  assert.ok(svg.includes(candleLabel(cs[cs.length - 1].time)));
  const shot = await buildScreenshot(cs, 'SELL', pattern, 'EURUSD', 'EURUSD', TF, fakeRasterizer, 5_000_000);
  assert.equal(shot!.lastCandleTime, cs[cs.length - 1].time);
  const req = buildAiRequest({ engine: { side: 'SELL', confidence: 1, agree: 1, reasons: [] }, label: 'x', tf: TF, closed: cs, pattern, quality: assessMarketQuality('SELL', cs, marketCondition(cs)), condition: marketCondition(cs), image: shot, key: 'k' });
  assert.equal(shot!.candleSetHash, (await import('./aiVerification')).candleSetHash(cs.slice(-60)));
  assert.match(req.prompt, new RegExp(shot!.candleSetHash.slice(0, 12)));
  assert.equal(await buildScreenshot(cs, 'SELL', pattern, 'x', 'x', TF, async () => null), null);
});

// ---------------------------------------------------------------------------------------------------------- consistency with the engines
test('the independent pattern arithmetic agrees with the engines on random candles (Engine 5 and the wick sweep geometry)', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  let cont = 0, wick = 0;
  for (let k = 0; k < 4000; k++) {
    const base = 100 + rnd();
    const cs = Array.from({ length: 12 }, (_, i) => {
      const o = base + (rnd() - 0.5) * 0.6, c = o + (rnd() - 0.5) * 0.5;
      return { time: T(i), open: o, close: c, high: Math.max(o, c) + rnd() * 0.3, low: Math.min(o, c) - rnd() * 0.3 };
    });
    const i = cs.length - 1;
    for (const side of ['BUY', 'SELL'] as const) {
      const eng = detectContinuationSignal(cs, i);
      const mine = verifyPattern({ side, continuation: { side } }, cs, cs[i].time);
      if (eng && eng.side === side) { cont++; assert.equal(mine.status, 'VALID', 'engine fired but the arithmetic disagrees'); }
      if (!eng || eng.side !== side) assert.equal(mine.status, 'INVALID', 'engine did not fire but the arithmetic says valid');
      const w = detectWickSweep(cs, i);
      const geo = verifyPattern({ side, sweep: { side } }, cs, cs[i].time);
      if (w && w.side === side) { wick++; assert.equal(geo.status, 'VALID', 'wick engine fired (even if its context check said SKIP) but the geometry disagrees'); }
      if (geo.status === 'VALID') assert.ok(w && w.side === side, 'geometry valid but the wick engine finds no sweep');
    }
  }
  assert.ok(cont > 0 && wick > 0, `fixtures never produced a setup (${cont}, ${wick})`);
});
const T = (i: number) => 1_700_000_100 + i * 300;

test('strict parsing: a reply to another request, or with a bad enum, is a failed verification', () => {
  const req = { requestId: 'abc', signalCandleTime: 5, ruleIds: ['SWEEP_WICK_PENETRATION'], image: null, expectedCandleLabel: 'x' } as unknown as AiRequest;
  const ok = parseAiResponse(reply(req), req, false) as AiAssessment;
  assert.equal(ok.pattern.verdict, 'CONFIRMED');
  assert.throws(() => parseAiResponse(reply({ ...req, requestId: 'zzz' }), req, false), /different request/);
  assert.throws(() => parseAiResponse(reply({ ...req, signalCandleTime: 6 }), req, false), /different request/);
  assert.throws(() => parseAiResponse(reply(req, { risk: 'MAYBE' }), req, false), /bad risk/);
  assert.throws(() => parseAiResponse('{"verdict":"approve"}', req, false));
});

test('the AI can dispute only original rule ids; a disputed real rule that the arithmetic passes goes to REVIEW, not to a rejection', async () => {
  const cs = withSweep(market('up'), 'BUY');
  const s = await run(cs, 'BUY', fakeAi(() => ({ pattern: { verdict: 'CONTRADICTED', ruleResults: [{ ruleId: 'SWEEP_WICK_PENETRATION', pass: false, observed: 'low 99.7 vs 99.7' }], failedRuleIds: ['SWEEP_WICK_PENETRATION'], notes: 'only a touch' } })));
  assert.equal(s.decision, 'REVIEW');
  assert.deepEqual(s.verification!.aiPatternVerification.authorizedFailedRules, ['SWEEP_WICK_PENETRATION']);
  assert.ok(s.verification!.aiRejectionReasons[0].includes('SWEEP_WICK_PENETRATION'));
  assert.equal(s.tradeable, false);
});

test('engine findings are preserved and no engine setup means no AI call', async () => {
  const cs = market('flat');
  const ai = fakeAi();
  const s = await run(cs, 'BUY', ai, {}, engine('BUY', { setup: false, side: null, status: 'no setup', reasons: ['Scanning live price action'], sweep: null }));
  assert.equal(s.setup, false); assert.equal(s.decision, null); assert.equal(ai.calls.length, 0);
  const t = await run(withSweep(market('up'), 'BUY'), 'BUY', null);
  assert.equal(t.engine.sweep?.side, 'BUY');
  assert.equal(t.engine.confidence, 75);
});
