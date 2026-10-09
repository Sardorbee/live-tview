// IFVG — inversion fair value gaps
// A fair value gap that price closes straight through "inverts": a bullish gap becomes resistance,
// a bearish gap becomes support. Each inversion is drawn in two parts: the original gap up to the
// bar that broke it, then the inverted zone from there to the right edge, with a midline.
// An arrow marks a bar that pushes back out of an inverted zone in its new direction.
// An inversion disappears once a candle body goes through its far side.

indicator({
  name: 'IFVG',
  overlay: true,
  inputs: {
    maxGaps: { value: 100, min: 1, step: 1, label: 'Maximum gaps shown' },
    signal: { value: 'Close', options: ['Close', 'Wick'], label: 'Signal preference' },
    bullColor: { value: '#089981', label: 'Bull colour' },
    bearColor: { value: '#f23645', label: 'Bear colour' },
    midColor: { value: '#787b86', label: 'Midline colour' },
  },
  calc({ open, high, low, close, length, inputs }) {
    const BUFFER = 1000; // gaps / inversions tracked per side; the oldest are forgotten beyond this
    const wick = inputs.signal === 'Wick';

    const bullFvg = [];
    const bearFvg = [];
    const bullInv = []; // inverted bullish gaps (now bearish zones)
    const bearInv = []; // inverted bearish gaps (now bullish zones)

    // A gap inverts when a candle body passes its far side.
    const manageGaps = (gaps, inversions, i, bodyTop, bodyBottom) => {
      if (gaps.length >= BUFFER) gaps.shift();
      for (let k = gaps.length - 1; k >= 0; k--) {
        const g = gaps[k];
        if ((g.dir === 1 && bodyBottom < g.bottom) || (g.dir === -1 && bodyTop > g.top)) {
          g.inverted = i;
          inversions.push(gaps.splice(k, 1)[0]);
        }
      }
    };

    const manageInversions = (inversions, i, bodyTop, bodyBottom) => {
      if (inversions.length >= BUFFER) inversions.shift();
      for (let k = inversions.length - 1; k >= 0; k--) {
        const g = inversions[k];
        if (g.state === 0) {
          // first bar as an inversion: flip its direction; signals start from the next bar
          g.state = 1;
          g.dir = -g.dir;
          continue;
        }
        // signal: price was inside the zone (previous close, or this bar's wick) and closes out of it
        const ref = wick ? (g.dir === -1 ? high[i] : low[i]) : close[i - 1];
        if (g.dir === -1 && close[i] < g.bottom && ref >= g.bottom && ref < g.top) g.signals.push({ i, dir: -1 });
        if (g.dir === 1 && close[i] > g.top && ref <= g.top && ref > g.bottom) g.signals.push({ i, dir: 1 });
        // invalidated: a body through the far side
        if ((g.dir === -1 && bodyTop > g.top) || (g.dir === 1 && bodyBottom < g.bottom)) inversions.splice(k, 1);
      }
    };

    for (let i = 0; i < length; i++) {
      if (i >= 2) {
        const up = low[i] > high[i - 2] && close[i - 1] > high[i - 2];
        const down = high[i] < low[i - 2] && close[i - 1] < low[i - 2];
        if (up) {
          bullFvg.push({ left: i - 1, top: low[i], bottom: high[i - 2], dir: 1, state: 0, signals: [], inverted: null });
        }
        if (down) {
          bearFvg.push({ left: i - 1, top: low[i - 2], bottom: high[i], dir: -1, state: 0, signals: [], inverted: null });
        }
      }

      const bodyTop = Math.max(open[i], close[i]);
      const bodyBottom = Math.min(open[i], close[i]);
      manageGaps(bullFvg, bullInv, i, bodyTop, bodyBottom);
      manageGaps(bearFvg, bearInv, i, bodyTop, bodyBottom);
      manageInversions(bullInv, i, bodyTop, bodyBottom);
      manageInversions(bearInv, i, bodyTop, bodyBottom);
    }

    const out = [];
    const up = new Array(length).fill(false);
    const down = new Array(length).fill(false);
    // the most recent inversions, bullish and bearish counted together
    const shown = [...bullInv, ...bearInv].sort((a, b) => a.inverted - b.inverted).slice(-inputs.maxGaps);
    for (const g of shown) {
      // dir -1 means a bullish gap that turned bearish: original part in the bull colour, inverted part in the bear colour
      const original = g.dir === -1 ? inputs.bullColor : inputs.bearColor;
      const inverted = g.dir === -1 ? inputs.bearColor : inputs.bullColor;
      out.push(box({ left: g.left, right: g.inverted, top: g.top, bottom: g.bottom, color: original, opacity: 0.2 }));
      out.push(box({ left: g.inverted, right: null, top: g.top, bottom: g.bottom, color: inverted, opacity: 0.2 }));
      const mid = (g.top + g.bottom) / 2;
      out.push(box({ left: g.left, right: null, top: mid, bottom: mid, color: inputs.midColor, opacity: 0.3 }));
      for (const s of g.signals) (s.dir === 1 ? up : down)[s.i] = true;
    }
    out.push(marker(up, { shape: 'arrowUp', position: 'belowBar', color: inputs.bullColor }));
    out.push(marker(down, { shape: 'arrowDown', position: 'aboveBar', color: inputs.bearColor }));
    return out;
  },
});
