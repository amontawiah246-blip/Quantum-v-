"""
THE INDICATOR STRATEGY: Stochastic oscillator + RSI, used as the TRIGGER (it replaces the old S1..S7 indicator strategies).
A candle pattern must then confirm it (see combine.py).  Python twin of src/stochRsi.ts: same parameters, same rules.

  BUY  : Stochastic %K (14,3,3) crosses UP through 20  AND  RSI(14) crosses UP through 30 or through 50
  SELL : Stochastic %K (14,3,3) crosses DOWN through 80 AND RSI(14) crosses DOWN through 70 or through 50

The two crossings may be up to `align_window` candles apart; the signal fires on the candle where the SECOND one completes.
A same-side signal is not repeated inside the window.  Closed candles only; nothing after the current candle is read.

Usage (live):  eng = Engine(); sig = eng.update(Candle(t,o,h,l,c))
Usage (batch): python indicator_engine.py candles.csv
"""
from __future__ import annotations
import csv, os, sys
from collections import deque
from dataclasses import dataclass, field


def _env_int(name, default, lo, hi):
    try:
        v = int(os.environ.get(name, ""))
        return v if lo <= v <= hi else default
    except ValueError:
        return default


@dataclass
class Candle:
    t: str
    o: float
    h: float
    l: float
    c: float


@dataclass
class Params:
    k_period: int = 14
    k_smooth: int = 3
    d_smooth: int = 3
    rsi_period: int = 14
    oversold: float = 20.0
    overbought: float = 80.0
    rsi_buy_levels: tuple = (30.0, 50.0)
    rsi_sell_levels: tuple = (70.0, 50.0)
    align_window: int = field(default_factory=lambda: _env_int("STOCHRSI_ALIGN_WINDOW", 3, 1, 6))
    warmup: int = 50
    min_votes: int = 1            # kept so older callers that pass it still work; the strategy has exactly one trigger


@dataclass
class Signal:
    index: int
    side: str
    strategies: list
    entry: float
    info: dict = field(default_factory=dict)


class Engine:
    def __init__(self, params: Params | None = None):
        self.P = params or Params()
        self.i = -1
        self.hi, self.lo = deque(maxlen=self.P.k_period), deque(maxlen=self.P.k_period)
        self.raw = deque(maxlen=self.P.k_smooth)
        self.kv = deque(maxlen=2)          # last two %K values (current is the right-hand one)
        self.dq = deque(maxlen=self.P.d_smooth)
        self.prev_close = None
        self.n_rsi = 0; self.ag = self.al = 0.0; self.rsi = None; self.rsi_prev = None
        self.ev = {"BUY": {"stoch": None, "rsi": None, "fired": -99}, "SELL": {"stoch": None, "rsi": None, "fired": -99}}

    def _rsi_update(self, close):
        n = self.P.rsi_period
        self.rsi_prev = self.rsi
        if self.prev_close is None:
            self.prev_close = close; return
        ch = close - self.prev_close; self.prev_close = close
        up, dn = max(ch, 0.0), max(-ch, 0.0)
        self.n_rsi += 1
        if self.n_rsi <= n:
            self.ag += up / n; self.al += dn / n          # simple average of the first n changes
            if self.n_rsi < n: return
        else:
            self.ag = (self.ag * (n - 1) + up) / n; self.al = (self.al * (n - 1) + dn) / n
        self.rsi = (50.0 if self.ag == 0 else 100.0) if self.al == 0 else 100 - 100 / (1 + self.ag / self.al)

    def update(self, c: Candle):
        P = self.P
        self.i += 1; i = self.i
        self.hi.append(c.h); self.lo.append(c.l)
        self._rsi_update(c.c)
        k_prev = self.kv[-1] if self.kv else None
        k = None
        if len(self.hi) == P.k_period:
            hh, ll = max(self.hi), min(self.lo)
            self.raw.append(100 * (c.c - ll) / (hh - ll) if hh > ll else 50.0)
            if len(self.raw) == P.k_smooth:
                k = sum(self.raw) / P.k_smooth
        self.kv.append(k)
        if k is not None:
            self.dq.append(k)
        # ---- the crossings on THIS candle
        k_prev = self.kv[0] if len(self.kv) == 2 else None
        r_prev, r = self.rsi_prev, self.rsi
        if k is not None and k_prev is not None:
            if k_prev < P.oversold <= k: self.ev["BUY"]["stoch"] = (i, k_prev, k, P.oversold)
            if k_prev > P.overbought >= k: self.ev["SELL"]["stoch"] = (i, k_prev, k, P.overbought)
        if r is not None and r_prev is not None:
            hit = sorted((L for L in P.rsi_buy_levels if r_prev < L <= r), reverse=True)
            if hit: self.ev["BUY"]["rsi"] = (i, r_prev, r, hit[0])
            hit = sorted(L for L in P.rsi_sell_levels if r_prev > L >= r)
            if hit: self.ev["SELL"]["rsi"] = (i, r_prev, r, hit[0])
        if i < P.warmup:
            return None
        fired = []
        for side in ("BUY", "SELL"):
            e = self.ev[side]; st, rs = e["stoch"], e["rsi"]
            if not st or not rs: continue
            if i - st[0] >= P.align_window or i - rs[0] >= P.align_window: continue
            if max(st[0], rs[0]) != i: continue                       # the second crossing completes on THIS candle
            if i - e["fired"] < P.align_window: continue              # already fired a moment ago: not a new direction
            fired.append(side)
        if len(fired) != 1:
            return None
        side = fired[0]; e = self.ev[side]; e["fired"] = i
        st, rs = e["stoch"], e["rsi"]
        up = "up" if side == "BUY" else "down"
        d = sum(self.dq) / len(self.dq) if self.dq else None
        return Signal(i, side, [f"Stochastic %K cross {up} through {st[3]:g}", f"RSI cross {up} through {rs[3]:g}"], c.c,
                      {"k": round(st[2] if st[0] == i else k, 1), "d": None if d is None else round(d, 1), "rsi": round(r, 1),
                       "stoch_index": st[0], "rsi_index": rs[0], "stoch_level": st[3], "rsi_level": rs[3]})


def run(cs, params=None):
    e = Engine(params)
    return [s for c in cs if (s := e.update(c))]


def binary_backtest(cs, sigs, expiries=(1, 2, 3, 4, 5), payout=0.92, show=True):
    out = {}
    for n in expiries:
        w = l = 0
        for s in sigs:
            j = s.index + n
            if j >= len(cs): continue
            d = cs[j].c - s.entry
            win = d > 0 if s.side == "BUY" else d < 0
            loss = d < 0 if s.side == "BUY" else d > 0
            if not (win or loss): continue
            w += win; l += loss
        t = w + l; wr = w / t if t else 0
        out[n] = (t, wr)
        if show:
            print(f"expiry {n}: trades={t:5d} winrate={wr:6.1%} EV/unit={wr*payout-(1-wr):+.3f}  (breakeven {1/(1+payout):.1%})")
    return out


def load_csv(path):
    out = []
    with open(path) as f:
        for r in csv.DictReader(f):
            r = {k.lower(): v for k, v in r.items()}
            out.append(Candle(r.get("time") or r.get("epoch") or r.get("date") or "",
                              float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])))
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python indicator_engine.py candles.csv"); sys.exit(0)
    cs = load_csv(sys.argv[1]); sigs = run(cs)
    print(f"{len(cs)} candles, {len(sigs)} indicator triggers ({sum(s.side=='BUY' for s in sigs)} buy / {sum(s.side=='SELL' for s in sigs)} sell); no candle-pattern confirmation applied here\n")
    binary_backtest(cs, sigs)
