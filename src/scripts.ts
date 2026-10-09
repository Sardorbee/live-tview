import crtKillzones from '../indicators/crt-killzones.js?raw';
import ifvg from '../indicators/ifvg.js?raw';
import macroIct from '../indicators/macro-ict.js?raw';
import taotSeparator from '../indicators/taot-separator.js?raw';
import type { Bar, Timeframe } from './api';

/**
 * User indicators are small JavaScript programs. A script calls `indicator({ name, overlay, inputs, calc })`;
 * `calc` receives the loaded bars as arrays plus the `ta` helpers and returns what to draw, built with
 * `plot()`, `marker()`, `hline()` and `box()`. Scripts run in a worker (scriptWorker.ts).
 */

export type InputValue = number | boolean | string;

export interface InputDef {
  key: string;
  label: string;
  type: 'number' | 'boolean' | 'color' | 'text' | 'select';
  value: InputValue;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}

export type Output =
  | { type: 'plot'; title: string; values: Float64Array; color: string; width: number; style: 'line' | 'dashed' | 'dotted' | 'histogram' }
  | { type: 'marker'; index: number[]; shape: 'circle' | 'square' | 'arrowUp' | 'arrowDown'; position: 'aboveBar' | 'belowBar' | 'inBar'; color: string; text: string }
  | { type: 'hline'; price: number; color: string; title: string }
  /** `left` / `right` are bar indexes; a null `right` runs to the right edge of the chart */
  | { type: 'box'; left: number; right: number | null; top: number; bottom: number; color: string; opacity: number; text: string };

export interface ScriptResult {
  name: string;
  overlay: boolean;
  inputDefs: InputDef[];
  outputs: Output[];
}

export interface RunRequest {
  id: number;
  mode: 'run' | 'describe';
  source: string;
  inputs?: Record<string, InputValue>;
  tf?: Timeframe;
  data?: Record<'time' | 'open' | 'high' | 'low' | 'close' | 'volume', Float64Array>;
}

export type RunResponse = { id: number; ok: true; result: ScriptResult } | { id: number; ok: false; error: string; line?: number };

export class ScriptError extends Error {
  constructor(
    message: string,
    public line?: number,
  ) {
    super(line ? `Line ${line}: ${message}` : message);
  }
}

const TIMEOUT_MS = 4000;

interface Job {
  req: RunRequest;
  transfer: Transferable[];
  resolve: (r: ScriptResult) => void;
  reject: (e: Error) => void;
}

/**
 * Runs scripts in the worker one at a time. Only the job actually executing is on the clock, so when a
 * script hangs, that job alone fails; the worker is replaced and the jobs waiting behind it carry on.
 */
export class ScriptRunner {
  private worker: Worker | undefined;
  private nextId = 1;
  private queue: Job[] = [];
  private timer: number | undefined;

  /** Read a script's name, pane and inputs without running its calculation. */
  describe(source: string) {
    return this.send({ mode: 'describe', source });
  }

  run(source: string, bars: Bar[], inputs: Record<string, InputValue>, tf: Timeframe) {
    const n = bars.length;
    const col = () => new Float64Array(n);
    const data = { time: col(), open: col(), high: col(), low: col(), close: col(), volume: col() };
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      data.time[i] = b.time;
      data.open[i] = b.open;
      data.high[i] = b.high;
      data.low[i] = b.low;
      data.close[i] = b.close;
      data.volume[i] = b.volume;
    }
    return this.send({ mode: 'run', source, inputs, tf, data }, Object.values(data).map((a) => a.buffer));
  }

  private send(req: Omit<RunRequest, 'id'>, transfer: Transferable[] = []): Promise<ScriptResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ req: { ...req, id: this.nextId++ }, transfer, resolve, reject });
      if (this.queue.length === 1) this.start();
    });
  }

  /** Hand the job at the head of the queue to the worker and start its clock. */
  private start() {
    const job = this.queue[0];
    if (!job) return;
    this.timer = window.setTimeout(() => this.fail(`stopped after ${TIMEOUT_MS / 1000}s — is there an endless loop?`, true), TIMEOUT_MS);
    this.ensure().postMessage(job.req, job.transfer);
  }

  private finish(): Job | undefined {
    window.clearTimeout(this.timer);
    const job = this.queue.shift();
    this.start();
    return job;
  }

  /** Fail the running job; a stuck worker cannot be interrupted, only replaced. */
  private fail(reason: string, replaceWorker: boolean) {
    if (replaceWorker) {
      this.worker?.terminate();
      this.worker = undefined;
    }
    this.finish()?.reject(new ScriptError(reason));
  }

  private ensure() {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('./scriptWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<RunResponse>) => {
      if (e.data.id !== this.queue[0]?.req.id) return; // answer from a job that was already timed out
      const job = this.finish()!;
      if (e.data.ok) job.resolve(e.data.result);
      else job.reject(new ScriptError(e.data.error, e.data.line));
    };
    w.onerror = (e) => this.fail(e.message || 'the script worker crashed', true);
    return (this.worker = w);
  }
}

// --- script library ----------------------------------------------------------------

export interface Script {
  id: string;
  name: string;
  source: string;
}

/** One use of a script on a chart, with its own input values. */
export interface ScriptInstance {
  id: string;
  scriptId: string;
  inputs: Record<string, InputValue>;
  hidden?: boolean;
}

const KEY = 'tview.scripts';
export const newId = () => Math.random().toString(36).slice(2, 10);

export const FVG_SOURCE = `// Fair Value Gaps
// A bullish gap is left when a candle's low is above the high of the candle two bars back;
// a bearish gap when its high is below that candle's low. The zone between the two is drawn
// from the middle candle and runs to the right until price comes back and fills it.

indicator({
  name: 'Fair Value Gaps',
  overlay: true,
  inputs: {
    mitigation: { value: 'full fill', options: ['touch', 'midpoint', 'full fill'], label: 'A gap counts as filled on' },
    showFilled: { value: false, label: 'Keep showing filled gaps' },
    minSizeAtr: { value: 0, min: 0, step: 0.1, label: 'Minimum size (x ATR 14)' },
    maxGaps: { value: 100, min: 1, step: 1, label: 'Maximum gaps shown' },
    bullColor: { value: '#089981', label: 'Bullish colour' },
    bearColor: { value: '#f23645', label: 'Bearish colour' },
  },
  calc({ high, low, length, inputs, ta }) {
    const atr = ta.atr(14);
    const gaps = [];
    for (let i = 2; i < length; i++) {
      const bull = low[i] > high[i - 2];
      const bear = high[i] < low[i - 2];
      if (!bull && !bear) continue;
      const top = bull ? low[i] : low[i - 2];
      const bottom = bull ? high[i - 2] : high[i];
      if (inputs.minSizeAtr > 0 && !(top - bottom >= inputs.minSizeAtr * atr[i])) continue;
      gaps.push({ bull, top, bottom, left: i - 1, formed: i, right: null });
    }

    // find the bar, if any, where price returned far enough to fill each gap
    for (const g of gaps) {
      const level =
        inputs.mitigation === 'touch' ? (g.bull ? g.top : g.bottom)
        : inputs.mitigation === 'midpoint' ? (g.top + g.bottom) / 2
        : (g.bull ? g.bottom : g.top);
      for (let j = g.formed + 1; j < length; j++) {
        if (g.bull ? low[j] <= level : high[j] >= level) {
          g.right = j;
          break;
        }
      }
    }

    return gaps
      .filter((g) => inputs.showFilled || g.right === null)
      .slice(-inputs.maxGaps)
      .map((g) => box({
        left: g.left,
        right: g.right,
        top: g.top,
        bottom: g.bottom,
        color: g.bull ? inputs.bullColor : inputs.bearColor,
        opacity: g.right === null ? 0.25 : 0.1,
      }));
  },
});
`;

export const TEMPLATE_SOURCE = `// A new indicator. Save with Ctrl/Cmd + S, then "Add to chart".
//
// calc() receives arrays, one value per loaded bar (oldest first):
//   open, high, low, close, volume, hl2, time (unix seconds), plus length, tf and your inputs.
// ta has: sma, ema, rma, wma, stdev, rsi(src, len), atr(len), tr(), change(src, bars),
//   highest(src, len), lowest(src, len), crossover(a, b), crossunder(a, b).
// Return any mix of:
//   plot(values, { color, width, style: 'line' | 'dashed' | 'dotted' | 'histogram', title })
//   marker(conditions, { shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square', color, text })
//   hline(price, { color })
//   box({ left, right, top, bottom, color, opacity })   // left/right are bar indexes; right: null runs to the edge

indicator({
  name: 'My indicator',
  overlay: true, // false puts it in its own pane under the chart
  inputs: {
    fast: { value: 9, min: 1, step: 1, label: 'Fast length' },
    slow: { value: 21, min: 1, step: 1, label: 'Slow length' },
  },
  calc({ close, inputs, ta }) {
    const fast = ta.ema(close, inputs.fast);
    const slow = ta.ema(close, inputs.slow);
    return {
      fast: plot(fast, { color: '#2962ff' }),
      slow: plot(slow, { color: '#ff6d00' }),
      up: marker(ta.crossover(fast, slow), { shape: 'arrowUp', color: '#089981' }),
      down: marker(ta.crossunder(fast, slow), { shape: 'arrowDown', color: '#f23645' }),
    };
  },
});
`;

/** Scripts that ship with the app. The sources of all but the first live in /indicators. */
const BUILT_IN: Script[] = [
  { id: 'fvg', name: 'Fair Value Gaps', source: FVG_SOURCE },
  { id: 'ifvg', name: 'IFVG', source: ifvg },
  { id: 'crt-killzones', name: 'CRT & Killzones', source: crtKillzones },
  { id: 'taot-separator', name: 'TAOT separator', source: taotSeparator },
  { id: 'macro-ict', name: 'Macro ICT', source: macroIct },
];
const SEEDED_KEY = 'tview.scripts.seeded';

/**
 * The saved scripts, topped up with any built-in one this browser has not been offered yet.
 * Each built-in is offered once, so deleting one sticks, and one the user already has under
 * the same name is not duplicated. Built-ins already in the library are never overwritten.
 */
export function loadScripts(): Script[] {
  let list: Script[] | undefined;
  let seeded: string[] = [];
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) list = (JSON.parse(raw) as Script[]).filter((s) => s && typeof s.id === 'string' && typeof s.source === 'string');
    seeded = JSON.parse(localStorage.getItem(SEEDED_KEY) ?? '[]');
  } catch {
    // unreadable storage: start again from the built-ins
  }
  // a library saved before built-ins were tracked was seeded with the fair value gap script only
  if (list && !seeded.length) seeded = ['fvg'];
  list ??= [];
  for (const b of BUILT_IN) {
    if (seeded.includes(b.id)) continue;
    seeded.push(b.id);
    if (!list.some((s) => s.id === b.id || s.name === b.name)) list.push({ ...b });
  }
  localStorage.setItem(SEEDED_KEY, JSON.stringify(seeded));
  localStorage.setItem(KEY, JSON.stringify(list));
  return list;
}

export const saveScripts = (list: Script[]) => localStorage.setItem(KEY, JSON.stringify(list));
