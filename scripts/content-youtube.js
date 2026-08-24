// content-youtube.js
// Catches the YouTube search form BEFORE it navigates, so a blocked query
// jumps straight to blocked.html instead of flashing the /results page first.

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

    const parts = self.RulesEngine.getUrlParts(url);
    const matchingRule = blocked.find((r) => self.RulesEngine.ruleMatches(parts, [r.domain, r.substring]));
    const ruleParam = matchingRule ? `&ruleId=${encodeURIComponent(matchingRule.id)}` : '';
    location.href = chrome.runtime.getURL(`pages/blocked.html?url=${encodeURIComponent(url)}${ruleParam}`);
  }
}, true);
