import * as signalR from '@microsoft/signalr';
import { isLocal, localBars, localInfo, localTicks } from './localdata';

const BASE = 'https://biquote.io';

export interface Tick {
  symbol: string;
  description?: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  high: number;
  low: number;
  direction?: 'UP' | 'DOWN' | 'FLAT';
  dayDiffPercent: number;
  timestamp: string;
  source?: string;
  exchange?: string | null;
  marketState?: 'open' | 'closed';
  stale?: boolean;
}

export interface SymbolInfo {
  name: string;
  description: string;
  exchange: string | null;
  type: string;
  digits?: number;
  currency?: string;
  source?: string;
  hasData?: boolean;
}

export interface Bar {
  time: number; // unix seconds, UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Mover {
  symbol: string;
  name: string;
  type: string;
  lastPrice: number;
  changePercent: number;
}

export interface NewsItem {
  title: string;
  description: string;
  url: string;
  publisher: string;
  publishedDate: string;
}

export interface CalendarEvent {
  id: string;
  time: string;
  countryCode: string;
  currency: string;
  name: string;
  importance: 'low' | 'medium' | 'high';
  unit?: string;
  digits?: number;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
}

type Params = Record<string, string | number | boolean | string[] | undefined>;

async function get<T>(path: string, params: Params = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    // arrays are sent as repeated params — the API does not accept the comma form
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else qs.append(k, String(v));
  }
  const q = qs.toString();
  const res = await fetch(`${BASE}${path}${q ? `?${q}` : ''}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Intervals the API serves natively, largest first. Every other timeframe is aggregated in the
// browser from one of these; second and tick timeframes are built from raw ticks instead.
const API_INTERVALS: [number, string][] = [
  [14400, '4h'],
  [3600, '1h'],
  [1800, '30m'],
  [900, '15m'],
  [300, '5m'],
  [60, '1m'],
];

/** `<count><unit>`: T ticks, s seconds, m minutes, h hours, d days, w weeks, M months. */
export type Timeframe = string;
type Unit = 'T' | 's' | 'm' | 'h' | 'd' | 'w' | 'M';
const UNIT_SECONDS: Record<Unit, number> = { T: 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800, M: 2592000 };
const MONDAY_OFFSET = 4 * 86400; // the unix epoch fell on a Thursday

export function parseTf(tf: Timeframe): { n: number; unit: Unit } | null {
  const m = /^(\d{1,4})([TsmhdwM])$/.exec(tf);
  return m && Number(m[1]) > 0 ? { n: Number(m[1]), unit: m[2] as Unit } : null;
}

/** Normalise typed input such as "45", "3H", "2d" or "100t". A bare number means minutes; capital M means months. */
export function normalizeTf(input: string): Timeframe | null {
  const m = /^(\d{1,4})\s*([a-zA-Z]?)$/.exec(input.trim());
  if (!m) return null;
  const l = m[2];
  const unit = l === '' || l === 'm' ? 'm' : l === 'M' ? 'M' : ({ t: 'T', s: 's', h: 'h', d: 'd', w: 'w' } as Record<string, Unit>)[l.toLowerCase()];
  const tf = `${Number(m[1])}${unit}`;
  return unit && parseTf(tf) ? tf : null;
}

export function tfLabel(tf: Timeframe) {
  const p = parseTf(tf);
  if (!p) return tf;
  return p.unit === 'd' || p.unit === 'w' || p.unit === 'M' ? `${p.n === 1 ? '' : p.n}${p.unit.toUpperCase()}` : tf;
}

/** Nominal bar length in seconds (a month counts as 30 days; tick bars as 1). */
export function tfSeconds(tf: Timeframe) {
  const p = parseTf(tf);
  return p ? p.n * UNIT_SECONDS[p.unit] : 3600;
}
export const isTickBased = (tf: Timeframe) => /[Ts]$/.test(tf);
export const isIntraday = (tf: Timeframe) => tfSeconds(tf) < 86400;

const monthIndex = (t: number) => {
  const d = new Date(t * 1000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};
const monthStart = (idx: number) => Date.UTC(Math.floor(idx / 12), idx % 12, 1) / 1000;

/** Open time of the bar that `t` (unix seconds) belongs to. */
export function bucketStart(t: number, tf: Timeframe): number {
  const p = parseTf(tf);
  if (!p || p.unit === 'T') return t;
  if (p.unit === 'M') return monthStart(monthIndex(t) - (monthIndex(t) % p.n));
  const s = p.n * UNIT_SECONDS[p.unit];
  if (p.unit === 'w') return Math.floor((t - MONDAY_OFFSET) / s) * s + MONDAY_OFFSET;
  return Math.floor(t / s) * s;
}

/** Close time of the bar that `t` belongs to. */
export function bucketEnd(t: number, tf: Timeframe): number {
  const p = parseTf(tf);
  if (p?.unit === 'M') return monthStart(monthIndex(bucketStart(t, tf)) + p.n);
  return bucketStart(t, tf) + tfSeconds(tf);
}

/**
 * Fold one price into a bar array in place. Returns true when a new bar was opened,
 * false when the last bar was updated, and null when the price was ignored.
 */
export function foldPrice(bars: Bar[], tf: Timeframe, price: number, t: number, countTicks: boolean): boolean | null {
  const p = parseTf(tf);
  const last = bars[bars.length - 1];
  let start: number;
  if (!last) {
    // only tick-built charts may start from nothing; the rest need their history first
    if (!isTickBased(tf)) return null;
    start = bucketStart(t, tf);
  } else if (p?.unit === 'T') {
    // tick bars keep their tick count in `volume`
    start = last.volume >= p.n ? Math.max(t, last.time + 1) : last.time;
  } else {
    start = bucketStart(t, tf);
    if (start < last.time) return null;
  }
  if (!last || start > last.time) {
    bars.push({ time: start, open: price, high: price, low: price, close: price, volume: countTicks ? 1 : 0 });
    return true;
  }
  last.close = price;
  last.high = Math.max(last.high, price);
  last.low = Math.min(last.low, price);
  if (countTicks) last.volume++;
  return false;
}

interface RawBar {
  openTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tickVolume: number;
}

export interface BarSet {
  bars: Bar[];
  /** true when the feed has no traded volume and `volume` holds tick counts */
  tickVolume: boolean;
  /** Present when older history can be paged in: resolves to the next batch of older bars, or null at the start. */
  more?: () => Promise<Bar[] | null>;
}

export async function fetchBars(symbol: string, tf: Timeframe): Promise<BarSet> {
  if (isLocal(symbol)) return localBars(symbol, tf);
  const path = `/api/${encodeURIComponent(symbol)}`;
  if (isTickBased(tf)) {
    // the API keeps only a short tail of raw ticks, so these charts mostly build up live
    const ticks = await get<Tick[]>(`${path}/history`, { count: 1000 });
    const bars: Bar[] = [];
    ticks
      .map((t) => ({ price: t.mid || (t.bid + t.ask) / 2, time: Date.parse(t.timestamp) / 1000 }))
      .filter((t) => t.price > 0 && !Number.isNaN(t.time))
      .sort((a, b) => a.time - b.time)
      .forEach((t) => foldPrice(bars, tf, t.price, t.time, true));
    return { bars, tickVolume: true };
  }

  const secs = tfSeconds(tf);
  const base = secs >= 86400 ? '1d' : (API_INTERVALS.find(([s]) => secs % s === 0)?.[1] ?? '1m');
  const data = await get<{ bars: RawBar[] }>(`${path}/ohlc`, { interval: base, limit: 1000 });
  const raw = data.bars ?? [];
  const tickVolume = !raw.some((b) => b.volume > 0);
  const bars: Bar[] = raw
    .map((b) => ({
      time: Math.floor(Date.parse(b.openTime) / 1000),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume || b.tickVolume || 0,
    }))
    .sort((a, b) => a.time - b.time)
    .filter((b, i, arr) => i === 0 || b.time !== arr[i - 1].time);
  if (tf === base) return { bars, tickVolume };

  const out: Bar[] = [];
  for (const b of bars) {
    const t = bucketStart(b.time, tf);
    const w = out[out.length - 1];
    if (w && w.time === t) {
      w.high = Math.max(w.high, b.high);
      w.low = Math.min(w.low, b.low);
      w.close = b.close;
      w.volume += b.volume;
    } else {
      out.push({ ...b, time: t });
    }
  }
  return { bars: out, tickVolume };
}

/** Latest quotes. Imported symbols have no feed, so theirs are made up from the last stored bars. */
export async function fetchLatest(symbols: string[]): Promise<Record<string, Tick>> {
  const remote = symbols.filter((s) => !isLocal(s));
  const [live, local] = await Promise.all([
    remote.length ? get<Record<string, Tick>>('/api/latest', { symbols: remote, allowStale: true }) : {},
    localTicks(symbols.filter(isLocal)),
  ]);
  return { ...live, ...local };
}

export const fetchSymbol = (name: string) => (isLocal(name) ? localInfo(name) : get<SymbolInfo>(`/api/symbols/${encodeURIComponent(name)}`));

export const searchSymbols = (q: string) => get<SymbolInfo[]>('/api/symbols/search', { q, limit: 100 });

export const listSymbols = (type?: string) => get<SymbolInfo[]>('/api/symbols', { type, quotedWithinDays: 7 });

export const fetchMovers = (kind: 'gainers' | 'losers', period: string, type?: string) =>
  get<{ data: Mover[] }>(`/api/market/${kind}`, { period, type, limit: 15 }).then((r) => r.data ?? []);

export const fetchNews = (symbol?: string) => get<NewsItem[]>('/api/news/market', { symbol, maxResults: 30 });

export const fetchCalendar = (importance?: string) =>
  get<CalendarEvent[]>('/api/calendar/upcoming', { importance, limit: 60 });

export type FeedStatus = 'connecting' | 'live' | 'polling' | 'offline';

/**
 * Live tick feed over the SignalR hub. While the socket is down it falls back
 * to polling /api/latest so prices keep moving.
 */
export class TickFeed {
  private conn: signalR.HubConnection;
  private subs = new Set<string>();
  private pollTimer: number | undefined;
  onTick: (t: Tick) => void = () => {};
  onStatus: (s: FeedStatus) => void = () => {};

  constructor() {
    this.conn = new signalR.HubConnectionBuilder()
      // the hub's CORS policy allows any origin but no credentials
      .withUrl(`${BASE}/hubs/tick`, { withCredentials: false })
      .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => Math.min(1000 * 2 ** ctx.previousRetryCount, 15000) })
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    this.conn.on('ReceiveTick', (payload: Tick | Tick[]) => {
      for (const t of Array.isArray(payload) ? payload : [payload]) if (t?.symbol) this.onTick(t);
    });
    this.conn.onreconnecting(() => this.setPolling(true, 'connecting'));
    this.conn.onreconnected(() => {
      this.setPolling(false, 'live');
      void this.send('Subscribe', [...this.subs]);
    });
    this.conn.onclose(() => {
      this.setPolling(true, 'polling');
      window.setTimeout(() => void this.start(), 10000);
    });
  }

  async start() {
    this.onStatus('connecting');
    try {
      await this.conn.start();
      this.setPolling(false, 'live');
      await this.send('Subscribe', [...this.subs]);
    } catch {
      this.setPolling(true, 'polling');
      window.setTimeout(() => void this.start(), 10000);
    }
  }

  /** Replace the subscription set, sending only the difference to the hub. */
  async setSymbols(symbols: string[]) {
    symbols = symbols.filter((s) => !isLocal(s));
    const next = new Set(symbols);
    const add = symbols.filter((s) => !this.subs.has(s));
    const drop = [...this.subs].filter((s) => !next.has(s));
    this.subs = next;
    await this.send('Unsubscribe', drop);
    await this.send('Subscribe', add);
  }

  private async send(method: 'Subscribe' | 'Unsubscribe', symbols: string[]) {
    if (!symbols.length || this.conn.state !== signalR.HubConnectionState.Connected) return;
    try {
      await this.conn.invoke(method, symbols);
    } catch (e) {
      console.warn(`${method} failed`, e);
    }
  }

  private setPolling(on: boolean, status: FeedStatus) {
    window.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    if (on) {
      this.pollTimer = window.setInterval(async () => {
        try {
          const ticks = await fetchLatest([...this.subs]);
          Object.values(ticks).forEach((t) => this.onTick(t));
          this.onStatus('polling');
        } catch {
          this.onStatus('offline');
        }
      }, 3000);
    }
    this.onStatus(status);
  }
}
