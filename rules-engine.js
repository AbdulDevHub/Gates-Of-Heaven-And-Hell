// rules-engine.js
// Pure, dependency-free helpers shared by background.js (service worker)
// and content-youtube.js (content script). No chrome.* calls in here —
// keep this file environment-agnostic so both contexts can load it as-is.

(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------

  function getUrlParts(url) {
    try {
      const u = new URL(url);
      return { host: u.hostname.toLowerCase(), full: url.toLowerCase() };
    } catch {
      return { host: '', full: (url || '').toLowerCase() };
    }
  }

  // ---------------------------------------------------------------------
  // Plain-JS AND-matching (domain + optional substring), used client-side
  // in the YouTube content script for a pre-navigation check. Mirrors the
  // original Tampermonkey semantics exactly: host OR full URL must contain
  // the domain string; if a substring is given, it must also appear
  // anywhere in the full URL.
  // ---------------------------------------------------------------------

  function ruleMatches(urlParts, rule) {
    const domain = (rule[0] || '').toLowerCase();
    const sub = (rule[1] || '').toLowerCase();

    if (!domain) return false;

    const hostMatch = urlParts.host.includes(domain) || urlParts.full.includes(domain);
    if (!hostMatch) return false;

    if (!sub) return true;
    return urlParts.full.includes(sub);
  }

  function matchesAny(url, rules) {
    if (!rules || !rules.length) return false;
    const parts = getUrlParts(url);
    return rules.some((rule) => ruleMatches(parts, rule));
  }

  // EXCLUDED always wins, unconditionally, regardless of specificity.
  function isEffectivelyBlocked(url, blockedRules, excludedRules) {
    if (matchesAny(url, excludedRules)) return false;
    return matchesAny(url, blockedRules);
  }

  // ---------------------------------------------------------------------
  // Regex compilation for declarativeNetRequest (RE2 engine — no
  // lookahead/lookbehind, no backreferences). Domain must appear before
  // the substring in the string, which holds for real URLs since the
  // domain always sits in the authority section near the start.
  // ---------------------------------------------------------------------

  function escapeRegex(str) {
    return (str || '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }

  // Builds a case-insensitive RE2 pattern string (no leading/trailing
  // slashes — DNR's regexFilter field takes the bare pattern).
  function buildRegexFilter(domain, substring) {
    const d = escapeRegex((domain || '').toLowerCase());
    if (!d) return null;
    const s = (substring || '').trim();
    const pattern = s ? `${d}.*${escapeRegex(s.toLowerCase())}` : d;
    return `(?i)${pattern}`;
  }

  const api = {
    getUrlParts,
    ruleMatches,
    matchesAny,
    isEffectivelyBlocked,
    escapeRegex,
    buildRegexFilter
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RulesEngine = api;
  }
})(typeof self !== 'undefined' ? self : this);
