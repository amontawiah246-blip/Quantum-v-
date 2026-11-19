// These tests exercise the sweep-based claims of the signal path (legacy mode). The default mode is covered by src/stochRsi.test.ts.
process.env.STRATEGY_MODE = 'legacy';
// Hybrid engine x AutoTrading x Gemini screenshot verification.
// Proves: the hybrid layer can only block, never create; its evidence reaches the AI; the AI contract is strict; the independent
// execution gate refuses on any failed check even when the AI approved; scanning no longer uses up a candle; the log is honest.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSignal, resetSignalCaches } from '../signalServer';
import { ExecutionLedger } from './aiVerification';
import { HybridView } from './hybridEngine';
import { gateHybrid } from './hybridGate';
import { toAiContract, validateAiContract } from './aiContract';
import { GateInput, atr14, candleIntegrity, runExecutionGate } from './executionGate';
import { lookFromSignal } from './autoLook';
import { TradeLog, analyze } from './tradeLog';
import { TF, engine, fakeAi, fakeRasterizer, market, nowAfter, withSweep } from './aiFixtures';

beforeEach(() => resetSignalCaches());
const cs = withSweep(market('up'), 'BUY');
const last = cs[cs.length - 1];

const view = (o: Partial<HybridView> = {}): HybridView => ({
  action: 'NO_TRADE', mode: 'B', modeNote: null, stage: 'REJECTED', reason: 'x', probability: null, patterns: ['bullish_sweep'], indicators: null, rejection: null, bySide: {},
  expirySec: 300, signalCandleTime: null, executeAfter: null, model: null, note: '', ...o,
});
const rej = (stage: string, reason = 'r') => ({ decision: 'NO_TRADE' as const, rejectionStage: stage, rejectionReason: reason, probability: null, qualityScore: -0.4, patterns: ['bullish_sweep'] });
const confirm = view({ action: 'BUY', stage: 'TRADE', bySide: { BUY: { decision: 'BUY', rejectionStage: null, rejectionReason: null, probability: 0.61, qualityScore: 0.5, patterns: ['bullish_sweep'] } } });
const veto = view({ bySide: { BUY: rej('STAGE2_INDICATORS', 'ADX, ATR and EMA all contradict') } });
const mk = (ai: any, hybrid: HybridView | undefined, o: any = {}) => ({ engines: async () => ({ ...engine('BUY'), hybrid }), ai, rasterizer: fakeRasterizer, now: () => nowAfter(cs), ...o });

// ---------------------------------------------------------------------------------------------------------------- hybrid gate
test('veto mode: blocks only when the hybrid layer positively disagrees about the ENGINE\'s side', () => {
  assert.equal(gateHybrid('BUY', veto).allow, false);
  assert.equal(gateHybrid('BUY', veto).status, 'VETO_INDICATORS');
  assert.equal(gateHybrid('BUY', view({ bySide: { BUY: rej('STAGE3_MODEL') } })).status, 'VETO_MODEL');
  assert.equal(gateHybrid('BUY', view({ action: 'SELL', stage: 'TRADE' })).status, 'VETO_OPPOSITE');
  // a rejection of the OTHER side says nothing about this one
  assert.equal(gateHybrid('BUY', view({ bySide: { SELL: rej('STAGE2_INDICATORS') } })).allow, true);
  assert.equal(gateHybrid('BUY', confirm).status, 'CONFIRMS');
});
test('no opinion / unavailable never blocks in veto mode, but require mode needs a confirmation', () => {
  for (const v of [undefined, view({ stage: 'NO_SETUP' }), view({ stage: 'WARMUP' }), view({ stage: 'TIMEFRAME' }), view({ bySide: { BUY: rej('MODEL_UNAVAILABLE') } })]) {
    assert.equal(gateHybrid('BUY', v).allow, true, String(v?.stage));
    assert.equal(gateHybrid('BUY', v, { mode: 'require' }).allow, false);
  }
  assert.equal(gateHybrid('BUY', confirm, { mode: 'require' }).allow, true);
});
test('off and advisory never block; advisory still reports the disagreement', () => {
  assert.equal(gateHybrid('BUY', veto, { mode: 'off' }).allow, true);
  const a = gateHybrid('BUY', veto, { mode: 'advisory' });
  assert.equal(a.allow, true); assert.equal(a.disagrees, true);
});

// ---------------------------------------------------------------------------------------------------------------- pipeline
test('a hybrid veto blocks the trade but never rewrites the strategy engine result or the AI decision', async () => {
  const ai = fakeAi();
  const s = await getSignal(mk(ai, veto), cs, TF, 'EURUSD', 'h1');
  assert.equal(s.setup, true); assert.equal(s.decision, 'APPROVED'); assert.equal(s.engine.side, 'BUY');
  assert.equal(s.tradeable, false);
  assert.match(s.verification!.execution.reason, /hybrid gate/);
  assert.match(s.status, /hybrid gate/i);
  assert.equal(s.hybrid?.status, 'VETO_INDICATORS');
});
test('advisory mode: same candidate stays tradeable; veto mode default with a confirming hybrid stays tradeable', async () => {
  assert.equal((await getSignal(mk(fakeAi(), veto, { hybridPolicy: { mode: 'advisory' } }), cs, TF, 'EURUSD', 'h2')).tradeable, true);
  resetSignalCaches();
  assert.equal((await getSignal(mk(fakeAi(), confirm), cs, TF, 'EURUSD', 'h3')).tradeable, true);
});
test('the hybrid layer cannot create a setup: no engine setup means no AI call and no trade, whatever hybrid says', async () => {
  const ai = fakeAi();
  const d = { engines: async () => ({ ...engine('BUY', { setup: false, side: null, status: 'no liquidity sweep' }), hybrid: confirm }), ai, rasterizer: fakeRasterizer, now: () => nowAfter(cs) };
  const s = await getSignal(d as any, cs, TF, 'EURUSD', 'h4');
  assert.equal(ai.calls.length, 0); assert.equal(s.setup, false); assert.equal(s.tradeable, false);
});
test('the screenshot request carries the hybrid evidence, and "off" removes it', async () => {
  const ai = fakeAi();
  await getSignal(mk(ai, confirm), cs, TF, 'EURUSD', 'h5');
  const p = ai.calls[0].prompt;
  assert.match(p, /HYBRID ENGINE EVIDENCE/); assert.match(p, /wickPenetration/); assert.match(p, /bodyToRange/); assert.match(p, /no validated model is loaded|"probability": 0\.61/);
  assert.ok(ai.calls[0].image, 'the screenshot is still attached');
  resetSignalCaches();
  const ai2 = fakeAi();
  await getSignal(mk(ai2, confirm, { hybridPolicy: { mode: 'off' } }), cs, TF, 'EURUSD', 'h6');
  assert.doesNotMatch(ai2.calls[0].prompt, /HYBRID ENGINE EVIDENCE/);
});
test('the AI cannot raise a trade the hybrid gate blocked, and an unavailable AI still never approves', async () => {
  const s = await getSignal(mk(null, veto), cs, TF, 'EURUSD', 'h7');
  assert.equal(s.tradeable, false); assert.equal(s.decision, 'AI_UNAVAILABLE');
});

// ---------------------------------------------------------------------------------------------------------------- contract
test('contract: APPROVE needs a verified screenshot; failures map to REJECT / ABSTAIN / RETRY; schema is strict', async () => {
  const ok = await getSignal(mk(fakeAi(), confirm), cs, TF, 'EURUSD', 'c1');
  assert.equal(ok.contract?.decision, 'APPROVE'); assert.equal(ok.contract?.direction, 'BUY'); assert.equal(ok.contract?.visual_match, true);
  assert.deepEqual(validateAiContract(ok.contract), { ok: true, errors: [] });
  assert.ok(!Number.isNaN(Date.parse(ok.contract!.evidence_timestamp)));

  resetSignalCaches();
  const noShot = await getSignal(mk(fakeAi(), confirm, { rasterizer: null, policy: { aiUnavailable: 'block', allowValidWithRisk: true, allowCountertrend: true, requireScreenshot: false, maxSignalAgeSec: null } }), cs, TF, 'EURUSD', 'c2');
  assert.notEqual(noShot.contract?.decision, 'APPROVE'); assert.equal(noShot.contract?.direction, 'NO_TRADE'); assert.equal(noShot.contract?.visual_match, false);

  resetSignalCaches();
  const down = await getSignal(mk(async () => { throw new Error('boom'); }, confirm), cs, TF, 'EURUSD', 'c3');
  assert.equal(down.contract?.decision, 'RETRY');
  resetSignalCaches();
  assert.equal((await getSignal(mk(null, confirm), cs, TF, 'EURUSD', 'c4')).contract?.decision, 'ABSTAIN');

  const bad = { ...ok.contract!, decision: 'APPROVE', visual_match: false };
  assert.equal(validateAiContract(bad).ok, false);
  assert.equal(validateAiContract({ ...ok.contract!, direction: 'HOLD' }).ok, false);
  assert.equal(validateAiContract({ ...ok.contract!, extra: 1 }).ok, false);
  assert.equal(validateAiContract({ decision: 'APPROVE' }).ok, false);
  assert.equal(toAiContract(null, null, 0).decision, 'ABSTAIN');
});

// ---------------------------------------------------------------------------------------------------------------- execution gate
const nowSec = last.time + TF + 6;
const base = (o: Partial<GateInput> = {}): GateInput => ({
  nowSec, tf: TF, expirySec: 300, engineSide: 'BUY', aiDecision: 'APPROVE', aiDirection: 'BUY', controllerEligible: true, controllerReason: '', hybridAllow: true, hybridReason: '',
  closed: cs, signalCandleTime: last.time, screenshotCandleTime: last.time, requireScreenshot: true,
  entryRef: last.close, currentPrice: last.close + 0.01, atr: atr14(cs), maxDeviationAtr: 0.35, maxEntryDelaySec: 45,
  duplicate: false, conflicting: false, brokerConnected: true, expiryOffered: true, stake: 10, maxStake: 50,
  risk: { tradesTaken: 1, maxTrades: 10, lossStreak: 0, maxLossStreak: 3, pnl: 0, stopLoss: 50 }, ...o,
});
test('execution gate: all mandatory checks pass -> TRADE', () => {
  const g = runExecutionGate(base());
  assert.equal(g.action, 'TRADE', g.reason); assert.equal(g.failed.length, 0);
});
test('execution gate: every single failed mandatory check returns NO_TRADE, even with an AI approval', () => {
  const cases: [string, Partial<GateInput>][] = [
    ['ENGINE_SIGNAL', { engineSide: null }], ['AI_APPROVED', { aiDecision: 'ABSTAIN' }], ['DIRECTIONS_AGREE', { aiDirection: 'SELL' }],
    ['CONTROLLER_ELIGIBLE', { controllerEligible: false, controllerReason: 'policy' }], ['HYBRID_GATE', { hybridAllow: false, hybridReason: 'veto' }],
    ['SIGNAL_CANDLE_IS_LAST', { closed: cs.slice(0, -1) }], ['DATA_FRESH', { nowSec: last.time + TF * 2 + 1 }], ['ENTRY_DELAY', { nowSec: last.time + TF + 46 }],
    ['SCREENSHOT_SYNC', { screenshotCandleTime: last.time - TF }], ['SCREENSHOT_SYNC', { screenshotCandleTime: null }],
    ['ENTRY_DEVIATION', { currentPrice: last.close + 5 }], ['ENTRY_DEVIATION', { currentPrice: null }], ['ENTRY_DEVIATION', { atr: null }],
    ['NO_DUPLICATE', { duplicate: true }], ['NO_CONFLICT', { conflicting: true }], ['BROKER_CONNECTED', { brokerConnected: false }], ['BROKER_CONNECTED', { brokerConnected: null }],
    ['EXPIRY_SUPPORTED', { expiryOffered: false }], ['EXPIRY_SUPPORTED', { expirySec: 60 }],
    ['RISK_LIMITS', { risk: { tradesTaken: 10, maxTrades: 10, lossStreak: 0, maxLossStreak: 3, pnl: 0, stopLoss: 50 } }],
    ['RISK_LIMITS', { risk: { tradesTaken: 1, maxTrades: 10, lossStreak: 3, maxLossStreak: 3, pnl: 0, stopLoss: 50 } }],
    ['RISK_LIMITS', { risk: { tradesTaken: 1, maxTrades: 10, lossStreak: 0, maxLossStreak: 3, pnl: -50, stopLoss: 50 } }],
    ['STAKE_LIMIT', { stake: 51 }], ['DATA_FRESH', { nowSec: null }],
  ];
  for (const [id, o] of cases) {
    const g = runExecutionGate(base(o));
    assert.equal(g.action, 'NO_TRADE', `${id} ${JSON.stringify(o).slice(0, 60)}`);
    assert.ok(g.failed.some((c) => c.id === id), `${id} should be among ${g.failed.map((c) => c.id)}`);
  }
});
test('execution gate: a gap or invalid candle in the sequence blocks; engine-only by explicit policy waives only the two AI checks', () => {
  const gap = [...cs.slice(0, -2), { ...cs[cs.length - 2], time: cs[cs.length - 2].time + TF }, last];
  assert.ok(candleIntegrity(gap, TF).length > 0);
  assert.equal(runExecutionGate(base({ closed: gap })).failed[0].id, 'CANDLE_SEQUENCE');
  assert.ok(candleIntegrity([...cs.slice(0, -1), { ...last, high: last.low - 1 }], TF).some((x) => /invalid OHLC/.test(x)));
  const e = runExecutionGate(base({ aiDecision: 'RETRY', aiDirection: 'NO_TRADE', engineOnlyByPolicy: true, screenshotCandleTime: null, requireScreenshot: false }));
  assert.equal(e.action, 'TRADE', e.reason);
  assert.equal(runExecutionGate(base({ aiDecision: 'RETRY', aiDirection: 'NO_TRADE', engineOnlyByPolicy: true, engineSide: null })).action, 'NO_TRADE');
});

// ---------------------------------------------------------------------------------------------------------------- scanning vs. ordering
test('scanning does not use up the candle (regression): the second look before the order still sees the setup; only the claim blocks it', async () => {
  const ledger = new ExecutionLedger();
  const s = await getSignal(mk(fakeAi(), confirm), cs, TF, 'EURUSD', 'a1');
  const ctx = { market: 'quotex:EURUSD', label: 'EURUSD', tfSec: TF, clk: nowAfter(cs) / 1000, candles: cs, ledger };
  const first: any = lookFromSignal(s, ctx), second: any = lookFromSignal(s, ctx);
  assert.equal(first.side, 'buy'); assert.equal(second.side, 'buy'); assert.equal(second.ref.side, 'BUY');
  assert.equal(second.ref.aiDecision, 'APPROVE'); assert.equal(second.ref.candleTime, last.time); assert.equal(second.ref.refPrice, last.close);
  assert.ok(ledger.claim(`${second.ref.signalKey}|BUY`));
  assert.deepEqual(lookFromSignal(s, ctx), { none: 'this candle was already traded' });
  ledger.release(`${second.ref.signalKey}|BUY`);
  assert.equal((lookFromSignal(s, ctx) as any).side, 'buy');
});
test('a hybrid-blocked or not-tradeable signal never becomes an auto look', async () => {
  const s = await getSignal(mk(fakeAi(), veto), cs, TF, 'EURUSD', 'a2');
  const r: any = lookFromSignal(s, { market: 'm', label: 'EURUSD', tfSec: TF, clk: nowAfter(cs) / 1000, candles: cs, ledger: new ExecutionLedger() });
  assert.ok('none' in r); assert.match(r.none, /hybrid gate/);
});

// ---------------------------------------------------------------------------------------------------------------- log + analytics
test('log: one candidate per candle and side, shadow results settle on the NEXT candle only, cohorts compare on equal terms', () => {
  const log = new TradeLog(null);
  const T = 1_700_000_100;
  const cand = (t: number, side: 'BUY' | 'SELL', decision: string, hybridAllow: boolean | null = true) => log.candidate({ market: 'q:EURUSD', label: 'EURUSD', tf: TF, candleTime: t, side, pattern: 'sweep', engineConfidence: 70, decision, aiContract: null, hybridStatus: null, hybridAllow, hybridProbability: null, screenshotStatus: null, visualDisagreement: false, tradeable: decision === 'APPROVED' && hybridAllow !== false, aiError: null });
  cand(T, 'BUY', 'APPROVED'); cand(T, 'BUY', 'APPROVED');                 // duplicate scan
  cand(T + 2 * TF, 'BUY', 'REJECTED'); cand(T + 4 * TF, 'SELL', 'APPROVED', false); cand(T + 6 * TF, 'BUY', 'REVIEW');
  assert.equal(log.events().filter((e) => e.type === 'CANDIDATE').length, 4);
  // candles: the entry candle after each signal
  const c = (t: number, o: number, cl: number) => ({ time: t, open: o, close: cl });
  log.resolveShadows('q:EURUSD', [c(T + TF, 1, 2)]);                       // BUY wins
  assert.equal(log.events().filter((e) => e.type === 'SHADOW').length, 1);
  log.resolveShadows('q:EURUSD', [c(T + TF, 1, 2), c(T + 3 * TF, 5, 4), c(T + 5 * TF, 5, 4), c(T + 7 * TF, 3, 3)]);   // BUY loses, SELL wins, BUY ties
  const a = analyze(log.events(), 0.9);
  assert.equal(a.cohorts.strategyOnly.n, 4); assert.equal(a.cohorts.strategyOnly.resolved, 4);
  assert.equal(a.cohorts.strategyOnly.wins, 2); assert.equal(a.cohorts.strategyOnly.losses, 1); assert.equal(a.cohorts.strategyOnly.ties, 1);
  assert.ok(Math.abs(a.cohorts.strategyOnly.evPerUnit! - (2 * 0.9 - 1) / 4) < 1e-9);
  assert.equal(a.cohorts.aiApproved.n, 2); assert.equal(a.cohorts.aiRejected.n, 1); assert.equal(a.cohorts.aiAbstained.n, 1);
  assert.equal(a.cohorts.hybridVetoed.n, 1); assert.equal(a.cohorts.finalTradeable.n, 1);
  assert.ok(Math.abs(a.breakEvenWinRate - 1 / 1.9) < 1e-12);
  assert.equal(a.broker.orders, 0); assert.equal(a.broker.resolved, 0);       // nothing was traded, so no broker result exists
  assert.equal(a.outOfSample, null);                                            // fewer than 20 candidates: no split is reported
});
test('log: orders and outcomes come from the broker only and are counted separately from shadow results', () => {
  const log = new TradeLog(null);
  const id = log.candidate({ market: 'q:EURUSD', label: 'EURUSD', tf: TF, candleTime: 1_700_000_100, side: 'BUY', pattern: 'sweep', engineConfidence: 70, decision: 'APPROVED', aiContract: null, hybridStatus: 'CONFIRMS', hybridAllow: true, hybridProbability: null, screenshotStatus: 'VERIFIED', visualDisagreement: false, tradeable: true, aiError: null });
  log.order({ id, brokerOrderId: 'B1', market: 'q:EURUSD', side: 'BUY', stake: 10, expirySec: 300, signalCloseTime: 1_700_000_400, requestedAtSec: 1_700_000_405, placedAtSec: 1_700_000_407, delaySec: 7, entryRef: 1, priceAtOrder: 1, settleAtSec: 1_700_000_707 });
  let a = analyze(log.events());
  assert.equal(a.broker.orders, 1); assert.equal(a.broker.resolved, 0); assert.equal(a.entryDelaySec.max, 7);
  log.outcome({ id, brokerOrderId: 'B1', outcome: 'loss', profit: -10 });
  a = analyze(log.events());
  assert.equal(a.broker.losses, 1); assert.equal(a.broker.wins, 0);
  assert.equal(a.cohorts.strategyOnly.resolved, 0);                              // the shadow result is still unknown
});
