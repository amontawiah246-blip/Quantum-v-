// Command line for the hybrid layer.
//
//   Build the training/evaluation dataset (features + outcomes) from candles:
//     npx tsx src/hybridCli.ts dataset --csv EURUSD_5m.csv --csv GBPUSD_5m.csv --payout 0.9 --out data/hybrid_dataset.csv
//     npx tsx src/hybridCli.ts dataset --synthetic --instruments 4 --n 30000 --seed 1 --persistence 0 --out data/synth.csv     (plumbing check only)
//   Instrument every rejection and attribute a low signal count:
//     npx tsx src/hybridCli.ts diagnose --csv EURUSD_5m.csv --mode B --out diag.json --log rejects.jsonl [--model models/hybrid_model.json] [--disable adx,atr]
//   CSV: header with time,open,high,low,close (time = epoch seconds, epoch milliseconds or ISO date), 5-minute candles, oldest first.
//   Options: --fine file.csv (finer prices for the matching --csv, same order)  --delay 2  --payout 0.9  --payout-table payouts.json
//   Then train, validate and export the model:   python3 ml/train.py --data data/hybrid_dataset.csv --out models
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { Candle } from './candleMath';
import { Dataset } from './engineBacktest';
import { parseCsv } from './engineBacktestCli';
import { synthCandles } from './syntheticData';
import { hybridConfig, HybridMode } from './hybridConfig';
import { buildDataset, toCsv } from './hybridDataset';
import { HybridEngine } from './hybridEngine';
import { attribute, crossCheckDetectors, renderDiagnostics, stage1Sensitivity, Diagnostics } from './hybridDiagnostics';
import { loadModel } from './hybridModel';

function arg(name: string): string[] {
  const out: string[] = []; const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i] === `--${name}` && a[i + 1] !== undefined) out.push(a[i + 1]);
  return out;
}
const flag = (n: string) => process.argv.includes(`--${n}`);
const ensureDir = (p: string) => mkdirSync(dirname(p), { recursive: true });

function loadData(): { data: Dataset[]; synthetic: boolean } {
  const data: Dataset[] = []; const fines = arg('fine');
  arg('csv').forEach((f, k) => data.push({ symbol: basename(f).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_'), candles: parseCsv(readFileSync(f, 'utf8')), ...(fines[k] ? { fine: parseCsv(readFileSync(fines[k], 'utf8')) } : {}) }));
  const synthetic = flag('synthetic');
  if (synthetic) {
    const k = Number(arg('instruments')[0] ?? 4), n = Number(arg('n')[0] ?? 30000), seed = Number(arg('seed')[0] ?? 1), persistence = Number(arg('persistence')[0] ?? 0);
    for (let j = 0; j < k; j++) data.push({ symbol: `SYNTH${j + 1}`, candles: synthCandles({ n, seed: seed * 1000 + j, tf: 300, persistence }) });
    console.log('*** SYNTHETIC DATA: this checks the machinery only. It says nothing about any real market. ***');
  }
  if (!data.length) { console.error('give --csv file(s) or --synthetic'); process.exit(1); }
  return { data, synthetic };
}

function payoutOpts() {
  const payout = Number(arg('payout')[0] ?? 0.9);
  const tp = arg('payout-table')[0];
  const table: Record<string, number> | null = tp ? JSON.parse(readFileSync(tp, 'utf8')) : null;
  return { payout, payoutFor: table ? (s: string, e: number) => table[`${s}|${e}`] ?? table[s] ?? table['*'] ?? payout : undefined };
}

function main() {
  const cmd = process.argv[2];
  const { data, synthetic } = loadData();
  const { payout, payoutFor } = payoutOpts();
  const disable = (arg('disable')[0] ?? '').split(',').filter(Boolean);
  const cfg = hybridConfig({ ml: { payout } as any, indicators: Object.fromEntries(disable.map((d) => [d, { enabled: false }])) as any });
  if (cmd === 'dataset') {
    const { rows, meta } = buildDataset(data, { cfg, payout, payoutFor, delaySec: Number(arg('delay')[0] ?? 0), synthetic });
    const out = arg('out')[0] ?? 'data/hybrid_dataset.csv';
    ensureDir(out);
    writeFileSync(out, toCsv(rows));
    writeFileSync(out.replace(/\.csv$/, '') + '.meta.json', JSON.stringify(meta, null, 2));
    const by: Record<string, number> = {};
    for (const r of rows) by[r.primary] = (by[r.primary] ?? 0) + 1;
    console.log(`${rows.length} rows written to ${out} (${meta.skippedNoOutcome} setups without a complete outcome were left out)`);
    console.log('rows by primary pattern:', by);
    console.log('next: python3 ml/train.py --data', out, '--out models');
    return;
  }
  if (cmd === 'diagnose') {
    const mode = (arg('mode')[0] ?? 'B') as HybridMode;
    const modelPath = arg('model')[0];
    const model = modelPath ? loadModel(modelPath) : null;
    if (modelPath && !model) throw new Error(`model file ${modelPath} not found`);
    const c2 = hybridConfig({ mode, ml: { payout, allowSyntheticModel: flag('allow-synthetic-model') } as any, indicators: Object.fromEntries(disable.map((d) => [d, { enabled: false }])) as any, log: { maxRecords: Number(arg('log-limit')[0] ?? 200000) } as any });
    const merged = new Diagnostics(300);
    const logPath = arg('log')[0];
    const stream = logPath ? (ensureDir(logPath), createWriteStream(logPath)) : null;
    let sens: ReturnType<typeof stage1Sensitivity> | null = null;
    let cross: ReturnType<typeof crossCheckDetectors> | null = null;
    const sensAcc = new Map<string, { frozen: number; looser: number; d: string }>();
    let crossAcc = { checked: 0, mismatches: [] as string[] };
    for (const ds of data) {
      const eng = new HybridEngine(ds.symbol, c2, model);
      const hits: Array<Set<string>> = [];
      const cs: Candle[] = ds.candles;
      for (const c of cs) { const d = eng.step(c); hits.push(new Set(d.records.flatMap((r) => r.patterns))); }
      // merge counters
      const r = eng.diag.report();
      const h = merged.health, s = r.health;
      for (const k of Object.keys(h) as Array<keyof typeof h>) if (typeof h[k] === 'number' && typeof s[k] === 'number' && k !== 'expectedTfSec' && k !== 'observedTfSec') (h as any)[k] += s[k] as number;
      h.observedTfSec = h.observedTfSec ?? s.observedTfSec;
      merged.candlesEvaluated += r.candlesEvaluated; merged.candlesWithCandidate += r.candlesWithCandidate; merged.candidates += r.candidates; merged.traded += r.traded;
      for (const [k, v] of Object.entries(r.rejectedBy)) (merged.rejectedBy as any)[k] = ((merged.rejectedBy as any)[k] ?? 0) + v;
      for (const [k, v] of Object.entries(r.reasons)) merged.reasons[k] = (merged.reasons[k] ?? 0) + v;
      for (const [k, v] of Object.entries(r.fired)) (merged.fired as any)[k] = ((merged.fired as any)[k] ?? 0) + v;
      for (const [p, m] of Object.entries(r.funnel)) for (const [k, v] of Object.entries(m)) { merged.funnel[p] ??= {}; merged.funnel[p][k] = (merged.funnel[p][k] ?? 0) + v; }
      for (const [p, v] of Object.entries(r.byPattern)) { const b = (merged.byPattern[p] ??= { candidates: 0, traded: 0, rejected: {} }); b.candidates += v.candidates; b.traded += v.traded; for (const [k, n] of Object.entries(v.rejected)) b.rejected[k] = (b.rejected[k] ?? 0) + n; }
      if (stream) for (const rec of eng.log) stream.write(JSON.stringify({ ...rec, iso: new Date(rec.time * 1000).toISOString() }) + '\n');
      const x = crossCheckDetectors(cs, (i) => hits[i]);
      crossAcc.checked += x.checked; crossAcc.mismatches.push(...x.mismatches.map((m) => `${ds.symbol} ${m}`));
      for (const row of stage1Sensitivity(cs)) { const a = sensAcc.get(row.pattern) ?? { frozen: 0, looser: 0, d: row.looserDescription }; a.frozen += row.frozen; a.looser += row.looser; sensAcc.set(row.pattern, a); }
    }
    stream?.end();
    sens = [...sensAcc.entries()].map(([pattern, a]) => ({ pattern, frozen: a.frozen, looser: a.looser, looserDescription: a.d }));
    cross = crossAcc;
    const rep = merged.report();
    const att = attribute(rep, sens, cross);
    console.log(renderDiagnostics(rep, att, sens));
    const out = arg('out')[0];
    if (out) { ensureDir(out); writeFileSync(out, JSON.stringify({ report: rep, attribution: att, sensitivity: sens, crossCheck: cross }, null, 2)); console.log(`\ndiagnostics written to ${out}`); }
    if (logPath) console.log(`one JSON line per candidate setup written to ${logPath}`);
    return;
  }
  console.error('usage: hybridCli.ts dataset|diagnose ...  (see the header of src/hybridCli.ts)');
  process.exit(1);
}

if (process.argv[1] && /hybridCli\.[tj]s$/.test(process.argv[1])) main();
