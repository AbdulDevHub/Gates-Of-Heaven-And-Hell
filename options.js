// options.js — the Rule Book UI. Runs as a full extension page/tab, so it
// has direct access to chrome.storage, chrome.alarms, and chrome.downloads-
// style anchor downloads. No message-passing to background.js required;
// background.js reacts to storage changes on its own.

const ALARM_LOCK_PREFIX = 'lock:';
const ALARM_COUNTDOWN_PREFIX = 'removalCountdown:';
const REMOVAL_COUNTDOWN_MS = 30 * 60 * 1000;

let state = { blocked: [], excluded: [] };
let pendingReflect = null; // { ruleId, step: 1|2 }

////////////////////////////////////////////////////////////////////////////
// Boot
////////////////////////////////////////////////////////////////////////////

(async function init() {
  await load();
  render();
  setInterval(render, 1000); // live countdown refresh

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.blocked || changes.excluded) {
      load().then(render);
    }
  });
})();

async function load() {
  const { blocked = [], excluded = [] } = await chrome.storage.local.get(['blocked', 'excluded']);
  state = { blocked, excluded };
}

async function save() {
  await chrome.storage.local.set({ blocked: state.blocked, excluded: state.excluded });
}

////////////////////////////////////////////////////////////////////////////
// Helpers
////////////////////////////////////////////////////////////////////////////

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function formatCountdown(ms) {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

// Mirrors background.js's lock-window logic exactly (Q7a):
// Locked Mon–Thu -> unlocks Friday 18:00, staying locked through the
// whole Fri–Sun window. Locked Fri/Sat/Sun -> flat 24h from lock time.
function computeLockUntil(now = new Date()) {
  const day = now.getDay(); // 0=Sun..6=Sat
  if (day >= 1 && day <= 4) {
    const daysUntilFriday = 5 - day;
    const target = new Date(now);
    target.setDate(now.getDate() + daysUntilFriday);
    target.setHours(18, 0, 0, 0);
    return target.getTime();
  }
  return now.getTime() + 24 * 60 * 60 * 1000;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2400);
}

////////////////////////////////////////////////////////////////////////////
// Render
////////////////////////////////////////////////////////////////////////////

function render() {
  renderBlocked();
  renderExcluded();
}

function renderBlocked() {
  const list = document.getElementById('blockedList');
  const empty = document.getElementById('blockedEmpty');
  const now = Date.now();

  list.innerHTML = '';
  empty.hidden = state.blocked.length > 0;

  for (const rule of state.blocked) {
    const li = document.createElement('li');
    li.className = 'rule-row' + (rule.locked && rule.lockedUntil > now ? ' is-locked' : '');

    const isLocked = rule.locked && rule.lockedUntil > now;
    const pr = rule.pendingRemoval;

    let metaHtml = '';
    let actionsHtml = '';

    if (isLocked) {
      metaHtml = `<span class="badge badge-locked">🔒 Locked until ${formatDate(rule.lockedUntil)}</span>`;
      actionsHtml = ``; // no controls at all — hard lock, no bypass
    } else if (pr && pr.stage === 'countdown') {
      const remaining = pr.readyAt - now;
      metaHtml = `<span class="badge badge-countdown">⏳ Cooling off — ${formatCountdown(remaining)}</span>`;
      actionsHtml = `<button class="btn btn-ghost btn-small" data-action="cancel-removal" data-id="${rule.id}">Cancel</button>`;
    } else if (pr && pr.stage === 'ready') {
      metaHtml = `<span class="badge badge-ready">✅ Ready — reflect once more to finish</span>`;
      actionsHtml = `
        <button class="btn btn-ghost btn-small" data-action="cancel-removal" data-id="${rule.id}">Cancel</button>
        <button class="btn btn-ember btn-small" data-action="finalize-removal" data-id="${rule.id}">Confirm Removal</button>
      `;
    } else {
      actionsHtml = `
        <button class="btn btn-ghost btn-small" data-action="lock" data-id="${rule.id}">Lock</button>
        <button class="btn btn-ghost btn-small" data-action="initiate-removal" data-id="${rule.id}">Remove</button>
      `;
    }

    li.innerHTML = `
      <div class="rule-main">
        <div class="rule-domain">${escapeHtml(rule.domain)}${rule.substring ? ` <span class="rule-sub">${escapeHtml(rule.substring)}</span>` : ''}</div>
        ${rule.message ? `<div class="rule-sub">"${escapeHtml(rule.message)}"</div>` : ''}
        ${metaHtml ? `<div class="rule-meta">${metaHtml}</div>` : ''}
      </div>
      <div class="rule-actions">${actionsHtml}</div>
    `;
    list.appendChild(li);
  }
}

function renderExcluded() {
  const list = document.getElementById('excludedList');
  const empty = document.getElementById('excludedEmpty');

  list.innerHTML = '';
  empty.hidden = state.excluded.length > 0;

  for (const rule of state.excluded) {
    const li = document.createElement('li');
    li.className = 'rule-row';
    li.innerHTML = `
      <div class="rule-main">
        <div class="rule-domain">${escapeHtml(rule.domain)}${rule.substring ? ` <span class="rule-sub">${escapeHtml(rule.substring)}</span>` : ''}</div>
      </div>
      <div class="rule-actions">
        <button class="btn btn-ghost btn-small" data-action="remove-excluded" data-id="${rule.id}">Remove</button>
      </div>
    `;
    list.appendChild(li);
  }
}

////////////////////////////////////////////////////////////////////////////
// Add-rule forms (instant, no friction)
////////////////////////////////////////////////////////////////////////////

document.getElementById('blockedForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const domain = document.getElementById('blockedDomain').value.trim();
  const substring = document.getElementById('blockedSubstring').value.trim();
  const message = document.getElementById('blockedMessage').value.trim();
  if (!domain) return;

  state.blocked.push({
    id: crypto.randomUUID(),
    domain, substring, message,
    locked: false, lockedUntil: null, pendingRemoval: null
  });
  await save();
  e.target.reset();
  toast('Blocked rule added.');
});

document.getElementById('excludedForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const domain = document.getElementById('excludedDomain').value.trim();
  const substring = document.getElementById('excludedSubstring').value.trim();
  if (!domain) return;

  state.excluded.push({ id: crypto.randomUUID(), domain, substring });
  await save();
  e.target.reset();
  toast('Exclusion added.');
});

////////////////////////////////////////////////////////////////////////////
// Rule row actions (event delegation)
////////////////////////////////////////////////////////////////////////////

document.getElementById('blockedList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;

  if (action === 'lock') return lockRule(id);
  if (action === 'initiate-removal') return openReflectModal(id, 1);
  if (action === 'finalize-removal') return openReflectModal(id, 2);
  if (action === 'cancel-removal') return cancelRemoval(id);
});

document.getElementById('excludedList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="remove-excluded"]');
  if (!btn) return;
  state.excluded = state.excluded.filter((r) => r.id !== btn.dataset.id);
  await save();
  toast('Exclusion removed.');
});

async function lockRule(id) {
  const rule = state.blocked.find((r) => r.id === id);
  if (!rule) return;
  const until = computeLockUntil(new Date());
  rule.locked = true;
  rule.lockedUntil = until;
  await save();
  chrome.alarms.create(ALARM_LOCK_PREFIX + id, { when: until });
  toast(`Locked until ${formatDate(until)}.`);
}

async function cancelRemoval(id) {
  const rule = state.blocked.find((r) => r.id === id);
  if (!rule) return;
  rule.pendingRemoval = null;
  await save();
  chrome.alarms.clear(ALARM_COUNTDOWN_PREFIX + id);
  toast('Removal cancelled.');
}

////////////////////////////////////////////////////////////////////////////
// Reflection modal (shared for both removal steps)
////////////////////////////////////////////////////////////////////////////

const modal = document.getElementById('reflectModal');
const reflectTitle = document.getElementById('reflectTitle');
const reflectInput = document.getElementById('reflectInput');
const reflectConfirm = document.getElementById('reflectConfirm');
const reflectCancel = document.getElementById('reflectCancel');

function openReflectModal(ruleId, step) {
  pendingReflect = { ruleId, step };
  reflectTitle.textContent = step === 1
    ? 'Why are you removing this rule?'
    : 'Final check — why are you removing this rule?';
  reflectInput.value = '';
  reflectConfirm.disabled = true;
  modal.hidden = false;
  reflectInput.focus();
}

function closeReflectModal() {
  modal.hidden = true;
  pendingReflect = null;
}

reflectInput.addEventListener('input', () => {
  reflectConfirm.disabled = reflectInput.value.trim().length === 0;
});

reflectCancel.addEventListener('click', closeReflectModal);

reflectConfirm.addEventListener('click', async () => {
  if (!pendingReflect) return;
  const { ruleId, step } = pendingReflect;
  const reason = reflectInput.value.trim();
  if (!reason) return;

  const rule = state.blocked.find((r) => r.id === ruleId);
  if (!rule) { closeReflectModal(); return; }

  if (step === 1) {
    const now = Date.now();
    const readyAt = now + REMOVAL_COUNTDOWN_MS;
    rule.pendingRemoval = { stage: 'countdown', reason1: reason, startedAt: now, readyAt };
    await save();
    chrome.alarms.create(ALARM_COUNTDOWN_PREFIX + ruleId, { when: readyAt });
    toast('Removal started. 30-minute cooling-off begins.');
  } else {
    state.blocked = state.blocked.filter((r) => r.id !== ruleId);
    await save();
    chrome.alarms.clear(ALARM_COUNTDOWN_PREFIX + ruleId);
    toast('Rule removed.');
  }

  closeReflectModal();
});

////////////////////////////////////////////////////////////////////////////
// Export / Import
////////////////////////////////////////////////////////////////////////////

document.getElementById('exportBtn').addEventListener('click', () => {
  const payload = {
    BLOCKED: state.blocked.map((r) => r.message ? [r.domain, r.substring, r.message] : [r.domain, r.substring]),
    EXCLUDED: state.excluded.map((r) => [r.domain, r.substring])
  };
  const text = '// Exported from Gates Of Heaven & Hell — ' + new Date().toISOString() + '\n' +
    JSON.stringify(payload, null, 2) + '\n';

  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bookOfLinks.export.jsonc';
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported.');
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();

  let parsed;
  try {
    parsed = parseJsonc(text);
  } catch (err) {
    toast('Import failed — invalid file.');
    return;
  }

  const ok = window.confirm(
    'This replaces your current BLOCKED and EXCLUDED lists entirely (locks and pending removals will be cleared). Continue?'
  );
  if (!ok) { e.target.value = ''; return; }

  state.blocked = (parsed.BLOCKED || []).map(([domain, substring, message]) => ({
    id: crypto.randomUUID(),
    domain: domain || '', substring: substring || '', message: message || '',
    locked: false, lockedUntil: null, pendingRemoval: null
  }));
  state.excluded = (parsed.EXCLUDED || []).map(([domain, substring]) => ({
    id: crypto.randomUUID(), domain: domain || '', substring: substring || ''
  }));

  await save();
  e.target.value = '';
  toast('Imported.');
});

function parseJsonc(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/("(?:[^"\\]|\\.)*")|\/\/.*$/gm, (m, str) => (str ? str : ''));
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}
