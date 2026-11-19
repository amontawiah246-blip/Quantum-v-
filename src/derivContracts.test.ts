import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateRiseFallSupport,
  getRiseFallStaticLimit,
  parseDerivDurationSec,
} from './derivContracts';

test('parseDerivDurationSec parses seconds, minutes, hours, days and ignores ticks', () => {
  assert.equal(parseDerivDurationSec('15s'), 15);
  assert.equal(parseDerivDurationSec('5m'), 300);
  assert.equal(parseDerivDurationSec('10h'), 36000);
  assert.equal(parseDerivDurationSec('1d'), 86400);
  assert.ok(Number.isNaN(parseDerivDurationSec('5t')));
});

test('evaluateRiseFallSupport rejects BOOM, CRASH, 1HZ150V, and 1HZ250V', () => {
  for (const sym of ['BOOM300', 'BOOM500', 'BOOM1000', 'CRASH300', 'CRASH500', 'CRASH1000', '1HZ150V', '1HZ250V']) {
    const r = evaluateRiseFallSupport(sym, 60);
    assert.equal(r.ok, false, `${sym} must not be treated as Rise/Fall tradeable`);
    assert.ok(r.reason && r.reason.length > 5);
  }
});

test('evaluateRiseFallSupport enforces minimum 5m expiry for frxXAUUSD and 15m for WLDXAU', () => {
  assert.equal(evaluateRiseFallSupport('frxXAUUSD', 60).ok, false);
  assert.equal(evaluateRiseFallSupport('frxXAUUSD', 240).ok, false);
  assert.equal(evaluateRiseFallSupport('frxXAUUSD', 300).ok, true);
  assert.equal(evaluateRiseFallSupport('frxXAUUSD', 600).ok, true);

  assert.equal(evaluateRiseFallSupport('WLDXAU', 300).ok, false);
  assert.equal(evaluateRiseFallSupport('WLDXAU', 900).ok, true);
});

test('evaluateRiseFallSupport permits standard Volatility, Step, and Jump symbols', () => {
  for (const sym of ['1HZ10V', '1HZ100V', 'R_10', 'R_100', 'stpRNG', 'JD10', 'JD100']) {
    assert.equal(getRiseFallStaticLimit(sym), null);
    assert.equal(evaluateRiseFallSupport(sym, 60).ok, true);
    assert.equal(evaluateRiseFallSupport(sym, 300).ok, true);
  }
});

test('evaluateRiseFallSupport respects dynamic cached limits from contracts_for', () => {
  const custom = { supported: true, minSec: 120, maxSec: 1800 };
  assert.equal(evaluateRiseFallSupport('R_100', 60, custom).ok, false);
  assert.equal(evaluateRiseFallSupport('R_100', 120, custom).ok, true);
  assert.equal(evaluateRiseFallSupport('R_100', 3600, custom).ok, false);
});
