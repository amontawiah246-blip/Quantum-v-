"""Model fitting, calibration, threshold choice and export (format read by src/hybridModel.ts)."""
from __future__ import annotations
import math
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.isotonic import IsotonicRegression

SEED = 7
LGBM_GRID = [dict(num_leaves=4, min_child_samples=200), dict(num_leaves=8, min_child_samples=200), dict(num_leaves=4, min_child_samples=50), dict(num_leaves=8, min_child_samples=50)]
LR_GRID = [0.01, 0.1, 1.0]


def logit(p):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return np.log(p / (1 - p))


def sigmoid(z):
    return 1 / (1 + np.exp(-z))


def ll(y, p):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


class Fitted:
    """A fitted model of one kind. predict_raw(X) -> P(win) before calibration."""
    def __init__(self, kind, names, impl, spec_part, es_logloss, params):
        self.kind, self.names, self.impl, self.spec_part, self.es_logloss, self.params = kind, names, impl, spec_part, es_logloss, params

    def predict_raw(self, X):
        if self.kind == "logistic":
            m = self.spec_part
            Z = np.where(np.isfinite(X), X, np.array(m["fill"])[None, :])
            return sigmoid(m["intercept"] + ((Z - np.array(m["mean"])) / np.array(m["std"])) @ np.array(m["coef"]))
        return self.impl.predict(X, raw_score=False)


def fit_logistic(X, y, Xes, yes, names):
    fill = np.nanmedian(X, axis=0); fill = np.where(np.isfinite(fill), fill, 0.0)
    Z = np.where(np.isfinite(X), X, fill[None, :])
    mean = Z.mean(0); std = Z.std(0); std = np.where(std > 0, std, 1.0)
    best = None
    for C in LR_GRID:
        lr = LogisticRegression(C=C, max_iter=2000).fit((Z - mean) / std, y)
        part = dict(intercept=float(lr.intercept_[0]), coef=lr.coef_[0].tolist(), mean=mean.tolist(), std=std.tolist(), fill=fill.tolist())
        f = Fitted("logistic", names, lr, part, None, {"C": C})
        loss = ll(yes, f.predict_raw(Xes))
        if best is None or loss < best.es_logloss:
            f.es_logloss = loss; best = f
    return best


def fit_lgbm(X, y, Xes, yes, names):
    import lightgbm as lgb
    best = None
    for g in LGBM_GRID:
        m = lgb.LGBMClassifier(objective="binary", learning_rate=0.03, n_estimators=800, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, reg_lambda=10.0,
                               random_state=SEED, deterministic=True, force_row_wise=True, verbose=-1, **g)
        m.fit(X, y, eval_set=[(Xes, yes)], eval_metric="binary_logloss", callbacks=[lgb.early_stopping(50, verbose=False)])
        f = Fitted("lightgbm", names, m, None, None, {**g, "trees": int(m.best_iteration_ or m.n_estimators_)})
        f.es_logloss = ll(yes, m.predict_proba(Xes, num_iteration=m.best_iteration_)[:, 1])
        f.impl_best_iter = m.best_iteration_
        if best is None or f.es_logloss < best.es_logloss:
            best = f
    return best


def lgbm_predict_raw(f: Fitted, X):
    return f.impl.predict_proba(X, num_iteration=f.impl.best_iteration_)[:, 1]


def predict_raw(f: Fitted, X):
    return f.predict_raw(X) if f.kind == "logistic" else lgbm_predict_raw(f, X)


def fit_calibrator(raw, y, kind="platt"):
    if kind == "isotonic":
        iso = IsotonicRegression(out_of_bounds="clip", y_min=1e-6, y_max=1 - 1e-6).fit(raw, y)
        return {"type": "isotonic", "x": iso.X_thresholds_.tolist(), "y": iso.y_thresholds_.tolist()}
    lr = LogisticRegression(C=1e6, max_iter=1000).fit(logit(raw).reshape(-1, 1), y)
    return {"type": "platt", "a": float(lr.coef_[0][0]), "b": float(lr.intercept_[0])}


def apply_calibration(raw, c):
    raw = np.asarray(raw, float)
    if c["type"] == "none":
        return raw
    if c["type"] == "platt":
        return sigmoid(c["a"] * logit(raw) + c["b"])
    return np.interp(raw, c["x"], c["y"])


def choose_threshold(p, pnl, breakeven, min_trades, step_q=0.02):
    """Pick the calibrated-probability cut-off on VALIDATION data: maximise (mean pnl - 1 standard error) among cut-offs that keep at least min_trades.
    Returns (threshold or None, note, table). None = nothing had a positive penalised expectancy, so the model must not trade."""
    p = np.asarray(p, float); pnl = np.asarray(pnl, float)
    cands = sorted(set(np.quantile(p, np.arange(0.0, 1.0, step_q)).tolist() + [breakeven]))
    best = None; table = []
    for t in cands:
        t = max(t, breakeven)
        m = p >= t; n = int(m.sum())
        if n < min_trades:
            continue
        mean = float(pnl[m].mean()); se = float(pnl[m].std(ddof=1) / math.sqrt(n))
        score = mean - se
        table.append({"threshold": t, "trades": n, "ev": mean, "ev_minus_se": score})
        if best is None or score > best[0]:
            best = (score, t, n, mean)
    if best is None or best[0] <= 0:
        return None, f"no cut-off with >= {min_trades} validation trades had mean - 1 s.e. above zero (best {best[0]:.4f})" if best else f"fewer than {min_trades} validation trades", table
    return float(best[1]), f"chosen on validation: {best[2]} trades, EV {best[3]:+.4f}, EV-1se {best[0]:+.4f}", table


# ------------------------------------------------------------------ export
def _tree(node):
    if "leaf_value" in node:
        return {"v": float(node["leaf_value"])}
    assert node["decision_type"] == "<=", "categorical splits are not used"
    mt = {"None": 0, "Zero": 1, "NaN": 2}[node["missing_type"]]
    return {"f": int(node["split_feature"]), "t": float(node["threshold"]), "dl": bool(node["default_left"]), "mt": mt, "l": _tree(node["left_child"]), "r": _tree(node["right_child"])}


def export_spec(f: Fitted, cal, thr, thr_note, indicators_used, metrics):
    spec = {"kind": f.kind, "featureNames": f.names, "indicatorsUsed": indicators_used, "calibration": cal, "threshold": thr, "thresholdNote": thr_note, "metrics": metrics, "hyperparameters": f.params}
    if f.kind == "logistic":
        spec["logistic"] = f.spec_part
    else:
        d = f.impl.booster_.dump_model(num_iteration=f.impl.best_iteration_)
        spec["lightgbm"] = {"trees": [_tree(t["tree_structure"]) for t in d["tree_info"]]}
    return spec


def predict_spec(spec, X):
    """Independent Python evaluation of the EXPORTED spec (same algorithm as hybridModel.ts). Used to prove the export is faithful."""
    X = np.asarray(X, float)
    if spec["kind"] == "logistic":
        L = spec["logistic"]
        Z = np.where(np.isfinite(X), X, np.array(L["fill"])[None, :])
        raw = sigmoid(L["intercept"] + ((Z - np.array(L["mean"])) / np.array(L["std"])) @ np.array(L["coef"]))
    else:
        def walk(n, x):
            while "v" not in n:
                v = x[n["f"]]
                if math.isnan(v) and n["mt"] != 2:
                    v = 0.0
                miss = (n["mt"] == 1 and abs(v) <= 1e-35) or (n["mt"] == 2 and math.isnan(v))
                n = (n["l"] if n["dl"] else n["r"]) if miss else (n["l"] if v <= n["t"] else n["r"])
            return n["v"]
        raw = np.array([sigmoid(sum(walk(t, x) for t in spec["lightgbm"]["trees"])) for x in X])
    return raw, apply_calibration(raw, spec["calibration"])
