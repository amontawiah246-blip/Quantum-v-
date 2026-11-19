# Classic mode, Pro mode and AI Trader

The centre button of the bottom bar opens the three glowing mode buttons. Your choice is remembered.

**Default: 5-minute chart, 5-minute expiry** in Classic mode, Pro mode and the server (`DEFAULT_CFG.tfSec = 300`). You can switch to any other time frame or expiry by hand; nothing else is chosen for you.

## Classic mode
1. Pick a Deriv synthetic market from the grid (search, favourites and groups: Volatility, 1s Volatility, Crash and Boom, Jump and Step).
2. Choose the **time frame**, the **expiry** (Auto = the policy expiry, or 15s to 15m), the **MTG step** (None, 1, 2, 3) and the **stake**.
3. Switch **AUTO** on and press **Generate signal**: the engines and AI make the signal and, only if it is verified (`tradeable`), the trade is placed at once. With AUTO off you get the signal and a Place button.
4. Every order is tracked: pending (with a countdown), win, loss, and every MTG recovery step. Wins, losses, trades, pending, win rate and profit/loss are shown, saved on the device, and finished trades are added to the Account history.

Classic mode runs in the browser. Like the Signals page auto button it follows `tradeable` (so it respects the AI and the hybrid veto) but it does NOT pass through the server execution gate (`src/executionGate.ts`). Use Pro mode for unattended trading.

## Pro mode
No market to pick. Set **Time frame & expiry** to Auto or Manual, switch **MTG** on or off, press **AUTO TRADE**. It runs on the server (`src/autopilot.ts` + `autoServer.ts`), so it keeps going with the phone locked, and it stops by itself at your limits (max trades, losses in a row, loss limit).

* **Auto 5m**: always the 5-minute chart with a 5-minute expiry (the policy in `src/executionConfig.ts`).
* **Manual** (the screen opens on this, set to M5 and 5m): you choose both. The execution gate accepts it (see ALLOW_CUSTOM_EXPIRY in `.env.example`).
* **Gate**: the independent execution gate runs before the first order of every setup, exactly as before.

## MTG (martingale)
After a loss the same market and side is entered again with a bigger stake: stake, stake x m, stake x m^2 ... (m = 2, 2.2 or 2.5; up to 3 steps). It stops, and never places the next step, when the stake is over your balance (Classic), over MAX_STAKE, or when the loss would pass your loss limit (Pro). The recovery steps are part of the same setup, so they do not go through the gate again, and they are not written to the hybrid log. The worst case (every step loses) is shown before you start. MTG raises the amount you can lose; it does not change the chance of winning.

## What changed in your code
* `src/executionGate.ts`: `EXPIRY_SUPPORTED` also accepts an expiry the user chose (`expiryChosenByUser`) and a one-candle expiry on non-M5 charts. Everything else, including the M5 lock for automatic choices, is unchanged. `ALLOW_CUSTOM_EXPIRY=0` restores the old strictness for user choices.
* `src/autopilot.ts`, `autoServer.ts`: MTG chains, per-trade records, automatic timing, `stakeLimit`.
* New: `src/tradeSession.ts`, `src/classicTrader.ts`, `src/ClassicMode.tsx`, `src/ProMode.tsx`, `src/AiTraderMode.tsx`, `src/TradeStats.tsx`, `src/modes.css`, `src/modes.test.ts`.
* `src/App.tsx`: mode buttons in the bottom bar (Signal package is still in the Signals page). `src/SignalsPage.tsx`: glowing hub cards.

## Live confidence (no hardcoded percentages)
- The engines' number is now labelled **engine agreement** (a count of agreeing engines, never a win probability).
- **Live win rate** = how earlier setups of the same kind actually ended in your trade log (settled against the next candle). Scope: same market + time frame + pattern, else same time frame + pattern, else same time frame. Shown with sample size, 95% range and break-even.
- Until 30 settled setups exist it shows "Collecting data n/30" and no percentage. Code: `src/liveConfidence.ts`.


---
## Update: indicator strategy and the new Classic flow
See `docs/INDICATOR_STRATEGY.md`. Classic no longer asks for a pair: choose time frame + expiry and press AUTO SCAN. Pro mode uses the chosen time frame and expiry for every agent and every trade.
