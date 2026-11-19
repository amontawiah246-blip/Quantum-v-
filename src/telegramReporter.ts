import fs from 'fs';
import path from 'path';
import { computeStochRsi, STOCH_RSI_DEFAULTS, STOCH_RSI_WINDOW } from './stochRsi';
import { renderIndicatorSvg } from './indicatorChart';
import { detectStochRsi, type StochRsiMeta } from './sweepEngines';
import { defaultRasterizer, type Rasterizer } from './screenshot';
import type { CandidateHub } from './candidateHub';

export interface TradeCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PlacedTradeMeta {
  mode?: 'pro' | 'classic' | 'signals' | 'manual' | string;
  candidateId?: string;
  tf?: number;
  label?: string;
  reasons?: string[];
  explanation?: string;
  aiConfidence?: number | null;
  aiBasis?: string;
  engines?: string[];
  why?: string;
  notes?: string[];
  stochRsi?: StochRsiMeta | null;
  signalCandleOpen?: number | null;
  entryPrice?: number | null;
  candles?: TradeCandle[];
}

export interface PlacedTradeContext extends PlacedTradeMeta {
  contractId: string;
  symbol: string;
  market: string;
  side: 'BUY' | 'SELL';
  stake: number;
  seconds: number;
  tf: number;
  placedAtSec: number;
  isDemo: boolean;
  accountId?: string;
}

export interface TradeOutcomeEvent {
  contractId: string;
  outcome: 'win' | 'loss' | 'draw';
  profit: number | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  entryTime?: number | null;
  exitTime?: number | null;
  meta?: PlacedTradeMeta;
}

export interface TelegramConfig {
  token: string;
  chatId: string;
}

const TELEGRAM_CONFIG_FILE = path.resolve(process.cwd(), 'data', 'telegram_config.json');

export function saveTelegramConfig(token: string, chatId: string, filePath = TELEGRAM_CONFIG_FILE): TelegramConfig {
  const clean = { token: token.trim(), chatId: chatId.trim() };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(clean, null, 2), { mode: 0o600 });
  return clean;
}

export function telegramConfigFromEnv(filePath = TELEGRAM_CONFIG_FILE): TelegramConfig | null {
  const envToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const envChatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (envToken && envChatId && !envToken.startsWith('MY_') && !envChatId.startsWith('MY_')) {
    return { token: envToken, chatId: envChatId };
  }
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const fileToken = String(parsed?.token || '').trim();
      const fileChatId = String(parsed?.chatId || '').trim();
      if (fileToken && fileChatId && !fileToken.startsWith('MY_') && !fileChatId.startsWith('MY_')) {
        return { token: fileToken, chatId: fileChatId };
      }
    }
  } catch {
    /* ignore malformed runtime config file */
  }
  return null;
}

export function escHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtTimeUtc(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return 'unknown UTC';
  return new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function fmtTf(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '1m';
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
  return `${Math.round(sec)}s`;
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  if (Math.abs(v) >= 1000) return v.toFixed(2);
  if (Math.abs(v) >= 100) return v.toFixed(3);
  if (Math.abs(v) >= 10) return v.toFixed(4);
  return v.toFixed(5);
}

export interface IndicatorSummary {
  signalK: number | null;
  signalD: number | null;
  signalRsi: number | null;
  exitK: number | null;
  exitD: number | null;
  exitRsi: number | null;
}

export function computeIndicatorSummary(
  candles: TradeCandle[],
  signalIdx: number,
  exitIdx: number,
): IndicatorSummary {
  if (!candles.length) {
    return { signalK: null, signalD: null, signalRsi: null, exitK: null, exitD: null, exitRsi: null };
  }
  const series = computeStochRsi(candles, STOCH_RSI_DEFAULTS);
  const clampIdx = (i: number) => Math.max(0, Math.min(candles.length - 1, i));
  const si = clampIdx(signalIdx);
  const ei = clampIdx(exitIdx);
  const pick = (arr: (number | null)[], i: number) => (arr[i] != null && Number.isFinite(arr[i] as number) ? Number(arr[i]) : null);
  return {
    signalK: pick(series.k, si),
    signalD: pick(series.d, si),
    signalRsi: pick(series.rsi, si),
    exitK: pick(series.k, ei),
    exitD: pick(series.d, ei),
    exitRsi: pick(series.rsi, ei),
  };
}

export interface LossReportMessage {
  caption: string;
  fullText: string | null;
}

export type TradeReportMessage = LossReportMessage;

export function formatTradeMessage(params: {
  ctx: PlacedTradeContext;
  outcome: TradeOutcomeEvent;
  reasons: string[];
  explanation: string;
  engines: string[];
  aiConfidence: number | null;
  aiBasis: string;
  indicators: IndicatorSummary;
}): LossReportMessage {
  const { ctx, outcome, reasons, explanation, engines, aiConfidence, aiBasis, indicators } = params;
  const isWin = outcome.outcome === 'win';
  const isLoss = outcome.outcome === 'loss';
  const pnl = outcome.profit != null && Number.isFinite(outcome.profit)
    ? outcome.profit
    : isWin
      ? Math.abs(ctx.stake || 0) * 0.85
      : isLoss
        ? -Math.abs(ctx.stake || 0)
        : 0;
  const entryP = outcome.entryPrice ?? ctx.entryPrice ?? null;
  const exitP = outcome.exitPrice ?? null;
  const deltaStr = entryP != null && exitP != null
    ? ` (${exitP - entryP >= 0 ? '+' : ''}${(exitP - entryP).toFixed(Math.abs(entryP) >= 1000 ? 2 : 4)})`
    : '';
  const modeLabel = ctx.mode === 'pro' ? 'Pro AI' : ctx.mode === 'classic' ? 'Classic Auto' : ctx.mode === 'signals' ? 'Signals' : 'Manual';
  const acctLabel = ctx.isDemo ? 'DEMO' : 'REAL';
  const entryTime = outcome.entryTime ?? ctx.placedAtSec;

  const stochSignal = indicators.signalK != null && indicators.signalD != null
    ? `%K ${indicators.signalK.toFixed(1)} / %D ${indicators.signalD.toFixed(1)}`
    : 'n/a';
  const stochExit = indicators.exitK != null && indicators.exitD != null
    ? `%K ${indicators.exitK.toFixed(1)} / %D ${indicators.exitD.toFixed(1)}`
    : 'n/a';
  const rsiSignal = indicators.signalRsi != null ? indicators.signalRsi.toFixed(1) : 'n/a';
  const rsiExit = indicators.exitRsi != null ? indicators.exitRsi.toFixed(1) : 'n/a';

  const titleEmoji = isWin ? '🟢' : isLoss ? '🔴' : '🟡';
  const titleKind = isWin ? 'WIN' : isLoss ? 'LOSS' : 'DRAW';
  const pnlSign = pnl > 0 ? '+' : pnl < 0 ? '-' : '';

  const headerLines = [
    `${titleEmoji} <b>TRADE ${titleKind} REPORT — ${escHtml(modeLabel)} (${escHtml(acctLabel)})</b>`,
    `<b>Market:</b> ${escHtml(ctx.market)} (<code>${escHtml(ctx.symbol)}</code>)`,
    `<b>Direction:</b> ${escHtml(ctx.side)} | <b>TF / Expiry:</b> ${escHtml(fmtTf(ctx.tf))} / ${escHtml(fmtTf(ctx.seconds))} (${ctx.seconds}s)`,
    `<b>Stake:</b> $${ctx.stake.toFixed(2)} | <b>PnL:</b> ${pnlSign}$${Math.abs(pnl).toFixed(2)}`,
    `<b>Entry → Exit:</b> ${escHtml(fmtPrice(entryP))} → ${escHtml(fmtPrice(exitP))}${escHtml(deltaStr)}`,
    `<b>Contract:</b> <code>${escHtml(ctx.contractId)}</code> | ${escHtml(fmtTimeUtc(entryTime))}`,
  ];

  const indicatorLines = [
    ``,
    `📊 <b>Indicators (Signal → Exit):</b>`,
    `• Stoch (14,3,3): ${escHtml(stochSignal)} → ${escHtml(stochExit)}`,
    `• RSI (14): ${escHtml(rsiSignal)} → ${escHtml(rsiExit)}`,
  ];

  const reasonLines: string[] = [``, `🧠 <b>Why the engine took this trade:</b>`];
  if (engines.length) reasonLines.push(`• Engines: ${escHtml(engines.join(', '))}`);
  if (aiConfidence != null || aiBasis) {
    reasonLines.push(`• AI Verdict: ${aiConfidence != null ? `${aiConfidence}% confidence` : 'verified'}${aiBasis ? ` (${escHtml(aiBasis)})` : ''}`);
  }
  if (ctx.why) reasonLines.push(`• Setup: ${escHtml(ctx.why)}`);
  if (explanation) reasonLines.push(`• AI Note: ${escHtml(explanation)}`);
  const uniqReasons = Array.from(new Set(reasons.map((r) => r.trim()).filter(Boolean)));
  if (uniqReasons.length) {
    for (const r of uniqReasons.slice(0, 6)) {
      reasonLines.push(`• ${escHtml(r)}`);
    }
  } else if (!ctx.why && !explanation) {
    reasonLines.push(`• Placed as a ${ctx.mode === 'manual' ? 'manual' : 'live'} order on ${escHtml(ctx.symbol)} without stored candidate notes.`);
  }

  const full = [...headerLines, ...indicatorLines, ...reasonLines].join('\n');
  if (full.length <= 1000) {
    return { caption: full, fullText: null };
  }

  // Telegram photo captions cap cleanly at 1024 chars: put summary in photo caption and send full breakdown right below
  const compactCaption = [
    ...headerLines,
    ...indicatorLines,
    ``,
    `🧠 <i>Full entry reasons &amp; AI breakdown sent below ↓</i>`,
  ].join('\n').slice(0, 1000);

  return { caption: compactCaption, fullText: full.slice(0, 4000) };
}

export const formatLossMessage = formatTradeMessage;

export interface TelegramReporterDeps {
  getConfig?: () => TelegramConfig | null;
  getCandles?: (symbol: string, tf: number, count: number) => Promise<TradeCandle[]>;
  getTradeResult?: (contractId: string, timeoutSec: number) => Promise<{
    status: string;
    result?: 'win' | 'loss' | 'draw';
    profit?: number;
    entryPrice?: number | null;
    exitPrice?: number | null;
    entryTime?: number | null;
    exitTime?: number | null;
  }>;
  getCandidate?: (id: string) => ReturnType<CandidateHub['get']>;
  findRecentCandidate?: (symbol: string, tf: number, side: 'BUY' | 'SELL', placedAtSec: number) => ReturnType<CandidateHub['get']>;
  rasterize?: Rasterizer;
  fetchImpl?: typeof fetch;
  enableBackgroundTimer?: boolean;
}

export class TelegramTradeReporter {
  private placed = new Map<string, PlacedTradeContext>();
  private settled = new Set<string>();
  private reportedOutcomes = new Set<string>();
  private inFlight = new Map<string, Promise<boolean>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private winCount = 0;
  private lossCount = 0;
  private lastError = '';
  private lastSentAt: number | null = null;
  private lastContractId = '';
  private lastOutcome: 'win' | 'loss' | '' = '';
  private lastChartBytes = 0;
  private deps: TelegramReporterDeps;

  constructor(deps: TelegramReporterDeps = {}) {
    this.deps = deps;
  }

  public setDeps(deps: Partial<TelegramReporterDeps>) {
    this.deps = { ...this.deps, ...deps };
  }

  public getStatus() {
    const cfg = (this.deps.getConfig ?? telegramConfigFromEnv)();
    return {
      configured: !!cfg,
      trackedTrades: this.placed.size,
      reportedTrades: this.winCount + this.lossCount,
      reportedWins: this.winCount,
      reportedLosses: this.lossCount,
      lastError: this.lastError,
      lastSentAt: this.lastSentAt,
      lastOutcome: this.lastOutcome,
      lastLossContractId: this.lastContractId,
      lastContractId: this.lastContractId,
      lastChartBytes: this.lastChartBytes,
    };
  }

  public registerPlacedTrade(ctx: PlacedTradeContext) {
    if (!ctx.contractId) return;
    const id = String(ctx.contractId);

    // Enrich candidateId if caller didn't pass one
    if (!ctx.candidateId && this.deps.findRecentCandidate) {
      const match = this.deps.findRecentCandidate(ctx.symbol, ctx.tf, ctx.side, ctx.placedAtSec);
      if (match) ctx = { ...ctx, candidateId: match.id };
    }

    this.placed.set(id, ctx);
    if (this.placed.size > 500) {
      const oldest = this.placed.keys().next().value;
      if (oldest) this.placed.delete(oldest);
    }

    // Fallback watcher in case the client UI closes before calling /api/trade-result
    if (this.deps.enableBackgroundTimer !== false && this.deps.getTradeResult && !this.timers.has(id)) {
      const waitMs = Math.max(10_000, (ctx.seconds + 8) * 1000);
      const t = setTimeout(() => {
        this.timers.delete(id);
        if (this.settled.has(id) || this.reportedOutcomes.has(id)) return;
        void this.checkUnpolledResult(id);
      }, waitMs);
      if (typeof t.unref === 'function') t.unref();
      this.timers.set(id, t);
    }
  }

  private async checkUnpolledResult(contractId: string, retry = true) {
    if (!this.deps.getTradeResult || this.settled.has(contractId)) return;
    try {
      const res = await this.deps.getTradeResult(contractId, 45);
      if (res?.status === 'ok' && (res.result === 'win' || res.result === 'loss' || res.result === 'draw')) {
        await this.handleTradeOutcome({
          contractId,
          outcome: res.result,
          profit: typeof res.profit === 'number' ? res.profit : null,
          entryPrice: res.entryPrice ?? null,
          exitPrice: res.exitPrice ?? null,
          entryTime: res.entryTime ?? null,
          exitTime: res.exitTime ?? null,
        });
        return;
      }
      if (retry && !this.settled.has(contractId)) {
        const t = setTimeout(() => {
          this.timers.delete(contractId);
          void this.checkUnpolledResult(contractId, false);
        }, 12_000);
        if (typeof t.unref === 'function') t.unref();
        this.timers.set(contractId, t);
      }
    } catch {
      /* ignore background check failures */
    }
  }

  public async handleTradeOutcome(ev: TradeOutcomeEvent): Promise<boolean> {
    const id = String(ev.contractId || '');
    if (!id) return false;

    this.settled.add(id);
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }

    if (ev.outcome !== 'loss' && ev.outcome !== 'win') return false;
    if (this.reportedOutcomes.has(id)) return true;

    const existing = this.inFlight.get(id);
    if (existing) return existing;

    const task = this.sendTradeReport(ev).finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, task);
    return task;
  }

  private async sendTradeReport(ev: TradeOutcomeEvent): Promise<boolean> {
    const cfg = (this.deps.getConfig ?? telegramConfigFromEnv)();
    if (!cfg) {
      this.lastError = 'Telegram bot token or chat id not configured';
      return false;
    }

    const baseCtx = this.placed.get(ev.contractId);
    const mergedMeta: PlacedTradeMeta = { ...baseCtx, ...ev.meta };
    const candidate = mergedMeta.candidateId && this.deps.getCandidate
      ? this.deps.getCandidate(mergedMeta.candidateId)
      : undefined;

    const o = candidate?.versions[0];
    const latest = candidate?.versions[candidate.versions.length - 1];
    const sigObj = candidate?.decision?.signal as any;

    const tf = baseCtx?.tf || o?.tf || mergedMeta.tf || 60;
    const symbol = baseCtx?.symbol || o?.symbol || 'UNKNOWN';
    const market = baseCtx?.market || o?.market || mergedMeta.label || symbol;
    const side: 'BUY' | 'SELL' = baseCtx?.side || o?.direction || 'BUY';
    const seconds = baseCtx?.seconds || tf;
    const entryTime = ev.entryTime ?? baseCtx?.placedAtSec ?? Math.floor(Date.now() / 1000) - seconds;

    const ctx: PlacedTradeContext = {
      contractId: ev.contractId,
      symbol,
      market,
      side,
      stake: baseCtx?.stake ?? (ev.profit != null ? Math.abs(ev.profit) : 0),
      seconds,
      tf,
      placedAtSec: entryTime,
      isDemo: baseCtx?.isDemo ?? true,
      accountId: baseCtx?.accountId,
      mode: mergedMeta.mode || 'unknown',
      candidateId: mergedMeta.candidateId,
      entryPrice: ev.entryPrice ?? mergedMeta.entryPrice ?? null,
      why: mergedMeta.why,
    };

    // Gather candles up through expiry window
    let candles: TradeCandle[] = [];
    if (this.deps.getCandles && symbol !== 'UNKNOWN') {
      try {
        const fetched = await this.deps.getCandles(symbol, tf, STOCH_RSI_WINDOW + 25);
        if (Array.isArray(fetched) && fetched.length) {
          const filtered = fetched
            .filter((c) => c.time < entryTime + seconds + tf)
            .map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
          candles = filtered.length >= 15 ? filtered : fetched.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
        }
      } catch {
        /* fallback to stored candles below */
      }
    }
    if (candles.length < 10 && Array.isArray(latest?.ohlc) && latest.ohlc.length) {
      candles = latest.ohlc.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    }
    if (candles.length < 10 && Array.isArray(mergedMeta.candles) && mergedMeta.candles.length) {
      candles = mergedMeta.candles;
    }

    const windowCandles = candles.slice(-STOCH_RSI_WINDOW);
    const signalTime = mergedMeta.signalCandleOpen
      ?? o?.signalCandleOpen
      ?? (windowCandles.length >= 2 ? windowCandles[windowCandles.length - 2].time : windowCandles[windowCandles.length - 1]?.time ?? entryTime - tf);

    const rawSigIdx = windowCandles.findIndex((c) => c.time === signalTime);
    const sigIdx = rawSigIdx >= 0 ? rawSigIdx : Math.max(0, windowCandles.length - 2);
    const exitIdx = Math.max(0, windowCandles.length - 1);
    const indicators = computeIndicatorSummary(windowCandles, sigIdx, exitIdx);

    let meta: StochRsiMeta | null = mergedMeta.stochRsi ?? o?.stochRsi ?? null;
    if (!meta && windowCandles.length >= 20 && sigIdx >= 0) {
      const det = detectStochRsi(windowCandles, sigIdx);
      if (det?.side === side) meta = det.stochRsi ?? null;
    }

    const notes = mergedMeta.notes ?? o?.notes ?? [];
    const engines = Array.from(new Set([
      ...(mergedMeta.engines ?? []),
      ...(o?.engine ? [o.engine] : []),
      ...(candidate?.coDetectedBy ?? []),
    ].filter(Boolean)));

    const reasons = [
      ...(Array.isArray(mergedMeta.reasons) ? mergedMeta.reasons : []),
      ...(Array.isArray(sigObj?.reasons) ? sigObj.reasons : []),
      ...(Array.isArray(candidate?.decision?.reasons) ? candidate.decision.reasons : []),
      ...notes,
    ];
    const explanation = String(
      mergedMeta.explanation
      || sigObj?.verification?.explanation
      || ''
    ).trim();
    const aiConfidence = mergedMeta.aiConfidence ?? (typeof sigObj?.aiConfidence === 'number' ? sigObj.aiConfidence : null);
    const aiBasis = String(mergedMeta.aiBasis || sigObj?.aiConfidenceBasis || '').trim();

    const tradeEntryPrice = ev.entryPrice
      ?? ctx.entryPrice
      ?? windowCandles[sigIdx]?.close
      ?? windowCandles[windowCandles.length - 1]?.open
      ?? 0;

    const chartResult: 'WIN' | 'LOSS' = ev.outcome === 'win' ? 'WIN' : 'LOSS';
    const raster = this.deps.rasterize ?? defaultRasterizer;
    let png: Buffer | null = null;
    if (windowCandles.length >= 10 && tradeEntryPrice > 0) {
      try {
        const svg = renderIndicatorSvg(windowCandles, {
          side,
          ok: true,
          tf,
          market,
          symbol,
          meta,
          notes,
          signalTime,
          compact: true,
          levels: true,
          visible: Math.min(40, windowCandles.length),
          trade: {
            time: entryTime,
            price: tradeEntryPrice,
            expirySec: seconds,
            result: chartResult,
            exitPrice: ev.exitPrice ?? null,
          },
        });
        const rawPng = await raster(svg);
        if (rawPng && rawPng.length) png = Buffer.from(rawPng);
      } catch (renderErr: any) {
        console.warn(`[Telegram] Chart render/rasterize failed for #${ev.contractId}:`, renderErr?.message || renderErr);
        png = null;
      }
    }

    if (!png && o?.screenshot?.png) {
      try { png = Buffer.from(o.screenshot.png); } catch { png = null; }
    }
    if (!png && o?.screenshot?.svg) {
      try {
        const rawPng = await raster(o.screenshot.svg);
        if (rawPng && rawPng.length) png = Buffer.from(rawPng);
      } catch {
        png = null;
      }
    }

    const { caption, fullText } = formatTradeMessage({
      ctx: { ...ctx, entryPrice: tradeEntryPrice > 0 ? tradeEntryPrice : ctx.entryPrice },
      outcome: ev,
      reasons,
      explanation,
      engines,
      aiConfidence,
      aiBasis,
      indicators,
    });

    const doFetch = this.deps.fetchImpl ?? fetch;
    const baseUrl = `https://api.telegram.org/bot${cfg.token}`;
    const outcomeTag = ev.outcome === 'win' ? 'win' : 'loss';

    try {
      if (png) {
        const form = new FormData();
        form.append('chat_id', cfg.chatId);
        form.append('caption', caption);
        form.append('parse_mode', 'HTML');
        form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${outcomeTag}-${symbol}-${ev.contractId}.png`);

        const r = await doFetch(`${baseUrl}/sendPhoto`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(20000),
        });
        const d: any = await r.json().catch(() => null);
        if (!r.ok || !d?.ok) {
          throw new Error(d?.description || `Telegram sendPhoto HTTP ${r.status}`);
        }
      }

      if (!png || fullText) {
        const r2 = await doFetch(`${baseUrl}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cfg.chatId,
            text: fullText || caption,
            parse_mode: 'HTML',
          }),
          signal: AbortSignal.timeout(15000),
        });
        const d2: any = await r2.json().catch(() => null);
        if (!r2.ok || !d2?.ok) {
          throw new Error(d2?.description || `Telegram sendMessage HTTP ${r2.status}`);
        }
      }

      this.reportedOutcomes.add(ev.contractId);
      if (this.reportedOutcomes.size > 1000) {
        const oldest = this.reportedOutcomes.values().next().value;
        if (oldest) this.reportedOutcomes.delete(oldest);
      }
      if (ev.outcome === 'win') this.winCount++;
      else this.lossCount++;
      this.lastError = '';
      this.lastSentAt = Date.now();
      this.lastOutcome = ev.outcome === 'win' ? 'win' : 'loss';
      this.lastContractId = ev.contractId;
      this.lastChartBytes = png ? png.length : 0;
      console.log(`[Telegram] Sent ${outcomeTag} report for ${symbol} (${side}) #${ev.contractId}${png ? ` (${png.length}B PNG)` : ' (text only)'}`);
      return true;
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      console.warn(`[Telegram] Failed to send ${outcomeTag} report for #${ev.contractId}:`, this.lastError);
      return false;
    }
  }
}

export const TelegramLossReporter = TelegramTradeReporter;
export const telegramReporter = new TelegramTradeReporter();
