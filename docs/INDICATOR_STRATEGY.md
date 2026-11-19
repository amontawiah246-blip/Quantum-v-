# The indicator strategy (Stochastic + RSI, confirmed by a candle pattern)

This replaces the old indicator strategies (RSI < 32 / EMA cross in the TypeScript engine, S1..S7 in `bridge/engines/indicator_engine.py`).
**Every candle-pattern strategy is kept**: wick sweep, sweep continuation, momentum, LSCC, structure sweep and the candlestick-pattern engine
(pinbar / hammer / shooting star / engulfing in TypeScript, the 54-pattern engine in `bridge/engines/candlestick_engine.py`). They are now the *confirmation*.

## The rules (one definition: `src/stochRsi.ts`, Python twin `bridge/engines/indicator_engine.py`)

| | BUY | SELL |
|---|---|---|
| Stochastic (14,3,3) %K | crosses **up** through **20** | crosses **down** through **80** |
| RSI (14) | crosses **up** through **30 or 50** | crosses **down** through **70 or 50** |

* The two crossings may be up to **3 candles** apart (`STOCHRSI_ALIGN_WINDOW`, 1..6). The trigger fires on the candle where the **second** one completes.
  The same direction is not triggered again inside that window.
* Then the engine **looks back** over the last **5 candles** (`STOCHRSI_CONFIRM_LOOKBACK`, 1..12), ending on the trigger candle, for a candle pattern
  pointing the same way. **No pattern = no trade.** A trigger without a pattern is logged as skipped; it is never broadcast.
* Entry: the open of the next candle. Only closed candles are read; nothing after the signal candle is ever used.

## What happens, end to end

1. Every market agent reads the **same indicator** on its own market, on the time frame chosen in the app (`src/stochRsi.ts`, drawn by `src/indicatorChart.ts`).
2. Trigger + candle-pattern confirmation found -> the agent renders the **screenshot** (candles, Stochastic panel, RSI panel, the trigger line, the framed candle pattern, the entry arrow).
3. The setup goes to the verification engines and **Gemini** with the screenshot. Gemini is told the strategy, given the server's own arithmetic and
   Stochastic / RSI readings, and may only fail rules from the list (`IND_STOCH_CROSS`, `IND_RSI_CROSS`, `IND_ALIGNED_ON_SIGNAL`, `IND_NEW_DIRECTION`,
   `IND_CANDLE_CONFIRMATION` plus the confirming pattern's own rules). It cannot add, relax or replace a condition.
4. Gemini also returns a **confidence (0-100)** with the basis it rests on. The server caps it by its own market-quality read (poor market <= 55, fair <= 78,
   strong counter-trend <= 62, repeated sweeps <= 70). It is a read of the setup, **not a probability of winning**.
5. APPROVED -> traded with the chosen expiry.

## Modes

* **Pro (AI Trading)**: pick the time frame and the expiry once ("Global Manual"). All agents switch to that chart; every trade uses that expiry.
  Switching AI Trading on starts the agents by itself.
* **Classic**: no pair to choose. Pick time frame + expiry, press **AUTO SCAN**. The scan calls every agent, waits for a setup the AI verifies and shows
  the BUY / SELL signal with its chart underneath (setup chart before the trade; the same chart with the trade window and WIN / LOSS after it).
  **AUTO TRADE** places the trade the moment the signal is verified (MTG as set) and scans again when it finishes.
  Endpoint: `POST /api/scan/start {tfSec, expirySec}`, poll `GET /api/scan/state`, chart `GET /api/classic/chart/:candidateId[?entryTime&entryPrice&expiry&result]`.

## Switches

* `STRATEGY_MODE=legacy` - the candle-pattern strategies trade on their own again (the old behaviour). Default: confirmed mode.
* `STOCHRSI_ALIGN_WINDOW`, `STOCHRSI_CONFIRM_LOOKBACK` - see above.

## Measured result (read this before trading real money)

Backtest of exactly this implementation on the uploaded Deriv 5m data (Gold 56 days, Silver 168 days), 92% payout, break-even 52.08%:

| | trades | win rate |
|---|---|---|
| Gold, confirmed, 1 / 2 / 3 / 5 candle expiry | ~410 each | 51.8% / 52.0% / 54.4% / 49.5% |
| Silver, confirmed, 1 / 2 / 3 / 5 candle expiry | ~1170 each | 48.8% / 50.4% / 51.0% / 51.4% |
| Trigger with no candle pattern (skipped) | 77 / 213 | 44-50% |

No expiry is statistically better than break-even (all p > 0.18). A candle pattern exists within 5 candles for ~84% of triggers, so it filters little.
Restricting the confirmation to the sweep family (sweep / LSCC / structure sweep) with a 2-candle look-back and a 3-candle expiry gave 55.8% (n=369, p=0.08):
worth testing on fresh data, not proven. Do not treat 85% confidence numbers or a green chart as a measured win rate: `src/liveConfidence.ts` measures the real one.
