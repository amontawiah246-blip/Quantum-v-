"""python3 -m unittest discover -s ml -p 'test_ml.py'   (pure Python: no Node needed)"""
import sys, unittest
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).parent))
import common as C, models as M

RULES = {"indicators": {"adx": {"enabled": True, "strong": 25, "weak": 18}, "atr": {"enabled": True, "coreLow": .7, "coreHigh": 1.8, "outerLow": .5, "outerHigh": 2.5}, "ema": {"enabled": True, "flatGapAtr": .1}},
         "gate": {"minIndicatorsForVeto": 2, "vetoContradictFraction": 1, "minQuality": -1}}


def frame(**kw):
    base = dict(adx=[10.0], di_diff=[-5.0], atr_ratio=[3.0], ema_gap_atr=[-.5], ema_slope_atr=[-.2], family=["CONTINUATION"])
    base.update({k: [v] for k, v in kw.items()})
    return pd.DataFrame(base)


class Gate(unittest.TestCase):
    def test_unanimous_contradiction_vetoes_one_does_not(self):
        q, g = C.evidence(frame(), RULES); self.assertFalse(g[0]); self.assertAlmostEqual(q[0], -1)
        q, g = C.evidence(frame(atr_ratio=1.0), RULES); self.assertTrue(g[0])
        r = {**RULES, "indicators": {**RULES["indicators"], "ema": {**RULES["indicators"]["ema"], "enabled": False}, "atr": {**RULES["indicators"]["atr"], "enabled": False}}}
        self.assertTrue(C.evidence(frame(), r)[1][0], "a single available indicator cannot veto")


class Trades(unittest.TestCase):
    def test_overlap_and_stats(self):
        df = pd.DataFrame({"symbol": ["A", "A", "B"], "entry_time": [0, 100, 50], "settle_time": [300, 400, 350], "result": ["win", "loss", "win"], "payout": [.9] * 3, "pnl": [.9, -1, .9]})
        tr = C.execute(df, np.ones(3, bool)); self.assertEqual(len(tr), 2, "second A trade starts before the first settled")
        s = C.stats(tr, .9); self.assertEqual(s["wins"], 2); self.assertAlmostEqual(s["ev"], .9)

    def test_conflicts(self):
        df = pd.DataFrame({"symbol": ["A", "A"], "signal_time": [1, 1]})
        self.assertFalse(C.resolve_conflicts(df, np.array([True, True]), None, 0).any())
        self.assertEqual(C.resolve_conflicts(df, np.array([True, True]), np.array([.7, .6]), .05).tolist(), [True, False])
        self.assertFalse(C.resolve_conflicts(df, np.array([True, True]), np.array([.62, .6]), .05).any())


class Models(unittest.TestCase):
    def test_noise_gets_no_threshold(self):
        rng = np.random.default_rng(0); p = rng.uniform(.4, .6, 4000); win = rng.random(4000) < .5
        pnl = np.where(win, .9, -1.0)
        thr, note, _ = M.choose_threshold(p, pnl, 1 / 1.9, 100)
        self.assertIsNone(thr, note)

    def test_real_signal_gets_a_threshold_and_export_is_faithful(self):
        rng = np.random.default_rng(1); n = 6000
        X = rng.normal(size=(n, 4)); X[rng.random((n, 4)) < .05] = np.nan
        z = np.nan_to_num(X[:, 0]) * 1.2; y = (rng.random(n) < 1 / (1 + np.exp(-z))).astype(int)
        names = list("abcd")
        f = M.fit_lgbm(X[:3600], y[:3600], X[3600:4500], y[3600:4500], names)
        spec = M.export_spec(f, {"type": "none"}, None, "", [], {})
        raw, _ = M.predict_spec(spec, X[4500:]); self.assertTrue(np.allclose(raw, M.predict_raw(f, X[4500:]), atol=1e-9))
        lr = M.fit_logistic(X[:3600], y[:3600], X[3600:4500], y[3600:4500], names)
        spec = M.export_spec(lr, {"type": "none"}, None, "", [], {})
        raw, _ = M.predict_spec(spec, X[4500:]); self.assertTrue(np.allclose(raw, M.predict_raw(lr, X[4500:]), atol=1e-9))

    def test_calibration_maps(self):
        rng = np.random.default_rng(2); raw = rng.uniform(.2, .8, 5000); y = (rng.random(5000) < raw * .5 + .25).astype(int)
        for kind in ("platt", "isotonic"):
            cal = M.fit_calibrator(raw, y, kind); p = M.apply_calibration(raw, cal)
            self.assertLess(abs(p.mean() - y.mean()), .02)


if __name__ == "__main__":
    unittest.main()
