// blocked.js — the Hell gate (pages/blocked.html). No way through: the only
// button turns back, which plays the Heaven transition and closes the tab.

const RE = self.RulesEngine;
const SH = self.Shared;

const params = new URLSearchParams(location.search);
const ruleId = params.get('ruleId');
const targetUrl = RE.readTargetUrl(location.href);

const stage = document.getElementById('stage');
const portcullis = document.querySelector('.portcullis');
const content = document.querySelector('.content');
const closeBtn = document.getElementById('closeTabBtn');
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
    const today = SH.summarizeStats(stats, Date.now(), settings).today.held;
    heldToday = today + (first ? 1 : 0);
    if (first) chrome.runtime.sendMessage({ action: 'RECORD_EVENT', event: 'blocked-view' }).catch(() => {});

    const streak = SH.currentStreak(stats, Date.now());
    document.getElementById('tally').textContent =
      `Gates held today: ${heldToday} · Clean streak: ${streak} ${streak === 1 ? 'day' : 'days'}`;
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Failed to load the gate:', err);
    messageEl.textContent = Reminders.blocked(reminderStyle);
  }
})();

closeBtn.addEventListener('click', () => {
  closeBtn.disabled = true;
  HeavenGate.ascend({
    message: Reminders.affirmation(reminderStyle),
    sub: heldToday ? `${heldToday} ${heldToday === 1 ? 'gate' : 'gates'} held today.` : ''
  });
});

// --- Embers rising from the pit ---------------------------------------------
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

  function spawn(initial) {
    return {
      x: Math.random() * w,
      y: initial ? Math.random() * h : h + 10,
      r: 0.6 + Math.random() * 2.2,
      vy: 0.35 + Math.random() * 1.1,
      vx: (Math.random() - 0.5) * 0.4,
      life: 0,
      max: 260 + Math.random() * 320,
      hue: 12 + Math.random() * 28,
      wobble: Math.random() * Math.PI * 2
    };
  }

  resize();
  window.addEventListener('resize', resize);
  const count = Math.round(Math.min(110, (w * h) / 14000));
  for (let i = 0; i < count; i++) parts.push(spawn(true));

  function frame() {
    if (document.hidden) { requestAnimationFrame(frame); return; }
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.life++;
      p.wobble += 0.03;
      p.x += p.vx + Math.sin(p.wobble) * 0.3;
      p.y -= p.vy;
      const fade = 1 - p.life / p.max;
      if (fade <= 0 || p.y < -10) { parts[i] = spawn(false); continue; }
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
      g.addColorStop(0, `hsla(${p.hue + 20}, 100%, 75%, ${0.9 * fade})`);
      g.addColorStop(0.4, `hsla(${p.hue}, 100%, 55%, ${0.5 * fade})`);
      g.addColorStop(1, `hsla(${p.hue}, 100%, 40%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
