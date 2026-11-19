// AI VERIFICATION: what the model is asked, how its answer is read, and how the final decision is made.
//
// Authority split (this is the whole point of the module):
//   * PATTERN VALIDITY is decided by plain OHLC arithmetic (src/patternVerification.ts). The AI re-checks the same rules on the
//     screenshot + numbers, but it may only dispute a rule id from the original strategy list. Anything else it objects to
//     (engulfing, weak momentum, chop, "not high probability") is demoted to a warning and can never invalidate the pattern.
//   * MARKET QUALITY (src/marketQuality.ts + the AI's read of the context) only ranks the setup and adds warnings.
//   * If the AI cannot answer (no key, rate limit, network, bad reply) the result is AI_UNAVAILABLE. Nothing here ever invents an approval.
//   * The execution controller (decideExecution) turns a decision into "may a trade be placed", using the user's configured policy.
import { createHash } from 'node:crypto';
import type { Condition } from './conditions';
import type { MarketQuality } from './marketQuality';
import { PatternVerification, RULE_TEXT, Bar, Side } from './patternVerification';
import type { HybridGateResult } from './hybridGate';
import { getGlobalTiming } from './globalConfig';
import { STOCH_RSI_DEFAULTS, computeStochRsi } from './stochRsi';

export type Decision = 'APPROVED' | 'VALID_WITH_RISK' | 'REJECTED' | 'REVIEW' | 'AI_UNAVAILABLE';
export type ScreenshotStatus = 'VERIFIED' | 'NOT_SENT' | 'NOT_INSPECTED' | 'MISMATCH' | 'STALE';

// ------------------------------------------------------------------------------------------------ transport types
export interface ScreenshotImage {
  mimeType: 'image/png';
  base64: string;
  sha256: string;
  /** open time of the last candle drawn in the image (must equal the signal candle) */
  lastCandleTime: number;
  lastCandleLabel: string;
  renderedAt: number;
  /** hash of the OHLC rows the image was drawn from, the same rows the numeric data carries */
  candleSetHash: string;
}

export interface AiRequest {
  requestId: string;
  system: string;
  prompt: string;
  image: ScreenshotImage | null;
  /** rule ids the AI is allowed to dispute */
  ruleIds: string[];
  signalCandleTime: number;
  expectedCandleLabel: string;
}

/** `imageSent` is set by the transport from the request it REALLY built. It is the only proof that the model was given the picture. */
export interface AiCallResult { text: string; imageSent: boolean }
export type AiCaller = (req: AiRequest) => Promise<AiCallResult>;

export type UnavailableKind = 'NO_KEY' | 'RATE_LIMITED' | 'HTTP_ERROR' | 'NETWORK' | 'TIMEOUT' | 'BLOCKED' | 'EMPTY' | 'BAD_RESPONSE' | 'WRONG_REQUEST' | 'NOT_CONFIGURED';
export class AiUnavailableError extends Error {
  constructor(public kind: UnavailableKind, message: string) { super(message); this.name = 'AiUnavailableError'; }
}

// ------------------------------------------------------------------------------------------------ policy
export interface ExecutionPolicy {
  /** what to do when the AI cannot verify: 'block' (default) or 'allow_engine_only' (must be set explicitly by the user) */
  aiUnavailable: 'block' | 'allow_engine_only';
  allowValidWithRisk: boolean;
  allowCountertrend: boolean;
  /** without the screenshot actually inspected by the AI, APPROVED / VALID_WITH_RISK setups are not executable */
  requireScreenshot: boolean;
  /** null = max(20 s, half a candle) */
  maxSignalAgeSec: number | null;
}
export const DEFAULT_POLICY: ExecutionPolicy = { aiUnavailable: 'block', allowValidWithRisk: true, allowCountertrend: true, requireScreenshot: true, maxSignalAgeSec: null };

const flag = (v: string | undefined, d: boolean) => (v == null || v === '' ? d : !/^(0|false|no|off)$/i.test(v.trim()));
export function policyFromEnv(env: Record<string, string | undefined> = process.env): ExecutionPolicy {
  const age = Number(env.MAX_SIGNAL_AGE_SEC);
  return {
    aiUnavailable: String(env.AI_UNAVAILABLE_POLICY ?? '').trim().toLowerCase() === 'allow_engine_only' ? 'allow_engine_only' : 'block',
    allowValidWithRisk: flag(env.AI_ALLOW_VALID_WITH_RISK, DEFAULT_POLICY.allowValidWithRisk),
    allowCountertrend: flag(env.AI_ALLOW_COUNTERTREND, DEFAULT_POLICY.allowCountertrend),
    requireScreenshot: flag(env.AI_REQUIRE_SCREENSHOT, DEFAULT_POLICY.requireScreenshot),
    maxSignalAgeSec: Number.isFinite(age) && age > 0 ? age : null,
  };
}
export const maxAgeFor = (p: ExecutionPolicy, tf: number) => p.maxSignalAgeSec ?? Math.max(20, tf * 0.5);

// ------------------------------------------------------------------------------------------------ hashes + labels
export const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export const candleRows = (cs: Bar[]) => cs.map((c) => `${c.time},${c.open},${c.high},${c.low},${c.close}`);
export const candleSetHash = (cs: Bar[]) => sha256(candleRows(cs).join('\n'));
/** the text the screenshot prints for its last candle, so the AI can read it back */
export const candleLabel = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const digits = (s: string) => s.replace(/\D/g, '').slice(0, 12);

// ------------------------------------------------------------------------------------------------ the request
export interface EngineView {
  side: Side;
  confidence: number;
  agree: number;
  reasons: string[];
  indicators?: { strategies: string[]; info?: Record<string, number> } | null;
  pattern?: { patterns: string[] } | null;
}

export interface BuildInput {
  engine: EngineView;
  label: string;
  tf: number;
  expirySec?: number;
  closed: Bar[];
  pattern: PatternVerification;
  quality: MarketQuality;
  condition: Condition | null;
  image: ScreenshotImage | null;
  key: string;
  /** optional hybrid-engine evidence block (src/hybridEvidence.ts). Context for the AI; it adds no strategy rule. */
  hybridSection?: string | null;
}

export const SYSTEM_PROMPT = [
  'You are the verification analyst of a binary-options signal system (using the chart timeframe and trade expiry specified in each request).',
  'You do NOT create, change or add strategy rules. The strategy rules are listed in the request and are the ONLY conditions that can make a pattern invalid.',
  'Never treat any of these as a pattern condition: engulfing the previous candle, strength of the momentum, choppy or sideways surroundings, your own opinion of the probability, the trend direction, the indicators. They belong to MARKET QUALITY and may only produce warnings.',
  'Your job: (1) inspect the supplied evidence yourself (the screenshot, when one is attached, and the OHLC numbers), (2) verify the engine\'s arithmetic, (3) point out genuine contradictions, (4) assess the market context, (5) explain and classify the risk.',
  'Say a pattern is CONTRADICTED only when you can name a rule id from the list whose condition FAILS on the OHLC numbers, and quote the numbers. If evidence is missing or inconsistent, answer INSUFFICIENT_EVIDENCE.',
  'When the engines that fired include stoch_rsi, the strategy is: the Stochastic (14,3,3) and the RSI (14) trigger the setup, and a candle pattern in the last candles must confirm it. The screenshot shows the candles, the Stochastic panel (%K, %D, lines 20 and 80), the RSI panel (lines 30, 50, 70) and the framed candle pattern. Check that what you SEE matches the server readings and the rule list. Do not add, relax or replace any condition of that strategy.',
  'Give a confidence from 0 to 100 for this setup. It must rest ONLY on (a) how clearly the listed strategy rules are met on the screenshot and numbers and (b) the market-condition measurements supplied in the request. It is your read of the setup, not a probability of winning, and you must say what it rests on. Use a low number when the market context is poor, and 0 when a listed rule fails.',
  'Only claim you inspected the screenshot if an image is attached to this request. Answer with JSON only.',
].join('\n');

const SCHEMA = `{
  "requestId": "<echo the requestId>",
  "signalCandleTime": <echo the signalCandleTime number>,
  "pattern": {
    "verdict": "CONFIRMED" | "CONTRADICTED" | "INSUFFICIENT_EVIDENCE",
    "ruleResults": [{"ruleId": "<id from the rule list>", "pass": true|false, "observed": "<numbers you read>"}],
    "failedRuleIds": ["<ids from the rule list that FAIL, empty when CONFIRMED>"],
    "notes": "max 200 characters"
  },
  "market": {
    "regime": "TRENDING_UP" | "TRENDING_DOWN" | "RANGING" | "UNCLEAR",
    "trendRelation": "WITH_TREND" | "COUNTERTREND" | "NEUTRAL",
    "momentum": "SUPPORTIVE" | "CONTRADICTORY" | "MIXED",
    "volatility": "SUITABLE" | "UNSUITABLE",
    "repeatedSweeps": true | false,
    "exhaustionOrContinuation": "EXHAUSTION" | "CONTINUATION" | "NONE",
    "quality": "GOOD" | "FAIR" | "POOR",
    "warnings": ["short contextual warning", ...]
  },
  "screenshot": {
    "inspected": true | false,
    "lastCandleTimeSeen": "<the last-candle time printed in the image, exactly as written, or null>",
    "matchesOhlc": true | false | null,
    "disagreement": "<what differs between image and numbers, or null>"
  },
  "confidence": <integer 0-100: your confidence in THIS setup given the strategy rules and the market condition>,
  "confidenceBasis": "max 200 characters: which listed rules and which market-condition measurements the number rests on",
  "explanation": "max 300 characters",
  "risk": "LOW" | "MEDIUM" | "HIGH"
}`;

export function requestIdFor(key: string, tf: number, signalCandleTime: number, side: Side, setHash: string): string {
  return sha256(`${key}|${tf}|${signalCandleTime}|${side}|${setHash}`).slice(0, 20);
}

/** The Stochastic / RSI readings of the last candles, computed by the server on ALL the candles (the AI only gets 60 rows, which is too short to rebuild the RSI). Context for reading the screenshot. */
export function indicatorEvidence(closed: Bar[], side: Side): string {
  const p = STOCH_RSI_DEFAULTS;
  const s = computeStochRsi(closed.slice(-300) as any, p);
  const n = closed.length > 300 ? 300 : closed.length;
  const rows: string[] = [];
  for (let j = Math.max(1, n - 8); j < n; j++) {
    const c = closed.slice(-300)[j];
    const f = (v: number | null) => (v == null ? 'n/a' : v.toFixed(1));
    rows.push(`${c.time}: %K ${f(s.k[j])}  %D ${f(s.d[j])}  RSI ${f(s.rsi[j])}`);
  }
  return [
    `Indicator strategy parameters: Stochastic (${p.kPeriod},${p.kSmooth},${p.dSmooth}) with lines ${p.oversold}/${p.overbought}; RSI (${p.rsiPeriod}) with lines ${p.rsiBuyLevels.concat(p.rsiSellLevels).filter((v, k, a) => a.indexOf(v) === k).sort((a, b) => a - b).join('/')}.`,
    `BUY needs %K to cross UP through ${p.oversold} and RSI to cross UP through ${p.rsiBuyLevels.join(' or ')}; SELL needs %K to cross DOWN through ${p.overbought} and RSI to cross DOWN through ${p.rsiSellLevels.join(' or ')}. Both crossings within ${p.alignWindow} candle(s), the second one on the signal candle; then a ${side} candle pattern within the last ${p.confirmLookback} candles.`,
    'Server-computed readings of the last candles (oldest first, last row = signal candle):',
    ...rows,
  ].join('\n');
}

export function buildAiRequest(i: BuildInput): AiRequest {
  const rows = i.closed.slice(-60);
  const sig = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const setHash = candleSetHash(rows);
  const signalCandleTime = sig ? sig.time : 0;
  const requestId = requestIdFor(i.key, i.tf, signalCandleTime, i.engine.side, setHash);
  const c = i.condition;
  const ruleIds = i.pattern.allowedRuleIds;

  const strategyRules = ruleIds.map((id) => ({ ruleId: id, condition: RULE_TEXT[id] ?? id }));
  const engineChecks = i.pattern.rules.map((r) => ({ ruleId: r.id, engine: r.engine, serverResult: r.pass ? 'PASS' : 'FAIL', arithmetic: r.detail }));

  const sw = i.closed.slice(-11, -1);
  const marketStructure = c ? {
    support30: c.support, resistance30: c.resistance,
    lastSwingLow10: sw.length ? Math.min(...sw.map((b) => b.low)) : null, lastSwingHigh10: sw.length ? Math.max(...sw.map((b) => b.high)) : null,
    notes: c.notes,
  } : null;

  const dashboard = c ? {
    trend: c.trend, trendStrength0to100: c.trendStrength, rsi14: c.rsi, bollingerPosition0to100: c.bbPos, cci20: c.cci,
    ema13vs34: c.ema.text, volatility: c.volatility,
    priceAction20BarHighLow: `${c.priceAction} (the dashboard's 20-candle high/low measure, NOT the previous-candle sweep the strategy engine uses)`,
  } : 'unavailable: fewer than 40 closed candles';

  const expirySec = i.expirySec ?? getGlobalTiming().expirySec;

  const prompt = [
    `REQUEST ${requestId}`,
    `Market: ${i.label}. Chart Timeframe: ${i.tf}s. Trade Expiry: ${expirySec}s. Binary-options trade proposed: ${i.engine.side}, entry at the open of the candle after the signal candle.`,
    `signalCandleTime: ${signalCandleTime} (${sig ? candleLabel(sig.time) : 'n/a'}). The LAST OHLC row below is the signal candle, already closed.`,
    '',
    '=== A. STRATEGY ENGINE EVIDENCE (this alone decides whether the pattern is valid) ===',
    `Engines that fired: ${i.pattern.claimed.map((x) => `${x.engine}:${x.side}`).join(', ') || 'none of the sweep engines (indicator / candlestick setup)'}`,
    `Engine reasons: ${i.engine.reasons.join(' | ')}`,
    `Swept level: ${i.pattern.sweptLevel ?? 'n/a'}`,
    'The ONLY conditions that can invalidate the pattern (ids you may cite):',
    JSON.stringify(strategyRules, null, 1),
    'Server arithmetic on the OHLC rows (recomputed independently of the engine):',
    JSON.stringify(engineChecks, null, 1),
    ...(i.pattern.claimed.some((x) => x.engine === 'stoch_rsi') ? ['', indicatorEvidence(i.closed, i.engine.side)] : []),
    '',
    '=== B. DASHBOARD MARKET-CONDITION MEASUREMENTS (context only, NOT strategy evidence) ===',
    JSON.stringify(dashboard, null, 1),
    `Indicator votes of the engine: ${i.engine.indicators ? `${i.engine.indicators.strategies.join(', ')} ${JSON.stringify(i.engine.indicators.info ?? {})}` : 'none'}`,
    `Candlestick-engine pattern: ${i.engine.pattern ? i.engine.pattern.patterns.join(', ') : 'none'} (an optional vote of another engine, never a requirement)`,
    `Server market-quality read: regime ${i.quality.regime}, trend alignment ${i.quality.trendAlignment}, indicators ${i.quality.indicatorAlignment.state}, momentum ${i.quality.momentum}, volatility ${i.quality.volatility.state}, previous-candle sweeps in last ${i.quality.repeatedSweeps.window} candles: ${i.quality.repeatedSweeps.count}, grade ${i.quality.grade}.`,
    'Market structure:',
    JSON.stringify(marketStructure),
    '',
    ...(i.hybridSection ? ['=== B2. HYBRID ENGINE EVIDENCE ===', i.hybridSection, ''] : []),
    '=== C. SCREENSHOT ===',
    i.image
      ? `An image is attached. It was drawn from the same candles and feed as the OHLC rows (candle set hash ${i.image.candleSetHash.slice(0, 12)}). Its last candle is printed as "${i.image.lastCandleLabel}". Inspect it, copy that time into lastCandleTimeSeen, and say whether it matches the numbers.`
      : 'NO image is attached to this request. Set screenshot.inspected to false and do not describe any chart.',
    '',
    '=== D. OHLC (time,open,high,low,close; oldest first; epoch seconds UTC) ===',
    ...candleRows(rows),
    '',
    'Reply with JSON only, exactly this shape:',
    SCHEMA,
  ].join('\n');

  return { requestId, system: SYSTEM_PROMPT, prompt, image: i.image, ruleIds, signalCandleTime, expectedCandleLabel: candleLabel(signalCandleTime) };
}

// ------------------------------------------------------------------------------------------------ the answer
export interface AiAssessment {
  requestId: string;
  imageSent: boolean;
  pattern: { verdict: 'CONFIRMED' | 'CONTRADICTED' | 'INSUFFICIENT_EVIDENCE'; failedRuleIds: string[]; ruleResults: { ruleId: string; pass: boolean; observed: string }[]; notes: string };
  market: {
    regime: string; trendRelation: string; momentum: string; volatility: string; repeatedSweeps: boolean;
    exhaustionOrContinuation: string; quality: 'GOOD' | 'FAIR' | 'POOR'; warnings: string[];
  };
  screenshot: { inspected: boolean; lastCandleTimeSeen: string | null; matchesOhlc: boolean | null; disagreement: string | null };
  /** the AI's confidence in the setup (0-100), null when it gave none. Not a win probability. */
  confidence: number | null;
  confidenceBasis: string;
  explanation: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
}

const oneOf = <T extends string>(v: unknown, set: readonly T[], what: string): T => {
  const s = String(v ?? '').toUpperCase();
  if (!(set as readonly string[]).includes(s)) throw new AiUnavailableError('BAD_RESPONSE', `bad ${what} in the AI reply`);
  return s as T;
};
const str = (v: unknown, n: number) => String(v ?? '').slice(0, n);

/** Strict: anything that is not the requested shape, or that answers a different request, is a failed verification (never an approval). */
export function parseAiResponse(text: string, req: AiRequest, imageSent: boolean): AiAssessment {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new AiUnavailableError('BAD_RESPONSE', 'no JSON in the AI reply');
  let j: any;
  try { j = JSON.parse(m[0]); } catch { throw new AiUnavailableError('BAD_RESPONSE', 'the AI reply is not valid JSON'); }
  if (!j || typeof j !== 'object' || !j.pattern || !j.market || !j.screenshot) throw new AiUnavailableError('BAD_RESPONSE', 'the AI reply is missing pattern / market / screenshot');
  if (String(j.requestId ?? '') !== req.requestId || Number(j.signalCandleTime) !== req.signalCandleTime) {
    throw new AiUnavailableError('WRONG_REQUEST', 'the AI reply belongs to a different request or candle (duplicate or stale response)');
  }
  const p = j.pattern, k = j.market, s = j.screenshot;
  const ruleResults = (Array.isArray(p.ruleResults) ? p.ruleResults : []).slice(0, 40).map((r: any) => ({ ruleId: str(r?.ruleId, 60), pass: r?.pass === true, observed: str(r?.observed, 160) }));
  const failed = new Set<string>((Array.isArray(p.failedRuleIds) ? p.failedRuleIds : []).map((x: unknown) => str(x, 60)));
  for (const r of ruleResults) if (!r.pass && r.ruleId) failed.add(r.ruleId);
  return {
    requestId: req.requestId,
    imageSent,
    pattern: { verdict: oneOf(p.verdict, ['CONFIRMED', 'CONTRADICTED', 'INSUFFICIENT_EVIDENCE'] as const, 'pattern verdict'), failedRuleIds: [...failed], ruleResults, notes: str(p.notes, 240) },
    market: {
      regime: str(k.regime, 20), trendRelation: str(k.trendRelation, 20), momentum: str(k.momentum, 20), volatility: str(k.volatility, 20),
      repeatedSweeps: k.repeatedSweeps === true, exhaustionOrContinuation: str(k.exhaustionOrContinuation, 20),
      quality: oneOf(k.quality, ['GOOD', 'FAIR', 'POOR'] as const, 'market quality'),
      warnings: (Array.isArray(k.warnings) ? k.warnings : []).slice(0, 6).map((x: unknown) => str(x, 120)),
    },
    screenshot: {
      inspected: s.inspected === true, lastCandleTimeSeen: s.lastCandleTimeSeen == null ? null : str(s.lastCandleTimeSeen, 60),
      matchesOhlc: typeof s.matchesOhlc === 'boolean' ? s.matchesOhlc : null, disagreement: s.disagreement == null ? null : str(s.disagreement, 200),
    },
    confidence: Number.isFinite(Number(j.confidence)) && j.confidence !== null && j.confidence !== '' ? Math.max(0, Math.min(100, Math.round(Number(j.confidence)))) : null,
    confidenceBasis: str(j.confidenceBasis, 220),
    explanation: str(j.explanation, 320),
    risk: oneOf(j.risk, ['LOW', 'MEDIUM', 'HIGH'] as const, 'risk'),
  };
}

// ------------------------------------------------------------------------------------------------ the decision
export interface Verification {
  decision: Decision;
  enginePatternValidity: { status: PatternVerification['status']; claimedEngines: string[]; rules: PatternVerification['rules']; failedRules: string[]; dataIssues: string[] };
  aiPatternVerification: {
    status: 'CONFIRMED' | 'CONTRADICTED' | 'INSUFFICIENT_EVIDENCE' | 'NOT_PERFORMED';
    /** rule ids of the ORIGINAL strategy that the AI says fail (only these count) */
    authorizedFailedRules: string[];
    /** objections the AI raised that are not strategy rules (engulfing, momentum, chop...). They are warnings, never a rejection. */
    ignoredObjections: string[];
    notes: string;
  };
  marketQuality: MarketQuality & { ai: { quality: string; risk: string; warnings: string[] } | null };
  trendAlignment: MarketQuality['trendAlignment'];
  indicatorAlignment: MarketQuality['indicatorAlignment'];
  countertrendWarning: boolean;
  screenshotVerification: { status: ScreenshotStatus; imageIncluded: boolean; imageSha256: string | null; imageLastCandle: string | null; candleSetHash: string | null; note: string };
  aiRejectionReasons: string[];
  decisionReasons: string[];
  aiAvailable: boolean;
  aiError: { kind: string; message: string } | null;
  /** true only when the model really received the screenshot AND confirmed it matches the numbers */
  visualVerification: boolean;
  explanation: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  /** the AI's confidence in this setup after the server's market-condition ceiling (null = no AI answer). Not a win probability. */
  aiConfidence: number | null;
  aiConfidenceBasis: string;
  signalAgeSec: number;
  cacheHit: boolean;
  execution: { eligible: boolean; reason: string; engineOnly: boolean; policy: ExecutionPolicy };
  /** what the hybrid gate said about this setup (null = not evaluated). It can only lower `execution.eligible`, never raise it. */
  hybrid?: HybridGateResult | null;
  /** id of the AI request (also the id of the cached screenshot served by /api/signal/screenshot/:id) */
  requestId?: string | null;
}

export interface ReconcileInput {
  pattern: PatternVerification;
  quality: MarketQuality;
  request: AiRequest | null;          // null when the AI was not called (invalid pattern, stale, bad data)
  ai: AiAssessment | null;
  aiError: AiUnavailableError | null;
  ageSec: number;
  tf: number;
  policy: ExecutionPolicy;
  cacheHit?: boolean;
}

const rank = { GOOD: 3, FAIR: 2, POOR: 1, UNKNOWN: 2 } as const;

/** The AI's number is capped by the server's own market-condition read: a poor market can never produce a high confidence. */
export function boundedConfidence(raw: number, q: MarketQuality): number {
  let cap = 90;
  if (q.grade === 'POOR') cap = Math.min(cap, 55);
  else if (q.grade === 'FAIR') cap = Math.min(cap, 78);
  if (q.strongCountertrend) cap = Math.min(cap, 62);
  else if (q.countertrendRisk) cap = Math.min(cap, 72);
  if (q.repeatedSweeps.count >= 2) cap = Math.min(cap, 70);
  return Math.max(0, Math.min(cap, Math.round(raw)));
}

export function reconcile(x: ReconcileInput): Verification {
  const { pattern, quality, request, ai, aiError, policy } = x;
  const reasons: string[] = [];
  const maxAge = maxAgeFor(policy, x.tf);
  const stale = x.ageSec > maxAge;

  // --- what the AI said about the pattern, filtered through the ORIGINAL rule list
  const allowed = new Set(pattern.allowedRuleIds);
  const authorizedFailed = ai ? ai.pattern.failedRuleIds.filter((id) => allowed.has(id)) : [];
  const ignored: string[] = [];
  if (ai) {
    for (const id of ai.pattern.failedRuleIds) if (!allowed.has(id)) ignored.push(`"${id}" is not a rule of the strategy`);
    if (ai.pattern.verdict === 'CONTRADICTED' && !authorizedFailed.length) ignored.push(`pattern objection without a strategy rule: ${ai.pattern.notes || ai.explanation || 'no detail'}`.slice(0, 220));
  }
  const aiRejectionReasons = authorizedFailed.map((id) => `AI: rule ${id} fails (${ai!.pattern.ruleResults.find((r) => r.ruleId === id)?.observed || RULE_TEXT[id] || id})`);

  // --- screenshot
  const imageIncluded = !!request?.image;
  let shot: ScreenshotStatus = 'NOT_SENT', shotNote = 'no screenshot was part of the AI request';
  if (request && imageIncluded && ai) {
    if (!ai.imageSent) { shot = 'NOT_SENT'; shotNote = 'the transport did not include the image in the model request'; }
    else if (!ai.screenshot.inspected) { shot = 'NOT_INSPECTED'; shotNote = 'the AI says it did not inspect the image'; }
    else if (!ai.screenshot.lastCandleTimeSeen || digits(ai.screenshot.lastCandleTimeSeen) !== digits(request.expectedCandleLabel) || request.image!.lastCandleTime !== request.signalCandleTime) {
      shot = 'STALE'; shotNote = `image last candle "${ai.screenshot.lastCandleTimeSeen ?? 'unreadable'}" is not the signal candle ${request.expectedCandleLabel}`;
    } else if (ai.screenshot.matchesOhlc === false) { shot = 'MISMATCH'; shotNote = `image and OHLC disagree: ${ai.screenshot.disagreement ?? 'no detail'}`; }
    else if (ai.screenshot.matchesOhlc === null) { shot = 'NOT_INSPECTED'; shotNote = 'the AI did not say whether the image matches the numbers'; }
    else { shot = 'VERIFIED'; shotNote = 'image was attached to the model request, read, and matches the OHLC numbers'; }
  } else if (request && imageIncluded && aiError) { shot = 'NOT_INSPECTED'; shotNote = 'the AI request failed, so nothing was inspected'; }
  else if (request && request.image && !ai) { shot = 'NOT_INSPECTED'; shotNote = 'no AI answer'; }

  // --- decision
  let decision: Decision;
  if (pattern.status === 'INVALID') {
    decision = 'REJECTED';
    reasons.push(`Strategy rule(s) fail on the OHLC data: ${pattern.failedRules.join(', ')}`);
  } else if (pattern.status === 'INSUFFICIENT_EVIDENCE') {
    decision = 'REVIEW';
    reasons.push(`Critical evidence missing or inconsistent: ${pattern.dataIssues.join('; ') || 'no candles'}`);
  } else if (stale) {
    decision = 'REVIEW';
    reasons.push(`Stale signal: ${Math.round(x.ageSec)}s after the candle closed, limit ${Math.round(maxAge)}s`);
  } else if (aiError || !ai) {
    decision = 'AI_UNAVAILABLE';
    reasons.push(`AI verification unavailable (${aiError?.kind ?? 'NOT_CONFIGURED'}): ${aiError?.message ?? 'no AI caller'}. Engine result kept; not visually verified`);
  } else if (shot === 'STALE' || shot === 'MISMATCH') {
    decision = 'REVIEW';
    reasons.push(`Screenshot ${shot}: ${shotNote}`);
  } else if (authorizedFailed.length) {
    decision = 'REVIEW';
    reasons.push(`The AI disputes strategy rule(s) ${authorizedFailed.join(', ')} but the server arithmetic says they pass. A person must look at the chart`);
  } else if (ai.pattern.verdict === 'INSUFFICIENT_EVIDENCE') {
    decision = 'REVIEW';
    reasons.push(`The AI reports insufficient evidence: ${ai.pattern.notes || 'no detail'}`);
  } else if (policy.requireScreenshot && shot !== 'VERIFIED') {
    decision = 'REVIEW';
    reasons.push(`A screenshot is required by the policy but it was not verified (${shot}): ${shotNote}`);
  } else {
    // pattern valid: market quality decides APPROVED vs VALID_WITH_RISK, never validity
    const aiQ = ai.market.quality;
    const worse = rank[aiQ] < rank[quality.grade] ? aiQ : quality.grade;
    const risky = quality.countertrendRisk || quality.indicatorAlignment.state === 'CONTRADICTORY' || quality.momentum === 'CONTRADICTORY'
      || quality.repeatedSweeps.count >= 2 || quality.exhaustionOrContinuation === 'CONTINUATION_SIGNS'
      || worse === 'POOR' || quality.grade === 'UNKNOWN' || ai.risk === 'HIGH' || ai.market.repeatedSweeps;
    decision = risky ? 'VALID_WITH_RISK' : 'APPROVED';
    reasons.push(risky ? 'Pattern is valid; market-quality warnings apply (ranking lowered, pattern unchanged)' : 'Pattern is valid and the market context is acceptable');
  }
  if (shot === 'NOT_SENT' && decision !== 'REJECTED' && decision !== 'REVIEW') reasons.push('No screenshot was inspected: this is NOT a visual verification');

  // --- merged warnings: server measurements + the AI's context read. The AI can add warnings, never remove one.
  const warnings = [...quality.warnings];
  if (ai) {
    for (const w of ai.market.warnings) if (w && !warnings.includes(w)) warnings.push(`AI: ${w}`);
    if (ai.market.trendRelation === 'COUNTERTREND' && !quality.countertrendRisk) warnings.push('AI reads this as COUNTERTREND although the dashboard trend does not');
    for (const g of ignored) warnings.push(`AI objection ignored (${g})`);
  }

  const verification: Verification = {
    decision,
    enginePatternValidity: { status: pattern.status, claimedEngines: pattern.claimed.map((c) => c.engine), rules: pattern.rules, failedRules: pattern.failedRules, dataIssues: pattern.dataIssues },
    aiPatternVerification: {
      status: ai ? ai.pattern.verdict : 'NOT_PERFORMED', authorizedFailedRules: authorizedFailed, ignoredObjections: ignored,
      notes: ai ? ai.pattern.notes : '',
    },
    marketQuality: { ...quality, warnings, ai: ai ? { quality: ai.market.quality, risk: ai.risk, warnings: ai.market.warnings } : null },
    trendAlignment: quality.trendAlignment,
    indicatorAlignment: quality.indicatorAlignment,
    countertrendWarning: quality.countertrendRisk,
    screenshotVerification: {
      status: shot, imageIncluded, imageSha256: request?.image?.sha256 ?? null, imageLastCandle: request?.image?.lastCandleLabel ?? null,
      candleSetHash: request?.image?.candleSetHash ?? null, note: shotNote,
    },
    aiRejectionReasons,
    decisionReasons: reasons,
    aiAvailable: !!ai && !aiError,
    aiError: aiError ? { kind: aiError.kind, message: aiError.message } : null,
    visualVerification: shot === 'VERIFIED',
    explanation: ai ? ai.explanation : '',
    risk: ai ? ai.risk : null,
    aiConfidence: ai && ai.confidence != null && decision !== 'REJECTED' ? boundedConfidence(ai.confidence, quality) : null,
    aiConfidenceBasis: ai ? ai.confidenceBasis : '',
    signalAgeSec: x.ageSec,
    cacheHit: !!x.cacheHit,
    execution: { eligible: false, reason: '', engineOnly: false, policy },
  };
  verification.execution = decideExecution(verification, x.tf);
  return verification;
}

// ------------------------------------------------------------------------------------------------ execution controller
/**
 * The ONE place that says whether a trade may be placed automatically. Callers must obey `eligible`.
 * REJECTED and REVIEW never execute. AI_UNAVAILABLE executes only when the user explicitly configured `allow_engine_only`.
 */
export function decideExecution(v: Verification, tf: number): Verification['execution'] {
  const policy = v.execution.policy;
  const no = (reason: string, engineOnly = false) => ({ eligible: false, reason, engineOnly, policy });
  const maxAge = maxAgeFor(policy, tf);
  if (v.signalAgeSec > maxAge) return no(`stale: ${Math.round(v.signalAgeSec)}s old, limit ${Math.round(maxAge)}s`);
  if (v.enginePatternValidity.status === 'INVALID' || v.enginePatternValidity.status === 'INSUFFICIENT_EVIDENCE') return no('the pattern is not confirmed by the OHLC data');
  switch (v.decision) {
    case 'REJECTED': return no('rejected: a strategy rule fails');
    case 'REVIEW': return no('needs a person to review it; never executed automatically');
    case 'AI_UNAVAILABLE':
      return policy.aiUnavailable === 'allow_engine_only'
        ? { eligible: true, reason: 'AI unavailable; executing on the engine result only because your policy allows it. NOT visually verified', engineOnly: true, policy }
        : no('AI verification unavailable and the policy is "block"');
    case 'VALID_WITH_RISK':
      if (!policy.allowValidWithRisk) return no('policy does not allow VALID_WITH_RISK setups');
      // LSCC exists to trade a genuine liquidity reversal against the prior trend: a valid LSCC is not refused for being countertrend
      if (v.countertrendWarning && !policy.allowCountertrend && !v.enginePatternValidity.claimedEngines.includes('lscc')) return no('policy does not allow countertrend setups');
      break;
    case 'APPROVED': break;
  }
  if (policy.requireScreenshot && v.screenshotVerification.status !== 'VERIFIED') return no(`policy requires a verified screenshot (status ${v.screenshotVerification.status})`);
  return { eligible: true, reason: v.decision === 'APPROVED' ? 'approved' : 'valid with risk, allowed by policy', engineOnly: false, policy };
}

/** Marks a signal as executed so the same candle can never be traded twice (duplicate responses, repeated scans). */
export class ExecutionLedger {
  private seen = new Map<string, number>();
  /** true when the key was already claimed (read-only: scanning must not use up a candle, only an actual order does) */
  has(signalKey: string): boolean { return this.seen.has(signalKey); }
  /** gives a claim back, e.g. when the broker refused the order, so the same candle may be retried */
  release(signalKey: string): void { this.seen.delete(signalKey); }
  claim(signalKey: string, now = Date.now()): boolean {
    if (this.seen.has(signalKey)) return false;
    this.seen.set(signalKey, now);
    if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }
}
