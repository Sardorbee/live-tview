// Macro ICT
// Boxes the "macro" window around each hour change: it opens on the first bar at or after xx:50
// and closes on the first bar after xx:10. The box spans the window's high and low, is coloured by
// the session the new hour belongs to, and stays open to the right edge until the window closes.
//   Asia 20:00-00:00, London 02:00-05:00, New York 07:00-11:00 (clock time in the chosen timezone)

indicator({
  name: 'Macro ICT',
  overlay: true,
  inputs: {
    showNonSession: { value: true, label: 'Show non-session boxes' },
    timezone: { value: 'New York', options: ['New York', 'UTC'], label: 'Clock used for the hours' },
    asiaColor: { value: '#ffeb3b', label: 'Asia' },
    londonColor: { value: '#2962ff', label: 'London' },
    nyColor: { value: '#4caf50', label: 'New York' },
    nonSessionColor: { value: '#787b86', label: 'Non-session' },
  },
  calc({ time, high, low, length, inputs }) {
    // Minutes to add to UTC to get the chosen clock. Looked up once per hour, so daylight saving is
    // followed without doing a timezone conversion on every bar.
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: 'numeric', minute: 'numeric' });
    const offsets = new Map();
    const offsetAt = (t) => {
      if (inputs.timezone === 'UTC') return 0;
      const hourStart = Math.floor(t / 3600) * 3600;
      let off = offsets.get(hourStart);
      if (off === undefined) {
        const parts = {};
        for (const p of fmt.formatToParts(new Date(hourStart * 1000))) parts[p.type] = Number(p.value);
        off = parts.hour * 60 + parts.minute - (Math.floor(hourStart / 60) % 1440);
        offsets.set(hourStart, off);
      }
      return off;
    };

    const sessionOf = (h) => (h >= 20 || h === 0 ? 'Asia' : h >= 2 && h < 5 ? 'London' : h >= 7 && h < 11 ? 'New York' : 'non-session');
    const colors = { Asia: inputs.asiaColor, London: inputs.londonColor, 'New York': inputs.nyColor, 'non-session': inputs.nonSessionColor };

    const boxes = [];
    let inWindow = false;
    let cur = null; // the box being built; null when this window is not drawn

    for (let i = 0; i < length; i++) {
      const clock = (((Math.floor(time[i] / 60) + offsetAt(time[i])) % 1440) + 1440) % 1440;
      const barHour = Math.floor(clock / 60);
      const barMin = clock % 60;
      const closeWindow = inWindow && barMin > 10 && barMin < 50;

      if (barMin >= 50 && !inWindow) {
        // the window runs xx:50 -> (xx+1):10, so it belongs to the session of the next hour
        const session = sessionOf((barHour + 1) % 24);
        inWindow = true;
        cur = null;
        if (session !== 'non-session' || inputs.showNonSession) {
          cur = { left: i, right: null, top: high[i], bottom: low[i], color: colors[session], opacity: 0.25, text: session === 'non-session' ? '' : session };
          boxes.push(cur);
        }
      } else if (inWindow) {
        if (cur) {
          cur.top = Math.max(cur.top, high[i]);
          cur.bottom = Math.min(cur.bottom, low[i]);
        }
        if (closeWindow) {
          // the closing bar is part of the box; after it the box stops extending
          if (cur) cur.right = i;
          inWindow = false;
          cur = null;
        }
      }
    }

    return boxes.map((b) => box(b));
  },
});
