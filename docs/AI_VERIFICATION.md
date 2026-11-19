# AI verification: pattern validity vs market quality

Flow per closed candle: engines -> **pattern validity** (OHLC arithmetic) -> **market quality** -> **AI verification** (screenshot + OHLC + findings + indicators) -> **decision** -> **execution controller**.

| Decision | Meaning | Trades automatically? |
|---|---|---|
| APPROVED | pattern valid, context acceptable, screenshot verified | yes |
| VALID_WITH_RISK | pattern valid, market-quality warnings (COUNTERTREND RISK, mixed indicators, ...) | if `AI_ALLOW_VALID_WITH_RISK` (default yes) and, for countertrend, `AI_ALLOW_COUNTERTREND` |
| REJECTED | an original strategy rule fails on the OHLC data | never |
| REVIEW | evidence missing/inconsistent, stale signal or screenshot, screenshot/OHLC mismatch, AI disputes a real rule the arithmetic passes | never |
| AI_UNAVAILABLE | Gemini failed / no key / rate limited / unusable reply. Engine result kept, **not** visually verified | only with `AI_UNAVAILABLE_POLICY=allow_engine_only` |

* Pattern rules live in `src/patternVerification.ts` (`RULE_TEXT`): direction, strict wick penetration, close location (plus Engine 5 / 6 conditions). Engulfing, momentum strength, choppiness and "probability" are not rules. The AI may only cite those rule ids; anything else is recorded in `ignoredObjections` and shown as a warning.
* Market quality (`src/marketQuality.ts`) uses the dashboard measurements (EMA 13/34 trend, RSI, Bollinger, CCI, ATR volatility, support/resistance) and repeated previous-candle sweeps. The dashboard's 20-bar high/low "price action" is passed to the AI labelled as such and is never written over by the engine's sweep.
* The screenshot is drawn from the same closed candles as the numbers (`src/screenshot.ts`), sent as an `inlineData` PNG in the same Gemini request (`src/geminiVision.ts`). `visualVerification` is true only if the transport confirms the image was in the request AND the model echoes the last-candle time printed in the image AND says it matches the OHLC.
* Needs a rasterizer (`@resvg/resvg-js`, or `sharp`) to turn the SVG chart into PNG. Without one the screenshot status is NOT_SENT and, with the default `AI_REQUIRE_SCREENSHOT=1`, setups go to REVIEW instead of trading.
* Tests: `npx tsx --test src/aiVerification.test.ts src/signal.test.ts` (or `npm run test:ai`).
