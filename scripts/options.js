// options.js — the Rule Book UI. Runs as a full extension page/tab, so it
// has direct access to chrome.storage, chrome.alarms, and chrome.downloads-
// style anchor downloads. No message-passing to background.js required;
// background.js reacts to storage changes on its own.

const ALARM_LOCK_PREFIX = 'lock:';
const ALARM_COUNTDOWN_PREFIX = 'pauseCountdown:';
const LEGACY_ALARM_COUNTDOWN_PREFIX = 'removalCountdown:';
const PAUSE_COUNTDOWN_MS = 30 * 60 * 1000;

let state = { blocked: [], excluded: [] };
let pendingReflect = null; // { ruleId, step: 1|2 }
let editingRuleId = null; // id of the rule currently showing its inline edit form (one at a time)

////////////////////////////////////////////////////////////////////////////
// Boot
////////////////////////////////////////////////////////////////////////////

(async function init() {
  await load();
  render();
  // Lightweight interval only updates countdown badge text in-place,
  // without rebuilding the DOM or wiping active input fields.
  setInterval(tickCountdowns, 1000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.blocked || changes.excluded) {
      load().then(() => {
        // If the user is currently editing a rule, avoid wiping out their active inputs
        if (!editingRuleId) {
          render();
        }
      });
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

// Mirrors background.js's lock-window logic exactly:
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
// Live Timer Ticker (Non-destructive)
////////////////////////////////////////////////////////////////////////////

function tickCountdowns() {
  const now = Date.now();
  let needsRender = false;

  const countdownBadges = document.querySelectorAll('.badge-countdown[data-ready-at]');
  countdownBadges.forEach((badge) => {
    const readyAt = Number(badge.dataset.readyAt);
    const remaining = readyAt - now;
    if (remaining <= 0) {
      needsRender = true;
    } else {
      badge.textContent = `⏳ Cooling off — ${formatCountdown(remaining)}`;
    }
  });

  for (const rule of state.blocked) {
    if (rule.locked && rule.lockedUntil && rule.lockedUntil <= now) {
      rule.locked = false;
      rule.lockedUntil = null;
      needsRender = true;
    }
    const pp = rule.pendingPause || rule.pendingRemoval;
    if (pp && pp.stage === 'countdown' && pp.readyAt <= now) {
      pp.stage = 'ready';
      rule.pendingPause = pp;
      delete rule.pendingRemoval;
      needsRender = true;
    }
  }

  // Only re-render when a stage actually transitions (e.g. countdown reaches 0)
  // and do not interrupt active editing
  if (needsRender && !editingRuleId) {
    render();
  }
}

////////////////////////////////////////////////////////////////////////////
// Render
////////////////////////////////////////////////////////////////////////////

function render() {
  renderBlocked();
  renderExcluded();
}

function groupByDomain(rules) {
  const map = new Map();
  for (const r of rules) {
    const key = (r.domain || '').toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderBlocked() {
  const list = document.getElementById('blockedList');
  const empty = document.getElementById('blockedEmpty');
  const now = Date.now();

  const openBefore = new Set();
  list.querySelectorAll('details.domain-group[open]').forEach((d) => openBefore.add(d.dataset.domain));

  list.innerHTML = '';
  empty.hidden = state.blocked.length > 0;

  for (const [domainKey, rules] of groupByDomain(state.blocked)) {
    if (rules.length > 1) {
      const details = document.createElement('details');
      details.className = 'domain-group';
      details.dataset.domain = domainKey;
      if (openBefore.has(domainKey)) details.open = true;

      const summary = document.createElement('summary');
      summary.innerHTML = `<span class="group-domain">${escapeHtml(rules[0].domain)}</span><span class="group-count">${rules.length} rules</span>`;
      details.appendChild(summary);

      const nested = document.createElement('ul');
      nested.className = 'rule-list rule-list-nested';
      for (const rule of rules) nested.appendChild(buildBlockedRow(rule, now, true));
      details.appendChild(nested);

      list.appendChild(details);
    } else {
      list.appendChild(buildBlockedRow(rules[0], now, false));
    }
  }
}

function buildBlockedRow(rule, now, nested) {
  const li = document.createElement('li');
  const isLocked = rule.locked && rule.lockedUntil > now;
  const isPaused = Boolean(rule.paused);
  li.className = 'rule-row' + (isLocked ? ' is-locked' : '') + (isPaused ? ' is-paused' : '');

  if (editingRuleId === rule.id) {
    li.innerHTML = buildEditForm(rule, 'blocked');
    attachEditEvents(li, rule.id, 'blocked');
    return li;
  }

  const pp = rule.pendingPause || rule.pendingRemoval;
  let metaHtml = '';
  let actionsHtml = '';

  if (isLocked) {
    metaHtml = `<span class="badge badge-locked">🔒 Locked until ${formatDate(rule.lockedUntil)}</span>`;
    actionsHtml = ``; // no controls at all — hard lock, no bypass
  } else if (pp && pp.stage === 'countdown') {
    const remaining = pp.readyAt - now;
    metaHtml = `<span class="badge badge-countdown" data-ready-at="${pp.readyAt}">⏳ Cooling off — ${formatCountdown(remaining)}</span>`;
    actionsHtml = `
      <button class="btn btn-ghost btn-small" data-action="cancel-pause" data-id="${rule.id}">Cancel</button>
      <button class="btn btn-ghost btn-small" data-action="delete" data-id="${rule.id}">Delete</button>
    `;
  } else if (pp && pp.stage === 'ready') {
    metaHtml = `<span class="badge badge-ready">✅ Ready — reflect once more to pause</span>`;
    actionsHtml = `
      <button class="btn btn-ghost btn-small" data-action="cancel-pause" data-id="${rule.id}">Cancel</button>
      <button class="btn btn-ember btn-small" data-action="finalize-pause" data-id="${rule.id}">Confirm Pause</button>
      <button class="btn btn-ghost btn-small" data-action="delete" data-id="${rule.id}">Delete</button>
    `;
  } else if (isPaused) {
    metaHtml = `<span class="badge badge-paused">⏸️ Paused</span>`;
    actionsHtml = `
      <button class="btn btn-gold btn-small" data-action="resume" data-id="${rule.id}">Resume</button>
      <button class="btn btn-ghost btn-small" data-action="edit" data-id="${rule.id}">Edit</button>
      <button class="btn btn-ghost btn-small" data-action="delete" data-id="${rule.id}">Delete</button>
    `;
  } else {
    actionsHtml = `
      <button class="btn btn-ghost btn-small" data-action="pause" data-id="${rule.id}">Pause</button>
      <button class="btn btn-ghost btn-small" data-action="edit" data-id="${rule.id}">Edit</button>
      <button class="btn btn-ghost btn-small" data-action="lock" data-id="${rule.id}">Lock</button>
      <button class="btn btn-ghost btn-small" data-action="delete" data-id="${rule.id}">Delete</button>
    `;
  }

  const domainLine = nested
    ? (rule.substring
        ? `<span class="rule-sub">${escapeHtml(rule.substring)}</span>`
        : `<span class="rule-sub rule-sub-muted">(whole domain)</span>`)
    : `${escapeHtml(rule.domain)}${rule.substring ? ` <span class="rule-sub">${escapeHtml(rule.substring)}</span>` : ''}`;

  li.innerHTML = `
    <div class="rule-main">
      <div class="rule-domain">${domainLine}</div>
      ${rule.message ? `<div class="rule-message" title="${escapeHtml(rule.message)}">"${escapeHtml(rule.message)}"</div>` : ''}
      ${metaHtml ? `<div class="rule-meta">${metaHtml}</div>` : ''}
    </div>
    <div class="rule-actions">${actionsHtml}</div>
  `;
  return li;
}

function renderExcluded() {
  const list = document.getElementById('excludedList');
  const empty = document.getElementById('excludedEmpty');

  const openBefore = new Set();
  list.querySelectorAll('details.domain-group[open]').forEach((d) => openBefore.add(d.dataset.domain));

  list.innerHTML = '';
  empty.hidden = state.excluded.length > 0;

  for (const [domainKey, rules] of groupByDomain(state.excluded)) {
    if (rules.length > 1) {
      const details = document.createElement('details');
      details.className = 'domain-group';
      details.dataset.domain = domainKey;
      if (openBefore.has(domainKey)) details.open = true;

      const summary = document.createElement('summary');
      summary.innerHTML = `<span class="group-domain">${escapeHtml(rules[0].domain)}</span><span class="group-count">${rules.length} rules</span>`;
      details.appendChild(summary);

      const nested = document.createElement('ul');
      nested.className = 'rule-list rule-list-nested';
      for (const rule of rules) nested.appendChild(buildExcludedRow(rule, true));
      details.appendChild(nested);

      list.appendChild(details);
    } else {
      list.appendChild(buildExcludedRow(rules[0], false));
    }
  }
}

function buildExcludedRow(rule, nested) {
  const li = document.createElement('li');
  li.className = 'rule-row';

  if (editingRuleId === rule.id) {
    li.innerHTML = buildEditForm(rule, 'excluded');
    attachEditEvents(li, rule.id, 'excluded');
    return li;
  }

  const domainLine = nested
    ? (rule.substring
        ? `<span class="rule-sub">${escapeHtml(rule.substring)}</span>`
        : `<span class="rule-sub rule-sub-muted">(whole domain)</span>`)
    : `${escapeHtml(rule.domain)}${rule.substring ? ` <span class="rule-sub">${escapeHtml(rule.substring)}</span>` : ''}`;

  li.innerHTML = `
    <div class="rule-main">
      <div class="rule-domain">${domainLine}</div>
    </div>
    <div class="rule-actions">
      <button class="btn btn-ghost btn-small" data-action="edit-excluded" data-id="${rule.id}">Edit</button>
      <button class="btn btn-ghost btn-small" data-action="remove-excluded" data-id="${rule.id}">Delete</button>
    </div>
  `;
  return li;
}

function buildEditForm(rule, type) {
  const messageField = type === 'blocked'
    ? `<input type="text" class="edit-message" placeholder="custom message (optional)" value="${escapeHtml(rule.message || '')}" />`
    : '';
  return `
    <div class="edit-form">
      <input type="text" class="edit-domain" placeholder="domain" value="${escapeHtml(rule.domain)}" />
      <input type="text" class="edit-substring" placeholder="substring (optional)" value="${escapeHtml(rule.substring || '')}" />
      ${messageField}
      <div class="edit-actions">
        <button class="btn btn-ghost btn-small" data-action="cancel-edit" data-id="${rule.id}">Cancel</button>
        <button class="btn btn-gold btn-small" data-action="save-edit" data-type="${type}" data-id="${rule.id}">Save</button>
      </div>
    </div>
  `;
}

function attachEditEvents(li, id, type) {
  requestAnimationFrame(() => {
    const domainInput = li.querySelector('.edit-domain');
    if (domainInput) {
      domainInput.focus();
      domainInput.select();
    }
  });

  li.querySelectorAll('input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveEdit(li, id, type);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        editingRuleId = null;
        render();
      }
    });
  });
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
    locked: false, lockedUntil: null, paused: false, pendingPause: null
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
  const { action, id, type } = btn.dataset;

  if (action === 'lock') return lockRule(id);
  if (action === 'pause') return openReflectModal(id, 1);
  if (action === 'finalize-pause') return openReflectModal(id, 2);
  if (action === 'cancel-pause') return cancelPause(id);
  if (action === 'resume') return resumeRule(id);
  if (action === 'delete') return deleteBlockedRule(id);
  if (action === 'edit') { editingRuleId = id; render(); return; }
  if (action === 'cancel-edit') { editingRuleId = null; render(); return; }
  if (action === 'save-edit') return saveEdit(btn.closest('li'), id, type);
});

document.getElementById('excludedList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id, type } = btn.dataset;

  if (action === 'remove-excluded') {
    state.excluded = state.excluded.filter((r) => r.id !== id);
    await save();
    toast('Exclusion deleted.');
    return;
  }
  if (action === 'edit-excluded') { editingRuleId = id; render(); return; }
  if (action === 'cancel-edit') { editingRuleId = null; render(); return; }
  if (action === 'save-edit') return saveEdit(btn.closest('li'), id, type);
});

async function saveEdit(li, id, type) {
  const domainInput = li.querySelector('.edit-domain');
  if (!domainInput) return;
  const domain = domainInput.value.trim();
  if (!domain) { toast('Domain can\u2019t be empty.'); return; }
  const substring = li.querySelector('.edit-substring').value.trim();
  const msgInput = li.querySelector('.edit-message');
  const message = msgInput ? msgInput.value.trim() : undefined;

  const list = type === 'blocked' ? state.blocked : state.excluded;
  const rule = list.find((r) => r.id === id);
  if (!rule) { editingRuleId = null; render(); return; }

  rule.domain = domain;
  rule.substring = substring;
  if (type === 'blocked') rule.message = message;

  editingRuleId = null;
  await save();
  toast('Rule updated.');
}

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

async function cancelPause(id) {
  const rule = state.blocked.find((r) => r.id === id);
  if (!rule) return;
  rule.pendingPause = null;
  delete rule.pendingRemoval;
  await save();
  chrome.alarms.clear(ALARM_COUNTDOWN_PREFIX + id);
  chrome.alarms.clear(LEGACY_ALARM_COUNTDOWN_PREFIX + id);
  toast('Pause cancelled.');
}

async function resumeRule(id) {
  const rule = state.blocked.find((r) => r.id === id);
  if (!rule) return;
  rule.paused = false;
  rule.pendingPause = null;
  delete rule.pendingRemoval;
  await save();
  chrome.alarms.clear(ALARM_COUNTDOWN_PREFIX + id);
  chrome.alarms.clear(LEGACY_ALARM_COUNTDOWN_PREFIX + id);
  toast('Rule resumed.');
}

async function deleteBlockedRule(id) {
  state.blocked = state.blocked.filter((r) => r.id !== id);
  await save();
  chrome.alarms.clear(ALARM_LOCK_PREFIX + id);
  chrome.alarms.clear(ALARM_COUNTDOWN_PREFIX + id);
  chrome.alarms.clear(LEGACY_ALARM_COUNTDOWN_PREFIX + id);
  toast('Rule deleted.');
}

////////////////////////////////////////////////////////////////////////////
// Reflection modal (shared for both pause steps)
////////////////////////////////////////////////////////////////////////////

const modal = document.getElementById('reflectModal');
const reflectTitle = document.getElementById('reflectTitle');
const reflectInput = document.getElementById('reflectInput');
const reflectConfirm = document.getElementById('reflectConfirm');
const reflectCancel = document.getElementById('reflectCancel');

function openReflectModal(ruleId, step) {
  pendingReflect = { ruleId, step };
  reflectTitle.textContent = step === 1
    ? 'Why are you pausing this rule?'
    : 'Final check — why are you pausing this rule?';
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
    const readyAt = now + PAUSE_COUNTDOWN_MS;
    rule.pendingPause = { stage: 'countdown', reason1: reason, startedAt: now, readyAt };
    delete rule.pendingRemoval;
    await save();
    chrome.alarms.create(ALARM_COUNTDOWN_PREFIX + ruleId, { when: readyAt });
    toast('Pause started. 30-minute cooling-off begins.');
  } else {
    rule.paused = true;
    rule.pendingPause = null;
    delete rule.pendingRemoval;
    await save();
    chrome.alarms.clear(ALARM_COUNTDOWN_PREFIX + ruleId);
    chrome.alarms.clear(LEGACY_ALARM_COUNTDOWN_PREFIX + ruleId);
    toast('Rule paused.');
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
    'This replaces your current BLOCKED and EXCLUDED lists entirely (locks and pending pauses will be cleared). Continue?'
  );
  if (!ok) { e.target.value = ''; return; }

  state.blocked = (parsed.BLOCKED || []).map(([domain, substring, message]) => ({
    id: crypto.randomUUID(),
    domain: domain || '', substring: substring || '', message: message || '',
    locked: false, lockedUntil: null, paused: false, pendingPause: null
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
