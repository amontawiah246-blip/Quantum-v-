# Hybrid AI price-action layer

Adds a quality-ranking layer on top of the original candlestick engines. **Nothing was removed or weakened.** Engines 1-12, the chart, the broker connections and AutoTrading are untouched; the hybrid verdict is exposed as `hybrid` on `/api/engines`. AutoTrading and the Gemini screenshot check now read it through a veto-only gate: see `docs/HYBRID_AUTOTRADING.md`.

## The four stages
| Stage | Question | Code |
|---|---|---|
| 1 | Is there a legitimate candlestick setup? | `src/hybridSetups.ts` runs the original detectors with their **original, frozen** parameters |
| 2 | How good is the evidence around it? | `src/hybridFeatures.ts` `evaluateEvidence`: ADX(14), ATR(14), EMA(20/50), each switchable |
| 3 | What is P(win) for a 5-minute trade? | `ml/train.py` trains and calibrates; `src/hybridModel.ts` evaluates the exported model |
| 4 | BUY, SELL or NO_TRADE | `src/hybridEngine.ts` |

Patterns kept (all in Stage 1): bearish sweep, bullish sweep, equal-level upper-wick sweep, equal-level lower-wick sweep, three-candle sweep continuation (Engine 5), three-candle body momentum (Engine 6), weak-strong-strong (Engine 7), repeated sweep (Engine 9). Several patterns on one candle/side are one observation with several flags.

**Important - equal-level sweeps:** the uploaded zip did not contain them (its own docs say so). `src/equalLevelSweeps.ts` is a new implementation from the plain description (2+ equal highs/lows in the last 12 candles, wick-only sweep, close back inside, rejection wick >= 35% of range). The thresholds are my assumption. If you have your original rule, replace `checkEqualLevelSweep` and keep its signature. Likewise Engine 7's weak-strong-strong has no direction in the original spec; the hybrid uses Engine 7's own hypothesis (trade against the run) and the model learns whether that is worth anything.

## What indicators may and may not do
They never create, remove or change a setup (a test proves candidates are identical in every mode and with every indicator switched off). A single disagreeing indicator never vetoes a setup; the default gate vetoes only when **all** available indicators (at least two) contradict it. `gate.vetoContradictFraction` and `gate.minQuality` are configurable and every deviation from the defaults is listed in `engine.configChanges`. The evidence rules are untuned starting hypotheses; the model, not these rules, learns what matters.

## Modes (compared on identical setups)
A candlestick only | B + indicator gate | C + model, no indicator inputs | D full hybrid | AUTO = D if a usable model is loaded, otherwise B (the response states which and why). A model trained on synthetic data, for a different payout (> 0.02 off), for another instrument, or needing an indicator that is switched off is **refused**, never silently downgraded. Without a model there is **no probability** (`null`).

## 5-minute execution
Chart 5 minutes, expiry 5 minutes (construction fails otherwise; candles that are not 300 s apart give `TIMEFRAME_MISMATCH`). Signals come from closed candles only; the earliest order time is the candle close (`executeAfter`); datasets record the actual fill time and price (`--delay`, `--fine` for sub-candle fills) and settle with the broker rule already used by the backtester (BUY wins above entry, SELL below, equal = stake returned, per-trade payout).

## Rejection instrumentation
Every candidate gets a `DecisionRecord`: patterns, validation, rejection stage and reason, indicator conditions, probability, final decision. `npm run hybrid:diagnose -- --csv X.csv --mode B --log rejects.jsonl --out diag.json` prints the funnel (first failed check per pattern), data health (gaps, invalid OHLC, flat candles, timestamp alignment, spacing), an independent brute-force cross-check of the sweep detectors, "what-if" counts for looser candlestick thresholds (measurement only) and an attribution of the signal count to: restrictive thresholds / wrong detection / timeframe sync / missing candles / bad OHLC / genuine absence. Example: `docs/hybrid/synthetic_diagnostics.txt`.

## Training and validation (scientific discipline)
```
npm run hybrid:dataset -- --csv EURUSD_5m.csv --csv GBPUSD_5m.csv --payout 0.9 --out data/hybrid_dataset.csv
pip install -r ml/requirements-ml.txt
python3 ml/train.py --data data/hybrid_dataset.csv --out models        # writes models/hybrid_model.json + validation_report.md/json
```
* Features come from the live engine code one closed candle at a time (a test cuts the series and compares), labels come from the execution model afterwards. "Recent pattern performance" uses only outcomes that had settled (+60 s lag) before the signal.
* Chronological global split 60/20/20 with a 12-candle embargo and purging of trades that settle across a boundary; the last block is the untouched test. Duplicate (instrument, candle, side) rows and instruments with identical candles are refused.
* Logistic regression baseline and LightGBM are both fitted; early stopping uses the tail of the training block; model type, calibration (Platt, or isotonic) and probability threshold are chosen on validation; the threshold maximises mean P&L minus one standard error and is **null (never trade)** when that is not positive.
* Walk-forward: expanding windows over train+validation only; every fold refits, recalibrates and re-picks its threshold on its own past.
* Reported for A/B/C/D: trades, win rate with Wilson interval, expectancy after payout with 95% interval, total, max drawdown, break-even comparison; Brier, log loss, AUC, ECE and reliability table; pattern, ADX regime, ATR regime, session, trend alignment and instrument breakdowns; the number of comparisons made.
* Gate and model export are checked at every run (Python gate vs the engine's gate on every row; exported trees vs the trained model; TypeScript vs Python scores in `src/hybrid.test.ts`).

## What the committed reports are (and are not)
`docs/hybrid/synthetic_*` are **synthetic** (random-walk candles). With no planted edge the pipeline finds none: AUC ~0.50, no model passes its validation threshold, A/B lose about the payout cost. With a planted persistence it finds the edge on the untouched test block and the walk-forward folds. This shows the machinery detects an edge when one exists and does not invent one; it says nothing about any real market. **No trained model is shipped and no accuracy, probability or profit figure for real markets exists in this package.** `docs/hybrid/synthetic_demo/` holds a synthetic-trained model only as a parity fixture; the engine refuses to use it unless `ml.allowSyntheticModel` is set.

## Known limits
Slippage, requotes, rejections and payout changes are not modelled; the live engine's own outcome tracking assumes next-open to next-close; instruments are correlated; one test block is one sample, so confirm any positive result on a later period before using money. No UI panel was added: read `hybrid` from `/api/engines`.

Tests: `npm run test:hybrid` (TypeScript, 16 tests), `python3 -m unittest discover -s ml -p test_ml.py` (Python), full suite `npx tsx --test src/*.test.ts`. Install note: the original `package.json` has a peer-dependency conflict, use `npm install --legacy-peer-deps`.
