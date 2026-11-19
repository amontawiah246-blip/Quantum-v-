import React from "react";
import { Summary, TradeRec } from "./tradeSession";

const p2 = (n: number) => String(n).padStart(2, "0");
export const clockOf = (ms: number) => { const d = new Date(ms); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
export const money = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
export const mmss = (s: number) => `${p2(Math.floor(s / 60))}:${p2(Math.floor(s % 60))}`;

/** The counters you asked for: trades, wins, losses, pending, win rate, profit/loss (and MTG recoveries). */
export function StatTiles({ s }: { s: Summary }) {
  const tiles: { k: string; v: React.ReactNode; tone?: string }[] = [
    { k: "Trades", v: s.trades },
    { k: "Wins", v: s.wins, tone: "up" },
    { k: "Losses", v: s.losses, tone: "down" },
    { k: "Pending", v: s.pending, tone: s.pending ? "warn" : "" },
    { k: "Win rate", v: `${s.winRate}%` },
    { k: "Profit / loss", v: money(s.pnl), tone: s.pnl > 0 ? "up" : s.pnl < 0 ? "down" : "" },
  ];
  return (
    <div className="qm-stats" role="group" aria-label="Trade statistics">
      {tiles.map((t) => (
        <div key={t.k} className={`qm-stat ${t.tone ?? ""}`}><b>{t.v}</b><small>{t.k}</small></div>
      ))}
      {(s.recovered > 0 || s.draws > 0) && (
        <div className="qm-stat-extra">
          {s.recovered > 0 && <span>MTG recovered {s.recovered}</span>}
          {s.draws > 0 && <span>Draws {s.draws}</span>}
        </div>
      )}
    </div>
  );
}

/** Every order, newest first. A pending one pulses until the broker reports its result. */
export function TradeList({ recs, now, limit = 12 }: { recs: TradeRec[]; now: number; limit?: number }) {
  if (!recs.length) return <p className="qm-muted">Your trades and their results will appear here.</p>;
  return (
    <div className="qm-list">
      {recs.slice(0, limit).map((t) => {
        const left = Math.max(0, Math.ceil((t.ts + t.seconds * 1000 - now) / 1000));
        return (
          <div className={`qm-row ${t.result}`} key={t.id}>
            <span className={`qm-side ${t.side}`}>{t.side === "buy" ? "BUY" : "SELL"}</span>
            <span className="qm-rm">
              {t.label}{t.step > 0 && <em className="qm-mtg">MTG {t.step}</em>}
              <small>{clockOf(t.ts)} UTC · ${t.stake} · {t.seconds >= 60 ? `${t.seconds / 60}m` : `${t.seconds}s`}{t.note ? ` · ${t.note}` : ""}</small>
            </span>
            <span className="qm-rr">
              {t.result === "pending"
                ? <span className="qm-pill pending">{left > 0 ? mmss(left) : "settling"}</span>
                : t.result === "error"
                  ? <span className="qm-pill error">Error</span>
                  : <><span className={`qm-pill ${t.result}`}>{t.result.toUpperCase()}</span>{t.profit != null && <small className={t.profit >= 0 ? "up" : "down"}>{money(t.profit)}</small>}</>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
