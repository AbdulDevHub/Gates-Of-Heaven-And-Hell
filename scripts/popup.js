// popup.js — toolbar popup: what happens on this page and why, quick rules
// for the current site (site + optional "only URLs containing" text, e.g. one
// YouTube channel) and open passes with live timers.

const RE = self.RulesEngine;
const SH = self.Shared;

const VERDICT = {
  blocked: { text: 'Blocked — Hell gate', cls: 'v-hell' },
  pause: { text: 'Pause & Think gate', cls: 'v-pause' },
  pass: { text: 'Open for now — pass active', cls: 'v-pass' },
  excluded: { text: 'Always allowed', cls: 'v-heaven' },
  none: { text: 'Not gated', cls: 'v-none' }
};

let tab = null;
let state = null;
let pageHost = '';
let lastVerdict = 'none';
let fieldsFilled = false;

function el(id) { return document.getElementById(id); }

async function load() {
  const s = await chrome.storage.local.get(['blocked', 'excluded', 'pauseAndThink', 'pauseSessions', 'settings']);
  state = {
    blocked: s.blocked || [],
    excluded: s.excluded || [],
    pauseAndThink: s.pauseAndThink || [],
    pauseSessions: s.pauseSessions || [],
    settings: SH.mergeSettings(s.settings)
  };
}

function gatedOriginal(url) {
  // On one of our own gate pages, show the site behind the gate instead.
  if (url && url.startsWith(chrome.runtime.getURL('pages/'))) return RE.readTargetUrl(url);
  return url;
}

function render() {
  const url = gatedOriginal(tab && (tab.url || tab.pendingUrl));
  const parts = RE.getUrlParts(url || '');
  const now = Date.now();

  if (!parts.isWeb) {
    el('siteHost').textContent = 'This page can’t be gated';
    el('verdict').textContent = '';
    el('reason').textContent = 'Open a website to see its status or add a rule.';
    el('actions').hidden = true;
  } else {
    const ex = RE.explainUrl(url, state, now);
    const v = VERDICT[ex.verdict];
    pageHost = parts.host.replace(/^www\./, '');
    lastVerdict = ex.verdict;
    el('siteHost').textContent = pageHost;
    if (!fieldsFilled) { el('qaDomain').value = pageHost; fieldsFilled = true; }
    el('verdict').textContent = v.text;
    el('verdict').className = `verdict ${v.cls}`;
    el('reason').textContent = ex.rule
      ? `${ex.reason} Rule: ${RE.normalizeDomain(ex.rule.domain)}${ex.rule.substring ? ` · “${ex.rule.substring}”` : ''}`
      : ex.reason;
    const notes = el('notes');
    notes.innerHTML = '';
    for (const n of ex.notes.slice(0, 2)) {
      const li = document.createElement('li');
      li.textContent = n.text;
      notes.appendChild(li);
    }
    notes.hidden = !ex.notes.length;

    el('actions').hidden = false;
    updateActions();
  }

  renderPasses(now);
}

function target() {
  const domain = RE.normalizeDomain(el('qaDomain').value);
  const substring = el('qaSubstring').value.trim();
  return { domain, substring };
}

// Shows what a rule from the fields would cover and which buttons make sense.
function updateActions() {
  const { domain, substring } = target();
  const preview = el('qaPreview');
  if (!domain) preview.textContent = 'Enter a site.';
  else if (domain === '*') preview.textContent = substring ? `Every site, URLs containing “${substring}”` : 'Every site';
  else preview.textContent = substring ? `${domain} URLs containing “${substring}”` : `All of ${domain}`;
  const narrowed = Boolean(substring) || domain !== RE.normalizeDomain(pageHost);
  document.querySelector('.act-hell .act-title').textContent = narrowed ? 'Block this' : 'Block this site';
  document.querySelector('.act-pause .act-title').textContent = 'Pause & Think';
  document.querySelector('.act-heaven .act-title').textContent = substring ? 'Always allow these URLs' : 'Always allow this page';
  // Hide what's already true for an un-narrowed rule on this page.
  document.querySelector('.act-hell').hidden = !domain || (!narrowed && lastVerdict === 'blocked');
  document.querySelector('.act-pause').hidden = !domain || (!narrowed && (lastVerdict === 'pause' || lastVerdict === 'pass'));
  // No one-click exception for a page that is gated right now (that would be
  // a bypass button), and none for some other site typed in here: exceptions
  // for anything gated go through the Rule Book.
  // With extra text, an exception could cover other gated URLs on this site
  // (e.g. "/" on x.com), so it's only offered when no gate rule touches the host.
  const host = RE.normalizeDomain(pageHost);
  const hostGated = [...state.blocked, ...state.pauseAndThink].some((r) => {
    const h = RE.normalizeDomain(r.domain).split('/')[0];
    return h === '*' || host === h || host.endsWith(`.${h}`);
  });
  document.querySelector('.act-heaven').hidden =
    lastVerdict !== 'none' || domain !== host || (Boolean(substring) && hostGated);
}

el('qaDomain').addEventListener('input', updateActions);
el('qaSubstring').addEventListener('input', updateActions);

function renderPasses(now) {
  const list = el('passes');
  list.innerHTML = '';
  for (const s of state.pauseSessions) {
    const ends = SH.sessionEndsAt(s);
    const li = document.createElement('li');
    const host = document.createElement('span');
    host.className = 'pass-host';
    host.textContent = RE.normalizeDomain(s.domain) + (s.substring ? ` · ${s.substring}` : '');
    const time = document.createElement('span');
    time.className = 'pass-time';
    time.dataset.until = String(ends);
    time.dataset.label = s.mode === 'fixed' ? 'ends in {t}' : '{t} grace left';
    time.textContent = time.dataset.label.replace('{t}', SH.formatDuration(ends - now));
    const end = document.createElement('button');
    end.type = 'button';
    end.className = 'pass-end';
    end.textContent = 'End';
    end.addEventListener('click', async () => {
      end.disabled = true;
      await chrome.runtime.sendMessage({ action: 'END_PASS', ruleId: s.ruleId });
    });
    li.append(host, time, end);
    list.appendChild(li);
  }
  el('passesSection').hidden = !state.pauseSessions.length;
}

document.querySelectorAll('.act').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const url = gatedOriginal(tab.url || tab.pendingUrl);
    const u = new URL(url);
    const list = btn.dataset.list;
    const t = target();
    if (!t.domain) return;
    // An exception without extra text covers just this page (host + path).
    const domain = list === 'excluded' && !t.substring
      ? `${t.domain}${u.pathname.replace(/\/+$/, '')}`
      : t.domain;
    btn.disabled = true;
    const res = await chrome.runtime.sendMessage({ action: 'QUICK_ADD', list, domain, substring: t.substring, tabId: tab.id, url });
    btn.querySelector('.act-sub').textContent = res && res.success ? (res.existed ? 'Already in your rules' : 'Added') : 'Could not add the rule';
    await load();
    render();
    if (list !== 'excluded') setTimeout(() => window.close(), 700);
  });
});

document.querySelectorAll('[data-open]').forEach((b) => {
  b.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`pages/options.html#${b.dataset.open}`) });
    window.close();
  });
});

setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('[data-until]').forEach((t) => {
    t.textContent = t.dataset.label.replace('{t}', SH.formatDuration(Number(t.dataset.until) - now));
  });
}, 1000);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  load().then(render);
});

(async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await load();
  render();
})();
