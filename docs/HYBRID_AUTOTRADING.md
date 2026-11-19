# Hybrid engine x AutoTrading x Gemini screenshot verification

This connects the three parts that existed side by side: the **strategy engines**, the **hybrid engine** (`src/hybrid*.ts`) and the **Gemini screenshot verification** (`src/aiVerification.ts`, `src/geminiVision.ts`), and puts one independent safety gate in front of every automatic order. Manual and automatic mode run the same pipeline.

## The pipeline (one path for both modes)

```
broker candles (closed only)
  -> strategy engines (UNCHANGED: sweep, continuation, momentum, indicators, candlestick)         POST /api/engines
  -> pattern validity from plain OHLC arithmetic (src/patternVerification.ts)                      only the original rules can invalidate
  -> hybrid verdict for the same candle (src/hybridEngine.ts, shown as `hybrid` on /api/engines)
  -> hybrid gate (src/hybridGate.ts)                                                               can only BLOCK, never create or loosen
  -> evidence package: annotated screenshot + OHLC + wick penetration, body/range, sweep count,
     indicator readings, hybrid verdict, probability (null without a model), data freshness
  -> Gemini (screenshot + numbers), strict schema (parseAiResponse) -> Verification -> AI contract (src/aiContract.ts)
  -> execution controller (decideExecution + your policy) -> `tradeable`
  -- manual mode stops here: verdict, screenshot and notes are shown, you decide --
  -> INDEPENDENT EXECUTION GATE (src/executionGate.ts), from fresh data, right before the order
  -> order through the existing bridge -> broker order id, actual fill time -> settlement -> outcome in the log
```

## What the hybrid engine may and may not do in AutoTrading

`HYBRID_AUTOTRADE` (default `veto`):

| mode | effect |
|---|---|
| `off` | AutoTrading ignores the hybrid verdict. No hybrid evidence is sent to the AI. |
| `advisory` | evidence goes to the AI and the log; nothing is blocked. |
| `veto` (default) | blocks only when the hybrid layer **positively disagrees about the engine's own side**: indicator gate (all available indicators contradict), model probability below the validated/break-even threshold, same-candle conflict, or an opposite hybrid trade. "No opinion" (no hybrid setup, warm-up, wrong timeframe, no model) never blocks and is labelled as such. |
| `require` | a trade also needs the hybrid layer to confirm the same side. |

In every mode the hybrid layer can only remove trades. A test proves that with no engine setup there is no AI call and no trade whatever the hybrid layer says, and that a hybrid veto leaves `engine`, `decision` and the AI answer untouched (only `tradeable` and the status text change).

## The independent execution gate (`src/executionGate.ts`)

Runs in `autoServer.ts` (`preflight`, called by the autopilot right before `place`). Any failed or unknowable check = `NO_TRADE`, logged with the exact reason. The AI approval is one input among these:

ENGINE_SIGNAL · AI_APPROVED · DIRECTIONS_AGREE · CONTROLLER_ELIGIBLE (your existing policy) · HYBRID_GATE · CANDLE_SEQUENCE (valid OHLC, strictly chronological, exactly 300 s apart: detects missing candles) · SIGNAL_CANDLE_IS_LAST · DATA_FRESH · ENTRY_DELAY · SCREENSHOT_SYNC (the image ends on the analysed candle) · ENTRY_DEVIATION · NO_DUPLICATE · NO_CONFLICT · BROKER_CONNECTED · EXPIRY_SUPPORTED (5 minutes) · RISK_LIMITS · STAKE_LIMIT.

`AI_UNAVAILABLE_POLICY=allow_engine_only` (your explicit opt-in, unchanged) waives only the two AI checks; the trade stays labelled NOT visually verified.

Expiry: the order asks the broker for 300 s at the moment it is sent; `settleAtSec` in the log is the actual order time + 300 s, and the outcome comes from the broker's own result.

## A bug fixed on the way (it is why AutoTrading could not use any of this)

`autoServer.ts` used to claim the "already traded" ledger while **scanning**. The autopilot then looks again right before the trade; that second look found the candle "already traded" and skipped, so a setup could not be placed. The ledger is now only read while scanning (`src/autoLook.ts`) and claimed atomically when an order is really sent (released if the broker refuses it). A regression test covers it. This is from reading the code and the new test, not from a live broker run.

## Failure handling

AI unavailable / malformed / wrong request id / timeout, screenshot failure, inconsistent OHLC, stale data, price moved, broker down, gate error: no order, and a `FAILURE` or `GATE` event with the reason is written. Nothing is retried into a later (late) entry.

## Log and analytics

`data/hybrid_log.jsonl` (`HYBRID_LOG_PATH`), append-only: CANDIDATE (every strategy-engine setup, with AI contract, hybrid status, screenshot status), SHADOW (what the candidate would have done), GATE, ORDER (broker id, delay, entry reference, price at order, settle time), OUTCOME (broker result), FAILURE.

* `GET /api/hybrid/status` configuration and whether a model file exists
* `GET /api/hybrid/log?limit=&type=`
* `GET /api/hybrid/analytics?payout=0.9` cohorts: strategy-only, AI-approved, AI-rejected, AI-abstained, hybrid-vetoed, final-tradeable; by pattern and market; broker results separately; visual disagreements; AI failures; entry delays; win rate with Wilson 95% interval and expected value per unit after payout; a chronological first/last split once there are 20+ candidates.
* `GET /api/signal/screenshot/:id` the PNG the AI inspected (`signal.screenshotId`). Manual mode shows it under the verdict in the Signals page.

Shadow results use the next candle's open to close (the backtester's rule), so rejected setups can be compared with approved ones on equal terms. They are not broker results and are never mixed with them. Whether AI verification **improves** profitability is answered only by `aiApproved` vs `strategyOnly` in the **last** block with a higher `evPerUnit` and non-overlapping evidence, not by a lower trade count. With little data the analytics say so; none of it exists yet.

## Assumptions you should check (all configurable, see `.env.example`)

* `MAX_ENTRY_DEVIATION_ATR=0.35` and `MAX_ENTRY_DELAY_SEC=45` are my starting values, not tuned on data. The Gemini free-tier spacing (12 s) plus latency can eat a lot of 45 s; measure it. The older 10 s limit in `executionConfig.ts` (backtest) is untouched.
* Whether the broker offers a 5-minute expiry for a market is taken as "yes" for a 5-minute chart (the bridge exposes no per-market list here); a refusal by the broker is logged as a failure.
* If a tick carries no broker clock, the local clock is used.
* The Signals page's own browser-side auto button follows `tradeable` (so it respects the hybrid veto) but does **not** pass through the server execution gate. Use server AutoTrading for unattended trading.
* No trained hybrid model ships. Without one `AUTO` runs mode B (indicator evidence, no probability) and the AI is told there is no probability.

## Tests

`npm run test:hybridauto` (new, 16 tests) and the full suite `npx tsx --test src/*.test.ts` (227 pass). One existing assertion was changed: `hybrid.test.ts` expected the note "Advisory only", which is no longer true. Not run here: the Vite frontend build, the Python bridge, a live Gemini call, a live broker order.
