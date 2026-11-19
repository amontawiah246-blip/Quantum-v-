// THE CHART EVERY AGENT DRAWS FOR THE INDICATOR STRATEGY: candles on top, the Stochastic panel (%K, %D, the 20 / 80 lines) and the RSI panel
// (the 30 / 50 / 70 lines) underneath, the candle pattern that confirmed the trigger framed on the price chart, and the entry arrow.
//
// All agents call this one function with the same indicator parameters (src/stochRsi.ts), so every screenshot carries the identical indicator.
// It draws only what the strategy defined: no extra indicators, no support / resistance unless `levels` is asked for (the signal card does).
// The same renderer draws the chart BEFORE the trade (entry arrow in the next candle slot) and AFTER it (shaded trade window, entry / exit prices, WIN / LOSS tag).
import { STOCH_RSI_DEFAULTS, computeStochRsi } from './stochRsi';
import type { StochRsiMeta } from './sweepEngines';

export interface IndicatorTrade {
  /** open time (epoch s) of the candle the trade starts on, and the price it started at */
  time: number; price: number; expirySec: number;
  result?: 'WIN' | 'LOSS' | 'DRAW' | 'PENDING';
  exitPrice?: number | null;
}

export interface IndicatorChartOptions {
  side: 'BUY' | 'SELL';
  ok: boolean;
  tf: number;
  market: string;
  symbol: string;
  meta?: StochRsiMeta | null;
  block?: string | null;
  notes?: string[];
  /** open time of the signal candle (the candle the trigger completed on) */
  signalTime?: number;
  /** candles shown (the indicators are still computed on every candle that is passed in) */
  visible?: number;
  /** no title block: used inside the signal card */
  compact?: boolean;
  /** draw the 30-candle support / resistance lines (signal card only) */
  levels?: boolean;
  trade?: IndicatorTrade | null;
}

const GREEN = '#3cb54f', RED = '#e8202e', AMBER = '#f5b942', CYAN = '#38bdf8', PINK = '#f472b6', PURPLE = '#c084fc';
const BG = '#030a1a', GRID = '#1b2742', TXT = '#ffffff', DIM = '#8a96b4';
const FONT = "Inter, 'Segoe UI', Arial, Helvetica, sans-serif";
const W = 1168, L = 40, R = 1040;                // price scale is on the right, like the app's own charts
const TRAIL = 3;                                  // empty slots to the right: room for the entry arrow

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pad2 = (v: number) => String(v).padStart(2, '0');
const f1 = (x: number) => x.toFixed(1);

export const ENGINE_LABEL: Record<string, string> = {
  sweep: 'wick sweep', continuation: 'sweep continuation', momentum: 'momentum', lscc: 'LSCC', structure_sweep: 'structure sweep', candlestick: 'candlestick pattern',
};

export function indicatorTitle(o: Pick<IndicatorChartOptions, 'side' | 'ok'>): string {
  const buy = o.side === 'BUY';
  return o.ok
    ? `Valid ${buy ? 'Buy' : 'Sell'} Setup \u2013 Stochastic + RSI ${buy ? 'up-cross' : 'down-cross'}, candle pattern confirmed`
    : `Skipped ${buy ? 'Buy' : 'Sell'} \u2013 Stochastic + RSI trigger, no candle pattern`;
}

export function indicatorRule(side: 'BUY' | 'SELL'): string {
  return side === 'BUY'
    ? 'Stochastic %K crosses up through 20 and RSI crosses up through 30 or 50; a bullish candle pattern in the last candles confirms. BUY at the next candle open'
    : 'Stochastic %K crosses down through 80 and RSI crosses down through 70 or 50; a bearish candle pattern in the last candles confirms. SELL at the next candle open';
}

export function renderIndicatorSvg(candles: Array<{ time: number; open: number; high: number; low: number; close: number }>, o: IndicatorChartOptions): string {
  const all = candles;
  if (!all.length) return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>';
  const V = Math.max(10, Math.min(o.visible ?? 40, all.length));
  const s0 = all.length - V;
  const cs = all.slice(s0);
  const n = cs.length;
  const series = computeStochRsi(all, STOCH_RSI_DEFAULTS);
  const buy = o.side === 'BUY';
  const colour = o.ok ? (buy ? GREEN : RED) : AMBER;
  const compact = !!o.compact;

  // ---- layout
  const top = compact ? 30 : 168;
  const mainB = compact ? 480 : 540;
  const stT = mainB + 46, stB = stT + 88;
  const rsT = stB + 46, rsB = rsT + 88;
  const H = rsB + (compact ? 44 : 90);
  const slots = n + TRAIL;
  const slot = (R - L) / slots;
  const bw = Math.max(3, slot * 0.56);
  const t0 = cs[0].time;
  const xt = (t: number) => L + slot * ((t - t0) / o.tf);                // left edge of the slot that opens at time t
  const x = (i: number) => L + slot * (i + 0.5);
  const idxOfTime = (t: number) => cs.findIndex((c) => c.time === t);

  // ---- price scale
  let lo = Math.min(...cs.map((c) => c.low)), hi = Math.max(...cs.map((c) => c.high));
  let resistance: number | null = null, support: number | null = null;
  if (o.levels) {
    const sigI = o.signalTime != null ? idxOfTime(o.signalTime) : n - 1;
    const base = cs.slice(Math.max(0, (sigI < 0 ? n - 1 : sigI) - 29), (sigI < 0 ? n - 1 : sigI) + 1);
    resistance = Math.max(...base.map((c) => c.high)); support = Math.min(...base.map((c) => c.low));
    hi = Math.max(hi, resistance); lo = Math.min(lo, support);
  }
  if (o.trade) { lo = Math.min(lo, o.trade.price, o.trade.exitPrice ?? o.trade.price); hi = Math.max(hi, o.trade.price, o.trade.exitPrice ?? o.trade.price); }
  const span = Math.max(hi - lo, Math.abs(hi) * 1e-6, 1e-9);
  const ymin = lo - span * 0.14, ymax = hi + span * 0.14;
  const y = (p: number) => mainB - ((p - ymin) / (ymax - ymin)) * (mainB - top);
  const dec = hi >= 1000 ? 2 : hi >= 100 ? 3 : hi >= 10 ? 4 : 5;
  const hhmm = (e: number) => {
    const d = new Date(e * 1000);
    return o.tf < 60 ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}` : `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  };
  const yPanel = (v: number, a: number, b: number) => b - (Math.max(0, Math.min(100, v)) / 100) * (b - a);

  const s: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">`,
    `<rect width="${W}" height="${H}" fill="${BG}"/>`,
  ];

  // ---- grid + price axis
  for (let k = 0; k < 9; k++) {
    const p = ymin + ((ymax - ymin) * k) / 8, yy = y(p);
    s.push(`<line x1="${L}" y1="${yy.toFixed(1)}" x2="${R}" y2="${yy.toFixed(1)}" stroke="${GRID}" stroke-width="1.5" stroke-dasharray="7 7"/>`);
    s.push(`<text x="${R + 10}" y="${(yy + 6).toFixed(1)}" fill="${DIM}" font-size="20">${p.toFixed(dec)}</text>`);
  }
  const step = Math.max(1, Math.round(n / 8));
  for (let i = 0; i < n; i += step) {
    const xx = x(i);
    s.push(`<line x1="${xx.toFixed(1)}" y1="${top}" x2="${xx.toFixed(1)}" y2="${rsB}" stroke="${GRID}" stroke-width="1" stroke-dasharray="3 9" opacity=".7"/>`);
    s.push(`<text x="${xx.toFixed(1)}" y="${rsB + 32}" fill="${DIM}" font-size="19" text-anchor="middle">${hhmm(cs[i].time)}</text>`);
  }

  // ---- trade window (after the trade): shaded column from entry to expiry
  const tr = o.trade ?? null;
  const maxRight = R + slot * (TRAIL - 0.5);
  if (tr) {
    const xa = Math.max(L, Math.min(maxRight - 8, xt(tr.time)));
    const xb = Math.max(xa + 6, Math.min(maxRight, xt(tr.time + tr.expirySec)));
    s.push(`<rect x="${xa.toFixed(1)}" y="${top}" width="${Math.max(6, xb - xa).toFixed(1)}" height="${(rsB - top).toFixed(1)}" fill="#6f8cff" opacity=".13"/>`);
  }

  // ---- key levels (card only)
  if (resistance != null && support != null) {
    s.push(`<line x1="${L}" y1="${y(resistance).toFixed(1)}" x2="${R}" y2="${y(resistance).toFixed(1)}" stroke="${RED}" stroke-width="1.6" stroke-dasharray="9 6" opacity=".7"/>`);
    s.push(`<text x="${L + 6}" y="${(y(resistance) - 7).toFixed(1)}" fill="${RED}" font-size="18" font-weight="700">R ${resistance.toFixed(dec)}</text>`);
    s.push(`<line x1="${L}" y1="${y(support).toFixed(1)}" x2="${R}" y2="${y(support).toFixed(1)}" stroke="${GREEN}" stroke-width="1.6" stroke-dasharray="9 6" opacity=".7"/>`);
    s.push(`<text x="${L + 6}" y="${(y(support) + 20).toFixed(1)}" fill="${GREEN}" font-size="18" font-weight="700">S ${support.toFixed(dec)}</text>`);
  }

  // ---- candles
  for (let i = 0; i < n; i++) {
    const c = cs[i], col = c.close >= c.open ? GREEN : RED, xx = x(i);
    const tp = y(Math.max(c.open, c.close)), bt = y(Math.min(c.open, c.close));
    s.push(`<line x1="${xx.toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${xx.toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${col}" stroke-width="3"/>`);
    s.push(`<rect x="${(xx - bw / 2).toFixed(1)}" y="${tp.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(bt - tp, 2).toFixed(1)}" fill="${col}"/>`);
  }

  // ---- the candle pattern that confirmed the trigger (framed) + the level it swept
  const sigIdx = o.signalTime != null ? idxOfTime(o.signalTime) : n - 1;
  const meta = o.meta ?? null;
  const confirm = meta?.confirm ?? null;
  if (confirm) {
    const a = idxOfTime(confirm.fromTime), b = idxOfTime(confirm.time);
    if (b >= 0) {
      const aa = a < 0 ? b : a;
      const hiP = Math.max(...cs.slice(aa, b + 1).map((c) => c.high)), loP = Math.min(...cs.slice(aa, b + 1).map((c) => c.low));
      s.push(`<rect x="${(x(aa) - slot * 0.46).toFixed(1)}" y="${(y(hiP) - 9).toFixed(1)}" width="${(x(b) - x(aa) + slot * 0.92).toFixed(1)}" height="${(y(loP) - y(hiP) + 18).toFixed(1)}" rx="7" fill="none" stroke="${AMBER}" stroke-width="2.2" stroke-dasharray="6 5" opacity=".95"/>`);
      const lab = ENGINE_LABEL[confirm.engine] ?? confirm.engine;
      const ly = buy ? y(loP) + 36 : y(hiP) - 22;
      s.push(`<text x="${Math.min(x(b), R - 90).toFixed(1)}" y="${ly.toFixed(1)}" fill="${AMBER}" font-size="20" font-weight="700" text-anchor="${x(b) > R - 150 ? 'end' : 'middle'}">${esc(lab)}</text>`);
      if (confirm.level != null && b > aa) {
        const yl = y(confirm.level);
        s.push(`<line x1="${(x(aa) - slot * 0.5).toFixed(1)}" y1="${yl.toFixed(1)}" x2="${(x(b) + slot * 0.9).toFixed(1)}" y2="${yl.toFixed(1)}" stroke="${AMBER}" stroke-width="2.2" stroke-dasharray="3 6"/>`);
        s.push(`<text x="${(x(b) + slot * 0.95).toFixed(1)}" y="${(yl + 6).toFixed(1)}" fill="${AMBER}" font-size="18" font-weight="700">${buy ? 'swept low' : 'swept high'} ${confirm.level.toFixed(dec)}</text>`);
      }
    }
  }

  // ---- trigger line through all three panels
  if (sigIdx >= 0) {
    const xx = x(sigIdx);
    s.push(`<line x1="${xx.toFixed(1)}" y1="${top}" x2="${xx.toFixed(1)}" y2="${rsB}" stroke="${colour}" stroke-width="2" stroke-dasharray="2 7" opacity=".85"/>`);
    s.push(`<text x="${xx.toFixed(1)}" y="${(top - 6).toFixed(1)}" fill="${colour}" font-size="18" font-weight="800" text-anchor="middle">TRIGGER</text>`);
  }

  // ---- Stochastic panel
  const panel = (a: number, b: number, name: string, legend: string) => {
    s.push(`<rect x="${L}" y="${a}" width="${R - L}" height="${b - a}" fill="#071329" stroke="${GRID}" stroke-width="1.5"/>`);
    s.push(`<text x="${L + 8}" y="${a - 12}" fill="${TXT}" font-size="20" font-weight="700">${name}</text>`);
    s.push(legend);
  };
  const line = (vals: (number | null)[], a: number, b: number, col: string, w = 2.6) => {
    let d = '';
    vals.forEach((v, i) => { if (v == null) return; d += `${d ? 'L' : 'M'}${x(i).toFixed(1)} ${yPanel(v, a, b).toFixed(1)} `; });
    if (d) s.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round"/>`);
  };
  const hline = (v: number, a: number, b: number, col: string, text: string) => {
    const yy = yPanel(v, a, b);
    s.push(`<line x1="${L}" y1="${yy.toFixed(1)}" x2="${R}" y2="${yy.toFixed(1)}" stroke="${col}" stroke-width="1.5" stroke-dasharray="7 6" opacity=".9"/>`);
    s.push(`<text x="${R + 10}" y="${(yy + 6).toFixed(1)}" fill="${col}" font-size="19">${text}</text>`);
  };
  const k = series.k.slice(s0), d = series.d.slice(s0), rs = series.rsi.slice(s0);
  const last = (v: (number | null)[]) => { for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i] as number; return null; };

  panel(stT, stB, `Stochastic (${STOCH_RSI_DEFAULTS.kPeriod},${STOCH_RSI_DEFAULTS.kSmooth},${STOCH_RSI_DEFAULTS.dSmooth})`,
    `<text x="${R - 8}" y="${stT - 12}" fill="${DIM}" font-size="19" text-anchor="end"><tspan fill="${CYAN}" font-weight="700">%K ${last(k) != null ? f1(last(k)!) : '-'}</tspan>  <tspan fill="${PINK}" font-weight="700">%D ${last(d) != null ? f1(last(d)!) : '-'}</tspan></text>`);
  hline(STOCH_RSI_DEFAULTS.overbought, stT, stB, RED, String(STOCH_RSI_DEFAULTS.overbought));
  hline(STOCH_RSI_DEFAULTS.oversold, stT, stB, GREEN, String(STOCH_RSI_DEFAULTS.oversold));
  line(d, stT, stB, PINK, 2.2); line(k, stT, stB, CYAN, 2.8);

  panel(rsT, rsB, `RSI (${STOCH_RSI_DEFAULTS.rsiPeriod})`,
    `<text x="${R - 8}" y="${rsT - 12}" fill="${PURPLE}" font-size="19" font-weight="700" text-anchor="end">RSI ${last(rs) != null ? f1(last(rs)!) : '-'}</text>`);
  for (const lv of [70, 50, 30]) hline(lv, rsT, rsB, lv === 50 ? DIM : lv === 70 ? RED : GREEN, String(lv));
  line(rs, rsT, rsB, PURPLE, 2.8);

  // ---- the two crossings, marked on their own panels
  if (meta) {
    const si = idxOfTime(meta.stochTime), ri = idxOfTime(meta.rsiTime);
    if (si >= 0 && k[si] != null) {
      s.push(`<circle cx="${x(si).toFixed(1)}" cy="${yPanel(k[si]!, stT, stB).toFixed(1)}" r="8" fill="none" stroke="${AMBER}" stroke-width="3"/>`);
      s.push(`<text x="${(x(si) - 14).toFixed(1)}" y="${(yPanel(k[si]!, stT, stB) + (buy ? -12 : 20)).toFixed(1)}" fill="${AMBER}" font-size="18" font-weight="700" text-anchor="end">%K ${buy ? 'up' : 'down'} ${meta.stochLevel}</text>`);
    }
    if (ri >= 0 && rs[ri] != null) {
      s.push(`<circle cx="${x(ri).toFixed(1)}" cy="${yPanel(rs[ri]!, rsT, rsB).toFixed(1)}" r="8" fill="none" stroke="${AMBER}" stroke-width="3"/>`);
      s.push(`<text x="${(x(ri) - 14).toFixed(1)}" y="${(yPanel(rs[ri]!, rsT, rsB) + (buy ? -12 : 20)).toFixed(1)}" fill="${AMBER}" font-size="18" font-weight="700" text-anchor="end">RSI ${buy ? 'up' : 'down'} ${meta.rsiLevel}</text>`);
    }
  }

  // ---- entry arrow (before the trade) or entry / exit marks (after it)
  const lastC = cs[n - 1];
  if (!tr) {
    const sig = sigIdx >= 0 ? cs[sigIdx] : lastC;
    const ax = x(Math.max(sigIdx, 0) + 1), cy = y(sig.close);
    s.push(`<line x1="${x(Math.max(sigIdx, 0)).toFixed(1)}" y1="${cy.toFixed(1)}" x2="${ax.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${colour}" stroke-width="2" stroke-dasharray="3 6" opacity=".6"/>`);
    const label = `${buy ? 'BUY' : 'SELL'}${o.ok ? '' : ' (skipped)'}`;
    if (buy) {
      const tip = cy - 40;
      s.push(`<path d="M${ax.toFixed(1)} ${tip.toFixed(1)} l-20 28 h13 v34 h14 v-34 h13 z" fill="${colour}"/>`);
      s.push(`<text x="${ax.toFixed(1)}" y="${(tip - 34).toFixed(1)}" fill="${colour}" font-size="26" font-weight="800" text-anchor="middle">${label}</text>`);
      s.push(`<text x="${ax.toFixed(1)}" y="${(tip - 10).toFixed(1)}" fill="${DIM}" font-size="17" text-anchor="middle">next open</text>`);
    } else {
      const tip = cy + 40;
      s.push(`<path d="M${ax.toFixed(1)} ${tip.toFixed(1)} l-20 -28 h13 v-34 h14 v34 h13 z" fill="${colour}"/>`);
      s.push(`<text x="${ax.toFixed(1)}" y="${(tip + 34).toFixed(1)}" fill="${colour}" font-size="26" font-weight="800" text-anchor="middle">${label}</text>`);
      s.push(`<text x="${ax.toFixed(1)}" y="${(tip + 58).toFixed(1)}" fill="${DIM}" font-size="17" text-anchor="middle">next open</text>`);
    }
  } else {
    const xa = Math.max(L + 40, Math.min(maxRight - 8, xt(tr.time)));
    const xb = Math.max(xa + 8, Math.min(maxRight, xt(tr.time + tr.expirySec)));
    const ey = y(tr.price);
    s.push(`<line x1="${xa.toFixed(1)}" y1="${ey.toFixed(1)}" x2="${Math.max(xb, xa + 8).toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${colour}" stroke-width="2.4" stroke-dasharray="4 5"/>`);
    s.push(`<circle cx="${xa.toFixed(1)}" cy="${ey.toFixed(1)}" r="8" fill="${colour}"/>`);
    s.push(`<text x="${(xa - 12).toFixed(1)}" y="${(ey + (buy ? 34 : -20)).toFixed(1)}" fill="${colour}" font-size="24" font-weight="800" text-anchor="end">${buy ? 'BUY' : 'SELL'} ${tr.price.toFixed(dec)}</text>`);
    if (tr.result && tr.result !== 'PENDING') {
      // the broker's result is the truth; the exit price is drawn only when it is known (otherwise the tag sits on the entry line and no price is invented)
      const xy = tr.exitPrice != null ? y(tr.exitPrice) : ey, rc = tr.result === 'WIN' ? GREEN : tr.result === 'LOSS' ? RED : AMBER;
      s.push(`<circle cx="${xb.toFixed(1)}" cy="${xy.toFixed(1)}" r="9" fill="${BG}" stroke="${rc}" stroke-width="4"/>`);
      const tx = Math.min(xb, R - 70), ty = Math.max(top + 40, Math.min(xy, ey) - 52);
      s.push(`<rect x="${(tx - 62).toFixed(1)}" y="${(ty - 30).toFixed(1)}" width="124" height="42" rx="10" fill="${BG}" stroke="${rc}" stroke-width="3"/>`);
      s.push(`<text x="${tx.toFixed(1)}" y="${(ty - 2).toFixed(1)}" fill="${rc}" font-size="26" font-weight="800" text-anchor="middle">${tr.result}</text>`);
      if (tr.exitPrice != null) s.push(`<text x="${Math.min(xb + 12, W - 110).toFixed(1)}" y="${(xy + 6).toFixed(1)}" fill="${rc}" font-size="19" font-weight="700">${tr.exitPrice.toFixed(dec)}</text>`);
    } else {
      s.push(`<text x="${Math.max(xb, xa + 8).toFixed(1)}" y="${(ey - 14).toFixed(1)}" fill="${AMBER}" font-size="20" font-weight="700">trade running</text>`);
    }
  }

  // current price tag on the axis
  const cyLast = y(lastC.close);
  s.push(`<rect x="${R + 4}" y="${(cyLast - 15).toFixed(1)}" width="120" height="30" rx="6" fill="#0d2238" stroke="${CYAN}" stroke-width="1.5"/>`);
  s.push(`<text x="${R + 64}" y="${(cyLast + 7).toFixed(1)}" fill="${CYAN}" font-size="19" font-weight="700" text-anchor="middle">${lastC.close.toFixed(dec)}</text>`);

  // ---- title block (the full screenshot only)
  if (!compact) {
    const sig = sigIdx >= 0 ? cs[sigIdx] : lastC;
    s.push(`<text x="${W / 2}" y="58" fill="${o.ok ? TXT : colour}" font-size="29" font-weight="700" text-anchor="middle">${esc(indicatorTitle(o))}</text>`);
    const when = new Date(sig.time * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    const tfl = o.tf < 60 ? `${o.tf}s` : `${Math.floor(o.tf / 60)}m`;
    s.push(`<text x="${W / 2}" y="98" fill="${DIM}" font-size="23" text-anchor="middle">${esc(o.market)} \u00b7 ${esc(o.symbol)} \u00b7 ${tfl} \u00b7 last closed candle ${when}</text>`);
    const why = o.ok ? ((o.notes ?? []).filter((t) => !/next candle open/.test(t)).join('; ') || 'confirmed') : (o.block || 'no candle pattern confirms the trigger');
    s.push(`<text x="${W / 2}" y="132" fill="${colour}" font-size="${why.length > 90 ? 17 : 21}" font-weight="600" text-anchor="middle">${o.ok ? 'TAKE' : 'SKIP'}: ${esc(why)}</text>`);
    const rule = indicatorRule(o.side), cut = rule.lastIndexOf(';');
    s.push(`<text x="${L}" y="${H - 40}" fill="${DIM}" font-size="16">${esc(rule.slice(0, cut + 1))}</text>`);
    s.push(`<text x="${L}" y="${H - 18}" fill="${DIM}" font-size="16">${esc(rule.slice(cut + 1).trim())}</text>`);
  }
  s.push('</svg>');
  return s.join('\n');
}
