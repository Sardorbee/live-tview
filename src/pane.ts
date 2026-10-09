import { bucketEnd, fetchBars, isTickBased, parseTf, tfLabel, type Bar, type BarSet, type SymbolInfo, type Tick, type Timeframe } from './api';
import { isLocal } from './localdata';
import { newId, type InputDef, type InputValue, type Script, type ScriptInstance, type ScriptResult } from './scripts';
import { CHART_TYPES, ChartView, DOWN, UP, type ChartType, type IndicatorId, type LegendData, type ScaleMode, type TimeRange } from './chartview';
import { Drawings } from './drawings';

export interface PaneState {
  symbol: string;
  tf: Timeframe;
  type: ChartType;
  indicators: IndicatorId[];
  compares: string[];
  scale: ScaleMode;
  /** box / reversal size for Renko-style charts; null = automatic */
  box: number | null;
  /** user scripts on this chart */
  scripts: ScriptInstance[];
}

/** What a chart pane needs from the app around it. */
export interface PaneHost {
  tick(symbol: string): Tick | undefined;
  info(symbol: string): SymbolInfo | undefined;
  loadInfo(symbol: string): Promise<unknown>;
  digitsFor(symbol: string, price: number): number;
  isActive(pane: ChartPane): boolean;
  activate(pane: ChartPane): void;
  pointer(pane: ChartPane): void;
  hover(pane: ChartPane, time: number | null): void;
  range(pane: ChartPane, range: TimeRange): void;
  toolDone(): void;
  script(id: string): Script | undefined;
  runScript(source: string, bars: Bar[], inputs: Record<string, InputValue>, tf: Timeframe): Promise<ScriptResult>;
  /** the user asked for a script's settings dialog or its source */
  scriptAction(pane: ChartPane, instanceId: string, action: 'settings' | 'edit'): void;
  scriptFailed(scriptId: string, message: string): void;
  /** pane state changed: persist it and refresh anything that mirrors it */
  changed(): void;
}

interface Replay {
  all: Bar[];
  cut: number;
  playing: boolean;
  speed: number;
  timer?: number;
}

const REPLAY_SPEEDS = [1, 3, 10];
/** stop paging in older history beyond this many loaded bars, to keep the chart responsive */
const MAX_LOADED_BARS = 250000;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (v: number, digits: number) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
const pad = (n: number) => String(n).padStart(2, '0');
const priceOf = (t: Tick) => t.mid || (t.bid + t.ask) / 2;
const tickTime = (t: Tick) => {
  const ms = Date.parse(t.timestamp);
  return (Number.isNaN(ms) ? Date.now() : ms) / 1000;
};

function remaining(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  return h ? `${h}:${pad(m)}:${pad(sec % 60)}` : `${pad(m)}:${pad(sec % 60)}`;
}

/** One chart in the layout: its own symbol, timeframe, chart type, overlays, drawings and replay. */
export class ChartPane {
  readonly el = document.createElement('div');
  readonly view: ChartView;
  readonly drawings: Drawings;

  private legend: HTMLElement;
  private countdown: HTMLElement;
  private msg: HTMLElement;
  private replayBar: HTMLElement;
  private resetBtn: HTMLElement;
  private loadSeq = 0;
  /** symbol the loaded bars belong to; ticks for anything else are ignored */
  private chartSymbol: string | null = null;
  private tickVolume = true;
  private replay: Replay | null = null;
  private picking = false;
  private more: BarSet['more'];
  /** latest outcome per script instance: its name and inputs, or why it failed */
  private scriptInfo = new Map<string, { name?: string; defs?: InputDef[]; error?: string }>();
  private scriptTimer: number | undefined;
  private scriptSeq = 0;
  private loadingMore = false;

  constructor(
    parent: HTMLElement,
    public state: PaneState,
    private host: PaneHost,
  ) {
    this.el.className = 'pane';
    this.el.innerHTML =
      `<div class="pane-chart"></div><div class="legend"></div><div class="countdown num" title="Time until this bar closes"></div>` +
      `<div class="chart-msg"></div><div class="replay-bar hidden"></div>` +
      `<button class="reset-view" title="Reset chart view (Alt + R)"><svg viewBox="0 0 20 20" width="15" height="15"><path d="M4.5 10a5.5 5.5 0 1 0 1.8-4.1M4 3.5v3h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    parent.appendChild(this.el);
    const q = (c: string) => this.el.querySelector<HTMLElement>(c)!;
    this.legend = q('.legend');
    this.countdown = q('.countdown');
    this.msg = q('.chart-msg');
    this.replayBar = q('.replay-bar');
    this.resetBtn = q('.reset-view');
    this.resetBtn.addEventListener('click', () => this.view.resetView());

    this.view = new ChartView(q('.pane-chart'));
    this.drawings = new Drawings(this.el, this.view, () => host.isActive(this));
    this.drawings.onToolDone = () => host.toolDone();
    this.drawings.setSymbol(state.symbol);

    this.view.onLegend = (d) => this.renderLegend(d);
    this.view.onHover = (t) => host.hover(this, t);
    this.view.onRange = (r) => {
      host.range(this, r);
      void this.loadOlder();
    };
    this.view.chart.subscribeClick((p) => {
      if (this.picking && p.logical !== undefined) this.beginReplay(this.view.srcIndexAt(p.logical) + 1);
    });

    this.el.addEventListener('pointerenter', () => host.pointer(this));
    this.el.addEventListener('pointerleave', () => host.hover(this, null));
    this.el.addEventListener('pointerdown', () => host.activate(this), true);
    this.legend.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const symbol = t.closest<HTMLElement>('[data-uncompare]')?.dataset.uncompare;
      if (symbol) return this.removeCompare(symbol);
      const btn = t.closest<HTMLElement>('[data-script-act]');
      const inst = btn && this.state.scripts.find((s) => s.id === btn.dataset.inst);
      if (!btn || !inst) return;
      const act = btn.dataset.scriptAct;
      if (act === 'remove') this.removeScript(inst.id);
      else if (act === 'toggle') {
        inst.hidden = !inst.hidden;
        this.syncScripts();
        host.changed();
      } else if (act === 'settings' || act === 'edit') host.scriptAction(this, inst.id, act);
    });
    // live ticks only touch the last bar, so they re-run scripts at most once a second
    this.view.onData = (structural) => this.queueScripts(structural ? 0 : 1000);
    this.view.setScriptOrder(this.visibleScripts());
    this.replayBar.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'play') this.togglePlay();
      else if (act === 'step') this.step();
      else if (act === 'speed') this.cycleSpeed();
      else if (act === 'exit') this.exitReplay();
    });

    this.view.setType(state.type);
    this.view.setBox(state.box);
    this.view.setScale(state.scale);
    this.view.setIndicators(state.indicators);
  }

  destroy() {
    window.clearTimeout(this.scriptTimer);
    this.scriptSeq++;
    this.stopTimer();
    this.drawings.destroy();
    this.view.destroy();
    this.el.remove();
  }

  /** Every symbol this pane needs live ticks for. */
  symbols() {
    return [this.state.symbol, ...this.state.compares];
  }

  // --- data -------------------------------------------------------------------

  async load() {
    const seq = ++this.loadSeq;
    const { symbol, tf } = this.state;
    this.chartSymbol = null;
    this.more = undefined;
    this.endReplay();
    this.setMsg('Loading…');
    try {
      const [set] = await Promise.all([fetchBars(symbol, tf), this.host.loadInfo(symbol)]);
      if (seq !== this.loadSeq) return;
      const last = set.bars[set.bars.length - 1];
      const seed = last?.close ?? (this.host.tick(symbol) ? priceOf(this.host.tick(symbol)!) : 1);
      this.tickVolume = set.tickVolume;
      this.more = set.more;
      this.view.setData(set.bars, tf, this.host.digitsFor(symbol, seed), set.tickVolume);
      if (!last && (!isTickBased(tf) || isLocal(symbol))) return this.setMsg(`No ${tfLabel(tf)} chart data for ${symbol}`);
      this.chartSymbol = symbol;
      // second and tick charts have almost no stored history and fill in from the live feed
      this.setMsg(last ? '' : 'Waiting for live ticks…');
      const t = this.host.tick(symbol);
      // imported symbols have no feed; their stand-in quote must not be drawn as a new bar
      if (t && last && !isLocal(symbol)) this.view.applyTick(priceOf(t), tickTime(t));
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.view.setData([], tf, 2, true);
      return this.setMsg(`Couldn't load ${symbol}: ${(e as Error).message}`);
    }
    for (const c of this.state.compares) void this.loadCompare(c, seq);
  }

  /** Page in older bars once the user has scrolled close to the oldest one loaded. */
  private async loadOlder() {
    if (!this.more || this.loadingMore || this.replay) return;
    const range = this.view.chart.timeScale().getVisibleLogicalRange();
    if (!range || range.from > 50) return;
    this.loadingMore = true;
    const seq = this.loadSeq;
    try {
      const older = await this.more();
      if (seq !== this.loadSeq) return;
      if (older) this.view.prepend(older);
      if (!older || this.view.src.length > MAX_LOADED_BARS) this.more = undefined;
    } finally {
      this.loadingMore = false;
    }
  }

  private async loadCompare(symbol: string, seq: number) {
    const bars = await fetchBars(symbol, this.state.tf)
      .then((s) => s.bars)
      .catch(() => [] as Bar[]);
    if (seq === this.loadSeq && this.state.compares.includes(symbol)) this.view.setCompare(symbol, bars);
  }

  onTick(t: Tick) {
    if (this.replay || isLocal(t.symbol)) return;
    if (t.symbol === this.chartSymbol) {
      this.view.applyTick(priceOf(t), tickTime(t));
      if (this.msg.textContent) this.setMsg('');
    } else if (this.chartSymbol && this.state.compares.includes(t.symbol)) {
      this.view.applyCompareTick(t.symbol, priceOf(t), tickTime(t));
    }
  }

  // --- settings ---------------------------------------------------------------

  setSymbol(symbol: string) {
    this.state.symbol = symbol;
    if (this.state.compares.includes(symbol)) this.removeCompare(symbol);
    this.drawings.setSymbol(symbol);
    void this.load();
  }

  setTf(tf: Timeframe) {
    this.state.tf = tf;
    void this.load();
  }

  setType(type: ChartType) {
    this.state.type = type;
    this.view.setType(type);
  }

  setBox(box: number | null) {
    this.state.box = box;
    this.view.setBox(box);
  }

  setIndicators(ids: IndicatorId[]) {
    this.state.indicators = ids;
    this.view.setIndicators(ids);
  }

  setScale(mode: ScaleMode) {
    this.state.scale = mode;
    this.view.setScale(mode);
  }

  addCompare(symbol: string) {
    if (symbol === this.state.symbol || this.state.compares.includes(symbol)) return;
    this.state.compares.push(symbol);
    // prices of two instruments rarely share a scale, so compare in percent unless the user chose otherwise
    if (this.state.scale === 'normal') this.setScale('percent');
    this.view.setCompare(symbol, []);
    void this.host.loadInfo(symbol);
    void this.loadCompare(symbol, this.loadSeq);
    this.host.changed();
  }

  removeCompare(symbol: string) {
    this.state.compares = this.state.compares.filter((s) => s !== symbol);
    this.view.removeCompare(symbol);
    if (!this.state.compares.length && this.state.scale === 'percent') this.setScale('normal');
    this.host.changed();
  }

  // --- user scripts -------------------------------------------------------------

  private visibleScripts() {
    return this.state.scripts.filter((s) => !s.hidden).map((s) => s.id);
  }

  addScript(scriptId: string) {
    this.state.scripts.push({ id: newId(), scriptId, inputs: {} });
    this.syncScripts();
    this.host.changed();
  }

  removeScript(instanceId: string) {
    this.state.scripts = this.state.scripts.filter((s) => s.id !== instanceId);
    this.scriptInfo.delete(instanceId);
    this.syncScripts();
    this.host.changed();
  }

  /** Drop every use of a script that was deleted from the library. */
  removeScriptsOf(scriptId: string) {
    if (!this.state.scripts.some((s) => s.scriptId === scriptId)) return;
    this.state.scripts = this.state.scripts.filter((s) => s.scriptId !== scriptId);
    this.syncScripts();
  }

  setScriptInputs(instanceId: string, inputs: Record<string, InputValue>) {
    const inst = this.state.scripts.find((s) => s.id === instanceId);
    if (!inst) return;
    inst.inputs = inputs;
    this.queueScripts(0);
    this.host.changed();
  }

  scriptInputs(instanceId: string) {
    const inst = this.state.scripts.find((s) => s.id === instanceId);
    return inst && { name: this.scriptInfo.get(instanceId)?.name ?? '', defs: this.scriptInfo.get(instanceId)?.defs ?? [], values: inst.inputs, scriptId: inst.scriptId };
  }

  /** The set of scripts (or a script's source) changed: realign the chart and run them again. */
  syncScripts() {
    this.view.setScriptOrder(this.visibleScripts());
    this.queueScripts(0);
  }

  private queueScripts(delay: number) {
    if (this.scriptTimer !== undefined) {
      if (delay > 0) return;
      window.clearTimeout(this.scriptTimer);
    }
    this.scriptTimer = window.setTimeout(() => {
      this.scriptTimer = undefined;
      void this.runScripts();
    }, delay);
  }

  private async runScripts() {
    const seq = ++this.scriptSeq;
    const bars = this.view.bars;
    if (!bars.length) return;
    for (const inst of this.state.scripts) {
      if (inst.hidden) continue;
      const lib = this.host.script(inst.scriptId);
      const prev = this.scriptInfo.get(inst.id);
      try {
        if (!lib) throw new Error('this script is no longer in the library');
        const result = await this.host.runScript(lib.source, bars, inst.inputs, this.state.tf);
        if (seq !== this.scriptSeq) return; // newer data arrived while this ran
        this.scriptInfo.set(inst.id, { name: result.name, defs: result.inputDefs });
        this.view.setScriptResult(inst.id, result);
      } catch (e) {
        if (seq !== this.scriptSeq) return;
        const error = (e as Error).message;
        this.scriptInfo.set(inst.id, { name: lib?.name ?? prev?.name, defs: prev?.defs, error });
        this.view.setScriptResult(inst.id, null);
        if (lib) this.host.scriptFailed(lib.id, error);
      }
    }
    this.view.refreshLegend();
  }

  /** The chart plus its drawings as one image. */
  screenshot() {
    const shot = this.view.chart.takeScreenshot();
    const out = document.createElement('canvas');
    out.width = shot.width;
    out.height = shot.height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(shot, 0, 0);
    ctx.drawImage(this.drawings.canvasEl, 0, 0, shot.width, shot.height);
    return out;
  }

  // --- bar replay -------------------------------------------------------------

  get replaying() {
    return this.picking || !!this.replay;
  }

  /** First click arms "pick a start bar"; the chart click that follows starts the replay there. */
  toggleReplay() {
    if (this.replaying) return this.exitReplay();
    if (!this.view.src.length) return;
    this.picking = true;
    this.renderReplayBar();
    this.host.changed();
  }

  private beginReplay(cut: number) {
    this.picking = false;
    const all = this.view.src.map((b) => ({ ...b }));
    this.replay = { all, cut: Math.max(1, Math.min(all.length, cut)), playing: false, speed: 1 };
    this.applyReplay();
    this.view.chart.timeScale().scrollToRealTime();
  }

  private applyReplay() {
    const r = this.replay;
    if (!r) return;
    const bars = r.all.slice(0, r.cut).map((b) => ({ ...b }));
    this.view.setData(bars, this.state.tf, this.view.digits, this.tickVolume, true);
    this.renderReplayBar();
  }

  private step() {
    const r = this.replay;
    if (!r) return;
    if (r.cut >= r.all.length) return this.setPlaying(false);
    r.cut++;
    this.applyReplay();
  }

  private togglePlay() {
    if (this.replay) this.setPlaying(!this.replay.playing);
  }

  private setPlaying(on: boolean) {
    const r = this.replay;
    if (!r) return;
    this.stopTimer();
    r.playing = on && r.cut < r.all.length;
    if (r.playing) r.timer = window.setInterval(() => this.step(), 1000 / r.speed);
    this.renderReplayBar();
  }

  private cycleSpeed() {
    const r = this.replay;
    if (!r) return;
    r.speed = REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(r.speed) + 1) % REPLAY_SPEEDS.length];
    this.setPlaying(r.playing);
  }

  private stopTimer() {
    window.clearInterval(this.replay?.timer);
  }

  private endReplay() {
    this.stopTimer();
    this.replay = null;
    this.picking = false;
    this.renderReplayBar();
  }

  /** Leave replay and go back to the live chart. */
  private exitReplay() {
    const wasReplaying = !!this.replay;
    this.endReplay();
    if (wasReplaying) void this.load();
    this.host.changed();
  }

  private renderReplayBar() {
    const r = this.replay;
    this.replayBar.classList.toggle('hidden', !this.replaying);
    if (this.picking) {
      this.replayBar.innerHTML = `<span>Click a bar to start the replay from there</span><button data-act="exit" title="Cancel">✕</button>`;
    } else if (r) {
      const done = r.cut >= r.all.length;
      this.replayBar.innerHTML =
        `<button data-act="play" title="${r.playing ? 'Pause' : 'Play'}" ${done ? 'disabled' : ''}>${r.playing ? '❚❚' : '▶'}</button>` +
        `<button data-act="step" title="Forward one bar" ${done ? 'disabled' : ''}>▶❙</button>` +
        `<button data-act="speed" title="Bars per second">${r.speed}×</button>` +
        `<span class="num">${r.cut} / ${r.all.length}${done ? ' · end' : ''}</span>` +
        `<button data-act="exit" title="Exit replay">✕</button>`;
    }
  }

  // --- overlays ---------------------------------------------------------------

  private setMsg(text: string) {
    this.msg.textContent = text;
    this.msg.classList.toggle('show', !!text);
  }

  /** Called a few times a second to keep the bar countdown under the last-price label. */
  tickUi(now: number) {
    // the reset button only shows once the view has been moved, and sits just left of the price scale
    this.resetBtn.style.display = this.view.isDefaultView() ? 'none' : 'grid';
    this.resetBtn.style.right = `${this.view.chart.priceScale('right').width() + 10}px`;
    const el = this.countdown;
    const { symbol, tf } = this.state;
    const open = this.chartSymbol && !this.replay && this.host.tick(symbol)?.marketState !== 'closed';
    const label = open ? this.view.lastPriceLabel() : null;
    if (!label) return void (el.style.display = 'none');
    const spec = parseTf(tf);
    // tick bars close after N ticks, not after a time
    el.textContent =
      spec?.unit === 'T' ? `${this.view.src[this.view.src.length - 1]?.volume ?? 0}/${spec.n}` : remaining(Math.max(0, Math.ceil(bucketEnd(now, tf) - now)));
    el.style.cssText = `display:block;top:${Math.round(label.y + 10)}px;width:${label.width}px;background:${label.up ? UP : DOWN}`;
  }

  private renderLegend({ bar, prevClose, note, inds, compares, scripts }: LegendData) {
    const { symbol, tf, type } = this.state;
    const i = this.host.info(symbol);
    const t = this.host.tick(symbol);
    const kind = type === 'candles' ? '' : CHART_TYPES[type];
    const desc = [t?.description || i?.description, tfLabel(tf), i?.exchange, kind, note].filter(Boolean).join(' · ');
    const badge = this.replay
      ? `<span class="badge replay">Replay</span>`
      : isLocal(symbol)
        ? `<span class="badge">Imported</span>`
        : t?.marketState
        ? `<span class="badge ${t.marketState}">${t.marketState === 'open' ? 'Market open' : 'Market closed'}</span>`
        : '';
    let ohlc = '';
    if (bar) {
      const d = this.view.digits;
      const c = bar.close >= bar.open ? 'up' : 'down';
      const chg = prevClose ? bar.close - prevClose : 0;
      const chgPct = prevClose ? (chg / prevClose) * 100 : 0;
      ohlc = `<span class="lg-ohlc">${(['open', 'high', 'low', 'close'] as const)
        .map((k) => `<span><i>${k[0].toUpperCase()}</i><span class="${c}">${fmt(bar[k], d)}</span></span>`)
        .join('')}<span class="${cls(chg)}">${chg >= 0 ? '+' : ''}${fmt(chg, d)} (${pct(chgPct)})</span></span>`;
    }
    this.legend.innerHTML =
      `<div class="lg-title"><strong>${esc(symbol)}</strong><span class="muted">${esc(desc)}</span>${badge}${ohlc}</div>` +
      compares
        .map(
          (c) =>
            `<div class="lg-ind"><b style="color:${c.color}">${esc(c.symbol)}</b> ${c.value === null ? '—' : fmt(c.value, this.host.digitsFor(c.symbol, c.value))}` +
            `<button class="lg-x" data-uncompare="${esc(c.symbol)}" title="Remove ${esc(c.symbol)}">✕</button></div>`,
        )
        .join('') +
      inds.map((x) => `<div class="lg-ind"><span>${esc(x.label)}</span><b style="color:${x.color};font-weight:500">${esc(x.value)}</b></div>`).join('') +
      this.state.scripts
        .map((inst) => {
          const info = this.scriptInfo.get(inst.id);
          const name = info?.name ?? this.host.script(inst.scriptId)?.name ?? 'Script';
          const btn = (act: string, title: string, label: string) => `<button class="lg-x" data-script-act="${act}" data-inst="${inst.id}" title="${title}">${label}</button>`;
          const body = info?.error ? `<b class="down" style="font-weight:500">${esc(info.error.slice(0, 90))}</b>` : `<b style="font-weight:500">${esc(inst.hidden ? '' : (scripts[inst.id] ?? ''))}</b>`;
          return (
            `<div class="lg-ind lg-script${inst.hidden ? ' off' : ''}"><span>${esc(name)}</span>${body}` +
            btn('toggle', inst.hidden ? 'Show' : 'Hide', inst.hidden ? 'show' : 'hide') +
            btn('settings', 'Settings', 'settings') +
            btn('edit', 'Edit source', 'edit') +
            btn('remove', 'Remove from chart', '✕') +
            `</div>`
          );
        })
        .join('');
  }
}
