// options-journey.js — the Journey tab: stat tiles and a 30-day chart drawn
// as inline SVG (no libraries). Uses globals from options.js (settings,
// escapeHtml, SH).

(function () {
  const COLORS = { held: '#ad8a1f', slip: '#c25050' }; // validated on the dark surface
  let stats = null;

  async function loadStats() {
    const s = await chrome.storage.local.get(['stats']);
    stats = s.stats || SH.emptyStats(Date.now());
    render();
  }

  function tile(label, value, sub) {
    return `<div class="tile"><p class="tile-label">${escapeHtml(label)}</p><p class="tile-value">${escapeHtml(value)}</p>${sub ? `<p class="tile-sub">${escapeHtml(sub)}</p>` : ''}</div>`;
  }

  function hoursText(minutes) {
    if (minutes < 60) return `${minutes} min`;
    const h = minutes / 60;
    return `${h >= 10 ? Math.round(h) : h.toFixed(1)} h`;
  }

  function render() {
    if (!stats) return;
    const now = Date.now();
    const sum = SH.summarizeStats(stats, now, settings);

    document.getElementById('journeyTiles').innerHTML = [
      tile('Gates held today', String(sum.today.held), sum.today.slips ? `${sum.today.slips} slip${sum.today.slips === 1 ? '' : 's'} today` : 'No slips today'),
      tile('Clean streak', `${sum.streak} ${sum.streak === 1 ? 'day' : 'days'}`, `Best: ${sum.bestStreak} ${sum.bestStreak === 1 ? 'day' : 'days'}`),
      tile('Time reclaimed', hoursText(sum.minutesReclaimed), `Estimate · ${sum.totalHeld} gates held in 90 days`),
      tile('Turned back at Pause & Think', sum.walkAwayRate == null ? '—' : `${sum.walkAwayRate}%`, 'of the times the gate appeared')
    ].join('');

    renderChart(sum.series);
    renderTable(sum.series);
  }

  function renderChart(series) {
    const el = document.getElementById('journeyChart');
    const W = 720;
    const H = 200;
    const pad = { top: 12, right: 8, bottom: 26, left: 30 };
    const innerW = W - pad.left - pad.right;
    const innerH = H - pad.top - pad.bottom;
    const max = Math.max(4, ...series.map((d) => d.held + d.slips));
    const step = Math.ceil(max / 4);
    const top = step * 4;
    const band = innerW / series.length;
    const barW = Math.min(16, band - 4);
    const y = (v) => pad.top + innerH - (v / top) * innerH;

    let grid = '';
    for (let v = 0; v <= top; v += step) {
      grid += `<line x1="${pad.left}" x2="${W - pad.right}" y1="${y(v)}" y2="${y(v)}" class="grid" />`;
      grid += `<text x="${pad.left - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}</text>`;
    }

    // Column with a 4px rounded data-end, square at the baseline.
    const column = (x, y0, y1, color, roundTop) => {
      const h = y0 - y1;
      if (h <= 0) return '';
      const r = roundTop ? Math.min(4, h, barW / 2) : 0;
      return `<path d="M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + barW - r} Q${x + barW},${y1} ${x + barW},${y1 + r} V${y0} Z" fill="${color}" />`;
    };

    let bars = '';
    let labels = '';
    series.forEach((d, i) => {
      const x = pad.left + i * band + (band - barW) / 2;
      const base = y(0);
      const heldTop = y(d.held);
      const gap = d.held && d.slips ? 2 : 0;
      bars += column(x, base, heldTop, COLORS.held, !d.slips);
      bars += column(x, heldTop - gap, y(d.held + d.slips) - gap, COLORS.slip, true);
      bars += `<rect x="${pad.left + i * band}" y="${pad.top}" width="${band}" height="${innerH}" class="hit" data-i="${i}" />`;
      if (i % 5 === 4 || i === series.length - 1) {
        const date = new Date(d.key + 'T12:00:00');
        labels += `<text x="${x + barW / 2}" y="${H - 8}" class="axis" text-anchor="middle">${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</text>`;
      }
    });

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gates held and slips per day for the last 30 days">${grid}${bars}${labels}</svg>`;

    const tip = document.getElementById('chartTip');
    el.querySelectorAll('.hit').forEach((rect) => {
      rect.addEventListener('mouseenter', () => {
        const d = series[Number(rect.dataset.i)];
        const date = new Date(d.key + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        tip.innerHTML = `<strong>${escapeHtml(date)}</strong><span><i class="swatch swatch-held"></i>${d.held} held</span><span><i class="swatch swatch-slip"></i>${d.slips} slips</span>`;
        tip.hidden = false;
        const box = el.getBoundingClientRect();
        const r = rect.getBoundingClientRect();
        const left = Math.min(Math.max(r.left - box.left + r.width / 2, 70), box.width - 70);
        tip.style.left = `${left}px`;
        rect.classList.add('is-hover');
      });
      rect.addEventListener('mouseleave', () => {
        tip.hidden = true;
        rect.classList.remove('is-hover');
      });
    });
  }

  function renderTable(series) {
    const rows = [...series].reverse().map((d) => `<tr><td>${escapeHtml(d.key)}</td><td>${d.held}</td><td>${d.slips}</td></tr>`).join('');
    document.getElementById('journeyTable').innerHTML = `<table><thead><tr><th>Day</th><th>Gates held</th><th>Slips</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.stats) {
      stats = changes.stats.newValue;
      render();
    }
  });
  document.addEventListener('gohh:data', render);
  loadStats();
})();
