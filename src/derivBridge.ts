import { WebSocket } from 'ws';
import fs from 'fs';
import https from 'https';
import {
  RiseFallLimit,
  parseDerivDurationSec,
  getRiseFallStaticLimit,
  evaluateRiseFallSupport,
} from './derivContracts';

export type { RiseFallLimit };
export { parseDerivDurationSec, getRiseFallStaticLimit, evaluateRiseFallSupport };

const SESSION_FILE = '/tmp/deriv_token.txt';
const REST_BASE = 'https://api.derivws.com';

const WS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Origin': 'https://app.deriv.com',
  'Accept-Language': 'en-US,en;q=0.9'
};

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DerivAsset {
  symbol: string;
  name: string;
  payout: number;
  active: boolean;
}

const DEFAULT_SYNTHETICS: DerivAsset[] = [
  { symbol: "frxXAUUSD", name: "Gold / USD (XAUUSD)", payout: 95, active: true },
  { symbol: "1HZ10V", name: "Volatility 10 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ25V", name: "Volatility 25 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ50V", name: "Volatility 50 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ75V", name: "Volatility 75 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ100V", name: "Volatility 100 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ150V", name: "Volatility 150 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ200V", name: "Volatility 200 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ250V", name: "Volatility 250 (1s) Index", payout: 95, active: true },
  { symbol: "1HZ300V", name: "Volatility 300 (1s) Index", payout: 95, active: true },
  { symbol: "R_10", name: "Volatility 10 Index", payout: 95, active: true },
  { symbol: "R_25", name: "Volatility 25 Index", payout: 95, active: true },
  { symbol: "R_50", name: "Volatility 50 Index", payout: 95, active: true },
  { symbol: "R_75", name: "Volatility 75 Index", payout: 95, active: true },
  { symbol: "R_100", name: "Volatility 100 Index", payout: 95, active: true },
  { symbol: "R_150", name: "Volatility 150 Index", payout: 95, active: true },
  { symbol: "R_200", name: "Volatility 200 Index", payout: 95, active: true },
  { symbol: "R_250", name: "Volatility 250 Index", payout: 95, active: true },
  { symbol: "R_300", name: "Volatility 300 Index", payout: 95, active: true },
  { symbol: "BOOM300", name: "Boom 300 Index", payout: 95, active: true },
  { symbol: "BOOM500", name: "Boom 500 Index", payout: 95, active: true },
  { symbol: "BOOM1000", name: "Boom 1000 Index", payout: 95, active: true },
  { symbol: "CRASH300", name: "Crash 300 Index", payout: 95, active: true },
  { symbol: "CRASH500", name: "Crash 500 Index", payout: 95, active: true },
  { symbol: "CRASH1000", name: "Crash 1000 Index", payout: 95, active: true },
  { symbol: "stpRNG", name: "Step Index 100", payout: 95, active: true },
  { symbol: "STEP", name: "Step Index", payout: 95, active: true },
  { symbol: "JD10", name: "Jump 10 Index", payout: 95, active: true },
  { symbol: "JD25", name: "Jump 25 Index", payout: 95, active: true },
  { symbol: "JD50", name: "Jump 50 Index", payout: 95, active: true },
  { symbol: "JD75", name: "Jump 75 Index", payout: 95, active: true },
  { symbol: "JD100", name: "Jump 100 Index", payout: 95, active: true },
];

export class DerivBridge {
  public token: string = '';
  public appId: string = '34QcI4Rf8S5tCkL6PMOcI';
  public accountId: string = '';
  public ready: boolean = false;
  public error: string = '';
  public authError: string = '';
  /** true only when the authenticated (trading) websocket is open: the public data feed alone cannot place orders */
  get tradable(): boolean { return !!this.authWs && this.authWs.readyState === WebSocket.OPEN; }
  public balance: number | null = null;
  public currency: string = 'USD';
  public isDemo: boolean = true;
  public assets: DerivAsset[] = [...DEFAULT_SYNTHETICS];
  public accountList: Array<{ loginid: string; is_virtual: number; account_type?: string }> = [];

  private publicWs: WebSocket | null = null;
  private authWs: WebSocket | null = null;
  private pendingPublicRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private pendingAuthRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
  private reqId = 1;
  private authReqId = 1000;
  private tickSubscribers = new Map<string, Set<(price: number, epoch: number) => void>>();
  private tickSubIds = new Map<string, string>();
  private resolvedSymbolMap = new Map<string, string>();
  private riseFallLimits = new Map<string, RiseFallLimit>();
  private authInitPromise: Promise<void> | null = null;
  private authInitEpoch = 0;
  private authRetryCount = 0;
  private authReconnectTimer: NodeJS.Timeout | null = null;
  private authPingTimer: NodeJS.Timeout | null = null;
  private publicPingTimer: NodeJS.Timeout | null = null;
  private publicReconnectTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.loadToken();
    this.connectPublicWs();
    void this.initAuth(true);
  }

  private loadToken() {
    let rawToken = process.env.DERIV_TOKEN || process.env.DERIV_API_KEY || '';
    if (!rawToken && fs.existsSync(SESSION_FILE)) {
      try {
        rawToken = fs.readFileSync(SESSION_FILE, 'utf-8').trim();
      } catch {}
    }
    if (!rawToken) {
      rawToken = 'pat_12430e9f3555e6dd3a2ad5bb86555b0a530667adbd0b8efd1f97b3abdcdaf106';
    }
    this.parseTokenString(rawToken);
  }

  public parseTokenString(raw: string) {
    const parts = raw.split('|').map(p => p.trim());
    if (parts[0]) this.token = parts[0];
    if (parts[1]) this.appId = parts[1];
    if (parts[2]) this.accountId = parts[2];
  }

  public setCredentials(raw: string) {
    this.parseTokenString(raw);
    try {
      fs.writeFileSync(SESSION_FILE, raw);
    } catch {}
    this.authError = '';
    this.balance = null;
    this.authRetryCount = 0;
    void this.initAuth(true);
  }

  // --- 1. Public Market Data Connection ---
  private connectPublicWs() {
    if (this.publicReconnectTimer) {
      clearTimeout(this.publicReconnectTimer);
      this.publicReconnectTimer = null;
    }
    if (this.publicPingTimer) {
      clearInterval(this.publicPingTimer);
      this.publicPingTimer = null;
    }

    const primaryUrl = 'wss://api.derivws.com/trading/v1/options/ws/public';
    console.log(`[DerivBridge] Connecting public market stream to ${primaryUrl}...`);

    try {
      const prev = this.publicWs;
      const ws = new WebSocket(primaryUrl, { headers: WS_HEADERS });
      this.publicWs = ws;
      if (prev) {
        try { prev.close(); } catch {}
      }

      ws.on('open', () => {
        if (this.publicWs !== ws) return;
        console.log(`[DerivBridge] Public Market Data Connected`);
        this.ready = true;
        this.error = '';

        this.publicPingTimer = setInterval(() => {
          if (this.publicWs === ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ ping: 1 })); } catch {}
          }
        }, 25000);

        // Re-subscribe any pending tick subscribers
        for (const sym of this.tickSubscribers.keys()) {
          this.requestPublic({ ticks: this.resolveSymbol(sym), subscribe: 1 }).catch(() => {});
        }

        // Load active symbols
        this.requestPublic({ active_symbols: 'brief' }).then((res) => {
          if (res && Array.isArray(res.active_symbols)) {
            const parsed = res.active_symbols
              .filter((s: any) => {
                const sym = (s.underlying_symbol || s.symbol || '').toUpperCase();
                return sym === 'FRXXAUUSD' || sym === 'WLDXAU' || sym.startsWith('R_') || sym.startsWith('1HZ') || sym.startsWith('BOOM') ||
                  sym.startsWith('CRASH') || sym.startsWith('STEP') || sym.startsWith('JD') || sym.startsWith('STP');
              })
              .map((s: any) => {
                const sym = s.underlying_symbol || s.symbol;
                const isGold = sym === 'frxXAUUSD' || sym.toUpperCase() === 'FRXXAUUSD';
                return {
                  symbol: sym,
                  name: isGold ? 'Gold / USD (XAUUSD)' : (s.underlying_symbol_name || s.display_name || sym),
                  payout: 95,
                  active: !s.is_trading_suspended && (s.exchange_is_open === 1 || s.exchange_is_open === undefined)
                };
              });
            if (parsed.length > 0) {
              if (!parsed.some((p: any) => p.symbol === 'frxXAUUSD')) {
                parsed.unshift({ symbol: 'frxXAUUSD', name: 'Gold / USD (XAUUSD)', payout: 95, active: true });
              }
              this.assets = parsed;
            }
          }
          void this.seedRiseFallCache();
        }).catch(() => {});
      });

      ws.on('message', (data: any) => {
        if (this.publicWs !== ws) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.req_id && this.pendingPublicRequests.has(msg.req_id)) {
            const { resolve } = this.pendingPublicRequests.get(msg.req_id)!;
            this.pendingPublicRequests.delete(msg.req_id);
            resolve(msg);
          }

          if (msg.msg_type === 'tick' && msg.tick) {
            const sym = msg.tick.symbol;
            const price = Number(msg.tick.quote);
            const epoch = Number(msg.tick.epoch);
            if (msg.subscription && msg.subscription.id && sym) {
              this.tickSubIds.set(sym, msg.subscription.id);
            }
            if (sym) {
              const direct = this.tickSubscribers.get(sym);
              if (direct) {
                for (const cb of direct) cb(price, epoch);
              }
              for (const [origSym, callbacks] of this.tickSubscribers.entries()) {
                if (origSym !== sym && this.resolveSymbol(origSym) === sym) {
                  for (const cb of callbacks) cb(price, epoch);
                }
              }
            }
          }
        } catch {}
      });

      ws.on('error', (err) => {
        if (this.publicWs !== ws) return;
        console.warn(`[DerivBridge] Public WS Warning: ${err.message}`);
        this.ready = false;
      });

      ws.on('close', () => {
        if (this.publicWs !== ws) return;
        if (this.publicPingTimer) {
          clearInterval(this.publicPingTimer);
          this.publicPingTimer = null;
        }
        for (const [, p] of this.pendingPublicRequests.entries()) {
          p.reject(new Error('Deriv Public WS closed'));
        }
        this.pendingPublicRequests.clear();
        this.publicWs = null;
        this.ready = false;
        this.publicReconnectTimer = setTimeout(() => this.connectPublicWs(), 2000);
      });
    } catch (err: any) {
      this.error = `Failed to connect public market WS: ${err.message}`;
    }
  }

  // --- 2. Authenticated Account Connection via REST OTP ---
  public async initAuth(force = false): Promise<void> {
    if (!force && this.authInitPromise) {
      return this.authInitPromise;
    }
    if (this.authReconnectTimer) {
      clearTimeout(this.authReconnectTimer);
      this.authReconnectTimer = null;
    }
    if (!this.token || this.token.startsWith('MY_')) {
      this.authError = 'No Deriv API Token configured. Enter your PAT on the API screen.';
      return;
    }

    const epoch = ++this.authInitEpoch;
    const task = (async () => {
      try {
        // Step A: Fetch accounts list
        const accountsRes = await this.httpApiGet('/trading/v1/options/accounts');
        if (this.authInitEpoch !== epoch) return;

        if (!accountsRes || !Array.isArray(accountsRes.data) || accountsRes.data.length === 0) {
          const apiErr = Array.isArray(accountsRes?.errors) && accountsRes.errors[0]?.message
            ? String(accountsRes.errors[0].message)
            : accountsRes?.message || 'No Deriv accounts found on this token';
          this.authError = apiErr;
          this.scheduleAuthReconnect();
          return;
        }

        const accList = accountsRes.data;
        this.accountList = accList.map((a: any) => ({
          loginid: a.account_id,
          is_virtual: a.account_type === 'demo' ? 1 : 0,
          account_type: a.account_type
        }));

        // Find matching account (demo vs real)
        let selectedAcc = accList.find((a: any) => (a.account_type === 'demo') === this.isDemo);
        if (!selectedAcc) selectedAcc = accList[0];

        this.accountId = selectedAcc.account_id;
        this.balance = Number(selectedAcc.balance || 0);
        this.currency = selectedAcc.currency || 'USD';
        this.isDemo = selectedAcc.account_type === 'demo';

        console.log(`[DerivBridge] Deriv Account Identified: ${this.accountId} (${this.isDemo ? 'DEMO' : 'REAL'}). Balance: ${this.balance} ${this.currency}`);

        // Step B: Fetch OTP WebSocket URL
        const otpRes = await this.httpApiPost(`/trading/v1/options/accounts/${this.accountId}/otp`);
        if (this.authInitEpoch !== epoch) return;

        if (!otpRes || !otpRes.data || !otpRes.data.url) {
          const otpErr = Array.isArray(otpRes?.errors) && otpRes.errors[0]?.message
            ? String(otpRes.errors[0].message)
            : otpRes?.message || 'Failed to obtain Deriv OTP session';
          this.authError = otpErr;
          this.scheduleAuthReconnect();
          return;
        }

        this.connectAuthWs(otpRes.data.url);
      } catch (err: any) {
        if (this.authInitEpoch !== epoch) return;
        this.authError = `Deriv Login Exception: ${err.message}`;
        console.warn(`[DerivBridge] Auth initialization error: ${err.message}`);
        this.scheduleAuthReconnect();
      }
    })();

    this.authInitPromise = task;
    try {
      await task;
    } finally {
      if (this.authInitPromise === task) {
        this.authInitPromise = null;
      }
    }
  }

  private scheduleAuthReconnect() {
    if (this.authReconnectTimer || !this.token || this.token.startsWith('MY_')) return;
    const delayMs = Math.min(10000, 1500 * Math.pow(2, Math.min(this.authRetryCount, 3)));
    this.authRetryCount++;
    this.authReconnectTimer = setTimeout(() => {
      this.authReconnectTimer = null;
      void this.initAuth(false);
    }, delayMs);
  }

  private connectAuthWs(otpUrl: string) {
    if (this.authReconnectTimer) {
      clearTimeout(this.authReconnectTimer);
      this.authReconnectTimer = null;
    }
    if (this.authPingTimer) {
      clearInterval(this.authPingTimer);
      this.authPingTimer = null;
    }

    try {
      const prev = this.authWs;
      const ws = new WebSocket(otpUrl, { headers: WS_HEADERS });
      this.authWs = ws;

      for (const [, p] of this.pendingAuthRequests.entries()) {
        p.reject(new Error('Deriv Auth WS reconnecting'));
      }
      this.pendingAuthRequests.clear();

      if (prev) {
        try { prev.close(); } catch {}
      }

      ws.on('open', () => {
        if (this.authWs !== ws) return;
        console.log(`[DerivBridge] Authenticated Deriv Session Opened (${this.accountId})`);
        this.authError = '';
        this.authRetryCount = 0;

        this.authPingTimer = setInterval(() => {
          if (this.authWs === ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ ping: 1 })); } catch {}
          }
        }, 25000);

        // Subscribe to live balance updates
        this.requestAuth({ balance: 1, subscribe: 1 }).catch(() => {});
      });

      ws.on('message', (data: any) => {
        if (this.authWs !== ws) return;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.req_id && this.pendingAuthRequests.has(msg.req_id)) {
            const { resolve } = this.pendingAuthRequests.get(msg.req_id)!;
            this.pendingAuthRequests.delete(msg.req_id);
            resolve(msg);
          }

          if (msg.msg_type === 'balance' && msg.balance) {
            this.balance = Number(msg.balance.balance);
            this.currency = msg.balance.currency || this.currency;
          }
        } catch {}
      });

      ws.on('error', (err) => {
        if (this.authWs !== ws) return;
        console.warn(`[DerivBridge] Auth WS warning: ${err.message}`);
      });

      ws.on('close', () => {
        if (this.authWs !== ws) return;
        if (this.authPingTimer) {
          clearInterval(this.authPingTimer);
          this.authPingTimer = null;
        }
        for (const [, p] of this.pendingAuthRequests.entries()) {
          p.reject(new Error('Deriv Auth WS closed'));
        }
        this.pendingAuthRequests.clear();
        this.authWs = null;
        if (this.token && !this.token.startsWith('MY_')) {
          console.log(`[DerivBridge] Auth WS closed. Refreshing OTP session...`);
          this.scheduleAuthReconnect();
        }
      });
    } catch (err: any) {
      this.authError = `Auth WS Error: ${err.message}`;
    }
  }

  public async ensureAuthConnected(timeoutMs = 15000): Promise<void> {
    if (this.authWs && this.authWs.readyState === WebSocket.OPEN) return;
    if (!this.token || this.token.startsWith('MY_')) {
      throw new Error('Deriv account not connected. Please enter your Deriv PAT Token on the API screen.');
    }
    if (!this.authWs || this.authWs.readyState === WebSocket.CLOSED || this.authWs.readyState === WebSocket.CLOSING) {
      void this.initAuth(false);
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.authWs && this.authWs.readyState === WebSocket.OPEN) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(this.authError || 'Deriv account not connected. Please enter your Deriv PAT Token on the API screen.');
  }

  // --- HTTP Helpers ---
  private httpApiGet(endpoint: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.derivws.com',
        path: endpoint,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Deriv-App-ID': this.appId || '34QcI4Rf8S5tCkL6PMOcI',
          'User-Agent': WS_HEADERS['User-Agent']
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  private httpApiPost(endpoint: string, bodyObj = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(bodyObj);
      const options = {
        hostname: 'api.derivws.com',
        path: endpoint,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Deriv-App-ID': this.appId || '34QcI4Rf8S5tCkL6PMOcI',
          'User-Agent': WS_HEADERS['User-Agent'],
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // --- Request Wrappers ---
  public async ensurePublicConnected(timeoutMs = 15000): Promise<void> {
    if (this.publicWs && this.publicWs.readyState === WebSocket.OPEN) return;
    if (!this.publicWs || this.publicWs.readyState === WebSocket.CLOSED || this.publicWs.readyState === WebSocket.CLOSING) {
      this.connectPublicWs();
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.publicWs && this.publicWs.readyState === WebSocket.OPEN) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Deriv Public WS not connected');
  }

  public async requestPublic(payload: any, timeoutMs = 15000): Promise<any> {
    await this.ensurePublicConnected(timeoutMs);
    return new Promise((resolve, reject) => {
      if (!this.publicWs || this.publicWs.readyState !== WebSocket.OPEN) {
        return reject(new Error('Deriv Public WS not connected'));
      }
      const id = ++this.reqId;
      const timer = setTimeout(() => {
        if (this.pendingPublicRequests.has(id)) {
          this.pendingPublicRequests.delete(id);
          reject(new Error('Deriv Public Request Timeout'));
        }
      }, timeoutMs);

      this.pendingPublicRequests.set(id, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });

      this.publicWs.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  public requestAuth(payload: any, timeoutMs = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.authWs || this.authWs.readyState !== WebSocket.OPEN) {
        return reject(new Error('Deriv Auth WS not connected'));
      }
      const id = ++this.authReqId;
      const timer = setTimeout(() => {
        if (this.pendingAuthRequests.has(id)) {
          this.pendingAuthRequests.delete(id);
          reject(new Error('Deriv Auth Request Timeout'));
        }
      }, timeoutMs);

      this.pendingAuthRequests.set(id, {
        resolve: (res) => { clearTimeout(timer); resolve(res); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });

      this.authWs.send(JSON.stringify({ ...payload, req_id: id }));
    });
  }

  private getSymbolAliases(symbol: string): string[] {
    const list = [symbol];
    const upper = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (upper === 'XAUUSD' || upper === 'GOLD' || upper === 'XAU' || upper === 'FRXXAUUSD') {
      return ['frxXAUUSD', 'WLDXAU'];
    }
    if (symbol === 'BOOM300') list.push('BOOM300N');
    else if (symbol === 'CRASH300') list.push('CRASH300N');
    else if (symbol === 'BOOM150') list.push('BOOM150N');
    else if (symbol === 'CRASH150') list.push('CRASH150N');
    else if (symbol === 'stpRNG') list.push('STEP', 'STPRNG');
    else if (symbol === 'STEP') list.push('stpRNG', 'STPRNG');
    else if (symbol === '1HZ200V') list.push('1HZ90V', '1HZ100V');
    else if (symbol === '1HZ300V') list.push('1HZ100V', '1HZ75V');
    else if (symbol === 'R_150' || symbol === 'R_200' || symbol === 'R_250' || symbol === 'R_300') list.push('R_100', 'R_75');
    if (symbol.startsWith('1HZ') && !symbol.endsWith('V')) list.push(symbol + 'V');
    if (symbol.startsWith('1HZ') && symbol.endsWith('V')) list.push(symbol.slice(0, -1));
    return Array.from(new Set(list));
  }

  // --- Gapless Candle Stitching ---
  public async getCandles(symbol: string, tf: number, count: number): Promise<Candle[]> {
    tf = Number(tf) || 60;
    count = Math.max(10, Math.min(1000, Number(count) || 60));

    const symbolsToTry = this.getSymbolAliases(symbol);

    for (const sym of symbolsToTry) {
      try {
        const res = await this.requestPublic({
          ticks_history: sym,
          adjust_start_time: 1,
          count: count,
          end: 'latest',
          granularity: tf,
          style: 'candles'
        });

        let rawCandles: Candle[] = [];
        if (res && Array.isArray(res.candles) && res.candles.length > 0) {
          rawCandles = res.candles.map((c: any) => ({
            time: Number(c.epoch),
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close)
          }));
        }

        if (rawCandles.length > 0) {
          this.resolvedSymbolMap.set(symbol, sym);
          return this.stitchCandleGaps(rawCandles, tf);
        }
      } catch (err: any) {
        if (sym === symbol && !err?.message?.includes('Deriv Public WS not connected')) {
          console.warn(`[DerivBridge] getCandles retry for ${sym}:`, err?.message || err);
        }
      }
    }

    return [];
  }

  public resolveSymbol(symbol: string): string {
    const cached = this.resolvedSymbolMap.get(symbol);
    if (cached) return cached;
    if (this.assets.some((a) => a.symbol === symbol)) return symbol;
    for (const alias of this.getSymbolAliases(symbol)) {
      if (this.assets.some((a) => a.symbol === alias)) return alias;
    }
    return symbol;
  }

  public stitchCandleGaps(raw: Candle[], tf: number): Candle[] {
    if (raw.length === 0) return [];
    raw.sort((a, b) => a.time - b.time);

    const map = new Map<number, Candle>();
    for (const c of raw) {
      const b = Math.floor(c.time / tf) * tf;
      map.set(b, { ...c, time: b });
    }

    const tMin = Math.floor(raw[0].time / tf) * tf;
    const tMax = Math.floor(raw[raw.length - 1].time / tf) * tf;
    const result: Candle[] = [];

    let prevClose = raw[0].open;
    for (let t = tMin; t <= tMax; t += tf) {
      if (map.has(t)) {
        const cand = map.get(t)!;
        prevClose = cand.close;
        result.push(cand);
      } else {
        result.push({
          time: t,
          open: prevClose,
          high: prevClose,
          low: prevClose,
          close: prevClose
        });
      }
    }
    return result;
  }

  // --- Subscriptions ---
  public subscribeTicks(symbol: string, callback: (price: number, epoch: number) => void) {
    const streamSym = this.resolveSymbol(symbol);
    if (!this.tickSubscribers.has(symbol)) {
      this.tickSubscribers.set(symbol, new Set());
      if (this.publicWs && this.publicWs.readyState === WebSocket.OPEN) {
        this.requestPublic({ ticks: streamSym, subscribe: 1 }).catch(() => {});
      }
    }
    this.tickSubscribers.get(symbol)!.add(callback);
  }

  public unsubscribeTicks(symbol: string, callback: (price: number, epoch: number) => void) {
    const subs = this.tickSubscribers.get(symbol);
    if (subs) {
      subs.delete(callback);
      if (subs.size === 0) {
        this.tickSubscribers.delete(symbol);
        const streamSym = this.resolveSymbol(symbol);
        const stillNeeded = Array.from(this.tickSubscribers.keys()).some((k) => this.resolveSymbol(k) === streamSym);
        const subId = this.tickSubIds.get(streamSym) ?? this.tickSubIds.get(symbol);
        if (!stillNeeded && subId && this.publicWs && this.publicWs.readyState === WebSocket.OPEN) {
          this.requestPublic({ forget: subId }).catch(() => {});
          this.tickSubIds.delete(streamSym);
          this.tickSubIds.delete(symbol);
        }
      }
    }
  }

  // --- Rise/Fall Contract Support Cache ---
  private async seedRiseFallCache() {
    const syms = Array.from(new Set(DEFAULT_SYNTHETICS.map((a) => a.symbol)));
    for (const sym of syms) {
      if (getRiseFallStaticLimit(sym)) continue;
      if (this.riseFallLimits.has(sym)) continue;
      await this.refreshRiseFallSupport(sym).catch(() => {});
    }
  }

  public async refreshRiseFallSupport(symbol: string): Promise<RiseFallLimit> {
    const staticLim = getRiseFallStaticLimit(symbol);
    if (staticLim && !staticLim.supported) {
      this.riseFallLimits.set(symbol, staticLim);
      return staticLim;
    }

    const candidates = Array.from(new Set([this.resolveSymbol(symbol), symbol, ...this.getSymbolAliases(symbol)]));
    let sawNoContract = false;
    for (const sym of candidates) {
      const symStatic = getRiseFallStaticLimit(sym);
      if (symStatic && !symStatic.supported) continue;
      try {
        const res = await this.requestPublic({ contracts_for: sym }, 8000);
        if (res?.error) {
          if (/no contract/i.test(String(res.error.message || ''))) sawNoContract = true;
          continue;
        }
        const avail = res?.contracts_for?.available;
        if (Array.isArray(avail)) {
          const timeContracts = avail.filter((c: any) =>
            (c.contract_type === 'CALL' || c.contract_type === 'PUT')
            && !String(c.min_contract_duration || '').toLowerCase().endsWith('t')
          );
          if (timeContracts.length === 0) {
            const lim: RiseFallLimit = {
              supported: false,
              minSec: 0,
              maxSec: 0,
              reason: `${symbol} does not offer Rise/Fall (CALL/PUT) contracts on Deriv`,
            };
            this.riseFallLimits.set(symbol, lim);
            this.riseFallLimits.set(sym, lim);
            return lim;
          }
          let minSec = Infinity;
          let maxSec = 0;
          for (const c of timeContracts) {
            const lo = parseDerivDurationSec(c.min_contract_duration);
            const hi = parseDerivDurationSec(c.max_contract_duration);
            if (Number.isFinite(lo) && lo < minSec) minSec = lo;
            if (Number.isFinite(hi) && hi > maxSec) maxSec = hi;
          }
          const lim: RiseFallLimit = {
            supported: true,
            minSec: Number.isFinite(minSec) ? minSec : 15,
            maxSec: maxSec > 0 ? maxSec : 86400,
          };
          this.riseFallLimits.set(symbol, lim);
          this.riseFallLimits.set(sym, lim);
          return lim;
        }
      } catch {
        /* try next candidate */
      }
    }

    if (staticLim) {
      this.riseFallLimits.set(symbol, staticLim);
      return staticLim;
    }
    if (sawNoContract) {
      const lim: RiseFallLimit = {
        supported: false,
        minSec: 0,
        maxSec: 0,
        reason: `${symbol} has no Rise/Fall contracts available on Deriv`,
      };
      this.riseFallLimits.set(symbol, lim);
      return lim;
    }
    return { supported: true, minSec: 15, maxSec: 86400 };
  }

  public supportsRiseFall(symbol: string, expirySec: number): { ok: boolean; reason?: string; minSec?: number } {
    const resolved = this.resolveSymbol(symbol);
    const cached = this.riseFallLimits.get(symbol) ?? this.riseFallLimits.get(resolved);
    const staticLim = getRiseFallStaticLimit(symbol) ?? getRiseFallStaticLimit(resolved);
    return evaluateRiseFallSupport(symbol, expirySec, cached ?? staticLim);
  }

  // --- Account & Trade Operations ---
  public async setAccount(demo: boolean): Promise<{ ok: boolean; msg: string }> {
    this.isDemo = demo;
    await this.initAuth(true);
    await this.ensureAuthConnected(10000).catch(() => {});
    return { ok: true, msg: `Switched to ${demo ? 'Demo' : 'Real'} account (${this.accountId})` };
  }

  public async placeTrade(asset: string, side: 'buy' | 'sell', amount: number, seconds: number): Promise<any> {
    const duration = Math.max(15, Number(seconds));
    const staticCheck = this.supportsRiseFall(asset, duration);
    if (!staticCheck.ok) {
      throw new Error(staticCheck.reason || `${asset} does not support ${duration}s Rise/Fall contracts on Deriv`);
    }

    await this.ensureAuthConnected(15000);

    const primarySym = this.resolveSymbol(asset);
    if (!this.riseFallLimits.has(asset) && !this.riseFallLimits.has(primarySym)) {
      const liveLim = await this.refreshRiseFallSupport(asset).catch(() => null);
      if (liveLim) {
        const liveCheck = evaluateRiseFallSupport(asset, duration, liveLim);
        if (!liveCheck.ok) {
          throw new Error(liveCheck.reason || `${asset} does not support ${duration}s Rise/Fall contracts on Deriv`);
        }
      }
    }

    const contractType = side.toLowerCase() === 'buy' ? 'CALL' : 'PUT';
    const candidates = Array.from(new Set([primarySym, ...this.getSymbolAliases(asset)]))
      .filter((sym) => evaluateRiseFallSupport(sym, duration).ok);

    if (candidates.length === 0) {
      throw new Error(`${asset} does not offer ${duration}s Rise/Fall contracts on Deriv`);
    }

    const requestProposal = async (): Promise<any> => {
      let propRes: any = null;
      let lastError: { code?: string; message?: string } | null = null;
      const baseProposal = {
        proposal: 1,
        amount: Number(amount),
        basis: 'stake',
        currency: this.currency,
        contract_type: contractType,
        duration,
        duration_unit: 's'
      };

      for (const sym of candidates) {
        let r: any = null;
        try {
          r = await this.requestAuth({ ...baseProposal, underlying_symbol: sym });
        } catch (err: any) {
          r = { error: { code: 'RequestError', message: err?.message || 'Proposal request failed' } };
        }

        if (r && !r.error && r.proposal?.id) {
          propRes = r;
          break;
        }

        const errCode = String(r?.error?.code || '');
        const errMsg = String(r?.error?.message || '');
        // Only try legacy `symbol` key if the API explicitly rejected the `underlying_symbol` parameter name
        if (errCode === 'InputValidationFailed' && /underlying_symbol/i.test(errMsg)) {
          try {
            const legacy = await this.requestAuth({ ...baseProposal, symbol: sym });
            if (legacy && !legacy.error && legacy.proposal?.id) {
              propRes = legacy;
              break;
            }
            if (legacy?.error && !/Input validation failed: symbol/i.test(String(legacy.error.message || ''))) {
              lastError = legacy.error;
            }
          } catch {}
        }

        if (r?.error) {
          lastError = r.error;
        }
      }

      if (!propRes && lastError) {
        return { error: lastError };
      }
      return propRes;
    };

    let propRes = await requestProposal();
    if (propRes?.error && /authoriz|invalid token|not logged in|please log in|session|Auth WS/i.test(String(propRes.error.message || '') + ' ' + String(propRes.error.code || ''))) {
      await this.initAuth(true);
      await this.ensureAuthConnected(10000);
      propRes = await requestProposal();
    }

    if (propRes && propRes.error) {
      throw new Error(propRes.error.message || 'Proposal failed');
    }

    const prop = propRes?.proposal;
    if (!prop || !prop.id) {
      throw new Error('Invalid proposal response from Deriv');
    }

    // Step 2: Buy
    const buyRes = await this.requestAuth({
      buy: prop.id,
      price: prop.ask_price
    });

    if (buyRes && buyRes.error) {
      throw new Error(buyRes.error.message || 'Buy order failed');
    }

    const buy = buyRes.buy;
    return {
      status: 'ok',
      id: String(buy.contract_id),
      stake: Number(buy.buy_price),
      payout: Number(buy.payout),
      msg: 'Trade placed successfully'
    };
  }

  public async getTradeResult(contractId: string, timeoutSec = 90): Promise<any> {
    const safeTimeout = Math.max(25, Number(timeoutSec) || 30);
    const end = Date.now() + (safeTimeout * 1000);
    while (Date.now() < end) {
      try {
        await this.ensureAuthConnected(8000);
        const res = await this.requestAuth({
          proposal_open_contract: 1,
          contract_id: Number(contractId)
        });
        if (res.proposal_open_contract) {
          const c = res.proposal_open_contract;
          if (c.is_sold || ['won', 'lost'].includes(c.status)) {
            const pnl = Number(c.profit || 0);
            const result = c.status === 'won' ? 'win' : c.status === 'lost' ? 'loss' : pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'draw';
            const rawEntry = Number(c.entry_tick ?? c.entry_spot);
            const rawExit = Number(c.exit_tick ?? c.sell_spot ?? c.current_spot);
            const rawStart = Number(c.date_start);
            const rawExpiry = Number(c.date_expiry);
            return {
              status: 'ok',
              result,
              profit: pnl,
              entryPrice: Number.isFinite(rawEntry) && rawEntry > 0 ? rawEntry : null,
              exitPrice: Number.isFinite(rawExit) && rawExit > 0 ? rawExit : null,
              entryTime: Number.isFinite(rawStart) && rawStart > 0 ? rawStart : null,
              exitTime: Number.isFinite(rawExpiry) && rawExpiry > 0 ? rawExpiry : null,
            };
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
    return { status: 'error', msg: 'Trade result timeout' };
  }
}

export const derivBridge = new DerivBridge();
