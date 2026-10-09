import { bucketStart, isTickBased, tfSeconds, type Bar, type BarSet, type SymbolInfo, type Tick, type Timeframe } from './api';

/**
 * Imported CSV history, kept in IndexedDB so it only has to be imported once.
 *
 * Minute bars are stored one chunk per month, and at import time they are also rolled up into
 * hourly (one chunk per year) and daily (one chunk) series. A chart then reads the coarsest series
 * its timeframe can be built from, a few chunks at a time, and pages further back on demand.
 */

export const LOCAL_PREFIX = 'CSV:';
export const isLocal = (symbol: string) => symbol.startsWith(LOCAL_PREFIX);

type Res = 'm1' | 'h1' | 'd1';
const RES_SECONDS: Record<Res, number> = { m1: 60, h1: 3600, d1: 86400 };

interface Meta {
  symbol: string;
  description: string;
  digits: number;
  from: number;
  to: number;
  /** chunk ids per resolution, oldest first */
  chunks: Record<Res, string[]>;
  last: Bar;
  day: Bar;
  prevClose: number | null;
}

interface Chunk {
  key: string;
  n: number;
  t: ArrayBuffer;
  o: ArrayBuffer;
  h: ArrayBuffer;
  l: ArrayBuffer;
  c: ArrayBuffer;
  v: ArrayBuffer;
}

// --- storage -------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | undefined;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('tview-local', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('series', { keyPath: 'key' });
      req.result.createObjectStore('symbols', { keyPath: 'symbol' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run<T>(store: 'series' | 'symbols', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const chunkKey = (symbol: string, res: Res, id: string) => `${symbol}|${res}|${id}`;

// Prices are stored as 32-bit floats: a sixth of the size of bar objects, and still exact to the
// displayed precision for anything quoted with up to ~7 significant digits.
function pack(key: string, bars: Bar[]): Chunk {
  const n = bars.length;
  const t = new Uint32Array(n);
  const cols = { o: new Float32Array(n), h: new Float32Array(n), l: new Float32Array(n), c: new Float32Array(n), v: new Float32Array(n) };
  bars.forEach((b, i) => {
    t[i] = b.time;
    cols.o[i] = b.open;
    cols.h[i] = b.high;
    cols.l[i] = b.low;
    cols.c[i] = b.close;
    cols.v[i] = b.volume;
  });
  return { key, n, t: t.buffer, o: cols.o.buffer, h: cols.h.buffer, l: cols.l.buffer, c: cols.c.buffer, v: cols.v.buffer };
}

function unpack(ch: Chunk | undefined, digits: number): Bar[] {
  if (!ch) return [];
  const t = new Uint32Array(ch.t);
  const [o, h, l, c, v] = [ch.o, ch.h, ch.l, ch.c, ch.v].map((b) => new Float32Array(b));
  const f = 10 ** digits;
  const r = (x: number) => Math.round(x * f) / f; // undo float32 noise
  const out: Bar[] = new Array(ch.n);
  for (let i = 0; i < ch.n; i++) out[i] = { time: t[i], open: r(o[i]), high: r(h[i]), low: r(l[i]), close: r(c[i]), volume: v[i] };
  return out;
}

const metas = new Map<string, Meta>();
const ready: Promise<void> = run<Meta[]>('symbols', 'readonly', (s) => s.getAll())
  .then((list) => list.forEach((m) => metas.set(m.symbol, m)))
  .catch((e) => console.warn('imported data unavailable', e));
export const localReady = ready;

// --- reading -------------------------------------------------------------------

function aggregate(bars: Bar[], tf: Timeframe, exact: boolean): Bar[] {
  if (exact) return bars;
  const out: Bar[] = [];
  for (const b of bars) {
    const t = bucketStart(b.time, tf);
    const w = out[out.length - 1];
    if (w && w.time === t) {
      w.high = Math.max(w.high, b.high);
      w.low = Math.min(w.low, b.low);
      w.close = b.close;
      w.volume += b.volume;
    } else out.push({ ...b, time: t });
  }
  return out;
}

const BARS_PER_PAGE = 4000;

export async function localBars(symbol: string, tf: Timeframe): Promise<BarSet> {
  await ready;
  const meta = metas.get(symbol);
  const name = symbol.slice(LOCAL_PREFIX.length);
  if (!meta) throw new Error(`no imported data for ${name} in this browser — import the CSV files again`);
  if (isTickBased(tf)) throw new Error('imported data has no tick history; use 1m or higher');
  const secs = tfSeconds(tf);
  const res: Res = secs >= 86400 ? 'd1' : secs % 3600 === 0 ? 'h1' : 'm1';
  const ids = meta.chunks[res];
  if (!ids.length) throw new Error(`no ${res === 'm1' ? 'minute' : 'hourly'} data was imported for ${name}`);
  const perBar = secs / RES_SECONDS[res];
  let next = ids.length; // chunks before this index are still unread

  /** Read whole chunks, newest first, until there is about a page of bars at this timeframe. */
  const page = async (): Promise<Bar[] | null> => {
    if (next <= 0) return null;
    let raw: Bar[] = [];
    while (next > 0 && raw.length < BARS_PER_PAGE * perBar) {
      const ch = await run<Chunk | undefined>('series', 'readonly', (s) => s.get(chunkKey(symbol, res, ids[--next])));
      raw = unpack(ch, meta.digits).concat(raw);
    }
    return aggregate(raw, tf, perBar === 1);
  };

  return { bars: (await page()) ?? [], tickVolume: false, more: page };
}

export async function localInfo(symbol: string): Promise<SymbolInfo> {
  await ready;
  const m = metas.get(symbol);
  if (!m) throw new Error('not imported');
  return toInfo(m);
}

const toInfo = (m: Meta): SymbolInfo => ({ name: m.symbol, description: m.description, exchange: 'CSV', type: 'Imported', digits: m.digits, source: 'Imported CSV', hasData: true });

export const localSymbols = () => [...metas.values()].map(toInfo);

/** A stand-in quote built from the last imported bars, so watchlist rows and the detail card have something to show. */
export async function localTicks(symbols: string[]): Promise<Record<string, Tick>> {
  await ready;
  const out: Record<string, Tick> = {};
  for (const s of symbols) {
    const m = metas.get(s);
    if (!m) continue;
    const p = m.last.close;
    out[s] = {
      symbol: s,
      description: m.description,
      bid: p,
      ask: p,
      mid: p,
      spread: 0,
      high: m.day.high,
      low: m.day.low,
      dayDiffPercent: m.prevClose ? ((p - m.prevClose) / m.prevClose) * 100 : 0,
      timestamp: new Date(m.last.time * 1000).toISOString(),
      source: `Imported CSV · ${day(m.from)} to ${day(m.to)}`,
      marketState: 'closed',
    };
  }
  return out;
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

export async function deleteLocal(symbol: string) {
  await run('series', 'readwrite', (s) => s.delete(IDBKeyRange.bound(`${symbol}|`, `${symbol}|￿`)));
  await run('symbols', 'readwrite', (s) => s.delete(symbol));
  metas.delete(symbol);
}

// --- importing -----------------------------------------------------------------

interface Parsed {
  bars: Bar[];
  digits: number;
}

function parseCsv(text: string): Parsed {
  const lines = text.split('\n');
  const head = lines[0].toLowerCase().split(',').map((s) => s.trim().replace(/^﻿/, ''));
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iMs = col('timestamp_ms');
  const iTime = col('time_utc', 'time', 'datetime', 'date', 'timestamp', 'gmt time');
  const [iO, iH, iL, iC, iV] = [col('open'), col('high'), col('low'), col('close'), col('volume', 'vol', 'tick_volume')];
  if ((iMs < 0 && iTime < 0) || iO < 0 || iH < 0 || iL < 0 || iC < 0) {
    throw new Error('needs a header row with a time column plus open, high, low, close');
  }
  const bars: Bar[] = [];
  let digits = 0;
  for (let n = 1; n < lines.length; n++) {
    const p = lines[n].split(',');
    if (p.length < 5) continue;
    let time: number;
    if (iMs >= 0) time = Number(p[iMs]) / 1000;
    else {
      const raw = p[iTime].trim();
      const num = Number(raw);
      // a bare number is epoch seconds or milliseconds; anything else is a UTC date string
      time = Number.isFinite(num) ? (num > 1e11 ? num / 1000 : num) : Date.parse(`${raw.replace(' ', 'T')}Z`) / 1000;
    }
    const close = Number(p[iC]);
    if (!Number.isFinite(time) || !Number.isFinite(close)) continue;
    if (n < 300) digits = Math.max(digits, (p[iC].trim().split('.')[1] ?? '').length);
    bars.push({ time: Math.floor(time), open: Number(p[iO]), high: Number(p[iH]), low: Number(p[iL]), close, volume: iV >= 0 ? Number(p[iV]) || 0 : 0 });
  }
  bars.sort((a, b) => a.time - b.time);
  return { bars: bars.filter((b, i) => i === 0 || b.time !== bars[i - 1].time), digits: Math.min(digits, 8) };
}

/** Symbol and bar size from names like `XAU-USD_BID_minute_2003-05.csv`; the bar size falls back to the data itself. */
function describe(file: string, bars: Bar[]): { name: string; side: string; res: Res } {
  const base = file.replace(/\.csv$/i, '');
  const m = /^(.+?)[_ ](BID|ASK)[_ ](minute|hour|day)/i.exec(base);
  let res: Res | undefined = m ? ({ minute: 'm1', hour: 'h1', day: 'd1' } as const)[m[3].toLowerCase() as 'minute' | 'hour' | 'day'] : undefined;
  if (!res) {
    const gaps = bars.slice(1, 60).map((b, i) => b.time - bars[i].time).sort((a, b) => a - b);
    const typical = gaps[gaps.length >> 1] ?? 60;
    res = typical < 3600 ? 'm1' : typical < 86400 ? 'h1' : 'd1';
  }
  return { name: (m ? m[1] : base.split(/[_ ]/)[0]).toUpperCase(), side: m ? m[2].toUpperCase() : '', res };
}

function roll(into: Map<number, Bar>, bars: Bar[], secs: number) {
  for (const b of bars) {
    const t = Math.floor(b.time / secs) * secs;
    const w = into.get(t);
    if (w) {
      w.high = Math.max(w.high, b.high);
      w.low = Math.min(w.low, b.low);
      w.close = b.close;
      w.volume += b.volume;
    } else into.set(t, { ...b, time: t });
  }
}

interface Pending {
  side: string;
  digits: number;
  months: Set<string>;
  hourFromMinutes: Map<number, Bar>;
  hourFiles: Map<number, Bar>;
  dayFiles: Map<number, Bar>;
}

export interface ImportResult {
  symbols: string[];
  bars: number;
  skipped: string[];
}

/**
 * Import any mix of minute / hour / day CSV files for one or more symbols.
 * Where files overlap, finer data wins: hours are rebuilt from minutes, days from hours.
 */
export async function importCsv(files: File[], progress: (done: number, total: number, name: string) => void): Promise<ImportResult> {
  await ready;
  const pending = new Map<string, Pending>();
  const skipped: string[] = [];
  let total = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    progress(i, files.length, file.name);
    let parsed: Parsed;
    try {
      parsed = parseCsv(await file.text());
    } catch (e) {
      skipped.push(`${file.name}: ${(e as Error).message}`);
      continue;
    }
    if (!parsed.bars.length) {
      skipped.push(`${file.name}: no rows`);
      continue;
    }
    const { name, side, res } = describe(file.name, parsed.bars);
    const symbol = LOCAL_PREFIX + name;
    let p = pending.get(symbol);
    if (!p) pending.set(symbol, (p = { side, digits: 0, months: new Set(), hourFromMinutes: new Map(), hourFiles: new Map(), dayFiles: new Map() }));
    p.digits = Math.max(p.digits, parsed.digits);
    total += parsed.bars.length;

    if (res === 'h1') parsed.bars.forEach((b) => p.hourFiles.set(b.time, b));
    else if (res === 'd1') parsed.bars.forEach((b) => p.dayFiles.set(b.time, b));
    else {
      // minute chunks are written straight away so memory stays flat across hundreds of files
      const byMonth = new Map<string, Bar[]>();
      for (const b of parsed.bars) {
        const ym = new Date(b.time * 1000).toISOString().slice(0, 7);
        let list = byMonth.get(ym);
        if (!list) byMonth.set(ym, (list = []));
        list.push(b);
      }
      for (const [ym, bars] of byMonth) {
        await run('series', 'readwrite', (s) => s.put(pack(chunkKey(symbol, 'm1', ym), bars)));
        p.months.add(ym);
      }
      roll(p.hourFromMinutes, parsed.bars, 3600);
    }
  }

  progress(files.length, files.length, 'Building hourly and daily series…');
  for (const [symbol, p] of pending) {
    const old = metas.get(symbol);
    const digits = Math.max(p.digits, old?.digits ?? 0);
    const read = async (res: Res) => {
      const map = new Map<number, Bar>();
      for (const id of old?.chunks[res] ?? []) {
        const ch = await run<Chunk | undefined>('series', 'readonly', (s) => s.get(chunkKey(symbol, res, id)));
        unpack(ch, digits).forEach((b) => map.set(b.time, b));
      }
      return map;
    };

    // hours: what was stored before, then hour files for gaps, then hours rebuilt from the new minutes
    const hours = await read('h1');
    p.hourFiles.forEach((b, t) => hours.has(t) || hours.set(t, b));
    p.hourFromMinutes.forEach((b, t) => hours.set(t, b));
    const hourList = [...hours.values()].sort((a, b) => a.time - b.time);
    const byYear = new Map<string, Bar[]>();
    for (const b of hourList) {
      const y = String(new Date(b.time * 1000).getUTCFullYear());
      let list = byYear.get(y);
      if (!list) byYear.set(y, (list = []));
      list.push(b);
    }
    for (const [y, bars] of byYear) await run('series', 'readwrite', (s) => s.put(pack(chunkKey(symbol, 'h1', y), bars)));

    const days = await read('d1');
    p.dayFiles.forEach((b, t) => days.has(t) || days.set(t, b));
    const fromHours = new Map<number, Bar>();
    roll(fromHours, hourList, 86400);
    fromHours.forEach((b, t) => days.set(t, b));
    const dayList = [...days.values()].sort((a, b) => a.time - b.time);
    if (!dayList.length) continue;
    await run('series', 'readwrite', (s) => s.put(pack(chunkKey(symbol, 'd1', 'all'), dayList)));

    const name = symbol.slice(LOCAL_PREFIX.length);
    const lastDay = dayList[dayList.length - 1];
    const meta: Meta = {
      symbol,
      description: `${name} · imported${p.side ? ` ${p.side}` : ''} data`,
      digits,
      from: (hourList[0] ?? dayList[0]).time,
      to: (hourList[hourList.length - 1] ?? lastDay).time,
      chunks: { m1: [...new Set([...(old?.chunks.m1 ?? []), ...p.months])].sort(), h1: [...byYear.keys()].sort(), d1: ['all'] },
      last: hourList[hourList.length - 1] ?? lastDay,
      day: lastDay,
      prevClose: dayList[dayList.length - 2]?.close ?? null,
    };
    await run('symbols', 'readwrite', (s) => s.put(meta));
    metas.set(symbol, meta);
  }
  return { symbols: [...pending.keys()].filter((s) => metas.has(s)), bars: total, skipped };
}
