// STAGE 3 RUNTIME: scores a setup with the model that ml/train.py trained and exported. TypeScript only EVALUATES the model (logistic
// regression or LightGBM trees plus a probability calibrator); training, validation and the choice of threshold happen in Python on
// chronologically split data. A cross-language test compares this code with Python's own predictions on the same rows.
//
// There is no hidden fallback: with no model file there is no probability (null). The engine reports that instead of inventing one.
import { readFileSync, existsSync } from 'node:fs';
import { HybridConfig } from './hybridConfig';

export type ModelKind = 'C' | 'D';
export type TreeNode = { v: number } | { f: number; t: number; dl: boolean; mt: 0 | 1 | 2; l: TreeNode; r: TreeNode };   // mt: LightGBM missing_type 0 None, 1 Zero, 2 NaN

export type Calibration = { type: 'none' } | { type: 'platt'; a: number; b: number } | { type: 'isotonic'; x: number[]; y: number[] };

export interface ScoreModelSpec {
  kind: 'logistic' | 'lightgbm';
  featureNames: string[];
  indicatorsUsed: Array<'adx' | 'atr' | 'ema'>;
  logistic?: { intercept: number; coef: number[]; mean: number[]; std: number[]; fill: number[] };
  lightgbm?: { trees: TreeNode[] };
  calibration: Calibration;
  /** calibrated probability needed to trade, chosen on the validation period only. null = no threshold had positive (penalised) validation expectancy: this model never trades. */
  threshold: number | null;
  thresholdNote: string;
  metrics?: Record<string, unknown>;
}

export interface ModelBundle {
  schema: 'quantum-hybrid-model/1';
  createdAt: string;
  modelId: string;
  synthetic: boolean;                       // trained on synthetic data: refused unless config.ml.allowSyntheticModel
  instruments: string[];
  payout: number;
  data: { rows: number; from: number; to: number; splits: Record<string, unknown> };
  models: Partial<Record<ModelKind, ScoreModelSpec>>;
  notes?: string[];
}

const ZERO = 1e-35;
function walk(n: TreeNode, x: number[]): number {
  for (;;) {
    if ('v' in n) return n.v;
    let v = x[n.f];
    if (Number.isNaN(v) && n.mt !== 2) v = 0;
    const missing = (n.mt === 1 && Math.abs(v) <= ZERO) || (n.mt === 2 && Number.isNaN(v));
    n = missing ? (n.dl ? n.l : n.r) : v <= n.t ? n.l : n.r;
  }
}
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => { const q = Math.min(1 - 1e-12, Math.max(1e-12, p)); return Math.log(q / (1 - q)); };

export function calibrate(p: number, c: Calibration): number {
  if (c.type === 'none') return p;
  if (c.type === 'platt') return sigmoid(c.a * logit(p) + c.b);
  const { x, y } = c;
  if (p <= x[0]) return y[0];
  if (p >= x[x.length - 1]) return y[y.length - 1];
  let lo = 0, hi = x.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] <= p) lo = m; else hi = m; }
  return x[hi] === x[lo] ? y[lo] : y[lo] + ((y[hi] - y[lo]) * (p - x[lo])) / (x[hi] - x[lo]);
}

export interface Score { raw: number; probability: number }

export function scoreWith(spec: ScoreModelSpec, features: Record<string, number>): Score {
  const x = spec.featureNames.map((n) => (n in features ? features[n] : NaN));
  let raw: number;
  if (spec.kind === 'logistic') {
    const L = spec.logistic!;
    let z = L.intercept;
    for (let j = 0; j < x.length; j++) { const v = Number.isFinite(x[j]) ? x[j] : L.fill[j]; z += (L.coef[j] * (v - L.mean[j])) / L.std[j]; }
    raw = sigmoid(z);
  } else {
    let s = 0;
    for (const t of spec.lightgbm!.trees) s += walk(t, x);
    raw = sigmoid(s);
  }
  return { raw, probability: calibrate(raw, spec.calibration) };
}

export class HybridModel {
  constructor(readonly bundle: ModelBundle, readonly source = 'memory') {}
  has(kind: ModelKind) { return !!this.bundle.models[kind]; }
  spec(kind: ModelKind) { return this.bundle.models[kind] ?? null; }
  score(kind: ModelKind, features: Record<string, number>): Score | null { const s = this.spec(kind); return s ? scoreWith(s, features) : null; }

  /** Reasons this model cannot be used with this configuration (empty = usable). Never "downgrades" silently. */
  problems(kind: ModelKind, cfg: HybridConfig, symbol?: string): string[] {
    const out: string[] = [];
    const s = this.spec(kind);
    if (!s) return [`no ${kind} model in the file (${this.source})`];
    if (this.bundle.synthetic && !cfg.ml.allowSyntheticModel) out.push('the model was trained on SYNTHETIC data and says nothing about a real market (set ml.allowSyntheticModel to use it for plumbing tests)');
    for (const ind of s.indicatorsUsed) if (!cfg.indicators[ind].enabled) out.push(`the model uses ${ind.toUpperCase()} features but ${ind.toUpperCase()} is switched off: retrain with that indicator disabled`);
    if (Math.abs(this.bundle.payout - cfg.ml.payout) > 0.02) out.push(`trained and thresholded for payout ${this.bundle.payout}, configuration says ${cfg.ml.payout}`);
    if (symbol && !this.bundle.instruments.includes(symbol)) out.push(`instrument ${symbol} was not in the training data (trained on ${this.bundle.instruments.join(', ')})`);
    return out;
  }
}

export function loadModel(path: string): HybridModel | null {
  if (!existsSync(path)) return null;
  const b = JSON.parse(readFileSync(path, 'utf8')) as ModelBundle;
  if (b.schema !== 'quantum-hybrid-model/1') throw new Error(`unsupported model schema ${String(b.schema)} in ${path}`);
  return new HybridModel(b, path);
}
