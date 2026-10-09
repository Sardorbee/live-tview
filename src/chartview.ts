import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type ISeriesApi,
  type Logical,
  type SeriesType,
  type UTCTimestamp,
} from 'lightweight-charts';
import { foldPrice, isIntraday, isTickBased, tfSeconds, type Bar, type Timeframe } from './api';
import { ACCENT, DOWN, UP } from './colors';
import { bollinger, ema, macd, rsi, sma, type Series } from './indicators';
import type { ScriptResult } from './scripts';
import { ShapeSeries } from './shapes';
import { autoBox, heikin, kagi, lineBreak, pnf, rangeBars, renko, type XBar } from './transforms';

export { ACCENT, DOWN, UP };

export const CHART_TYPES = {
  candles: 'Candles',
  hollow: 'Hollow candles',
  volume: 'Volume candles',
  heikin: 'Heikin Ashi',
  bars: 'Bars',
  line: 'Line',
  area: 'Area',
  baseline: 'Baseline',
  renko: 'Renko',
  linebreak: 'Line break',
  kagi: 'Kagi',
  pnf: 'Point & figure',
  range: 'Range bars',
} as const;
export type ChartType = keyof typeof CHART_TYPES;

/** Types whose bars are derived from the source bars rather than shown one-to-one. */
const DERIVED = new Set<ChartType>(['heikin', 'renko', 'linebreak', 'kagi', 'pnf', 'range']);
/** Types that take a box / reversal size. */
export const SIZED = new Set<ChartType>(['renko', 'kagi', 'pnf', 'range']);

export const INDICATORS = {
  vol: 'Volume',
  sma20: 'SMA 20',
  ema50: 'EMA 50',
  ema200: 'EMA 200',
  bb: 'Bollinger Bands (20, 2)',
  rsi: 'RSI (14)',
  macd: 'MACD (12, 26, 9)',
} as const;
export type IndicatorId = keyof typeof INDICATORS;

export const SCALES = { normal: 'Regular', log: 'Logarithmic', percent: 'Percent', indexed: 'Indexed to 100' } as const;
export type ScaleMode = keyof typeof SCALES;
const SCALE_MODES: Record<ScaleMode, PriceScaleMode> = {
  normal: PriceScaleMode.Normal,
  log: PriceScaleMode.Logarithmic,
  percent: PriceScaleMode.Percentage,
  indexed: PriceScaleMode.IndexedTo100,
};

const IND_COLORS = { sma20: '#f7a600', ema50: '#42a5f5', ema200: '#ab47bc', bb: '#26a69a', rsi: '#7e57c2', macdLine: '#2962ff', macdSignal: '#ff6d00' };
const COMPARE_COLORS = ['#f7a600', '#e040fb', '#00bcd4', '#ff5252', '#8bc34a', '#ffeb3b'];

export interface LegendData {
  bar: Bar | null;
  prevClose: number | null;
  /** e.g. the box size in use for Renko */
  note: string;
  inds: { label: string; color: string; value: string }[];
  compares: { symbol: string; color: string; value: number | null }[];
  /** plotted values of each user script at the hovered bar, keyed by instance id */
  scripts: Record<string, string>;
}

/** A shaded price zone drawn by a user script (anchored by time, like drawings). */
export interface Zone {
  t1: number;
  /** null runs to the right edge */
  t2: number | null;
  top: number;
  bottom: number;
  color: string;
  opacity: number;
  text: string;
}

interface ScriptView {
  result: ScriptResult;
  series: AnySeries[];
  /** everything about the result that needs series rebuilt when it changes (as opposed to new data) */
  shape: string;
}
const shapeOf = (r: ScriptResult) =>
  JSON.stringify([r.overlay, r.outputs.map((o) => (o.type === 'plot' ? [o.style, o.color, o.width, o.title] : o.type === 'hline' ? [o.price, o.color, o.title] : 0))]);

export interface TimeRange {
  from: number;
  to: number;
}

type AnySeries = ISeriesApi<SeriesType>;
interface Compare {
  series: ISeriesApi<'Line'>;
  color: string;
  bars: Bar[];
  /** close per displayed bar, null where the other symbol has no bar */
  values: (number | null)[];
}
const at = (t: number) => t as UTCTimestamp;
const DEFAULT_BAR_SPACING = 6;

export class ChartView {
  readonly chart: IChartApi;
  /** Source bars at real UTC times; live ticks are folded into these. */
  src: Bar[] = [];
  /** Bars as displayed: the same array as `src`, or derived from it (Renko, Kagi, …). */
  bars: XBar[] = [];
  digits = 2;
  onLegend: (d: LegendData) => void = () => {};
  /** Fired with the hovered bar's time when the user (not a sync call) moves the crosshair. */
  onHover: (time: number | null) => void = () => {};
  onRange: (r: TimeRange) => void = () => {};
  /** Displayed bars changed: `structural` for a rebuild, false for a live tick on the last bar. */
  onData: (structural: boolean) => void = () => {};
  /** Zones from user scripts; the drawing layer paints them. */
  zones: Zone[] = [];

  private main!: AnySeries;
  private type: ChartType = 'candles';
  private tf: Timeframe = '1h';
  private tz = 'UTC';
  private box: number | null = null;
  private tickVolume = true;
  /** Bar times as handed to the chart: shifted into the display timezone on intraday timeframes. */
  private times: number[] = [];
  private active = new Set<IndicatorId>();
  private ind: Record<string, AnySeries> = {};
  private calc: Record<string, Series> = {};
  private compares = new Map<string, Compare>();
  private indDirty = false;
  private deriveDirty = false;
  private hoverIndex: number | null = null;
  private timer: number;
  private scriptOrder: string[] = [];
  private scriptViews = new Map<string, ScriptView>();
  private mainLines: IPriceLine[] = [];
  private markerApi: ISeriesMarkersPluginApi<Time> | undefined;
  private builtinPanes = 0;

  constructor(el: HTMLElement) {
    this.chart = createChart(el, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { rightOffset: 8, barSpacing: DEFAULT_BAR_SPACING, timeVisible: true, secondsVisible: false },
      rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.08 } },
    });
    this.createMain();
    this.chart.subscribeCrosshairMove((p) => {
      const on = p.time !== undefined && p.logical !== undefined;
      this.hoverIndex = on ? Math.round(p.logical!) : null;
      this.emitLegend();
      if (p.sourceEvent) this.onHover(on ? (this.bars[this.hoverIndex!]?.time ?? null) : null);
    });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r && this.bars.length) this.onRange({ from: this.logicalToTime(r.from), to: this.logicalToTime(r.to) });
    });
    // Derived charts are rebuilt, and indicators recomputed, on a timer rather than on every tick.
    let n = 0;
    this.timer = window.setInterval(() => {
      if (this.deriveDirty) this.rebuild();
      else if (this.indDirty && ++n % 3 === 0) this.fillIndicators();
    }, 300);
  }

  destroy() {
    window.clearInterval(this.timer);
    this.chart.remove();
  }

  applyTheme(dark: boolean) {
    const line = dark ? '#2a2e39' : '#e0e3eb';
    this.chart.applyOptions({
      layout: {
        background: { color: dark ? '#131722' : '#ffffff' },
        textColor: dark ? '#b2b5be' : '#131722',
        fontFamily: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`,
        panes: { separatorColor: line, separatorHoverColor: dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)' },
      },
      grid: { vertLines: { color: dark ? '#1c2030' : '#f0f3fa' }, horzLines: { color: dark ? '#1c2030' : '#f0f3fa' } },
      rightPriceScale: { borderColor: line },
      timeScale: { borderColor: line },
      crosshair: {
        vertLine: { color: '#758696', labelBackgroundColor: dark ? '#363a45' : '#131722' },
        horzLine: { color: '#758696', labelBackgroundColor: dark ? '#363a45' : '#131722' },
      },
    });
  }

  /** `keepRange` leaves the scroll position alone (used when replay steps through bars). */
  setData(src: Bar[], tf: Timeframe, digits: number, tickVolume: boolean, keepRange = false) {
    const reformat = tf !== this.tf || digits !== this.digits;
    this.src = src;
    this.tf = tf;
    this.digits = digits;
    this.tickVolume = tickVolume;
    this.chart.applyOptions({ timeScale: { timeVisible: isIntraday(tf), secondsVisible: isTickBased(tf) } });
    if (reformat || !keepRange) this.createMain();
    else this.rebuild();
    if (keepRange) return;
    this.chart.timeScale().resetTimeScale();
    this.chart.priceScale('right').applyOptions({ autoScale: true });
  }

  /** Back to the default view: latest bars at the default zoom, every price scale auto-fitted. */
  resetView() {
    this.chart.timeScale().applyOptions({ barSpacing: DEFAULT_BAR_SPACING, rightOffset: 8 });
    this.chart.timeScale().resetTimeScale();
    this.chart.panes().forEach((_, i) => this.chart.priceScale('right', i).applyOptions({ autoScale: true }));
  }

  /** False once the user has scrolled away from the latest bar, zoomed, or dragged the price scale. */
  isDefaultView() {
    const ts = this.chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range || !this.bars.length) return true;
    // zoom is read off the visible range, which is what the mouse wheel actually changes
    const spacing = ts.width() / (range.to - range.from);
    return range.to >= this.bars.length - 1 && Math.abs(spacing - DEFAULT_BAR_SPACING) < 0.3 && this.chart.priceScale('right').options().autoScale;
  }

  /** Add older history in front of what is loaded. The view stays where it is. */
  prepend(older: Bar[]) {
    const first = this.src[0];
    if (!first) return;
    older = older.filter((b) => b.time <= first.time);
    const edge = older[older.length - 1];
    // a bar that straddles two stored chunks arrives in halves; join them
    if (edge?.time === first.time) {
      older.pop();
      first.open = edge.open;
      first.high = Math.max(first.high, edge.high);
      first.low = Math.min(first.low, edge.low);
      first.volume += edge.volume;
    }
    if (!older.length) return;
    this.src = older.concat(this.src);
    this.hoverIndex = null;
    this.rebuild();
  }

  setType(type: ChartType) {
    this.type = type;
    this.createMain();
  }

  /** Box / reversal size for Renko, Kagi, point & figure and range bars; null picks one from ATR. */
  setBox(box: number | null) {
    this.box = box;
    if (SIZED.has(this.type)) this.rebuild();
  }

  setTimezone(tz: string) {
    this.tz = tz;
    this.rebuild();
  }

  setScale(mode: ScaleMode) {
    this.chart.priceScale('right').applyOptions({ mode: SCALE_MODES[mode] });
  }

  setIndicators(ids: IndicatorId[]) {
    this.active = new Set(ids);
    this.buildIndicators();
  }

  // --- user scripts -------------------------------------------------------------

  /** Which script instances are on this chart, in display order. Results for anything else are dropped. */
  setScriptOrder(ids: string[]) {
    this.clearScriptSeries();
    this.scriptOrder = ids;
    for (const id of [...this.scriptViews.keys()]) if (!ids.includes(id)) this.scriptViews.delete(id);
    this.renderScripts();
    this.emitLegend();
  }

  /** Show a script's output; null removes it (for example when the script fails). */
  setScriptResult(id: string, result: ScriptResult | null) {
    const cur = this.scriptViews.get(id);
    if (!result) {
      if (!cur) return;
      this.clearScriptSeries();
      this.scriptViews.delete(id);
      this.renderScripts();
    } else if (cur && cur.shape === shapeOf(result)) {
      cur.result = result;
      this.refreshScriptData();
    } else {
      this.clearScriptSeries();
      this.scriptViews.set(id, { result, series: [], shape: shapeOf(result) });
      this.renderScripts();
    }
    this.emitLegend();
  }

  refreshLegend() {
    this.emitLegend();
  }

  private clearScriptSeries() {
    for (const v of this.scriptViews.values()) {
      v.series.forEach((s) => this.chart.removeSeries(s));
      v.series = [];
    }
    this.mainLines.forEach((l) => this.main.removePriceLine(l));
    this.mainLines = [];
  }

  /** (Re)create the series behind every script: overlays on the price pane, the rest one pane each below the built-ins. */
  private renderScripts() {
    this.clearScriptSeries();
    let pane = 1 + this.builtinPanes;
    for (const id of this.scriptOrder) {
      const v = this.scriptViews.get(id);
      if (!v) continue;
      const { overlay, outputs } = v.result;
      for (const o of outputs) {
        if (o.type !== 'plot') continue;
        const common = { color: o.color, priceLineVisible: false, lastValueVisible: !overlay, crosshairMarkerVisible: false, title: overlay ? '' : o.title };
        v.series.push(
          o.style === 'histogram'
            ? this.chart.addSeries(HistogramSeries, common, overlay ? 0 : pane)
            : this.chart.addSeries(
                LineSeries,
                { ...common, lineWidth: o.width as 1 | 2 | 3 | 4, lineStyle: o.style === 'dashed' ? LineStyle.Dashed : o.style === 'dotted' ? LineStyle.Dotted : LineStyle.Solid },
                overlay ? 0 : pane,
              ),
        );
      }
      const target = overlay ? this.main : v.series[0];
      for (const o of outputs) {
        if (o.type !== 'hline' || !target) continue;
        const line = target.createPriceLine({ price: o.price, color: o.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: o.title });
        if (overlay) this.mainLines.push(line);
      }
      if (!overlay && v.series.length) pane++;
    }
    this.chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 4 : 1));
    this.refreshScriptData();
  }

  /** Push current script values into their series, and gather markers and zones. */
  private refreshScriptData() {
    const n = this.bars.length;
    const zones: Zone[] = [];
    const markers: SeriesMarker<Time>[] = [];
    for (const id of this.scriptOrder) {
      const v = this.scriptViews.get(id);
      if (!v) continue;
      let k = 0;
      for (const o of v.result.outputs) {
        if (o.type === 'plot') {
          const s = v.series[k++];
          if (!s) continue;
          const data = [];
          for (let i = 0; i < Math.min(n, o.values.length); i++) if (Number.isFinite(o.values[i])) data.push({ time: at(this.times[i]), value: o.values[i] });
          s.setData(data);
        } else if (o.type === 'marker') {
          for (const i of o.index) if (i < n) markers.push({ time: at(this.times[i]), position: o.position, shape: o.shape, color: o.color, text: o.text });
        } else if (o.type === 'box' && v.result.overlay && o.left < n) {
          zones.push({ t1: this.bars[o.left].time, t2: o.right === null || o.right >= n ? null : this.bars[o.right].time, top: o.top, bottom: o.bottom, color: o.color, opacity: o.opacity, text: o.text });
        }
      }
    }
    this.zones = zones;
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    try {
      if (this.markerApi) this.markerApi.setMarkers(markers);
      else if (markers.length) this.markerApi = createSeriesMarkers(this.main, markers);
    } catch (e) {
      console.warn('markers are not available on this chart type', e);
    }
  }

  /** Overlay another symbol's closes as a line. Bars must be on this chart's timeframe. */
  setCompare(symbol: string, bars: Bar[]) {
    let c = this.compares.get(symbol);
    if (!c) {
      const used = new Set([...this.compares.values()].map((x) => x.color));
      const color = COMPARE_COLORS.find((x) => !used.has(x)) ?? COMPARE_COLORS[0];
      const series = this.chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, title: symbol, crosshairMarkerVisible: false }, 0);
      c = { series, color, bars: [], values: [] };
      this.compares.set(symbol, c);
    }
    c.bars = bars;
    this.fillCompare(c);
    this.emitLegend();
  }

  removeCompare(symbol: string) {
    const c = this.compares.get(symbol);
    if (!c) return;
    this.chart.removeSeries(c.series);
    this.compares.delete(symbol);
    this.emitLegend();
  }

  /** Fold a live price into the last bar, or open a new bar when its bucket has rolled over. */
  applyTick(price: number, timeSec: number) {
    const opened = foldPrice(this.src, this.tf, price, timeSec, this.tickVolume);
    if (opened === null) return;
    if (DERIVED.has(this.type)) {
      this.deriveDirty = true; // the rebuild that follows reports the change
      return;
    }
    const n = this.src.length - 1;
    if (opened) this.times[n] = this.shifted(this.src[n].time, this.times[n - 1]);
    this.main.update(this.point(n));
    if (opened) {
      this.fillIndicators();
      this.fillCompares();
    } else this.indDirty = true;
    this.emitLegend();
    this.onData(opened);
  }

  applyCompareTick(symbol: string, price: number, timeSec: number) {
    const c = this.compares.get(symbol);
    if (!c?.bars.length || foldPrice(c.bars, this.tf, price, timeSec, false) === null) return;
    const n = this.bars.length - 1;
    const last = c.bars[c.bars.length - 1];
    if (n < 0 || !this.comparable || last.time !== this.bars[n].time) return;
    c.values[n] = last.close;
    c.series.update({ time: at(this.times[n]), value: last.close });
  }

  /** Where the last-price label sits on the price scale, for anchoring the bar countdown under it. */
  lastPriceLabel() {
    const b = this.bars[this.bars.length - 1];
    const y = b ? this.main.priceToCoordinate(b.close) : null;
    if (y === null || y < 0 || y > this.mainPaneSize().height) return null;
    return { y, up: b.close >= b.open, width: this.chart.priceScale('right').width() };
  }

  // --- crosshair / range sync between charts ----------------------------------

  showCrosshairAt(time: number | null) {
    const n = this.bars.length - 1;
    if (time === null || n < 0 || time < this.bars[0].time || time >= this.bars[n].time + tfSeconds(this.tf)) {
      return this.chart.clearCrosshairPosition();
    }
    const i = this.indexAt(time);
    this.chart.setCrosshairPosition(this.bars[i].close, at(this.times[i]), this.main);
  }

  setRange(r: TimeRange) {
    if (!this.bars.length) return;
    this.chart.timeScale().setVisibleLogicalRange({ from: this.timeToLogical(r.from) as Logical, to: this.timeToLogical(r.to) as Logical });
  }

  // --- coordinate helpers used by the drawing layer and replay ------------------

  /** Drawings are anchored by time so they survive a timeframe switch; this maps a time back to a bar position. */
  timeToX(t: number): number | null {
    return this.bars.length ? this.chart.timeScale().logicalToCoordinate(this.timeToLogical(t) as Logical) : null;
  }

  xToTime(x: number): number | null {
    const l = this.chart.timeScale().coordinateToLogical(x);
    return l === null || !this.bars.length ? null : this.logicalToTime(Math.round(l));
  }

  priceToY = (p: number) => this.main.priceToCoordinate(p);
  yToPrice = (y: number) => this.main.coordinateToPrice(y);

  /** Size of the main price pane, excluding the price scale and any indicator panes. */
  mainPaneSize() {
    return { width: this.chart.timeScale().width(), height: this.chart.panes()[0]?.getHeight() ?? 0 };
  }

  /** Index into `src` of the bar under a chart position, whatever the chart type. */
  srcIndexAt(logical: number) {
    if (!this.bars.length) return 0;
    const i = Math.max(0, Math.min(this.bars.length - 1, Math.round(logical)));
    return this.bars === this.src ? i : indexAt(this.src, this.bars[i].time);
  }

  /** Box size actually in use: the user's, unless it is unset or would produce an absurd number of bars. */
  boxSize() {
    const auto = autoBox(this.src);
    if (!this.box || this.box <= 0) return auto;
    let hi = -Infinity;
    let lo = Infinity;
    for (const b of this.src) {
      hi = Math.max(hi, b.high);
      lo = Math.min(lo, b.low);
    }
    return (hi - lo) / this.box > 3000 ? auto : this.box;
  }

  // --- internals --------------------------------------------------------------

  private indexAt = (t: number) => indexAt(this.bars, t);

  private timeToLogical(t: number) {
    const b = this.bars;
    const step = tfSeconds(this.tf);
    const n = b.length - 1;
    if (t <= b[0].time) return (t - b[0].time) / step;
    if (t >= b[n].time) return n + (t - b[n].time) / step;
    const i = this.indexAt(t);
    return i + Math.min(0.999, (t - b[i].time) / step);
  }

  private logicalToTime(l: number) {
    const b = this.bars;
    const step = tfSeconds(this.tf);
    const n = b.length - 1;
    if (l <= 0) return b[0].time + l * step;
    if (l >= n) return b[n].time + (l - n) * step;
    const i = Math.floor(l);
    return b[i].time + (l - i) * step;
  }

  /** Overlays line up bar-for-bar, which only makes sense on a plain time-based chart. */
  private get comparable() {
    return !DERIVED.has(this.type) && !isTickBased(this.tf);
  }

  private derive(): XBar[] {
    const s = this.src;
    switch (this.type) {
      case 'heikin':
        return heikin(s);
      case 'renko':
        return renko(s, this.boxSize());
      case 'range':
        return rangeBars(s, this.boxSize());
      case 'linebreak':
        return lineBreak(s);
      case 'kagi':
        return kagi(s, this.boxSize());
      case 'pnf':
        return pnf(s, this.boxSize());
      default:
        return s;
    }
  }

  // The chart only knows UTC, so local time is shown by shifting each bar by its zone offset.
  // Daily and longer bars stay put: shifting midnight UTC would move them onto the wrong date.
  private shifted(t: number, prev: number | undefined) {
    const local = isIntraday(this.tf) ? t + tzOffset(this.tz, t) : t;
    // a DST fall-back repeats an hour; keep times strictly increasing as the chart requires
    return prev !== undefined && local <= prev ? prev + 1 : local;
  }

  /** Recompute displayed bars from `src` and push everything to the chart. */
  private rebuild() {
    this.deriveDirty = false;
    this.bars = this.derive();
    this.times = [];
    for (const b of this.bars) this.times.push(this.shifted(b.time, this.times[this.times.length - 1]));
    this.main.setData(this.bars.map((_, i) => this.point(i)));
    this.fillIndicators();
    this.fillCompares();
    this.refreshScriptData();
    this.emitLegend();
    this.onData(true);
  }

  private createMain() {
    // The old series is removed only after its replacement exists: a pane with no series is
    // deleted, which would shift every indicator pane up and land the new series in the wrong one.
    const old = this.main as AnySeries | undefined;
    // price lines and markers attached to the old series go with it
    this.mainLines = [];
    this.markerApi = undefined;
    const priceFormat = { type: 'price' as const, precision: this.digits, minMove: 1 / 10 ** this.digits };
    const c = this.chart;
    switch (this.type) {
      case 'bars':
        this.main = c.addSeries(BarSeries, { upColor: UP, downColor: DOWN, priceFormat }, 0);
        break;
      case 'line':
        this.main = c.addSeries(LineSeries, { color: ACCENT, lineWidth: 2, priceFormat }, 0);
        break;
      case 'area':
        this.main = c.addSeries(
          AreaSeries,
          { lineColor: ACCENT, lineWidth: 2, topColor: 'rgba(41,98,255,.35)', bottomColor: 'rgba(41,98,255,0)', priceFormat },
          0,
        );
        break;
      case 'baseline':
        this.main = c.addSeries(
          BaselineSeries,
          {
            baseValue: { type: 'price', price: this.src[0]?.close ?? 0 },
            topLineColor: UP,
            bottomLineColor: DOWN,
            topFillColor1: 'rgba(8,153,129,.28)',
            topFillColor2: 'rgba(8,153,129,.02)',
            bottomFillColor1: 'rgba(242,54,69,.02)',
            bottomFillColor2: 'rgba(242,54,69,.28)',
            priceFormat,
          },
          0,
        );
        break;
      case 'volume':
      case 'pnf':
        this.main = c.addCustomSeries(new ShapeSeries(this.type), { color: ACCENT, priceFormat }, 0) as unknown as AnySeries;
        break;
      default:
        this.main = c.addSeries(
          CandlestickSeries,
          {
            upColor: this.type === 'hollow' ? 'transparent' : UP,
            downColor: DOWN,
            borderUpColor: UP,
            borderDownColor: DOWN,
            wickUpColor: UP,
            wickDownColor: DOWN,
            priceFormat,
          },
          0,
        );
    }
    if (old) {
      this.chart.removeSeries(old);
      this.main.setSeriesOrder(0); // keep price underneath the indicator lines drawn over it
    }
    this.rebuild();
    if (this.scriptViews.size) this.renderScripts();
  }

  private point(i: number) {
    const b = this.bars[i];
    const time = at(this.times[i]);
    if (this.type === 'line' || this.type === 'area' || this.type === 'baseline') return { time, value: b.close };
    const ohlc = { time, open: b.open, high: b.high, low: b.low, close: b.close };
    if (this.type === 'volume' || this.type === 'pnf') return { ...ohlc, volume: b.volume, box: b.box };
    return b.color ? { ...ohlc, color: b.color, borderColor: b.color, wickColor: b.color } : ohlc;
  }

  private buildIndicators() {
    // script panes sit below the built-in ones, so they come off first and go back on after
    this.clearScriptSeries();
    Object.values(this.ind).forEach((s) => this.chart.removeSeries(s));
    this.ind = {};
    const has = (id: IndicatorId) => this.active.has(id);
    const quiet = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    const line = (color: string, pane = 0, extra: object = {}) =>
      this.chart.addSeries(LineSeries, { color, lineWidth: 1, ...quiet, ...extra }, pane);

    if (has('vol')) {
      this.ind.vol = this.chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, ...quiet }, 0);
      this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    }
    if (has('sma20')) this.ind.sma20 = line(IND_COLORS.sma20);
    if (has('ema50')) this.ind.ema50 = line(IND_COLORS.ema50);
    if (has('ema200')) this.ind.ema200 = line(IND_COLORS.ema200);
    if (has('bb')) {
      this.ind.bbUpper = line(IND_COLORS.bb);
      this.ind.bbMid = line(IND_COLORS.bb, 0, { lineStyle: LineStyle.Dashed });
      this.ind.bbLower = line(IND_COLORS.bb);
    }
    let pane = 1;
    if (has('rsi')) {
      const s = line(IND_COLORS.rsi, pane++, { lastValueVisible: true, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
      for (const price of [70, 30]) {
        s.createPriceLine({ price, color: '#787b86', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
      }
      this.ind.rsi = s;
    }
    if (has('macd')) {
      const fmt = { priceFormat: { type: 'price' as const, precision: this.digits, minMove: 1 / 10 ** this.digits } };
      this.ind.macdHist = this.chart.addSeries(HistogramSeries, { ...quiet, ...fmt }, pane);
      this.ind.macdLine = line(IND_COLORS.macdLine, pane, fmt);
      this.ind.macdSignal = line(IND_COLORS.macdSignal, pane, fmt);
    }
    this.builtinPanes = (has('rsi') ? 1 : 0) + (has('macd') ? 1 : 0);
    this.fillIndicators();
    this.renderScripts();
  }

  private fillIndicators() {
    this.indDirty = false;
    const closes = this.bars.map((b) => b.close);
    const calc: Record<string, Series> = {};
    const has = (id: IndicatorId) => this.active.has(id);
    if (has('sma20')) calc.sma20 = sma(closes, 20);
    if (has('ema50')) calc.ema50 = ema(closes, 50);
    if (has('ema200')) calc.ema200 = ema(closes, 200);
    if (has('bb')) {
      const b = bollinger(closes);
      Object.assign(calc, { bbUpper: b.upper, bbMid: b.mid, bbLower: b.lower });
    }
    if (has('rsi')) calc.rsi = rsi(closes);
    if (has('macd')) {
      const m = macd(closes);
      Object.assign(calc, { macdLine: m.line, macdSignal: m.signal, macdHist: m.hist });
    }
    this.calc = calc;

    for (const [key, s] of Object.entries(this.ind)) {
      if (key === 'vol') {
        s.setData(
          this.bars.map((b, i) => ({
            time: at(this.times[i]),
            value: b.volume,
            color: b.close >= b.open ? 'rgba(8,153,129,.45)' : 'rgba(242,54,69,.45)',
          })),
        );
        continue;
      }
      const values = calc[key] ?? [];
      const data = [];
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value === null) continue;
        const color = key === 'macdHist' ? (value >= 0 ? 'rgba(8,153,129,.6)' : 'rgba(242,54,69,.6)') : undefined;
        data.push({ time: at(this.times[i]), value, color });
      }
      s.setData(data);
    }
  }

  private fillCompares() {
    this.compares.forEach((c) => this.fillCompare(c));
  }

  // Only points that share a bar time with the main series are plotted. Anything else would add
  // slots to the time axis and knock every index-based lookup (legend, drawings) out of line.
  private fillCompare(c: Compare) {
    c.values = new Array(this.bars.length).fill(null);
    const data = [];
    if (this.comparable) {
      const byTime = new Map(c.bars.map((b) => [b.time, b.close]));
      for (let i = 0; i < this.bars.length; i++) {
        const value = byTime.get(this.bars[i].time);
        if (value === undefined) continue;
        c.values[i] = value;
        data.push({ time: at(this.times[i]), value });
      }
    }
    c.series.setData(data);
  }

  private emitLegend() {
    const n = this.bars.length;
    const compares = [...this.compares].map(([symbol, c]) => ({ symbol, color: c.color, value: null as number | null }));
    if (!n) return this.onLegend({ bar: null, prevClose: null, note: '', inds: [], compares, scripts: {} });
    const i = this.hoverIndex === null ? n - 1 : Math.max(0, Math.min(n - 1, this.hoverIndex));
    const v = (key: string, digits = this.digits) => {
      const x = this.calc[key]?.[i];
      return x === null || x === undefined ? '—' : x.toFixed(digits);
    };
    const inds: LegendData['inds'] = [];
    const has = (id: IndicatorId) => this.active.has(id);
    if (has('vol')) inds.push({ label: this.tickVolume ? 'Vol (ticks)' : 'Vol', color: '#787b86', value: compact(this.bars[i].volume) });
    if (has('sma20')) inds.push({ label: 'SMA 20', color: IND_COLORS.sma20, value: v('sma20') });
    if (has('ema50')) inds.push({ label: 'EMA 50', color: IND_COLORS.ema50, value: v('ema50') });
    if (has('ema200')) inds.push({ label: 'EMA 200', color: IND_COLORS.ema200, value: v('ema200') });
    if (has('bb')) inds.push({ label: 'BB 20 2', color: IND_COLORS.bb, value: `${v('bbUpper')}  ${v('bbMid')}  ${v('bbLower')}` });
    if (has('rsi')) inds.push({ label: 'RSI 14', color: IND_COLORS.rsi, value: v('rsi', 2) });
    if (has('macd')) inds.push({ label: 'MACD 12 26 9', color: IND_COLORS.macdLine, value: `${v('macdLine')}  ${v('macdSignal')}  ${v('macdHist')}` });
    let ci = 0;
    for (const c of this.compares.values()) compares[ci++].value = c.values[i] ?? null;
    const note = SIZED.has(this.type) ? `${this.type === 'range' ? 'Range' : 'Box'} ${+this.boxSize().toPrecision(6)}${this.box ? '' : ' (ATR)'}` : '';
    const scripts: Record<string, string> = {};
    for (const [id, sv] of this.scriptViews) {
      scripts[id] = sv.result.outputs
        .flatMap((o) => (o.type === 'plot' ? [Number.isFinite(o.values[i]) ? o.values[i].toFixed(sv.result.overlay ? this.digits : 2) : '—'] : []))
        .join('  ');
    }
    this.onLegend({ bar: this.bars[i], prevClose: i > 0 ? this.bars[i - 1].close : null, note, inds, compares, scripts });
  }
}

/** Index of the last bar opening at or before `t`. */
function indexAt(bars: Bar[], t: number) {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function compact(n: number) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
}

const tzFormats = new Map<string, Intl.DateTimeFormat>();

/** Seconds to add to a UTC timestamp to get wall-clock time in `tz` at that moment (DST-aware). */
export function tzOffset(tz: string, t: number) {
  if (tz === 'UTC') return 0;
  let f = tzFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    tzFormats.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(t * 1000))) p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - Math.floor(t);
}
