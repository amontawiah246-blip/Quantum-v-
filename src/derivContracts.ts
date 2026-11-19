export interface RiseFallLimit {
  supported: boolean;
  minSec: number;
  maxSec: number;
  reason?: string;
}

export function parseDerivDurationSec(raw: unknown): number {
  const s = String(raw ?? '').trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/);
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  if (unit === 'd') return n * 86400;
  return NaN;
}

export function getRiseFallStaticLimit(symbol: string): RiseFallLimit | null {
  const upper = String(symbol ?? '').trim().toUpperCase();
  if (!upper) return null;
  if (upper.startsWith('BOOM') || upper.startsWith('CRASH')) {
    return {
      supported: false,
      minSec: 0,
      maxSec: 0,
      reason: `${symbol} only supports Accumulators/Multipliers on Deriv, not Rise/Fall`,
    };
  }
  if (upper === '1HZ150V' || upper === '1HZ250V') {
    return {
      supported: false,
      minSec: 0,
      maxSec: 0,
      reason: `${symbol} has no Rise/Fall contracts available on Deriv`,
    };
  }
  if (upper === 'FRXXAUUSD') {
    return { supported: true, minSec: 300, maxSec: 365 * 86400 };
  }
  if (upper === 'WLDXAU') {
    return { supported: true, minSec: 900, maxSec: 36000 };
  }
  return null;
}

export function evaluateRiseFallSupport(
  symbol: string,
  expirySec: number,
  limit?: RiseFallLimit | null,
): { ok: boolean; reason?: string; minSec?: number } {
  const resolvedLimit = limit ?? getRiseFallStaticLimit(symbol);
  if (!resolvedLimit) return { ok: true };
  if (!resolvedLimit.supported) {
    return { ok: false, reason: resolvedLimit.reason || `${symbol} does not support Rise/Fall on Deriv` };
  }
  const sec = Number(expirySec);
  if (Number.isFinite(sec) && sec > 0) {
    if (resolvedLimit.minSec > 0 && sec < resolvedLimit.minSec) {
      const minLabel = resolvedLimit.minSec >= 60 && resolvedLimit.minSec % 60 === 0
        ? `${resolvedLimit.minSec / 60}m`
        : `${resolvedLimit.minSec}s`;
      return {
        ok: false,
        minSec: resolvedLimit.minSec,
        reason: `${symbol} requires at least ${minLabel} expiry for Rise/Fall on Deriv (selected ${sec}s)`,
      };
    }
    if (resolvedLimit.maxSec > 0 && sec > resolvedLimit.maxSec) {
      return {
        ok: false,
        minSec: resolvedLimit.minSec,
        reason: `${symbol} maximum Rise/Fall expiry is ${resolvedLimit.maxSec}s (selected ${sec}s)`,
      };
    }
  }
  return { ok: true, minSec: resolvedLimit.minSec };
}
