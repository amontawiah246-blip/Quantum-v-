// EXECUTION AND EXPIRY CONFIGURATION (pure helpers, no network).
//
//  * Primary chart timeframe is 5 minutes and a 5-minute chart ALWAYS trades a 5-minute (300 s) expiry. That lock is a hard rule of
//    `resolveExpiry`: no market condition, multiplier or broker list can change it.
//  * Other timeframes may get their expiry chosen automatically from the market condition (Engine 12 state). The default policy uses
//    expiry = timeframe x 1 for every condition, because no other multiple has been shown to help. Change `byCondition` only after the
//    backtest by expiry (npm run backtest -- --expiry ...) shows a difference that holds out of sample.
//  * Candle timeframe and trade expiry are different things: the candle only decides WHEN a signal can exist (after it closes); the expiry
//    decides how long the trade runs after the order is actually filled.
//  * A signal can only be acted on after its candle has completely closed. `planTrade` refuses earlier. The trade settles `expiry`
//    seconds after the ACTUAL fill (`recordFill`), not after the candle close.
import { ExhaustionState } from './exhaustionEngine';

export const FIVE_MINUTES = 300;

export interface ExpiryPolicy {
  /** timeframe (seconds) -> expiry (seconds) that is ALWAYS used for it. Default { 300: 300 }. */
  locked: Record<number, number>;
  /** multiple of the timeframe used for every other timeframe when the condition has no entry in `byCondition`. */
  defaultMultiple: number;
  byCondition: Partial<Record<ExhaustionState, number>>;
  minExpiry: number; maxExpiry: number;
}
export const EXPIRY_DEFAULTS: ExpiryPolicy = { locked: { [FIVE_MINUTES]: FIVE_MINUTES }, defaultMultiple: 1, byCondition: {}, minExpiry: 60, maxExpiry: 3600 };

export interface ExpiryChoice { expirySec: number; locked: boolean; ok: boolean; reason: string }

/** `brokerAllowed`: the durations (seconds) the broker offers for this market, if known. Non-locked choices snap to the nearest allowed value. */
export function resolveExpiry(tfSec: number, condition: ExhaustionState | null = null, policy: ExpiryPolicy = EXPIRY_DEFAULTS, brokerAllowed?: number[]): ExpiryChoice {
  if (!(tfSec > 0)) return { expirySec: 0, locked: false, ok: false, reason: 'invalid timeframe' };
  const lock = policy.locked[tfSec];
  if (lock !== undefined) {
    const offered = !brokerAllowed || brokerAllowed.includes(lock);
    return { expirySec: lock, locked: true, ok: offered, reason: offered ? `${tfSec}s chart always trades a ${lock}s expiry` : `${tfSec}s chart needs a ${lock}s expiry but the broker does not offer it for this market: no trade` };
  }
  const mult = (condition && policy.byCondition[condition]) || policy.defaultMultiple;
  let e = Math.min(policy.maxExpiry, Math.max(policy.minExpiry, tfSec * mult));
  if (brokerAllowed?.length) {
    const near = [...brokerAllowed].sort((a, b) => Math.abs(a - e) - Math.abs(b - e) || a - b)[0];
    return { expirySec: near, locked: false, ok: true, reason: `${tfSec}s chart, ${condition ?? 'no condition'}: wanted ${e}s, nearest broker expiry ${near}s` };
  }
  return { expirySec: e, locked: false, ok: true, reason: `${tfSec}s chart x ${mult}${condition ? ` (${condition})` : ''}` };
}

// ------------------------------------------------------------------------------------------------ trade lifecycle
export interface ExecutionConfig {
  tfSec: number;               // 300
  expirySec: number;           // 300
  maxEntryDelaySec: number;    // a signal older than this when the order could be sent is stale and is dropped (10)
}
export const QUANTUM_EXECUTION: ExecutionConfig = { tfSec: FIVE_MINUTES, expirySec: FIVE_MINUTES, maxEntryDelaySec: 10 };

export interface TradePlan { symbol: string; side: 'BUY' | 'SELL'; signalCandleTime: number; signalCloseTime: number; tfSec: number; expirySec: number }
export interface TradeFill { executionTime: number; entryPrice: number }
export interface TradeRecord extends TradePlan { executionTime: number; entryPrice: number; delaySec: number; settleAt: number }

/** nowSec = broker clock in seconds. Refuses when the signal candle has not finished closing or the signal is already stale. */
export function planTrade(sig: { symbol: string; side: 'BUY' | 'SELL'; signalCandleTime: number }, cfg: ExecutionConfig, nowSec: number): { plan: TradePlan | null; reason: string } {
  const signalCloseTime = sig.signalCandleTime + cfg.tfSec;
  if (nowSec < signalCloseTime) return { plan: null, reason: `signal candle closes at ${signalCloseTime}, now ${nowSec}: not closed yet` };
  if (nowSec - signalCloseTime > cfg.maxEntryDelaySec) return { plan: null, reason: `signal is ${nowSec - signalCloseTime}s old (limit ${cfg.maxEntryDelaySec}s): stale, skipped` };
  return { plan: { symbol: sig.symbol, side: sig.side, signalCandleTime: sig.signalCandleTime, signalCloseTime, tfSec: cfg.tfSec, expirySec: cfg.expirySec }, reason: 'ok' };
}

/** Records the ACTUAL execution time and entry price. Settlement is expiry seconds after this fill. */
export function recordFill(plan: TradePlan, fill: TradeFill): TradeRecord {
  return { ...plan, executionTime: fill.executionTime, entryPrice: fill.entryPrice, delaySec: fill.executionTime - plan.signalCloseTime, settleAt: fill.executionTime + plan.expirySec };
}

/** Same settlement rule as the backtester: BUY wins above the entry, SELL below it, equal = tie (stake returned). */
export function settle(rec: TradeRecord, settlePrice: number, payout: number): { result: 'win' | 'loss' | 'tie'; pnl: number } {
  const up = settlePrice > rec.entryPrice, down = settlePrice < rec.entryPrice;
  const win = (rec.side === 'BUY' && up) || (rec.side === 'SELL' && down), loss = (rec.side === 'BUY' && down) || (rec.side === 'SELL' && up);
  return win ? { result: 'win', pnl: payout } : loss ? { result: 'loss', pnl: -1 } : { result: 'tie', pnl: 0 };
}
