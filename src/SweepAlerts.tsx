// Wick sweep alerts: the 16 agents post a chart screenshot here the moment the wick sweep engine sees a setup.
// The bridge does the watching (bridge/sweep_watch.py); this screen only shows what it found.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";
import { BROKER_TIMEFRAME_OPTIONS } from "./globalConfig";
import { useGlobalTiming } from "./useGlobalTiming";

export interface SweepAlert {
  id: number; symbol: string; name: string; market: string; tf: number; candle_time: number;
  engine: "sweep" | "continuation" | "momentum" | "lscc" | "structure_sweep"; trade_at_next_open: boolean;
  side: "BUY" | "SELL"; ok: boolean; block: string | null; notes: string[]; entry: number; swept_level: number;
  created: number; live: boolean;
  /** LSCC: where the liquidity-sweep setup stands and the candles it is made of */
  lscc?: { state: "WAITING" | "CONFIRMED" | "INVALID"; level: number; sweepTime: number; confirmTime: number | null; entryTime: number | null; reason?: string };
  /** Structure-confirmed sweep: directional bias event and swept level */
  structureMeta?: {
    biasDirection: "BULLISH" | "BEARISH";
    eventType: "CHoCH" | "MSS" | "BOS";
    breakLevel: number;
    eventTime: number;
    bosCount: number;
    pullbackTime: number;
    sweepTime: number;
  };
  /** an LSCC alert is updated in place (confirmed or invalid): the new alert replaces this id */
  replaces?: number;
}
export interface LsccCard {
  key: string; market: string; direction: "BUY" | "SELL"; state: string; label: string; detail: string; level: number;
  sweepCandle: number; confirmationCandle: number | null; entryCandle: number | null; screenshotAlertId: number; candidateId: string | null;
  engines: { engine: string; status: string }[]; ai: string | null; execution: string;
}
export interface SweepState {
  running: boolean; tf: number; agents: number; last_run: number; last_id: number; total: number; now: number;
  failed: string[]; markets: { symbol: string; name: string; last_candle: number; error: string }[];
}
export interface SweepFeed {
  alerts: SweepAlert[]; state: SweepState | null; error: string; unseen: number; lastId: number;
  markSeen: () => void;
  start: (tf: number, backfill?: number) => Promise<void>;
  stop: () => Promise<void>;
  clear: () => Promise<void>;
}

export const ENGINE_LABEL: Record<SweepAlert["engine"], string> = {
  sweep: "Wick sweep",
  continuation: "Sweep continuation",
  momentum: "Momentum",
  lscc: "LSCC",
  structure_sweep: "Structure Sweep",
};
/** the label the LSCC setup carries on screen: WAITING, BUY, SELL, INVALID (expiry is shown on the LSCC board, which knows the clock) */
export const lsccTag = (a: SweepAlert) => a.engine !== "lscc" || !a.lscc ? "" : a.lscc.state === "WAITING" ? "LSCC WAITING" : a.lscc.state === "INVALID" ? "LSCC INVALID" : `LSCC ${a.side}`;
const SEEN_KEY = "qx-sweep-seen";
const VERDICT_KEY = "qx-sweep-verdicts";
const readNum = (k: string) => { try { return Number(localStorage.getItem(k)) || 0; } catch { return 0; } };

/** Polls the bridge every few seconds. Lives in App so the Menu badge and the toast work from any tab. */
export function useSweepFeed(http: string, onNew?: (a: SweepAlert) => void): SweepFeed {
  const [alerts, setAlerts] = useState<SweepAlert[]>([]);
  const [state, setState] = useState<SweepState | null>(null);
  const [error, setError] = useState("");
  const [seen, setSeen] = useState<number>(() => readNum(SEEN_KEY));
  const lastId = useRef(0);
  const first = useRef(true);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  const poll = useCallback(async () => {
    try {
      const r = await apiFetch(`${http}/api/sweep/alerts?since=${lastId.current}&limit=100`);
      if (!r.ok) throw new Error(`bridge answered ${r.status}`);
      const d: { alerts: SweepAlert[]; state: SweepState } = await r.json();
      setState(d.state);
      setError("");
      if (d.alerts.length) {
        const fresh = d.alerts;
        lastId.current = Math.max(lastId.current, ...fresh.map((a) => a.id));
        setAlerts((prev) => {
          const m = new Map(prev.map((a) => [a.id, a]));
          fresh.forEach((a) => { if (a.replaces != null) m.delete(a.replaces); m.set(a.id, a); });
          return [...m.values()].sort((a, b) => b.candle_time - a.candle_time || b.id - a.id).slice(0, 150);
        });
        if (!first.current) fresh.filter((a) => a.live).sort((a, b) => a.id - b.id).forEach((a) => onNewRef.current?.(a));
      }
      first.current = false;
    } catch (e) {
      setError(`Cannot reach the bridge (${(e as Error).message})`);
    }
  }, [http]);

  useEffect(() => {
    lastId.current = 0; first.current = true; setAlerts([]);
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [poll]);

  const post = async (path: string, body: object = {}) => {
    try {
      const r = await apiFetch(`${http}/api/sweep/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.status === "error") setError(d.msg || "Request failed");
    } catch (e) { setError(`Cannot reach the bridge (${(e as Error).message})`); }
  };

  const lastIdNow = alerts.reduce((m, a) => Math.max(m, a.id), 0);
  return {
    alerts, state, error, lastId: lastIdNow,
    unseen: alerts.filter((a) => a.id > seen).length,
    markSeen: () => { if (lastIdNow > seen) { setSeen(lastIdNow); try { localStorage.setItem(SEEN_KEY, String(lastIdNow)); } catch { /* storage unavailable */ } } },
    start: async (tf, backfill = 0) => { await post("start", { tf, backfill }); await poll(); },
    stop: async () => { await post("stop"); await poll(); },
    clear: async () => { await post("clear"); lastId.current = 0; setAlerts([]); await poll(); },
  };
}

const ago = (sec: number) => (sec < 90 ? "just now" : sec < 3600 ? `${Math.round(sec / 60)}m ago` : `${Math.round(sec / 3600)}h ago`);
const hhmm = (epoch: number, tf: number) =>
  new Date(epoch * 1000).toLocaleTimeString([], tf < 60 ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

/** The LSCC board: every liquidity sweep the agents are tracking, with candles, screenshot, engine and AI answers and the final execution status. */
export function LsccBoard({ http }: { http: string }) {
  const [cards, setCards] = useState<LsccCard[]>([]);
  useEffect(() => {
    let live = true;
    const load = async () => { try { const r = await apiFetch(`${http}/api/sweep/lscc`); const d = await r.json(); if (live && d.cards) setCards(d.cards); } catch { /* the bridge is not reachable: keep what is shown */ } };
    load(); const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
  }, [http]);
  if (!cards.length) return null;
  return (
    <div className="sw-card">
      <div className="sw-head"><b>LSCC · liquidity sweep + confirmation candle</b></div>
      {cards.slice(0, 12).map((c) => (
        <p key={c.key} className="sw-sub">
          <b>{c.label}</b> · {c.market} · {c.direction} · level {c.level} · sweep {hhmmUtc(c.sweepCandle)}{c.confirmationCandle ? ` · confirm ${hhmmUtc(c.confirmationCandle)}` : ""}{c.entryCandle ? ` · entry ${hhmmUtc(c.entryCandle)}` : ""}
          {c.engines.length ? ` · engines ${c.engines.map((e) => `${e.engine}:${e.status}`).join(" ")}` : ""}{c.ai ? ` · AI ${c.ai}` : ""} · {c.execution}{c.detail ? ` (${c.detail})` : ""}
        </p>
      ))}
    </div>
  );
}
const hhmmUtc = (e: number) => new Date(e * 1000).toISOString().slice(11, 16);

export default function SweepAlerts({ feed, http }: { feed: SweepFeed; http: string }) {
  const { alerts, state, error } = feed;
  const { timing, updateTiming } = useGlobalTiming(http);
  const [filter, setFilter] = useState<"all" | "take" | "skip">("all");
  const [engine, setEngine] = useState<"all" | SweepAlert["engine"]>("all");
  const [zoom, setZoom] = useState<SweepAlert | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, "yes" | "no">>(() => {
    try { return JSON.parse(localStorage.getItem(VERDICT_KEY) || "{}"); } catch { return {}; }
  });
  const vote = (id: number, v: "yes" | "no") => {
    setVerdicts((p) => {
      const n = { ...p }; if (n[id] === v) delete n[id]; else n[id] = v;
      try { localStorage.setItem(VERDICT_KEY, JSON.stringify(n)); } catch { /* storage unavailable */ }
      return n;
    });
  };

  const shown = alerts.filter((a) => (filter === "all" ? true : filter === "take" ? a.ok : !a.ok) && (engine === "all" || a.engine === engine));
  const yes = alerts.filter((a) => verdicts[a.id] === "yes").length;
  const no = alerts.filter((a) => verdicts[a.id] === "no").length;
  const nowSec = state?.now ?? Date.now() / 1000;
  const checked = state?.last_run ? ago(nowSec - state.last_run) : "not yet";

  return (
    <section className="sw">
      <div className="sw-card">
        <div className="sw-head">
          <b>Setup watch: sweep, continuation, momentum, LSCC, Structure</b>
          <span className={`sw-dot ${state?.running ? "on" : ""}`}>
            {timing.transitioning ? `Syncing ${timing.syncedAgents.length}/${timing.requiredAgents.length}` : state?.running ? "Watching" : "Stopped"}
          </span>
        </div>
        <p className="sw-sub">
          {state ? `${state.agents} agents synced to global timeframe (${timing.tfSec}s · expiry ${timing.expirySec}s). Last check: ${checked}.` : "Connecting to the bridge…"}
          {state && state.failed.length > 0 && ` No data from: ${state.failed.join(", ")}.`}
        </p>
        {error && <p className="sw-err">{error}</p>}
        <div className="sw-row">
          {BROKER_TIMEFRAME_OPTIONS.map((t) => (
            <button key={t.sec} className={`sw-chip ${timing.tfSec === t.sec ? "on" : ""}`} onClick={() => { void updateTiming({ tfSec: t.sec }); }}>{t.label}</button>
          ))}
        </div>
        <div className="sw-row">
          {state?.running
            ? <button className="sw-btn" onClick={() => feed.stop()}>Stop</button>
            : <button className="sw-btn pri" onClick={() => feed.start(timing.tfSec)}>Start</button>}
          <button className="sw-btn" onClick={() => feed.start(timing.tfSec, 60)}>Load recent setups</button>
          <button className="sw-btn" onClick={() => { if (window.confirm("Delete all alerts?")) feed.clear(); }}>Clear</button>
        </div>
      </div>

      <LsccBoard http={http} />
      <div className="sw-row sw-filter">
        {([["all", "All"], ["take", "Taken"], ["skip", "Skipped"]] as const).map(([k, l]) => (
          <button key={k} className={`sw-chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <div className="sw-row sw-filter">
        {([["all", "All engines"], ["sweep", "Sweep"], ["continuation", "Continuation"], ["momentum", "Momentum"], ["lscc", "LSCC"], ["structure_sweep", "Structure Sweep"]] as const).map(([k, l]) => (
          <button key={k} className={`sw-chip ${engine === k ? "on" : ""}`} onClick={() => setEngine(k)}>{l}</button>
        ))}
      </div>
      <div className="sw-row">
        <span className="sw-tally">Checked by you: {yes} correct, {no} wrong</span>
      </div>

      {shown.length === 0 && (
        <p className="muted">
          {alerts.length === 0
            ? "No setups yet. A screenshot appears here the moment any agent sees one. Tap “Load recent setups” to see the latest ones from the last 60 candles."
            : "Nothing in this filter."}
        </p>
      )}

      {shown.map((a) => (
        <article key={a.id} className={`sw-alert ${a.ok ? "" : "skip"}`}>
          <div className="sw-ahead">
            <span className={`sw-side ${a.side === "BUY" ? "buy" : "sell"}`}>{a.side}</span>
            <div className="sw-title">
              <b>{a.name}</b>
              <small>{ENGINE_LABEL[a.engine]} · {a.symbol} · {hhmm(a.candle_time, a.tf)} · {ago(nowSec - (a.candle_time + a.tf))}{a.live ? "" : " · earlier"}</small>
            </div>
            <span className={`sw-tag ${a.ok ? "take" : "skip"}`}>{lsccTag(a) || (a.ok ? "TAKE" : "SKIP")}</span>
          </div>
          <img className="sw-img" loading="lazy" alt={`${a.side} setup on ${a.name}`} src={`${http}/api/sweep/image/${a.id}`} onClick={() => setZoom(a)} />
          {a.lscc && <p className="sw-sub">Liquidity level {a.lscc.level} · sweep candle {hhmm(a.lscc.sweepTime, a.tf)}{a.lscc.confirmTime ? ` · confirmation ${hhmm(a.lscc.confirmTime, a.tf)}` : ""}{a.lscc.entryTime ? ` · entry ${hhmm(a.lscc.entryTime, a.tf)}` : ""}</p>}
          {a.structureMeta && <p className="sw-sub">{a.structureMeta.biasDirection} bias ({a.structureMeta.eventType} @ {a.structureMeta.breakLevel.toFixed(5)}) · pullback {hhmm(a.structureMeta.pullbackTime, a.tf)} · sweep {hhmm(a.structureMeta.sweepTime, a.tf)}</p>}
          <p className="sw-why">{a.ok ? a.notes.join(", ") || "confirmed" : a.block}{a.ok && a.trade_at_next_open ? ". Trade opens on the next candle." : ""}</p>
          <div className="sw-row">
            <button className={`sw-btn ${verdicts[a.id] === "yes" ? "yes" : ""}`} onClick={() => vote(a.id, "yes")}>✓ Engine is right</button>
            <button className={`sw-btn ${verdicts[a.id] === "no" ? "no" : ""}`} onClick={() => vote(a.id, "no")}>✗ Engine is wrong</button>
          </div>
        </article>
      ))}

      {zoom && (
        <div className="sw-zoom" onClick={() => setZoom(null)} role="dialog" aria-label="Setup screenshot">
          <img alt="Setup screenshot" src={`${http}/api/sweep/image/${zoom.id}`} />
        </div>
      )}
    </section>
  );
}
