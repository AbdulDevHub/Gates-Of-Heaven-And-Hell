// options.js — the Rule Book: rule lists, quick add, edit, pause, lock, lint
// fixes, plus the URL tester and import/export (both shown in Settings).
// Journey and Settings tabs live in options-journey.js and options-settings.js
// and share the globals below.
// The page writes chrome.storage directly; background.js reacts to changes.

const RE = self.RulesEngine;
const SH = self.Shared;

const ALARM_LOCK_PREFIX = 'lock:';
const ALARM_COUNTDOWN_PREFIX = 'pauseCountdown:';
const LEGACY_ALARM_COUNTDOWN_PREFIX = 'removalCountdown:';

const LISTS = ['blocked', 'pauseAndThink', 'excluded'];
const LIST_LABEL = { blocked: 'Blocked', pauseAndThink: 'Pause & Think', excluded: 'Exceptions' };
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let state = { blocked: [], excluded: [], pauseAndThink: [], pauseSessions: [] };
let settings = SH.mergeSettings({});
let pendingReflect = null; // { ruleId, step: 1|2 }
let editingRuleId = null; // one inline edit form at a time
let quickAddKey = null; // `${list}|${domainKey}` with an open quick-add form
let filterText = '';
let flashRuleId = null;

////////////////////////////////////////////////////////////////////////////
// Boot
////////////////////////////////////////////////////////////////////////////

(async function init() {
  await load();
  setupTabs();
  render();
  setInterval(tick, 1000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.blocked || changes.excluded || changes.pauseAndThink || changes.pauseSessions || changes.settings) {
      load().then(() => {
        if (!editingRuleId && !quickAddKey) render();
      });
    }
  });
})();

async function load() {
  const s = await chrome.storage.local.get(['blocked', 'excluded', 'pauseAndThink', 'pauseSessions', 'settings']);
  state = {
    blocked: s.blocked || [],
    excluded: s.excluded || [],
    pauseAndThink: s.pauseAndThink || [],
    pauseSessions: s.pauseSessions || []
  };
  settings = SH.mergeSettings(s.settings);
  snapshot = clone({ blocked: state.blocked, excluded: state.excluded, pauseAndThink: state.pauseAndThink });
  document.dispatchEvent(new CustomEvent('gohh:data'));
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// Writes only what this page changed since it last loaded, on top of the
// latest stored lists, so a rule added from the popup or a lock/pause change
// made by the worker in the meantime is never overwritten by stale page state.
let snapshot = { blocked: [], excluded: [], pauseAndThink: [] };
async function save() {
  const fresh = await chrome.storage.local.get(LISTS);
  const out = {};
  for (const list of LISTS) {
    const before = new Map((snapshot[list] || []).map((r) => [r.id, JSON.stringify(r)]));
    const mine = new Map(state[list].map((r) => [r.id, r]));
    const merged = (fresh[list] || [])
      .filter((r) => !(before.has(r.id) && !mine.has(r.id))) // deleted here
      .map((r) => {
        const m = mine.get(r.id);
        return m && JSON.stringify(m) !== before.get(r.id) ? m : r; // edited here
      });
    const ids = new Set(merged.map((r) => r.id));
    for (const r of state[list]) if (!before.has(r.id) && !ids.has(r.id)) merged.push(r); // added here
    out[list] = merged;
  }
  await chrome.storage.local.set(out);
  for (const list of LISTS) state[list] = clone(out[list]);
  snapshot = clone(out);
}

function endPassesFor(ruleIds) {
  const ids = new Set(ruleIds);
  for (const s of state.pauseSessions) {
    if (ids.has(s.ruleId)) chrome.runtime.sendMessage({ action: 'END_PASS', ruleId: s.ruleId }).catch(() => {});
  }
}

////////////////////////////////////////////////////////////////////////////
// Tabs
////////////////////////////////////////////////////////////////////////////

let showTab = () => {};
function setupTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  const show = (name) => {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      document.getElementById(`tab-${t.dataset.tab}`).hidden = !on;
    }
    try { history.replaceState(null, '', `#${name}`); } catch {}
    document.dispatchEvent(new CustomEvent('gohh:tab', { detail: name }));
  };
  showTab = show;
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  const initial = location.hash.slice(1);
  show(tabs.some((t) => t.dataset.tab === initial) ? initial : 'rules');
}

////////////////////////////////////////////////////////////////////////////
// Helpers
////////////////////////////////////////////////////////////////////////////

// Safe for both text and attribute values (rule text lands in value="…" and title="…").
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(ts) {
  return new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function domainKey(domain) {
  return RE.normalizeDomain(domain);
}

function ruleKey(r) {
  return `${domainKey(r.domain)}|${String(r.substring || '').trim().toLowerCase()}`;
}

function isLocked(rule, now = Date.now()) {
  return Boolean(rule.locked && rule.lockedUntil > now);
}

function findRule(id) {
  for (const list of LISTS) {
    const rule = state[list].find((r) => r.id === id);
    if (rule) return { list, rule };
  }
  return { list: null, rule: null };
}

function textOf(list, rule) {
  return list === 'blocked' ? rule.message || '' : rule.note || '';
}

function matchesFilter(list, rule) {
  if (!filterText) return true;
  const hay = [rule.domain, rule.substring, textOf(list, rule)].join(' ').toLowerCase();
  return hay.includes(filterText);
}

function countdownBadge(cls, until, label) {
  return `<span class="badge ${cls}" data-until="${until}" data-label="${escapeHtml(label)}">${escapeHtml(label.replace('{t}', SH.formatDuration(until - Date.now())))}</span>`;
}

////////////////////////////////////////////////////////////////////////////
// Live ticker: updates countdown text in place; re-renders on transitions.
////////////////////////////////////////////////////////////////////////////

function tick() {
  const now = Date.now();
  let needsRender = false;

  document.querySelectorAll('[data-until]').forEach((el) => {
    const remaining = Number(el.dataset.until) - now;
    if (remaining <= 0) needsRender = true;
    else el.textContent = el.dataset.label.replace('{t}', SH.formatDuration(remaining));
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

  if (needsRender && !editingRuleId && !quickAddKey) render();
}

////////////////////////////////////////////////////////////////////////////
// Render
////////////////////////////////////////////////////////////////////////////

function render() {
  const now = Date.now();
  for (const list of LISTS) renderList(list, now);
  renderCounts(now);
  renderDatalist();
  if (flashRuleId) {
    const row = document.querySelector(`.rule-row[data-id="${CSS.escape(flashRuleId)}"]`);
    if (row) {
      row.classList.add('flash');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    flashRuleId = null;
  }
}

function groupByDomain(rules) {
  const map = new Map();
  for (const r of rules) {
    const key = domainKey(r.domain);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderList(list, now) {
  const ul = document.getElementById(`${list}List`);
  const empty = document.getElementById(`${list}Empty`);
  const openBefore = new Set();
  ul.querySelectorAll('details.domain-group[open]').forEach((d) => openBefore.add(d.dataset.domain));

  const visible = state[list].filter((r) => matchesFilter(list, r));
  ul.innerHTML = '';
  empty.hidden = visible.length > 0;
  empty.textContent = state[list].length ? 'No rules match the filter.' : `No ${LIST_LABEL[list].toLowerCase()} rules yet.`;
  document.getElementById(`${list}Count`).textContent = state[list].length ? String(state[list].length) : '';

  for (const [key, rules] of groupByDomain(visible)) {
    const qaOpen = quickAddKey === `${list}|${key}`;
    if (rules.length > 1 || qaOpen) {
      const details = document.createElement('details');
      details.className = 'domain-group';
      details.dataset.domain = key;
      if (openBefore.has(key) || qaOpen || filterText || rules.some((r) => r.id === editingRuleId || r.id === flashRuleId)) details.open = true;

      const summary = document.createElement('summary');
      summary.innerHTML = `
        <span class="group-domain">${escapeHtml(key)}</span>
        <span class="group-count">${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}</span>
        <button class="btn btn-ghost btn-small btn-add" type="button" data-action="quick-add" data-list="${list}" data-domain="${escapeHtml(key)}" title="Add more words for ${escapeHtml(key)}">＋ Add</button>`;
      details.appendChild(summary);

      const nested = document.createElement('ul');
      nested.className = 'rule-list rule-list-nested';
      if (qaOpen) nested.appendChild(buildQuickAdd(list, key));
      for (const rule of rules) nested.appendChild(buildRow(list, rule, now, true));
      details.appendChild(nested);
      ul.appendChild(details);
    } else {
      ul.appendChild(buildRow(list, rules[0], now, false));
    }
  }
}

function renderCounts(now) {
  const total = LISTS.reduce((n, l) => n + state[l].length, 0);
  const locked = state.blocked.filter((r) => isLocked(r, now)).length;
  const paused = state.blocked.filter((r) => RE.isRulePaused(r, now)).length;
  const passes = state.pauseSessions.length;
  const chips = [`${total} rules`];
  if (locked) chips.push(`🔒 ${locked} locked`);
  if (paused) chips.push(`⏸ ${paused} paused`);
  if (passes) chips.push(`🔓 ${passes} open ${passes === 1 ? 'pass' : 'passes'}`);
  document.getElementById('ruleCounts').innerHTML = chips.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
}

function renderDatalist() {
  const domains = new Set();
  for (const l of LISTS) for (const r of state[l]) domains.add(domainKey(r.domain));
  document.getElementById('domainList').innerHTML = [...domains].sort().map((d) => `<option value="${escapeHtml(d)}"></option>`).join('');
}

function buildQuickAdd(list, key) {
  const li = document.createElement('li');
  li.className = 'quick-add';
  const textPh = list === 'blocked' ? 'message on the gate (optional)' : 'note (optional)';
  li.innerHTML = `
    <form class="quick-form" data-list="${list}" data-domain="${escapeHtml(key)}">
      <span class="quick-domain">${escapeHtml(key)}</span>
      <input type="text" class="quick-subs" placeholder="words in URL, comma-separated" autocomplete="off" />
      <input type="text" class="quick-text" placeholder="${textPh}" autocomplete="off" />
      <button type="submit" class="btn btn-gold btn-small">Add</button>
      <button type="button" class="btn btn-ghost btn-small" data-action="quick-cancel">Cancel</button>
    </form>`;
  requestAnimationFrame(() => li.querySelector('.quick-subs').focus());
  li.querySelector('.quick-subs').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { quickAddKey = null; render(); }
  });
  return li;
}

function lintHtml(list, rule, locked) {
  const lints = RE.lintRule(rule, list, state);
  return lints.map((l) => {
    const canFix = l.fix && !(locked && list === 'blocked');
    const fixLabel = { 'move-to-note': 'Move to note', 'move-to-message': 'Move to message', normalize: 'Clean up', delete: 'Delete duplicate' }[l.fix];
    return `<span class="lint" title="${escapeHtml(l.text)}">⚠ ${escapeHtml(l.text)}${canFix ? ` <button class="link-btn" type="button" data-action="lint-fix" data-fix="${l.fix}" data-id="${rule.id}">${fixLabel}</button>` : ''}</span>`;
  }).join('');
}

function buildRow(list, rule, now, nested) {
  const li = document.createElement('li');
  const locked = list === 'blocked' && isLocked(rule, now);
  const paused = list === 'blocked' && RE.isRulePaused(rule, now);
  li.className = 'rule-row' + (locked ? ' is-locked' : '') + (paused ? ' is-paused' : '');
  li.dataset.id = rule.id;

  if (editingRuleId === rule.id) {
    li.classList.add('is-editing');
    li.innerHTML = buildEditForm(list, rule);
    attachEditEvents(li, rule.id, list);
    return li;
  }

  const meta = [];
  let actions = '';
  const id = rule.id;
  const btn = (action, label, cls = 'btn-ghost') => `<button class="btn ${cls} btn-small" type="button" data-action="${action}" data-list="${list}" data-id="${id}">${label}</button>`;
  const addBtn = nested ? '' : `<button class="btn btn-ghost btn-small btn-add" type="button" data-action="quick-add" data-list="${list}" data-domain="${escapeHtml(domainKey(rule.domain))}" title="Add more words for this site">＋</button>`;

  if (list === 'blocked') {
    const pp = rule.pendingPause || rule.pendingRemoval;
    if (locked) {
      meta.push(`<span class="badge badge-locked">🔒 Locked until ${formatDate(rule.lockedUntil)}</span>`);
      actions = addBtn;
    } else if (paused) {
      meta.push(rule.pausedUntil
        ? countdownBadge('badge-paused', rule.pausedUntil, '⏸ Paused · resumes in {t}')
        : '<span class="badge badge-paused">⏸ Paused until you resume</span>');
      actions = btn('resume', 'Resume', 'btn-gold') + btn('edit', 'Edit') + btn('delete', 'Delete') + addBtn;
    } else if (pp && pp.stage === 'countdown') {
      meta.push(countdownBadge('badge-countdown', pp.readyAt, '⏳ Cooling off · {t}'));
      actions = btn('cancel-pause', 'Cancel');
    } else if (pp && pp.stage === 'ready') {
      meta.push('<span class="badge badge-ready">⚠ Ready to pause</span>');
      actions = btn('cancel-pause', 'Cancel') + btn('finalize-pause', 'Confirm Pause', 'btn-ember');
    } else {
      actions = btn('edit', 'Edit') + btn('lock', 'Lock') + btn('pause', 'Pause') + btn('delete', 'Delete') + addBtn;
    }
  } else {
    actions = btn('edit', 'Edit') + btn('delete', 'Delete') + addBtn;
  }

  if (list === 'blocked' && (rule.cooldownMinutes != null || rule.pendingCooldown)) {
    meta.push(`<span class="badge badge-custom" title="This rule has its own pause cooldown">⏳ ${escapeHtml(SH.formatMinutes(SH.ruleCooldownMinutes(rule, settings, now)))} cooldown · custom</span>`);
  }

  if (list === 'pauseAndThink') {
    const wait = SH.resolveWaitSeconds(rule, settings);
    const custom = rule.waitSeconds != null || rule.passMode || rule.passMinutes != null;
    meta.push(`<span class="badge ${custom ? 'badge-custom' : 'badge-gate'}" title="Access lasts ${escapeHtml(SH.describePass(rule, settings))}">⏱ ${wait}s wait${custom ? ' · custom timing' : ''}</span>`);
    const session = state.pauseSessions.find((s) => s.ruleId === rule.id);
    if (session) {
      const ends = SH.sessionEndsAt(session);
      meta.push(countdownBadge('badge-pass', ends, session.mode === 'fixed' ? '🔓 Pass open · ends in {t}' : '🔓 Pass open · {t} grace left'));
      actions = btn('end-pass', 'End pass', 'btn-ember') + actions;
    }
  }

  if (RE.isValidSchedule(rule.schedule)) {
    const on = RE.isScheduleActive(rule.schedule, new Date(now));
    meta.push(`<span class="badge badge-schedule${on ? '' : ' is-off'}">🕘 ${escapeHtml(RE.describeSchedule(rule.schedule))}${on ? '' : ' · off now'}</span>`);
  }

  const sub = rule.substring
    ? `<span class="rule-sub">${escapeHtml(rule.substring)}</span>`
    : (nested ? '<span class="rule-sub rule-sub-muted">(whole site)</span>' : '');
  const domainLine = nested ? sub : `${escapeHtml(domainKey(rule.domain) || rule.domain)} ${sub}`;
  const text = textOf(list, rule);
  const textLine = text
    ? `<div class="rule-message" title="${escapeHtml(text)}">${list === 'blocked' ? `“${escapeHtml(text)}”` : list === 'pauseAndThink' ? `⌨ Type: ${escapeHtml(text)}` : `📝 ${escapeHtml(text)}`}</div>`
    : '';
  const lints = lintHtml(list, rule, locked);

  li.innerHTML = `
    <div class="rule-main">
      <div class="rule-domain">${domainLine}</div>
      ${textLine}
      ${meta.length ? `<div class="rule-meta">${meta.join('')}</div>` : ''}
      ${lints ? `<div class="rule-lints">${lints}</div>` : ''}
    </div>
    <div class="rule-actions">${actions}</div>`;
  return li;
}

function buildEditForm(list, rule) {
  const text = textOf(list, rule);
  const sched = RE.isValidSchedule(rule.schedule) ? rule.schedule : null;
  const days = sched ? sched.days : [1, 2, 3, 4, 5];
  const dayToggles = DAY_NAMES.map((n, i) => `<label class="day"><input type="checkbox" class="edit-day" value="${i}" ${days.includes(i) ? 'checked' : ''} /><span>${n}</span></label>`).join('');
  const pt = list === 'pauseAndThink';
  const passModeOpt = (v, label) => `<option value="${v}" ${rule.passMode === v || (!rule.passMode && v === '') ? 'selected' : ''}>${label}</option>`;
  const MODE_LABEL = { activity: 'while I’m on the site', fixed: 'a fixed time', endOfDay: 'until the end of today' };
  const pendingCd = rule.pendingCooldown && rule.pendingCooldown.effectiveAt > Date.now() ? rule.pendingCooldown : null;
  const cdValue = rule.pendingCooldown ? rule.pendingCooldown.minutes : rule.cooldownMinutes; // the configured target

  return `
    <div class="edit-form">
      <div class="edit-row edit-main">
        <input type="text" class="edit-domain" placeholder="site" value="${escapeHtml(rule.domain)}" aria-label="Site" />
        <input type="text" class="edit-substring" placeholder="word in URL (optional)" value="${escapeHtml(rule.substring || '')}" aria-label="Word in URL" />
        <input type="text" class="edit-text" placeholder="${list === 'blocked' ? 'message on the gate (optional)' : pt ? 'phrase to type instead of “Yes I Am Sure” (optional)' : 'note (optional)'}" value="${escapeHtml(text)}" aria-label="${list === 'blocked' ? 'Message' : pt ? 'Phrase to type' : 'Note'}" />
      </div>
      <div class="edit-row edit-schedule">
        <label class="check"><input type="checkbox" class="edit-sched-on" ${sched ? 'checked' : ''} /> Only active on a schedule</label>
        <div class="sched-fields" ${sched ? '' : 'hidden'}>
          <div class="days">${dayToggles}</div>
          <span class="time-range"><input type="time" class="edit-start" value="${sched ? sched.start : '09:00'}" aria-label="Start time" /> to <input type="time" class="edit-end" value="${sched ? sched.end : '17:00'}" aria-label="End time" /></span>
          <span class="hint">Same start and end = all day. An end before the start runs overnight.</span>
        </div>
      </div>
      ${pt ? `
      <div class="edit-row edit-gate">
        <span class="sentence">Wait <input type="number" class="edit-wait" min="3" max="300" placeholder="${settings.pauseWaitSeconds}" value="${rule.waitSeconds ?? ''}" aria-label="Wait seconds" /> s before typing.</span>
        <span class="sentence">After going through, access lasts <select class="edit-pass-mode" aria-label="Access lasts">
          ${passModeOpt('', `default (${MODE_LABEL[settings.passMode]})`)}
          ${passModeOpt('activity', MODE_LABEL.activity)}
          ${passModeOpt('fixed', MODE_LABEL.fixed)}
          ${passModeOpt('endOfDay', MODE_LABEL.endOfDay)}
        </select></span>
        <span class="sentence edit-pass-min-wrap"><span class="edit-pass-min-label"></span> <input type="number" class="edit-pass-min" min="1" max="720" placeholder="" value="${rule.passMinutes ?? ''}" aria-label="Minutes" /> min.</span>
        <span class="hint">Leave a box empty to use the default from Settings.</span>
      </div>` : ''}
      ${list === 'blocked' ? `
      <div class="edit-row edit-gate">
        <span class="sentence">Wait <input type="number" class="edit-cooldown" min="5" max="1440" placeholder="${SH.effectiveCooldownMinutes(settings, Date.now())}" value="${cdValue ?? ''}" aria-label="Pause cooldown minutes" /> min before this rule can be paused.</span>
        <span class="hint">${pendingCd ? `Now ${SH.formatMinutes(SH.ruleCooldownMinutes(rule, settings, Date.now()))}; the shorter value applies at ${formatDate(pendingCd.effectiveAt)}. ` : ''}Empty = the default. A shorter cooldown only applies after the current one has passed.</span>
      </div>` : ''}
      <div class="edit-actions">
        <button class="btn btn-ghost btn-small" type="button" data-action="cancel-edit" data-list="${list}" data-id="${rule.id}">Cancel</button>
        <button class="btn btn-gold btn-small" type="button" data-action="save-edit" data-list="${list}" data-id="${rule.id}">Save</button>
      </div>
    </div>`;
}

function attachEditEvents(li, id, list) {
  requestAnimationFrame(() => {
    const d = li.querySelector('.edit-domain');
    if (d) { d.focus(); d.select(); }
  });
  li.querySelector('.edit-sched-on').addEventListener('change', (e) => {
    li.querySelector('.sched-fields').hidden = !e.target.checked;
  });
  const modeSel = li.querySelector('.edit-pass-mode');
  if (modeSel) {
    // The minutes box means different things per access type; say which.
    const syncMinutes = () => {
      const mode = modeSel.value || settings.passMode;
      const wrap = li.querySelector('.edit-pass-min-wrap');
      wrap.hidden = mode === 'endOfDay';
      li.querySelector('.edit-pass-min-label').textContent = mode === 'fixed' ? 'Access ends after' : 'Access ends once I’ve been off the site for';
      li.querySelector('.edit-pass-min').placeholder = String(mode === 'fixed' ? settings.passFixedMinutes : settings.passGraceMinutes);
    };
    modeSel.addEventListener('change', syncMinutes);
    syncMinutes();
  }
  li.querySelectorAll('input[type="text"], input[type="number"]').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveEdit(li, id, list); }
      else if (e.key === 'Escape') { e.preventDefault(); editingRuleId = null; render(); }
    });
  });
}

////////////////////////////////////////////////////////////////////////////
// Adding rules
////////////////////////////////////////////////////////////////////////////

function addRules(list, domain, substrings, text) {
  const clean = RE.normalizeDomain(domain);
  if (!clean) return { added: 0, skipped: 0 };
  const existing = new Set(state[list].map(ruleKey));
  let added = 0;
  let skipped = 0;
  for (const sub of substrings.length ? substrings : ['']) {
    const fields = { domain: clean, substring: sub };
    fields[list === 'blocked' ? 'message' : 'note'] = text;
    const rule = SH.makeRule(list, fields);
    if (existing.has(ruleKey(rule))) { skipped++; continue; }
    existing.add(ruleKey(rule));
    state[list].push(rule);
    added++;
  }
  return { added, skipped };
}

function splitSubstrings(raw) {
  return [...new Set(String(raw || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
}

function addedToast(list, { added, skipped }) {
  if (!added && skipped) return toast('Already in the list.');
  toast(`${added} ${LIST_LABEL[list]} ${added === 1 ? 'rule' : 'rules'} added${skipped ? ` (${skipped} already there)` : ''}.`);
}

for (const list of LISTS) {
  document.getElementById(`${list}Form`).addEventListener('submit', async (e) => {
    e.preventDefault();
    const domain = document.getElementById(`${list}Domain`).value;
    const sub = document.getElementById(`${list}Substring`).value.trim();
    const textId = list === 'blocked' ? 'blockedMessage' : `${list}Note`;
    const text = document.getElementById(textId).value.trim();
    if (!RE.normalizeDomain(domain)) return;
    const res = addRules(list, domain, sub ? [sub] : [], text);
    await save();
    e.target.reset();
    document.getElementById(`${list}Domain`).focus();
    addedToast(list, res);
  });
}

document.getElementById('tab-rules').addEventListener('submit', async (e) => {
  const form = e.target.closest('.quick-form');
  if (!form) return;
  e.preventDefault();
  const { list, domain } = form.dataset;
  const subs = splitSubstrings(form.querySelector('.quick-subs').value);
  const text = form.querySelector('.quick-text').value.trim();
  const res = addRules(list, domain, subs, text);
  await save();
  addedToast(list, res);
  render(); // the quick-add form stays open (and refocused) for the next batch
});

////////////////////////////////////////////////////////////////////////////
// Row actions (one delegated handler for all lists)
////////////////////////////////////////////////////////////////////////////

document.getElementById('tab-rules').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id, list } = btn.dataset;

  if (action === 'quick-add') {
    e.preventDefault(); // don't toggle the <details>
    quickAddKey = `${list}|${btn.dataset.domain}`;
    editingRuleId = null;
    render();
    return;
  }
  if (action === 'quick-cancel') { quickAddKey = null; render(); return; }
  if (action === 'jump') { jumpToRule(id); return; }

  if (action === 'edit') { editingRuleId = id; quickAddKey = null; render(); return; }
  if (action === 'cancel-edit') { editingRuleId = null; render(); return; }
  if (action === 'save-edit') return saveEdit(btn.closest('li'), id, list);
  if (action === 'delete') return deleteRule(list, id);
  if (action === 'lint-fix') return applyLintFix(id, btn.dataset.fix);
  if (action === 'end-pass') return endPass(id);

  if (action === 'lock') return lockRule(id);
  if (action === 'pause') return openReflectModal(id, 1);
  if (action === 'finalize-pause') return openReflectModal(id, 2);
  if (action === 'cancel-pause') return cancelPause(id);
  if (action === 'resume') return resumeRule(id);
});

async function saveEdit(li, id, list) {
  const { rule } = findRule(id);
  if (!rule) { editingRuleId = null; render(); return; }
  if (list === 'blocked' && isLocked(rule)) { toast('Locked rules can’t be edited.'); editingRuleId = null; render(); return; }

  const domain = RE.normalizeDomain(li.querySelector('.edit-domain').value);
  if (!domain) { toast('Site can’t be empty.'); return; }
  const substring = li.querySelector('.edit-substring').value.trim();
  // A pass covers the old pattern; end it so it can't outlive the edit.
  if (list === 'pauseAndThink' && (domain !== rule.domain || substring !== (rule.substring || ''))) endPassesFor([id]);
  rule.domain = domain;
  rule.substring = substring;
  const text = li.querySelector('.edit-text').value.trim();
  if (list === 'blocked') rule.message = text;
  else rule.note = text;

  if (li.querySelector('.edit-sched-on').checked) {
    const days = [...li.querySelectorAll('.edit-day:checked')].map((c) => Number(c.value));
    const schedule = SH.cleanSchedule({ days, start: li.querySelector('.edit-start').value, end: li.querySelector('.edit-end').value });
    if (!schedule) { toast('Pick at least one day and both times.'); return; }
    rule.schedule = schedule;
  } else {
    rule.schedule = null;
  }

  if (list === 'pauseAndThink') {
    const wait = li.querySelector('.edit-wait').value;
    const mode = li.querySelector('.edit-pass-mode').value;
    const mins = li.querySelector('.edit-pass-min').value;
    rule.waitSeconds = wait === '' ? null : SH.clamp(wait, SH.LIMITS.pauseWaitSeconds);
    rule.passMode = mode || null;
    rule.passMinutes = mins === '' ? null : SH.clamp(mins, SH.LIMITS.passFixedMinutes);
  }

  if (list === 'blocked') {
    const raw = li.querySelector('.edit-cooldown').value.trim();
    const wanted = raw === '' ? null : SH.clamp(raw, SH.LIMITS.blockedCooldownMinutes);
    const shown = rule.pendingCooldown ? rule.pendingCooldown.minutes : rule.cooldownMinutes ?? null;
    if (wanted !== shown) {
      const before = SH.ruleCooldownMinutes(rule, settings, Date.now());
      Object.assign(rule, SH.requestRuleCooldown(rule, wanted, settings, Date.now()));
      if (rule.pendingCooldown) toast(`Shorter cooldown applies at ${formatDate(rule.pendingCooldown.effectiveAt)} (now ${SH.formatMinutes(before)}).`);
    }
  }

  editingRuleId = null;
  await save();
  render();
  if (!(list === 'blocked' && rule.pendingCooldown && rule.pendingCooldown.effectiveAt > Date.now())) toast('Rule updated.');
}

async function deleteRule(list, id) {
  const rule = state[list].find((r) => r.id === id);
  if (!rule) return;
  if (list === 'blocked' && isLocked(rule)) { toast('Locked rules can’t be deleted.'); return; }
  state[list] = state[list].filter((r) => r.id !== id);
  await save();
  if (list === 'pauseAndThink') endPassesFor([id]);
  if (list === 'blocked') {
    chrome.alarms.clear(ALARM_LOCK_PREFIX + id);
    chrome.alarms.clear(ALARM_COUNTDOWN_PREFIX + id);
    chrome.alarms.clear(LEGACY_ALARM_COUNTDOWN_PREFIX + id);
  }
  toast('Rule deleted.');
}

async function applyLintFix(id, fix) {
  const { list, rule } = findRule(id);
  if (!rule) return;
  if (list === 'blocked' && isLocked(rule)) return;
  if (fix === 'delete') return deleteRule(list, id);
  if (fix === 'normalize') rule.domain = RE.normalizeDomain(rule.domain);
  if (fix === 'move-to-note' || fix === 'move-to-message') {
    const field = fix === 'move-to-note' ? 'note' : 'message';
    rule[field] = [rule[field], rule.substring].filter(Boolean).join(' · ');
    rule.substring = '';
  }
  await save();
  render();
  toast('Fixed. The rule now covers the whole site.');
}

async function endPass(ruleId) {
  await chrome.runtime.sendMessage({ action: 'END_PASS', ruleId });
  toast('Pass ended. Open tabs on that site are back at the gate.');
}

async function lockRule(id) {
  const rule = state.blocked.find((r) => r.id === id);
  if (!rule) return;
  const until = SH.computeLockUntil(Date.now());
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
  rule.pausedUntil = null;
  rule.pendingPause = null;
  delete rule.pendingRemoval;
  await save();
  chrome.alarms.clear(ALARM_COUNTDOWN_PREFIX + id);
  chrome.alarms.clear(LEGACY_ALARM_COUNTDOWN_PREFIX + id);
  toast('Rule resumed.');
}

////////////////////////////////////////////////////////////////////////////
// URL tester and filter
////////////////////////////////////////////////////////////////////////////

const VERDICT_UI = {
  blocked: { cls: 'v-hell', title: 'Blocked — the Hell gate closes' },
  pause: { cls: 'v-pause', title: 'Pause & Think — the crossroads gate' },
  pass: { cls: 'v-pass', title: 'Allowed for now — a pass is open' },
  excluded: { cls: 'v-heaven', title: 'Allowed — an exception matches' },
  none: { cls: 'v-none', title: 'Not gated' }
};

function ruleLabel(list, rule) {
  return `${LIST_LABEL[list]}: ${domainKey(rule.domain)}${rule.substring ? ` · “${rule.substring}”` : ''}`;
}

document.getElementById('testerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  let url = document.getElementById('testerUrl').value.trim();
  if (!url) return;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  const ex = RE.explainUrl(url, state, Date.now());
  const ui = VERDICT_UI[ex.verdict];
  const out = document.getElementById('testerResult');
  const ruleLine = ex.rule
    ? `<p class="tester-rule">${escapeHtml(ruleLabel(ex.list, ex.rule))} <button class="link-btn" type="button" data-action="jump" data-id="${ex.rule.id}">Show rule</button></p>`
    : '';
  const notes = ex.notes.map((n) => `<li>${escapeHtml(n.text)} <span class="muted">(${escapeHtml(ruleLabel(n.list, n.rule))})</span> <button class="link-btn" type="button" data-action="jump" data-id="${n.rule.id}">Show rule</button></li>`).join('');
  out.className = `tester-result ${ui.cls}`;
  out.innerHTML = `
    <p class="tester-verdict">${escapeHtml(ui.title)}</p>
    <p class="tester-reason">${escapeHtml(ex.reason)}</p>
    ${ruleLine}
    ${notes ? `<ul class="tester-notes">${notes}</ul>` : ''}`;
  out.hidden = false;
});

function jumpToRule(id, mode) {
  const { list, rule } = findRule(id);
  if (!rule) return;
  showTab('rules');
  filterText = '';
  document.getElementById('filterInput').value = '';
  flashRuleId = id;
  if (mode === 'edit' && !(list === 'blocked' && isLocked(rule))) { editingRuleId = id; quickAddKey = null; }
  render();
}

document.getElementById('filterInput').addEventListener('input', (e) => {
  filterText = e.target.value.trim().toLowerCase();
  render();
});

////////////////////////////////////////////////////////////////////////////
// Reflection modal (both pause steps)
////////////////////////////////////////////////////////////////////////////

const modal = document.getElementById('reflectModal');
const reflectTitle = document.getElementById('reflectTitle');
const reflectSub = document.getElementById('reflectSub');
const reflectInput = document.getElementById('reflectInput');
const reflectConfirm = document.getElementById('reflectConfirm');
const reflectCancel = document.getElementById('reflectCancel');
const pauseLengthRow = document.getElementById('pauseLengthRow');

function openReflectModal(ruleId, step) {
  const rule = state.blocked.find((r) => r.id === ruleId);
  if (!rule || isLocked(rule)) return;
  pendingReflect = { ruleId, step };
  const cooldown = SH.ruleCooldownMinutes(rule, settings, Date.now());
  reflectTitle.textContent = step === 1 ? 'Why are you pausing this rule?' : 'Final check — why are you pausing this rule?';
  reflectSub.textContent = step === 1
    ? `A ${SH.formatMinutes(cooldown)} cooldown starts after this. Then you’ll be asked once more.`
    : `Your first reason: “${(rule.pendingPause && rule.pendingPause.reason1) || ''}”`;
  pauseLengthRow.hidden = step !== 2;
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
modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReflectModal(); });

reflectConfirm.addEventListener('click', async () => {
  if (!pendingReflect) return;
  const { ruleId, step } = pendingReflect;
  const reason = reflectInput.value.trim();
  if (!reason) return;
  const rule = state.blocked.find((r) => r.id === ruleId);
  if (!rule || isLocked(rule)) { closeReflectModal(); return; }
  const now = Date.now();

  if (step === 1) {
    const minutes = SH.ruleCooldownMinutes(rule, settings, now);
    const readyAt = now + minutes * SH.MINUTE;
    rule.pendingPause = { stage: 'countdown', reason1: reason, startedAt: now, readyAt };
    delete rule.pendingRemoval;
    await save();
    chrome.alarms.create(ALARM_COUNTDOWN_PREFIX + ruleId, { when: readyAt });
    toast(`Pause started. ${SH.formatMinutes(minutes)} cooldown begins.`);
  } else {
    if (!rule.pendingPause || rule.pendingPause.stage !== 'ready') { closeReflectModal(); return; }
    const choice = document.getElementById('pauseLength').value;
    let until = null;
    if (choice === 'eod') until = SH.endOfDay(now);
    else if (choice !== 'manual') until = now + Number(choice) * SH.MINUTE;
    rule.paused = true;
    rule.pausedUntil = until;
    rule.pendingPause = null;
    delete rule.pendingRemoval;
    await save();
    chrome.alarms.clear(ALARM_COUNTDOWN_PREFIX + ruleId);
    chrome.alarms.clear(LEGACY_ALARM_COUNTDOWN_PREFIX + ruleId);
    chrome.runtime.sendMessage({ action: 'RECORD_EVENT', event: 'rule-paused', ruleId }).catch(() => {});
    toast(until ? `Rule paused until ${formatDate(until)}.` : 'Rule paused until you resume it.');
  }
  closeReflectModal();
});

////////////////////////////////////////////////////////////////////////////
// Export / Import
////////////////////////////////////////////////////////////////////////////

document.getElementById('exportBtn').addEventListener('click', () => {
  const text = SH.serializeRuleBook(state, settings, Date.now());
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
  let book;
  try {
    book = SH.parseRuleBook(await file.text());
  } catch {
    toast('Import failed — that file isn’t valid JSONC.');
    e.target.value = '';
    return;
  }

  const now = Date.now();
  const locked = state.blocked.filter((r) => isLocked(r, now));
  const ok = window.confirm(
    `Replace your rules with ${book.blocked.length} Blocked, ${book.pauseAndThink.length} Pause & Think and ${book.excluded.length} exception rules?` +
    (locked.length ? `\n\nYour ${locked.length} locked rule(s) stay as they are until their lock ends.` : '')
  );
  if (!ok) { e.target.value = ''; return; }

  // An imported per-rule cooldown can't be shorter than the current default
  // (same reason the global cooldown is never imported).
  const floor = SH.effectiveCooldownMinutes(settings, now);
  for (const r of book.blocked) if (r.cooldownMinutes != null && r.cooldownMinutes < floor) r.cooldownMinutes = null;

  // A rule that already exists keeps its id and creation date, so its
  // streak and stats carry over.
  for (const list of LISTS) {
    const old = new Map(state[list].map((r) => [ruleKey(r), r]));
    for (const r of book[list]) {
      const prev = old.get(ruleKey(r));
      if (prev) { r.id = prev.id; if (prev.createdAt) r.createdAt = prev.createdAt; }
    }
  }

  // Locked rules survive an import, so Import can't be used to dodge a lock.
  const lockedKeys = new Set(locked.map(ruleKey));
  state.blocked = [...locked, ...book.blocked.filter((r) => !lockedKeys.has(ruleKey(r)))];
  state.pauseAndThink = book.pauseAndThink;
  state.excluded = book.excluded;
  await save();
  endPassesFor(state.pauseSessions.map((s) => s.ruleId)); // imported rules get new ids

  const imported = SH.importableSettings(book.settings);
  if (Object.keys(imported).length) {
    await chrome.storage.local.set({ settings: SH.mergeSettings(Object.assign({}, settings, imported)) });
  }
  e.target.value = '';
  toast('Imported.');
});
