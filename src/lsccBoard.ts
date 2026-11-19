// What the LSCC screen shows for every liquidity-sweep setup the market agents are tracking: where it stands (WAITING, BUY, SELL, INVALID, EXPIRED),
// the candles it is made of, the screenshot, what the three engines and the AI answered and what finally happened. Read-only: it decides nothing.
import type { CandidateHub } from './candidateHub';

export type LsccDisplayState = 'LSCC WAITING' | 'LSCC BUY' | 'LSCC SELL' | 'LSCC INVALID' | 'LSCC EXPIRED';
export const LSCC_LABEL: Record<LsccDisplayState, string> = {
  'LSCC WAITING': 'LSCC WAITING — Sweep detected, confirmation pending',
  'LSCC BUY': 'LSCC BUY — Bullish liquidity sweep confirmed',
  'LSCC SELL': 'LSCC SELL — Bearish liquidity sweep confirmed',
  'LSCC INVALID': 'LSCC INVALID — Confirmation failed or setup invalidated',
  'LSCC EXPIRED': 'LSCC EXPIRED — Entry opportunity missed',
};

export interface TrackedLscc { key: string; symbol: string; tf: number; side: 'BUY' | 'SELL'; state: 'WAITING' | 'CONFIRMED' | 'INVALID'; alertId: number; sweepTime: number; level: number; market: string; candidateId: string | null }

export interface LsccCard {
  key: string; market: string; symbol: string; direction: 'BUY' | 'SELL';
  state: LsccDisplayState; label: string; detail: string;
  level: number; sweepCandle: number; confirmationCandle: number | null; entryCandle: number | null;
  screenshotAlertId: number; candidateId: string | null;
  engines: { engine: string; status: string }[];
  ai: string | null;
  execution: 'NOT_CONFIRMED' | 'PENDING' | 'EXECUTED' | 'REJECTED' | 'MISSED' | 'INVALID';
}

export function lsccCards(tracked: TrackedLscc[], hub: CandidateHub, nowSec: number, maxEntryDelaySec: number): LsccCard[] {
  return tracked.map((t) => {
    const base = { key: t.key, market: t.market, symbol: t.symbol, direction: t.side, level: t.level, sweepCandle: t.sweepTime, screenshotAlertId: t.alertId, candidateId: t.candidateId };
    if (t.state === 'WAITING') return { ...base, state: 'LSCC WAITING' as const, label: LSCC_LABEL['LSCC WAITING'], detail: 'waiting for the next candle to confirm', confirmationCandle: null, entryCandle: null, engines: [], ai: null, execution: 'NOT_CONFIRMED' as const };
    if (t.state === 'INVALID') return { ...base, state: 'LSCC INVALID' as const, label: LSCC_LABEL['LSCC INVALID'], detail: 'confirmation failed', confirmationCandle: null, entryCandle: null, engines: [], ai: null, execution: 'INVALID' as const };
    const rec = t.candidateId ? hub.get(t.candidateId) : undefined;
    const ev = rec?.versions[0];
    const confirm = ev?.lscc?.confirmTime ?? null, entry = ev?.lscc?.entryTime ?? null;
    const engines = (rec?.results ?? []).filter((r: any) => r.kind === 'engine' && r.version === 1).map((r: any) => ({ engine: r.engine, status: r.status }));
    const aiRes: any = (rec?.results ?? []).find((r: any) => r.kind === 'ai');
    const ai = aiRes ? (aiRes.status === 'DONE' && aiRes.answer ? (aiRes.answer.tradeable ? 'APPROVED' : `NOT APPROVED (${aiRes.answer.status})`) : aiRes.status) : null;
    let execution: LsccCard['execution'] = 'PENDING', state: LsccDisplayState = t.side === 'BUY' ? 'LSCC BUY' : 'LSCC SELL', detail = 'confirmed';
    if (!rec) { execution = 'PENDING'; }
    else if (rec.executed) { execution = 'EXECUTED'; detail = 'order placed on the entry candle'; }
    else if (rec.status === 'INVALIDATED') { state = 'LSCC INVALID'; execution = 'INVALID'; detail = rec.invalidReason ?? 'setup invalidated'; }
    else if (ev && nowSec - ev.signalCandleClose > maxEntryDelaySec) { state = 'LSCC EXPIRED'; execution = 'MISSED'; detail = `no order within ${maxEntryDelaySec}s of the confirmation candle closing: the entry was missed and is never taken late`; }
    else if (rec.decision && rec.decision.action !== 'EXECUTE') { execution = 'REJECTED'; detail = rec.decision.reasons[0] ?? 'rejected'; }
    return { ...base, state, label: LSCC_LABEL[state], detail, confirmationCandle: confirm, entryCandle: entry, engines, ai, execution };
  });
}
