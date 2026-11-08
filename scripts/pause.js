// pause.js — the Pause & Think crossroads (pages/pause.html).
// Turn Back is always available. Going through needs the reflection wait
// (it only counts down while this tab is visible) and the exact phrase.

const RE = self.RulesEngine;
const SH = self.Shared;

const REQUIRED_CONFIRMATION = 'Yes I Am Sure';
const RING_LENGTH = 276.46; // 2πr for r = 44

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

requestAnimationFrame(() => requestAnimationFrame(() => content.classList.add('is-visible')));

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
}

(async function init() {
  let rule = null;
  try {
    const { pauseAndThink = [], settings, stats } = await chrome.storage.local.get(['pauseAndThink', 'settings', 'stats']);
    const s = SH.mergeSettings(settings);
    reminderStyle = s.reminderStyle;
    rule = ruleId ? pauseAndThink.find((r) => r.id === ruleId) : null;
    if (!rule && targetUrl) rule = RE.findMatchingRule(targetUrl, pauseAndThink);

    waitMs = SH.resolveWaitSeconds(rule, s) * 1000;
    document.getElementById('passInfo').textContent = `Wait, then type “${REQUIRED_CONFIRMATION}”. The pass lasts ${SH.describePass(rule, s)}.`;
    document.getElementById('prompt').textContent = Reminders.pause(reminderStyle);

    if (rule && rule.note) {
      const note = document.getElementById('note');
      note.textContent = rule.note;
      note.hidden = false;
    }

    const seenKey = `gohh:seen:${location.href}`;
    let first = true;
    try { first = !sessionStorage.getItem(seenKey); sessionStorage.setItem(seenKey, '1'); } catch {}
    if (first) chrome.runtime.sendMessage({ action: 'RECORD_EVENT', event: 'pause-view' }).catch(() => {});
    heldToday = SH.summarizeStats(stats, Date.now(), s).today.held;
    const streak = SH.currentStreak(stats, Date.now());
    document.getElementById('tally').textContent = `Gates held today: ${heldToday} · Clean streak: ${streak} ${streak === 1 ? 'day' : 'days'}`;
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Failed to load the gate:', err);
  }

  if (targetUrl) {
    try { document.getElementById('siteHost').textContent = new URL(targetUrl).hostname.replace(/^www\./, ''); } catch {}
  }
  startCountdown();
})();

// --- Reflection countdown (only while the tab is visible) ------------------
function startCountdown() {
  let elapsed = 0;
  let last = performance.now();

  function frame(now) {
    if (unlocked) return;
    if (document.visibilityState === 'visible') elapsed += now - last;
    last = now;
    const left = Math.max(0, waitMs - elapsed);
    ringProgress.style.strokeDashoffset = String(RING_LENGTH * (left / waitMs));
    ringText.textContent = String(Math.ceil(left / 1000));
    if (left <= 0) { unlock(); return; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function unlock() {
  unlocked = true;
  onward.classList.add('is-unlocked');
  inputWrapper.classList.remove('is-locked');
  confirmInput.disabled = false;
  confirmInput.placeholder = `Type “${REQUIRED_CONFIRMATION}”`;
  confirmInput.focus();
}

confirmInput.addEventListener('input', () => {
  const ok = confirmInput.value.trim() === REQUIRED_CONFIRMATION;
  continueBtn.disabled = !ok;
  continueBtn.classList.toggle('is-ready', ok);
});

document.getElementById('pauseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!unlocked || confirmInput.value.trim() !== REQUIRED_CONFIRMATION) return;
  confirmInput.disabled = true;
  continueBtn.disabled = true;
  closeTabBtn.disabled = true;
  continueBtn.textContent = 'Opening…';

  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ action: 'ACTIVATE_PAUSE_SESSION', ruleId, url: targetUrl });
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Failed to open a pass:', err);
  }

  if (!res || !res.success) {
    continueBtn.textContent = 'Continue';
    closeTabBtn.disabled = false;
    showToast((res && res.error) || 'Could not open a pass.');
    return;
  }
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) { showToast('Pass opened.'); return; }
  document.body.classList.add('is-descending');
  // The DNR allow rule is already applied when the message resolves; the
  // fade just gives the choice a moment of weight.
  setTimeout(() => location.replace(targetUrl), HeavenGate.reduceMotion() ? 50 : 600);
});

closeTabBtn.addEventListener('click', () => {
  closeTabBtn.disabled = true;
  unlocked = true; // stop the countdown
  chrome.runtime.sendMessage({ action: 'RECORD_EVENT', event: 'walk-away' }).catch(() => {});
  const held = heldToday + 1;
  HeavenGate.ascend({
    message: Reminders.affirmation(reminderStyle),
    sub: `${held} ${held === 1 ? 'gate' : 'gates'} held today.`
  });
});
