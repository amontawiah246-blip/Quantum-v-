import test from 'node:test';
import assert from 'node:assert/strict';
import { createFailoverCaller, createNvidiaCaller, nvidiaBody } from './nvidiaVision';
import { AiRequest, AiUnavailableError, candleLabel } from './aiVerification';
import { runExecutionGate } from './executionGate';
import { PNG, TF, market, reply, withSweep } from './aiFixtures';

function sampleReq(cs = withSweep(market('up'), 'BUY')): AiRequest {
  const t = cs[cs.length - 1].time;
  return {
    requestId: 'req12345',
    system: 'Reply with JSON only.',
    prompt: 'Verify setup',
    image: {
      mimeType: 'image/png',
      base64: Buffer.from(PNG).toString('base64'),
      sha256: 'abc',
      lastCandleTime: t,
      lastCandleLabel: candleLabel(t),
      renderedAt: t,
      candleSetHash: 'hash',
    },
    ruleIds: ['SWEEP_WICK_PENETRATION'],
    signalCandleTime: t,
    expectedCandleLabel: candleLabel(t),
  };
}

test('nvidiaBody attaches PNG as image_url and flags imageSent=true', () => {
  const req = sampleReq();
  const { body, imageSent } = nvidiaBody(req, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.equal(imageSent, true);
  assert.equal(body.model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  const userContent = body.messages[1].content as any[];
  assert.equal(userContent.length, 2);
  assert.equal(userContent[1].type, 'image_url');
  assert.ok(String(userContent[1].image_url.url).startsWith('data:image/png;base64,'));
});

test('createNvidiaCaller fails over across models on HTTP errors and malformed JSON', async () => {
  const req = sampleReq();
  const tried: string[] = [];
  const caller = createNvidiaCaller({
    apiKey: 'nvapi-test',
    models: ['m1-429', 'm2-bad-json', 'm3-ok'],
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body));
      tried.push(payload.model);
      if (payload.model === 'm1-429') return new Response('{}', { status: 429 });
      if (payload.model === 'm2-bad-json') {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: reply(req) } }] }), { status: 200 });
    }) as typeof fetch,
  });

  const res = await caller(req);
  assert.equal(res.imageSent, true);
  assert.deepEqual(tried, ['m1-429', 'm2-bad-json', 'm3-ok']);
});

test('createFailoverCaller switches from NVIDIA to Gemini if all NVIDIA models fail', async () => {
  const req = sampleReq();
  const order: string[] = [];
  const caller = createFailoverCaller([
    {
      name: 'nvidia',
      caller: async () => {
        order.push('nvidia');
        throw new AiUnavailableError('RATE_LIMITED', 'nvidia 429');
      },
    },
    {
      name: 'gemini',
      caller: async (r) => {
        order.push('gemini');
        return { text: reply(r), imageSent: true };
      },
    },
  ]);

  const res = await caller(req);
  assert.deepEqual(order, ['nvidia', 'gemini']);
  assert.equal(res.imageSent, true);
});

test('runExecutionGate waives SCREENSHOT_SYNC when engineOnlyByPolicy is true', () => {
  const closed = withSweep(market('up'), 'BUY');
  const last = closed[closed.length - 1];
  const base = {
    nowSec: last.time + TF + 5,
    tf: TF,
    expirySec: TF,
    engineSide: 'BUY' as const,
    aiDecision: 'RETRY' as const,
    aiDirection: 'NO_TRADE' as const,
    controllerEligible: true,
    controllerReason: 'ok',
    hybridAllow: true,
    hybridReason: 'ok',
    closed,
    signalCandleTime: last.time,
    screenshotCandleTime: null,
    requireScreenshot: true,
    entryRef: last.close,
    currentPrice: last.close,
    atr: 1,
    maxDeviationAtr: 0.35,
    maxEntryDelaySec: 90,
    duplicate: false,
    conflicting: false,
    brokerConnected: true,
    expiryOffered: true,
    stake: 10,
    maxStake: null,
    risk: { tradesTaken: 0, maxTrades: 10, lossStreak: 0, maxLossStreak: 3, pnl: 0, stopLoss: 50 },
  };

  const blocked = runExecutionGate({ ...base, engineOnlyByPolicy: false });
  assert.equal(blocked.action, 'NO_TRADE');
  assert.ok(blocked.failed.some((c) => c.id === 'SCREENSHOT_SYNC'));

  const allowed = runExecutionGate({ ...base, engineOnlyByPolicy: true });
  assert.equal(allowed.action, 'TRADE', allowed.reason);
});
