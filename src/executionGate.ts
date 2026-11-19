// INDEPENDENT EXECUTION SAFETY GATE.
//
// Runs immediately before an order is sent. It does not trust the AI, the hybrid layer or the earlier scan: every check is recomputed
// from the inputs given here, and ANY failed or unknowable mandatory check returns NO_TRADE. An AI "APPROVE" is just one input.
import { validOhlc } from './candleMath';
import type { Bar } from './patternVerification';

export type GateSide = 'BUY' | 'SELL';
export interface GateCheck { id: string; pass: boolean; detail: string }
export interface GateResult { action: 'TRADE' | 'NO_TRADE'; checks: GateCheck[]; failed: GateCheck[]; reason: string }

export interface GateInput {
  nowSec: number | null;                     // broker clock (seconds); null = unknown -> fail
  tf: number;
  expirySec: number;
  /** true when the user picked this expiry in the app. Without it only the policy expiry passes: 300 s on the 5-minute chart, one candle on any other chart. */
  expiryChosenByUser?: boolean;
  /** the strategy engine's own side for this candle (null = it has no valid signal) */
  engineSide: GateSide | null;
  /** the verdict the AI contract carried: direction is BUY/SELL only for APPROVE */
  aiDecision: 'APPROVE' | 'REJECT' | 'ABSTAIN' | 'RETRY' | null;
  aiDirection: GateSide | 'NO_TRADE' | null;
  /** the user explicitly set AI_UNAVAILABLE_POLICY=allow_engine_only and the AI could not answer: the two AI checks are waived and the trade is labelled NOT visually verified */
  engineOnlyByPolicy?: boolean;
  /** what the existing execution controller (decideExecution + user policy) said, and the hybrid gate */
  controllerEligible: boolean; controllerReason: string;
  hybridAllow: boolean; hybridReason: string;
  /** closed candles the signal was computed from (oldest first) */
  closed: Bar[];
  signalCandleTime: number;
  /** open time of the last candle drawn in the screenshot the AI inspected (null = no screenshot) */
  screenshotCandleTime: number | null;
  requireScreenshot: boolean;
  entryRef: number | null; currentPrice: number | null; atr: number | null; maxDeviationAtr: number;
  maxEntryDelaySec: number;
  duplicate: boolean; conflicting: boolean;
  brokerConnected: boolean | null; expiryOffered: boolean | null;
  stake: number; maxStake: number | null;
  risk: { tradesTaken: number; maxTrades: number; lossStreak: number; maxLossStreak: number; pnl: number; stopLoss: number };
}

/** Candle sequence integrity: valid OHLC, strictly increasing, exactly `tf` apart (no missing or duplicate candles) over the last `look` candles. */
export function candleIntegrity(closed: Bar[], tf: number, look = 40): string[] {
  const issues: string[] = [];
  const rows = closed.slice(-look);
  if (rows.length < 20) issues.push(`only ${rows.length} closed candles`);
  rows.forEach((c, i) => {
    if (!validOhlc(c as any)) issues.push(`invalid OHLC at ${c.time}`);
    if (i && c.time - rows[i - 1].time !== tf) issues.push(`candle spacing ${c.time - rows[i - 1].time}s at ${c.time} (expected ${tf}s)`);
  });
  return issues.slice(0, 6);
}

export function atr14(bars: Bar[]): number | null {
  const rows = bars.slice(-15);
  if (rows.length < 15) return null;
  const tr = rows.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - rows[i].close), Math.abs(b.low - rows[i].close)));
  const v = tr.reduce((s, x) => s + x, 0) / tr.length;
  return v > 0 ? v : null;
}

export function runExecutionGate(i: GateInput): GateResult {
  const checks: GateCheck[] = [];
  const add = (id: string, pass: boolean, detail: string) => checks.push({ id, pass, detail });
  const last = i.closed[i.closed.length - 1];
  const closeAt = i.signalCandleTime + i.tf;

  add('ENGINE_SIGNAL', !!i.engineSide, i.engineSide ? `strategy engine signal ${i.engineSide}` : 'the strategy engine has no valid signal');
  const waived = !!i.engineOnlyByPolicy;
  add('AI_APPROVED', waived || i.aiDecision === 'APPROVE', waived ? 'AI unavailable; waived by your allow_engine_only policy (NOT visually verified)' : `AI decision ${i.aiDecision ?? 'none'}`);
  add('DIRECTIONS_AGREE', waived ? !!i.engineSide : !!i.engineSide && i.aiDirection === i.engineSide, waived ? 'engine direction only (no AI answer)' : `engine ${i.engineSide ?? 'none'} vs AI ${i.aiDirection ?? 'none'}`);
  add('CONTROLLER_ELIGIBLE', i.controllerEligible, i.controllerEligible ? 'execution controller allows it' : `execution controller: ${i.controllerReason}`);
  add('HYBRID_GATE', i.hybridAllow, i.hybridAllow ? 'hybrid gate allows it' : `hybrid gate: ${i.hybridReason}`);

  const integrity = candleIntegrity(i.closed, i.tf);
  add('CANDLE_SEQUENCE', integrity.length === 0, integrity.length ? integrity.join('; ') : 'candles chronological, correctly spaced, valid OHLC');
  const lastIsSignal = !!last && last.time === i.signalCandleTime;
  add('SIGNAL_CANDLE_IS_LAST', lastIsSignal, lastIsSignal ? 'the analysed candle is the newest closed candle' : `newest closed candle ${last?.time ?? 'none'} is not the signal candle ${i.signalCandleTime}`);
  if (i.nowSec == null) { add('DATA_FRESH', false, 'no broker clock'); add('ENTRY_DELAY', false, 'no broker clock'); }
  else {
    const since = i.nowSec - closeAt;
    add('DATA_FRESH', since >= 0 && since < i.tf, since < 0 ? `the signal candle has not closed yet (${-since}s left)` : since >= i.tf ? `data is ${Math.round(since)}s past the candle close: a newer candle should exist (missing or stale data)` : 'no newer candle is missing');
    add('ENTRY_DELAY', since >= 0 && since <= i.maxEntryDelaySec, `${Math.round(since)}s after the candle close (limit ${i.maxEntryDelaySec}s)`);
  }
  const shotOk = waived || (i.screenshotCandleTime === null ? !i.requireScreenshot : i.screenshotCandleTime === i.signalCandleTime);
  add('SCREENSHOT_SYNC', shotOk, waived ? 'no screenshot; waived by allow_engine_only policy (NOT visually verified)' : i.screenshotCandleTime === null ? (i.requireScreenshot ? 'no screenshot, and the policy requires one' : 'no screenshot (policy does not require one)') : i.screenshotCandleTime === i.signalCandleTime ? 'screenshot ends on the analysed candle' : `screenshot ends on ${i.screenshotCandleTime}, analysis on ${i.signalCandleTime}`);

  if (i.entryRef == null || i.currentPrice == null || !i.atr) add('ENTRY_DEVIATION', false, `cannot measure the price move (reference ${i.entryRef ?? 'none'}, price ${i.currentPrice ?? 'none'}, ATR ${i.atr ?? 'none'})`);
  else {
    const move = i.currentPrice - i.entryRef, adverse = i.engineSide === 'BUY' ? -move : i.engineSide === 'SELL' ? move : Math.abs(move);
    const units = Math.abs(move) / i.atr;
    // a move beyond the limit in either direction cancels: against us it is a worse price, in favour of us the setup may already have played out
    add('ENTRY_DEVIATION', units <= i.maxDeviationAtr, `price moved ${move >= 0 ? '+' : ''}${move.toPrecision(4)} = ${units.toFixed(2)} ATR since the signal candle closed (${adverse > 0 ? 'against' : 'with'} the trade; limit ${i.maxDeviationAtr} ATR)`);
  }
  add('NO_DUPLICATE', !i.duplicate, i.duplicate ? 'an order for this candle and side already exists' : 'no earlier order for this candle');
  add('NO_CONFLICT', !i.conflicting, i.conflicting ? 'an opposite or unresolved conflicting signal exists for this candle' : 'no conflicting signal');
  add('BROKER_CONNECTED', i.brokerConnected === true, i.brokerConnected === true ? 'broker connection active' : i.brokerConnected === false ? 'broker is not connected' : 'broker connection could not be confirmed');
  add('EXPIRY_SUPPORTED', (i.expirySec === 300 || i.expiryChosenByUser === true || (i.tf !== 300 && i.expirySec === i.tf)) && i.expiryOffered === true, i.expiryOffered === true ? `${i.expirySec}s expiry offered` : i.expiryOffered === false ? `the broker does not offer a ${i.expirySec}s expiry for this market` : 'expiry support could not be confirmed');
  const r = i.risk;
  const riskBad = r.tradesTaken >= r.maxTrades ? `trade limit ${r.maxTrades} reached` : r.lossStreak >= r.maxLossStreak ? `${r.lossStreak} losses in a row` : r.pnl <= -r.stopLoss ? `loss limit ${r.stopLoss} reached` : '';
  add('RISK_LIMITS', !riskBad, riskBad || 'within trade count, loss streak and loss limits');
  add('STAKE_LIMIT', i.stake > 0 && (i.maxStake == null || i.stake <= i.maxStake), i.maxStake == null ? `stake ${i.stake} (no MAX_STAKE configured)` : `stake ${i.stake} (limit ${i.maxStake})`);

  const failed = checks.filter((c) => !c.pass);
  return { action: failed.length ? 'NO_TRADE' : 'TRADE', checks, failed, reason: failed.length ? failed.map((c) => `${c.id}: ${c.detail}`).join(' | ').slice(0, 400) : 'all mandatory checks passed' };
}
