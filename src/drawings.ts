import { ACCENT, DOWN, UP, type ChartView, type Zone } from './chartview';
import { isTyping } from './dom';

export type Tool = 'cursor' | 'trend' | 'ray' | 'hline' | 'vline' | 'rect' | 'fib' | 'measure' | 'long' | 'short';

interface Pt {
  t: number; // unix seconds
  p: number; // price
}
interface Drawing {
  id: number;
  tool: Exclude<Tool, 'cursor'>;
  a: Pt;
  b: Pt;
  /** long / short position only: `a` is the entry, `b.p` the target, `b.t` the right edge, and this the stop */
  stop?: number;
}
type HandleKey = 'a' | 'b' | 'entry' | 'target' | 'stop' | 'width';
interface Drag {
  id: number;
  key: HandleKey | 'move';
  start: Pt;
  orig: Drawing;
}
interface XY {
  x: number;
  y: number;
}

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#787b86'];
const ONE_CLICK = new Set<Tool>(['hline', 'vline']);
const HIT = 6;
const GRAB = 9;
const isPosition = (d: Drawing) => d.tool === 'long' || d.tool === 'short';

/** Account assumptions behind the position tool's quantity and amounts. Double-click a position to change them. */
const POSITION_KEY = 'tview.position';
function positionSettings(): { account: number; riskPct: number } {
  try {
    const v = JSON.parse(localStorage.getItem(POSITION_KEY) ?? '{}');
    return { account: v.account > 0 ? v.account : 10000, riskPct: v.riskPct > 0 ? v.riskPct : 1 };
  } catch {
    return { account: 10000, riskPct: 1 };
  }
}
const SYNC_EVENT = 'tview-drawings';

/**
 * Canvas layer over the main price pane. It only takes pointer events while a
 * drawing tool is armed; otherwise the chart underneath stays fully interactive.
 */
export class Drawings {
  onToolDone: () => void = () => {};

  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private items: Drawing[] = [];
  private draft: Drawing | null = null;
  private hover: XY | null = null;
  private tool: Tool = 'cursor';
  private selected: number | null = null;
  private symbol = '';
  private downAt: XY | null = null;
  private drag: Drag | null = null;
  private off = new AbortController();

  /** `isActive` says whether this chart is the focused one; keyboard edits only apply there. */
  constructor(
    private host: HTMLElement,
    private view: ChartView,
    private isActive: () => boolean = () => true,
  ) {
    this.canvas.className = 'draw-layer';
    host.appendChild(this.canvas);

    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => (this.hover = null));

    view.chart.subscribeClick((p) => {
      this.selected = p.point ? this.hitTest(p.point) : null;
    });
    const signal = this.off.signal;
    // Editing happens with no tool armed: grab a handle to reshape, or the body to move.
    // Cancelling pointerdown also suppresses the mouse events the chart would pan on.
    host.addEventListener('pointerdown', (e) => this.onGrab(e), { capture: true, signal });
    host.addEventListener('mousedown', (e) => this.drag && e.stopPropagation(), { capture: true, signal });
    host.addEventListener('touchstart', (e) => this.drag && e.stopPropagation(), { capture: true, signal });
    host.addEventListener('dblclick', (e) => this.onDoubleClick(e), { signal });
    window.addEventListener('pointermove', (e) => this.onDrag(e), { signal });
    window.addEventListener('pointerup', () => this.endDrag(), { signal });
    window.addEventListener('pointercancel', () => this.endDrag(), { signal });
    window.addEventListener(
      'keydown',
      (e) => {
        if (isTyping(e)) return;
        if (e.key === 'Escape') {
          this.draft = null;
          this.selected = null;
          if (this.tool !== 'cursor') this.onToolDone();
        } else if (!this.isActive()) return;
        else if (e.key === 'Delete' || e.key === 'Backspace') this.removeSelected();
        else if (e.key === 'z' && (e.metaKey || e.ctrlKey) && this.items.length) {
          this.items.pop();
          this.save();
        }
      },
      { signal },
    );
    // another chart showing the same symbol changed its drawings: pick them up
    window.addEventListener(
      SYNC_EVENT,
      (e) => {
        const d = (e as CustomEvent<{ symbol: string; from: Drawings }>).detail;
        if (d.from !== this && d.symbol === this.symbol) this.read();
      },
      { signal },
    );
    const loop = () => {
      if (signal.aborted) return;
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setTool(tool: Tool) {
    this.tool = tool;
    this.draft = null;
    this.canvas.classList.toggle('armed', tool !== 'cursor');
  }

  destroy() {
    this.off.abort();
    this.canvas.remove();
  }

  get canvasEl() {
    return this.canvas;
  }

  setSymbol(symbol: string) {
    this.symbol = symbol;
    this.draft = null;
    this.selected = null;
    this.read();
  }

  private read() {
    const symbol = this.symbol;
    try {
      this.items = JSON.parse(localStorage.getItem(`tview.drawings.${symbol}`) ?? '[]');
    } catch {
      this.items = [];
    }
  }

  /** Deletes the selected drawing; returns false when nothing is selected. */
  removeSelected() {
    if (this.selected === null) return false;
    this.items = this.items.filter((d) => d.id !== this.selected);
    this.selected = null;
    this.save();
    return true;
  }

  clear() {
    this.items = [];
    this.draft = null;
    this.selected = null;
    this.save();
  }

  get count() {
    return this.items.length;
  }

  private save() {
    localStorage.setItem(`tview.drawings.${this.symbol}`, JSON.stringify(this.items));
    window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { symbol: this.symbol, from: this } }));
  }

  // --- pointer handling -----------------------------------------------------

  private local(e: PointerEvent): XY {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toPt(xy: XY): Pt | null {
    const t = this.view.xToTime(xy.x);
    const p = this.view.yToPrice(xy.y);
    return t === null || p === null ? null : { t, p };
  }

  private onDown(e: PointerEvent) {
    if (this.tool === 'cursor') return;
    const xy = this.local(e);
    const pt = this.toPt(xy);
    if (!pt) return;
    if (this.tool === 'long' || this.tool === 'short') {
      // one click drops a position with a 1:1 target and stop, sized to the current view
      const pane = this.view.mainPaneSize();
      const above = this.view.yToPrice(xy.y - pane.height * 0.15);
      const below = this.view.yToPrice(xy.y + pane.height * 0.15);
      const end = this.view.xToTime(xy.x + Math.max(80, pane.width * 0.2));
      if (above === null || below === null || end === null) return;
      const long = this.tool === 'long';
      return this.commit({ id: Date.now(), tool: this.tool, a: pt, b: { t: end, p: long ? above : below }, stop: long ? below : above });
    }
    if (ONE_CLICK.has(this.tool)) return this.commit({ id: Date.now(), tool: this.tool, a: pt, b: pt });
    if (this.draft) return this.commit({ ...this.draft, b: pt });
    this.draft = { id: Date.now(), tool: this.tool, a: pt, b: pt };
    this.downAt = xy;
    this.canvas.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    this.hover = this.local(e);
    const pt = this.draft && this.toPt(this.hover);
    if (this.draft && pt) this.draft.b = pt;
  }

  // Both gestures work: click-move-click, or press-drag-release.
  private onUp(e: PointerEvent) {
    const xy = this.local(e);
    const dragged = this.downAt && Math.hypot(xy.x - this.downAt.x, xy.y - this.downAt.y) > 8;
    this.downAt = null;
    if (this.draft && dragged) this.commit(this.draft);
  }

  private onGrab(e: PointerEvent) {
    if (this.tool !== 'cursor' || e.button !== 0 || (e.target as HTMLElement).closest('button, .replay-bar')) return;
    const pos = this.local(e);
    const pane = this.view.mainPaneSize();
    if (pos.x > pane.width || pos.y > pane.height) return;
    const sel = this.items.find((d) => d.id === this.selected);
    let key: Drag['key'] | undefined = sel && this.handlesOf(sel, pane).find((h) => Math.hypot(h.x - pos.x, h.y - pos.y) < GRAB)?.key;
    let target = sel;
    if (!key) {
      const id = this.hitTest(pos);
      target = this.items.find((d) => d.id === id);
      key = 'move';
    }
    const start = this.toPt(pos);
    if (!target || !start) return;
    this.selected = target.id;
    this.drag = { id: target.id, key, start, orig: JSON.parse(JSON.stringify(target)) };
    e.preventDefault();
    e.stopPropagation();
  }

  private onDrag(e: PointerEvent) {
    const g = this.drag;
    const d = g && this.items.find((x) => x.id === g.id);
    const pt = d && this.toPt(this.local(e));
    if (!g || !d || !pt) return;
    const o = g.orig;
    switch (g.key) {
      case 'move': {
        const dt = pt.t - g.start.t;
        const dp = pt.p - g.start.p;
        d.a = { t: o.a.t + dt, p: o.a.p + dp };
        d.b = { t: o.b.t + dt, p: o.b.p + dp };
        if (o.stop !== undefined) d.stop = o.stop + dp;
        break;
      }
      case 'a':
        if (d.tool === 'hline') d.a.p = d.b.p = pt.p;
        else if (d.tool === 'vline') d.a.t = d.b.t = pt.t;
        else d.a = pt;
        break;
      case 'b':
        d.b = pt;
        break;
      case 'entry':
        d.a = { t: pt.t < d.b.t ? pt.t : d.a.t, p: pt.p };
        break;
      case 'target':
        d.b.p = pt.p;
        break;
      case 'stop':
        d.stop = pt.p;
        break;
      case 'width':
        if (pt.t > d.a.t) d.b.t = pt.t;
        break;
    }
  }

  private endDrag() {
    if (!this.drag) return;
    this.drag = null;
    this.save();
  }

  private onDoubleClick(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    const d = this.items.find((x) => x.id === this.hitTest({ x: e.clientX - r.left, y: e.clientY - r.top }));
    if (!d || !isPosition(d)) return;
    const cur = positionSettings();
    const input = prompt('Account size, risk % per trade', `${cur.account}, ${cur.riskPct}`);
    const [account, riskPct] = (input ?? '').split(',').map((x) => Number(x.trim()));
    if (account > 0 && riskPct > 0) localStorage.setItem(POSITION_KEY, JSON.stringify({ account, riskPct }));
  }

  /** Grab points of a drawing, in pane pixels. */
  private handlesOf(d: Drawing, pane: { width: number; height: number }): (XY & { key: HandleKey })[] {
    const a = this.xy(d.a);
    const b = this.xy(d.b);
    if (!a || !b) return [];
    if (d.tool === 'hline') return [{ key: 'a', x: pane.width / 2, y: a.y }];
    if (d.tool === 'vline') return [{ key: 'a', x: a.x, y: pane.height / 2 }];
    if (isPosition(d)) {
      const ys = this.view.priceToY(d.stop ?? d.a.p) ?? a.y;
      return [
        { key: 'entry', x: a.x, y: a.y },
        { key: 'target', x: a.x, y: b.y },
        { key: 'stop', x: a.x, y: ys },
        { key: 'width', x: b.x, y: a.y },
      ];
    }
    return [
      { key: 'a', ...a },
      { key: 'b', ...b },
    ];
  }

  private commit(d: Drawing) {
    this.items.push(d);
    this.draft = null;
    this.selected = d.id;
    this.save();
    this.onToolDone();
  }

  // --- geometry ---------------------------------------------------------------

  private xy(pt: Pt): XY | null {
    const x = this.view.timeToX(pt.t);
    const y = this.view.priceToY(pt.p);
    return x === null || y === null ? null : { x, y };
  }

  private hitTest(pos: XY): number | null {
    const { width } = this.view.mainPaneSize();
    for (let i = this.items.length - 1; i >= 0; i--) {
      const d = this.items[i];
      const a = this.xy(d.a);
      const b = this.xy(d.b);
      if (!a || !b) continue;
      let hit = false;
      if (d.tool === 'hline') hit = Math.abs(pos.y - a.y) < HIT;
      else if (d.tool === 'vline') hit = Math.abs(pos.x - a.x) < HIT;
      else if (isPosition(d)) {
        const ys = this.view.priceToY(d.stop ?? d.a.p) ?? a.y;
        hit = pos.x >= Math.min(a.x, b.x) - HIT && pos.x <= Math.max(a.x, b.x) + HIT && pos.y >= Math.min(b.y, ys) - HIT && pos.y <= Math.max(b.y, ys) + HIT;
      }
      else if (d.tool === 'trend') hit = segDist(pos, a, b) < HIT;
      else if (d.tool === 'ray') hit = segDist(pos, a, rayEnd(a, b, width)) < HIT;
      else {
        const right = d.tool === 'fib' ? width : Math.max(a.x, b.x);
        hit = pos.x >= Math.min(a.x, b.x) - HIT && pos.x <= right + HIT && pos.y >= Math.min(a.y, b.y) - HIT && pos.y <= Math.max(a.y, b.y) + HIT;
      }
      if (hit) return d.id;
    }
    return null;
  }

  // --- rendering --------------------------------------------------------------

  private render() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pane = this.view.mainPaneSize();
    if (!pane.width || !pane.height) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, pane.width, pane.height);
    ctx.clip();
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';

    for (const z of this.view.zones) this.drawZone(z, pane);
    for (const d of this.items) this.draw(d, pane, d.id === this.selected);
    if (this.draft) this.draw(this.draft, pane, true);

    if (this.tool !== 'cursor' && this.hover) {
      ctx.strokeStyle = '#758696';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(this.hover.x + 0.5, 0);
      ctx.lineTo(this.hover.x + 0.5, pane.height);
      ctx.moveTo(0, this.hover.y + 0.5);
      ctx.lineTo(pane.width, this.hover.y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  /** Shaded zone from a user script. */
  private drawZone(z: Zone, pane: { width: number; height: number }) {
    const x1 = this.view.timeToX(z.t1);
    const x2 = z.t2 === null ? pane.width : this.view.timeToX(z.t2);
    const y1 = this.view.priceToY(z.top);
    const y2 = this.view.priceToY(z.bottom);
    if (x1 === null || x2 === null || y1 === null || y2 === null || x2 < 0 || x1 > pane.width) return;
    const { ctx } = this;
    const h = Math.max(1, y2 - y1);
    ctx.fillStyle = ctx.strokeStyle = z.color;
    ctx.globalAlpha = z.opacity;
    ctx.fillRect(x1, y1, x2 - x1, h);
    ctx.globalAlpha = Math.min(1, z.opacity * 2.5);
    ctx.lineWidth = 1;
    ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1, h);
    if (z.text) {
      ctx.textAlign = 'left';
      ctx.fillText(z.text, Math.max(x1, 0) + 4, y1 + h / 2);
    }
    ctx.globalAlpha = 1;
  }

  private draw(d: Drawing, pane: { width: number; height: number }, selected: boolean) {
    const a = this.xy(d.a);
    const b = this.xy(d.b);
    if (!a || !b) return;
    const { ctx } = this;
    const fmt = (p: number) => p.toFixed(this.view.digits);
    ctx.strokeStyle = ACCENT;
    ctx.fillStyle = ACCENT;
    ctx.lineWidth = selected ? 2 : 1.5;
    const stroke = (p: XY, q: XY) => {
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    };

    switch (d.tool) {
      case 'trend':
        stroke(a, b);
        break;
      case 'ray':
        stroke(a, rayEnd(a, b, pane.width));
        break;
      case 'hline':
        stroke({ x: 0, y: a.y }, { x: pane.width, y: a.y });
        this.tag(fmt(d.a.p), pane.width - 6, a.y - 9, ACCENT, 'right');
        break;
      case 'vline':
        stroke({ x: a.x, y: 0 }, { x: a.x, y: pane.height });
        break;
      case 'rect':
        ctx.fillStyle = 'rgba(41,98,255,.12)';
        ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        break;
      case 'fib': {
        const x0 = Math.min(a.x, b.x);
        FIB_LEVELS.forEach((lv, i) => {
          const price = d.b.p + (d.a.p - d.b.p) * lv;
          const y = this.view.priceToY(price);
          if (y === null) return;
          ctx.strokeStyle = FIB_COLORS[i];
          ctx.lineWidth = 1;
          stroke({ x: x0, y }, { x: pane.width, y });
          ctx.fillStyle = FIB_COLORS[i];
          ctx.textAlign = 'left';
          ctx.fillText(`${lv} (${fmt(price)})`, x0 + 4, y - 7);
        });
        ctx.strokeStyle = '#787b86';
        ctx.setLineDash([3, 3]);
        stroke(a, b);
        ctx.setLineDash([]);
        break;
      }
      case 'long':
      case 'short': {
        const ys = this.view.priceToY(d.stop ?? d.a.p);
        if (ys === null) break;
        const x0 = Math.min(a.x, b.x);
        const w = Math.abs(b.x - a.x);
        const mx = x0 + w / 2;
        ctx.fillStyle = 'rgba(8,153,129,.22)';
        ctx.fillRect(x0, Math.min(a.y, b.y), w, Math.abs(b.y - a.y));
        ctx.fillStyle = 'rgba(242,54,69,.22)';
        ctx.fillRect(x0, Math.min(a.y, ys), w, Math.abs(ys - a.y));
        ctx.strokeStyle = '#787b86';
        ctx.lineWidth = 1;
        stroke({ x: x0, y: a.y }, { x: x0 + w, y: a.y });

        const entry = d.a.p;
        const reward = Math.abs(d.b.p - entry);
        const risk = Math.abs((d.stop ?? entry) - entry);
        const { account, riskPct } = positionSettings();
        // size the trade so that hitting the stop loses exactly the chosen share of the account
        const rawQty = risk > 0 ? (account * riskPct) / 100 / risk : 0;
        const qty = rawQty >= 10 ? Math.floor(rawQty) : Math.floor(rawQty * 100) / 100;
        const tick = 10 ** -this.view.digits;
        const leg = (dist: number) => `${fmt(dist)} (${entry ? ((dist / entry) * 100).toFixed(3) : '0'}%) ${Math.round(dist / tick)}`;
        const last = this.view.bars[this.view.bars.length - 1]?.close ?? entry;
        const pnl = (last - entry) * qty * (d.tool === 'long' ? 1 : -1);
        // labels sit outside the box, on whichever side each level is
        this.tag(`Target: ${leg(reward)}, Amount: ${(account + reward * qty).toFixed(2)}`, mx, b.y + (b.y <= a.y ? -14 : 14), UP, 'center');
        this.tag(`Stop: ${leg(risk)}, Amount: ${(account - risk * qty).toFixed(2)}`, mx, ys + (ys >= a.y ? 14 : -14), DOWN, 'center');
        const toStop = ys >= a.y ? 1 : -1;
        this.tag(`Open PnL: ${pnl.toFixed(2)}, Qty: ${qty}`, mx, a.y + toStop * 16, pnl >= 0 ? UP : DOWN, 'center');
        this.tag(`Risk/reward ratio: ${risk > 0 ? +(reward / risk).toFixed(2) : '—'}`, mx, a.y + toStop * 35, pnl >= 0 ? UP : DOWN, 'center');
        break;
      }
      case 'measure': {
        const up = d.b.p >= d.a.p;
        const color = up ? UP : DOWN;
        ctx.fillStyle = up ? 'rgba(8,153,129,.15)' : 'rgba(242,54,69,.15)';
        ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        const mx = (a.x + b.x) / 2;
        stroke({ x: mx, y: a.y }, { x: mx, y: b.y });
        const diff = d.b.p - d.a.p;
        const pct = d.a.p ? (diff / d.a.p) * 100 : 0;
        const bars = Math.round(Math.abs(b.x - a.x) / (this.view.chart.timeScale().options().barSpacing || 1));
        const label = `${diff >= 0 ? '+' : ''}${fmt(diff)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) · ${bars} bars`;
        this.tag(label, mx, up ? b.y - 14 : b.y + 14, color, 'center');
        break;
      }
    }

    if (selected) {
      for (const p of this.handlesOf(d, pane)) {
        ctx.beginPath();
        if (p.key === 'target' || p.key === 'stop' || p.key === 'width') ctx.roundRect(p.x - 4.5, p.y - 4.5, 9, 9, 2);
        else ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  private tag(text: string, x: number, y: number, color: string, align: 'right' | 'center') {
    const { ctx } = this;
    const w = ctx.measureText(text).width + 10;
    const left = align === 'right' ? x - w : x - w / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(left, y - 9, w, 18, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(text, left + 5, y);
  }
}

function segDist(p: XY, a: XY, b: XY) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Extend a→b until it leaves the pane horizontally. */
function rayEnd(a: XY, b: XY, width: number): XY {
  const dx = b.x - a.x;
  if (Math.abs(dx) < 0.001) return { x: a.x, y: b.y > a.y ? 1e5 : -1e5 };
  const x = dx > 0 ? width : 0;
  return { x, y: a.y + ((b.y - a.y) * (x - a.x)) / dx };
}
