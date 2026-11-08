// blocked.js — the Hell gate (pages/blocked.html). No way through: the only
// button turns back, which plays the Heaven transition and closes the tab.
// A tab that a link just opened is closed by the worker before it gets here;
// GATE_OPENED is the fallback for redirects the worker didn't see coming.

const RE = self.RulesEngine;
const SH = self.Shared;

const params = new URLSearchParams(location.search);
const ruleId = params.get('ruleId');
const targetUrl = RE.readTargetUrl(location.href);

const stage = document.getElementById('stage');
const portcullis = document.querySelector('.portcullis');
const content = document.querySelector('.content');
const closeBtn = document.getElementById('closeTabBtn');
const glow = document.querySelector('.fire-glow');
const reduce = HeavenGate.reduceMotion();

let reminderStyle = 'universal';
let heldToday = 0;

// --- Entrance: the portcullis drops, the stage shakes, the words appear ----
requestAnimationFrame(() => requestAnimationFrame(() => {
  portcullis.classList.add('is-down');
  setTimeout(() => {
    if (!reduce) stage.classList.add('is-shaking');
    content.classList.add('is-visible');
  }, reduce ? 0 : 600);
}));

// --- Message, target and tally --------------------------------------------
(async function init() {
  const messageEl = document.getElementById('message');
  try {
    const res = await chrome.runtime.sendMessage({ action: 'GATE_OPENED', kind: 'blocked', ruleId }).catch(() => null);
    if (res && res.closed) return; // the worker closed this tab and counted it
    Sfx.play('hell');

    const { blocked = [], settings, stats } = await chrome.storage.local.get(['blocked', 'settings', 'stats']);
    reminderStyle = SH.mergeSettings(settings).reminderStyle;

    let rule = ruleId ? blocked.find((r) => r.id === ruleId) : null;
    if (!rule && targetUrl) rule = RE.findMatchingRule(targetUrl, blocked);
    messageEl.textContent = (rule && rule.message && rule.message.trim()) || Reminders.blocked(reminderStyle);

    if (targetUrl) {
      try { document.getElementById('target').textContent = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch {}
    }

    // Count each gate once per tab, not on every reload.
    const seenKey = `gohh:seen:${location.href}`;
    let first = true;
    try { first = !sessionStorage.getItem(seenKey); sessionStorage.setItem(seenKey, '1'); } catch {}
    const now = Date.now();
    const today = SH.summarizeStats(stats, now, settings).today.held;
    heldToday = today + (first ? 1 : 0);
    if (first) chrome.runtime.sendMessage({ action: 'RECORD_EVENT', event: 'blocked-view', ruleId: (rule && rule.id) || ruleId }).catch(() => {});

    document.getElementById('tally').textContent = `${heldToday} ${heldToday === 1 ? 'gate' : 'gates'} held today`;
    if (rule) renderRecord(rule, stats, now);
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Failed to load the gate:', err);
    messageEl.textContent = Reminders.blocked(reminderStyle);
  }
})();

// "Last paused 3 days ago · Streak 3 days": this site's own record.
function renderRecord(rule, stats, now) {
  const el = document.getElementById('ruleRecord');
  const r = stats && stats.rules && stats.rules[rule.id];
  const streak = SH.ruleStreak(stats, rule.id, now, rule);
  const best = Math.max((r && r.bestStreak) || 0, streak);
  const part = (label, value) => {
    const span = document.createElement('span');
    span.append(`${label} `);
    const b = document.createElement('strong');
    b.textContent = value;
    span.appendChild(b);
    return span;
  };
  el.innerHTML = '';
  el.appendChild(r && r.lastSlipAt ? part('Last paused', SH.formatAgo(r.lastSlipAt, now)) : part('Never paused', '✓'));
  el.appendChild(part('Streak', `${streak} ${streak === 1 ? 'day' : 'days'}`));
  if (best > streak) el.appendChild(part('Best', `${best} days`));
  el.hidden = false;
}

closeBtn.addEventListener('click', () => {
  closeBtn.disabled = true;
  HeavenGate.ascend({
    message: Reminders.affirmation(reminderStyle),
    sub: heldToday ? `${heldToday} ${heldToday === 1 ? 'gate' : 'gates'} held today.` : ''
  });
});

// --- Fire -------------------------------------------------------------------
// Flames: additive particles drawn from a few pre-rendered glow sprites at
// half resolution (cheap, and flames are soft anyway). Embers: small sparks
// across the whole page. Every few seconds a flare: a burst of sparks and a
// brighter glow.

function makeSprite(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

const SPRITES = {
  core: makeSprite(64, [[0, 'rgba(255,215,130,0.75)'], [0.35, 'rgba(255,140,40,0.5)'], [1, 'rgba(230,80,10,0)']]),
  flame: makeSprite(64, [[0, 'rgba(255,120,30,0.6)'], [0.45, 'rgba(200,50,10,0.35)'], [1, 'rgba(120,10,0,0)']]),
  smoke: makeSprite(64, [[0, 'rgba(150,20,8,0.5)'], [0.6, 'rgba(70,8,4,0.25)'], [1, 'rgba(20,0,0,0)']]),
  spark: makeSprite(16, [[0, 'rgba(255,240,200,1)'], [0.4, 'rgba(255,150,50,0.8)'], [1, 'rgba(255,80,20,0)']])
};

const flareBursts = [];
let nextFlare = performance.now() + 3000 + Math.random() * 4000;

(function flames() {
  if (reduce) return;
  const canvas = document.getElementById('flames');
  const ctx = canvas.getContext('2d');
  const SCALE = 0.5;
  let w = 0;
  let h = 0;
  const parts = [];

  function resize() {
    w = Math.max(1, Math.round(canvas.clientWidth * SCALE));
    h = Math.max(1, Math.round(canvas.clientHeight * SCALE));
    canvas.width = w;
    canvas.height = h;
  }
  resize();
  window.addEventListener('resize', resize);

  function spawn(x, boost) {
    const life = 45 + Math.random() * 55;
    return {
      x: x != null ? x : Math.random() * w,
      y: h + 6,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (1.5 + Math.random() * 2.1) * (boost || 1),
      size: (14 + Math.random() * 22) * (h / 220),
      life: 0,
      max: life * (boost ? 1.3 : 1),
      wob: Math.random() * Math.PI * 2
    };
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const target = Math.round(w / 2.9);
    for (let i = 0; parts.length < target && i < 12; i++) parts.push(spawn());
    // Flares push a tall column of fire up from their spot.
    for (const f of flareBursts) {
      if (f.flames > 0) {
        for (let i = 0; i < 6; i++) parts.push(spawn(f.x * w + (Math.random() - 0.5) * w * 0.12, 1.8));
        f.flames--;
      }
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life++;
      p.wob += 0.08;
      p.x += p.vx + Math.sin(p.wob) * 0.35;
      p.y -= p.vy;
      const t = p.life / p.max;
      if (t >= 1 || p.y < -p.size) { parts.splice(i, 1); continue; }
      const s = p.size * (1 - t * 0.75);
      const sprite = t < 0.25 ? SPRITES.core : t < 0.7 ? SPRITES.flame : SPRITES.smoke;
      ctx.globalAlpha = Math.min(0.9, (1 - t) * 1.2);
      ctx.drawImage(sprite, p.x - s, p.y - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(frame);
})();

(function embers() {
  if (reduce) return;
  const canvas = document.getElementById('embers');
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let dpr = 1;
  const parts = [];

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(initial, x, burst) {
    return {
      x: x != null ? x : Math.random() * w,
      y: initial ? Math.random() * h : h + 10,
      r: 0.6 + Math.random() * (burst ? 2.8 : 2.2),
      vy: burst ? 2 + Math.random() * 3.5 : 0.45 + Math.random() * 1.4,
      vx: (Math.random() - 0.5) * (burst ? 2.4 : 0.5),
      life: 0,
      max: burst ? 120 + Math.random() * 160 : 220 + Math.random() * 320,
      wobble: Math.random() * Math.PI * 2,
      burst: Boolean(burst)
    };
  }

  resize();
  window.addEventListener('resize', resize);
  const count = Math.round(Math.min(240, (w * h) / 7000));
  for (let i = 0; i < count; i++) parts.push(spawn(true));

  function flare(now) {
    const x = 0.15 + Math.random() * 0.7;
    flareBursts.push({ x, flames: 18 });
    if (flareBursts.length > 4) flareBursts.shift();
    for (let i = 0; i < 45; i++) parts.push(spawn(false, x * w + (Math.random() - 0.5) * 80, true));
    glow.classList.add('is-flaring');
    setTimeout(() => glow.classList.remove('is-flaring'), 450);
    nextFlare = now + 3500 + Math.random() * 5000;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    if (now >= nextFlare) flare(now);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life++;
      p.wobble += 0.03;
      p.x += p.vx + Math.sin(p.wobble) * 0.3;
      p.y -= p.vy;
      if (p.burst) p.vy *= 0.992;
      const fade = 1 - p.life / p.max;
      if (fade <= 0 || p.y < -10) {
        if (p.burst) parts.splice(i, 1);
        else parts[i] = spawn(false);
        continue;
      }
      const s = p.r * 4;
      ctx.globalAlpha = Math.min(1, fade * 1.1);
      ctx.drawImage(SPRITES.spark, p.x - s, p.y - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;
  }
  requestAnimationFrame(frame);
})();
