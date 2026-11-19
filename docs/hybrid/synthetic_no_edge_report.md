> **SYNTHETIC DATA.** These numbers test the machinery. They say nothing about any real market and must not be read as evidence of profitability.

# Hybrid engine validation report

Payout 0.900 (break-even win probability 0.5263). Rows: {'all': 29280, 'train': 17557, 'validation': 5846, 'test': 5840}. Chronological split with a 12-candle embargo; the test block was not used for any choice.
Number of models, thresholds and gate settings compared while building this: **22** (a good-looking number among many comparisons can be luck).

## Results by mode (identical setups, one open trade per instrument)

A = candlestick only, B = + indicator gate, B_tuned = gate settings chosen on validation, C = + model (no indicator inputs), D = full hybrid.

### validation (thresholds were chosen here: in-sample for them)

| mode | trades | win rate [95% CI] | EV per unit stake [95% CI] | total | max drawdown | vs break-even |
|---|---|---|---|---|---|---|
| A | 5506 | 49.51% [48.2, 50.8] | -0.0593 [-0.084, -0.034] | -326.6 | 351.8 | below |
| B | 5594 | 49.48% [48.2, 50.8] | -0.0598 [-0.085, -0.035] | -334.8 | 355.4 | below |
| B_tuned | 5339 | 49.52% [48.2, 50.9] | -0.0591 [-0.085, -0.034] | -315.4 | 332.9 | below |
| C | 0 | - | - | - | - | - |
| D | 0 | - | - | - | - | - |

### test (out of sample, untouched)

| mode | trades | win rate [95% CI] | EV per unit stake [95% CI] | total | max drawdown | vs break-even |
|---|---|---|---|---|---|---|
| A | 5512 | 50.60% [49.3, 51.9] | -0.0386 [-0.064, -0.014] | -212.9 | 236.5 | below |
| B | 5580 | 50.84% [49.5, 52.2] | -0.0340 [-0.059, -0.009] | -189.7 | 211.8 | below |
| B_tuned | 5338 | 50.69% [49.4, 52.0] | -0.0368 [-0.062, -0.011] | -196.6 | 216.2 | below |
| C | 0 | - | - | - | - | - |
| D | 0 | - | - | - | - | - |

### walk forward oof (every fold trained only on its past)

| mode | trades | win rate [95% CI] | EV per unit stake [95% CI] | total | max drawdown | vs break-even |
|---|---|---|---|---|---|---|
| A | 13320 | 50.06% [49.2, 50.9] | -0.0489 [-0.065, -0.033] | -650.8 | 687.3 | below |
| B | 13466 | 50.06% [49.2, 50.9] | -0.0489 [-0.065, -0.033] | -658.1 | 689.0 | below |
| C | 0 | - | - | - | - | - |
| D | 101 | 58.42% [48.7, 67.5] | +0.1099 [-0.074, +0.293] | +11.1 | 6.5 | inconclusive |

## Probability models

**Model C**: selected `lightgbm` {'num_leaves': 4, 'min_child_samples': 200, 'trees': 62}. Threshold: None (fewer than 100 validation trades)

| on test | AUC | Brier (base-rate Brier) | log loss | ECE |
|---|---|---|---|---|
| selected | 0.4967 | 0.25016 (0.24997) | 0.69347 | 0.0160 |
| logistic baseline | 0.4942 | 0.25011 (0.24997) | 0.69337 | 0.0143 |

Reliability (test): 0.483->0.509 (n=584); 0.488->0.536 (n=584); 0.490->0.519 (n=584); 0.492->0.485 (n=584); 0.494->0.478 (n=584); 0.496->0.500 (n=584); 0.498->0.522 (n=584); 0.500->0.498 (n=584); 0.502->0.503 (n=584); 0.509->0.507 (n=584)

**Model D**: selected `lightgbm` {'num_leaves': 4, 'min_child_samples': 200, 'trees': 11}. Threshold: None (fewer than 100 validation trades)

| on test | AUC | Brier (base-rate Brier) | log loss | ECE |
|---|---|---|---|---|
| selected | 0.4941 | 0.25007 (0.24997) | 0.69329 | 0.0173 |
| logistic baseline | 0.4939 | 0.25012 (0.24997) | 0.69340 | 0.0173 |

Reliability (test): 0.495->0.491 (n=585); 0.495->0.515 (n=586); 0.495->0.521 (n=603); 0.495->0.514 (n=562); 0.495->0.531 (n=586); 0.495->0.505 (n=582); 0.495->0.480 (n=588); 0.495->0.501 (n=583); 0.495->0.518 (n=581); 0.495->0.481 (n=584)

## Walk-forward folds (train+validation period only)

| fold | rows | A trades/EV | B | C | D | thresholds C/D |
|---|---|---|---|---|---|---|
| 0 | 2799 | 2657 / -0.027 | 2670 / -0.031 | 0 / - | 0 / - | None / None |
| 1 | 2798 | 2668 / -0.062 | 2693 / -0.061 | 0 / - | 101 / +0.110 | None / 0.527136517462793 |
| 2 | 2825 | 2669 / -0.030 | 2694 / -0.027 | 0 / - | 0 / - | None / None |
| 3 | 2871 | 2713 / -0.034 | 2744 / -0.031 | 0 / - | 0 / - | None / None |
| 4 | 2775 | 2613 / -0.093 | 2665 / -0.095 | 0 / - | 0 / - | None / None |

## Test performance by pattern and market condition (modes A and D)

**A by pattern**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| BEARISH_SWEEP | 658 | 51.37% [47.6, 55.2] | -0.0240 [-0.097, +0.049] | -15.8 | 36.5 | inconclusive |
| BULLISH_SWEEP | 680 | 50.88% [47.1, 54.6] | -0.0332 [-0.105, +0.038] | -22.6 | 32.1 | inconclusive |
| EQ_LOWER_WICK_SWEEP | 130 | 41.54% [33.4, 50.1] | -0.2108 [-0.372, -0.049] | -27.4 | 32.6 | below |
| EQ_UPPER_WICK_SWEEP | 128 | 53.91% [45.3, 62.3] | +0.0242 [-0.141, +0.189] | +3.1 | 6.6 | inconclusive |
| MOMENTUM_BODY_DOMINANCE | 800 | 47.62% [44.2, 51.1] | -0.0951 [-0.161, -0.029] | -76.1 | 89.0 | below |
| REPEATED_SWEEP | 2142 | 51.45% [49.3, 53.6] | -0.0225 [-0.063, +0.018] | -48.2 | 83.2 | inconclusive |
| SWEEP_CONTINUATION | 826 | 51.69% [48.3, 55.1] | -0.0178 [-0.083, +0.047] | -14.7 | 30.6 | inconclusive |
| WEAK_STRONG_STRONG | 148 | 48.65% [40.7, 56.6] | -0.0757 [-0.229, +0.078] | -11.2 | 13.3 | inconclusive |

**A by adx_regime**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| moderate | 1669 | 49.79% [47.4, 52.2] | -0.0540 [-0.100, -0.008] | -90.1 | 93.6 | below |
| strong | 2181 | 50.57% [48.5, 52.7] | -0.0391 [-0.079, +0.001] | -85.3 | 108.7 | inconclusive |
| weak | 1662 | 51.44% [49.0, 53.8] | -0.0226 [-0.068, +0.023] | -37.5 | 65.6 | inconclusive |

**A by atr_regime**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| busy | 472 | 52.12% [47.6, 56.6] | -0.0097 [-0.095, +0.076] | -4.6 | 23.7 | inconclusive |
| normal | 4109 | 50.62% [49.1, 52.1] | -0.0382 [-0.067, -0.009] | -157.0 | 179.4 | below |
| quiet | 931 | 49.73% [46.5, 52.9] | -0.0551 [-0.116, +0.006] | -51.3 | 65.1 | inconclusive |

**A by session**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| asia | 1622 | 51.23% [48.8, 53.7] | -0.0266 [-0.073, +0.020] | -43.1 | 65.7 | inconclusive |
| late | 682 | 51.61% [47.9, 55.3] | -0.0194 [-0.091, +0.052] | -13.2 | 43.6 | inconclusive |
| london | 1404 | 50.93% [48.3, 53.5] | -0.0324 [-0.082, +0.017] | -45.5 | 66.4 | inconclusive |
| newyork | 1804 | 49.39% [47.1, 51.7] | -0.0616 [-0.105, -0.018] | -111.1 | 122.3 | below |

**A by trend_vs_trade**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| against_trend | 1328 | 50.75% [48.1, 53.4] | -0.0357 [-0.087, +0.015] | -47.4 | 61.0 | inconclusive |
| no_trend | 2922 | 50.82% [49.0, 52.6] | -0.0344 [-0.069, +0.000] | -100.5 | 138.5 | inconclusive |
| with_trend | 1262 | 49.92% [47.2, 52.7] | -0.0515 [-0.104, +0.001] | -65.0 | 69.4 | inconclusive |

**A by instrument**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|
| SYNTH1 | 1371 | 51.20% [48.6, 53.8] | -0.0271 [-0.077, +0.023] | -37.2 | 76.4 | inconclusive |
| SYNTH2 | 1392 | 51.51% [48.9, 54.1] | -0.0213 [-0.071, +0.029] | -29.7 | 49.9 | inconclusive |
| SYNTH3 | 1352 | 48.59% [45.9, 51.3] | -0.0767 [-0.127, -0.026] | -103.7 | 112.9 | below |
| SYNTH4 | 1397 | 51.04% [48.4, 53.7] | -0.0303 [-0.080, +0.020] | -42.3 | 73.7 | inconclusive |

**D by pattern**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|

**D by adx_regime**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|

**D by atr_regime**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|

**D by session**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|

**D by trend_vs_trade**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|

**D by instrument**

| group | trades | win rate | EV | total | max DD | vs break-even |
|---|---|---|---|---|---|---|

## Verdict

**No mode shows a demonstrable positive expectancy on the untouched test block** (the 95% interval of the expectancy includes zero or there were fewer than 200 trades). Do not trade this model on this evidence.

Limits: slippage, requotes, rejections and payout changes are not modelled; one trade at a time per instrument; instruments are correlated; a model that earned nothing on validation exports threshold `null` and never trades.