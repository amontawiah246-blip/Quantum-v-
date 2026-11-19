> **SYNTHETIC DATA.** These numbers test the machinery. They say nothing about any real market and must not be read as evidence of profitability.

# Hybrid engine validation report

Payout 0.900 (break-even win probability 0.5263). Rows: {'all': 33828, 'train': 20282, 'validation': 6747, 'test': 6754}. Chronological split with a 12-candle embargo; the test block was not used for any choice.
Number of models, thresholds and gate settings compared while building this: **124** (a good-looking number among many comparisons can be luck).

## Results by mode (identical setups, one open trade per instrument)

A = candlestick only, B = + indicator gate, B_tuned = gate settings chosen on validation, C = + model (no indicator inputs), D = full hybrid.

### validation (thresholds were chosen here: in-sample for them)

| mode | trades | win rate [95% CI] | EV per unit stake [95% CI] | total | max drawdown | vs break-even |
|---|---|---|---|---|---|---|
| A | 6157 | 57.90% [56.7, 59.1] | +0.1001 [+0.077, +0.124] | +616.5 | 30.5 | above |
| B | 6352 | 58.17% [57.0, 59.4] | +0.1052 [+0.082, +0.128] | +668.5 | 25.2 | above |
| B_tuned | 2459 | 61.16% [59.2, 63.1] | +0.1621 [+0.125, +0.199] | +398.6 | 11.3 | above |
| C | 135 | 80.00% [72.5, 85.9] | +0.5200 [+0.391, +0.649] | +70.2 | 2.1 | above |
| D | 135 | 76.30% [68.5, 82.7] | +0.4496 [+0.313, +0.586] | +60.7 | 3.3 | above |

### test (out of sample, untouched)

| mode | trades | win rate [95% CI] | EV per unit stake [95% CI] | total | max drawdown | vs break-even |
|---|---|---|---|---|---|---|
| A | 6226 | 57.97% [56.7, 59.2] | +0.1014 [+0.078, +0.125] | +631.1 | 36.7 | above |
| B | 6377 | 57.91% [56.7, 59.1] | +0.1003 [+0.077, +0.123] | +639.7 | 38.8 | above |
| B_tuned | 2478 | 60.05% [58.1, 62.0] | +0.1409 [+0.104, +0.178] | +349.2 | 13.5 | above |
| C | 137 | 79.56% [72.0, 85.5] | +0.5117 [+0.383, +0.640] | +70.1 | 2.2 | above |
| D | 144 | 75.00% [67.3, 81.4] | +0.4250 [+0.290, +0.560] | +61.2 | 2.2 | above |

### walk forward oof (every fold trained only on its past)

| mode | trades | win rate [95% CI] | EV per unit stake [95% CI] | total | max drawdown | vs break-even |
|---|---|---|---|---|---|---|
| A | 14765 | 57.62% [56.8, 58.4] | +0.0948 [+0.080, +0.110] | +1400.2 | 32.4 | above |
| B | 15232 | 57.74% [57.0, 58.5] | +0.0971 [+0.082, +0.112] | +1478.5 | 31.3 | above |
| C | 1065 | 75.12% [72.4, 77.6] | +0.4272 [+0.378, +0.477] | +455.0 | 6.5 | above |
| D | 807 | 75.34% [72.3, 78.2] | +0.4315 [+0.375, +0.488] | +348.2 | 6.3 | above |

## Probability models

**Model C**: selected `lightgbm` {'num_leaves': 8, 'min_child_samples': 200, 'trees': 126}. Threshold: 0.761548498385195 (chosen on validation: 135 trades, EV +0.5200, EV-1se +0.4543)

| on test | AUC | Brier (base-rate Brier) | log loss | ECE |
|---|---|---|---|---|
| selected | 0.6065 | 0.23518 (0.24461) | 0.66273 | 0.0157 |
| logistic baseline | 0.6044 | 0.23581 (0.24461) | 0.66415 | 0.0157 |

Reliability (test): 0.360->0.359 (n=676); 0.500->0.527 (n=675); 0.521->0.533 (n=675); 0.537->0.527 (n=676); 0.555->0.553 (n=675); 0.581->0.590 (n=675); 0.615->0.596 (n=676); 0.647->0.673 (n=675); 0.685->0.636 (n=675); 0.743->0.741 (n=676)

**Model D**: selected `lightgbm` {'num_leaves': 8, 'min_child_samples': 200, 'trees': 149}. Threshold: 0.7600566248620412 (chosen on validation: 135 trades, EV +0.4496, EV-1se +0.3798)

| on test | AUC | Brier (base-rate Brier) | log loss | ECE |
|---|---|---|---|---|
| selected | 0.6032 | 0.23552 (0.24461) | 0.66346 | 0.0211 |
| logistic baseline | 0.6050 | 0.23569 (0.24461) | 0.66389 | 0.0165 |

Reliability (test): 0.363->0.374 (n=676); 0.502->0.536 (n=675); 0.524->0.530 (n=675); 0.539->0.518 (n=676); 0.556->0.573 (n=675); 0.581->0.545 (n=675); 0.613->0.602 (n=676); 0.645->0.676 (n=675); 0.683->0.647 (n=675); 0.741->0.732 (n=676)

## Walk-forward folds (train+validation period only)

| fold | rows | A trades/EV | B | C | D | thresholds C/D |
|---|---|---|---|---|---|---|
| 0 | 3243 | 2889 / +0.111 | 3004 / +0.108 | 343 / +0.379 | 146 / +0.379 | 0.6960648366410689 / 0.7148128956631663 |
| 1 | 3247 | 2959 / +0.117 | 3034 / +0.117 | 268 / +0.503 | 66 / +0.526 | 0.6970009141898743 / 0.7166249857044397 |
| 2 | 3217 | 2943 / +0.045 | 3026 / +0.050 | 304 / +0.350 | 238 / +0.421 | 0.7272381979020431 / 0.7326261058269711 |
| 3 | 3238 | 2974 / +0.097 | 3058 / +0.103 | 62 / +0.594 | 55 / +0.520 | 0.7300701025710266 / 0.7194915369390434 |
| 4 | 3310 | 3000 / +0.104 | 3110 / +0.107 | 88 / +0.533 | 302 / +0.428 | 0.7318969377226447 / 0.6918178956455976 |

## Test performance by pattern and market condition (modes A and D)

**A by pattern**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| BEARISH_SWEEP | 671 | 56.93% [53.2, 60.6] | +0.0817 [+0.010, +0.153] | +54.8 | 14.1 | above |
| BULLISH_SWEEP | 668 | 57.34% [53.6, 61.0] | +0.0894 [+0.018, +0.161] | +59.7 | 14.0 | above |
| EQ_LOWER_WICK_SWEEP | 113 | 53.98% [44.8, 62.9] | +0.0257 [-0.150, +0.201] | +2.9 | 7.2 | inconclusive |
| EQ_UPPER_WICK_SWEEP | 104 | 54.81% [45.2, 64.0] | +0.0413 [-0.141, +0.224] | +4.3 | 12.8 | inconclusive |
| MOMENTUM_BODY_DOMINANCE | 2025 | 65.33% [63.2, 67.4] | +0.2413 [+0.202, +0.281] | +488.7 | 15.0 | above |
| REPEATED_SWEEP | 1544 | 53.50% [51.0, 56.0] | +0.0165 [-0.031, +0.064] | +25.4 | 45.0 | inconclusive |
| SWEEP_CONTINUATION | 833 | 58.70% [55.3, 62.0] | +0.1154 [+0.052, +0.179] | +96.1 | 11.2 | above |
| WEAK_STRONG_STRONG | 268 | 32.84% [27.5, 38.7] | -0.3761 [-0.483, -0.269] | -100.8 | 102.6 | below |

**A by adx_regime**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| moderate | 1740 | 60.00% [57.7, 62.3] | +0.1400 [+0.096, +0.184] | +243.6 | 30.0 | above |
| strong | 3526 | 57.40% [55.8, 59.0] | +0.0906 [+0.060, +0.122] | +319.6 | 28.9 | above |
| weak | 960 | 56.35% [53.2, 59.5] | +0.0707 [+0.011, +0.130] | +67.9 | 19.3 | above |

**A by atr_regime**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| busy | 504 | 60.91% [56.6, 65.1] | +0.1573 [+0.076, +0.238] | +79.3 | 9.1 | above |
| normal | 4661 | 57.78% [56.4, 59.2] | +0.0978 [+0.071, +0.125] | +455.7 | 33.7 | above |
| quiet | 1061 | 57.40% [54.4, 60.3] | +0.0906 [+0.034, +0.147] | +96.1 | 21.7 | above |

**A by session**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| asia | 1829 | 58.72% [56.4, 61.0] | +0.1157 [+0.073, +0.159] | +211.6 | 16.3 | above |
| late | 783 | 57.98% [54.5, 61.4] | +0.1017 [+0.036, +0.167] | +79.6 | 14.1 | above |
| london | 1547 | 58.05% [55.6, 60.5] | +0.1029 [+0.056, +0.150] | +159.2 | 21.6 | above |
| newyork | 2067 | 57.23% [55.1, 59.4] | +0.0874 [+0.047, +0.128] | +180.7 | 23.5 | above |

**A by trend_vs_trade**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| against_trend | 1342 | 54.84% [52.2, 57.5] | +0.0420 [-0.009, +0.093] | +56.4 | 22.6 | inconclusive |
| no_trend | 3405 | 58.38% [56.7, 60.0] | +0.1093 [+0.078, +0.141] | +372.2 | 24.9 | above |
| with_trend | 1479 | 59.84% [57.3, 62.3] | +0.1369 [+0.089, +0.184] | +202.5 | 14.1 | above |

**A by instrument**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| SYNTH1 | 1576 | 59.33% [56.9, 61.7] | +0.1272 [+0.081, +0.173] | +200.5 | 25.5 | above |
| SYNTH2 | 1539 | 58.22% [55.7, 60.7] | +0.1062 [+0.059, +0.153] | +163.4 | 24.1 | above |
| SYNTH3 | 1532 | 56.85% [54.4, 59.3] | +0.0802 [+0.033, +0.127] | +122.9 | 23.1 | above |
| SYNTH4 | 1579 | 57.44% [55.0, 59.9] | +0.0914 [+0.045, +0.138] | +144.3 | 14.6 | above |

**D by pattern**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| MOMENTUM_BODY_DOMINANCE | 131 | 76.34% [68.4, 82.8] | +0.4504 [+0.312, +0.589] | +59.0 | 2.2 | above |
| SWEEP_CONTINUATION | 13 | 61.54% [35.5, 82.3] | +0.1692 [-0.354, +0.692] | +2.2 | 3.0 | inconclusive |

**D by adx_regime**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| moderate | 46 | 78.26% [64.4, 87.7] | +0.4870 [+0.258, +0.716] | +22.4 | 3.2 | above |
| strong | 78 | 71.79% [61.0, 80.6] | +0.3641 [+0.173, +0.555] | +28.4 | 4.4 | above |
| weak | 20 | 80.00% [58.4, 91.9] | +0.5200 [+0.178, +0.862] | +10.4 | 2.0 | above |

**D by atr_regime**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| busy | 8 | 100.00% [67.6, 100.0] | +0.9000 [+0.900, +0.900] | +7.2 | 0.0 | above |
| normal | 99 | 75.76% [66.5, 83.1] | +0.4394 [+0.278, +0.601] | +43.5 | 2.4 | above |
| quiet | 37 | 67.57% [51.5, 80.4] | +0.2838 [-0.007, +0.574] | +10.5 | 3.1 | inconclusive |

**D by session**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| asia | 26 | 76.92% [57.9, 89.0] | +0.4615 [+0.148, +0.775] | +12.0 | 4.2 | above |
| late | 12 | 75.00% [46.8, 91.1] | +0.4250 [-0.061, +0.911] | +5.1 | 1.1 | inconclusive |
| london | 41 | 80.49% [66.0, 89.8] | +0.5293 [+0.296, +0.763] | +21.7 | 2.1 | above |
| newyork | 65 | 70.77% [58.8, 80.4] | +0.3446 [+0.133, +0.556] | +22.4 | 4.0 | above |

**D by trend_vs_trade**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| against_trend | 4 | 100.00% [51.0, 100.0] | +0.9000 [+0.900, +0.900] | +3.6 | 0.0 | inconclusive |
| no_trend | 105 | 72.38% [63.2, 80.0] | +0.3752 [+0.212, +0.539] | +39.4 | 2.1 | above |
| with_trend | 35 | 80.00% [64.1, 90.0] | +0.5200 [+0.265, +0.775] | +18.2 | 3.1 | above |

**D by instrument**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| SYNTH1 | 50 | 78.00% [64.8, 87.2] | +0.4820 [+0.262, +0.702] | +24.1 | 2.0 | above |
| SYNTH2 | 38 | 78.95% [63.7, 88.9] | +0.5000 [+0.250, +0.750] | +19.0 | 3.0 | above |
| SYNTH3 | 33 | 69.70% [52.7, 82.6] | +0.3242 [+0.022, +0.627] | +10.7 | 3.1 | above |
| SYNTH4 | 23 | 69.57% [49.1, 84.4] | +0.3217 [-0.044, +0.687] | +7.4 | 2.0 | inconclusive |

## Verdict

Modes with an expectancy confidence interval entirely above zero on the untouched test block (>= 200 trades): A, B, B_tuned. One test block is still one sample: confirm on a later period before risking money.

Limits: slippage, requotes, rejections and payout changes are not modelled; one trade at a time per instrument; instruments are correlated; a model that earned nothing on validation exports threshold `null` and never trades.