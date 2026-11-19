#!/usr/bin/env python3
"""Train, calibrate, validate and export the hybrid probability model.

    python3 ml/train.py --data data/hybrid_dataset.csv --out models

Chronological discipline (nothing below ever looks at the test period before the very last step):
  train       first 60% of the timeline        -> fits the models (last 20% of it is used only for early stopping)
  validation  next 20%                          -> model-type choice, calibration, probability threshold, gate choice
  test        final 20%, untouched              -> reported once, never used to choose anything
  embargo     rows whose trade settles within `--embargo-candles` of a boundary are dropped from the earlier side, and the first rows after a boundary are skipped
  walk-forward  expanding windows over train+validation only (each fold refits, recalibrates and re-picks its threshold on past data)
Compared on identical setups:  A candlestick only | B + indicator gate | C + model (no indicator inputs) | D full hybrid.
"""
from __future__ import annotations
import argparse, hashlib, json, math, sys, time
from pathlib import Path
import warnings
warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import common as C
import models as M

KINDS = ("C", "D")


def build_names(meta, kind, disabled):
    groups = meta["featureGroups"]; ind = set(meta["indicatorGroups"])
    use = [g for g in groups if (kind == "D" and g not in disabled) or (kind == "C" and g not in ind)]
    return [n for g in use for n in groups[g]]


def add_instruments(df, instruments):
    for s in instruments:
        df[f"inst_{s}"] = (df["symbol"] == s).astype(float)


def fit_pipeline(fit, cal, names, be, min_trades, calibration="platt", force_kind=None):
    """fit/cal: DataFrames (time ordered). Returns a dict with the chosen model, calibrator and validation-chosen threshold."""
    f = fit[~fit["tie"]]; c = cal[~cal["tie"]]
    if len(f) < 300 or len(c) < 100:
        return None
    cut = int(len(f) * 0.8)
    X, y = f[names].to_numpy(float), f["win"].to_numpy()
    Xa, ya, Xe, ye = X[:cut], y[:cut], X[cut:], y[cut:]
    cands = {}
    if force_kind in (None, "logistic"):
        cands["logistic"] = M.fit_logistic(Xa, ya, Xe, ye, names)
    if force_kind in (None, "lightgbm"):
        cands["lightgbm"] = M.fit_lgbm(Xa, ya, Xe, ye, names)
    Xc, yc = c[names].to_numpy(float), c["win"].to_numpy()
    raw_ll = {k: M.ll(yc, M.predict_raw(v, Xc)) for k, v in cands.items()}
    kind = min(raw_ll, key=raw_ll.get)
    model = cands[kind]
    raw_c = M.predict_raw(model, Xc)
    cal_spec = M.fit_calibrator(raw_c, yc, calibration)
    p_all = M.apply_calibration(M.predict_raw(model, cal[names].to_numpy(float)), cal_spec)       # every validation row (ties included: pnl 0)
    thr, note, table = M.choose_threshold(p_all, cal["pnl"].to_numpy(float), be, min_trades)
    return dict(kind=kind, model=model, cal=cal_spec, thr=thr, note=note, table=table, raw_ll=raw_ll, es_ll={k: v.es_logloss for k, v in cands.items()}, names=names, n_fit=len(f), n_cal=len(c))


def prob(fp, df):
    return M.apply_calibration(M.predict_raw(fp["model"], df[fp["names"]].to_numpy(float)), fp["cal"])


def select_modes(df, rules, fps, be, tuned_gate=None, conflict_p=0.05, conflict_q=0.3):
    """Selections (after conflict resolution) for every mode on the rows of df."""
    q, gp = C.evidence(df, rules)
    n = len(df); out = {}
    out["A"] = C.resolve_conflicts(df, np.ones(n, bool), None, 0)
    out["B"] = C.resolve_conflicts(df, gp, q, conflict_q)
    if tuned_gate is not None:
        q2, gp2 = C.evidence(df, rules, tuned_gate)
        out["B_tuned"] = C.resolve_conflicts(df, gp2, q2, conflict_q)
    for kind in KINDS:
        fp = fps.get(kind)
        if fp is None or fp["thr"] is None:
            out[kind] = np.zeros(n, bool); continue
        p = prob(fp, df); t = max(fp["thr"], be)
        base = (p >= t) & (gp if kind == "D" else True)
        out[kind] = C.resolve_conflicts(df, base, p, conflict_p)
    return out


def tune_gate(val, rules, payout, min_trades):
    grid = [dict(minQuality=mq, vetoContradictFraction=vf) for mq in (-1, -0.34, 0.0, 0.34) for vf in (1.0, 0.67)]
    best, rows = None, []
    for g in grid:
        q, gp = C.evidence(val, rules, g)
        sel = C.resolve_conflicts(val, gp, q, 0.3)
        tr = C.execute(val, sel)
        if len(tr) < min_trades:
            continue
        s = C.stats(tr, payout); se = (s["ev_ci"][1] - s["ev"]) / 1.96
        score = s["ev"] - se
        rows.append({**g, "trades": s["trades"], "ev": s["ev"], "ev_minus_se": score})
        if best is None or score > best[0]:
            best = (score, g)
    return (best[1] if best else None), rows, len(grid)


def eval_modes(df, sel, payout):
    return {m: C.stats(C.execute(df, s), payout) for m, s in sel.items()}


def breakdowns(df, sel, payout, rules):
    A = rules["indicators"]["adx"]; R = rules["indicators"]["atr"]
    key = {
        "pattern": df["primary"],
        "adx_regime": pd.cut(df["adx"], [-math.inf, A["weak"], A["strong"], math.inf], labels=["weak", "moderate", "strong"]).astype(str),
        "atr_regime": pd.cut(df["atr_ratio"], [-math.inf, R["coreLow"], R["coreHigh"], math.inf], labels=["quiet", "normal", "busy"]).astype(str),
        "session": np.where(df["sess_asia"] == 1, "asia", np.where(df["sess_london"] == 1, "london", np.where(df["sess_ny"] == 1, "newyork", "late"))),
        "trend_vs_trade": df["struct_trend"].map({1.0: "with_trend", 0.0: "no_trend", -1.0: "against_trend"}).fillna("n/a"),
        "instrument": df["symbol"],
    }
    out = {}
    for m, s in sel.items():
        tr = C.execute(df, s); out[m] = {}
        for k, v in key.items():
            vv = pd.Series(np.asarray(v), index=df.index).loc[tr.index]
            out[m][k] = {str(g): C.stats(tr[vv == g], payout) for g in sorted(vv.unique())}
    return out


def fmt(s):
    if not s or not s["trades"]:
        return "| 0 | - | - | - | - | - |"
    ci = s["ev_ci"]
    return f"| {s['trades']} | {s['win_rate']*100:.2f}% [{s['wr_ci'][0]*100:.1f}, {s['wr_ci'][1]*100:.1f}] | {s['ev']:+.4f} [{ci[0]:+.3f}, {ci[1]:+.3f}] | {s['total']:+.1f} | {s['max_dd']:.1f} | {s['vs_breakeven']} |"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--out", default="models")
    ap.add_argument("--train-frac", type=float, default=0.6); ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--embargo-candles", type=int, default=12); ap.add_argument("--min-val-trades", type=int, default=100)
    ap.add_argument("--min-instrument-rows", type=int, default=300); ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--calibration", choices=["platt", "isotonic"], default="platt")
    ap.add_argument("--disable-indicators", default="", help="comma list of adx,atr,ema: removed from model D inputs AND from the gate")
    a = ap.parse_args()
    t0 = time.time()
    df, meta = C.load_dataset(a.data)
    if "featureGroups" not in meta or "rules" not in meta:
        raise SystemExit("the .meta.json next to the dataset is required (it comes from `hybridCli.ts dataset`)")
    rules = json.loads(json.dumps(meta["rules"]))
    disabled = [d for d in a.disable_indicators.split(",") if d]
    for d in disabled:
        rules["indicators"][d]["enabled"] = False
    synthetic = bool(meta.get("synthetic"))
    payout = float(df["payout"].mean()); be = 1 / (1 + payout)
    emb = a.embargo_candles * C.TF

    # integrity: the Python gate must reproduce the engine's own gate decision on every row
    q, gp = C.evidence(df, meta["rules"])
    mism = int((gp != df["gate_pass"].astype(bool)).sum())
    if mism:
        raise SystemExit(f"gate parity FAILED on {mism} rows: src/hybridFeatures.ts and ml/common.py disagree")

    # ---- chronological split by time across all instruments
    t = df["signal_time"].to_numpy()
    t1, t2 = np.quantile(t, a.train_frac), np.quantile(t, a.train_frac + a.val_frac)
    train = df[(df.signal_time < t1) & (df.settle_time + emb <= t1)]
    val = df[(df.signal_time >= t1) & (df.settle_time + emb <= t2)]
    test = df[df.signal_time >= t2 + emb]
    pre = df[(df.signal_time < t2)]
    # no row may leak across a boundary: outcomes, not only signals, must be settled before the next block starts
    assert train.settle_time.max() + emb <= t1 + 1e-6 and val.signal_time.min() >= t1 and val.settle_time.max() + emb <= t2 + 1e-6 and (len(test) == 0 or test.signal_time.min() >= t2 + emb)
    assert train.index.intersection(val.index).empty and val.index.intersection(test.index).empty and train.index.intersection(test.index).empty
    insts = [s for s, n in train["symbol"].value_counts().items() if n >= a.min_instrument_rows]
    add_instruments(df, insts); [add_instruments(x, insts) for x in (train, val, test, pre)]
    df = df.copy(); train, val, test, pre = df.loc[train.index], df.loc[val.index], df.loc[test.index], df.loc[pre.index]
    print(f"rows {len(df)} | train {len(train)} val {len(val)} test {len(test)} (embargo {a.embargo_candles} candles) | instruments {insts}")

    names = {k: build_names(meta, k, disabled) + [f"inst_{s}" for s in insts] for k in KINDS}
    used_ind = [g for g in meta["indicatorGroups"] if g not in disabled]
    fps, tried = {}, 0
    for k in KINDS:
        fps[k] = fit_pipeline(train, val, names[k], be, a.min_val_trades, a.calibration)
        tried += len(M.LR_GRID) + len(M.LGBM_GRID) + len(fps[k]["table"]) if fps[k] else 0
        print(k, "->", None if not fps[k] else f"{fps[k]['kind']} thr={fps[k]['thr']} ({fps[k]['note']})")
    tuned, tune_rows, ng = tune_gate(val, rules, payout, a.min_val_trades); tried += ng

    sel_val = select_modes(val, rules, fps, be, tuned)
    sel_test = select_modes(test, rules, fps, be, tuned)
    res = {"validation": eval_modes(val, sel_val, payout), "test": eval_modes(test, sel_test, payout)}

    # ---- probability quality on the untouched test rows (ties excluded: they have no win/loss label)
    cal_rep = {}; cmp_models = {}
    for k in KINDS:
        fp = fps[k]
        if not fp:
            continue
        tt = test[~test["tie"]]; vv = val[~val["tie"]]
        p = prob(fp, tt); cal_rep[k] = C.calibration(tt["win"].to_numpy(), p)
        cmp_models[k] = {"selected": fp["kind"], "early_stop_logloss": fp["es_ll"], "validation_raw_logloss": fp["raw_ll"], "params": fp["model"].params,
                         "test": cal_rep[k], "validation_calibrated": C.calibration(vv["win"].to_numpy(), prob(fp, vv))}
        # the logistic baseline always reported next to the chosen model
        lr = M.fit_logistic(*(lambda f: (f[:int(len(f)*.8)][names[k]].to_numpy(float), f[:int(len(f)*.8)]["win"].to_numpy(), f[int(len(f)*.8):][names[k]].to_numpy(float), f[int(len(f)*.8):]["win"].to_numpy(), names[k]))(train[~train["tie"]]))
        craw = M.predict_raw(lr, val[~val["tie"]][names[k]].to_numpy(float)); lcal = M.fit_calibrator(craw, val[~val["tie"]]["win"].to_numpy())
        cmp_models[k]["logistic_baseline_test"] = C.calibration(tt["win"].to_numpy(), M.apply_calibration(M.predict_raw(lr, tt[names[k]].to_numpy(float)), lcal))

    # ---- walk-forward on train+validation only
    wf = []
    if a.folds > 0 and len(pre) > 2000:
        s0 = pre["signal_time"].min(); bounds = [s0 + (t2 - s0) * f for f in np.linspace(0.4, 1.0, a.folds + 1)]
        oof = {m: [] for m in ("A", "B", "C", "D")}
        for k in range(a.folds):
            lo, hi = bounds[k], bounds[k + 1]
            past = pre[pre.settle_time + emb <= lo]; cut = past["signal_time"].quantile(0.8)
            fit_p = past[past.settle_time + emb <= cut]; cal_p = past[past.signal_time >= cut + emb]
            fold = pre[(pre.signal_time >= lo) & (pre.signal_time < hi)]
            wfps = {kk: fit_pipeline(fit_p, cal_p, names[kk], be, max(30, a.min_val_trades // 2), a.calibration, force_kind=fps[kk]["kind"] if fps[kk] else None) for kk in KINDS}
            sel = select_modes(fold, rules, wfps, be)
            st = eval_modes(fold, sel, payout)
            wf.append({"fold": k, "from": float(lo), "to": float(hi), "rows": len(fold), **{m: st[m] for m in ("A", "B", "C", "D")}, "thresholds": {kk: (wfps[kk]["thr"] if wfps[kk] else None) for kk in KINDS}})
            for m in oof:
                oof[m].append(C.execute(fold, sel[m]))
        res["walk_forward_oof"] = {m: C.stats(pd.concat(v), payout) for m, v in oof.items()}
    res["walk_forward_folds"] = wf

    breakdown = breakdowns(test, {m: sel_test[m] for m in ("A", "B", "C", "D")}, payout, rules)

    # ---- export (models whose threshold is None are still exported: the engine then reports "no validated threshold" and never trades with them)
    exported = {}
    for k in KINDS:
        fp = fps[k]
        if not fp:
            continue
        spec = M.export_spec(fp["model"], fp["cal"], fp["thr"], fp["note"], used_ind if k == "D" else [], {"validation_calibrated": cmp_models[k]["validation_calibrated"], "test": cal_rep[k]})
        raw_py = M.predict_raw(fp["model"], test[fp["names"]].to_numpy(float))[:500]
        rr, pp = M.predict_spec(spec, test[fp["names"]].to_numpy(float)[:500])
        assert np.allclose(raw_py, rr, atol=1e-9), f"export of model {k} does not reproduce the trained model"
        exported[k] = spec
    bundle = {"schema": "quantum-hybrid-model/1", "createdAt": pd.Timestamp.now("UTC").isoformat(), "synthetic": synthetic, "instruments": insts, "payout": round(payout, 4),
              "data": {"rows": len(df), "from": int(df.signal_time.min()), "to": int(df.signal_time.max()), "splits": {"t_train_end": float(t1), "t_val_end": float(t2), "embargo_sec": emb, "train": len(train), "validation": len(val), "test": len(test)}},
              "models": exported, "recommendedGate": tuned,
              "notes": ["thresholds were chosen on the validation period only", "a model with threshold null found no validated edge and will not trade"] + (["TRAINED ON SYNTHETIC DATA: plumbing test only"] if synthetic else [])}
    bundle["modelId"] = hashlib.sha256(json.dumps(exported, sort_keys=True).encode()).hexdigest()[:12]
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    (out / "hybrid_model.json").write_text(json.dumps(bundle))

    # parity fixture for the TypeScript test
    fix = {}
    for k in KINDS:
        if k not in exported:
            continue
        rows = test.iloc[:: max(1, len(test) // 150)].head(150)
        raw = M.predict_raw(fps[k]["model"], rows[fps[k]["names"]].to_numpy(float))
        fix[k] = [{"features": {n: (None if not np.isfinite(r[n]) else float(r[n])) for n in fps[k]["names"]}, "raw": float(x), "probability": float(M.apply_calibration(np.array([x]), fps[k]["cal"])[0])} for (_, r), x in zip(rows.iterrows(), raw)]
    (out / "parity_fixture.json").write_text(json.dumps(fix))

    # ---- verdict (strict)
    verdict = {}
    for m, s in res["test"].items():
        lo = s["ev_ci"][0]
        verdict[m] = bool(s["trades"] >= 200 and lo is not None and lo > 0)
    report = {"synthetic": synthetic, "payout": payout, "breakeven_probability": be, "rows": {"all": len(df), "train": len(train), "validation": len(val), "test": len(test)},
              "split_times": {"train_end": float(t1), "validation_end": float(t2)}, "models": cmp_models, "thresholds": {k: (fps[k]["thr"] if fps[k] else None) for k in KINDS},
              "threshold_notes": {k: (fps[k]["note"] if fps[k] else "too few rows to fit") for k in KINDS}, "tuned_gate": tuned, "gate_grid": tune_rows,
              "results": res, "test_breakdown": breakdown, "comparisons_tried": tried, "edge_demonstrated_on_test": verdict, "seconds": round(time.time() - t0, 1)}
    (out / "validation_report.json").write_text(json.dumps(report, indent=1, default=float))
    (out / "validation_report.md").write_text(render_md(report, meta, a))
    print((out / "validation_report.md").read_text())


def render_md(r, meta, a):
    L = []
    if r["synthetic"]:
        L += ["> **SYNTHETIC DATA.** These numbers test the machinery. They say nothing about any real market and must not be read as evidence of profitability.", ""]
    L += ["# Hybrid engine validation report", "",
          f"Payout {r['payout']:.3f} (break-even win probability {r['breakeven_probability']:.4f}). Rows: {r['rows']}. Chronological split with a {a.embargo_candles}-candle embargo; the test block was not used for any choice.",
          f"Number of models, thresholds and gate settings compared while building this: **{r['comparisons_tried']}** (a good-looking number among many comparisons can be luck).", "",
          "## Results by mode (identical setups, one open trade per instrument)", "", "A = candlestick only, B = + indicator gate, B_tuned = gate settings chosen on validation, C = + model (no indicator inputs), D = full hybrid.", ""]
    for seg in ("validation", "test") + (("walk_forward_oof",) if "walk_forward_oof" in r["results"] else ()):
        L += [f"### {seg.replace('_', ' ')}" + (" (out of sample, untouched)" if seg == "test" else " (thresholds were chosen here: in-sample for them)" if seg == "validation" else " (every fold trained only on its past)"), "",
              "| mode | trades | win rate [95% CI] | EV per unit stake [95% CI] | total | max drawdown | vs break-even |", "|---|---|---|---|---|---|---|"]
        for m, s in r["results"][seg].items():
            L.append(f"| {m} " + fmt(s))
        L.append("")
    L += ["## Probability models", ""]
    for k, v in r["models"].items():
        t = v["test"]; b = v["logistic_baseline_test"]
        L += [f"**Model {k}**: selected `{v['selected']}` {v['params']}. Threshold: {r['thresholds'][k]} ({r['threshold_notes'][k]})", "",
              "| on test | AUC | Brier (base-rate Brier) | log loss | ECE |", "|---|---|---|---|---|",
              f"| selected | {t['auc']:.4f} | {t['brier']:.5f} ({t['brier_baseline']:.5f}) | {t['logloss']:.5f} | {t['ece']:.4f} |",
              f"| logistic baseline | {b['auc']:.4f} | {b['brier']:.5f} ({b['brier_baseline']:.5f}) | {b['logloss']:.5f} | {b['ece']:.4f} |", "",
              "Reliability (test): " + "; ".join(f"{x['mean_predicted']:.3f}->{x['observed_win_rate']:.3f} (n={x['n']})" for x in t["reliability"]), ""]
    L += ["## Walk-forward folds (train+validation period only)", "", "| fold | rows | A trades/EV | B | C | D | thresholds C/D |", "|---|---|---|---|---|---|---|"]
    ev = lambda s: f"{s['trades']} / {s['ev']:+.3f}" if s["trades"] else "0 / -"
    for f in r["results"].get("walk_forward_folds", []):
        L.append(f"| {f['fold']} | {f['rows']} | {ev(f['A'])} | {ev(f['B'])} | {ev(f['C'])} | {ev(f['D'])} | {f['thresholds']['C']} / {f['thresholds']['D']} |")
    L += ["", "## Test performance by pattern and market condition (modes A and D)", ""]
    for m in ("A", "D"):
        for k, groups in r["test_breakdown"][m].items():
            L += [f"**{m} by {k}**", "", "| group | trades | win rate | EV | total | max DD | vs break-even |", "|---|---|---|---|---|---|---|"]
            for g, s in groups.items():
                L.append(f"| {g} " + fmt(s))
            L.append("")
    L += ["## Verdict", ""]
    ok = [m for m, v in r["edge_demonstrated_on_test"].items() if v]
    L.append(("Modes with an expectancy confidence interval entirely above zero on the untouched test block (>= 200 trades): " + ", ".join(ok) + ". One test block is still one sample: confirm on a later period before risking money.") if ok else
             "**No mode shows a demonstrable positive expectancy on the untouched test block** (the 95% interval of the expectancy includes zero or there were fewer than 200 trades). Do not trade this model on this evidence.")
    L += ["", "Limits: slippage, requotes, rejections and payout changes are not modelled; one trade at a time per instrument; instruments are correlated; a model that earned nothing on validation exports threshold `null` and never trades."]
    return "\n".join(L)


if __name__ == "__main__":
    main()
