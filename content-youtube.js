// content-youtube.js
// The only job left for a content script: catch the YouTube search form
// BEFORE it navigates, so a blocked query jumps straight to blocked.html
// instead of flashing the /results page first (declarativeNetRequest would
// still catch the navigation, but only after it starts). Everything else
// the original Tampermonkey script did (click interception, 50ms polling,
// history patching) is redundant now that DNR blocks at the network layer
// regardless of how navigation is triggered — dropped entirely.

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;

  let actionPath = '';
  try {
    actionPath = new URL(form.action, location.origin).pathname;
  } catch {
    return;
  }
  if (!actionPath.includes('/results')) return;

  const data = new FormData(form);
  const q = data.get('search_query');
  if (!q) return;

  const url = location.origin + '/results?search_query=' + encodeURIComponent(q);

  const { blocked = [], excluded = [] } = await chrome.storage.local.get(['blocked', 'excluded']);
  const isBlocked = self.RulesEngine.isEffectivelyBlocked(url, blocked, excluded);

  if (isBlocked) {
    e.preventDefault();
    e.stopImmediatePropagation();
    location.href = chrome.runtime.getURL('blocked.html');
  }
}, true);
