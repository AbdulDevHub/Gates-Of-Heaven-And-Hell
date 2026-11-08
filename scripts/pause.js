// pause.js — the Pause & Think crossroads (pages/pause.html).
// Turn Back (the whole Heaven card) is always available. Going through needs
// the reflection wait (it only counts down while this tab is visible), the
// exact phrase (the rule's note, or "Yes I Am Sure"), and then a slow gate
// opening. Closing the tab at any point before the site loads is a walk-away
// (the worker counts it via the open-gate entry this page registers).

const RE = self.RulesEngine;
const SH = self.Shared;

const OPENING_MS = 5000;

const params = new URLSearchParams(location.search);
const ruleId = params.get('ruleId');
const targetUrl = RE.readTargetUrl(location.href);

const content = document.querySelector('.content');
const onward = document.querySelector('.path-onward');
const inputWrapper = document.getElementById('inputWrapper');
const confirmInput = document.getElementById('confirmInput');
const continueBtn = document.getElementById('continueBtn');
const closeTabBtn = document.getElementById('closeTabBtn');
const ringProgress = document.getElementById('ringProgress');
const ringText = document.getElementById('ringText');
const toastEl = document.getElementById('toast');

let reminderStyle = 'universal';
let heldToday = 0;
let waitMs = SH.DEFAULT_SETTINGS.pauseWaitSeconds * 1000;
let unlocked = false;
let phrase = SH.DEFAULT_PHRASE;
let typedSent = false;
let rule = null;

requestAnimationFrame(() => requestAnimationFrame(() => content.classList.add('is-visible')));

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
}

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

function recordEvent(event) {
  return send({ action: 'RECORD_EVENT', event, ruleId: (rule && rule.id) || ruleId });
}

(async function init() {
  try {
    const { pauseAndThink = [], settings, stats } = await chrome.storage.local.get(['pauseAndThink', 'settings', 'stats']);
    const s = SH.mergeSettings(settings);
    reminderStyle = s.reminderStyle;
    rule = ruleId ? pauseAndThink.find((r) => r.id === ruleId) : null;
    if (!rule && targetUrl) rule = RE.findMatchingRule(targetUrl, pauseAndThink);

    send({ action: 'GATE_OPENED', kind: 'pause', ruleId: (rule && rule.id) || ruleId });

    waitMs = SH.resolveWaitSeconds(rule, s) * 1000;
    phrase = SH.gatePhrase(rule);
    const info = document.getElementById('passInfo');
    info.textContent = 'Wait, then type ';
    const q = document.createElement('span');
    q.className = 'phrase';
    q.textContent = `“${phrase}”`;
    info.appendChild(q);
    info.appendChild(document.createTextNode(`. The pass lasts ${SH.describePass(rule, s)}.`));
    document.getElementById('confirmLabel').textContent = `Type ${phrase} to continue`;
    document.getElementById('prompt').textContent = Reminders.pause(reminderStyle);

    const seenKey = `gohh:seen:${location.href}`;
    let first = true;
    try { first = !sessionStorage.getItem(seenKey); sessionStorage.setItem(seenKey, '1'); } catch {}
    if (first) recordEvent('pause-view');

    const now = Date.now();
    heldToday = SH.summarizeStats(stats, now, s).today.held;
    document.getElementById('tally').textContent = `${heldToday} ${heldToday === 1 ? 'gate' : 'gates'} held today`;
    if (rule) renderRecord(stats, now);
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Failed to load the gate:', err);
  }

  if (targetUrl) {
    try { document.getElementById('siteHost').textContent = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch {}
  }
  startCountdown();
})();

// "Last went through 6 days ago · 6-day streak · best 12": the pressure that
// belongs to this one site.
function renderRecord(stats, now) {
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
  el.appendChild(r && r.lastSlipAt ? part('Last went through', SH.formatAgo(r.lastSlipAt, now)) : part('Never gone through', '✓'));
  el.appendChild(part('Streak', `${streak} ${streak === 1 ? 'day' : 'days'}`));
  if (best > streak) el.appendChild(part('Best', `${best} days`));
  el.hidden = false;
}

// --- Reflection wait (only while the tab is visible) -----------------------
// No number and no filling ring: a visible countdown turns the wait into
// something to sit out instead of a moment to reflect.
function startCountdown() {
  let elapsed = 0;
  let last = performance.now();
  ringText.textContent = 'Wait';

  function frame(now) {
    if (unlocked) return;
    if (document.visibilityState === 'visible') elapsed += now - last;
    last = now;
    if (elapsed >= waitMs) { unlock(); return; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function unlock() {
  unlocked = true;
  onward.classList.add('is-unlocked');
  inputWrapper.classList.remove('is-locked');
  confirmInput.disabled = false;
  confirmInput.placeholder = `Type “${phrase}”`;
  confirmInput.focus();
  const key = `gohh:unlocked:${location.href}`;
  let first = true;
  try { first = !sessionStorage.getItem(key); sessionStorage.setItem(key, '1'); } catch {}
  if (first) recordEvent('gate-unlocked');
  Sfx.play('chime');
}

// The phrase has to be typed, not pasted.
for (const ev of ['paste', 'drop']) {
  confirmInput.addEventListener(ev, (e) => {
    e.preventDefault();
    Sfx.play('deny');
    showToast('Type it out. That’s the point.');
    setTimeout(() => toastEl.classList.remove('show'), 2200);
  });
}

confirmInput.addEventListener('input', () => {
  if (!typedSent && confirmInput.value.length) { typedSent = true; recordEvent('phrase-typed'); }
  const ok = confirmInput.value.trim() === phrase;
  continueBtn.disabled = !ok;
  continueBtn.classList.toggle('is-ready', ok);
});

document.getElementById('pauseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!unlocked || confirmInput.value.trim() !== phrase || document.body.classList.contains('is-going')) return;
  confirmInput.disabled = true;
  continueBtn.disabled = true;
  closeTabBtn.disabled = true;

  // The slow part: the gate grinds open. Nothing is granted until it has.
  await openGateSlowly();

  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ action: 'ACTIVATE_PAUSE_SESSION', ruleId, url: targetUrl });
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Failed to open a pass:', err);
  }

  if (!res || !res.success) {
    document.body.classList.remove('is-going');
    document.getElementById('opening').hidden = true;
    confirmInput.disabled = false;
    closeTabBtn.disabled = false;
    continueBtn.disabled = false;
    showToast((res && res.error) || 'Could not open a pass.');
    return;
  }
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) { showToast('Pass opened.'); return; }
  location.replace(targetUrl);
});

function openGateSlowly() {
  const opening = document.getElementById('opening');
  opening.hidden = false;
  Sfx.play('grind');
  document.body.classList.add('is-going');
  const start = performance.now();
  return new Promise((resolve) => {
    // Counts real visible time, like the reflection wait.
    let elapsed = 0;
    let last = start;
    function frame(now) {
      if (document.visibilityState === 'visible') elapsed += now - last;
      last = now;
      if (elapsed >= OPENING_MS) return resolve();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
}

closeTabBtn.addEventListener('click', async () => {
  if (document.body.classList.contains('is-going')) return;
  closeTabBtn.disabled = true;
  unlocked = true; // stop the countdown
  await send({ action: 'RESOLVE_GATE', outcome: 'walk-away', ruleId: (rule && rule.id) || ruleId });
  const held = heldToday + 1;
  HeavenGate.ascend({
    message: Reminders.affirmation(reminderStyle),
    sub: `${held} ${held === 1 ? 'gate' : 'gates'} held today.`
  });
});
