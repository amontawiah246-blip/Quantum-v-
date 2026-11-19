# LSCC: Liquidity Sweep Confirmation Candle

An additional, independent strategy (engine id `lscc`). The three existing strategies are unchanged. LSCC feeds the existing
agent -> hub -> 3 engines + AI -> AutoTrade path; there is no new scanner and AutoTrade never searches for LSCC itself.

## Rules (`src/lscc.ts`, pure, closed candles only, nothing after candle i is read)
BUY: (1) a swing low = liquidity level below price (2 candles on each side with strictly higher lows, none of the right-hand candles after the sweep candle);
(2) the SWEEP candle wicks STRICTLY below the level while its body (open and close) stays at or above it; (3) the sweep candle closes back above the level;
(4) the very NEXT completed candle is the CONFIRMATION candle: bullish AND closing above the sweep candle's high; (5) the candle after that is the ENTRY candle.
SELL is the exact mirror. Never an entry on the sweep or confirmation candle. A sweep alone never trades.
A level that any later candle traded through is spent and is never used again; the exact swept level and its candle are recorded.

## Lifecycle (`src/sweepWatcherCore.ts`, `trackLscc`)
- Sweep candle closes: the agent registers **LSCC WAITING** (chart with the level, screenshot sha recorded) and keeps watching. Nothing is sent for verification.
- Next candle confirms: the same alert is updated in place (same candidate, new screenshot, sweep time preserved) and the candidate is published to the hub:
  the SAME evidence and screenshot go to the three engines and Gemini at once (`src/candidateHub.ts` broadcast). Evidence carries `lscc{level, levelTime, sweepTime, confirmTime, entryTime, sweepDetectedAtMs, sweepScreenshotSha256}`.
- Next candle does not confirm (or a candle is missed): **LSCC INVALID**. Later confirmations are not accepted (one candle only).
- Confirmed but not ordered within the 45 s window (e.g. slow AI): rejected as stale; shown as **LSCC EXPIRED** (`src/lsccBoard.ts`). Never entered late.

## Verification
- `engine:lscc` re-runs the LSCC rules on the evidence (the coordinator does it as the primary check for LSCC candidates); the sweep / continuation / momentum engines
  also read the evidence and may only veto by signalling the opposite side. Gemini and the hybrid gate run through the existing `getSignal` pipeline.
- `src/patternVerification.ts` recomputes the LSCC arithmetic independently (`LSCC_*` rules). The AI can warn but cannot invalidate on trend.
- LSCC is a voting engine in `src/engineEvaluator.ts` (`lscc`), so manual Signals and Auto scan also see it. If another engine votes the opposite way the result is "conflicting signals" and nothing is traded; the reason now names who voted what.
- A valid LSCC is not refused for being countertrend even when `AI_ALLOW_COUNTERTREND=false` (the strategy exists for reversals). All other execution safeguards are unchanged.

## Display
Menu > Setup watch: LSCC board (state, market, direction, level, sweep / confirmation / entry candle, engines, AI, execution status) and alert cards tagged
LSCC WAITING / LSCC BUY / LSCC SELL / LSCC INVALID. API: `GET /api/sweep/lscc`. AutoTrade feed shows `LSCC WAITING`, `AGENT DETECTED ... LSCC BUY`, `LSCC -> BUY`, final status.

## Preserved
M5 primary, 300 s expiry, entry on the next candle, 45 s maximum execution delay, one order per candidate, ledger claim, freshness check.
Tests: `npx tsx --test src/lscc.test.ts` (25 tests, including the live R_75 M5 data).
