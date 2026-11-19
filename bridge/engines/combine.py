"""
Combines the engines. They never overlap: each one only reads candles and returns its own verdict.

  DEFAULT (confirmed mode): THE INDICATOR STRATEGY creates the setup. Stochastic (14,3,3) + RSI (14) decide WHEN (indicator_engine.py).
  When they confirm a new direction on the newest closed candle, the engine looks BACK over the last CONFIRM_LOOKBACK candles for a candle pattern
  pointing the same way: the sweep engine or the candlestick-pattern engine (both kept exactly as they were). No pattern = no setup.
  Engines that agree raise the confidence; a pattern pointing the other way is ignored (only same-direction patterns confirm).

  STRATEGY_MODE=legacy: every engine may trigger on its own again (sweep, indicator trigger, candlestick pattern), as before.

Candles passed in must be CLOSED candles, oldest first: [{time,open,high,low,close}, ...].
"""
from __future__ import annotations
import os, time as _time
from . import sweep_engine as SW, indicator_engine as IN, candlestick_engine as CS

MIN_CANDLES = 140          # warm-up so the RSI has settled
IND_LOOKBACK = 1           # legacy mode only: an indicator vote may be 1 candle older than the sweep candle
CONFIRM_LOOKBACK = int(os.environ.get("STOCHRSI_CONFIRM_LOOKBACK", "5") or 5)   # candles (ending on the trigger candle) in which a candle pattern must exist


def _legacy():
    return os.environ.get("STRATEGY_MODE", "").lower() == "legacy"


def _closed(candles, tf, now):
    if now is None:
        now = _time.time()
    if candles and candles[-1]["time"] >= int(now // tf * tf):
        return candles[:-1]
    return candles


def evaluate(candles, tf=60, min_ind=1, now=None, drop_forming=True):
    cs = _closed(candles, tf, now) if drop_forming else list(candles)
    out = {"setup": False, "side": None, "confidence": 0, "agree": 0, "candles": len(cs),
           "sweep": None, "indicators": None, "pattern": None, "reasons": [], "status": "watching"}
    if len(cs) < MIN_CANDLES:
        out["status"] = f"need {MIN_CANDLES} candles, have {len(cs)}"
        return out
    last = len(cs) - 1
    t = lambda c: str(c["time"])

    # ---- 1. sweep engine (boss)
    sw_c = [SW.Candle(t(c), c["open"], c["high"], c["low"], c["close"]) for c in cs]
    sg = SW.check(sw_c, last, SW.Params())
    if sg:
        out["sweep"] = {"side": sg.side, "reasons": sg.reasons[:4]}

    # ---- 2. indicator engine (stateful: replay, keep the newest votes)
    ie = IN.Engine(IN.Params())
    ind = None
    for k, c in enumerate(cs):
        s = ie.update(IN.Candle(t(c), c["open"], c["high"], c["low"], c["close"]))
        if s and k >= last - (IND_LOOKBACK if _legacy() else 0):
            ind = s    # newest wins (default mode: the trigger must complete on the newest closed candle)
    if ind:
        out["indicators"] = {"side": ind.side, "strategies": list(ind.strategies), "count": len(ind.strategies),
                             "info": ind.info}

    # ---- 3. candlestick engine
    ce = CS.Engine(CS.Params(trade_neutral=False))   # doji / inside-bar style patterns carry no direction of their own
    pat = None; pats = []
    for k, c in enumerate(cs):
        s = ce.update(CS.Candle(t(c), c["open"], c["high"], c["low"], c["close"]))
        if s and k >= last - max(IND_LOOKBACK, CONFIRM_LOOKBACK - 1):
            pats.append((k, s))
        if s and k >= last - IND_LOOKBACK:
            pat = s
    if pat:
        out["pattern"] = {"side": pat.side, "patterns": list(pat.patterns), "stop": pat.stop, "counted": False}

    # ---- DEFAULT: the indicator trigger + a candle pattern in the last candles, same direction
    if not _legacy():
        out["trigger"] = bool(ind)
        if not ind:
            out["status"] = "waiting for the Stochastic + RSI trigger"
            out["sweep"] = None; out["pattern"] = None
            return out
        side = ind.side
        out["indicators"] = {"side": side, "strategies": list(ind.strategies), "count": len(ind.strategies), "info": ind.info}
        confs = []
        for k in range(last, last - CONFIRM_LOOKBACK, -1):
            sgk = SW.check(sw_c, k, SW.Params()) if k >= 1 else None
            if sgk and sgk.side == side:
                confs.append({"engine": "sweep", "index": k, "age": last - k, "note": "; ".join(sgk.reasons[:2])})
        for k, ps in pats:
            if ps.side == side and last - k < CONFIRM_LOOKBACK:
                confs.append({"engine": "candlestick", "index": k, "age": last - k, "note": ", ".join(ps.patterns[:3])})
        out["sweep"] = {"side": side, "reasons": [c["note"]]} if (c := next((x for x in confs if x["engine"] == "sweep"), None)) else None
        cp = next((x for x in confs if x["engine"] == "candlestick"), None)
        out["pattern"] = {"side": side, "patterns": cp["note"].split(", "), "stop": None, "counted": True} if cp else None
        if not confs:
            out["status"] = f"Stochastic + RSI triggered {side} but no candle pattern confirms it in the last {CONFIRM_LOOKBACK} candles"
            out["reasons"] = [out["status"]]
            return out
        kinds = {c["engine"] for c in confs}
        out.update(setup=True, side=side, agree=1 + len(kinds), confidence=min(85, 70 + 5 * (len(kinds) - 1)), status="setup",
                   engines=sorted({"ind"} | ({"sweep"} if "sweep" in kinds else set()) | ({"pat"} if "candlestick" in kinds else set())),
                   confirmations=confs,
                   reasons=[f"Stochastic + RSI ({side}): " + ", ".join(ind.strategies)] + [f"candle confirmation ({side}): {c['engine']} - {c['note']}" for c in confs[:3]])
        return out

    # ---- decision: any engine may trigger a trade; agreement between engines raises the confidence
    sides = {}
    if sg: sides["sweep"] = sg.side
    if ind: sides["ind"] = ind.side
    if pat: sides["pat"] = pat.side
    if not sides:
        out["status"] = "no engine sees a setup on the newest candle"
        return out
    conflict = ""
    if len(set(sides.values())) > 1:
        if "sweep" not in sides:
            out["status"] = "indicators and candle pattern point in opposite directions, standing aside"
            return out
        # the sweep is the boss: it keeps its side, but opposing engines pull the confidence below the usual bar
        opp = [k for k, v in sides.items() if v != sides["sweep"]]
        conflict = "+".join(opp)
        sides = {k: v for k, v in sides.items() if v == sides["sweep"]}
        if ind and ind.side != sg.side: ind = None
        if pat and pat.side != sg.side: pat = None; out["pattern"]["counted"] = False
    side = next(iter(sides.values()))
    n_ind = len(ind.strategies) if ind else 0
    if "ind" in sides and "sweep" not in sides and n_ind < min_ind and len(sides) == 1:
        out["status"] = f"only {n_ind}/{min_ind} indicator strategies, not enough on their own"
        return out
    kinds = set(sides)
    if kinds == {"sweep", "ind", "pat"}:
        conf = 80 + 3 * (n_ind - 1)
    elif kinds == {"sweep", "ind"}:
        conf = 72 + 4 * (n_ind - 1)                  # the high-probability pair
    elif kinds == {"ind", "pat"}:
        conf = 68 + 3 * (n_ind - 1)
    elif kinds == {"sweep", "pat"}:
        conf = 66
    elif kinds == {"sweep"}:
        conf = 62
    elif kinds == {"ind"}:
        conf = 60 + 4 * (n_ind - 1)
    else:
        conf = 56 + 2 * (pat.score - 1)              # a pattern alone is the weakest trigger
    reasons = []
    if conflict:
        conf = 56
        reasons.append(f"opposed by: {conflict} (confidence reduced)")
    if sg: reasons.append(f"liquidity sweep ({side}): " + "; ".join(sg.reasons[:2]))
    if ind: reasons.append(f"{n_ind} indicator strategies agree: " + ", ".join(ind.strategies))
    if pat:
        out["pattern"]["counted"] = True
        reasons.append("candlestick pattern: " + ", ".join(pat.patterns[:3]))
    out.update(setup=True, side=side, agree=len(kinds), confidence=min(conf, 92), reasons=reasons,
               status="setup", engines=sorted(kinds))
    return out
