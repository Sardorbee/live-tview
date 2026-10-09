// CRT & Killzones
// Three tools in one:
//   1. CRT (candle range theory): marks a candle that sweeps the previous candle's high or low
//      and closes back inside it.
//   2. Two moving averages with their crosses, optionally filtered by the daily long MA.
//   3. Sessions: the New York midnight open line, a daily separator, killzone boxes, and the
//      open price of the day / week / month.
// Horizontal and vertical lines are drawn as hair-thin boxes, which is the only line a script has.

indicator({
  name: 'CRT & Killzones',
  overlay: true,
  inputs: {
    enableCRT: { value: true, label: 'CRT: enable finder' },
    showRealTime: { value: true, label: 'CRT: include the unfinished bar' },

    enableMA: { value: true, label: 'MA: enable moving averages' },
    shortLen: { value: 20, min: 1, step: 1, label: 'MA: short length' },
    longLen: { value: 60, min: 1, step: 1, label: 'MA: long length' },
    maType: { value: 'SMA', options: ['SMA', 'EMA', 'WMA', 'VWMA'], label: 'MA: type' },
    enableBias: { value: false, label: 'MA: daily bias filter' },

    timezone: { value: 'GMT-4', options: ['GMT-4', 'GMT-5', 'UTC', 'GMT+5'], label: 'Sessions: timezone' },
    daySeparator: { value: true, label: 'Sessions: daily separator' },
    separatorColor: { value: '#00b9d0', label: 'Sessions: separator colour' },
    midnightLine: { value: true, label: 'Sessions: NY midnight open line' },
    midnightColor: { value: '#0064ff', label: 'Sessions: midnight line colour' },
    extend: { value: '1 Day', options: ['1 Day', '2 Days', 'Right'], label: 'Sessions: midnight line length' },
    useHours: { value: false, label: 'Sessions: use a length in hours instead' },
    hours: { value: 3, min: 1, max: 23, step: 1, label: 'Sessions: hours' },

    showAsian: { value: true, label: 'Killzone: Asian' },
    asianSession: { value: '2000-0000', label: 'Killzone: Asian hours' },
    asianColor: { value: '#e91e63', label: 'Killzone: Asian colour' },
    showLondon: { value: true, label: 'Killzone: London' },
    londonSession: { value: '0200-0500', label: 'Killzone: London hours' },
    londonColor: { value: '#00bcd4', label: 'Killzone: London colour' },
    showNyAm: { value: true, label: 'Killzone: New York AM' },
    nyAmSession: { value: '0830-1100', label: 'Killzone: New York AM hours' },
    nyAmColor: { value: '#ff5d00', label: 'Killzone: New York AM colour' },
    showNyPm: { value: true, label: 'Killzone: New York PM' },
    nyPmSession: { value: '1330-1600', label: 'Killzone: New York PM hours' },
    nyPmColor: { value: '#2157f3', label: 'Killzone: New York PM colour' },
    kzLines: { value: false, label: 'Killzone: top / bottom lines' },
    kzMean: { value: false, label: 'Killzone: mean line' },
    kzExtend: { value: true, label: 'Killzone: extend lines until price returns' },
    kzLabels: { value: true, label: 'Killzone: labels' },
    kzMaxTf: { value: '60', options: ['1', '3', '5', '15', '30', '45', '60', '360'], label: 'Killzone: show up to timeframe (minutes)' },

    openOf: { value: 'None', options: ['Killzones', 'the Day', 'the Week', 'the Month', 'None'], label: 'Open price of' },
    openSeparator: { value: true, label: 'Open price: separator' },
    openColor: { value: '#787b86', label: 'Open price: colour' },
    openLabel: { value: true, label: 'Open price: label' },
  },

  calc({ time, open, high, low, close, volume, length, tf, inputs }) {
    const out = [];
    if (!length) return out;
    const last = length - 1;

    // ---- helpers ----------------------------------------------------------------
    const offset = { 'GMT-4': -4, 'GMT-5': -5, UTC: 0, 'GMT+5': 5 }[inputs.timezone] * 3600;
    const local = (i) => time[i] + offset; // seconds on the session clock
    const dayOf = (i) => Math.floor(local(i) / 86400);

    // chart timeframe: bar length in seconds, and in minutes for the "show up to" limit
    const tfm = /^(\d+)([Tsmhdw M])$/.exec(tf || '') || [];
    const barSec = Number(tfm[1] || 1) * ({ T: 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800, M: 2592000 }[tfm[2]] || 60);
    const intraday = barSec < 86400;
    const showKz = intraday && barSec / 60 <= Number(inputs.kzMaxTf);

    // prices in labels use as many decimals as the data has
    let decimals = 0;
    for (let i = Math.max(0, length - 50); i < length; i++) decimals = Math.max(decimals, (String(close[i]).split('.')[1] || '').length);
    const price = (p) => p.toFixed(Math.min(decimals, 8));

    let top = -Infinity;
    let bottom = Infinity;
    for (let i = 0; i < length; i++) {
      if (high[i] > top) top = high[i];
      if (low[i] < bottom) bottom = low[i];
    }
    const hLine = (left, right, p, color, text) => box({ left, right, top: p, bottom: p, color, opacity: 0.4, text: text || '' });
    const vLine = (i, color) => box({ left: i, right: i, top: top * 10, bottom: bottom / 10, color, opacity: 0.3 });

    // moving average of any series; Pine-style seeding so values match TradingView closely
    const ma = (src, vol, len, type) => {
      const n = src.length;
      const res = new Array(n).fill(NaN);
      if (type === 'EMA') {
        const k = 2 / (len + 1);
        let prev = NaN;
        for (let i = 0; i < n; i++) res[i] = prev = Number.isNaN(prev) ? src[i] : src[i] * k + prev * (1 - k);
        return res;
      }
      for (let i = len - 1; i < n; i++) {
        let sum = 0;
        let weight = 0;
        for (let j = 0; j < len; j++) {
          const w = type === 'WMA' ? len - j : type === 'VWMA' ? vol[i - j] : 1;
          sum += src[i - j] * w;
          weight += w;
        }
        // with no volume a VWMA is undefined, so fall back to the plain average
        if (weight > 0) res[i] = sum / weight;
        else {
          let s = 0;
          for (let j = 0; j < len; j++) s += src[i - j];
          res[i] = s / len;
        }
      }
      return res;
    };

    // "HHMM-HHMM" -> test on the session clock; end exclusive, may run past midnight
    const sessionTest = (text) => {
      const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(text).trim());
      if (!m) return () => false;
      const start = +m[1] * 60 + +m[2];
      const end = +m[3] * 60 + +m[4];
      return (i) => {
        const minute = Math.floor(((local(i) % 86400) + 86400) % 86400 / 60);
        return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
      };
    };

    // ---- 1. CRT -----------------------------------------------------------------
    if (inputs.enableCRT) {
      const sweepHigh = new Array(length).fill(false);
      const sweepLow = new Array(length).fill(false);
      const end = inputs.showRealTime ? length : last; // otherwise wait for the bar to finish
      for (let i = 1; i < end; i++) {
        sweepHigh[i] = high[i - 1] < high[i] && close[i] < high[i - 1];
        sweepLow[i] = low[i - 1] > low[i] && close[i] > low[i - 1];
      }
      out.push(marker(sweepLow, { shape: 'arrowUp', position: 'belowBar', color: '#4caf50' }));
      out.push(marker(sweepHigh, { shape: 'arrowDown', position: 'aboveBar', color: '#f23645' }));
    }

    // ---- 2. Moving averages -------------------------------------------------------
    if (inputs.enableMA) {
      const shortMa = ma(close, volume, inputs.shortLen, inputs.maType);
      const longMa = ma(close, volume, inputs.longLen, inputs.maType);

      // Daily bias: the long MA on daily closes. Each bar sees the value as of the previous
      // finished day, as a higher-timeframe request without lookahead does.
      let dailyLong = null;
      if (inputs.enableBias) {
        const dayClose = [];
        const dayVol = [];
        const dayIndex = new Array(length);
        for (let i = 0; i < length; i++) {
          if (i === 0 || dayOf(i) !== dayOf(i - 1)) {
            dayClose.push(close[i]);
            dayVol.push(0);
          }
          dayClose[dayClose.length - 1] = close[i];
          dayVol[dayVol.length - 1] += volume[i];
          dayIndex[i] = dayClose.length - 1;
        }
        const dma = ma(dayClose, dayVol, inputs.longLen, inputs.maType);
        dailyLong = dayIndex.map((d) => (d > 0 ? dma[d - 1] : NaN));
      }

      const crossUp = new Array(length).fill(false);
      const crossDown = new Array(length).fill(false);
      for (let i = 1; i < length; i++) {
        const up = shortMa[i] > longMa[i] && shortMa[i - 1] <= longMa[i - 1];
        const down = shortMa[i] < longMa[i] && shortMa[i - 1] >= longMa[i - 1];
        crossUp[i] = up && (!dailyLong || close[i] > dailyLong[i]);
        crossDown[i] = down && (!dailyLong || close[i] < dailyLong[i]);
      }
      out.push(plot(shortMa, { color: '#ff6d00', width: 1, title: 'Short MA' }));
      out.push(plot(longMa, { color: '#43a047', width: 1, title: 'Long MA' }));
      out.push(marker(crossUp, { shape: 'circle', position: 'inBar', color: '#2962ff' }));
      out.push(marker(crossDown, { shape: 'circle', position: 'inBar', color: '#ff1744' }));
    }

    // ---- 3a. New York midnight open and daily separator -----------------------------
    // the bar that contains 00:00 on the session clock (intraday charts only: on daily bars every bar would qualify)
    const midnights = [];
    for (let i = 0; intraday && i < length; i++) {
      const sec = ((local(i) % 86400) + 86400) % 86400;
      if (sec === 0 || sec + barSec > 86400) midnights.push(i);
    }
    if (inputs.daySeparator) for (const i of midnights) out.push(vLine(i, inputs.separatorColor));
    if (inputs.midnightLine) {
      const span = inputs.useHours ? inputs.hours * 3600 : inputs.extend === '2 Days' ? 172800 : 86400;
      midnights.forEach((i, k) => {
        const next = midnights[k + 1];
        if (next !== undefined) return out.push(hLine(i, next, open[i], inputs.midnightColor));
        // the newest line runs for the chosen length, or to the right edge if that is still ahead
        let right = null;
        if (inputs.extend !== 'Right' || inputs.useHours) {
          for (let j = i; j < length; j++) {
            if (time[j] >= time[i] + span) {
              right = j;
              break;
            }
          }
        }
        out.push(hLine(i, right, open[i], inputs.midnightColor, 'NY Midnight Open | ' + price(open[i])));
      });
    }

    // ---- 3b. Killzones ------------------------------------------------------------
    const zones = [
      { on: inputs.showAsian, test: sessionTest(inputs.asianSession), color: inputs.asianColor, name: 'Asian' },
      { on: inputs.showLondon, test: sessionTest(inputs.londonSession), color: inputs.londonColor, name: 'London' },
      { on: inputs.showNyAm, test: sessionTest(inputs.nyAmSession), color: inputs.nyAmColor, name: 'New York AM' },
      { on: inputs.showNyPm, test: sessionTest(inputs.nyPmSession), color: inputs.nyPmColor, name: 'New York PM' },
    ].filter((z) => z.on && showKz);

    const inZone = zones.map((z) => {
      const flags = new Array(length);
      for (let i = 0; i < length; i++) flags[i] = z.test(i);
      return flags;
    });
    const inAny = (i) => inZone.some((f) => f[i]);

    zones.forEach((z, zi) => {
      const flags = inZone[zi];
      for (let i = 0; i < length; i++) {
        if (!flags[i] || (i > 0 && flags[i - 1])) continue;
        // i is the first bar of a killzone; find its last bar and its range
        let end = i;
        let max = high[i];
        let min = low[i];
        while (end + 1 < length && flags[end + 1]) {
          end++;
          max = Math.max(max, high[end]);
          min = Math.min(min, low[end]);
        }
        out.push(box({ left: i, right: end, top: max, bottom: min, color: z.color, opacity: 0.1, text: inputs.kzLabels ? z.name : '' }));

        // a line keeps running after the killzone until price trades back through it,
        // or until the next killzone starts
        const runTo = (level, isTop) => {
          if (!inputs.kzExtend) return end;
          for (let j = end + 1; j < length; j++) {
            if (inAny(j)) return j;
            if (level === null) continue;
            if (isTop ? high[j] >= level : low[j] <= level) return j;
          }
          return null;
        };
        if (inputs.kzLines) {
          out.push(hLine(i, runTo(max, true), max, z.color));
          out.push(hLine(i, runTo(min, false), min, z.color));
        }
        if (inputs.kzMean) out.push(hLine(i, runTo(null, false), (max + min) / 2, z.color));
        if (inputs.openOf === 'Killzones') out.push(hLine(i, end, open[i], inputs.openColor, inputs.openLabel ? 'KZO(' + price(open[i]) + ')' : ''));
      }
    });

    // ---- 3c. Open price of the day / week / month ------------------------------------
    const period = { 'the Day': ['DO', dayOf], 'the Week': ['WO', (i) => Math.floor((dayOf(i) + 3) / 7)], 'the Month': ['MO', (i) => { const d = new Date(local(i) * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }] }[inputs.openOf];
    if (period && showKz) {
      const [tag, key] = period;
      const starts = [];
      for (let i = 1; i < length; i++) if (key(i) !== key(i - 1)) starts.push(i);
      starts.forEach((i, k) => {
        const next = starts[k + 1];
        out.push(hLine(i, next === undefined ? last : next - 1, open[i], inputs.openColor, inputs.openLabel ? tag + '(' + price(open[i]) + ')' : ''));
        if (inputs.openSeparator) out.push(vLine(i, inputs.openColor));
      });
    }

    return out;
  },
});
