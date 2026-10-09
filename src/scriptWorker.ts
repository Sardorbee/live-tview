// Runs user indicator scripts off the main thread, so a slow or endless script can be killed
// without freezing the chart. See scripts.ts for the message types and the script format.

import type { InputDef, InputValue, Output, RunRequest, RunResponse, ScriptResult } from './scripts';

type Arr = ArrayLike<number>;
interface Data {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

const PALETTE = ['#2962ff', '#ff6d00', '#00bcd4', '#e040fb', '#8bc34a', '#f7a600'];
const MAX_BOXES = 3000;
const MAX_MARKERS = 5000;

const nans = (n: number) => new Float64Array(n).fill(NaN);
/** first index holding a real number, so helpers can be chained (e.g. an SMA of an RSI) */
const firstFinite = (src: Arr) => {
  let i = 0;
  while (i < src.length && !Number.isFinite(src[i])) i++;
  return i;
};

/** Technical-analysis helpers. Every series result is a Float64Array as long as the data, NaN during warm-up. */
function makeTa(d: Data) {
  const n = d.close.length;

  const sma = (src: Arr, len: number) => {
    const out = nans(n);
    const s = firstFinite(src);
    let sum = 0;
    for (let i = s; i < n; i++) {
      sum += src[i];
      if (i >= s + len) sum -= src[i - len];
      if (i >= s + len - 1) out[i] = sum / len;
    }
    return out;
  };
  /** generic exponential smoothing seeded with a simple average */
  const smooth = (src: Arr, len: number, k: number) => {
    const out = nans(n);
    const s = firstFinite(src);
    if (s + len > n) return out;
    let prev = 0;
    for (let i = s; i < s + len; i++) prev += src[i];
    prev /= len;
    out[s + len - 1] = prev;
    for (let i = s + len; i < n; i++) out[i] = prev = src[i] * k + prev * (1 - k);
    return out;
  };
  const ema = (src: Arr, len: number) => smooth(src, len, 2 / (len + 1));
  const rma = (src: Arr, len: number) => smooth(src, len, 1 / len);
  const wma = (src: Arr, len: number) => {
    const out = nans(n);
    const denom = (len * (len + 1)) / 2;
    for (let i = firstFinite(src) + len - 1; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < len; j++) sum += src[i - j] * (len - j);
      out[i] = sum / denom;
    }
    return out;
  };
  const stdev = (src: Arr, len: number) => {
    const mean = sma(src, len);
    const out = nans(n);
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(mean[i])) continue;
      let v = 0;
      for (let j = i - len + 1; j <= i; j++) v += (src[j] - mean[i]) ** 2;
      out[i] = Math.sqrt(v / len);
    }
    return out;
  };
  const extreme = (src: Arr, len: number, pick: (a: number, b: number) => number) => {
    const out = nans(n);
    for (let i = firstFinite(src) + len - 1; i < n; i++) {
      let v = src[i];
      for (let j = 1; j < len; j++) v = pick(v, src[i - j]);
      out[i] = v;
    }
    return out;
  };
  const change = (src: Arr, bars = 1) => {
    const out = nans(n);
    for (let i = bars; i < n; i++) out[i] = src[i] - src[i - bars];
    return out;
  };
  const tr = () => {
    const out = nans(n);
    for (let i = 0; i < n; i++) {
      const pc = i ? d.close[i - 1] : d.close[i];
      out[i] = Math.max(d.high[i] - d.low[i], Math.abs(d.high[i] - pc), Math.abs(d.low[i] - pc));
    }
    return out;
  };
  const rsi = (src: Arr, len: number) => {
    const up = nans(n);
    const down = nans(n);
    for (let i = 1; i < n; i++) {
      const diff = src[i] - src[i - 1];
      up[i] = Math.max(diff, 0);
      down[i] = Math.max(-diff, 0);
    }
    const g = rma(up, len);
    const l = rma(down, len);
    return g.map((x, i) => (l[i] === 0 ? 100 : 100 - 100 / (1 + x / l[i])));
  };
  const at = (x: Arr | number, i: number) => (typeof x === 'number' ? x : x[i]);
  const cross = (a: Arr | number, b: Arr | number, dir: 1 | -1) => {
    const out: boolean[] = new Array(n).fill(false);
    for (let i = 1; i < n; i++) out[i] = (at(a, i) - at(b, i)) * dir > 0 && (at(a, i - 1) - at(b, i - 1)) * dir <= 0;
    return out;
  };

  return {
    sma,
    ema,
    rma,
    wma,
    stdev,
    rsi,
    change,
    tr,
    atr: (len = 14) => rma(tr(), len),
    highest: (src: Arr, len: number) => extreme(src, len, Math.max),
    lowest: (src: Arr, len: number) => extreme(src, len, Math.min),
    crossover: (a: Arr | number, b: Arr | number) => cross(a, b, 1),
    crossunder: (a: Arr | number, b: Arr | number) => cross(a, b, -1),
  };
}

// --- what a script can return ----------------------------------------------------

type Spec = { __kind: string; [k: string]: unknown };
const plot = (values: Arr, opts: object = {}): Spec => ({ __kind: 'plot', values, ...opts });
const marker = (when: ArrayLike<unknown>, opts: object = {}): Spec => ({ __kind: 'marker', when, ...opts });
const hline = (price: number, opts: object = {}): Spec => ({ __kind: 'hline', price, ...opts });
const box = (spec: object): Spec => ({ __kind: 'box', ...spec });

const isSeries = (v: unknown): v is Arr => Array.isArray(v) ? typeof v[0] === 'number' || v.length === 0 : ArrayBuffer.isView(v);
const str = (v: unknown, def: string) => (typeof v === 'string' && v ? v : def);
const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);

function collect(ret: unknown, n: number): Output[] {
  const outputs: Output[] = [];
  let plots = 0;
  const walk = (v: unknown, key: string) => {
    if (v === null || v === undefined) return;
    if (isSeries(v)) v = plot(v);
    else if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    const s = v as Spec;
    if (typeof s !== 'object' || !s.__kind) {
      if (typeof v === 'object') for (const [k, x] of Object.entries(v as object)) walk(x, k);
      return;
    }
    if (s.__kind === 'plot') {
      const values = nans(n);
      const src = s.values as Arr;
      for (let i = 0; i < Math.min(n, src?.length ?? 0); i++) values[i] = Number(src[i]);
      const style = str(s.style, 'line');
      outputs.push({
        type: 'plot',
        title: str(s.title, key),
        values,
        color: str(s.color, PALETTE[plots++ % PALETTE.length]),
        width: Math.max(1, Math.min(4, Math.round(num(s.width, 2)))),
        style: style === 'histogram' || style === 'dashed' || style === 'dotted' ? style : 'line',
      });
    } else if (s.__kind === 'marker') {
      const when = s.when as ArrayLike<unknown>;
      const index: number[] = [];
      for (let i = 0; i < Math.min(n, when?.length ?? 0); i++) if (when[i]) index.push(i);
      const shape = str(s.shape, 'circle');
      outputs.push({
        type: 'marker',
        index: index.slice(-MAX_MARKERS),
        shape: shape === 'arrowUp' || shape === 'arrowDown' || shape === 'square' ? shape : 'circle',
        position: s.position === 'aboveBar' || s.position === 'belowBar' || s.position === 'inBar' ? s.position : shape === 'arrowUp' ? 'belowBar' : 'aboveBar',
        color: str(s.color, PALETTE[0]),
        text: str(s.text, ''),
      });
    } else if (s.__kind === 'hline') {
      if (Number.isFinite(s.price)) outputs.push({ type: 'hline', price: s.price as number, color: str(s.color, '#787b86'), title: str(s.title, '') });
    } else if (s.__kind === 'box') {
      const left = Math.round(num(s.left, NaN));
      const top = num(s.top, NaN);
      const bottom = num(s.bottom, NaN);
      if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(bottom)) return;
      outputs.push({
        type: 'box',
        left: Math.max(0, Math.min(n - 1, left)),
        right: s.right === null || s.right === undefined ? null : Math.max(0, Math.min(n - 1, Math.round(num(s.right, n - 1)))),
        top: Math.max(top, bottom),
        bottom: Math.min(top, bottom),
        color: str(s.color, PALETTE[0]),
        opacity: Math.max(0, Math.min(1, num(s.opacity, 0.2))),
        text: str(s.text, ''),
      });
    }
  };
  walk(ret, 'plot');
  const boxes = outputs.filter((o) => o.type === 'box');
  if (boxes.length <= MAX_BOXES) return outputs;
  const keep = new Set(boxes.slice(-MAX_BOXES));
  return outputs.filter((o) => o.type !== 'box' || keep.has(o));
}

/** Turn the script's `inputs` block into typed fields the settings dialog can render. */
function inputDefs(raw: unknown): InputDef[] {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw as Record<string, unknown>).flatMap(([key, v]): InputDef[] => {
    const o = (v !== null && typeof v === 'object' ? v : { value: v }) as Record<string, unknown>;
    const value = o.value;
    const label = str(o.label, key);
    if (Array.isArray(o.options)) return [{ key, label, type: 'select', value: String(value), options: o.options.map(String) }];
    if (typeof value === 'boolean') return [{ key, label, type: 'boolean', value }];
    if (typeof value === 'number') return [{ key, label, type: 'number', value, min: o.min as number, max: o.max as number, step: o.step as number }];
    if (typeof value === 'string') return [{ key, label, type: /^#[0-9a-f]{6}$/i.test(value) ? 'color' : 'text', value }];
    return [];
  });
}

function execute(req: RunRequest): ScriptResult {
  const z = new Float64Array(0);
  const data: Data = req.data ?? { time: z, open: z, high: z, low: z, close: z, volume: z };
  const n = data.close.length;
  let def: Record<string, unknown> | undefined;
  const indicator = (d: Record<string, unknown>) => (def = d);
  // The script body runs as a function whose parameters shadow the page-level globals a chart script has no use for.
  new Function('indicator', 'plot', 'marker', 'hline', 'box', 'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts', 'self', 'globalThis', `"use strict";${req.source}`)(
    indicator,
    plot,
    marker,
    hline,
    box,
  );
  if (!def) throw new Error('the script must call indicator({ name, calc })');
  const defs = inputDefs(def.inputs);
  const inputs: Record<string, InputValue> = {};
  for (const d of defs) {
    const given = req.inputs?.[d.key];
    inputs[d.key] = typeof given === typeof d.value && (d.type !== 'select' || d.options!.includes(String(given))) ? given! : d.value;
  }
  const result: ScriptResult = { name: str(def.name, 'Untitled script'), overlay: def.overlay !== false, inputDefs: defs, outputs: [] };
  if (req.mode === 'describe') return result;
  if (typeof def.calc !== 'function') throw new Error('indicator({ … }) needs a calc(ctx) function');
  const hl2 = data.high.map((h, i) => (h + data.low[i]) / 2);
  const ret = def.calc({ ...data, hl2, inputs, ta: makeTa(data), tf: req.tf, length: n });
  result.outputs = collect(ret, n);
  return result;
}

const post = (m: RunResponse, transfer: Transferable[] = []) => (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(m, transfer);

self.onmessage = (e: MessageEvent<RunRequest>) => {
  try {
    const result = execute(e.data);
    post({ id: e.data.id, ok: true, result }, result.outputs.flatMap((o) => (o.type === 'plot' ? [o.values.buffer] : [])));
  } catch (err) {
    const error = err as Error;
    // the body is compiled as line 3 of a generated function; map the stack position back to the script
    const m = /<anonymous>:(\d+):\d+/.exec(error.stack ?? '');
    const line = m ? Number(m[1]) - 2 : undefined;
    post({ id: e.data.id, ok: false, error: `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}`, line: line && line > 0 ? line : undefined });
  }
};
