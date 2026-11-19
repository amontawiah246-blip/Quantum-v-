// Classic mode: you do NOT pick a market. Choose the time frame and the expiry, press AUTO SCAN: every market agent is called, the Stochastic + RSI strategy
// (confirmed by a candle pattern) is read on each one, the AI verifies the best setup, and the BUY / SELL signal appears with its chart.
// With AUTO on, the trade is placed the moment the signal is verified and followed (with MTG recovery) to its result; the chart under the signal follows the trade.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowLeft, ArrowUp, Clock, Percent, RefreshCw, ShieldAlert, Square } from "lucide-react";
import { apiFetch } from "./api";
import { Asset, splitName } from "./assets";
import { mtgPlan, MTG_DEFAULT_MULT, Side, summarize, TradeRec } from "./tradeSession";
import { runChain } from "./classicTrader";
import { StatTiles, TradeList } from "./TradeStats";
import { BROKER_EXPIRY_OPTIONS, BROKER_TIMEFRAME_OPTIONS } from "./globalConfig";
import { useGlobalTiming } from "./useGlobalTiming";

const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const beep = (up: boolean) => {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = "sine"; o.frequency.value = up ? 880 : 520; g.gain.value = 0.06; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.16);
    setTimeout(() => ctx.close(), 400);
  } catch { /* no audio */ }
};

const MULTS = [2, MTG_DEFAULT_MULT, 2.5];
const STEPS = ["Calling every market agent", "Stochastic + RSI trigger", "Candle-pattern confirmation", "Chart screenshot", "AI verification"];

/** the setup the scan found (scanServer.ts: Top) */
interface Found {
  symbol: string; label: string; side: "buy" | "sell"; confidence: number; verified: boolean;
  candidateId?: string; aiConfidence?: number | null; aiBasis?: string; explanation?: string; risk?: string | null; decision?: string | null;
  reasons?: string[]; tf?: number; expirySec?: number; signalCloseTime?: number; entry?: number; engines?: string[];
}
/** the trade placed for it, kept so the chart can show the entry window and the result */
interface Placed { candidateId: string; entryTime: number; entryPrice: number; expiry: number; result: "pending" | "win" | "loss" | "draw" | "error" }

interface Props {
  http: string; wsBase: string; assets: Asset[]; asset: string; setAsset: (s: string) => void;
  balance?: number | null; isDemo?: boolean; ready: boolean; onToast: (m: string) => void; onExit: () => void;
}

export default function ClassicMode({ http, assets, balance, isDemo, ready, onToast, onExit }: Props) {
  const { timing, updateTiming } = useGlobalTiming(http);
  const tf = timing.tfSec;
  const expiry = timing.expirySec;

  const [mtgStep, setMtgStep] = useState<number>(() => store.get("qx-cl-mtg", 2));
  const [mult, setMult] = useState<number>(() => store.get("qx-cl-mult", MTG_DEFAULT_MULT));
  const [auto, setAuto] = useState<boolean>(() => store.get("qx-cl-auto", false));
  const [stake, setStake] = useState<string>(() => String(store.get("qx-cl-stake", 10)));
  useEffect(() => { store.set("qx-cl-mtg", mtgStep); store.set("qx-cl-mult", mult); store.set("qx-cl-auto", auto); }, [mtgStep, mult, auto]);

  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [sg, setSg] = useState<Found | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [chartTick, setChartTick] = useState(0);
  const [trading, setTrading] = useState(false);
  const [recs, setRecs] = useState<TradeRec[]>(() => store.get("qx-classic-trades", []));
  const [now, setNow] = useState(() => Date.now());

  const scanId = useRef(0);
  const cancel = useRef(false);
  const alive = useRef(true);
  const autoRef = useRef(auto); autoRef.current = auto;
  const reported = useRef(new Set<string>());
  const balRef = useRef(balance ?? null); balRef.current = balance ?? null;
  const realOk = useRef(false);
  const startScanRef = useRef<() => void>(() => {});

  useEffect(() => {
    alive.current = true;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive.current = false; clearInterval(id); scanId.current++; cancel.current = true; void fetch(`${http}/api/scan/stop`, { method: "POST" }).catch(() => {}); };
  }, [http]);

  const stakeNum = Math.max(0, parseFloat(stake) || 0);
  const plan = mtgPlan(stakeNum, { on: mtgStep > 0, steps: mtgStep, mult });
  const summary = useMemo(() => summarize(recs), [recs]);

  // ---- trade records (saved on this device, and every finished trade is added to the Account history)
  const upsert = useCallback((r: TradeRec) => {
    setRecs((cur) => {
      const i = cur.findIndex((x) => x.id === r.id);
      const next = (i >= 0 ? cur.map((x) => (x.id === r.id ? r : x)) : [r, ...cur]).slice(0, 100);
      store.set("qx-classic-trades", next);
      return next;
    });
    if ((r.result === "win" || r.result === "loss") && !reported.current.has(r.id)) {
      reported.current.add(r.id);
      fetch(`${http}/api/history/add`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ market: r.label, side: r.side, result: r.result, profit: r.profit, time: Date.now() }) }).catch(() => {});
    }
  }, [http]);

  // a trade that was still running when the app was closed: ask the broker what happened to it
  useEffect(() => {
    const stale = recs.filter((r) => r.result === "pending" && r.contract && Date.now() > r.ts + r.seconds * 1000);
    stale.forEach(async (r) => {
      try {
        const d = await (await fetch(`${http}/api/trade-result?broker=deriv&id=${encodeURIComponent(r.contract!)}&seconds=20`)).json();
        if (d.status === "ok" && ["win", "loss", "draw"].includes(d.result)) upsert({ ...r, result: d.result, profit: d.profit ?? null });
        else upsert({ ...r, result: "error", note: "result not found" });
      } catch { /* try again next time */ }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tfOpt = BROKER_TIMEFRAME_OPTIONS.find((t) => t.sec === tf) ?? BROKER_TIMEFRAME_OPTIONS[0];
  const expOpt = BROKER_EXPIRY_OPTIONS.find((e) => e.sec === expiry) ?? { sec: expiry, label: `${expiry}s`, description: `${expiry}s` };

  // ---- place the trade (and its MTG recovery chain) for the found signal
  const trade = async (s: Found) => {
    if (trading) return;
    if (timing.transitioning) { onToast("Agents are synchronizing to the new timeframe — please wait."); return; }
    const side = s.side as Side, sym = s.symbol, label = splitName(assets.find((a) => a.symbol === sym) ?? { symbol: sym }).label || s.label;
    if (!(stakeNum > 0)) { onToast("Enter a stake first"); return; }
    if (isDemo === false && !realOk.current) {
      if (!window.confirm(`REAL account: this places a real-money ${side.toUpperCase()} on ${label}${mtgStep ? ` and up to ${mtgStep} MTG recovery steps (worst case $${plan.worstCase.toFixed(2)})` : ""}. Continue?`)) return;
      realOk.current = true;
    }
    const secs = expiry;
    setTrading(true); cancel.current = false;
    const entryTime = Math.floor(Date.now() / 1000);
    if (s.candidateId) setPlaced({ candidateId: s.candidateId, entryTime, entryPrice: s.entry ?? 0, expiry: secs, result: "pending" });
    onToast(`Placing ${side.toUpperCase()} on ${label} · $${stakeNum} · ${secs}s`);
    const payoutPct = assets.find((a) => a.symbol === sym)?.payout;
    const out = await runChain({
      place: async (sd, amount, sc) => {
        const r = await apiFetch(`${http}/api/trade`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            broker: "deriv",
            asset: sym,
            side: sd,
            amount,
            seconds: sc,
            meta: {
              mode: "classic",
              candidateId: s.candidateId,
              tf,
              label,
              reasons: s.reasons,
              explanation: s.explanation,
              aiConfidence: s.aiConfidence,
              aiBasis: s.aiBasis,
              engines: s.engines,
              entryPrice: s.entry ?? null,
              signalCandleOpen: s.signalCloseTime ? s.signalCloseTime - tf : null,
            },
          }),
        });
        let d: any = {};
        try { d = await r.json(); } catch { /* non-JSON body */ }
        return { ok: d.status === "ok" && !!d.id, msg: d.msg || (!r.ok ? `Broker returned HTTP ${r.status}` : ""), id: d.id ? String(d.id) : undefined };
      },
      result: async (id, sc) => {
        await sleep(sc * 1000 + 800);                                   // let the trade run out first
        for (let i = 0; i < 3 && alive.current; i++) {
          try {
            const d = await (await fetch(`${http}/api/trade-result?broker=deriv&id=${encodeURIComponent(id)}&seconds=90`)).json();
            if (d.status === "ok" && ["win", "loss", "draw"].includes(d.result)) { beep(d.result === "win"); return { outcome: d.result, profit: typeof d.profit === "number" ? d.profit : null }; }
          } catch { /* retry */ }
        }
        return null;
      },
      onRec: (r) => { if (alive.current) upsert(r); else store.set("qx-classic-trades", [r, ...store.get<TradeRec[]>("qx-classic-trades", []).filter((x) => x.id !== r.id)]); },
      balance: () => balRef.current,
      cancelled: () => cancel.current,
    }, { symbol: sym, label, side, stake: stakeNum, seconds: secs, tf, mtg: { on: mtgStep > 0, steps: mtgStep, mult }, payout: payoutPct });
    if (!alive.current) return;
    setTrading(false);
    // the chart under the signal now shows the result (the first trade of the chain is the one the signal made)
    const first = out.final === "cancelled" ? null : out.final;
    setPlaced((p) => (p ? { ...p, result: first === "win" ? "win" : first === "loss" ? "loss" : first === "error" ? "error" : p.result } : p));
    setChartTick((t) => t + 1);
    if (out.final === "win") onToast(`WIN ${out.steps ? `after MTG ${out.steps} ` : ""}(${out.pnl >= 0 ? "+" : ""}$${out.pnl.toFixed(2)})`);
    else if (out.final === "loss") onToast(`LOSS (${out.pnl >= 0 ? "+" : "-"}$${Math.abs(out.pnl).toFixed(2)})${out.message && out.message !== "loss" ? " · " + out.message : ""}`);
    else if (out.final === "error") { setErr(out.message || "Trade failed"); onToast(out.message || "Trade failed"); }
    else if (out.final === "cancelled") onToast("Stopped. No more MTG steps will be placed.");
    // AUTO keeps scanning for the next setup once this trade is finished
    if (autoRef.current && alive.current && out.final !== "cancelled" && out.final !== "error") setTimeout(() => { if (autoRef.current && alive.current) startScanRef.current(); }, 2500);
  };

  // ---- AUTO SCAN: call every agent, wait for a setup the AI verifies
  const startScan = useCallback(async () => {
    if (trading || scanning) return;
    if (!ready) { onToast("Deriv is not connected yet. Check the API screen."); return; }
    if (timing.transitioning) { onToast("Agents are synchronizing to the new timeframe — please wait."); return; }
    const my = ++scanId.current;
    setErr(""); setSg(null); setPlaced(null); setScanning(true); setStep(0); setScanMsg("Starting the market agents…");
    const stepper = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 2200);
    try {
      const r = await fetch(`${http}/api/scan/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broker: "deriv", tfSec: tf, expirySec: expiry, minPayout: 0, auto: autoRef.current }) });
      const d = await r.json();
      if (d.status !== "ok") { setErr(d.msg || "Could not start the scan"); setScanning(false); return; }
      for (;;) {
        await sleep(1500);
        if (my !== scanId.current || !alive.current) return;
        let st: any = null;
        try { st = await (await fetch(`${http}/api/scan/state`)).json(); } catch { continue; }
        setScanMsg(st.message || "");
        if (st.found && st.best) {
          const f = st.best as Found;
          setSg(f); setScanning(false); beep(f.side === "buy");
          if (autoRef.current) void trade(f);
          return;
        }
        if (!st.running && !st.found) { setErr(st.message || "The scan stopped"); setScanning(false); return; }
      }
    } catch { if (my === scanId.current) { setErr("Could not reach the server"); setScanning(false); } }
    finally { clearInterval(stepper); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [http, tf, expiry, ready, timing.transitioning, trading, scanning, assets, stakeNum, mtgStep, mult, isDemo]);
  startScanRef.current = () => { void startScan(); };

  const stopScan = () => { scanId.current++; setScanning(false); void fetch(`${http}/api/scan/stop`, { method: "POST" }).catch(() => {}); };
  const stopTrading = () => { cancel.current = true; setAuto(false); stopScan(); onToast("Stopping: the trade already placed will finish, but no more MTG steps are placed and scanning stops."); };
  const resetStats = () => { setRecs([]); store.set("qx-classic-trades", []); };

  // the chart under the signal: the setup chart before the trade, the same chart with the trade window and the result after it
  useEffect(() => {
    if (!placed || placed.result !== "pending") return;
    const id = setInterval(() => setChartTick((t) => t + 1), 20000);       // new candles appear while the trade runs
    return () => clearInterval(id);
  }, [placed]);
  const chartSrc = useMemo(() => {
    if (!sg?.candidateId) return "";
    const q = new URLSearchParams();
    if (placed && placed.candidateId === sg.candidateId && placed.entryPrice > 0) {
      q.set("entryTime", String(placed.entryTime)); q.set("entryPrice", String(placed.entryPrice)); q.set("expiry", String(placed.expiry));
      if (placed.result === "win" || placed.result === "loss" || placed.result === "draw") q.set("result", placed.result);
    }
    q.set("_", String(chartTick));
    return `${http}/api/classic/chart/${encodeURIComponent(sg.candidateId)}?${q.toString()}`;
  }, [http, sg?.candidateId, placed, chartTick]);

  const side = sg?.side ?? null;
  const stateText = trading ? "TRADING" : scanning ? "SCANNING" : "READY";
  const syncTotal = timing.requiredAgents.length;
  const syncDone = timing.syncedAgents.length;
  const payout = sg ? assets.find((a) => a.symbol === sg.symbol)?.payout : undefined;
  const conf = sg ? (sg.aiConfidence ?? null) : null;
  const when = (e?: number) => { if (!e) return "next candle open"; const d = new Date(e * 1000); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}${tf < 60 ? ":" + String(d.getUTCSeconds()).padStart(2, "0") : ""} UTC`; };
  const wins = summary.wins ?? 0, losses = summary.losses ?? 0;
  const winRate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0;

  return (
    <div className="qm">
      <div className="qm-head">
        <button className="qm-back" onClick={() => { stopScan(); onExit(); }} aria-label="Back"><ArrowLeft size={20} /></button>
        <div><h1>Signal Generator</h1><p className={`qm-status ${trading || scanning || timing.transitioning ? "busy" : "ok"}`}><i />{timing.transitioning ? `SYNCING ${syncDone}/${syncTotal}` : stateText}</p></div>
        <span className={`qm-acct ${isDemo === false ? "real" : ""}`}>{isDemo === false ? "REAL" : "DEMO"}{balance != null && <b>${balance.toFixed(2)}</b>}</span>
      </div>

      <div className="qm-card gc big">
        <div className="qm-2">
          <div className="qm-tile"><span className="qm-tico"><Clock size={20} /></span><div><small>TIME FRAME / EXPIRY</small><b>{tfOpt.label} / {expOpt.label}</b><em>every agent reads the {tfOpt.label} chart</em></div></div>
          <div className="qm-tile"><span className="qm-tico"><Percent size={20} /></span><div><small>STRATEGY</small><b>Stoch + RSI</b><em>+ candle pattern</em></div></div>
        </div>

        <h4 className="qm-lbl">TIME FRAME (ALL AGENTS)</h4>
        <div className="qm-chips">{BROKER_TIMEFRAME_OPTIONS.map((t) => <button key={t.sec} className={tf === t.sec ? "on" : ""} disabled={trading || scanning} onClick={() => { void updateTiming({ tfSec: t.sec }).then((r) => { if (!r.ok) onToast(r.error || "Timeframe update failed"); }); }}>{t.label}</button>)}</div>

        <h4 className="qm-lbl">TRADE EXPIRY</h4>
        <div className="qm-chips">
          {BROKER_EXPIRY_OPTIONS.map((e) => <button key={e.sec} className={expiry === e.sec ? "on" : ""} disabled={trading || scanning} onClick={() => { void updateTiming({ expirySec: e.sec }).then((r) => { if (!r.ok) onToast(r.error || "Expiry update failed"); }); }}>{e.label}</button>)}
        </div>
        <p className="qm-hint">
          {timing.transitioning
            ? `Switching the agents to ${tfOpt.label} (${syncDone}/${syncTotal} ready). Scanning starts when all of them confirm.`
            : `No pair to choose: every market agent is called. They read the ${tfOpt.label} chart and the trade uses a ${expOpt.label} expiry.`}
        </p>

        <h4 className="qm-lbl">MTG STEP</h4>
        <div className="qm-chips four">{[0, 1, 2, 3].map((n) => <button key={n} className={mtgStep === n ? "on" : ""} disabled={trading} onClick={() => setMtgStep(n)}>{n === 0 ? "None" : `${n} Step${n > 1 ? "s" : ""}`}</button>)}</div>
        {mtgStep > 0 && (
          <>
            <div className="qm-chips mult"><small>Stake multiplier</small>{MULTS.map((m) => <button key={m} className={mult === m ? "on" : ""} disabled={trading} onClick={() => setMult(m)}>×{m}</button>)}</div>
            <p className="qm-hint warn"><ShieldAlert size={14} /><span>After a loss the same side is re-entered with stakes {plan.stakes.map((s) => `$${s}`).join(" → ")}. If every step loses you lose <b>${plan.worstCase.toFixed(2)}</b>.</span></p>
          </>
        )}

        <div className="qm-stakerow">
          <label><small>STAKE ($)</small><input inputMode="decimal" value={stake} disabled={trading} onChange={(e) => { setStake(e.target.value); const n = parseFloat(e.target.value); if (n > 0) store.set("qx-cl-stake", n); }} /></label>
          <button className={`qm-auto ${auto ? "on" : ""}`} role="switch" aria-checked={auto} disabled={trading} onClick={() => setAuto((a) => !a)}>
            <span className="qm-sw"><i /></span><span><b>AUTO TRADE</b><small>{auto ? "Places the trade the moment a signal is verified, then scans again" : "Signal only, you place the trade"}</small></span>
          </button>
        </div>

        {trading
          ? <button className="qm-go stop" onClick={stopTrading}><Square size={18} fill="currentColor" /> STOP AFTER THIS TRADE</button>
          : scanning
            ? <button className="qm-go stop" onClick={stopScan}><Square size={18} fill="currentColor" /> STOP SCAN</button>
            : <button className="qm-go" disabled={timing.transitioning} onClick={() => void startScan()}><RefreshCw size={19} /> {timing.transitioning ? "SYNCING AGENTS…" : auto ? "AUTO SCAN & TRADE" : "AUTO SCAN"}</button>}
      </div>

      {(scanning || sg || err) && (
        <div className={`qm-card result ${side ? "gc" : ""} ${side ?? ""}`}>
          {scanning && (
            <div className="qm-an"><div className="qm-radar"><i /><i /><i /><Activity size={26} /></div><h3>Scanning every market on the {tfOpt.label} chart</h3>
              <p className="qm-muted center">{scanMsg}</p>
              <ul>{STEPS.map((s, i) => <li key={s} className={i < step ? "ok" : i === step ? "now" : ""}>{i < step ? "✓" : i === step ? "●" : "○"} {s}</li>)}</ul>
              <p className="qm-hint">The indicators confirm on a candle close, so the scan waits for the next one. It keeps listening until a setup passes the AI check.</p></div>
          )}
          {!scanning && err && <div className="qm-empty"><h3>{sg ? "Trade error" : "Scan stopped"}</h3><p>{err}</p></div>}
          {!scanning && sg && side && (
            <div className="qm-out">
              <div className="qm-call">
                <span className="qm-arrow">{side === "buy" ? <ArrowUp size={34} strokeWidth={3} /> : <ArrowDown size={34} strokeWidth={3} />}</span>
                <div><strong>{side === "buy" ? "BUY" : "SELL"} · {sg.label}</strong><small>{tfOpt.label} chart · {expOpt.label} expiry · entry {when(sg.signalCloseTime)}</small></div>
                <div className="qm-conf">{conf != null ? <><b>{conf}%</b><small>AI confidence</small></> : <><b>{sg.confidence}</b><small>engine agreement</small></>}</div>
              </div>
              <div className="qm-eng">
                <span className="on">Stochastic cross</span><span className="on">RSI cross</span>
                <span className="on">Candle pattern</span>
                <span className={sg.verified ? "on" : "off"}>{sg.decision === "VALID_WITH_RISK" ? "Valid with risk" : sg.decision === "AI_UNAVAILABLE" ? "AI unavailable" : sg.verified ? "AI verified" : "Not verified"}</span>
              </div>
              {sg.aiBasis && <p className="qm-hint">AI confidence rests on: {sg.aiBasis}</p>}
              {sg.explanation && <p className="qm-hint">{sg.explanation}</p>}

              {/* THE CHART UNDER THE SIGNAL: before the trade (entry arrow) and after it (trade window + WIN / LOSS) */}
              {chartSrc && (
                <figure className="qm-chart">
                  <div className="qm-chart-top"><span>{sg.label} · {tfOpt.label}</span><b className={placed?.result === "win" ? "win" : placed?.result === "loss" ? "loss" : ""}>{placed ? (placed.result === "pending" ? "TRADE RUNNING" : placed.result.toUpperCase()) : `TRADE AT ${when(sg.signalCloseTime)} · EXPIRY ${expOpt.label}`}</b></div>
                  <img alt={`${sg.label} setup chart with Stochastic and RSI`} src={chartSrc} />
                  <div className="qm-chart-stats">
                    <span><small>PAYOUT</small><b>{payout ? `${payout}%` : "Live"}</b></span>
                    <span><small>MARTINGALE</small><b>{mtgStep ? `${mtgStep} Step${mtgStep > 1 ? "s" : ""}` : "None"}</b></span>
                    <span><small>WIN RATE</small><b>{winRate}%</b></span>
                    <span><small>W / L</small><b>{wins} / {losses}</b></span>
                  </div>
                </figure>
              )}

              {!sg.verified && <p className="qm-hint warn"><ShieldAlert size={14} /><span>Not traded: the AI did not verify this setup.</span></p>}
              {sg.verified && !auto && !trading && !placed && (
                <button className={`qm-go ${side}`} onClick={() => void trade(sg)}>{side === "buy" ? <ArrowUp size={18} /> : <ArrowDown size={18} />} PLACE {side.toUpperCase()} · ${stakeNum || 0}</button>
              )}
              {trading && <p className="qm-hint">Trade running. The result arrives automatically{mtgStep ? " and MTG recovery follows after a loss" : ""}.</p>}
              {!trading && !scanning && !auto && placed && <button className="qm-go" onClick={() => void startScan()}><RefreshCw size={19} /> SCAN AGAIN</button>}
              {Array.isArray(sg.reasons) && sg.reasons.length > 0 && <ul className="qm-why">{sg.reasons.slice(0, 5).map((r, i) => <li key={i}>{r}</li>)}</ul>}
            </div>
          )}
        </div>
      )}

      <div className="qm-card">
        <div className="qm-cardtop"><h3>Trades</h3>{recs.length > 0 && !trading && <button className="qm-link" onClick={resetStats}>Reset</button>}</div>
        <StatTiles s={summary} />
        <TradeList recs={recs} now={now} />
      </div>
      <p className="qm-disc">The AI confidence is the AI's read of this setup against the strategy rules and the market condition, capped by a server-side market-quality check. It is not a chance of winning. MTG multiplies your stake after losses and can lose a lot quickly. Trade only what you can afford to lose. Not financial advice.</p>
      <div style={{ height: 24 }} />
    </div>
  );
}
