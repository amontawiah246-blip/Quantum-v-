// SINGLE CENTRAL CONFIGURATION MODULE FOR GLOBAL TIMEFRAME & TRADE EXPIRY.
//
// All agents, strategy engines, market structure bias tracking, LSCC, AI prompts,
// chart screenshots, historical fetches, and backtesting read from this module.
// No module is allowed to silently override tfSec or expirySec.

export const BROKER_TIMEFRAMES = [60, 120, 180, 300, 600, 900, 1800, 3600] as const;
export type BrokerTimeframeSec = (typeof BROKER_TIMEFRAMES)[number];

export const BROKER_EXPIRIES = [15, 30, 60, 120, 180, 240, 300, 600, 900, 1800, 3600] as const;
export type BrokerExpirySec = (typeof BROKER_EXPIRIES)[number];

export interface TimingOption {
  sec: number;
  label: string;
  description: string;
}

export const BROKER_TIMEFRAME_OPTIONS: TimingOption[] = [
  { sec: 60, label: '1m', description: '1 Minute (M1)' },
  { sec: 120, label: '2m', description: '2 Minutes (M2)' },
  { sec: 180, label: '3m', description: '3 Minutes (M3)' },
  { sec: 300, label: '5m', description: '5 Minutes (M5)' },
  { sec: 600, label: '10m', description: '10 Minutes (M10)' },
  { sec: 900, label: '15m', description: '15 Minutes (M15)' },
  { sec: 1800, label: '30m', description: '30 Minutes (M30)' },
  { sec: 3600, label: '1h', description: '1 Hour (H1)' },
];

export const BROKER_EXPIRY_OPTIONS: TimingOption[] = [
  { sec: 15, label: '15s', description: '15 Seconds' },
  { sec: 30, label: '30s', description: '30 Seconds' },
  { sec: 60, label: '1m', description: '1 Minute' },
  { sec: 120, label: '2m', description: '2 Minutes' },
  { sec: 180, label: '3m', description: '3 Minutes' },
  { sec: 240, label: '4m', description: '4 Minutes' },
  { sec: 300, label: '5m', description: '5 Minutes' },
  { sec: 600, label: '10m', description: '10 Minutes' },
  { sec: 900, label: '15m', description: '15 Minutes' },
  { sec: 1800, label: '30m', description: '30 Minutes' },
  { sec: 3600, label: '1h', description: '1 Hour' },
];

export function formatTimingLabel(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s';
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.round(sec)}s`;
}

export function isSupportedTimeframe(tfSec: number): tfSec is BrokerTimeframeSec {
  return Number.isInteger(tfSec) && (BROKER_TIMEFRAMES as readonly number[]).includes(tfSec);
}

export function isSupportedExpiry(expirySec: number): expirySec is BrokerExpirySec {
  return Number.isInteger(expirySec) && (BROKER_EXPIRIES as readonly number[]).includes(expirySec);
}

export function validateTimeframe(tfSec: number): BrokerTimeframeSec {
  if (!isSupportedTimeframe(tfSec)) {
    throw new Error(
      `Unsupported broker chart timeframe ${tfSec}s. Supported granularities: ${BROKER_TIMEFRAMES.map((s) => `${formatTimingLabel(s)} (${s}s)`).join(', ')}.`
    );
  }
  return tfSec;
}

export function validateExpiry(expirySec: number): BrokerExpirySec {
  if (!isSupportedExpiry(expirySec)) {
    throw new Error(
      `Unsupported broker trade expiry ${expirySec}s. Supported durations: ${BROKER_EXPIRIES.map((s) => `${formatTimingLabel(s)} (${s}s)`).join(', ')}.`
    );
  }
  return expirySec;
}

export interface GlobalTimingState {
  tfSec: BrokerTimeframeSec;
  expirySec: BrokerExpirySec;
  syncVersion: number;
  transitioning: boolean;
  transitionStartedAt: number | null;
  lastSyncedAt: number | null;
  requiredAgents: string[];
  syncedAgents: string[];
  pendingAgents: string[];
  updatedAt: number;
}

export interface TradeGateCheck {
  ok: boolean;
  reason: string;
  transitioning: boolean;
  syncVersion: number;
  pendingCount: number;
  tfSec: number;
  expirySec: number;
}

type TimingListener = (state: GlobalTimingState) => void;

function readInitialTf(): BrokerTimeframeSec {
  try {
    const raw = typeof process !== 'undefined' ? Number(process.env?.SWEEP_TF) : NaN;
    if (isSupportedTimeframe(raw)) return raw;
  } catch { /* ignore */ }
  return 60;
}

function readInitialExpiry(): BrokerExpirySec {
  try {
    const raw = typeof process !== 'undefined' ? Number(process.env?.DEFAULT_EXPIRY_SEC) : NaN;
    if (isSupportedExpiry(raw)) return raw;
  } catch { /* ignore */ }
  return 60;
}

class CentralTimingConfig {
  private tfSec: BrokerTimeframeSec = readInitialTf();
  private expirySec: BrokerExpirySec = readInitialExpiry();
  private syncVersion = 1;
  private transitioning = false;
  private transitionStartedAt: number | null = null;
  private lastSyncedAt: number | null = Date.now();
  private requiredAgents = new Set<string>();
  private syncedAgents = new Set<string>();
  private updatedAt = Date.now();
  private listeners = new Set<TimingListener>();

  getSnapshot(): GlobalTimingState {
    const required = [...this.requiredAgents];
    const synced = [...this.syncedAgents];
    const pending = required.filter((s) => !this.syncedAgents.has(s));
    return {
      tfSec: this.tfSec,
      expirySec: this.expirySec,
      syncVersion: this.syncVersion,
      transitioning: this.transitioning,
      transitionStartedAt: this.transitionStartedAt,
      lastSyncedAt: this.lastSyncedAt,
      requiredAgents: required,
      syncedAgents: synced,
      pendingAgents: pending,
      updatedAt: this.updatedAt,
    };
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        /* listener errors must not break config propagation */
      }
    }
  }

  subscribe(fn: TimingListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  registerRequiredAgents(symbols: string[], markCurrentlySynced = true): GlobalTimingState {
    this.requiredAgents = new Set(symbols.filter(Boolean));
    if (markCurrentlySynced && !this.transitioning) {
      this.syncedAgents = new Set(this.requiredAgents);
      this.lastSyncedAt = Date.now();
    } else {
      for (const s of [...this.syncedAgents]) {
        if (!this.requiredAgents.has(s)) this.syncedAgents.delete(s);
      }
      if (this.transitioning && this.requiredAgents.size > 0 && this.syncedAgents.size >= this.requiredAgents.size) {
        this.transitioning = false;
        this.lastSyncedAt = Date.now();
      }
    }
    this.updatedAt = Date.now();
    this.emit();
    return this.getSnapshot();
  }

  setTiming(next: { tfSec?: number; expirySec?: number; forceTransition?: boolean }): GlobalTimingState {
    const nextTf = next.tfSec !== undefined ? validateTimeframe(next.tfSec) : this.tfSec;
    const nextExpiry = next.expirySec !== undefined ? validateExpiry(next.expirySec) : this.expirySec;
    const tfChanged = nextTf !== this.tfSec || !!next.forceTransition;
    const expiryChanged = nextExpiry !== this.expirySec;

    if (!tfChanged && !expiryChanged) {
      return this.getSnapshot();
    }

    this.tfSec = nextTf;
    this.expirySec = nextExpiry;
    this.updatedAt = Date.now();

    if (tfChanged) {
      this.syncVersion += 1;
      if (this.requiredAgents.size > 0) {
        this.transitioning = true;
        this.transitionStartedAt = Date.now();
        this.syncedAgents.clear();
      } else {
        this.transitioning = false;
        this.lastSyncedAt = Date.now();
      }
    }

    this.emit();
    return this.getSnapshot();
  }

  markAgentSynced(symbol: string, syncVersion: number): GlobalTimingState {
    if (syncVersion !== this.syncVersion) {
      return this.getSnapshot();
    }
    if (!this.requiredAgents.has(symbol)) {
      this.requiredAgents.add(symbol);
    }
    this.syncedAgents.add(symbol);
    this.updatedAt = Date.now();
    if (this.transitioning && this.requiredAgents.size > 0) {
      let allSynced = true;
      for (const req of this.requiredAgents) {
        if (!this.syncedAgents.has(req)) {
          allSynced = false;
          break;
        }
      }
      if (allSynced) {
        this.transitioning = false;
        this.lastSyncedAt = Date.now();
      }
    }
    this.emit();
    return this.getSnapshot();
  }

  canExecuteTrade(): TradeGateCheck {
    const snap = this.getSnapshot();
    if (snap.transitioning) {
      return {
        ok: false,
        reason: `Configuration transition in progress: waiting for ${snap.pendingAgents.length} agent(s) to sync to ${formatTimingLabel(snap.tfSec)}`,
        transitioning: true,
        syncVersion: snap.syncVersion,
        pendingCount: snap.pendingAgents.length,
        tfSec: snap.tfSec,
        expirySec: snap.expirySec,
      };
    }
    return {
      ok: true,
      reason: 'Synchronized',
      transitioning: false,
      syncVersion: snap.syncVersion,
      pendingCount: 0,
      tfSec: snap.tfSec,
      expirySec: snap.expirySec,
    };
  }

  applyRemoteSnapshot(remote: Partial<GlobalTimingState>): void {
    const tf = remote.tfSec !== undefined && isSupportedTimeframe(remote.tfSec) ? remote.tfSec : this.tfSec;
    const exp = remote.expirySec !== undefined && isSupportedExpiry(remote.expirySec) ? remote.expirySec : this.expirySec;
    const changed =
      tf !== this.tfSec ||
      exp !== this.expirySec ||
      remote.transitioning !== this.transitioning ||
      remote.syncVersion !== this.syncVersion;
    this.tfSec = tf;
    this.expirySec = exp;
    if (typeof remote.syncVersion === 'number') this.syncVersion = remote.syncVersion;
    if (typeof remote.transitioning === 'boolean') this.transitioning = remote.transitioning;
    if (Array.isArray(remote.requiredAgents)) this.requiredAgents = new Set(remote.requiredAgents);
    if (Array.isArray(remote.syncedAgents)) this.syncedAgents = new Set(remote.syncedAgents);
    if (remote.transitionStartedAt !== undefined) this.transitionStartedAt = remote.transitionStartedAt;
    if (remote.lastSyncedAt !== undefined) this.lastSyncedAt = remote.lastSyncedAt;
    this.updatedAt = remote.updatedAt ?? Date.now();
    if (changed) this.emit();
  }

  resetForTests(opts: { tfSec?: number; expirySec?: number; requiredAgents?: string[] } = {}): GlobalTimingState {
    this.tfSec = opts.tfSec !== undefined ? validateTimeframe(opts.tfSec) : 60;
    this.expirySec = opts.expirySec !== undefined ? validateExpiry(opts.expirySec) : 60;
    this.syncVersion = 1;
    this.transitioning = false;
    this.transitionStartedAt = null;
    this.lastSyncedAt = Date.now();
    this.requiredAgents = new Set(opts.requiredAgents ?? []);
    this.syncedAgents = new Set(opts.requiredAgents ?? []);
    this.updatedAt = Date.now();
    this.emit();
    return this.getSnapshot();
  }
}

export const centralTimingConfig = new CentralTimingConfig();

export const getGlobalTiming = (): GlobalTimingState => centralTimingConfig.getSnapshot();
export const setGlobalTiming = (next: { tfSec?: number; expirySec?: number; forceTransition?: boolean }) =>
  centralTimingConfig.setTiming(next);
export const registerRequiredAgents = (symbols: string[], markCurrentlySynced = true) =>
  centralTimingConfig.registerRequiredAgents(symbols, markCurrentlySynced);
export const markAgentSynced = (symbol: string, syncVersion: number) =>
  centralTimingConfig.markAgentSynced(symbol, syncVersion);
export const canExecuteTrade = (): TradeGateCheck => centralTimingConfig.canExecuteTrade();
export const isConfigTransitioning = (): boolean => centralTimingConfig.getSnapshot().transitioning;
export const subscribeGlobalTiming = (fn: TimingListener): (() => void) => centralTimingConfig.subscribe(fn);
export const applyRemoteGlobalTiming = (remote: Partial<GlobalTimingState>): void =>
  centralTimingConfig.applyRemoteSnapshot(remote);
export const resetGlobalTimingForTests = (opts?: { tfSec?: number; expirySec?: number; requiredAgents?: string[] }) =>
  centralTimingConfig.resetForTests(opts);

// ---------------- Closed-candle & cross-market timestamp synchronization helpers ----------------

/** Returns the expected open timestamp (seconds) of the latest fully CLOSED candle on tfSec grid. */
export function latestClosedCandleOpen(nowSec: number, tfSec: number, settleDelaySec = 2): number {
  const effectiveNow = nowSec - settleDelaySec;
  return Math.floor(effectiveNow / tfSec) * tfSec - tfSec;
}

/** True strictly when candle is explicitly not open/forming and its full period has elapsed by nowSec. */
export function isCandleClosed(
  candleOpenSec: number,
  tfSec: number,
  nowSec: number,
  closedFlag?: boolean
): boolean {
  if (closedFlag === false) return false;
  return candleOpenSec + tfSec <= nowSec;
}

/** Filters any series strictly to chronological, completed/closed candles with no forming tail. */
export function filterClosedCandles<T extends { time: number; closed?: boolean }>(
  candles: readonly T[],
  tfSec: number,
  nowSec: number
): T[] {
  const out: T[] = [];
  for (const c of candles) {
    if (!Number.isFinite(c.time)) continue;
    if (!isCandleClosed(c.time, tfSec, nowSec, c.closed)) continue;
    if (out.length > 0 && c.time <= out[out.length - 1].time) continue;
    out.push(c);
  }
  return out;
}

/** Checks whether all market candle streams share an aligned candle open grid on the active tfSec. */
export function areMarketTimestampsSynchronized(
  marketLastCandles: ReadonlyArray<{ symbol: string; lastCandle: number | null }>,
  tfSec: number,
  maxSkewPeriods = 1
): { synchronized: boolean; alignedTo: number | null; laggedSymbols: string[] } {
  const valid = marketLastCandles.filter((m): m is { symbol: string; lastCandle: number } => typeof m.lastCandle === 'number' && m.lastCandle > 0);
  if (valid.length === 0) return { synchronized: false, alignedTo: null, laggedSymbols: [] };
  const newest = Math.max(...valid.map((m) => m.lastCandle));
  const lagged = valid
    .filter((m) => newest - m.lastCandle > maxSkewPeriods * tfSec || m.lastCandle % tfSec !== newest % tfSec)
    .map((m) => m.symbol);
  return {
    synchronized: lagged.length === 0,
    alignedTo: newest,
    laggedSymbols: lagged,
  };
}
