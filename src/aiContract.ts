// THE AI RESPONSE CONTRACT (the verdict shape the project spec asks for), derived from the Verification the pipeline already produces.
//
//   { decision: APPROVE | REJECT | ABSTAIN | RETRY, direction: BUY | SELL | NO_TRADE, pattern_id, visual_match, ohlc_consistency,
//     structure_alignment: ALIGNED | CONFLICTING | UNCLEAR, detected_issues[], reasoning, evidence_timestamp }
//
// Gemini keeps answering in the richer, already-tested schema of src/aiVerification.ts (parseAiResponse rejects anything malformed).
// This module maps that checked answer onto the contract, and `validateAiContract` is a strict schema check that refuses anything else.
// Hard rule enforced in `toAiContract`: APPROVE is only ever produced when every required check passed.
import type { Verification } from './aiVerification';

export type ContractDecision = 'APPROVE' | 'REJECT' | 'ABSTAIN' | 'RETRY';
export interface AiContract {
  decision: ContractDecision;
  direction: 'BUY' | 'SELL' | 'NO_TRADE';
  pattern_id: string;
  visual_match: boolean;
  ohlc_consistency: boolean;
  structure_alignment: 'ALIGNED' | 'CONFLICTING' | 'UNCLEAR';
  detected_issues: string[];
  reasoning: string;
  evidence_timestamp: string;
}

const RETRYABLE = new Set(['RATE_LIMITED', 'HTTP_ERROR', 'NETWORK', 'TIMEOUT', 'EMPTY', 'BAD_RESPONSE', 'WRONG_REQUEST']);

export function toAiContract(v: Verification | null, side: 'BUY' | 'SELL' | null, evidenceAtMs: number): AiContract {
  const stamp = new Date(evidenceAtMs).toISOString();
  if (!v || !side) return { decision: 'ABSTAIN', direction: 'NO_TRADE', pattern_id: 'NONE', visual_match: false, ohlc_consistency: false, structure_alignment: 'UNCLEAR', detected_issues: ['no engine setup'], reasoning: 'The strategy engine found no setup, so nothing was verified.', evidence_timestamp: stamp };

  const issues: string[] = [];
  const shot = v.screenshotVerification;
  const visual = shot.status === 'VERIFIED';
  const ohlc = v.enginePatternValidity.status === 'VALID' && !v.enginePatternValidity.dataIssues.length && shot.status !== 'MISMATCH';
  if (!visual) issues.push(`screenshot ${shot.status}: ${shot.note}`);
  for (const f of v.enginePatternValidity.failedRules) issues.push(`rule fails on the OHLC data: ${f}`);
  for (const d of v.enginePatternValidity.dataIssues) issues.push(`data: ${d}`);
  for (const f of v.aiPatternVerification.authorizedFailedRules) issues.push(`AI disputes rule ${f}`);
  if (v.aiError) issues.push(`AI ${v.aiError.kind}: ${v.aiError.message}`);
  for (const w of v.marketQuality.warnings.slice(0, 4)) issues.push(`warning: ${w}`);
  if (v.hybrid && v.hybrid.disagrees) issues.push(`hybrid: ${v.hybrid.reason}`);

  const align = v.marketQuality.trendAlignment;
  const structure: AiContract['structure_alignment'] = align === 'WITH_TREND' ? 'ALIGNED' : align === 'COUNTERTREND' ? 'CONFLICTING' : 'UNCLEAR';

  let decision: ContractDecision;
  if (v.decision === 'REJECTED') decision = 'REJECT';
  else if (v.decision === 'REVIEW') decision = 'ABSTAIN';
  else if (v.decision === 'AI_UNAVAILABLE') decision = v.aiError && RETRYABLE.has(v.aiError.kind) ? 'RETRY' : 'ABSTAIN';
  else decision = 'APPROVE';
  // the contract rule: no APPROVE while a required check has failed
  if (decision === 'APPROVE' && (!visual || !ohlc || !v.aiAvailable)) decision = 'ABSTAIN';

  return {
    decision, direction: decision === 'APPROVE' ? side : 'NO_TRADE',
    pattern_id: v.enginePatternValidity.claimedEngines.join('+') || 'indicator_or_candlestick',
    visual_match: visual, ohlc_consistency: ohlc, structure_alignment: structure,
    detected_issues: issues.slice(0, 12).map((x) => x.slice(0, 200)), reasoning: (v.explanation || v.decisionReasons.join('. ')).slice(0, 320), evidence_timestamp: stamp,
  };
}

/** Strict schema check: exact keys, exact enums, ISO timestamp. Used by tests and by the log writer. */
export function validateAiContract(x: unknown): { ok: boolean; errors: string[] } {
  const e: string[] = [];
  const o = x as Record<string, unknown>;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, errors: ['not an object'] };
  const keys = ['decision', 'direction', 'pattern_id', 'visual_match', 'ohlc_consistency', 'structure_alignment', 'detected_issues', 'reasoning', 'evidence_timestamp'];
  for (const k of keys) if (!(k in o)) e.push(`missing ${k}`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) e.push(`unexpected ${k}`);
  if (!['APPROVE', 'REJECT', 'ABSTAIN', 'RETRY'].includes(String(o.decision))) e.push('bad decision');
  if (!['BUY', 'SELL', 'NO_TRADE'].includes(String(o.direction))) e.push('bad direction');
  if (typeof o.pattern_id !== 'string' || !o.pattern_id) e.push('bad pattern_id');
  if (typeof o.visual_match !== 'boolean') e.push('bad visual_match');
  if (typeof o.ohlc_consistency !== 'boolean') e.push('bad ohlc_consistency');
  if (!['ALIGNED', 'CONFLICTING', 'UNCLEAR'].includes(String(o.structure_alignment))) e.push('bad structure_alignment');
  if (!Array.isArray(o.detected_issues) || o.detected_issues.some((i) => typeof i !== 'string')) e.push('bad detected_issues');
  if (typeof o.reasoning !== 'string') e.push('bad reasoning');
  if (typeof o.evidence_timestamp !== 'string' || Number.isNaN(Date.parse(o.evidence_timestamp))) e.push('bad evidence_timestamp');
  if (o.decision === 'APPROVE' && (o.direction === 'NO_TRADE' || o.visual_match !== true || o.ohlc_consistency !== true)) e.push('APPROVE while a required check failed');
  if (o.decision !== 'APPROVE' && (o.direction === 'BUY' || o.direction === 'SELL')) e.push('a direction without APPROVE');
  return { ok: e.length === 0, errors: e };
}
