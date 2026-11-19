// Pro mode: no market to choose. Set the timing yourself or let the engine pick it, switch MTG on or off,
// then press AUTO TRADE. The engines + AI scan the markets, place the trades, follow them and keep score.
// The bot runs on the server (src/autopilot.ts), so it keeps going when the phone is locked.
import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Bot, Clock, Play, ShieldAlert, Square, Zap } from "lucide-react";
import { AutoConfig, DEFAULT_CFG } from "./autopilot";
import { useAutopilot, AgentDashboard } from "./AutopilotUI";
import { BROKER_EXPIRY_OPTIONS, BROKER_TIMEFRAME_OPTIONS, formatTimingLabel } from "./globalConfig";
import { MTG_DEFAULT_MULT, Summary, mtgPlan } from "./tradeSession";
import { StatTiles, TradeList, mmss } from "./TradeStats";
import { useGlobalTiming } from "./useGlobalTiming";

const KEY = "qx-pro-cfg2";
const DEFAULTS: AutoConfig = { ...DEFAULT_CFG, tfSec: 300, expirySec: 300, mtg: false, autoTiming: false };
const load = (): AutoConfig => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEFAULTS }; } };
const save = (c: AutoConfig) => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* storage unavailable */ } };

const PHASE: Record<string, string> = { idle: "Idle", scanning: "Scanning markets", listening: "Listening to the market agents", confirming: "Confirming setup", running: "Trade running", cooldown: "Waiting for the next setup", stopped: "Stopped" };

function NumField({ label, value, min, max, step = 1, disabled, onCommit, prefix }: { label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onCommit: (n: number) => void; prefix?: string }) {
  const [raw, setRaw] = useState(String(value));
  useEffect(() => setRaw(String(value)), [value]);
  const commit = () => { const n = parseFloat(raw); const v = Number.isFinite(n) ? Math.min(max, Math.max(min, step >= 1 ? Math.round(n) : n)) : value; setRaw(String(v)); onCommit(v); };
  return (
    <label className="qm-field"><small>{label}</small>
      <span>{prefix && <em>{prefix}</em>}<input inputMode="decimal" value={raw} disabled={disabled} onChange={(e) => setRaw(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} /></span>
    </label>
  );
}

interface Props { http: string; balance?: number | null; isDemo?: boolean; ready: boolean; currency?: string; onToast: (m: string) => void; onExit: () => void }

export default function ProMode({ http, balance, isDemo, ready, onToast, onExit }: Props) {
  const ap = useAutopilot(http);
  const { timing, updateTiming } = useGlobalTiming(http);
  const [cfg, setCfg] = useState<AutoConfig>(load);
  const [now, setNow] = useState(() => Date.now());
  const [starting, setStarting] = useState(false);
  const [allowEngineOnly, setAllowEngineOnly] = useState(true);

  useEffect(() => {
    fetch(`${http}/api/signal/policy`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.policy?.aiUnavailable) {
          setAllowEngineOnly(d.policy.aiUnavailable === "allow_engine_only");
        }
      })
      .catch(() => {});
  }, [http]);

  const toggleEngineOnly = async () => {
    const next = !allowEngineOnly;
    setAllowEngineOnly(next);
    try {
      await fetch(`${http}/api/signal/policy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiUnavailable: next ? "allow_engine_only" : "block" }),
      });
      onToast(next ? "Engine-only fallback enabled" : "Strict AI verification enabled");
    } catch {
      onToast("Failed to update policy");
    }
  };

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const run = ap.running;
  const st = ap.st;
  const set = (p: Partial<AutoConfig>) => setCfg((c) => { const n = { ...c, ...p }; save(n); return n; });
  const shown = run && ap.cfg ? { ...cfg, ...ap.cfg } : cfg;     // while it runs, show what the server is really using
  const plan = mtgPlan(shown.stake, { on: !!shown.mtg, steps: shown.mtgSteps ?? 2, mult: shown.mtgMult ?? MTG_DEFAULT_MULT });

  const summary: Summary | null = useMemo(() => {
    if (!st) return null;
    const s = st.stats, settled = s.wins + s.losses;
    return { trades: s.trades, wins: s.wins, losses: s.losses, draws: s.draws, pending: st.trade ? 1 : 0, errors: 0, winRate: settled ? Math.round((s.wins / settled) * 100) : 0, pnl: s.pnl, recovered: s.recovered ?? 0 };
  }, [st]);

  const start = async () => {
    if (!ready) { onToast("Deriv is not connected yet. Check the API screen."); return; }
    if (timing.transitioning) { onToast("Agents are synchronizing to the new timeframe — please wait."); return; }
    if (balance != null && cfg.stake > balance) { onToast(`Stake $${cfg.stake} is more than your balance $${balance.toFixed(2)}`); return; }
    if (cfg.mtg && balance != null && plan.worstCase > balance && !window.confirm(`MTG worst case is $${plan.worstCase.toFixed(2)}, more than your balance of $${balance.toFixed(2)}. The engine will stop MTG when a stake is too large. Continue?`)) return;
    if (isDemo === false && !window.confirm(`REAL account: Auto Trade will place real-money trades on its own${cfg.mtg ? `, with MTG recovery (worst case $${plan.worstCase.toFixed(2)} per setup)` : ""}. It stops after ${cfg.maxTrades} trades, ${cfg.maxLossStreak} losses in a row, or $${cfg.stopLoss} down. Start?`)) return;
    setStarting(true);
    const effectiveCfg = {
      ...cfg,
      tfSec: cfg.autoTiming ? cfg.tfSec : timing.tfSec,
      expirySec: cfg.autoTiming ? cfg.expirySec : timing.expirySec,
      derivType: "risefall",
    } as AutoConfig & Record<string, unknown>;
    const msg = await ap.start("deriv", effectiveCfg);
    setStarting(false);
    onToast(msg || "Auto Trade started");
  };

  const open = st && st.phase !== "idle";
  const done = st?.phase === "stopped";
  const scanDone = st ? st.scan.filter((r) => r.state === "done" || r.state === "fail").length : 0;
  const t = st?.trade;
  const left = t ? Math.max(0, Math.ceil((t.endsAt - now) / 1000)) : 0;

  return (
    <div className="qm">
      <div className="qm-head">
        <button className="qm-back" onClick={onExit} aria-label="Back"><ArrowLeft size={20} /></button>
        <div><h1>Pro Mode</h1><p className={`qm-status ${run ? "busy" : ready ? "ok" : ""}`}><i />{run ? (PHASE[st?.phase ?? "scanning"] ?? "Running").toUpperCase() : ready ? "READY" : "CONNECTING…"}</p></div>
        <span className={`qm-acct ${isDemo === false ? "real" : ""}`}>{isDemo === false ? "REAL" : "DEMO"}{balance != null && <b>${balance.toFixed(2)}</b>}</span>
      </div>

      <div className="qm-card gc">
        <div className="qm-cardtop">
          <h3><Clock size={17} /> Global Time frame &amp; expiry</h3>
          <span className="text-[11px] font-mono text-slate-300">
            {timing.transitioning
              ? `Syncing ${timing.syncedAgents.length}/${timing.requiredAgents.length}…`
              : `${formatTimingLabel(timing.tfSec)} / ${formatTimingLabel(timing.expirySec)} Synced`}
          </span>
        </div>
        <div className="qm-seg two">
          <button className={!shown.autoTiming ? "on" : ""} disabled={run} onClick={() => set({ autoTiming: false })}>Global Manual</button>
          <button className={shown.autoTiming ? "on" : ""} disabled={run} onClick={() => set({ autoTiming: true })}><Zap size={13} /> Auto 5m</button>
        </div>
        {shown.autoTiming ? (
          <p className="qm-hint">Auto locks to the 5-minute chart with a 5-minute expiry (your execution policy). Choose Global Manual to use another time frame or expiry.{run && st?.timing ? <> <b>Now: {st.timing}</b></> : null}</p>
        ) : (
          <>
            <h4 className="qm-lbl">GLOBAL TIME FRAME (ALL AGENTS)</h4>
            <div className="qm-chips">
              {BROKER_TIMEFRAME_OPTIONS.map((x) => (
                <button
                  key={x.sec}
                  className={(run ? shown.tfSec : timing.tfSec) === x.sec ? "on" : ""}
                  disabled={run}
                  onClick={() => {
                    set({ tfSec: x.sec });
                    void updateTiming({ tfSec: x.sec }).then((r) => {
                      if (!r.ok) onToast(r.error || "Timeframe update failed");
                    });
                  }}
                >
                  {x.label}
                </button>
              ))}
            </div>
            <h4 className="qm-lbl">GLOBAL TRADE EXPIRY</h4>
            <div className="qm-chips">
              {BROKER_EXPIRY_OPTIONS.map((x) => (
                <button
                  key={x.sec}
                  className={(run ? (shown.expirySec ?? timing.expirySec) : timing.expirySec) === x.sec ? "on" : ""}
                  disabled={run}
                  onClick={() => {
                    set({ expirySec: x.sec });
                    void updateTiming({ expirySec: x.sec }).then((r) => {
                      if (!r.ok) onToast(r.error || "Expiry update failed");
                    });
                  }}
                >
                  {x.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className={`qm-card gc ${shown.mtg ? "hot" : ""}`}>
        <div className="qm-cardtop">
          <h3>MTG recovery</h3>
          <button className={`qm-switch ${shown.mtg ? "on" : ""}`} role="switch" aria-checked={!!shown.mtg} aria-label="MTG" disabled={run} onClick={() => set({ mtg: !shown.mtg })}><i /></button>
        </div>
        {shown.mtg ? (
          <>
            <div className="qm-chips three">{[1, 2, 3].map((n) => <button key={n} className={(shown.mtgSteps ?? 2) === n ? "on" : ""} disabled={run} onClick={() => set({ mtgSteps: n })}>{n} Step{n > 1 ? "s" : ""}</button>)}</div>
            <div className="qm-chips mult"><small>Stake multiplier</small>{[2, MTG_DEFAULT_MULT, 2.5].map((m) => <button key={m} className={(shown.mtgMult ?? MTG_DEFAULT_MULT) === m ? "on" : ""} disabled={run} onClick={() => set({ mtgMult: m })}>×{m}</button>)}</div>
            <p className="qm-hint warn"><ShieldAlert size={14} /><span>After a loss it re-enters the same market and side with stakes {plan.stakes.map((s) => `$${s}`).join(" → ")}. If every step loses you lose <b>${plan.worstCase.toFixed(2)}</b>. MTG never goes past your loss limit or your balance.</span></p>
          </>
        ) : <p className="qm-hint">Off: each loss is a single loss. Switch on to recover losses with bigger follow-up trades.</p>}
      </div>

      <div className="qm-card">
        <div className="qm-cardtop"><h3>Risk &amp; filters</h3></div>
        <div className="qm-fields">
          <NumField label="Stake ($)" value={shown.stake} min={0.35} max={100000} step={0.01} disabled={run} onCommit={(n) => set({ stake: n })} />
          <NumField label="Min engine agreement" value={shown.minConf} min={55} max={95} disabled={run} onCommit={(n) => set({ minConf: n })} />
          <NumField label="Max trades" value={shown.maxTrades} min={1} max={500} disabled={run} onCommit={(n) => set({ maxTrades: n })} />
          <NumField label="Stop at loss ($)" value={shown.stopLoss} min={1} max={1000000} step={0.01} disabled={run} onCommit={(n) => set({ stopLoss: n })} />
          <NumField label="Stop after losses in a row" value={shown.maxLossStreak} min={1} max={20} disabled={run} onCommit={(n) => set({ maxLossStreak: n })} />
        </div>
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>ALLOW ENGINE-ONLY TRADES</div>
            <div style={{ fontSize: 11, color: "#8a96b4", marginTop: 2 }}>Allows trading based on confirmed strategy engine signals when Gemini AI is not available.</div>
          </div>
          <button className={`qm-switch ${allowEngineOnly ? "on" : ""}`} role="switch" aria-checked={allowEngineOnly} aria-label="Allow engine-only trades" onClick={toggleEngineOnly}><i /></button>
        </div>
      </div>

      {run
        ? <button className="qm-go stop big" onClick={() => void ap.stop()}><Square size={20} fill="currentColor" /> STOP AUTO TRADE</button>
        : <button className="qm-go big" disabled={starting} onClick={() => void start()}><Play size={20} fill="currentColor" /> {starting ? "STARTING…" : "AUTO TRADE"}</button>}
      {!run && <p className="qm-disc center">The engines and AI choose the market, confirm the setup, place the trade and follow it to the result. It stops by itself at your limits.</p>}

      {open && st && summary && (
        <div className={`qm-card live ${run ? "gc" : ""}`}>
          <div className="qm-cardtop"><h3><Bot size={17} /> {run ? "Live" : "Session"}</h3>{done && <button className="qm-link" onClick={() => void ap.dismiss()}>Dismiss</button>}</div>
          {done && st.stopReason && <p className="qm-hint warn">{st.stopReason}</p>}
          <StatTiles s={summary} />
          {t && (
            <div className={`qm-run ${t.side}`}>
              <div><b>{t.side === "buy" ? "BUY" : "SELL"} {t.label}</b>{(t.step ?? 0) > 0 && <em className="qm-mtg">MTG {t.step}</em>}<small>${t.stake} · {t.seconds}s · agreement {t.conf}</small></div>
              <span className="qm-count">{left > 0 ? mmss(left) : "settling…"}</span>
              <i className="qm-bar"><u style={{ width: `${Math.min(100, Math.max(0, ((t.seconds - left) / t.seconds) * 100))}%` }} /></i>
            </div>
          )}
          {run && !t && (
            <p className="qm-hint">{PHASE[st.phase]}{st.phase === "scanning" && st.scan.length ? ` · ${scanDone}/${st.scan.length} markets checked` : ""}{st.timing ? ` · ${st.timing}` : ""}</p>
          )}
          {st.agent && (<><h4 className="qm-lbl">MARKET AGENTS → AUTO TRADE</h4><AgentDashboard a={st.agent} /></>)}
          <h4 className="qm-lbl">TRADES</h4>
          <TradeList recs={st.trades ?? []} now={now} limit={15} />
          {st.log.length > 0 && (<><h4 className="qm-lbl">ACTIVITY</h4>
            <ul className="qm-log">{st.log.slice(0, 8).map((l, i) => <li key={`${l.t}-${i}`} className={l.kind}>{l.text}</li>)}</ul></>)}
        </div>
      )}
      <p className="qm-disc">Confidence shows how many engines agree, not a chance of winning. Auto trading and MTG can lose money fast. Not financial advice.</p>
      <div style={{ height: 24 }} />
    </div>
  );
}
