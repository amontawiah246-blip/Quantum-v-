// DATASET BUILDER for the probability model. One row per (instrument, signal candle, side) that passed Stage 1 and the warm-up. No row is
// dropped because an indicator or a model would have rejected it (that decision belongs to the evaluation in Python, on the same rows).
//
// Features are computed by the same engine code that runs live (HybridEngine), one closed candle at a time, so they cannot contain anything
// after the signal candle. Outcomes are attached afterwards with the execution model of the backtester: the signal exists at the candle
// close, the order is filled at the first available price at or after (close + delaySec), the trade settles `expiry` seconds after the ACTUAL
// fill, BUY wins above the entry, SELL below, equal = tie (stake returned).
import { createHash } from 'node:crypto';
import { Candle, contiguous } from './candleMath';
import { Dataset, cleanCandles, firstAtOrAfter } from './engineBacktest';
import { HYBRID_DEFAULTS, HybridConfig, hybridConfig } from './hybridConfig';
import { ALL_BASE_FEATURES, FEATURE_GROUPS, INDICATOR_GROUPS } from './hybridFeatures';
import { HybridEngine } from './hybridEngine';

export interface DatasetOptions { cfg?: HybridConfig; payout?: number; payoutFor?: (symbol: string, expirySec: number, entryTime: number) => number; delaySec?: number; synthetic?: boolean }
export interface DatasetRow {
  symbol: string; signal_time: number; close_time: number; side: 'BUY' | 'SELL'; primary: string; patterns: string; family: string;
  entry_time: number; settle_time: number; entry: number; exit: number; result: 'win' | 'loss' | 'tie'; payout: number; delay_sec: number;
  ev_adx: string; ev_atr: string; ev_ema: string; quality: number | null; gate_pass: number;
  features: Record<string, number>;
}
export interface DatasetMeta {
  schema: 'quantum-hybrid-dataset/1'; generatedAt: string; synthetic: boolean; tfSec: number; expirySec: number; delaySec: number; payout: number;
  instruments: Array<{ symbol: string; candles: number; from: number; to: number; fingerprint: string; issues: string[] }>;
  rows: number; skippedNoOutcome: number; warmupCandles: number; configChanges: string[]; featureNames: string[];
  featureGroups: Record<string, string[]>; indicatorGroups: string[];
  /** the indicator and gate settings the evidence columns were computed with (the Python gate re-computation must use the same ones) */
  rules: { indicators: HybridConfig['indicators']; gate: HybridConfig['gate'] };
}

export const fingerprint = (cs: Candle[]) => createHash('sha256').update(cs.map((c) => `${c.time},${c.open},${c.high},${c.low},${c.close}`).join('\n')).digest('hex').slice(0, 16);

export function buildDataset(data: Dataset[], o: DatasetOptions = {}): { rows: DatasetRow[]; meta: DatasetMeta } {
  const base = o.cfg ?? hybridConfig();
  const cfg: HybridConfig = { ...base, mode: 'A', log: { ...base.log, keepFeatures: true, maxRecords: Number.MAX_SAFE_INTEGER, collectFunnel: false } };
  const tf = cfg.tfSec, expiry = cfg.expirySec, delay = o.delaySec ?? 0;
  const payoutDefault = o.payout ?? cfg.ml.payout;
  const rows: DatasetRow[] = [];
  const meta: DatasetMeta = {
    schema: 'quantum-hybrid-dataset/1', generatedAt: new Date().toISOString(), synthetic: !!o.synthetic, tfSec: tf, expirySec: expiry, delaySec: delay, payout: payoutDefault,
    instruments: [], rows: 0, skippedNoOutcome: 0, warmupCandles: cfg.warmupCandles, configChanges: [], featureNames: ALL_BASE_FEATURES, featureGroups: FEATURE_GROUPS, indicatorGroups: INDICATOR_GROUPS as string[],
    rules: { indicators: cfg.indicators, gate: cfg.gate },
  };
  const seen = new Map<string, string>();
  const dc = delay / tf;
  for (const ds of data) {
    const { candles: cs, issues } = cleanCandles(ds.candles);
    const fp = fingerprint(cs);
    if (seen.has(fp)) throw new Error(`instruments ${seen.get(fp)} and ${ds.symbol} contain identical candles: duplicate historical observations would leak between train and test`);
    seen.set(fp, ds.symbol);
    meta.instruments.push({ symbol: ds.symbol, candles: cs.length, from: cs[0]?.time ?? 0, to: cs.at(-1)?.time ?? 0, fingerprint: fp, issues });
    const fine = ds.fine ? cleanCandles(ds.fine).candles : null;
    if (!fine && !Number.isInteger(dc)) throw new Error(`delaySec ${delay}s needs a finer price series (fine) unless it is a whole number of ${tf}s candles`);
    const fineTf = fine && fine.length > 1 ? fine[1].time - fine[0].time : 0;

    const eng = new HybridEngine(ds.symbol, cfg, null);
    const index = new Map<number, number>(cs.map((c, k) => [c.time, k]));
    for (const c of cs) {
      const dec = eng.step(c);
      for (const r of dec.records) {
        const i = index.get(r.time)!;
        // ---- outcome with the execution model
        const signalClose = r.time + tf;
        let entry: number, exit: number, execTime: number, settleTime: number;
        if (!fine) {
          const e = i + 1 + dc;
          if (e >= cs.length || cs[e].time - cs[i].time !== (1 + dc) * tf) { meta.skippedNoOutcome++; continue; }
          entry = cs[e].open; exit = cs[e].close; execTime = cs[e].time; settleTime = cs[e].time + tf;
        } else {
          const fe = firstAtOrAfter(fine, signalClose + delay);
          if (fe < 0 || fine[fe].time - (signalClose + delay) > fineTf || i + 1 >= cs.length || !contiguous([cs[i], cs[i + 1]])) { meta.skippedNoOutcome++; continue; }
          execTime = fine[fe].time;
          const fx = firstAtOrAfter(fine, execTime + expiry);
          if (fx < 0 || fine[fx].time - (execTime + expiry) > fineTf) { meta.skippedNoOutcome++; continue; }
          entry = fine[fe].open; exit = fine[fx].open; settleTime = fine[fx].time;
        }
        const up = exit > entry, down = exit < entry;
        const result: DatasetRow['result'] = (r.side === 'BUY' && up) || (r.side === 'SELL' && down) ? 'win' : (r.side === 'BUY' && down) || (r.side === 'SELL' && up) ? 'loss' : 'tie';
        rows.push({
          symbol: ds.symbol, signal_time: r.time, close_time: r.closeTime, side: r.side, primary: r.primary, patterns: r.patterns.join('|'), family: r.family,
          entry_time: execTime, settle_time: settleTime, entry, exit, result, payout: o.payoutFor ? o.payoutFor(ds.symbol, expiry, execTime) : payoutDefault, delay_sec: execTime - signalClose,
          ev_adx: r.stage2.evidence.adx, ev_atr: r.stage2.evidence.atr, ev_ema: r.stage2.evidence.ema, quality: r.stage2.evidence.qualityScore, gate_pass: r.stage2.evidence.gatePass ? 1 : 0,
          features: r.features!,
        });
      }
    }
  }
  rows.sort((a, b) => a.signal_time - b.signal_time || a.symbol.localeCompare(b.symbol) || a.side.localeCompare(b.side));
  // one observation per (instrument, signal candle, side): the engine emits exactly one, this guards against any future change
  const keys = new Set<string>();
  for (const r of rows) { const k = `${r.symbol}|${r.signal_time}|${r.side}`; if (keys.has(k)) throw new Error(`duplicate observation ${k}`); keys.add(k); }
  meta.rows = rows.length; meta.configChanges = eng0(base);
  return { rows, meta };
}
const eng0 = (c: HybridConfig) => new HybridEngine('x', c, null).configChanges;

const META_COLS = ['symbol', 'signal_time', 'close_time', 'side', 'primary', 'patterns', 'family', 'entry_time', 'settle_time', 'entry', 'exit', 'result', 'payout', 'delay_sec', 'ev_adx', 'ev_atr', 'ev_ema', 'quality', 'gate_pass'] as const;
export function toCsv(rows: DatasetRow[]): string {
  const num = (v: unknown) => (typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v === null || v === undefined ? '' : String(v));
  const out = [[...META_COLS, ...ALL_BASE_FEATURES].join(',')];
  for (const r of rows) out.push([...META_COLS.map((k) => num((r as any)[k])), ...ALL_BASE_FEATURES.map((k) => num(r.features[k]))].join(','));
  return out.join('\n') + '\n';
}
