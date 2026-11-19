import test from 'node:test';
import assert from 'node:assert/strict';
import { mtgStake, mtgPlan, mtgBlock, chooseTiming, summarize, autoTfForRound, TradeRec } from './tradeSession';
import { runChain, ChainDeps } from './classicTrader';
import { Autopilot, Deps, DEFAULT_CFG, MarketRef } from './autopilot';
import { Candle } from './analysis';

// ---------- martingale maths
test('MTG stakes grow by the multiplier and the worst case adds them all up', () => {
  assert.deepEqual(mtgPlan(10, { on: true, steps: 2, mult: 2.2 }).stakes, [10, 22, 48.4]);
  assert.equal(mtgPlan(10, { on: true, steps: 2, mult: 2.2 }).worstCase, 80.4);
  assert.deepEqual(mtgPlan(10, { on: false, steps: 3, mult: 2.2 }).stakes, [10]);        // off = no recovery steps
  assert.equal(mtgPlan(10, { on: true, steps: 9, mult: 2 }).stakes.length, 4);            // never more than 3 recovery steps
  assert.equal(mtgStake(1, 3, 2), 8);
});
test('MTG is blocked when the stake is over the balance or the loss limit', () => {
  assert.match(mtgBlock(50, { balance: 40, lossSoFar: 10 }), /more than your balance/);
  assert.match(mtgBlock(30, { balance: 500, lossSoFar: 25, stopLoss: 50 }), /loss limit/);
  assert.equal(mtgBlock(20, { balance: 500, lossSoFar: 10, stopLoss: 50 }), '');
});

// ---------- automatic timing (follows the execution policy: M5 locked to 300 s, others one candle)
test('auto timing: M5 trades 5 minutes, other time frames trade one candle, M5 is scanned first', () => {
  assert.equal(chooseTiming(300).expiry, 300);
  assert.equal(chooseTiming(60).expiry, 60);
  assert.equal(chooseTiming(60, 'frxXAUUSD').expiry, 240, 'Gold uses 4m (240s) expiry for 1m TF');
  assert.equal(chooseTiming(60, 'XAUUSD').expiry, 240, 'Gold alias uses 4m expiry');
  assert.equal(chooseTiming(900).expiry, 900);
  assert.equal(chooseTiming(1800).expiry, 1800);
  assert.deepEqual([1, 2, 3, 4].map(autoTfForRound), [300, 300, 300, 300]);
  assert.equal(DEFAULT_CFG.tfSec, 300);
});

// ---------- counters
test('summary counts wins, losses, pending and recovered chains', () => {
  const t = (result: TradeRec['result'], profit: number | null, step = 0): TradeRec => ({ id: Math.random() + '', ts: 0, symbol: 'X', label: 'X', side: 'buy', stake: 10, seconds: 60, tf: 60, step, result, profit });
  const s = summarize([t('loss', -10), t('win', 22, 1), t('pending', null), t('error', null), t('draw', 0), t('loss', -10)]);
  assert.deepEqual({ trades: s.trades, wins: s.wins, losses: s.losses, pending: s.pending, errors: s.errors, draws: s.draws, recovered: s.recovered, pnl: s.pnl, winRate: s.winRate }, { trades: 5, wins: 1, losses: 2, pending: 1, errors: 1, draws: 1, recovered: 1, pnl: 2, winRate: 33 });
});

// ---------- Classic mode chain
function chainRig(results: Array<'win' | 'loss' | 'draw' | null>, o: { reject?: number; balance?: number } = {}) {
  const placed: number[] = []; const recs = new Map<string, any>(); let i = 0, cancelled = false;
  const d: ChainDeps = {
    place: async (_s, stake) => { placed.push(stake); return placed.length === o.reject ? { ok: false, msg: 'no money' } : { ok: true, msg: '', id: 'c' + placed.length }; },
    result: async () => { const r = results[i++]; return r ? { outcome: r, profit: r === 'win' ? 9 : r === 'loss' ? -placed[placed.length - 1] : 0 } : null; },
    onRec: (r) => recs.set(r.id, r), balance: () => o.balance ?? 1000, cancelled: () => cancelled,
  };
  return { d, placed, recs, cancel: () => { cancelled = true; } };
}
const base = { symbol: 'R_100', label: 'V100', side: 'buy' as const, stake: 10, seconds: 60, tf: 60, payout: 90 };
test('chain: a win on the first entry places exactly one trade', async () => {
  const r = chainRig(['win']); const o = await runChain(r.d, { ...base, mtg: { on: true, steps: 2, mult: 2.2 } });
  assert.equal(o.final, 'win'); assert.deepEqual(r.placed, [10]); assert.equal(o.steps, 0);
});
test('chain: loss, loss, win with MTG 2 places 10, 22, 48.4 and ends in a win', async () => {
  const r = chainRig(['loss', 'loss', 'win']); const o = await runChain(r.d, { ...base, mtg: { on: true, steps: 2, mult: 2.2 } });
  assert.deepEqual(r.placed, [10, 22, 48.4]); assert.equal(o.final, 'win'); assert.equal(o.steps, 2);
  assert.equal(o.pnl, -10 - 22 + 9);
  assert.deepEqual([...r.recs.values()].map((x) => x.result), ['loss', 'loss', 'win']);
});
test('chain: MTG off stops after one loss; MTG 1 stops after two', async () => {
  const a = chainRig(['loss', 'win']); assert.equal((await runChain(a.d, { ...base, mtg: { on: false, steps: 3, mult: 2 } })).final, 'loss'); assert.equal(a.placed.length, 1);
  const b = chainRig(['loss', 'loss', 'win']); assert.equal((await runChain(b.d, { ...base, mtg: { on: true, steps: 1, mult: 2 } })).final, 'loss'); assert.equal(b.placed.length, 2);
});
test('chain: a recovery stake above the balance is never placed', async () => {
  const r = chainRig(['loss', 'win'], { balance: 15 }); const o = await runChain(r.d, { ...base, mtg: { on: true, steps: 2, mult: 2.2 } });
  assert.equal(r.placed.length, 1); assert.match(o.message, /balance/);
});
test('chain: a rejected order is recorded as an error and nothing else is placed', async () => {
  const r = chainRig([], { reject: 1 }); const o = await runChain(r.d, { ...base, mtg: { on: true, steps: 2, mult: 2 } });
  assert.equal(o.final, 'error'); assert.equal([...r.recs.values()][0].result, 'error');
});
test('chain: an unreadable result is an error, never a guessed win or loss, and never triggers MTG', async () => {
  const r = chainRig([null]); const o = await runChain(r.d, { ...base, mtg: { on: true, steps: 2, mult: 2 } });
  assert.equal(o.final, 'error'); assert.equal(r.placed.length, 1);
});
test('chain: a stop request between steps ends the chain', async () => {
  const r = chainRig(['loss', 'win']); const d = { ...r.d, result: async () => { r.cancel(); return { outcome: 'loss' as const, profit: -10 }; } };
  const o = await runChain(d, { ...base, mtg: { on: true, steps: 2, mult: 2 } }); assert.equal(o.final, 'cancelled'); assert.equal(r.placed.length, 1);
});

// ---------- Pro mode (server engine) with MTG
function series(n: number, step: number, start = 1.1): Candle[] {
  let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  const out: Candle[] = []; let px = start;
  for (let i = 0; i < n; i++) { const o = px, c = o + step + rnd() * 0.00015; out.push({ time: i * 60, open: o, close: c, high: Math.max(o, c) + 8e-5, low: Math.min(o, c) - 8e-5 }); px = c; }
  return out;
}
const M = (symbol: string): MarketRef => ({ symbol, label: symbol, payout: 90, active: true });
function proRig(outcomes: Array<'win' | 'loss'>, o: { gate?: (c: any) => { ok: boolean; reason: string }; stakeLimit?: number } = {}) {
  const placed: any[] = []; const gateCalls: any[] = []; const watched: number[] = []; let k = 0, sleeps = 0;
  const data = series(120, 0.0003);
  const deps: Deps = {
    assets: () => [M('UP')],
    watch: async (sym, tf) => (watched.push(tf), { candles: data, price: () => data[data.length - 1].close, close() {} }),
    place: async (symbol, side, stake, seconds) => { placed.push({ symbol, side, stake, seconds }); return { ok: true, msg: '', id: 't' + placed.length }; },
    result: async () => { const o = outcomes[k++] ?? 'win'; return { outcome: o, profit: o === 'win' ? 9 : -placed[placed.length - 1].stake }; },
    sleep: async () => { if (++sleeps > 400) throw new Error('runaway'); await Promise.resolve(); },
    ...(o.gate ? { preflight: async (c: any) => { gateCalls.push(c); return o.gate!(c); } } : {}),
    ...(o.stakeLimit != null ? { stakeLimit: () => o.stakeLimit! } : {}),
  };
  return { deps, placed, gateCalls, watched };
}
const cfg = { ...DEFAULT_CFG, minConf: 55, maxTrades: 1, stopLoss: 500 };

test('Pro: MTG off, a loss is one trade', async () => {
  const r = proRig(['loss']); const ap = new Autopilot(r.deps, { ...cfg, mtg: false }); await ap.start();
  assert.deepEqual(r.placed.map((p) => p.stake), [10]); assert.equal(ap.state.stats.losses, 1);
});
test('Pro: MTG on recovers in the same market with growing stakes and counts every order', async () => {
  const r = proRig(['loss', 'loss', 'win']); const ap = new Autopilot(r.deps, { ...cfg, mtg: true, mtgSteps: 2, mtgMult: 2.2 }); await ap.start();
  assert.deepEqual(r.placed.map((p) => p.stake), [10, 22, 48.4]); assert.ok(r.placed.every((p) => p.symbol === 'UP' && p.side === 'buy'));
  const s = ap.state.stats; assert.deepEqual({ t: s.trades, w: s.wins, l: s.losses, rec: s.recovered }, { t: 3, w: 1, l: 2, rec: 1 });
  assert.equal(s.pnl, -10 - 22 + 9);
  assert.deepEqual(ap.state.trades!.map((t) => t.result).reverse(), ['loss', 'loss', 'win']); assert.equal(ap.state.trades!.filter((t) => t.result === 'pending').length, 0);
});
test('Pro: MTG never goes past its step limit', async () => {
  const r = proRig(['loss', 'loss', 'loss', 'loss']); const ap = new Autopilot(r.deps, { ...cfg, mtg: true, mtgSteps: 1, mtgMult: 2 }); await ap.start();
  assert.deepEqual(r.placed.map((p) => p.stake), [10, 20]);
});
test('Pro: MTG stops when the next stake would pass the loss limit', async () => {
  const r = proRig(['loss', 'loss', 'loss']); const ap = new Autopilot(r.deps, { ...cfg, mtg: true, mtgSteps: 3, mtgMult: 2, stopLoss: 40 }); await ap.start();
  assert.deepEqual(r.placed.map((p) => p.stake), [10, 20]);   // 10 + 20 lost = 30; a 40 stake would break the 40 limit
  assert.ok(ap.state.log.some((l) => /loss limit/.test(l.text)));
});
test('Pro: your own expiry is used and the gate is told it was your choice', async () => {
  const a = proRig(['win'], { gate: () => ({ ok: true, reason: '' }) }); await new Autopilot(a.deps, { ...cfg, tfSec: 60, expirySec: 180 }).start();
  assert.equal(a.placed[0].seconds, 180); assert.equal(a.gateCalls[0].seconds, 180); assert.equal(a.gateCalls[0].tf, 60); assert.equal(a.gateCalls[0].expiryByUser, true);
});
test('Pro: auto timing scans M5 first and uses the policy expiry (5-minute chart = 300 s), not a guess', async () => {
  const b = proRig(['win'], { gate: () => ({ ok: true, reason: '' }) }); const ap = new Autopilot(b.deps, { ...cfg, autoTiming: true }); await ap.start();
  assert.equal(b.watched[0], 300); assert.equal(b.placed[0].seconds, 300); assert.equal(b.gateCalls[0].expiryByUser, false); assert.match(ap.state.timing!, /5-minute/);
});
test('Pro: the execution gate runs before the first order, and a refusal means no order at all', async () => {
  let ap!: Autopilot;
  const r = proRig(['loss', 'win'], { gate: () => { queueMicrotask(() => ap.stop('test over')); return { ok: false, reason: 'ENTRY_DELAY failed' }; } });
  ap = new Autopilot(r.deps, { ...cfg, mtg: true, mtgSteps: 2 }); await ap.start();
  assert.equal(r.placed.length, 0); assert.ok(r.gateCalls.length >= 1); assert.ok(ap.state.log.some((l) => /NO TRADE, ENTRY_DELAY failed/.test(l.text)));
});
test('Pro: the gate is asked once per setup, not again for MTG recovery steps', async () => {
  const r = proRig(['loss', 'loss', 'win'], { gate: () => ({ ok: true, reason: '' }) });
  await new Autopilot(r.deps, { ...cfg, mtg: true, mtgSteps: 2 }).start();
  assert.equal(r.placed.length, 3); assert.equal(r.gateCalls.length, 1);
});
test('Pro: MTG never goes past MAX_STAKE', async () => {
  const r = proRig(['loss', 'loss', 'loss'], { stakeLimit: 25 }); const ap = new Autopilot(r.deps, { ...cfg, mtg: true, mtgSteps: 3, mtgMult: 2.2 }); await ap.start();
  assert.deepEqual(r.placed.map((p) => p.stake), [10, 22]); assert.ok(ap.state.log.some((l) => /MAX_STAKE/.test(l.text)));
});
