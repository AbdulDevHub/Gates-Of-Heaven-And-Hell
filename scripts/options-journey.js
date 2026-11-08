// options-journey.js — the Journey tab: tiles, a 30-day chart, a year
// calendar, a weekday × hour heatmap, the Pause & Think funnel, time on passes
// and a sortable per-rule table. All inline SVG/HTML, no libraries. Uses
// globals from options.js (settings, state, escapeHtml, LIST_LABEL, SH).
// Today's slips are never shown (one slip shouldn't invite more); they appear
// from tomorrow on.

(function () {
  const COLORS = { held: '#ad8a1f', slip: '#c25050' }; // validated on --ink-2 (dark)
  const RAMP = ['#1a222b', '#3b3318', '#5f4f1b', '#8a6f1e', '#c9a227']; // one hue, dark -> bright
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let stats = null;
  let sortKey = 'streak';
  let sortDir = -1;
  const tip = document.getElementById('hoverTip');

  async function loadStats() {
    const s = await chrome.storage.local.get(['stats']);
    stats = s.stats || SH.emptyStats(Date.now());
    render();
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

  function tile(label, value, sub, cls = '') {
    return `<div class="tile ${cls}"><p class="tile-label">${escapeHtml(label)}</p><p class="tile-value">${escapeHtml(value)}</p>${sub ? `<p class="tile-sub">${sub}</p>` : ''}</div>`;
  }

  function hoursText(minutes) {
    if (minutes < 60) return `${minutes} min`;
    const h = minutes / 60;
    return `${h >= 10 ? Math.round(h) : h.toFixed(1)} h`;
  }

  function change(now, prev, goodWhenUp) {
    if (!now && !prev) return 'Same as last week';
    const d = now - prev;
    if (!d) return 'Same as last week';
    const good = goodWhenUp ? d > 0 : d < 0;
    return `<span class="${good ? 'up-good' : 'up-bad'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d)}</span> vs last week`;
  }

  function liveRules() {
    return [
      ...state.blocked.map((rule) => ({ list: 'blocked', rule })),
      ...state.pauseAndThink.map((rule) => ({ list: 'pauseAndThink', rule }))
    ];
  }

  function render() {
    if (!stats) return;
    const now = Date.now();
    const rules = liveRules();
    const sum = SH.summarizeStats(stats, now, settings, rules);
    const todayKey = SH.dayKey(now);
    // Hide today's slips everywhere on this tab.
    const series = sum.series.map((d) => (d.key === todayKey ? Object.assign({}, d, { slips: 0, today: true }) : d));
    const year = sum.year.map((d) => (d.key === todayKey ? Object.assign({}, d, { slips: 0, today: true }) : d));
    const weekSlips = sum.week.slips - ((sum.series[sum.series.length - 1] || {}).slips || 0);

    const longest = sum.longestStreak;
    document.getElementById('journeyTiles').innerHTML = [
      tile('Gates held today', String(sum.today.held), escapeHtml(plural(sum.today.walkAways, 'turn-back')) + ' at Pause &amp; Think'),
      tile('Longest streak', longest ? plural(longest.streak, 'day') : '—', longest ? escapeHtml(longest.label) : 'Add a rule to start one'),
      tile('Rules on a streak', `${sum.rulesOnStreak} / ${rules.length}`, 'Each rule counts its own clean days'),
      tile('Held this week', String(sum.week.held), change(sum.week.held, sum.week.prevHeld, true)),
      tile('Slips this week', String(weekSlips), 'Not counting today'),
      tile('Time reclaimed', hoursText(sum.minutesReclaimed), escapeHtml(`Estimate · ${sum.totalHeld} gates held`)),
      tile('Turned back', sum.walkAwayRate == null ? '—' : `${sum.walkAwayRate}%`, 'of Pause &amp; Think gates'),
      tile('Time on passes', hoursText(sum.passMinutes), 'After going through')
    ].join('');

    renderChart(series);
    renderTable(series);
    renderFunnel(sum.funnel);
    renderYear(year);
    renderHours(sum.hours);
    renderPassTime(sum.board);
    renderBoard(sum.board, now);
  }

  // --- Floating tooltip shared by every chart ------------------------------
  function showTip(html, e) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 14;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = e.clientX + pad;
    let y = e.clientY - h - pad;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (y < 8) y = e.clientY + pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }
  function hideTip() { tip.hidden = true; }
  function bindHover(root, selector, html) {
    root.querySelectorAll(selector).forEach((node) => {
      node.addEventListener('mousemove', (e) => { showTip(html(node), e); node.classList.add('is-hover'); });
      node.addEventListener('mouseleave', () => { hideTip(); node.classList.remove('is-hover'); });
    });
  }
  const dateLabel = (key, opts) => new Date(key + 'T12:00:00').toLocaleDateString(undefined, opts || { weekday: 'short', month: 'short', day: 'numeric' });

  // --- 30-day stacked columns -----------------------------------------------
  function renderChart(series) {
    const el = document.getElementById('journeyChart');
    const W = 720;
    const H = 210;
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
        labels += `<text x="${x + barW / 2}" y="${H - 8}" class="axis" text-anchor="middle">${d.today ? 'Today' : dateLabel(d.key, { month: 'short', day: 'numeric' })}</text>`;
      }
    });

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gates held and slips per day for the last 30 days">${grid}${bars}${labels}</svg>`;
    bindHover(el, '.hit', (rect) => {
      const d = series[Number(rect.dataset.i)];
      return `<strong>${escapeHtml(d.today ? 'Today' : dateLabel(d.key))}</strong><span><i class="swatch swatch-held"></i>${d.held} held</span>${d.today ? '<span class="muted">Slips show from tomorrow</span>' : `<span><i class="swatch swatch-slip"></i>${d.slips} slips</span>`}`;
    });
  }

  function renderTable(series) {
    const rows = [...series].reverse().map((d) => `<tr><td>${escapeHtml(d.key)}</td><td>${d.held}</td><td>${d.today ? '—' : d.slips}</td></tr>`).join('');
    document.getElementById('journeyTable').innerHTML = `<table><thead><tr><th>Day</th><th>Gates held</th><th>Slips</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // --- Funnel ---------------------------------------------------------------
  function renderFunnel(f) {
    const steps = [
      ['Saw the gate', f.seen],
      ['Waited it out', f.waited],
      ['Started typing', f.typed],
      ['Went through', f.through]
    ];
    const max = Math.max(1, ...steps.map((s) => s[1]));
    const pct = (v) => (f.seen ? `${Math.round((v / f.seen) * 100)}%` : '');
    document.getElementById('journeyFunnel').innerHTML =
      steps.map(([label, v], i) => `
        <div class="funnel-row">
          <div class="funnel-label"><span>${escapeHtml(label)}</span><span class="funnel-num">${v}${i ? ` <span class="muted">${pct(v)}</span>` : ''}</span></div>
          <div class="funnel-track"><div class="funnel-bar${i === steps.length - 1 ? ' is-slip' : ''}" style="width:${(v / max) * 100}%"></div></div>
        </div>`).join('') +
      `<p class="funnel-foot">Turned back <strong>${f.walkedAway}</strong> ${f.walkedAway === 1 ? 'time' : 'times'}. Gates seen before this update only count as "seen".</p>`;
  }

  function level(v, max) {
    if (!v) return 0;
    return Math.min(4, Math.max(1, Math.ceil((v / max) * 4)));
  }

  // --- Year calendar (weeks as columns, Sun..Sat rows) ----------------------
  function renderYear(year) {
    const el = document.getElementById('journeyYear');
    const cell = 11;
    const gap = 3;
    const left = 28;
    const topPad = 16;
    const firstDow = new Date(year[0].key + 'T12:00:00').getDay();
    const weeks = Math.ceil((year.length + firstDow) / 7);
    const W = left + weeks * (cell + gap);
    const H = topPad + 7 * (cell + gap);
    const max = Math.max(1, ...year.map((d) => d.held));
    let out = '';
    let lastMonth = -1;
    year.forEach((d, i) => {
      const idx = i + firstDow;
      const col = Math.floor(idx / 7);
      const row = idx % 7;
      const x = left + col * (cell + gap);
      const yy = topPad + row * (cell + gap);
      const date = new Date(d.key + 'T12:00:00');
      if (row === 0 || i === 0) {
        const m = date.getMonth();
        if (m !== lastMonth && date.getDate() <= 7) {
          out += `<text x="${x}" y="10" class="axis">${date.toLocaleDateString(undefined, { month: 'short' })}</text>`;
          lastMonth = m;
        }
      }
      out += `<rect x="${x}" y="${yy}" width="${cell}" height="${cell}" rx="2" fill="${RAMP[level(d.held, max)]}" class="cal-cell" data-i="${i}" />`;
      if (d.slips) out += `<circle cx="${x + cell / 2}" cy="${yy + cell / 2}" r="2.2" fill="${COLORS.slip}" pointer-events="none" />`;
    });
    for (const r of [1, 3, 5]) out += `<text x="0" y="${topPad + r * (cell + gap) + 9}" class="axis">${DAY_NAMES[r]}</text>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gates held per day over the last year">${out}</svg>`;
    bindHover(el, '.cal-cell', (node) => {
      const d = year[Number(node.dataset.i)];
      return `<strong>${escapeHtml(d.today ? 'Today' : dateLabel(d.key, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}</strong><span>${d.held} held</span>${d.today ? '' : `<span>${d.slips} slips</span>`}`;
    });
  }

  // --- Weekday x hour heatmap -----------------------------------------------
  function renderHours(hours) {
    const el = document.getElementById('journeyHours');
    const cw = 15;
    const ch = 15;
    const gap = 2;
    const left = 30;
    const topPad = 4;
    const W = left + 24 * (cw + gap);
    const H = topPad + 7 * (ch + gap) + 16;
    const max = Math.max(1, ...hours.flat());
    const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first
    let out = '';
    order.forEach((dow, r) => {
      const yy = topPad + r * (ch + gap);
      out += `<text x="0" y="${yy + 11}" class="axis">${DAY_NAMES[dow]}</text>`;
      for (let h = 0; h < 24; h++) {
        const v = hours[dow][h] || 0;
        out += `<rect x="${left + h * (cw + gap)}" y="${yy}" width="${cw}" height="${ch}" rx="2" fill="${RAMP[level(v, max)]}" class="hour-cell" data-d="${dow}" data-h="${h}" />`;
      }
    });
    for (const h of [0, 6, 12, 18, 23]) {
      out += `<text x="${left + h * (cw + gap) + cw / 2}" y="${H - 2}" class="axis" text-anchor="middle">${h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`}</text>`;
    }
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gate views by weekday and hour">${out}</svg>`;
    bindHover(el, '.hour-cell', (node) => {
      const d = Number(node.dataset.d);
      const h = Number(node.dataset.h);
      const fmt = (x) => new Date(2026, 0, 1, x).toLocaleTimeString(undefined, { hour: 'numeric' });
      return `<strong>${DAY_NAMES[d]} ${fmt(h)}–${fmt((h + 1) % 24)}</strong><span>${plural(hours[d][h] || 0, 'gate view')}</span>`;
    });
  }

  // --- Time on passes (horizontal bars) -------------------------------------
  function renderPassTime(board) {
    const rows = board.filter((r) => r.passMinutes > 0).sort((a, b) => b.passMinutes - a.passMinutes).slice(0, 8);
    const el = document.getElementById('journeyPassTime');
    if (!rows.length) {
      el.innerHTML = '<p class="hint">Nothing yet. Time is added when a pass ends.</p>';
      return;
    }
    const max = rows[0].passMinutes;
    el.innerHTML = rows.map((r) => `
      <div class="bar-row">
        <span class="bar-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(r.passMinutes / max) * 100}%"></span></span>
        <span class="bar-value">${escapeHtml(hoursText(r.passMinutes))}</span>
      </div>`).join('');
  }

  // --- Sortable per-rule table ----------------------------------------------
  const COLUMNS = [
    ['label', 'Rule'],
    ['list', 'Gate'],
    ['streak', 'Streak'],
    ['bestStreak', 'Best'],
    ['lastSlipAt', 'Last slip'],
    ['views', 'Gate views'],
    ['held', 'Held'],
    ['slips', 'Slips'],
    ['walkAwayRate', 'Turned back'],
    ['passMinutes', 'Pass time']
  ];

  function renderBoard(board, now) {
    const rows = [...board].sort((a, b) => {
      let x = a[sortKey];
      let y = b[sortKey];
      if (x == null) x = sortDir > 0 ? Infinity : -Infinity;
      if (y == null) y = sortDir > 0 ? Infinity : -Infinity;
      if (typeof x === 'string') return x.localeCompare(y) * sortDir;
      return (x - y) * sortDir;
    });
    const head = COLUMNS.map(([k, label]) => `<th scope="col"><button type="button" data-sort="${k}" class="${sortKey === k ? 'is-sorted' : ''}" aria-sort="${sortKey === k ? (sortDir > 0 ? 'ascending' : 'descending') : 'none'}">${label}${sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('');
    const body = rows.length ? rows.map((r) => `
      <tr class="${r.removed ? 'is-removed' : ''}">
        <td class="board-rule">${escapeHtml(r.label)}${r.removed ? ' <span class="muted">(removed)</span>' : ''}</td>
        <td><span class="dot ${r.list === 'blocked' ? 'dot-hell' : 'dot-pause'}" aria-hidden="true"></span> ${escapeHtml(r.list ? LIST_LABEL[r.list] : '—')}</td>
        <td><strong>${plural(r.streak, 'day')}</strong></td>
        <td>${plural(r.bestStreak, 'day')}</td>
        <td>${r.lastSlipAt ? escapeHtml(SH.formatAgo(r.lastSlipAt, now)) : '<span class="muted">never</span>'}</td>
        <td>${r.views}</td>
        <td>${r.held}</td>
        <td>${r.slips}</td>
        <td>${r.walkAwayRate == null ? '—' : `${r.walkAwayRate}%`}</td>
        <td>${r.passMinutes ? escapeHtml(hoursText(r.passMinutes)) : '—'}</td>
      </tr>`).join('') : `<tr><td colspan="${COLUMNS.length}" class="muted">No Blocked or Pause &amp; Think rules yet.</td></tr>`;
    document.getElementById('journeyBoard').innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  }

  document.getElementById('journeyBoard').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sort]');
    if (!btn) return;
    const k = btn.dataset.sort;
    if (sortKey === k) sortDir = -sortDir;
    else { sortKey = k; sortDir = k === 'label' || k === 'list' ? 1 : -1; }
    render();
  });

  // Clear stats: click once to arm, again within 4 s to clear.
  const clearBox = document.querySelector('.clear-stats');
  const clearHint = clearBox.querySelector('.clear-hint');
  const CLEAR_TEXT = { hour: 'the last hour', day: 'today', all: 'all time' };
  let armTimer = null;
  function disarm() {
    clearTimeout(armTimer);
    for (const b of clearBox.querySelectorAll('[data-armed]')) {
      b.removeAttribute('data-armed');
      b.textContent = b.dataset.label;
    }
    clearHint.textContent = '';
  }
  clearBox.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-clear]');
    if (!btn) return;
    const range = btn.dataset.clear;
    if (!btn.hasAttribute('data-armed')) {
      disarm();
      btn.dataset.label = btn.dataset.label || btn.textContent;
      btn.setAttribute('data-armed', '');
      btn.textContent = 'Click to confirm';
      clearHint.textContent = `Clears stats from ${CLEAR_TEXT[range]}. Can't be undone.`;
      armTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    const res = await chrome.runtime.sendMessage({ action: 'CLEAR_STATS', range }).catch(() => null);
    clearHint.textContent = res && res.success ? `Cleared ${CLEAR_TEXT[range]}.` : 'Could not clear stats.';
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.stats) {
      stats = changes.stats.newValue;
      render();
    }
  });
  document.addEventListener('gohh:data', render);
  loadStats();
})();
