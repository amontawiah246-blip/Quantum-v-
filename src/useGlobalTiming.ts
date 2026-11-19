import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "./api";
import {
  BROKER_EXPIRY_OPTIONS,
  BROKER_TIMEFRAME_OPTIONS,
  GlobalTimingState,
  TimingOption,
  applyRemoteGlobalTiming,
  getGlobalTiming,
  subscribeGlobalTiming,
} from "./globalConfig";

export interface UseGlobalTimingResult {
  timing: GlobalTimingState;
  timeframes: TimingOption[];
  expiries: TimingOption[];
  loading: boolean;
  error: string | null;
  updateTiming: (next: { tfSec?: number; expirySec?: number }) => Promise<{ ok: boolean; error?: string }>;
  refresh: () => Promise<void>;
}

// Shared singleton poller so multiple mounted views never fire duplicate /api/config/timing requests
let sharedTimeframes: TimingOption[] = BROKER_TIMEFRAME_OPTIONS;
let sharedExpiries: TimingOption[] = BROKER_EXPIRY_OPTIONS;
let sharedError: string | null = null;
let activeSubscribers = 0;
let activeHttp = "";
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightRefresh: Promise<void> | null = null;
const metaListeners = new Set<() => void>();

function notifyMeta() {
  for (const fn of metaListeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

async function sharedRefresh(http: string): Promise<void> {
  if (!http) return;
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    try {
      const res = await apiFetch(`${http}/api/config/timing`);
      if (!res.ok) return;
      const data = await res.json();
      if (data?.timing) {
        applyRemoteGlobalTiming(data.timing);
      }
      if (Array.isArray(data?.timeframes) && data.timeframes.length) {
        sharedTimeframes = data.timeframes;
      }
      if (Array.isArray(data?.expiries) && data.expiries.length) {
        sharedExpiries = data.expiries;
      }
      sharedError = null;
    } catch (e) {
      sharedError = (e as Error)?.message || "Failed to load global timing config";
    } finally {
      inFlightRefresh = null;
      notifyMeta();
    }
  })();
  return inFlightRefresh;
}

function scheduleSharedPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (activeSubscribers <= 0 || !activeHttp) return;
  const intervalMs = getGlobalTiming().transitioning ? 1200 : 4500;
  pollTimer = setTimeout(async () => {
    await sharedRefresh(activeHttp);
    scheduleSharedPoll();
  }, intervalMs);
}

/**
 * Shared React hook bound directly to the server's Single Central Timing Configuration
 * (/api/config/timing). Every screen, chart, agent matrix, signal generator, and trade panel
 * uses this hook so tfSec and expirySec stay globally consistent without silent per-market overrides.
 */
export function useGlobalTiming(http: string): UseGlobalTimingResult {
  const [timing, setTiming] = useState<GlobalTimingState>(() => getGlobalTiming());
  const [timeframes, setTimeframes] = useState<TimingOption[]>(sharedTimeframes);
  const [expiries, setExpiries] = useState<TimingOption[]>(sharedExpiries);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(sharedError);

  useEffect(() => {
    const unsubTiming = subscribeGlobalTiming((snap) => setTiming(snap));
    const onMeta = () => {
      setTimeframes(sharedTimeframes);
      setExpiries(sharedExpiries);
      setError(sharedError);
    };
    metaListeners.add(onMeta);

    activeSubscribers += 1;
    if (http && http !== activeHttp) {
      activeHttp = http;
    }
    if (activeSubscribers === 1) {
      void sharedRefresh(activeHttp).then(() => scheduleSharedPoll());
    } else if (http) {
      void sharedRefresh(http);
    }

    return () => {
      unsubTiming();
      metaListeners.delete(onMeta);
      activeSubscribers = Math.max(0, activeSubscribers - 1);
      if (activeSubscribers === 0 && pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };
  }, [http]);

  const refresh = useCallback(async () => {
    await sharedRefresh(http);
  }, [http]);

  const updateTiming = useCallback(
    async (next: { tfSec?: number; expirySec?: number }): Promise<{ ok: boolean; error?: string }> => {
      setLoading(true);
      try {
        const res = await apiFetch(`${http}/api/config/timing`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        const data = await res.json();
        if (!res.ok || data.status !== "ok") {
          const msg = data?.msg || "Failed to update timing configuration";
          sharedError = msg;
          setError(msg);
          return { ok: false, error: msg };
        }
        if (data?.timing) {
          applyRemoteGlobalTiming(data.timing);
          setTiming(data.timing);
        }
        sharedError = null;
        setError(null);
        scheduleSharedPoll();
        return { ok: true };
      } catch (e) {
        const msg = (e as Error)?.message || "Network error updating timing configuration";
        sharedError = msg;
        setError(msg);
        return { ok: false, error: msg };
      } finally {
        setLoading(false);
      }
    },
    [http]
  );

  return { timing, timeframes, expiries, loading, error, updateTiming, refresh };
}
