// content-youtube.js
// Catches the YouTube search form BEFORE it navigates, so a blocked or pause-intercepted query
// jumps straight to blocked.html or pause.html instead of flashing the /results page first.

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

  const {
    blocked = [],
    excluded = [],
    pauseAndThink = [],
    pauseSessions = []
  } = await chrome.storage.local.get(['blocked', 'excluded', 'pauseAndThink', 'pauseSessions']);

  const activeBlocked = blocked.filter((r) => !r.paused);
  const evaluation = self.RulesEngine.evaluateUrl(url, {
    blocked: activeBlocked,
    excluded,
    pauseAndThink
  });

  if (evaluation === 'pause') {
    const parts = self.RulesEngine.getUrlParts(url);
    const hasActiveSession = pauseSessions.some((s) => self.RulesEngine.ruleMatches(parts, [s.domain, s.substring]));

    if (!hasActiveSession) {
      e.preventDefault();
      e.stopImmediatePropagation();

      const matchingRule = self.RulesEngine.findMatchingRule(url, pauseAndThink);
      const ruleParam = matchingRule ? `&ruleId=${encodeURIComponent(matchingRule.id)}` : '';
      location.href = chrome.runtime.getURL(`pages/pause.html?url=${encodeURIComponent(url)}${ruleParam}`);
    }
  } else if (evaluation === 'blocked') {
    e.preventDefault();
    e.stopImmediatePropagation();

    const matchingRule = self.RulesEngine.findMatchingRule(url, activeBlocked);
    const ruleParam = matchingRule ? `&ruleId=${encodeURIComponent(matchingRule.id)}` : '';
    location.href = chrome.runtime.getURL(`pages/blocked.html?url=${encodeURIComponent(url)}${ruleParam}`);
  }
}, true);
