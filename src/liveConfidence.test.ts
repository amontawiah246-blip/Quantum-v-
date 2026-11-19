import test from 'node:test';
import assert from 'node:assert/strict';
import { liveConfidence, liveShort, LIVE_MIN_RESOLVED } from './liveConfidence';
import type { LogEvent } from './tradeLog';

let k = 0;
function mk(market: string, tf: number, pattern: string, results: ('win' | 'loss' | 'tie' | null)[]): LogEvent[] {
  const out: LogEvent[] = [];
  for (const r of results) {
    const id = `i${k++}`;
    out.push({ type: 'CANDIDATE', id, ts: 1, market, label: market, tf, candleTime: k, side: 'BUY', pattern } as unknown as LogEvent);
    if (r) out.push({ type: 'SHADOW', id, ts: 2, result: r, entry: 1, exit: 2 });
  }
  return out;
}
const rep = (w: number, l: number) => [...Array(w).fill('win'), ...Array(l).fill('loss')] as ('win' | 'loss')[];
const q = { market: 'R_50', tf: 300, pattern: 'sweep' };

test('no history: no percentage, says collecting', () => {
  const r = liveConfidence([], q);
  assert.equal(r.pct, null); assert.equal(r.ready, false); assert.match(r.text, /Collecting data/);
});
test('too few settled setups: no percentage even if all wins', () => {
  const r = liveConfidence(mk('R_50', 300, 'sweep', rep(LIVE_MIN_RESOLVED - 1, 0)), q);
  assert.equal(r.pct, null); assert.equal(r.n, LIVE_MIN_RESOLVED - 1);
});
test('enough data: real observed win rate with a range', () => {
  const r = liveConfidence(mk('R_50', 300, 'sweep', rep(30, 20)), q);
  assert.equal(r.ready, true); assert.equal(r.pct, 60); assert.equal(r.n, 50);
  assert.ok(r.lo! < 60 && r.hi! > 60); assert.equal(r.scope, 'market+pattern');
});
test('percentage follows the data, not a fixed table', () => {
  const a = liveConfidence(mk('R_50', 300, 'sweep', rep(40, 10)), q).pct;
  const b = liveConfidence(mk('R_50', 300, 'sweep', rep(10, 40)), q).pct;
  assert.equal(a, 80); assert.equal(b, 20);
});
test('falls back to a broader scope; ties and unsettled are ignored; other time frames are ignored', () => {
  const ev = [...mk('R_100', 300, 'sweep', rep(20, 20)), ...mk('R_50', 300, 'sweep', rep(2, 1)), ...mk('R_50', 300, 'sweep', ['tie', null, null]), ...mk('R_50', 60, 'sweep', rep(100, 0))];
  const r = liveConfidence(ev, q);
  assert.equal(r.scope, 'timeframe+pattern'); assert.equal(r.n, 43); assert.equal(r.wins, 22);
});
test('verdict compares the range with break-even', () => {
  assert.equal(liveConfidence(mk('R_50', 300, 'sweep', rep(90, 10)), q).verdict, 'above');
  assert.equal(liveConfidence(mk('R_50', 300, 'sweep', rep(10, 90)), q).verdict, 'below');
  assert.equal(liveConfidence(mk('R_50', 300, 'sweep', rep(15, 15)), q, 0.9, 30).verdict, 'unclear');
});
test('short form', () => {
  assert.equal(liveShort(null), '');
  assert.match(liveShort(liveConfidence([], q)), /collecting 0\/30/);
  assert.match(liveShort(liveConfidence(mk('R_50', 300, 'sweep', rep(30, 20)), q)), /live 60% \(n=50\)/);
});
