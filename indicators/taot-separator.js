// TAOT separator
// Shades each trading session with a box spanning its high and low, and optionally
// colours every 15-minute block (for the 1m strategy).

indicator({
  name: 'TAOT separator',
  overlay: true,
  inputs: {
    showBoxes: { value: true, label: 'Show TAOT boxes' },
    showLabels: { value: true, label: 'Show session names' },
    timezone: { value: 'GMT+5', options: ['GMT+5', 'GMT-4', 'GMT-5'], label: 'Timezone' },
    loSession: { value: '1700-0315', label: 'LO session' },
    loColor: { value: '#ff0000', label: 'LO colour' },
    amSession: { value: '0200-0915', label: 'AM session' },
    amColor: { value: '#0000ff', label: 'AM colour' },
    lunchSession: { value: '0800-1215', label: 'Lunch session' },
    lunchColor: { value: '#00ff00', label: 'Lunch colour' },
    pmSession: { value: '1200-2015', label: 'PM session' },
    pmColor: { value: '#000000', label: 'PM colour' },
    showBlocks: { value: false, label: '1m strategy: 15-minute blocks' },
  },
  calc({ time, high, low, length, inputs }) {
    const boxes = [];
    const offset = { 'GMT+5': 5, 'GMT-4': -4, 'GMT-5': -5 }[inputs.timezone] * 3600;

    // "HHMM-HHMM" -> a test for whether a bar's open time falls inside the session.
    // The end is exclusive, and a session may run past midnight (e.g. 1700-0315).
    const sessionTest = (text) => {
      const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(text).trim());
      if (!m) return () => false;
      const start = +m[1] * 60 + +m[2];
      const end = +m[3] * 60 + +m[4];
      return (t) => {
        const minute = Math.floor((((t + offset) % 86400) + 86400) % 86400 / 60);
        return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
      };
    };

    // One box per unbroken run of bars inside the session, stretched to that run's high and low.
    const drawSession = (text, color, name) => {
      const inSession = sessionTest(text);
      let cur = null;
      for (let i = 0; i < length; i++) {
        if (!inSession(time[i])) {
          cur = null;
        } else if (!cur) {
          cur = { left: i, right: i, top: high[i], bottom: low[i], color, opacity: 0.1, text: inputs.showLabels ? name : '' };
          boxes.push(cur);
        } else {
          cur.right = i;
          cur.top = Math.max(cur.top, high[i]);
          cur.bottom = Math.min(cur.bottom, low[i]);
        }
      }
    };

    if (inputs.showBoxes) {
      drawSession(inputs.loSession, inputs.loColor, 'LO');
      drawSession(inputs.amSession, inputs.amColor, 'AM');
      drawSession(inputs.lunchSession, inputs.lunchColor, 'Lunch');
      drawSession(inputs.pmSession, inputs.pmColor, 'PM');
    }

    // 1m strategy: a box per 15-minute block, colours rotating red, blue, green, yellow.
    if (inputs.showBlocks) {
      const colors = ['#f23645', '#2962ff', '#4caf50', '#ffeb3b'];
      let cur = null;
      let prevBlock = null;
      for (let i = 0; i < length; i++) {
        const block = Math.floor(time[i] / 900);
        if (block !== prevBlock) {
          prevBlock = block;
          cur = { left: i, right: i, top: high[i], bottom: low[i], color: colors[block % 4], opacity: 0.15 };
          boxes.push(cur);
        } else {
          cur.right = i;
          cur.top = Math.max(cur.top, high[i]);
          cur.bottom = Math.min(cur.bottom, low[i]);
        }
      }
    }

    return boxes.map((b) => box(b));
  },
});
