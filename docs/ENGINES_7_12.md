# Engines 7 to 12: market context, momentum exhaustion, repeated sweeps

Added on top of Engines 1 to 6. Nothing was removed or weakened: the wick-sweep engine, Pattern 1/2, Engine 5 (sweep continuation) and Engine 6 (momentum) are untouched and still produce their own signals through `src/sweepEngines.ts`. The new code is additive: all new modules are pure TypeScript (candles in, verdict out), the evaluator only gains an extra `intelligence` field, and the chart, broker integration, AI verification and historical signal records are not touched.

## Modules
| File | Engine | Role |
|---|---|---|
| `src/sequenceClassifier.ts` | 7 | THREE_STRONG / WEAK_STRONG_STRONG / MIXED_STRENGTH |
| `src/sequenceStats.ts` | 7 | fourth-candle outcomes for every class (continuation, reversal, flat, Wilson CI, train/validation/test) |
| `src/structureEngine.ts` | 8 | confirmed pivots, HH/HL/LH/LL, BOS, MSS, NEUTRAL (incremental, no look-ahead) |
| `src/sweepIntelligence.ts` | 9 | sweep log, alignment, clusters, follow-up status, pluggable sweep sources |
| `src/reversalConfirmation.ts` | 10 | countertrend sweep arms a watch; only a confirmed MSS can trade |
| `src/continuationConfirmation.ts` | 11 | with-trend sweep + the original Engine 5 rule + structure + exhaustion gate |
| `src/exhaustionEngine.ts` | 12 | HEALTHY_CONTINUATION / POSSIBLE_EXHAUSTION / CONFIRMED_STRUCTURE_REVERSAL / UNCLEAR |
| `src/quantumPipeline.ts` | all | the 7-step priority order, state machine, explanation, `pipelineSeries` for backtests |
| `src/executionConfig.ts` | | 5-minute expiry lock, expiry policy, trade lifecycle (plan, fill, settle) |
| `src/intelBacktest.ts` | | strategies for every hypothesis, breakdowns, resampling, per-timeframe runs, report |
| `src/engineBacktest.ts` | | extended: execution delay, fine price data, payout table, execution record per trade (defaults unchanged) |

## Rules in short
**Engine 7.** Three consecutive same-direction closed candles. STRONG = body/range >= 0.65. THREE_STRONG: all strong and combined wick/range <= 0.30. WEAK_STRONG_STRONG: first body/range between 0.10 and 0.50 and its body <= 0.75 x the smaller of the other two, which are strong. Everything else is MIXED_STRENGTH and gets no side. `hypothesis` names the side each label would be *tested* on (continuation for THREE_STRONG, opposite side for WSS). It is not a prediction: the backtest runs both directions for both labels.

**Engine 8.** Swing high at k: high strictly above the 2 highs before and the 2 after (lows mirrored, equal highs are not a pivot). It becomes known on candle k+2 (`confirmedAt`). BULLISH = last two swing highs rise and last two swing lows rise; BEARISH mirrored; otherwise NEUTRAL. BOS = close beyond the latest unbroken swing in the trend direction. MSS = close through the latest confirmed swing against the trend (wick-only does not count); the trend then reads NEUTRAL until new pivots confirmed after the shift show the new direction. A trend that turned NEUTRAL (for example a lower high) remembers its direction so a later break still counts as the shift (`mssFromNeutral`).

**Engine 9.** Per sweep: direction, level, extreme, timestamp, structure *before* the sweep candle, WITH_TREND / COUNTERTREND / NO_TREND, recent count, cluster ordinal (same-side sweeps within `clusterWindow`), then FOLLOWED_THROUGH / FAILED after `monitorCandles`. Events are immutable, so older snapshots never see later information. No rule enters after N sweeps.

**Engine 10.** Countertrend sweep arms a watch (repeated sweeps update it and are counted). SELL needs: structure was BULLISH, upside sweep, then a close below the protected swing low, with that swing confirmed on an earlier candle (`requireRefBeforeSweep` also demands it pre-dates the sweep). The watch expires after `maxCandlesToConfirm` or is cancelled by a close beyond the sweep extreme. One entry per shift.

**Engine 11.** With-trend sweep (A), then B and C must close with the trade direction under the unchanged Engine 5 rule; at C's close the structure must still agree and, by default, Engine 12 must not say POSSIBLE_EXHAUSTION or CONFIRMED_STRUCTURE_REVERSAL. Invalid sequences are dropped and logged; one watch per sweep.

**Engine 12.** Signs, each measured with a configurable threshold: body decay, wick rejection, failed with-trend sweeps, opposing body share, no new extreme, choppy structure. `minSigns` (3) signs = POSSIBLE_EXHAUSTION. The number of sweeps is reported and is never a sign.

**Pipeline.** 1 validate data (invalid/unfinished/duplicate/out-of-order candles are rejected, a gap resets all state) -> 2 structure -> 3 patterns (Engine 7, sweeps, Engines 5 and 6 as context) -> 4 alignment and counts -> 5 Engine 11 or Engine 10 -> 6 duplicate (same side within 3 candles) and conflict (opposite side within 3 candles) checks -> 7 BUY / SELL / NO_TRADE with an explanation (market structure, sweeps, trend alignment, candle momentum, structure status, reason, notes). States: NORMAL, SWEEP_DETECTED, CONTINUATION_WATCH, REVERSAL_WATCH, REPEATED_SWEEP_MONITOR, CONFIRMED.

All parameters are in `QUANTUM_DEFAULTS`; override one level deep with `quantumParams({ exhaustion: { minSigns: 2 }, minHistory: 40 })`.

## Execution and expiry
* A signal exists only after its candle has completely closed. `planTrade` refuses earlier, and drops signals older than `maxEntryDelaySec`. `recordFill` stores the actual execution time and entry price; settlement is `expiry` seconds after that fill.
* `resolveExpiry`: a 5-minute chart always gets 300 s. No market condition, multiplier or policy changes that (if the broker does not offer 300 s for a market the result is `ok: false`, no trade). Other timeframes use `expiry = timeframe x multiplier`, chosen from the Engine 12 state; the default multiplier is 1 for every state because no other value has been shown to help. Change `byCondition` only after the by-expiry backtest supports it.
* Candle timeframe and expiry are separate everywhere. The evaluator's `intelligence` field carries `expirySec`, `signalCandleTime` and `executeAfter` (candle close).

## Backtesting
```
npm run backtest:intel -- --csv EURUSD_5m.csv --csv GBPUSD_5m.csv --tf 300 --payout 0.9 --out intel.json
npm run backtest:intel -- --csv EURUSD_5m.csv --fine EURUSD_1s.csv --delay 2 --payout-table payouts.json --resample 900,1800
npm run backtest -- --synthetic --instruments 4 --n 30000 --seed 1 --persistence 0 --intel     # machinery check only
```
Strategies (each hypothesis is its own strategy): `e7_three_strong_as_continuation` and `_as_reversal`, `e7_wss_as_reversal` and `_as_continuation`, `e5_continuation` (three-candle sweep continuation), `e9_single_sweep`, `e9_repeated_cluster`, `e9_with_trend_sweep`, `e9_countertrend_sweep`, `e9_no_trend_sweep` (sweep baselines entered right after the sweep, research only), `e11_continuation_confirmed` (and without the exhaustion gate), `e10_reversal_confirmed`, `pipeline_all`. MIXED_STRENGTH has no strategy by design; its fourth-candle statistics are reported.

Cuts: market (per instrument), timeframe (`--resample`), signal type (strategy), sweep count (1, 2, 3, 4+), trend condition, exhaustion state, expiry. Chronological train / validation / test per market with boundary trades embargoed; 95% Wilson intervals against the break-even win rate for the payout actually used.

How a trade is simulated: the signal exists at the signal candle's close; the fill is the first available price at or after close + `delaySec`; settlement is exactly `expiry` seconds after the *actual* fill; ties return the stake; payout can be a per-market, per-expiry table. Expiry defaults to the live policy (5-minute chart: 300 s only); `--expiry 300,600,900` is available for research.

## Limits you should know
* **No real market data was available here.** Nothing in this repo says whether any of these engines has an edge. The two committed reports (`docs/backtests/intel_synthetic_*.txt`) are synthetic: with no edge every strategy sits near 50% with negative expectancy and nothing is "above" break-even; with a planted edge the harness finds it. They validate the machinery only. Run the CLI on exported candles.
* **On candle data alone a 5-minute trade with a 5-minute expiry and zero delay is mathematically the next candle's open versus its close.** What makes the simulation different from "colour of the next candle" is the execution model: a delay, finer price data (`--fine`, 1-second or tick candles) for the exact fill and settlement prices, per-trade payouts, and multi-candle expiries. Delay is only as precise as the finest series supplied; a sub-candle delay without `--fine` is refused rather than invented.
* Slippage, requotes, broker rejections and payout changes during the trade are not modelled.
* Engine 8 on noisy 5-minute data shifts often with the default 2/2 pivots (about 40% of random candles sit within 10 candles of some shift, so the exhaustion state is frequently CONFIRMED_STRUCTURE_REVERSAL). That is a property of the definition, not proof of anything. Wider pivots (`structure: { pivotLeft: 3, pivotRight: 3 }`) make structure slower and calmer; test it before trusting either setting.
* Sweep sources: Pattern 1/2 (default) and the wick-sweep engine (`sweep: { sources: ['pattern12','wick'] }`). Patterns 3 and 4 (equal-level sweeps) are not in this repo; add them with `registerSweepSource`.
* The pipeline is not wired into AutoTrading or the AI verification vote. It is exposed as `intelligence` on `/api/engines` so you can watch it first. Many strategies and cut cells are compared in the report, so a good-looking cell in one segment is a multiple-comparison result.
* Nothing here guarantees that any number of sweeps or any candle sequence produces a reversal or a continuation.

## Tests
`npm run test:quantum` (new) or `npm run test:engines`; `npm run test:ai` for the AI verification tests. Highlights: truncation tests prove no look-ahead for Engine 8, the pipeline and every backtest strategy; invariants over 20,000 random candles (reference swings confirmed before breaks, one entry per shift, no duplicate or conflicting signals, Engines 5/6 context equals the untouched engines); the 5-minute lock; execution delay, fine data and payout tables.
