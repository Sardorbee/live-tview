# LiveView

A TradingView-style charting platform that runs in the browser. Live prices and candles come from the free [biquote](https://biquote.io/docs/) market data API (forex, metals, crypto, indices, stocks); no API key or account is needed.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm run dev
```

Then open the address it prints (normally http://localhost:5173).

To make a production build and serve it locally:

```bash
npm run build
npm run preview
```

The build output goes to `dist/` and is a plain static site, so it can be hosted anywhere.

## What it does

- **Live charts**: candles update tick by tick over the biquote SignalR feed, with a countdown to the bar close.
- **Chart types**: candles, hollow, volume candles, Heikin Ashi, bars, line, area, baseline, Renko, line break, Kagi, point & figure, range bars.
- **Timeframes**: ticks and seconds up to monthly, plus custom ones such as `7m` or `6h`.
- **Layouts**: up to 8 charts, with optional sync of symbol, interval, crosshair and time range.
- **Tools**: trend line, ray, horizontal/vertical line, rectangle, Fibonacci retracement, measure, long/short position. Drawings can be moved and reshaped.
- **Compare** symbols, log / percent / indexed price scales, bar replay, timezone selector.
- **Watchlist**, economic calendar, news and top movers.
- **CSV import**: load your own history (see below).
- **Your own indicators** in JavaScript (see below).

## TradingView symbols

Symbols can also come from TradingView's public data socket (the same approach as [Tradingview-ticker](https://github.com/Hattorius/Tradingview-ticker)), with no account. In symbol search, pick the **TradingView** chip or type `EXCHANGE:TICKER`, for example `BINANCE:BTCUSDT`, `OANDA:XAUUSD` or `NASDAQ:AAPL`. They show up as `TV:<EXCHANGE>:<TICKER>` and get live quotes plus history (about 10,000 one-minute bars, more on higher timeframes).

Futures come from TradingView only: use the **Futures** chip, or type a continuous contract such as `CME_MINI:ES1!`, `COMEX:GC1!` or `NYMEX:CL1!` (`1!` is the front month, `2!` the next). CME group futures and some indices are delayed by about 10 minutes; such symbols show a **Delayed** badge on the chart and in the details panel, and a small **D** next to the price in the watchlist. Bar replay works on TradingView symbols too, over the bars that are loaded.

Signed-out access has limits: some exchanges are delayed, seconds and tick charts build up from the live feed only, and TradingView's own symbol search can't be called from another site, so search only knows a short list of popular symbols plus whatever you type.

TradingView only accepts this connection from `localhost` (and its own site), so it works with `npm run dev` / `npm run preview` but not on a deployed copy as is. To use it there, run a small WebSocket relay that forwards to `wss://data.tradingview.com/socket.io/websocket` with the header `Origin: https://www.tradingview.com`, and build with `VITE_TV_SOCKET=wss://your-relay/...`.

## Importing CSV history

The biquote API only keeps recent history. For deeper history, open symbol search and use **Import CSV folder**.

Files need a header row with a time column (`timestamp_ms`, `time_utc`, `time` or `date`, in UTC) plus `open`, `high`, `low`, `close`, and optionally `volume`. Names like `XAU-USD_BID_minute_2024-05.csv` are recognised (symbol, and minute / hour / day bars); otherwise the bar size is worked out from the data.

Imported data is stored in the browser (IndexedDB), shows up as `CSV:<symbol>`, and has no live feed.

## Writing indicators

Open the **Script editor** tab in the bottom panel. A script calls `indicator({ name, overlay, inputs, calc })`; `calc` receives the loaded bars as arrays and returns what to draw:

```js
indicator({
  name: 'EMA cross',
  overlay: true,
  inputs: { fast: 9, slow: 21 },
  calc({ close, inputs, ta }) {
    const fast = ta.ema(close, inputs.fast);
    const slow = ta.ema(close, inputs.slow);
    return {
      fast: plot(fast, { color: '#2962ff' }),
      slow: plot(slow, { color: '#ff6d00' }),
      up: marker(ta.crossover(fast, slow), { shape: 'arrowUp', color: '#089981' }),
    };
  },
});
```

Available outputs are `plot()`, `marker()`, `hline()` and `box()`. Five scripts are included (Fair Value Gaps, IFVG, CRT & Killzones, TAOT separator, Macro ICT); the last four live in `indicators/` and are good starting points. The template you get from **+ New** lists every helper.

## Good to know

- Settings, watchlist, drawings, scripts and imported data are saved in your browser only; there are no accounts.
- Quotes are broker (MetaTrader 5) feeds relayed by biquote, not official exchange data.
- Charts are drawn with [Lightweight Charts](https://github.com/tradingview/lightweight-charts) by TradingView.
