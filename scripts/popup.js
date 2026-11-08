// popup.js — toolbar popup: what happens on this page and why, one-click
// rules for the current site, open passes with live timers, today's tally.

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

function el(id) { return document.getElementById(id); }

async function load() {
  const s = await chrome.storage.local.get(['blocked', 'excluded', 'pauseAndThink', 'pauseSessions', 'settings', 'stats']);
  state = {
    blocked: s.blocked || [],
    excluded: s.excluded || [],
    pauseAndThink: s.pauseAndThink || [],
    pauseSessions: s.pauseSessions || [],
    settings: SH.mergeSettings(s.settings),
    stats: s.stats
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
    el('siteHost').textContent = parts.host.replace(/^www\./, '');
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
    document.querySelector('.act-hell').hidden = ex.verdict === 'blocked';
    document.querySelector('.act-pause').hidden = ex.verdict === 'pause' || ex.verdict === 'pass';
    // No one-click exception for a page that is gated right now: that would
    // be a bypass button. Exceptions for gated pages go through the Rule Book.
    document.querySelector('.act-heaven').hidden = ex.verdict !== 'none' && ex.verdict !== 'pass';
  }

  renderPasses(now);
  renderToday(now);
}

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

function renderToday(now) {
  const sum = SH.summarizeStats(state.stats, now, state.settings);
  el('today').innerHTML = '';
  const items = [
    [String(sum.today.held), 'held today'],
    [String(sum.streak), sum.streak === 1 ? 'day streak' : 'days streak'],
    [String(sum.today.slips), sum.today.slips === 1 ? 'slip today' : 'slips today']
  ];
  for (const [value, label] of items) {
    const d = document.createElement('div');
    const b = document.createElement('strong');
    b.textContent = value;
    const span = document.createElement('span');
    span.textContent = label;
    d.append(b, span);
    el('today').appendChild(d);
  }
}

document.querySelectorAll('.act').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const url = gatedOriginal(tab.url || tab.pendingUrl);
    const u = new URL(url);
    const list = btn.dataset.list;
    // Exceptions cover just this page (host + path); gates cover the whole site.
    const domain = list === 'excluded'
      ? `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`
      : u.hostname.replace(/^www\./, '');
    btn.disabled = true;
    const res = await chrome.runtime.sendMessage({ action: 'QUICK_ADD', list, domain, substring: '', tabId: tab.id, url });
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
