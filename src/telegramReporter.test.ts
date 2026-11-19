import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TelegramLossReporter,
  computeIndicatorSummary,
  formatLossMessage,
  type TradeCandle,
} from './telegramReporter';
import { defaultRasterizer } from './screenshot';

function makeCandles(count = 45, tf = 60, startSec = 1_760_000_000): TradeCandle[] {
  const out: TradeCandle[] = [];
  let price = 1000;
  for (let i = 0; i < count; i++) {
    const wave = Math.sin(i * 0.35) * 4 + (i > 35 ? -1.4 * (i - 35) : 0.3 * i);
    const open = price;
    const close = Number((1000 + wave).toFixed(2));
    const high = Number((Math.max(open, close) + 1.8).toFixed(2));
    const low = Number((Math.min(open, close) - 1.6).toFixed(2));
    out.push({ time: startSec + i * tf, open, high, low, close });
    price = close;
  }
  return out;
}

test('formatLossMessage keeps short report inside caption and escapes HTML', () => {
  const candles = makeCandles(45);
  const indicators = computeIndicatorSummary(candles, 42, 44);
  const res = formatLossMessage({
    ctx: {
      contractId: '998877',
      symbol: 'R_100',
      market: 'Volatility 100 <1s>',
      side: 'BUY',
      stake: 10,
      seconds: 60,
      tf: 60,
      placedAtSec: candles[43].time,
      isDemo: true,
      mode: 'pro',
      entryPrice: 1005.25,
      why: 'Stoch cross <20 & RSI bounce',
    },
    outcome: {
      contractId: '998877',
      outcome: 'loss',
      profit: -10,
      entryPrice: 1005.25,
      exitPrice: 1001.1,
      entryTime: candles[43].time,
      exitTime: candles[44].time,
    },
    reasons: ['Bullish Stoch crossover', 'RSI oversold recovery'],
    explanation: 'Price swept support and closed bullish',
    engines: ['Stochastic + RSI', 'Sweep Engine'],
    aiConfidence: 84,
    aiBasis: 'NVIDIA Vision',
    indicators,
  });

  assert.equal(res.fullText, null);
  assert.ok(res.caption.length <= 1000);
  assert.match(res.caption, /Volatility 100 &lt;1s&gt;/);
  assert.match(res.caption, /Stoch cross &lt;20 &amp; RSI bounce/);
  assert.match(res.caption, /Stoch \(14,3,3\): %K \d+\.\d+ \/ %D \d+\.\d+ → %K \d+\.\d+ \/ %D \d+\.\d+/);
  assert.match(res.caption, /RSI \(14\): \d+\.\d+ → \d+\.\d+/);
  assert.match(res.caption, /84% confidence \(NVIDIA Vision\)/);
  assert.match(res.caption, /-\$10\.00/);
});

test('formatLossMessage splits oversized reasons into compact caption plus fullText', () => {
  const candles = makeCandles(45);
  const indicators = computeIndicatorSummary(candles, 42, 44);
  const longReasons = Array.from({ length: 6 }, (_, i) => `Detailed engine reason #${i + 1}: ` + 'X'.repeat(160));
  const res = formatLossMessage({
    ctx: {
      contractId: '112233',
      symbol: 'R_75',
      market: 'Volatility 75 Index',
      side: 'SELL',
      stake: 25,
      seconds: 120,
      tf: 60,
      placedAtSec: candles[43].time,
      isDemo: false,
      mode: 'classic',
      entryPrice: 50000,
    },
    outcome: {
      contractId: '112233',
      outcome: 'loss',
      profit: -25,
      entryPrice: 50000,
      exitPrice: 50120,
    },
    reasons: longReasons,
    explanation: 'Long AI reasoning: ' + 'Y'.repeat(300),
    engines: ['Classic Stoch+RSI'],
    aiConfidence: 79,
    aiBasis: 'AI Verified',
    indicators,
  });

  assert.ok(res.caption.length <= 1000);
  assert.ok(res.fullText !== null);
  assert.match(res.caption, /Full entry reasons &amp; AI breakdown sent below/);
  assert.match(res.fullText!, /Detailed engine reason #1/);
  assert.match(res.fullText!, /REAL/);
});

test('TelegramTradeReporter sends PNG chart + deduplicated reports for both wins and losses while skipping draws', async () => {
  const candles = makeCandles(45);
  const calls: Array<{ url: string; method: string; body: any }> = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method || 'GET', body: init?.body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const reporter = new TelegramLossReporter({
    getConfig: () => ({ token: '123:test-token', chatId: '5799629755' }),
    getCandles: async () => candles,
    rasterize: defaultRasterizer,
    fetchImpl: fakeFetch,
    enableBackgroundTimer: false,
  });

  reporter.registerPlacedTrade({
    contractId: 'draw-1',
    symbol: 'R_100',
    market: 'Volatility 100',
    side: 'SELL',
    stake: 5,
    seconds: 60,
    tf: 60,
    placedAtSec: candles[43].time,
    isDemo: true,
    mode: 'classic',
  });
  const drawSent = await reporter.handleTradeOutcome({ contractId: 'draw-1', outcome: 'draw', profit: 0 });
  assert.equal(drawSent, false);
  assert.equal(calls.length, 0);

  reporter.registerPlacedTrade({
    contractId: 'win-1',
    symbol: 'R_100',
    market: 'Volatility 100',
    side: 'BUY',
    stake: 5,
    seconds: 60,
    tf: 60,
    placedAtSec: candles[43].time,
    isDemo: true,
    mode: 'classic',
    reasons: ['Stoch bullish cross below 20'],
    entryPrice: candles[43].open,
  });
  const [w1, w2] = await Promise.all([
    reporter.handleTradeOutcome({
      contractId: 'win-1',
      outcome: 'win',
      profit: 4.75,
      entryPrice: candles[43].open,
      exitPrice: candles[44].close,
      entryTime: candles[43].time,
      exitTime: candles[44].time,
    }),
    reporter.handleTradeOutcome({ contractId: 'win-1', outcome: 'win', profit: 4.75 }),
  ]);
  assert.equal(w1, true);
  assert.equal(w2, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bot123:test-token/sendPhoto');
  const winForm = calls[0].body as FormData;
  const winCaption = String(winForm.get('caption'));
  assert.match(winCaption, /TRADE WIN REPORT/);
  assert.match(winCaption, /\+\$4\.75/);
  assert.match(winCaption, /Stoch bullish cross below 20/);
  const winPhoto = winForm.get('photo') as File;
  assert.ok(winPhoto);
  assert.equal(winPhoto.name, 'win-R_100-win-1.png');
  const winBytes = new Uint8Array(await winPhoto.arrayBuffer());
  assert.deepEqual(Array.from(winBytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);

  reporter.registerPlacedTrade({
    contractId: 'loss-1',
    symbol: 'R_100',
    market: 'Volatility 100',
    side: 'BUY',
    stake: 10,
    seconds: 60,
    tf: 60,
    placedAtSec: candles[43].time,
    isDemo: true,
    mode: 'pro',
    engines: ['Stochastic + RSI'],
    reasons: ['%K crossed above %D below 20', 'Support sweep rejection'],
    explanation: 'Bullish reversal wick at lower band',
    aiConfidence: 88,
    aiBasis: 'NVIDIA Nemotron Vision',
    signalCandleOpen: candles[42].time,
    entryPrice: candles[43].open,
  });

  const [r1, r2] = await Promise.all([
    reporter.handleTradeOutcome({
      contractId: 'loss-1',
      outcome: 'loss',
      profit: -10,
      entryPrice: candles[43].open,
      exitPrice: candles[44].close,
      entryTime: candles[43].time,
      exitTime: candles[44].time,
    }),
    reporter.handleTradeOutcome({
      contractId: 'loss-1',
      outcome: 'loss',
      profit: -10,
    }),
  ]);

  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.telegram.org/bot123:test-token/sendPhoto');
  assert.ok(calls[1].body instanceof FormData);

  const form = calls[1].body as FormData;
  assert.equal(form.get('chat_id'), '5799629755');
  assert.equal(form.get('parse_mode'), 'HTML');
  const caption = String(form.get('caption'));
  assert.match(caption, /TRADE LOSS REPORT/);
  assert.match(caption, /Volatility 100/);
  assert.match(caption, /%K crossed above %D below 20/);
  assert.match(caption, /NVIDIA Nemotron Vision/);
  assert.match(caption, /Stoch \(14,3,3\)/);

  const photo = form.get('photo') as File;
  assert.ok(photo, 'expected photo attachment');
  const bytes = new Uint8Array(await photo.arrayBuffer());
  assert.ok(bytes.length > 5000, `expected non-trivial PNG chart, got ${bytes.length} bytes`);
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);

  assert.equal(reporter.getStatus().reportedWins, 1);
  assert.equal(reporter.getStatus().reportedLosses, 1);
  assert.equal(reporter.getStatus().reportedTrades, 2);
});

test('TelegramLossReporter sends follow-up sendMessage when full breakdown overflows caption', async () => {
  const candles = makeCandles(45);
  const calls: Array<{ url: string; body: any }> = [];

  const reporter = new TelegramLossReporter({
    getConfig: () => ({ token: '123:test-token', chatId: '5799629755' }),
    getCandles: async () => candles,
    rasterize: defaultRasterizer,
    fetchImpl: async (input, init) => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push({ url, body: init?.body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    enableBackgroundTimer: false,
  });

  reporter.registerPlacedTrade({
    contractId: 'loss-overflow',
    symbol: 'R_50',
    market: 'Volatility 50',
    side: 'SELL',
    stake: 15,
    seconds: 60,
    tf: 60,
    placedAtSec: candles[43].time,
    isDemo: true,
    mode: 'classic',
    reasons: [
      'Reason 1 ' + 'A'.repeat(250),
      'Reason 2 ' + 'B'.repeat(250),
      'Reason 3 ' + 'C'.repeat(250),
    ],
    explanation: 'Detailed AI chart analysis: ' + 'D'.repeat(250),
    aiConfidence: 91,
    aiBasis: 'Vision Model',
  });

  const ok = await reporter.handleTradeOutcome({
    contractId: 'loss-overflow',
    outcome: 'loss',
    profit: -15,
    entryPrice: candles[43].open,
    exitPrice: candles[44].close,
  });

  assert.equal(ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/sendPhoto$/);
  assert.match(calls[1].url, /\/sendMessage$/);
  const parsed = JSON.parse(String(calls[1].body));
  assert.equal(parsed.chat_id, '5799629755');
  assert.equal(parsed.parse_mode, 'HTML');
  assert.match(parsed.text, /Reason 1/);
  assert.match(parsed.text, /Detailed AI chart analysis/);
});
