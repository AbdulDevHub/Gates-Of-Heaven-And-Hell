// content-youtube.js
// Catches the YouTube search form BEFORE it navigates, so a gated query jumps
// straight to blocked.html or pause.html instead of flashing /results first.
// (Other in-app navigation is caught by the worker's SPA listener.)
//
// Rule state is cached and kept fresh so the submit check can run
// synchronously: preventDefault() only works before the first await.

const KEYS = ['blocked', 'excluded', 'pauseAndThink', 'pauseSessions'];
let cachedState = null;

function refreshState() {
  try {
    chrome.storage.local.get(KEYS).then((s) => { cachedState = s; }).catch(() => {});
  } catch {
    // Extension was reloaded under this page; stay inert.
  }
}

refreshState();
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEYS.some((k) => changes[k])) refreshState();
  });
} catch {}

document.addEventListener('submit', (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement) || !cachedState) return;

  let actionPath = '';
  try {
    actionPath = new URL(form.action, location.origin).pathname;
  } catch {
    return;
  }
  if (!actionPath.includes('/results')) return;

  const q = new FormData(form).get('search_query');
  if (!q) return;

  const url = location.origin + '/results?search_query=' + encodeURIComponent(q);
  const verdict = self.RulesEngine.explainUrl(url, cachedState, Date.now());
  if (verdict.verdict !== 'pause' && verdict.verdict !== 'blocked') return;

  e.preventDefault();
  e.stopImmediatePropagation();
  const page = verdict.verdict === 'pause' ? 'pause.html' : 'blocked.html';
  location.href = chrome.runtime.getURL(self.RulesEngine.buildGatePath(page, verdict.rule && verdict.rule.id, url));
}, true);
