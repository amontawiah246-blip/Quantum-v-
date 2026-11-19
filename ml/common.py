"""Shared helpers: dataset loading and checks, the indicator gate (mirror of src/hybridFeatures.ts evaluateEvidence),
trade simulation and statistics. Nothing here looks at the future of a row except the outcome columns, which are only
used for labels and for scoring a decision AFTER it was made."""
from __future__ import annotations
import json, math
from pathlib import Path
import numpy as np
import pandas as pd

TF = 300


def load_dataset(path: str):
    p = Path(path)
    df = pd.read_csv(p)
    meta_path = p.with_suffix("").with_name(p.stem + ".meta.json")
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    need = {"symbol", "signal_time", "side", "primary", "result", "payout", "entry_time", "settle_time", "gate_pass"}
    miss = need - set(df.columns)
    if miss:
        raise SystemExit(f"dataset is missing columns: {sorted(miss)}")
    dup = df.duplicated(["symbol", "signal_time", "side"]).sum()
    if dup:
        raise SystemExit(f"{dup} duplicate (symbol, signal_time, side) observations: refusing to train on duplicates")
    if (df["settle_time"] <= df["signal_time"]).any():
        raise SystemExit("a trade settles before its signal candle: corrupt dataset")
    df = df.sort_values(["signal_time", "symbol", "side"], kind="mergesort").reset_index(drop=True)
    df["win"] = (df["result"] == "win").astype(int)
    df["pnl"] = np.where(df["result"] == "win", df["payout"], np.where(df["result"] == "loss", -1.0, 0.0))
    df["tie"] = (df["result"] == "tie")
    return df, meta


# ------------------------------------------------------------------ gate (must equal the TypeScript evidence rules)
def evidence(df: pd.DataFrame, rules: dict, gate: dict | None = None):
    """Returns (quality, gate_pass) as arrays. rules = meta['rules'] ({'indicators':..., 'gate':...}); gate overrides rules['gate']."""
    ind, g = rules["indicators"], dict(rules["gate"])
    if gate:
        g.update(gate)
    adx, di, atr, gap, slope = (df[c].to_numpy(float) for c in ("adx", "di_diff", "atr_ratio", "ema_gap_atr", "ema_slope_atr"))
    cont = (df["family"] == "CONTINUATION").to_numpy()
    n = len(df)
    A, R, E = ind["adx"], ind["atr"], ind["ema"]
    with np.errstate(invalid="ignore"):
        strong, weak, withdir = adx >= A["strong"], adx < A["weak"], di > 0
        e_adx = np.where(cont, np.where(strong, np.where(withdir, 1, -1), np.where(weak, -1, 0)),
                         np.where(strong & ~withdir, -1, np.where(weak, 1, 0))).astype(float)
        e_atr = np.where((atr >= R["coreLow"]) & (atr <= R["coreHigh"]), 1, np.where((atr < R["outerLow"]) | (atr > R["outerHigh"]), -1, 0)).astype(float)
        up = (gap > E["flatGapAtr"]) & (slope > 0)
        down = (gap < -E["flatGapAtr"]) & (slope < 0)
        e_ema = np.where(up, 1, np.where(down, -1, 0)).astype(float)
    ok = {"adx": A["enabled"] & np.isfinite(adx) & np.isfinite(di), "atr": R["enabled"] & np.isfinite(atr), "ema": E["enabled"] & np.isfinite(gap) & np.isfinite(slope)}
    vals = {"adx": e_adx, "atr": e_atr, "ema": e_ema}
    used = np.zeros(n); contra = np.zeros(n); tot = np.zeros(n)
    for k in vals:
        m = np.broadcast_to(ok[k], (n,)).astype(bool)
        used += m; contra += m & (vals[k] == -1); tot += np.where(m, vals[k], 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        quality = np.where(used > 0, tot / used, np.nan)
        veto = (used >= g["minIndicatorsForVeto"]) & (contra / np.where(used > 0, used, 1) >= g["vetoContradictFraction"] - 1e-12)
        if g["minQuality"] > -1:
            veto |= (used > 0) & (quality < g["minQuality"])
    return quality, ~veto


# ------------------------------------------------------------------ trade simulation and statistics
def wilson(w: int, n: int, z=1.96):
    if n <= 0:
        return (math.nan, math.nan)
    p = w / n; d = 1 + z * z / n; c = p + z * z / (2 * n); h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def normal_cdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def execute(df: pd.DataFrame, sel: np.ndarray) -> pd.DataFrame:
    """Selected rows -> trades actually taken: one open trade per instrument (a signal whose fill comes before the previous settlement is skipped)."""
    t = df[sel].sort_values(["entry_time", "symbol"], kind="mergesort")
    keep = []; last = {}
    for idx, s, e, st in zip(t.index, t["symbol"], t["entry_time"], t["settle_time"]):
        if e < last.get(s, -math.inf):
            continue
        last[s] = st; keep.append(idx)
    return t.loc[keep]


def stats(tr: pd.DataFrame, payout: float) -> dict:
    n = len(tr)
    if n == 0:
        return {"trades": 0, "wins": 0, "losses": 0, "ties": 0, "win_rate": None, "ev": None, "ev_ci": [None, None], "total": 0.0, "max_dd": 0.0, "wr_ci": [None, None], "breakeven_wr": 1 / (1 + payout), "vs_breakeven": "n/a", "p_ev_le_0": None}
    w = int((tr["result"] == "win").sum()); l = int((tr["result"] == "loss").sum()); ties = n - w - l
    pay = float(tr["payout"].mean()); be = 1 / (1 + pay)
    ci = wilson(w, w + l)
    p = tr["pnl"].to_numpy(float); mean = p.mean(); se = p.std(ddof=1) / math.sqrt(n) if n > 1 else math.nan
    eq = np.cumsum(tr.sort_values(["entry_time", "symbol"], kind="mergesort")["pnl"].to_numpy(float))
    dd = float(np.max(np.maximum.accumulate(np.concatenate([[0.0], eq])) - np.concatenate([[0.0], eq])))
    z = mean / se if se and se > 0 else math.nan
    return {
        "trades": n, "wins": w, "losses": l, "ties": ties, "win_rate": w / (w + l) if w + l else None, "wr_ci": [ci[0], ci[1]], "breakeven_wr": be,
        "vs_breakeven": "n/a" if math.isnan(ci[0]) else "above" if ci[0] > be else "below" if ci[1] < be else "inconclusive",
        "ev": float(mean), "ev_ci": [float(mean - 1.96 * se), float(mean + 1.96 * se)] if not math.isnan(se) else [None, None],
        "total": float(p.sum()), "max_dd": dd, "p_ev_le_0": float(1 - normal_cdf(z)) if not math.isnan(z) else None,
    }


def resolve_conflicts(df: pd.DataFrame, sel: np.ndarray, score: np.ndarray | None, margin: float) -> np.ndarray:
    """Both sides selected on one (symbol, candle): keep the higher score if it leads by `margin`, else neither (score None = neither)."""
    sel = sel.copy()
    d = pd.DataFrame({"k": df["symbol"] + "|" + df["signal_time"].astype(str), "sel": sel, "i": np.arange(len(df))})
    both = d[d.sel].groupby("k")["i"].apply(list)
    for idxs in both:
        if len(idxs) < 2:
            continue
        if score is None:
            sel[idxs] = False; continue
        s = score[idxs]
        if np.any(np.isnan(s)) or s.max() - np.sort(s)[-2] < margin:
            sel[idxs] = False
        else:
            keep = idxs[int(np.argmax(s))]; sel[idxs] = False; sel[keep] = True
    return sel


# ------------------------------------------------------------------ probability metrics
def calibration(y: np.ndarray, p: np.ndarray, bins: int = 10) -> dict:
    from sklearn.metrics import roc_auc_score
    y = np.asarray(y, float); p = np.clip(np.asarray(p, float), 1e-9, 1 - 1e-9)
    out = {"n": int(len(y)), "brier": float(np.mean((p - y) ** 2)), "logloss": float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))),
           "base_rate": float(y.mean()) if len(y) else None, "auc": float(roc_auc_score(y, p)) if len(set(y)) > 1 else None}
    edges = np.quantile(p, np.linspace(0, 1, bins + 1)); edges[0] -= 1e-9; edges[-1] += 1e-9
    rel, ece = [], 0.0
    for a, b in zip(edges[:-1], edges[1:]):
        m = (p > a) & (p <= b)
        if m.sum() == 0:
            continue
        rel.append({"n": int(m.sum()), "mean_predicted": float(p[m].mean()), "observed_win_rate": float(y[m].mean())})
        ece += m.sum() / len(y) * abs(p[m].mean() - y[m].mean())
    out["ece"] = float(ece); out["reliability"] = rel
    out["brier_baseline"] = float(np.mean((y.mean() - y) ** 2)) if len(y) else None
    return out
