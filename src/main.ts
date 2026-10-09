import './style.css';
import {
  TickFeed,
  fetchCalendar,
  fetchLatest,
  fetchMovers,
  fetchNews,
  fetchSymbol,
  listSymbols,
  normalizeTf,
  parseTf,
  searchSymbols,
  tfLabel,
  type FeedStatus,
  type SymbolInfo,
  type Tick,
  type Timeframe,
} from './api';
import { CHART_TYPES, INDICATORS, SCALES, SIZED, tzOffset, type ChartType, type IndicatorId, type ScaleMode } from './chartview';
import type { Tool } from './drawings';
import { deleteLocal, importCsv, isLocal, localSymbols } from './localdata';
import { isTyping } from './dom';
import { ChartPane, type PaneHost, type PaneState } from './pane';
import { ScriptEditor, openInputs } from './scriptui';
import { ScriptRunner, loadScripts, saveScripts, type Script, type ScriptInstance } from './scripts';

const DEFAULT_WATCHLIST = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD', 'ETHUSD', 'US500', 'USTEC', 'US30', 'DE30', 'USOIL', 'XAGUSD', 'AAPL', 'NFLX'];
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TIMEZONES: [string, string][] = [
  ['UTC', 'UTC'],
  ['Pacific/Honolulu', 'Honolulu'],
  ['America/Los_Angeles', 'Los Angeles'],
  ['America/Denver', 'Denver'],
  ['America/Chicago', 'Chicago'],
  ['America/New_York', 'New York'],
  ['America/Sao_Paulo', 'São Paulo'],
  ['Europe/London', 'London'],
  ['Europe/Berlin', 'Frankfurt'],
  ['Europe/Istanbul', 'Istanbul'],
  ['Europe/Moscow', 'Moscow'],
  ['Asia/Dubai', 'Dubai'],
  ['Asia/Tashkent', 'Tashkent'],
  ['Asia/Kolkata', 'Mumbai'],
  ['Asia/Bangkok', 'Bangkok'],
  ['Asia/Shanghai', 'Shanghai'],
  ['Asia/Singapore', 'Singapore'],
  ['Asia/Tokyo', 'Tokyo'],
  ['Australia/Sydney', 'Sydney'],
  ['Pacific/Auckland', 'Auckland'],
];
if (!TIMEZONES.some(([id]) => id === LOCAL_TZ)) TIMEZONES.splice(1, 0, [LOCAL_TZ, LOCAL_TZ.split('/').pop()!.replace(/_/g, ' ')]);
const SYMBOL_TYPES = ['All', 'Forex', 'Crypto', 'Stock', 'Index', 'Commodity'];

const TF_FAVORITES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const TF_GROUPS: [string, Timeframe[]][] = [
  ['Ticks', ['1T', '10T', '100T']],
  ['Seconds', ['1s', '5s', '15s', '30s']],
  ['Minutes', ['1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m']],
  ['Hours', ['1h', '2h', '3h', '4h']],
  ['Days and up', ['1d', '2d', '3d', '1w', '1M']],
];

/** Chart grid layouts. `big` makes the first chart span both rows. */
const LAYOUTS: Record<string, { n: number; cols: number; rows: number; big?: boolean }> = {
  '1': { n: 1, cols: 1, rows: 1 },
  '2v': { n: 2, cols: 2, rows: 1 },
  '2h': { n: 2, cols: 1, rows: 2 },
  '3': { n: 3, cols: 2, rows: 2, big: true },
  '4': { n: 4, cols: 2, rows: 2 },
  '6': { n: 6, cols: 3, rows: 2 },
  '8': { n: 8, cols: 4, rows: 2 },
};
const SYNC_OPTIONS = { symbol: 'Symbol', interval: 'Interval', crosshair: 'Crosshair', time: 'Time range' } as const;
type SyncKey = keyof typeof SYNC_OPTIONS;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function load<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(`tview.${key}`);
    return v === null ? def : JSON.parse(v);
  } catch {
    return def;
  }
}
const save = (key: string, v: unknown) => localStorage.setItem(`tview.${key}`, JSON.stringify(v));

/** Fill in and sanity-check a stored pane, so old or hand-edited settings can't break startup. */
function cleanPane(p: Partial<PaneState>): PaneState {
  return {
    symbol: typeof p.symbol === 'string' && p.symbol ? p.symbol : 'XAUUSD',
    tf: typeof p.tf === 'string' && parseTf(p.tf) ? p.tf : '1h',
    type: p.type && p.type in CHART_TYPES ? p.type : 'candles',
    indicators: (Array.isArray(p.indicators) ? p.indicators : (['vol', 'ema50'] as IndicatorId[])).filter((i) => i in INDICATORS),
    compares: Array.isArray(p.compares) ? p.compares.filter((c) => typeof c === 'string') : [],
    scale: p.scale && p.scale in SCALES ? p.scale : 'normal',
    box: typeof p.box === 'number' && p.box > 0 ? p.box : null,
    scripts: (Array.isArray(p.scripts) ? p.scripts : []).filter((s: ScriptInstance) => s && typeof s.id === 'string' && typeof s.scriptId === 'string').map((s) => ({ ...s, inputs: s.inputs ?? {} })),
  };
}

const state = {
  // before multi-chart layouts there was one chart with these top-level keys; they seed the first pane
  panes: load<Partial<PaneState>[]>('panes', [{ symbol: load('symbol', 'XAUUSD'), tf: load('tf', '1h'), type: load('type', 'candles'), indicators: load('indicators', undefined) }]).map(cleanPane),
  layout: load('layout', '1'),
  activePane: load('activePane', 0),
  sync: { symbol: false, interval: false, crosshair: true, time: false, ...load<Partial<Record<SyncKey, boolean>>>('sync', {}) },
  watchlist: load('watchlist', DEFAULT_WATCHLIST),
  dark: load('dark', true),
  tz: load('tz', LOCAL_TZ),
  tab: load<'calendar' | 'news' | 'movers' | 'scripts'>('tab', 'calendar'),
  bottomOpen: load('bottomOpen', true),
  // on a narrow window the watchlist starts hidden so the chart gets the room
  sideOpen: load('sideOpen', window.innerWidth >= 1000),
  sideWidth: load('sideWidth', 320),
};
if (!(state.layout in LAYOUTS)) state.layout = '1';
if (!state.panes.length) state.panes = [cleanPane({})];
if (!TIMEZONES.some(([id]) => id === state.tz)) state.tz = 'UTC';

const feed = new TickFeed();
const runner = new ScriptRunner();
const scripts: Script[] = loadScripts();
const ticks = new Map<string, Tick>();
const infoCache = new Map<string, SymbolInfo>();
const infoPending = new Map<string, Promise<SymbolInfo | null>>();
const panes: ChartPane[] = [];
/** the chart the pointer is over; only that one broadcasts crosshair and scroll to the others */
let pointerPane: ChartPane | null = null;

const active = () => panes[Math.min(state.activePane, panes.length - 1)];
// handy when poking at charts from the dev console
if (import.meta.env.DEV) Object.assign(window, { __panes: panes });
const activeSymbol = () => active().state.symbol;

// ---------------------------------------------------------------- formatting

function info(symbol: string) {
  let p = infoPending.get(symbol);
  if (!p) {
    p = fetchSymbol(symbol)
      .then((i) => (infoCache.set(symbol, i), i))
      .catch(() => null);
    infoPending.set(symbol, p);
  }
  return p;
}

function digitsFor(symbol: string, price: number) {
  const i = infoCache.get(symbol);
  const p = Math.abs(price);
  if (i?.digits !== undefined && (i.type === 'Forex' || i.type === 'Imported' || i.digits <= 4 || p < 1)) return Math.min(i.digits, 8);
  // metadata missing, or a blanket "5" on a non-FX instrument: go by magnitude instead
  return p >= 10 ? 2 : p >= 1 ? 4 : 6;
}

const fmt = (v: number, digits: number) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'muted');
const priceOf = (t: Tick) => t.mid || (t.bid + t.ask) / 2;

// -------------------------------------------------------------------- charts

function persist() {
  state.panes = panes.map((p) => p.state);
  save('panes', state.panes);
  save('layout', state.layout);
  save('activePane', state.activePane);
  save('sync', state.sync);
}

const host: PaneHost = {
  tick: (s) => ticks.get(s),
  info: (s) => infoCache.get(s),
  loadInfo: info,
  digitsFor,
  isActive: (p) => p === active(),
  activate,
  pointer: (p) => (pointerPane = p),
  hover(pane, time) {
    if (state.sync.crosshair && pane === pointerPane) for (const p of panes) if (p !== pane) p.view.showCrosshairAt(time);
  },
  range(pane, range) {
    if (state.sync.time && pane === pointerPane) for (const p of panes) if (p !== pane) p.view.setRange(range);
  },
  toolDone: () => setTool('cursor'),
  script: (id) => scripts.find((s) => s.id === id),
  runScript: (source, bars, inputs, tf) => runner.run(source, bars, inputs, tf),
  scriptAction(pane, instanceId, action) {
    const info = pane.scriptInputs(instanceId);
    if (!info) return;
    if (action === 'edit') return openScriptEditor(info.scriptId);
    openInputs($('inputsModal'), info.name || 'Script settings', info.defs, info.values, (v) => pane.setScriptInputs(instanceId, v));
  },
  scriptFailed: (scriptId, message) => editor.reportError(scriptId, message),
  changed() {
    persist();
    syncFeed();
    renderTopbar();
  },
};

function addPane(st: PaneState) {
  const pane = new ChartPane($('charts'), st, host);
  pane.view.applyTheme(state.dark);
  pane.view.setTimezone(state.tz);
  pane.drawings.setTool(currentTool);
  panes.push(pane);
  void pane.load();
  return pane;
}

function activate(pane: ChartPane) {
  const i = panes.indexOf(pane);
  if (i < 0 || (i === state.activePane && pane.el.classList.contains('active'))) return;
  state.activePane = i;
  panes.forEach((p) => p.el.classList.toggle('active', p === pane));
  save('activePane', i);
  renderTopbar();
  markWatchlist();
  renderDetails();
}

/** Grow or shrink the grid to the chosen layout. New charts start as copies of the active one. */
function applyLayout(id: string) {
  const spec = LAYOUTS[id];
  state.layout = id;
  const grid = $('charts');
  grid.style.gridTemplateColumns = `repeat(${spec.cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${spec.rows}, minmax(0, 1fr))`;
  grid.classList.toggle('multi', spec.n > 1);
  while (panes.length > spec.n) panes.pop()!.destroy();
  while (panes.length < spec.n) addPane(cleanPane(JSON.parse(JSON.stringify(state.panes[panes.length] ?? active().state))));
  panes.forEach((p, i) => (p.el.style.gridRow = spec.big && i === 0 ? 'span 2' : ''));
  state.activePane = Math.min(state.activePane, panes.length - 1);
  panes.forEach((p, i) => p.el.classList.toggle('active', i === state.activePane));
  persist();
  syncFeed();
  renderTopbar();
  markWatchlist();
  renderDetails();
}

/** Load a symbol into the active chart, or into every chart when symbols are synced. */
function selectSymbol(symbol: string) {
  for (const p of state.sync.symbol ? panes : [active()]) p.setSymbol(symbol);
  host.changed();
  markWatchlist();
  renderDetails();
}

function setTimeframe(tf: Timeframe) {
  for (const p of state.sync.interval ? panes : [active()]) if (p.state.tf !== tf) p.setTf(tf);
  host.changed();
}

function markWatchlist() {
  const symbol = activeSymbol();
  document.querySelectorAll<HTMLElement>('.wl-row').forEach((r) => r.classList.toggle('active', r.dataset.symbol === symbol));
}

// ----------------------------------------------------------------- live feed

const dirty = new Set<string>();
let flushQueued = false;

function onTick(t: Tick, live = true) {
  const prev = ticks.get(t.symbol);
  // hub ticks carry no marketState; a tick arriving at all means the market is quoting
  ticks.set(t.symbol, { ...prev, ...t, marketState: t.marketState ?? (live ? 'open' : prev?.marketState) });
  dirty.add(t.symbol);
  for (const p of panes) p.onTick(t);
  if (!flushQueued) {
    flushQueued = true;
    requestAnimationFrame(flush);
  }
}

function flush() {
  flushQueued = false;
  for (const s of dirty) updateRow(s);
  if (dirty.has(activeSymbol())) renderDetails();
  dirty.clear();
}

const allSymbols = () => [...new Set([...state.watchlist, ...panes.flatMap((p) => p.symbols())])];

function syncFeed() {
  void feed.setSymbols(allSymbols());
}

const FEED_LABEL: Record<FeedStatus, string> = { live: 'Live', connecting: 'Connecting', polling: 'Polling', offline: 'Offline' };
feed.onTick = onTick;
feed.onStatus = (s) => {
  $('feed').dataset.status = s;
  $('feed').querySelector('b')!.textContent = FEED_LABEL[s];
};

// ----------------------------------------------------------------- watchlist

const rows = new Map<string, { last: HTMLElement; chg: HTMLElement; desc: HTMLElement; price: number }>();

function renderWatchlist() {
  const el = $('watchlist');
  el.innerHTML = '';
  rows.clear();
  for (const symbol of state.watchlist) {
    const row = document.createElement('div');
    row.className = 'wl-row';
    row.dataset.symbol = symbol;
    row.classList.toggle('active', symbol === activeSymbol());
    row.innerHTML =
      `<div class="wl-sym"><b>${esc(symbol)}</b><small></small></div><span class="wl-last num">—</span><span class="wl-chg num">—</span>` +
      `<button class="wl-del" title="Remove from watchlist"><svg viewBox="0 0 20 20" width="12" height="12"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>`;
    row.addEventListener('click', () => selectSymbol(symbol));
    row.querySelector('.wl-del')!.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatch(symbol);
    });
    el.appendChild(row);
    rows.set(symbol, {
      last: row.querySelector('.wl-last')!,
      chg: row.querySelector('.wl-chg')!,
      desc: row.querySelector('small')!,
      price: NaN,
    });
    updateRow(symbol);
  }
}

function updateRow(symbol: string) {
  const r = rows.get(symbol);
  const t = ticks.get(symbol);
  if (!r) return;
  r.desc.textContent = t?.description || infoCache.get(symbol)?.description || '';
  if (!t) return;
  const price = priceOf(t);
  r.last.textContent = fmt(price, digitsFor(symbol, price));
  r.chg.textContent = pct(t.dayDiffPercent);
  r.chg.className = `wl-chg num ${cls(t.dayDiffPercent)}`;
  if (!Number.isNaN(r.price) && price !== r.price) {
    const flash = price > r.price ? 'flash-up' : 'flash-down';
    r.last.classList.remove('flash-up', 'flash-down');
    r.last.classList.add(flash);
    window.setTimeout(() => r.last.classList.remove(flash), 80);
  }
  r.price = price;
}

function toggleWatch(symbol: string) {
  const i = state.watchlist.indexOf(symbol);
  if (i >= 0) state.watchlist.splice(i, 1);
  else state.watchlist.push(symbol);
  save('watchlist', state.watchlist);
  renderWatchlist();
  syncFeed();
  if (i < 0) void seedTicks([symbol]);
}

function renderDetails() {
  const symbol = activeSymbol();
  const t = ticks.get(symbol);
  const i = infoCache.get(symbol);
  const head = `<div class="dt-name"><b>${esc(symbol)}</b><span class="badge">${esc(i?.type ?? '')}</span></div><div class="dt-desc">${esc(t?.description || i?.description || '')}</div>`;
  if (!t) return void ($('details').innerHTML = `${head}<div class="muted">Waiting for a quote…</div>`);
  const price = priceOf(t);
  const d = digitsFor(symbol, price);
  const closed = t.marketState === 'closed';
  const pos = t.high > t.low ? Math.max(0, Math.min(100, ((price - t.low) / (t.high - t.low)) * 100)) : 50;
  $('details').innerHTML =
    head +
    `<div class="dt-price num">${fmt(price, d)}</div>` +
    // the day change belongs to a session that has ended once the market closes
    `<div class="dt-chg num ${closed ? 'muted' : cls(t.dayDiffPercent)}">${closed ? 'Market closed — last price' : `${pct(t.dayDiffPercent)} today`}</div>` +
    `<div class="dt-ba num"><div class="bid"><small>BID</small>${fmt(t.bid, d)}</div><div class="spr">${fmt(t.spread ?? t.ask - t.bid, d)}</div><div class="ask"><small>ASK</small>${fmt(t.ask, d)}</div></div>` +
    `<div class="range">Day's range<div class="range-bar"><i style="left:${pos}%"></i></div><div class="range-vals num"><span>${fmt(t.low, d)}</span><span>${fmt(t.high, d)}</span></div></div>` +
    `<div class="dt-src">${esc(t.source ?? i?.source ?? '')}</div>`;
}

async function seedTicks(symbols: string[]) {
  try {
    Object.values(await fetchLatest(symbols)).forEach((t) => onTick(t, false));
  } catch (e) {
    console.warn('quote snapshot failed', e);
  }
  await Promise.all(symbols.map(info));
  symbols.forEach(updateRow);
  renderDetails();
}

// ------------------------------------------------------------------- top bar

const layoutIcon = (id: string) => {
  const { cols, rows, big } = LAYOUTS[id];
  let cells = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (big && c === 0 && r > 0) continue;
      const w = 16 / cols;
      const h = 12 / rows;
      cells += `<rect x="${2 + c * w + 0.6}" y="${4 + r * h + 0.6}" width="${w - 1.2}" height="${(big && c === 0 ? 12 : h) - 1.2}" rx="1"/>`;
    }
  }
  return `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.2">${cells}</svg>`;
};

/** The top bar mirrors the active chart. */
function renderTopbar() {
  if (!panes.length) return;
  const st = active().state;
  $('symbolName').textContent = st.symbol;
  const quick = TF_FAVORITES.includes(st.tf) ? TF_FAVORITES : [...TF_FAVORITES, st.tf];
  $('tfs').innerHTML = quick.map((tf) => `<button data-tf="${tf}" class="${tf === st.tf ? 'active' : ''}">${tfLabel(tf)}</button>`).join('');
  $('tfPop').innerHTML =
    TF_GROUPS.map(
      ([name, list]) =>
        `<h5>${name}</h5><div class="tf-grid">${list.map((tf) => `<button data-tf="${tf}" class="${tf === st.tf ? 'active' : ''}">${tfLabel(tf)}</button>`).join('')}</div>`,
    ).join('') + `<h5>Custom</h5><input id="tfInput" class="pop-input" placeholder="e.g. 7m, 6h, 2D, 50T" autocomplete="off" />`;

  $('typeBtn').textContent = CHART_TYPES[st.type];
  $('typePop').innerHTML =
    Object.entries(CHART_TYPES)
      .map(([id, name]) => `<button data-type="${id}" class="${id === st.type ? 'active' : ''}">${name}</button>`)
      .join('') +
    (SIZED.has(st.type)
      ? `<h5>${st.type === 'range' ? 'Range' : st.type === 'kagi' ? 'Reversal amount' : 'Box size'}</h5><input id="boxInput" class="pop-input" inputmode="decimal" placeholder="auto (ATR 14)" value="${st.box ?? ''}" />`
      : '');
  $('indPop').innerHTML = Object.entries(INDICATORS)
    .map(([id, name]) => `<button data-ind="${id}" class="${st.indicators.includes(id as IndicatorId) ? 'active' : ''}"><span class="check"></span>${name}</button>`)
    .join('');
  $('indPop').innerHTML +=
    `<h5>My scripts</h5>` +
    scripts.map((s) => `<button data-script="${esc(s.id)}" title="Add to this chart"><span class="plus">+</span>${esc(s.name)}</button>`).join('') +
    `<button data-script-editor>Open script editor…</button>`;
  $('scaleBtn').textContent = st.scale === 'normal' ? 'Scale' : SCALES[st.scale];
  $('scalePop').innerHTML = Object.entries(SCALES)
    .map(([id, name]) => `<button data-scale="${id}" class="${id === st.scale ? 'active' : ''}">${name}</button>`)
    .join('');
  $('replayBtn').classList.toggle('on', active().replaying);
  $('layoutBtn').innerHTML = layoutIcon(state.layout);
  $('layoutPop').innerHTML =
    `<div class="layout-grid">${Object.keys(LAYOUTS)
      .map((id) => `<button data-layout="${id}" class="${id === state.layout ? 'active' : ''}" title="${LAYOUTS[id].n} chart${LAYOUTS[id].n > 1 ? 's' : ''}">${layoutIcon(id)}</button>`)
      .join('')}</div><h5>Sync across charts</h5>` +
    Object.entries(SYNC_OPTIONS)
      .map(([id, name]) => `<button data-sync="${id}" class="${state.sync[id as SyncKey] ? 'active' : ''}"><span class="check"></span>${name}</button>`)
      .join('');
}

const pickTf = (e: Event) => {
  const tf = (e.target as HTMLElement).closest<HTMLElement>('[data-tf]')?.dataset.tf;
  if (!tf) return;
  setTimeframe(tf);
  closeMenus();
};
$('tfs').addEventListener('click', pickTf);
$('tfPop').addEventListener('click', pickTf);
$('tfPop').addEventListener('keydown', (e) => {
  const input = e.target as HTMLInputElement;
  if (e.key !== 'Enter' || input.id !== 'tfInput') return;
  const tf = normalizeTf(input.value);
  if (!tf) return input.classList.add('bad');
  setTimeframe(tf);
  closeMenus();
});

$('typePop').addEventListener('click', (e) => {
  const type = (e.target as HTMLElement).closest('button')?.dataset.type as ChartType | undefined;
  if (!type) return;
  active().setType(type);
  host.changed();
  // box-based types reveal a size field, so leave the menu open for it
  if (!SIZED.has(type)) closeMenus();
});
$('typePop').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.id !== 'boxInput') return;
  const v = Number(input.value.replace(',', '.'));
  active().setBox(v > 0 ? v : null);
  host.changed();
});

$('indPop').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (btn?.dataset.script) {
    active().addScript(btn.dataset.script);
    return closeMenus();
  }
  if (btn && 'scriptEditor' in btn.dataset) {
    closeMenus();
    return openScriptEditor();
  }
  const id = btn?.dataset.ind as IndicatorId | undefined;
  if (!id) return;
  const cur = active().state.indicators;
  active().setIndicators((Object.keys(INDICATORS) as IndicatorId[]).filter((k) => (k === id ? !cur.includes(id) : cur.includes(k))));
  host.changed();
});

$('scalePop').addEventListener('click', (e) => {
  const mode = (e.target as HTMLElement).closest('button')?.dataset.scale as ScaleMode | undefined;
  if (!mode) return;
  active().setScale(mode);
  host.changed();
  closeMenus();
});

$('layoutPop').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (btn?.dataset.layout) {
    applyLayout(btn.dataset.layout);
    closeMenus();
  } else if (btn?.dataset.sync) {
    const key = btn.dataset.sync as SyncKey;
    state.sync[key] = !state.sync[key];
    if (!state.sync.crosshair) panes.forEach((p) => p.view.showCrosshairAt(null));
    // turning a sync on brings the other charts in line with the active one straight away
    if (state.sync[key] && key === 'symbol') selectSymbol(activeSymbol());
    if (state.sync[key] && key === 'interval') setTimeframe(active().state.tf);
    host.changed();
  }
});

$('replayBtn').addEventListener('click', () => active().toggleReplay());
$('compareBtn').addEventListener('click', () => openSearch('', 'compare'));

// ------------------------------------------------- timezone & bar countdown

function utcLabel(tz: string) {
  const m = Math.round(tzOffset(tz, Date.now() / 1000) / 60);
  if (!m) return 'UTC';
  const abs = Math.abs(m);
  return `UTC${m < 0 ? '-' : '+'}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}

function renderTz() {
  $('tzPop').innerHTML = TIMEZONES.map(
    ([id, city]) => `<button data-tz="${esc(id)}" class="${id === state.tz ? 'active' : ''}">${esc(city)}${id === LOCAL_TZ ? ' (local)' : ''}<span class="muted">${id === 'UTC' ? '' : utcLabel(id)}</span></button>`,
  ).join('');
  tickClock();
}

$('tzPop').addEventListener('click', (e) => {
  const tz = (e.target as HTMLElement).closest('button')?.dataset.tz;
  if (!tz) return;
  state.tz = tz;
  save('tz', tz);
  panes.forEach((p) => p.view.setTimezone(tz));
  renderTz();
  closeMenus();
  if (state.tab === 'calendar') void loadTab(false);
});

function tickClock() {
  const clock = new Date().toLocaleTimeString('en-GB', { timeZone: state.tz });
  $('tzBtn').textContent = `${clock} (${utcLabel(state.tz)})`;
  const now = Date.now() / 1000;
  for (const p of panes) p.tickUi(now);
}
window.setInterval(tickClock, 250);

const closeMenus = () => document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
for (const id of ['tfMenu', 'typeMenu', 'indMenu', 'scaleMenu', 'layoutMenu', 'tzMenu']) {
  $(id)
    .querySelector('.tb-btn')!
    .addEventListener('click', (e) => {
      e.stopPropagation();
      const open = $(id).classList.contains('open');
      closeMenus();
      $(id).classList.toggle('open', !open);
    });
}
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.pop')) closeMenus();
});

function applyTheme() {
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
  editor.setDark(state.dark);
  panes.forEach((p) => p.view.applyTheme(state.dark));
}
$('themeBtn').addEventListener('click', () => {
  state.dark = !state.dark;
  save('dark', state.dark);
  applyTheme();
});

$('fsBtn').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
});

$('shotBtn').addEventListener('click', () => {
  const { symbol, tf } = active().state;
  const a = document.createElement('a');
  a.href = active().screenshot().toDataURL('image/png');
  a.download = `${symbol}-${tf}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.png`;
  a.click();
});

// ------------------------------------------------------------- drawing tools

const svg = (body: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const dot = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="1.8" fill="currentColor" stroke="none"/>`;
const TOOLS: { id: Tool; title: string; icon: string }[] = [
  { id: 'cursor', title: 'Crosshair', icon: svg('<path d="M12 3v7M12 14v7M3 12h7M14 12h7"/>') },
  { id: 'trend', title: 'Trend line', icon: svg(`<path d="M5.5 18.5l13-13"/>${dot(5, 19)}${dot(19, 5)}`) },
  { id: 'ray', title: 'Ray', icon: svg(`<path d="M5.5 17.5L21 7"/>${dot(5, 18)}${dot(12, 13.2)}`) },
  { id: 'hline', title: 'Horizontal line', icon: svg(`<path d="M3 12h18"/>${dot(12, 12)}`) },
  { id: 'vline', title: 'Vertical line', icon: svg(`<path d="M12 3v18"/>${dot(12, 12)}`) },
  { id: 'rect', title: 'Rectangle', icon: svg('<rect x="4" y="7" width="16" height="10" rx="1"/>') },
  { id: 'fib', title: 'Fib retracement', icon: svg('<path d="M4 5h16M4 10h16M4 14h16M4 19h16"/>') },
  { id: 'measure', title: 'Measure price range', icon: svg('<path d="M4 16L16 4l4 4L8 20z"/><path d="M8 12l2 2M11 9l2 2M14 6l2 2"/>') },
  { id: 'long', title: 'Long position', icon: svg('<rect x="5" y="4" width="14" height="8" rx="1" fill="rgba(8,153,129,.45)" stroke="#089981"/><rect x="5" y="12" width="14" height="8" rx="1" fill="rgba(242,54,69,.25)" stroke="#f23645"/>') },
  { id: 'short', title: 'Short position', icon: svg('<rect x="5" y="4" width="14" height="8" rx="1" fill="rgba(242,54,69,.25)" stroke="#f23645"/><rect x="5" y="12" width="14" height="8" rx="1" fill="rgba(8,153,129,.45)" stroke="#089981"/>') },
];

function renderTools(active: Tool) {
  $('tools').innerHTML =
    TOOLS.map((t) => `<button data-tool="${t.id}" title="${t.title}" class="${t.id === active ? 'active' : ''}">${t.icon}</button>`).join('') +
    `<hr/><button data-clear title="Delete selected drawing (or all, if none is selected)">${svg('<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>')}</button>`;
}
let currentTool: Tool = 'cursor';

/** A tool is armed on every chart at once, so the next click can land in any of them. */
function setTool(tool: Tool) {
  currentTool = tool;
  panes.forEach((p) => p.drawings.setTool(tool));
  renderTools(tool);
}

$('tools').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  if ('clear' in btn.dataset) {
    // the bin removes just the selected drawing; wiping everything needs a confirmation
    const d = active().drawings;
    if (!d.removeSelected() && d.count && confirm(`Remove all ${d.count} drawings on ${activeSymbol()}?`)) d.clear();
    return;
  }
  setTool(btn.dataset.tool as Tool);
});

// ------------------------------------------------------------- symbol search

let searchType = 'All';
let searchSeq = 0;
let results: SymbolInfo[] = [];
let cursor = 0;
let searchTimer: number | undefined;
const listCache = new Map<string, SymbolInfo[]>();
const searchInput = $<HTMLInputElement>('searchInput');

/** 'compare' adds the picked symbol as an overlay on the active chart instead of loading it. */
let searchMode: 'symbol' | 'compare' = 'symbol';

function openSearch(prefill = '', mode: typeof searchMode = 'symbol') {
  searchMode = mode;
  $('searchModal').classList.remove('hidden');
  searchInput.placeholder = mode === 'compare' ? `Compare ${activeSymbol()} with…` : 'Search symbol or name';
  searchInput.value = prefill;
  searchInput.focus();
  renderChips();
  void runSearch();
}
const closeSearch = () => $('searchModal').classList.add('hidden');
const searchOpen = () => !$('searchModal').classList.contains('hidden');

function renderChips() {
  $('searchChips').innerHTML = [...SYMBOL_TYPES, 'Imported'].map((t) => `<button data-type="${t}" class="${t === searchType ? 'active' : ''}">${t}</button>`).join('');
}

async function runSearch() {
  const seq = ++searchSeq;
  const q = searchInput.value.trim().toUpperCase();
  const type = searchType === 'All' ? undefined : searchType;
  const locals = localSymbols().filter((s) => !q || `${s.name} ${s.description}`.toUpperCase().includes(q));
  let list: SymbolInfo[];
  try {
    if (type === 'Imported') {
      list = [];
    } else if (q) {
      list = (await searchSymbols(q)).filter((s) => !type || s.type === type);
    } else {
      const key = type ?? 'All';
      if (!listCache.has(key)) listCache.set(key, await listSymbols(type));
      list = listCache.get(key)!;
    }
  } catch (e) {
    if (seq === searchSeq) $('searchResults').innerHTML = `<div class="empty">Search failed: ${esc((e as Error).message)}</div>`;
    return;
  }
  if (seq !== searchSeq) return;
  if (!type || type === 'Imported') list = [...locals, ...list];
  // imported data first, then symbols that actually quote, then the closest name match, then the default watchlist
  const rank = (s: SymbolInfo) =>
    (isLocal(s.name) ? -10000 : 0) +
    (s.hasData === false ? 4000 : 0) +
    (q ? (s.name === q ? 0 : s.name.startsWith(q) ? 1000 : 2000) : 0) +
    (DEFAULT_WATCHLIST.indexOf(s.name) + 1 || 900);
  results = [...list].sort((a, b) => rank(a) - rank(b)).slice(0, 150);
  cursor = 0;
  renderResults();
}

function renderResults() {
  const el = $('searchResults');
  if (!results.length) {
    const hint = searchType === 'Imported' ? 'Nothing imported yet. Use “Import CSV folder” above.' : 'No symbols match';
    return void (el.innerHTML = `<div class="empty">${hint}</div>`);
  }
  el.innerHTML = results
    .map((s, i) => {
      const on = state.watchlist.includes(s.name);
      return (
        `<div class="res-row ${i === cursor ? 'cursor' : ''}" data-i="${i}">` +
        `<b class="${s.hasData === false ? 'nodata' : ''}">${esc(s.name)}</b><span class="desc">${esc(s.description)}</span>` +
        (isLocal(s.name)
          ? `<button class="res-del" title="Delete this imported data from the browser">Delete data</button>`
          : `<span class="badge">${esc(s.type)}${s.exchange ? ` · ${esc(s.exchange)}` : ''}</span>`) +
        `<button class="res-add ${on ? 'on' : ''}" title="${on ? 'Remove from' : 'Add to'} watchlist"><svg viewBox="0 0 20 20" width="14" height="14"><path d="${on ? 'M4 10.5l4 4 8-9' : 'M10 4v12M4 10h12'}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>`
      );
    })
    .join('');
}

function pick(i: number) {
  const s = results[i];
  if (!s) return;
  infoCache.set(s.name, s);
  closeSearch();
  if (searchMode === 'compare') active().addCompare(s.name);
  else selectSymbol(s.name);
}

$('searchResults').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const row = target.closest<HTMLElement>('.res-row');
  if (!row) return;
  const i = Number(row.dataset.i);
  if (target.closest('.res-del')) {
    const { name } = results[i];
    if (!confirm(`Delete the imported data for ${name.slice(4)} from this browser? Your CSV files are not touched.`)) return;
    void deleteLocal(name).then(() => {
      infoCache.delete(name);
      infoPending.delete(name);
      ticks.delete(name);
      if (state.watchlist.includes(name)) toggleWatch(name);
      void runSearch();
    });
  } else if (target.closest('.res-add')) {
    infoCache.set(results[i].name, results[i]);
    toggleWatch(results[i].name);
    renderResults();
  } else pick(i);
});
$('searchChips').addEventListener('click', (e) => {
  const type = (e.target as HTMLElement).dataset.type;
  if (!type) return;
  searchType = type;
  renderChips();
  void runSearch();
  searchInput.focus();
});
searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void runSearch(), 180);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') return pick(cursor);
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  cursor = Math.max(0, Math.min(results.length - 1, cursor + (e.key === 'ArrowDown' ? 1 : -1)));
  renderResults();
  $('searchResults').querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
});
$('symbolBtn').addEventListener('click', () => openSearch());
$('addBtn').addEventListener('click', () => openSearch());
$('searchClose').addEventListener('click', closeSearch);
$('searchModal').addEventListener('mousedown', (e) => {
  if (e.target === $('searchModal')) closeSearch();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenus();
    return closeSearch();
  }
  // Alt+R resets the active chart's view (matched by key position: on a Mac, Option+R types "®")
  if (e.altKey && e.code === 'KeyR' && !searchOpen() && !isTyping(e)) {
    e.preventDefault();
    return active().view.resetView();
  }
  // start typing anywhere to search, as on TradingView
  if (searchOpen() || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
  if (/^[a-z0-9]$/i.test(e.key)) {
    e.preventDefault();
    openSearch(e.key.toUpperCase());
  }
});

// ---------------------------------------------------------------- CSV import

async function runImport(input: HTMLInputElement) {
  const files = [...(input.files ?? [])].filter((f) => /\.csv$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  input.value = '';
  if (!files.length) return alert('No .csv files in that selection.');
  closeSearch();
  $('importModal').classList.remove('hidden');
  $('importClose').classList.add('hidden');
  $('importTitle').textContent = 'Importing CSV data';
  const started = Date.now();
  try {
    const res = await importCsv(files, (done, total, name) => {
      $('importBar').style.width = `${(done / total) * 100}%`;
      $('importText').textContent = `${done} of ${total} files\n${name}`;
    });
    for (const s of res.symbols) {
      // forget anything cached from an earlier import of the same symbol
      infoCache.delete(s);
      infoPending.delete(s);
      if (!state.watchlist.includes(s)) state.watchlist.unshift(s);
    }
    save('watchlist', state.watchlist);
    renderWatchlist();
    await seedTicks(res.symbols);
    if (res.symbols[0]) selectSymbol(res.symbols[0]);
    $('importTitle').textContent = res.symbols.length ? 'Import finished' : 'Nothing was imported';
    $('importText').textContent =
      `${res.bars.toLocaleString()} rows from ${files.length - res.skipped.length} files in ${Math.round((Date.now() - started) / 1000)}s` +
      (res.symbols.length ? `\nAdded to the watchlist: ${res.symbols.map((s) => s.slice(4)).join(', ')}` : '') +
      (res.skipped.length ? `\n\nSkipped ${res.skipped.length}:\n${res.skipped.slice(0, 20).join('\n')}` : '');
  } catch (e) {
    $('importTitle').textContent = 'Import failed';
    $('importText').textContent = (e as Error).message;
  }
  $('importClose').classList.remove('hidden');
}
$('importFolderBtn').addEventListener('click', () => $('csvFolder').click());
$('importFilesBtn').addEventListener('click', () => $('csvFiles').click());
$('csvFolder').addEventListener('change', (e) => void runImport(e.target as HTMLInputElement));
$('csvFiles').addEventListener('change', (e) => void runImport(e.target as HTMLInputElement));
$('importClose').addEventListener('click', () => $('importModal').classList.add('hidden'));

// ------------------------------------------------------ watchlist panel size

const SIDE_MIN = 220;
const SIDE_MAX = 640;

function applySide() {
  $('app').classList.toggle('side-hidden', !state.sideOpen);
  $('app').style.setProperty('--side-w', `${state.sideWidth}px`);
  $('sideBtn').classList.toggle('on', state.sideOpen);
}

function toggleSide() {
  state.sideOpen = !state.sideOpen;
  save('sideOpen', state.sideOpen);
  applySide();
}
$('sideBtn').addEventListener('click', toggleSide);
$('sideHideBtn').addEventListener('click', toggleSide);

const grip = $('sideGrip');
let resizing = false;
grip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  resizing = true;
  grip.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
});
grip.addEventListener('pointermove', (e) => {
  if (!resizing) return;
  // the panel is anchored to the right edge, so its width is the distance from the pointer to that edge
  state.sideWidth = Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, window.innerWidth * 0.6, window.innerWidth - e.clientX)));
  applySide();
});
const endResize = () => {
  resizing = false;
  document.body.classList.remove('resizing');
  save('sideWidth', state.sideWidth);
};
grip.addEventListener('pointerup', endResize);
grip.addEventListener('pointercancel', endResize);
grip.addEventListener('dblclick', () => {
  state.sideWidth = 320;
  applySide();
  endResize();
});

// -------------------------------------------------------------- user scripts

const editor = new ScriptEditor($('scriptPanel'), {
  runner,
  scripts: () => scripts,
  saved(changedId) {
    saveScripts(scripts);
    if (changedId) for (const p of panes) if (p.state.scripts.some((s) => s.scriptId === changedId)) p.syncScripts();
    renderTopbar();
  },
  deleted(id) {
    saveScripts(scripts);
    panes.forEach((p) => p.removeScriptsOf(id));
    host.changed();
  },
  addToChart: (id) => active().addScript(id),
  activeBars: () => ({ bars: active().view.bars, tf: active().state.tf }),
  dark: () => state.dark,
});

function openScriptEditor(scriptId?: string) {
  state.tab = 'scripts';
  state.bottomOpen = true;
  save('tab', state.tab);
  save('bottomOpen', true);
  renderTabs();
  void editor.show(scriptId);
}

// -------------------------------------------------------------- bottom panel

const tabOpts = { importance: 'medium', period: '1D', moverType: 'All' };
let tabSeq = 0;

function renderTabs() {
  $('bottom').classList.toggle('collapsed', !state.bottomOpen);
  // the script editor needs more room than the data tabs, and keeps its own DOM between visits
  const editing = state.tab === 'scripts';
  $('bottom').classList.toggle('tall', editing);
  $('tabBody').classList.toggle('hidden', editing);
  $('scriptPanel').classList.toggle('hidden', !editing);
  document.querySelectorAll<HTMLElement>('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const group = (key: keyof typeof tabOpts, opts: [string, string][]) =>
    opts.map(([v, label]) => `<button data-opt="${key}" data-val="${v}" class="${tabOpts[key] === v ? 'active' : ''}">${label}</button>`).join('');
  $('tabControls').innerHTML = !state.bottomOpen
    ? ''
    : state.tab === 'calendar'
      ? group('importance', [['', 'All'], ['medium', 'Medium+'], ['high', 'High']])
      : state.tab === 'movers'
        ? group('moverType', SYMBOL_TYPES.map((t) => [t, t])) + '<div class="sep"></div>' + group('period', ['1H', '4H', '1D', '1W'].map((p) => [p, p]))
        : '';
}

async function loadTab(showLoading = true) {
  if (!state.bottomOpen) return;
  if (state.tab === 'scripts') return void editor.show();
  const seq = ++tabSeq;
  const body = $('tabBody');
  if (showLoading) body.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    let html: string;
    if (state.tab === 'calendar') html = calendarHtml(await fetchCalendar(tabOpts.importance));
    else if (state.tab === 'news') html = newsHtml(await fetchNews());
    else {
      const type = tabOpts.moverType === 'All' ? undefined : tabOpts.moverType;
      const [g, l] = await Promise.all([fetchMovers('gainers', tabOpts.period, type), fetchMovers('losers', tabOpts.period, type)]);
      html = `<div class="movers">${moversHtml('Top gainers', g)}${moversHtml('Top losers', l)}</div>`;
    }
    if (seq === tabSeq) body.innerHTML = html;
  } catch (e) {
    if (seq === tabSeq) body.innerHTML = `<div class="empty">Couldn't load: ${esc((e as Error).message)}</div>`;
  }
}

const flag = (cc: string) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');

function calendarHtml(events: Awaited<ReturnType<typeof fetchCalendar>>) {
  if (!events.length) return `<div class="empty">No upcoming releases</div>`;
  const val = (v: number | null, digits = 2) => (v === null || v === undefined ? '<span class="muted">—</span>' : v.toLocaleString('en-US', { maximumFractionDigits: Math.max(digits, 0) }));
  let day = '';
  let rows = '';
  for (const ev of events) {
    const d = new Date(ev.time);
    const label = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: state.tz });
    if (label !== day) {
      day = label;
      rows += `<tr class="day"><td colspan="7">${esc(label)}</td></tr>`;
    }
    rows +=
      `<tr><td class="num">${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: state.tz })}</td>` +
      `<td>${flag(ev.countryCode)} ${esc(ev.currency)}</td><td><span class="imp ${esc(ev.importance)}"><i></i><i></i><i></i></span></td>` +
      `<td class="wrap">${esc(ev.name)}</td><td class="r num">${val(ev.actual, ev.digits)}</td><td class="r num">${val(ev.forecast, ev.digits)}</td><td class="r num">${val(ev.previous, ev.digits)}</td></tr>`;
  }
  return `<table class="grid"><thead><tr><th>Time</th><th>Currency</th><th>Impact</th><th>Event</th><th class="r">Actual</th><th class="r">Forecast</th><th class="r">Previous</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function ago(iso: string) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(m)) return '';
  if (m < 60) return `${Math.max(m, 1)}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function newsHtml(items: Awaited<ReturnType<typeof fetchNews>>) {
  if (!items.length) return `<div class="empty">No news right now</div>`;
  return `<div class="news">${items
    .filter((n) => /^https?:\/\//.test(n.url))
    .map((n) => `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}<small>${esc(n.publisher)} · ${ago(n.publishedDate)}</small></a>`)
    .join('')}</div>`;
}

function moversHtml(title: string, list: Awaited<ReturnType<typeof fetchMovers>>) {
  const rows = list
    .map((m) => {
      const d = Math.abs(m.lastPrice) >= 10 ? 2 : Math.abs(m.lastPrice) >= 1 ? 4 : 6;
      return `<button class="mv-row" data-symbol="${esc(m.symbol)}"><span><b>${esc(m.symbol)}</b><span class="muted">${esc(m.name)}</span></span><span class="num">${fmt(m.lastPrice, d)}</span><span class="r num ${cls(m.changePercent)}">${pct(m.changePercent)}</span></button>`;
    })
    .join('');
  return `<div><h4>${title}</h4>${rows || '<div class="empty">Nothing to show</div>'}</div>`;
}

$('tabs').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  if (btn.id === 'collapseBtn') state.bottomOpen = !state.bottomOpen;
  else if (btn.dataset.tab) {
    state.bottomOpen = true;
    state.tab = btn.dataset.tab as typeof state.tab;
  } else if (btn.dataset.opt) tabOpts[btn.dataset.opt as keyof typeof tabOpts] = btn.dataset.val ?? '';
  else return;
  save('tab', state.tab);
  save('bottomOpen', state.bottomOpen);
  renderTabs();
  void loadTab();
});
$('tabBody').addEventListener('click', (e) => {
  const symbol = (e.target as HTMLElement).closest<HTMLElement>('.mv-row')?.dataset.symbol;
  if (symbol) selectSymbol(symbol);
});
window.setInterval(() => {
  if (!document.hidden) void loadTab(false);
}, 60000);

// ---------------------------------------------------------------------- boot

// bars drift out of date while the tab sleeps; refetch after a long absence
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 120000) panes.forEach((p) => !p.replaying && void p.load());
});

document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
renderTools('cursor');
applySide();
applyLayout(state.layout);
renderWatchlist();
renderTabs();
renderTz();
void seedTicks(allSymbols());
void feed.start();
void loadTab();
