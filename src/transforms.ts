import type { Bar } from './api';
import { DOWN, UP } from './colors';

/** A displayed bar. Price-driven chart types add a colour override or a box size. */
export interface XBar extends Bar {
  color?: string;
  box?: number;
}

/** Default box / reversal size: the 14-bar average true range, rounded to two significant digits. */
export function autoBox(bars: Bar[]): number {
  const n = bars.length;
  if (!n) return 1;
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, n - 14); i < n; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    sum += Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    count++;
  }
  const atr = count ? sum / count : 0;
  const v = atr > 0 ? atr : Math.abs(bars[n - 1].close) * 0.002 || 1;
  const mag = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / mag) * mag;
}

const bar = (time: number, open: number, close: number, volume = 0): XBar => ({
  time,
  open,
  close,
  high: Math.max(open, close),
  low: Math.min(open, close),
  volume,
});

// Several synthetic bars can come out of one source bar; the chart needs strictly increasing times.
function fixTimes<T extends Bar>(out: T[]): T[] {
  for (let i = 1; i < out.length; i++) if (out[i].time <= out[i - 1].time) out[i].time = out[i - 1].time + 1;
  return out;
}

export function heikin(bars: Bar[]): XBar[] {
  const out: XBar[] = [];
  for (const b of bars) {
    const prev = out[out.length - 1];
    const close = (b.open + b.high + b.low + b.close) / 4;
    const open = prev ? (prev.open + prev.close) / 2 : (b.open + b.close) / 2;
    out.push({ ...b, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) });
  }
  return out;
}

/** Traditional Renko on closes: a brick per `box` move, two boxes to reverse. */
export function renko(bars: Bar[], box: number): XBar[] {
  const out: XBar[] = [];
  if (!bars.length || !(box > 0)) return out;
  let top = Math.floor(bars[0].close / box) * box;
  let bot = top;
  for (const b of bars) {
    let vol = b.volume;
    for (;;) {
      if (b.close >= top + box) {
        out.push(bar(b.time, top, top + box, vol));
        bot = top;
        top += box;
      } else if (b.close <= bot - box) {
        out.push(bar(b.time, bot, bot - box, vol));
        top = bot;
        bot -= box;
      } else break;
      vol = 0;
    }
  }
  return fixTimes(out);
}

/** Range bars: every bar spans exactly `range`. Rebuilt from OHLC, walking each bar open → low/high → close. */
export function rangeBars(bars: Bar[], range: number): XBar[] {
  const out: XBar[] = [];
  if (!(range > 0)) return out;
  let cur: XBar | null = null;
  const feed = (p: number, t: number) => {
    cur ??= bar(t, p, p);
    for (;;) {
      if (p > cur.low + range) {
        cur.high = cur.close = cur.low + range;
        out.push(cur);
        cur = bar(t, cur.close, cur.close);
      } else if (p < cur.high - range) {
        cur.low = cur.close = cur.high - range;
        out.push(cur);
        cur = bar(t, cur.close, cur.close);
      } else {
        cur.high = Math.max(cur.high, p);
        cur.low = Math.min(cur.low, p);
        cur.close = p;
        return;
      }
    }
  };
  for (const b of bars) {
    for (const p of b.close >= b.open ? [b.open, b.low, b.high, b.close] : [b.open, b.high, b.low, b.close]) feed(p, b.time);
    cur!.volume += b.volume;
  }
  if (cur) out.push(cur);
  return fixTimes(out);
}

/** N-line break: a new line only when the close clears the extreme of the last `lines` lines. */
export function lineBreak(bars: Bar[], lines = 3): XBar[] {
  const out: XBar[] = [];
  if (!bars.length) return out;
  const first = bars[0].close;
  let vol = 0;
  for (const b of bars.slice(1)) {
    vol += b.volume;
    const last = out[out.length - 1];
    let next: XBar | null = null;
    if (!last) {
      if (b.close !== first) next = bar(b.time, first, b.close, vol);
    } else {
      const recent = out.slice(-lines);
      if (b.close > Math.max(...recent.map((l) => l.high))) next = bar(b.time, last.high, b.close, vol);
      else if (b.close < Math.min(...recent.map((l) => l.low))) next = bar(b.time, last.low, b.close, vol);
    }
    if (next) {
      out.push(next);
      vol = 0;
    }
  }
  return fixTimes(out);
}

/**
 * Kagi: one bar per vertical leg, turning when price reverses by `rev`.
 * Green legs are "yang" (above the prior shoulder), red are "yin" (below the prior waist).
 */
export function kagi(bars: Bar[], rev: number): XBar[] {
  const out: XBar[] = [];
  if (!bars.length || !(rev > 0)) return out;
  let dir = 0;
  let start = bars[0].close;
  let end = start;
  let time = bars[0].time;
  let yang = true;
  let shoulder = Infinity;
  let waist = -Infinity;
  const push = () => out.push({ ...bar(time, start, end), color: yang ? UP : DOWN });
  for (const b of bars.slice(1)) {
    const c = b.close;
    if (dir === 0) {
      if (Math.abs(c - start) < rev) continue;
      dir = c > start ? 1 : -1;
      yang = dir > 0;
      end = c;
    } else if (dir > 0) {
      if (c > end) end = c;
      else if (c <= end - rev) {
        push();
        shoulder = end;
        start = end;
        end = c;
        dir = -1;
        time = b.time;
      }
    } else if (c < end) end = c;
    else if (c >= end + rev) {
      push();
      waist = end;
      start = end;
      end = c;
      dir = 1;
      time = b.time;
    }
    if (end > shoulder) yang = true;
    if (end < waist) yang = false;
  }
  if (dir !== 0) push();
  return fixTimes(out);
}

/** Point & figure on closes: columns of rising X's and falling O's, `reversal` boxes to switch column. */
export function pnf(bars: Bar[], box: number, reversal = 3): XBar[] {
  const out: XBar[] = [];
  if (!bars.length || !(box > 0)) return out;
  const base = Math.floor(bars[0].close / box) * box;
  let col: XBar | null = null; // low/high are box edges; open < close means an X column
  for (const b of bars) {
    const c = b.close;
    if (!col) {
      const k = Math.floor(Math.abs(c - base) / box);
      if (k < 1) continue;
      col = c > base ? { ...bar(b.time, base, base + k * box), box } : { ...bar(b.time, base, base - k * box), box };
    } else if (col.close > col.open) {
      if (c >= col.high + box) col.high = col.close = col.high + box * Math.floor((c - col.high) / box);
      else if (c <= col.high - reversal * box) {
        out.push(col);
        const k = Math.floor((col.high - c) / box);
        col = { ...bar(b.time, col.high - box, col.high - k * box), box };
      }
    } else if (c <= col.low - box) col.low = col.close = col.low - box * Math.floor((col.low - c) / box);
    else if (c >= col.low + reversal * box) {
      out.push(col);
      const k = Math.floor((c - col.low) / box);
      col = { ...bar(b.time, col.low + box, col.low + k * box), box };
    }
    if (col) col.volume += b.volume;
  }
  if (col) out.push(col);
  return fixTimes(out);
}
