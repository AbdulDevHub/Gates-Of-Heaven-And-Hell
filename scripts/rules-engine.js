// rules-engine.js
// Pure, dependency-free helpers shared by background.js (service worker),
// content-youtube.js (content script), and blocked.js. No chrome.* calls in here —
// keep this file environment-agnostic so all contexts can load it as-is.

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
  // in the YouTube content script and blocked page for matching rules.
  // Host OR full URL must contain the domain string; if a substring is given,
  // it must also appear anywhere in the full URL.
  // ---------------------------------------------------------------------

  function ruleMatches(urlParts, rule) {
    let domain = '';
    let sub = '';
    if (Array.isArray(rule)) {
      domain = (rule[0] || '').toLowerCase();
      sub = (rule[1] || '').toLowerCase();
    } else if (rule && typeof rule === 'object') {
      domain = (rule.domain || '').toLowerCase();
      sub = (rule.substring || '').toLowerCase();
    }

    if (!domain) return false;

    const hostMatch = urlParts.host.includes(domain) || urlParts.full.includes(domain);
    if (!hostMatch) return false;

    if (!sub) return true;
    return urlParts.full.includes(sub);
  }

  function findMatchingRule(url, rules) {
    if (!rules || !rules.length) return null;
    const parts = getUrlParts(url);
    return rules.find((rule) => ruleMatches(parts, rule)) || null;
  }

  function matchesAny(url, rules) {
    return Boolean(findMatchingRule(url, rules));
  }

  // Precedence order:
  // 1. EXCLUDED always wins unconditionally (returns false for blocked).
  // 2. PAUSE_AND_THINK overrides BLOCKED.
  function isEffectivelyBlocked(url, blockedRules, excludedRules) {
    if (matchesAny(url, excludedRules)) return false;
    return matchesAny(url, blockedRules);
  }

  // Evaluates URL state against all rule tiers:
  // Returns: 'excluded' | 'pause' | 'blocked' | 'none'
  function evaluateUrl(url, { blocked = [], excluded = [], pauseAndThink = [] } = {}) {
    if (matchesAny(url, excluded)) return 'excluded';
    if (matchesAny(url, pauseAndThink)) return 'pause';
    if (matchesAny(url, blocked)) return 'blocked';
    return 'none';
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

  // Builds a case-insensitive RE2 pattern string. Anchored to
  // require an http(s) scheme so this can NEVER match a chrome-extension://
  // URL. Captures the full matched URL as group 1 (\1) for regexSubstitution.
  function buildRegexFilter(domain, substring) {
    const d = escapeRegex((domain || '').toLowerCase());
    if (!d) return null;
    const s = (substring || '').trim();
    const pattern = s ? `${d}.*${escapeRegex(s.toLowerCase())}` : d;
    return `(?i)^(https?://.*${pattern}.*)`;
  }

  const api = {
    getUrlParts,
    ruleMatches,
    findMatchingRule,
    matchesAny,
    isEffectivelyBlocked,
    evaluateUrl,
    escapeRegex,
    buildRegexFilter
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RulesEngine = api;
  }
})(typeof self !== 'undefined' ? self : this);
