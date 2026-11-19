// Shared trade bookkeeping for Classic mode (browser) and Pro mode (server): martingale (MTG) maths,
// automatic time-frame / expiry choice, and the win / loss / pending counters. Pure functions, no I/O.

export type Side = "buy" | "sell";
export type TradeResult = "pending" | "win" | "loss" | "draw" | "error";

/** One order sent to the broker (an MTG recovery step is its own record with step >= 1). */
export interface TradeRec {
  id: string;
  ts: number;               // ms when placed
  symbol: string;
  label: string;
  side: Side;
  stake: number;
  seconds: number;          // expiry
  tf: number;               // candle time frame the setup came from
  step: number;             // 0 = first entry, 1.. = MTG recovery step
  result: TradeResult;
  profit: number | null;
  contract?: string;
  note?: string;
}

export interface MtgConfig { on: boolean; steps: number; mult: number }
export const MTG_MAX_STEPS = 3;
export const MTG_DEFAULT_MULT = 2.2;   // recovers the earlier losses plus a little profit at a ~90% payout

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Stake for a recovery step. step 0 is the base stake. */
export const mtgStake = (base: number, step: number, mult: number) => r2(base * Math.pow(mult, step));

/** Every stake of a full chain and the money at risk if every step loses. */
export function mtgPlan(base: number, cfg: MtgConfig): { stakes: number[]; worstCase: number } {
  const n = cfg.on ? Math.min(MTG_MAX_STEPS, Math.max(0, Math.floor(cfg.steps))) : 0;
  const stakes = Array.from({ length: n + 1 }, (_, i) => mtgStake(base, i, cfg.mult));
  return { stakes, worstCase: r2(stakes.reduce((a, b) => a + b, 0)) };
}

/** Is the next recovery stake affordable and inside the limits? Returns the reason it is not, or "". */
export function mtgBlock(nextStake: number, o: { balance?: number | null; lossSoFar: number; stopLoss?: number }): string {
  if (o.balance != null && nextStake > o.balance) return `MTG stopped: next stake ${nextStake} is more than your balance ${o.balance.toFixed(2)}`;
  if (o.stopLoss != null && o.lossSoFar + nextStake > o.stopLoss) return `MTG stopped: another step could take the session past your loss limit of ${o.stopLoss}`;
  return "";
}

// ---------------------------------------------------------------- automatic time frame + expiry
export const EXPIRIES = [15, 30, 60, 120, 180, 300, 600, 900, 1800];
// Deriv only serves candles at these granularities (so there is no S30 time frame here, unlike the expiry list).
export const ANALYSIS_TFS = [60, 120, 180, 300, 600, 900, 1800];
export const FIVE_MINUTES = 300;

export interface Timing { tf: number; expiry: number; why: string }

export function isGoldSymbol(symbol?: string): boolean {
  if (!symbol) return false;
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.includes('XAU') || s.includes('GOLD') || s === 'FRXXAUUSD';
}

/**
 * Automatic expiry. This follows the policy in src/executionConfig.ts (EXPIRY_DEFAULTS): a 5-minute chart always trades a
 * 5-minute expiry, and every other time frame trades one candle (expiry = time frame x 1).
 * Special policy for Gold (XAUUSD): 1 minute timeframe with 4 minutes (240s) expiry.
 */
export function chooseTiming(tf: number, symbol?: string): Timing {
  if (isGoldSymbol(symbol)) {
    const goldTf = tf === 60 ? 60 : tf;
    const goldExpiry = goldTf === 60 ? 240 : Math.min(3600, Math.max(60, goldTf * 4));
    return { tf: goldTf, expiry: goldExpiry, why: "Gold (XAUUSD) strategy: 1m candles · 4m expiry" };
  }
  const expiry = Math.min(3600, Math.max(60, tf));
  return { tf, expiry, why: tf === FIVE_MINUTES ? "5-minute chart always trades a 5-minute expiry" : "one candle (expiry = time frame)" };
}

/** Auto timing always scans the 5-minute chart (the default). Other time frames are only used when you pick them yourself. */
export const autoTfForRound = (_round: number) => FIVE_MINUTES;

// ---------------------------------------------------------------- counters
export interface Summary { trades: number; wins: number; losses: number; draws: number; pending: number; errors: number; winRate: number; pnl: number; recovered: number }

/** Counts every order. "recovered" = chains that lost first and were won by an MTG step. */
export function summarize(recs: TradeRec[]): Summary {
  let wins = 0, losses = 0, draws = 0, pending = 0, errors = 0, pnl = 0, recovered = 0;
  for (const t of recs) {
    if (t.result === "win") { wins++; if (t.step > 0) recovered++; }
    else if (t.result === "loss") losses++;
    else if (t.result === "draw") draws++;
    else if (t.result === "pending") pending++;
    else errors++;
    if (t.profit != null && (t.result === "win" || t.result === "loss")) pnl += t.profit;
  }
  const settled = wins + losses;
  return { trades: recs.length - errors, wins, losses, draws, pending, errors, winRate: settled ? Math.round((wins / settled) * 100) : 0, pnl: r2(pnl), recovered };
}

/** When the broker gives no profit figure, estimate it from the stake and payout. */
export const estimateProfit = (result: TradeResult, stake: number, payoutPct: number | null | undefined) =>
  result === "win" ? r2(stake * ((payoutPct && payoutPct > 0 ? payoutPct : 85) / 100)) : result === "loss" ? -stake : 0;
