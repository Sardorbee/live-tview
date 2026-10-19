import { bucketStart, isTickBased, tfSeconds, type Bar, type BarSet, type SymbolInfo, type Tick, type Timeframe } from './api';

/**
 * TradingView's public data socket, used without an account (the same way their own pages
 * talk to it before you sign in). Symbols are written `TV:<EXCHANGE>:<TICKER>`, for example
 * `TV:BINANCE:BTCUSDT` or `TV:NASDAQ:AAPL`.
 *
 * Frames look like `~m~<length>~m~<json>`; the server sends `~m~N~m~~h~<n>` heartbeats that
 * have to be echoed back or it drops the connection. Some exchanges are delayed for
 * signed-out users, and seconds and custom intervals are not available.
 */

export const TV_PREFIX = 'TV:';
export const isTv = (symbol: string) => symbol.startsWith(TV_PREFIX);
const tvName = (symbol: string) => symbol.slice(TV_PREFIX.length).toUpperCase();

// TradingView only accepts this socket from localhost and its own pages, so a deployed copy
// needs a relay that forwards it with an allowed Origin header; VITE_TV_SOCKET points at one.
const URL = import.meta.env.VITE_TV_SOCKET || 'wss://data.tradingview.com/socket.io/websocket';
const QUOTE_FIELDS = [
  'lp', 'lp_time', 'ch', 'chp', 'bid', 'ask', 'high_price', 'low_price', 'volume',
  'description', 'exchange', 'type', 'pricescale', 'current_session', 'currency_code', 'update_mode',
];

type Msg = { m: string; p: unknown[] };
type Handler = (m: Msg) => void;

const token = () => Math.random().toString(36).slice(2, 14);
const frame = (s: string) => `~m~${s.length}~m~${s}`;

class Socket {
  private ws: WebSocket | null = null;
  private open = false;
  private queue: string[] = [];
  private retry = 0;
  /** per-session message handlers, keyed by session id (the first parameter of every message) */
  private handlers = new Map<string, Handler>();
  /** re-sent after every reconnect so live sessions come back by themselves */
  private restore = new Map<string, () => void>();
  onState: (open: boolean) => void = () => {};

  private connect() {
    if (this.ws) return;
    const ws = (this.ws = new WebSocket(URL));
    ws.onopen = () => {
      this.open = true;
      this.retry = 0;
      this.raw('set_auth_token', ['unauthorized_user_token']);
      this.restore.forEach((f) => f());
      this.queue.splice(0).forEach((s) => ws.send(s));
      this.onState(true);
    };
    ws.onmessage = (e) => this.receive(String(e.data));
    ws.onclose = () => {
      this.ws = null;
      this.open = false;
      this.onState(false);
      // sessions that only existed for one request are gone with the socket
      this.queue = [];
      this.handlers.forEach((h, id) => !this.restore.has(id) && h({ m: 'critical_error', p: [id, "Couldn't reach TradingView"] }));
      if (this.handlers.size) window.setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.retry++, 15000));
    };
  }

  private receive(data: string) {
    for (const part of data.split(/~m~\d+~m~/)) {
      if (!part) continue;
      if (part.startsWith('~h~')) {
        this.ws?.send(frame(part));
        continue;
      }
      let msg: Msg;
      try {
        msg = JSON.parse(part);
      } catch {
        continue;
      }
      if (msg.m && Array.isArray(msg.p)) this.handlers.get(String(msg.p[0]))?.(msg);
    }
  }

  private raw(m: string, p: unknown[]) {
    const s = frame(JSON.stringify({ m, p }));
    if (this.open) this.ws!.send(s);
    else this.queue.push(s);
  }

  /** Send a message once the socket is up. */
  send(m: string, p: unknown[]) {
    this.connect();
    this.raw(m, p);
  }

  /** Open a session. `setup` sends its create/subscribe messages and, when `persistent`, runs again after a reconnect. */
  session(id: string, handler: Handler, setup: () => void, persistent = false) {
    this.handlers.set(id, handler);
    if (persistent) this.restore.set(id, setup);
    this.connect();
    if (this.open || !persistent) setup();
  }

  close(id: string, deleteMsg: string) {
    this.handlers.delete(id);
    this.restore.delete(id);
    if (this.open) this.raw(deleteMsg, [id]);
  }
}

const socket = new Socket();

// ---------------------------------------------------------------- quotes

type QuoteValues = Record<string, unknown>;
const quotes = new Map<string, QuoteValues>();

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Decimals needed to show one price step; fractional scales such as 64 (1/64) need more than log10 gives. */
function digitsOf(pricescale: unknown) {
  const ps = num(pricescale);
  if (ps <= 1) return undefined;
  const d = Math.log10(ps);
  return Number.isInteger(d) ? d : Math.min(8, (String(1 / ps).split('.')[1] ?? '').length);
}

/** Seconds the feed lags behind the market, from `update_mode` (`streaming`, `delayed_streaming_600`, `endofday`). */
function delayOf(mode: unknown): number {
  if (typeof mode !== 'string' || mode === 'streaming') return 0;
  if (mode === 'endofday') return 86400;
  const m = /delayed\D*(\d+)/.exec(mode);
  return m ? Number(m[1]) : mode.includes('delayed') ? 900 : 0;
}

const TYPES: Record<string, string> = { forex: 'Forex', crypto: 'Crypto', stock: 'Stock', fund: 'Stock', dr: 'Stock', index: 'Index', futures: 'Futures', commodity: 'Commodity', cfd: 'Commodity', spot: 'Crypto' };

function toTick(symbol: string, v: QuoteValues): Tick | null {
  const lp = num(v.lp);
  if (!lp) return null;
  const delay = delayOf(v.update_mode);
  const bid = num(v.bid) || lp;
  const ask = num(v.ask) || lp;
  return {
    symbol,
    description: typeof v.description === 'string' ? v.description : undefined,
    bid,
    ask,
    // charts follow the last trade, as TradingView's own do
    mid: lp,
    spread: ask - bid,
    high: num(v.high_price) || lp,
    low: num(v.low_price) || lp,
    dayDiffPercent: num(v.chp),
    // delayed feeds such as CME futures send no trade time; date them back by the delay so they land in the right bar
    timestamp: new Date((num(v.lp_time) || Date.now() / 1000 - (delay < 86400 ? delay : 0)) * 1000).toISOString(),
    delay,
    source: 'TradingView',
    exchange: typeof v.exchange === 'string' ? v.exchange : null,
    marketState: v.current_session === undefined ? undefined : v.current_session === 'market' ? 'open' : 'closed',
  };
}

function toInfo(symbol: string, v: QuoteValues): SymbolInfo {
  return {
    name: symbol,
    description: typeof v.description === 'string' ? v.description : tvName(symbol),
    exchange: typeof v.exchange === 'string' ? v.exchange : tvName(symbol).split(':')[0],
    type: TYPES[String(v.type)] ?? 'TradingView',
    digits: digitsOf(v.pricescale),
    currency: typeof v.currency_code === 'string' ? v.currency_code : undefined,
    source: 'TradingView',
    hasData: true,
  };
}

/** One quote snapshot per symbol, from a throwaway quote session. Symbols TradingView does not know come back as null. */
function snapshot(symbols: string[], timeout = 8000): Promise<Record<string, QuoteValues | null>> {
  const want = new Set(symbols.map(tvName));
  const out: Record<string, QuoteValues | null> = {};
  const finished = new Set<string>();
  if (!want.size) return Promise.resolve(out);
  return new Promise((resolve) => {
    const qs = `qs_${token()}`;
    const done = () => {
      window.clearTimeout(timer);
      socket.close(qs, 'quote_delete_session');
      resolve(out);
    };
    const timer = window.setTimeout(done, timeout);
    socket.session(qs, (msg) => {
      if (msg.m === 'critical_error') return done();
      if (msg.m === 'quote_completed') finished.add(String(msg.p[1]));
      else if (msg.m === 'qsd') {
        const d = msg.p[1] as { n: string; s: string; v: QuoteValues };
        if (d.s === 'ok') out[TV_PREFIX + d.n] = { ...out[TV_PREFIX + d.n], ...d.v };
        else (out[TV_PREFIX + d.n] = null), finished.add(d.n);
      }
      if (finished.size >= want.size) done();
    }, () => {
      socket.send('quote_create_session', [qs]);
      socket.send('quote_set_fields', [qs, ...QUOTE_FIELDS]);
      socket.send('quote_add_symbols', [qs, ...want]);
    });
  });
}

export async function tvInfo(symbol: string): Promise<SymbolInfo> {
  const v = quotes.get(symbol) ?? (await snapshot([symbol]))[symbol];
  if (!v) throw new Error(`TradingView has no symbol ${tvName(symbol)}`);
  quotes.set(symbol, { ...v, ...quotes.get(symbol) });
  return toInfo(symbol, v);
}

export async function tvLatest(symbols: string[]): Promise<Record<string, Tick>> {
  const missing = symbols.filter((s) => !quotes.get(s)?.lp);
  const snap = await snapshot(missing);
  const out: Record<string, Tick> = {};
  for (const s of symbols) {
    const v = quotes.get(s) || snap[s] ? { ...snap[s], ...quotes.get(s) } : null;
    if (!v) continue;
    quotes.set(s, v);
    const t = toTick(s, v);
    if (t) out[s] = t;
  }
  return out;
}

/** Streams quotes for the symbols it is given over one long-lived quote session. */
export class TvFeed {
  private qs = `qs_${token()}`;
  private subs = new Set<string>();
  private started = false;
  onTick: (t: Tick) => void = () => {};

  setSymbols(symbols: string[]) {
    const next = new Set(symbols.filter(isTv).map(tvName));
    const add = [...next].filter((s) => !this.subs.has(s));
    const drop = [...this.subs].filter((s) => !next.has(s));
    this.subs = next;
    if (!this.started) {
      if (!next.size) return;
      this.started = true;
      socket.session(this.qs, (m) => this.receive(m), () => {
        socket.send('quote_create_session', [this.qs]);
        socket.send('quote_set_fields', [this.qs, ...QUOTE_FIELDS]);
        if (this.subs.size) socket.send('quote_add_symbols', [this.qs, ...this.subs]);
      }, true);
      return;
    }
    if (drop.length) socket.send('quote_remove_symbols', [this.qs, ...drop]);
    if (add.length) socket.send('quote_add_symbols', [this.qs, ...add]);
  }

  private receive(msg: Msg) {
    if (msg.m !== 'qsd') return;
    const d = msg.p[1] as { n: string; s: string; v: QuoteValues };
    if (d.s !== 'ok' || !this.subs.has(d.n)) return;
    const symbol = TV_PREFIX + d.n;
    const v = { ...quotes.get(symbol), ...d.v };
    quotes.set(symbol, v);
    // bid/ask-only packets are folded in silently so tick charts count trades, not quote changes
    if (!('lp' in d.v || 'lp_time' in d.v || 'volume' in d.v || 'current_session' in d.v)) return;
    const t = toTick(symbol, v);
    if (t) this.onTick(t);
  }
}

// ---------------------------------------------------------------- bars

/** Resolutions TradingView serves to signed-out users, in seconds, largest first. */
const RESOLUTIONS: [number, string][] = [
  [14400, '240'], [10800, '180'], [7200, '120'], [3600, '60'], [2700, '45'],
  [1800, '30'], [900, '15'], [300, '5'], [180, '3'], [60, '1'],
];

function resolutionFor(tf: Timeframe): string {
  const unit = tf.slice(-1);
  if (unit === 'M') return '1M';
  if (unit === 'w') return '1W';
  if (unit === 'd') return '1D';
  const secs = tfSeconds(tf);
  return RESOLUTIONS.find(([s]) => secs % s === 0)?.[1] ?? '1';
}

interface Series {
  bars: Bar[];
  /** TradingView has nothing older than these bars */
  complete: boolean;
}

/** Load `count` bars from a throwaway chart session. */
function series(symbol: string, resolution: string, count: number, timeout = 20000): Promise<Series> {
  return new Promise((resolve, reject) => {
    const cs = `cs_${token()}`;
    let bars: Bar[] = [];
    const finish = (err?: Error) => {
      window.clearTimeout(timer);
      socket.close(cs, 'chart_delete_session');
      if (err) reject(err);
    };
    const timer = window.setTimeout(() => finish(new Error('TradingView did not answer')), timeout);
    socket.session(cs, (msg) => {
      switch (msg.m) {
        case 'timescale_update': {
          const s = (msg.p[1] as Record<string, { s?: { v: number[] }[] }>).sds_1?.s ?? [];
          bars = s.map(({ v }) => ({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] ?? 0 }));
          break;
        }
        case 'series_completed': {
          const status = (msg.p[4] as { data_completed?: string } | undefined)?.data_completed;
          finish();
          resolve({ bars, complete: status === 'end' || bars.length < count });
          break;
        }
        case 'symbol_error':
          return finish(new Error(`TradingView has no symbol ${tvName(symbol)}`));
        case 'series_error':
          return finish(new Error(`TradingView refused this interval (${String(msg.p[3] ?? 'error')})`));
        case 'critical_error':
        case 'protocol_error':
          return finish(new Error(String(msg.p[1] ?? 'TradingView error')));
      }
    }, () => {
      socket.send('chart_create_session', [cs, '']);
      socket.send('resolve_symbol', [cs, 'sym', '=' + JSON.stringify({ symbol: tvName(symbol), adjustment: 'splits' })]);
      socket.send('create_series', [cs, 'sds_1', 's1', 'sym', resolution, count, '']);
    });
  });
}

/** Roll bars up into `tf` buckets. Daily and longer bars are snapped to the app's day/week/month starts. */
function rollUp(bars: Bar[], tf: Timeframe): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const t = bucketStart(b.time, tf);
    const w = out[out.length - 1];
    if (w && w.time === t) {
      w.high = Math.max(w.high, b.high);
      w.low = Math.min(w.low, b.low);
      w.close = b.close;
      w.volume += b.volume;
    } else if (!w || t > w.time) {
      out.push({ ...b, time: t });
    }
  }
  return out;
}

const PAGE = 5000;
// the free tier stops a little above 10k bars on intraday resolutions
const MAX_BARS = 20000;

export async function tvBars(symbol: string, tf: Timeframe): Promise<BarSet> {
  // seconds and tick charts are not served to signed-out users; they build up from the live feed
  if (isTickBased(tf)) return { bars: [], tickVolume: true };
  const res = resolutionFor(tf);
  let count = PAGE;
  let first = await series(symbol, res, count);
  const bars = rollUp(first.bars, tf);
  const tickVolume = !first.bars.some((b) => b.volume > 0);
  let oldest = bars[0]?.time ?? Infinity;
  let done = first.complete;
  // there is no "bars before T" request, so paging asks for a longer series and keeps the older part
  const more = async () => {
    if (done || count >= MAX_BARS) return null;
    count = Math.min(count * 2, MAX_BARS);
    first = await series(symbol, res, count);
    done = first.complete;
    const older = rollUp(first.bars, tf).filter((b) => b.time < oldest);
    // the bucket the old first bar sat in may have been cut short; it is already on the chart, so drop it
    if (older.length && bucketStart(older[older.length - 1].time, tf) === bucketStart(oldest, tf)) older.pop();
    if (!older.length) return null;
    oldest = older[0].time;
    return older;
  };
  return { bars, tickVolume, more };
}

// ---------------------------------------------------------------- search

/** A few well-known TradingView symbols so the list is not empty before you type. */
export const TV_POPULAR: [string, string, string][] = [
  ['BINANCE:BTCUSDT', 'Bitcoin / TetherUS', 'Crypto'],
  ['BINANCE:ETHUSDT', 'Ethereum / TetherUS', 'Crypto'],
  ['BINANCE:SOLUSDT', 'Solana / TetherUS', 'Crypto'],
  ['COINBASE:BTCUSD', 'Bitcoin / U.S. Dollar', 'Crypto'],
  ['OANDA:XAUUSD', 'Gold Spot / U.S. Dollar', 'Commodity'],
  ['OANDA:EURUSD', 'Euro / U.S. Dollar', 'Forex'],
  ['FX:GBPUSD', 'British Pound / U.S. Dollar', 'Forex'],
  ['FX:USDJPY', 'U.S. Dollar / Japanese Yen', 'Forex'],
  ['TVC:DXY', 'U.S. Dollar Index', 'Index'],
  ['SP:SPX', 'S&P 500', 'Index'],
  ['NASDAQ:NDX', 'Nasdaq 100', 'Index'],
  ['TVC:DJI', 'Dow Jones Industrial Average', 'Index'],
  ['NASDAQ:AAPL', 'Apple Inc.', 'Stock'],
  ['NASDAQ:NVDA', 'NVIDIA Corporation', 'Stock'],
  ['NASDAQ:TSLA', 'Tesla, Inc.', 'Stock'],
  ['TVC:USOIL', 'Crude Oil', 'Commodity'],
  // continuous front-month futures (`1!`); `2!` is the next contract
  ['CME_MINI:ES1!', 'E-mini S&P 500 Futures', 'Futures'],
  ['CME_MINI:NQ1!', 'E-mini Nasdaq-100 Futures', 'Futures'],
  ['CBOT_MINI:YM1!', 'E-mini Dow Futures', 'Futures'],
  ['CME_MINI:RTY1!', 'E-mini Russell 2000 Futures', 'Futures'],
  ['CME_MINI:MES1!', 'Micro E-mini S&P 500 Futures', 'Futures'],
  ['CME_MINI:MNQ1!', 'Micro E-mini Nasdaq-100 Futures', 'Futures'],
  ['COMEX:GC1!', 'Gold Futures', 'Futures'],
  ['COMEX:MGC1!', 'Micro Gold Futures', 'Futures'],
  ['COMEX:SI1!', 'Silver Futures', 'Futures'],
  ['COMEX:HG1!', 'Copper Futures', 'Futures'],
  ['NYMEX:CL1!', 'Crude Oil Futures', 'Futures'],
  ['NYMEX:NG1!', 'Natural Gas Futures', 'Futures'],
  ['CBOT:ZN1!', '10-Year T-Note Futures', 'Futures'],
  ['CBOT:ZB1!', 'U.S. Treasury Bond Futures', 'Futures'],
  ['CME:6E1!', 'Euro FX Futures', 'Futures'],
  ['CME:6J1!', 'Japanese Yen Futures', 'Futures'],
  ['CME:BTC1!', 'Bitcoin Futures', 'Futures'],
  ['CBOT:ZC1!', 'Corn Futures', 'Futures'],
  ['CBOT:ZS1!', 'Soybean Futures', 'Futures'],
];

/**
 * TradingView's search API does not answer other sites, so search is local: the popular list,
 * plus whatever was typed when it looks like `EXCHANGE:TICKER`.
 */
export function tvSearch(q: string, type?: string): SymbolInfo[] {
  q = q.trim().toUpperCase().replace(/^TV:/, '');
  const list: SymbolInfo[] = TV_POPULAR.filter(([n, d, t]) => (!type || t === type) && (!q || `${n} ${d}`.toUpperCase().includes(q))).map(([n, d, t]) => ({
    name: TV_PREFIX + n,
    description: d,
    exchange: n.split(':')[0],
    type: t,
    source: 'TradingView',
  }));
  if (/^[A-Z0-9_.!-]+:[A-Z0-9_.!&/-]+$/.test(q) && !list.some((s) => s.name === TV_PREFIX + q)) {
    list.unshift({ name: TV_PREFIX + q, description: 'TradingView symbol', exchange: q.split(':')[0], type: 'TradingView', source: 'TradingView' });
  }
  return list;
}
