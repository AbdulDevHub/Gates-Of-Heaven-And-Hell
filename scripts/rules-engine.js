// rules-engine.js
// Pure, dependency-free matching logic shared by background.js (service worker),
// content-youtube.js (content script), the gate pages, the popup and the Rule Book.
// No chrome.* calls in here, so every context (and Node tests) can load it as-is.

(function (root) {
  'use strict';

  // ---------------------------------------------------------------------
  // Domain normalisation
  // A rule "domain" is a host with an optional path prefix:
  //   "reddit.com"            any page on reddit.com or a subdomain of it
  //   "google.com/search"     only paths starting with /search
  //   "*"                     any site (pair it with a substring)
  // ---------------------------------------------------------------------

  function normalizeDomain(input) {
    let d = String(input || '').trim().toLowerCase();
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
    d = d.replace(/^\*\.(?=.)/, ''); // "*.example.com" -> "example.com"
    d = d.replace(/^www\./, '');
    d = d.replace(/\/+$/, '');
    return d;
  }

  function splitDomain(domain) {
    const d = normalizeDomain(domain);
    const slash = d.indexOf('/');
    let host = slash < 0 ? d : d.slice(0, slash);
    const path = slash < 0 ? '' : d.slice(slash);
    host = host.replace(/:\d+$/, '');
    return { host, path };
  }

  // ---------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------

  function getUrlParts(url) {
    try {
      const u = new URL(url);
      const rest = (u.pathname + u.search + u.hash).toLowerCase();
      return {
        host: u.hostname.toLowerCase(),
        rest,
        full: String(url).toLowerCase(),
        isWeb: u.protocol === 'http:' || u.protocol === 'https:'
      };
    } catch {
      return { host: '', rest: '', full: String(url || '').toLowerCase(), isWeb: false };
    }
  }

  function ruleFields(rule) {
    if (Array.isArray(rule)) return { domain: rule[0] || '', substring: rule[1] || '' };
    if (rule && typeof rule === 'object') return { domain: rule.domain || '', substring: rule.substring || '' };
    return { domain: '', substring: '' };
  }

  // Google search rules only look at the query text (q=), not the long opaque
  // tracking params (fbs, sxsrf, ved...) that Google's AI mode adds.
  function isSearchRule(domain) {
    return /(^|\.)google\.[a-z.]+\/search/.test(normalizeDomain(domain));
  }

  function decodeQueryValue(raw) {
    const spaced = raw.replace(/\+/g, ' ');
    try { return decodeURIComponent(spaced).toLowerCase(); } catch { return spaced.toLowerCase(); }
  }

  function hostMatches(urlHost, ruleHost) {
    if (!ruleHost) return false;
    if (ruleHost === '*') return true;
    return urlHost === ruleHost || urlHost.endsWith('.' + ruleHost);
  }

  // Precise AND-matching: host equals the rule host or is a subdomain of it,
  // the URL path starts with the rule's path (if any), and the substring (if
  // any) appears after the host. Spaces in a substring match "+", "%20" or " ".
  function ruleMatches(urlParts, rule) {
    if (!urlParts || !urlParts.isWeb) return false;
    const { domain, substring } = ruleFields(rule);
    const { host, path } = splitDomain(domain);
    if (!hostMatches(urlParts.host, host)) return false;
    if (path && !urlParts.rest.startsWith(path)) return false;

    const sub = String(substring || '').trim().toLowerCase();
    if (!sub) return true;

    if (isSearchRule(domain)) {
      const m = urlParts.rest.match(/[?&]q=([^&#]*)/);
      return m ? decodeQueryValue(m[1]).includes(sub) : false;
    }
    if (urlParts.rest.includes(sub)) return true;
    const spaced = urlParts.rest.replace(/\+|%20/g, ' ');
    if (spaced.includes(sub)) return true;
    try { return decodeURIComponent(spaced).includes(sub); } catch { return false; }
  }

  function findMatchingRule(url, rules) {
    if (!rules || !rules.length) return null;
    const parts = getUrlParts(url);
    return rules.find((rule) => ruleMatches(parts, rule)) || null;
  }

  function matchesAny(url, rules) {
    return Boolean(findMatchingRule(url, rules));
  }

  // ---------------------------------------------------------------------
  // Schedules: { days: [0..6] (0 = Sunday), start: "HH:MM", end: "HH:MM" }.
  // start === end means all day on the listed days; start > end wraps past
  // midnight (e.g. 22:00-06:00). No schedule means always active.
  // ---------------------------------------------------------------------

  function toMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function isValidSchedule(schedule) {
    return Boolean(
      schedule &&
      Array.isArray(schedule.days) &&
      schedule.days.length > 0 &&
      toMinutes(schedule.start) !== null &&
      toMinutes(schedule.end) !== null
    );
  }

  function isScheduleActive(schedule, date) {
    if (!isValidSchedule(schedule)) return true;
    const d = date instanceof Date ? date : new Date(date);
    const day = d.getDay();
    const prevDay = (day + 6) % 7;
    const now = d.getHours() * 60 + d.getMinutes();
    const start = toMinutes(schedule.start);
    const end = toMinutes(schedule.end);
    const has = (x) => schedule.days.includes(x);

    if (start === end) return has(day);
    if (start < end) return has(day) && now >= start && now < end;
    return (has(day) && now >= start) || (has(prevDay) && now < end);
  }

  // Earliest moment after `now` at which any rule's schedule could flip.
  function nextScheduleBoundary(rules, now) {
    let best = null;
    for (const rule of rules || []) {
      if (!rule || !isValidSchedule(rule.schedule)) continue;
      const marks = [toMinutes(rule.schedule.start), toMinutes(rule.schedule.end)];
      for (let offset = 0; offset <= 8; offset++) {
        for (const mins of marks) {
          const t = new Date(now);
          t.setDate(t.getDate() + offset);
          t.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
          const ts = t.getTime();
          if (ts > now && (best === null || ts < best)) best = ts;
        }
      }
    }
    return best;
  }

  function describeSchedule(schedule) {
    if (!isValidSchedule(schedule)) return 'Always';
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = [...schedule.days].sort((a, b) => a - b);
    let dayText;
    const key = days.join(',');
    if (key === '0,1,2,3,4,5,6') dayText = 'Every day';
    else if (key === '1,2,3,4,5') dayText = 'Mon–Fri';
    else if (key === '0,6') dayText = 'Weekends';
    else dayText = days.map((d) => names[d]).join(' ');
    const time = schedule.start === schedule.end ? 'all day' : `${schedule.start}–${schedule.end}`;
    return `${dayText} ${time}`;
  }

  function isRulePaused(rule, now) {
    if (!rule || !rule.paused) return false;
    return !rule.pausedUntil || rule.pausedUntil > now;
  }

  // A rule takes part in matching right now (schedule on, not paused).
  function isRuleLive(rule, now) {
    return !isRulePaused(rule, now) && isScheduleActive(rule && rule.schedule, new Date(now));
  }

  function sessionCovers(parts, session) {
    if (!session) return false;
    return ruleMatches(parts, [session.domain, session.substring]);
  }

  // ---------------------------------------------------------------------
  // explainUrl: what happens to this URL right now, and why.
  // Mirrors the DNR priority layers built in background.js:
  //   EXCLUDED (4) > active pass (3) > PAUSE_AND_THINK (2) > BLOCKED (1)
  // ---------------------------------------------------------------------

  function explainUrl(url, state, now) {
    const t = typeof now === 'number' ? now : Date.now();
    const {
      blocked = [],
      excluded = [],
      pauseAndThink = [],
      pauseSessions = []
    } = state || {};
    const parts = getUrlParts(url);
    const notes = [];

    if (!parts.isWeb) {
      return { verdict: 'none', reason: 'Only http and https pages can be gated.', notes, rule: null, list: null };
    }

    const exc = excluded.find((r) => isRuleLive(r, t) && ruleMatches(parts, r));
    if (exc) {
      return { verdict: 'excluded', list: 'excluded', rule: exc, reason: 'An exception matches. Exceptions always win.', notes };
    }

    const pauseRule = pauseAndThink.find((r) => isRuleLive(r, t) && ruleMatches(parts, r));
    const session = pauseSessions.find((s) => sessionCovers(parts, s));

    if (session) {
      return {
        verdict: 'pass',
        list: 'pauseAndThink',
        rule: pauseRule || null,
        session,
        reason: 'You went through a Pause & Think gate. The pass is still open.',
        notes
      };
    }

    if (pauseRule) {
      return { verdict: 'pause', list: 'pauseAndThink', rule: pauseRule, reason: 'A Pause & Think rule matches.', notes };
    }

    const blockedRule = blocked.find((r) => isRuleLive(r, t) && ruleMatches(parts, r));
    if (blockedRule) {
      return { verdict: 'blocked', list: 'blocked', rule: blockedRule, reason: 'A Blocked rule matches.', notes };
    }

    // Nothing gates this URL. Explain the near misses so a confusing rule
    // (like a label typed into the substring box) is easy to spot.
    const tiers = [
      ['blocked', blocked],
      ['pauseAndThink', pauseAndThink],
      ['excluded', excluded]
    ];
    for (const [list, rules] of tiers) {
      for (const r of rules) {
        const { host, path } = splitDomain(r.domain);
        if (!hostMatches(parts.host, host)) continue;
        if (ruleMatches(parts, r)) {
          if (isRulePaused(r, t)) notes.push({ list, rule: r, text: 'This rule matches but is paused.' });
          else if (!isScheduleActive(r.schedule, new Date(t))) notes.push({ list, rule: r, text: `This rule matches but is off-schedule (${describeSchedule(r.schedule)}).` });
        } else if (path && !parts.rest.startsWith(path)) {
          notes.push({ list, rule: r, text: `Same site, but this rule only covers paths starting with "${path}".` });
        } else if (r.substring) {
          notes.push({ list, rule: r, text: `Same site, but the URL doesn't contain "${r.substring}".` });
        }
      }
    }
    return { verdict: 'none', list: null, rule: null, reason: 'No rule gates this page.', notes };
  }

  // Legacy helpers kept for older callers.
  function isEffectivelyBlocked(url, blockedRules, excludedRules) {
    if (matchesAny(url, excludedRules)) return false;
    return matchesAny(url, blockedRules);
  }

  function evaluateUrl(url, { blocked = [], excluded = [], pauseAndThink = [] } = {}) {
    if (matchesAny(url, excluded)) return 'excluded';
    if (matchesAny(url, pauseAndThink)) return 'pause';
    if (matchesAny(url, blocked)) return 'blocked';
    return 'none';
  }

  // ---------------------------------------------------------------------
  // Rule lint: catches rules that probably don't do what was intended.
  // Returns [{ code, text, fix? }]. `fix` names a one-click repair the UI offers.
  // ---------------------------------------------------------------------

  function lintRule(rule, list, all) {
    const out = [];
    if (!rule) return out;
    const raw = String(rule.domain || '').trim();
    const { host, path } = splitDomain(raw);
    const sub = String(rule.substring || '').trim();

    if (raw && raw.toLowerCase() !== normalizeDomain(raw)) {
      out.push({ code: 'normalize', text: `Will be saved as "${normalizeDomain(raw)}".`, fix: 'normalize' });
    }

    if (host === '*' && !path && !sub) {
      out.push({ code: 'everything', text: 'Site "*" with no word gates every website. Add a word in the URL.' });
    }

    if (host && host !== '*' && host !== 'localhost' && !host.includes('.')) {
      out.push({ code: 'host', text: `"${host}" isn't a full site name, so this only matches that exact host. To match a word on any site, use domain "*" with a substring.` });
    }

    if (sub && !isSearchRule(raw) && /\s/.test(sub) && /[A-Z]/.test(sub)) {
      const target = list === 'blocked' ? 'message' : 'note';
      out.push({
        code: 'label',
        text: `"${sub}" looks like a label, but it's in the substring box, so only URLs containing it are gated. Move it to the ${target}?`,
        fix: list === 'blocked' ? 'move-to-message' : 'move-to-note'
      });
    }

    const key = (r) => `${normalizeDomain(r.domain)}|${String(r.substring || '').trim().toLowerCase()}`;
    const siblings = (all && all[list]) || [];
    const myKey = key(rule);
    const firstSame = siblings.find((r) => key(r) === myKey);
    if (firstSame && firstSame.id !== rule.id) {
      out.push({ code: 'duplicate', text: 'Duplicate of another rule in this list.', fix: 'delete' });
    }

    if (list !== 'excluded' && all && Array.isArray(all.excluded)) {
      const shadow = all.excluded.find((ex) => {
        if (String(ex.substring || '').trim()) return false;
        const e = splitDomain(ex.domain);
        if (!(e.host === '*' || host === e.host || host.endsWith('.' + e.host))) return false;
        return !e.path || path.startsWith(e.path);
      });
      if (shadow) out.push({ code: 'shadowed', text: `The exception "${shadow.domain}" overrides this rule everywhere.` });
    }

    return out;
  }

  // ---------------------------------------------------------------------
  // Regex compilation for declarativeNetRequest (RE2 engine: no lookarounds,
  // no backreferences). Anchored to an http(s) scheme so it can never match a
  // chrome-extension:// URL. Group 1 (\1) captures the whole URL for the
  // redirect's regexSubstitution.
  // ---------------------------------------------------------------------

  function escapeRegex(str) {
    return (str || '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }

  function buildRegexFilter(domain, substring) {
    const { host, path } = splitDomain(domain);
    if (!host) return null;
    const hostRe = host === '*' ? '[^/?#]*' : `(?:[^/?#]*\\.)?${escapeRegex(host)}`;
    const prefix = `(?i)^(https?://${hostRe}(?::[0-9]+)?`;
    const s = String(substring || '').trim().toLowerCase();

    if (!s) {
      const tail = path ? `${escapeRegex(path)}.*` : '(?:[/?#].*)?';
      return `${prefix}${tail})$`;
    }

    const sp = escapeRegex(s).replace(/ /g, '(?:\\+|%20| )');
    if (path) {
      const body = isSearchRule(domain) ? `.*[?&]q=[^&#]*${sp}.*` : `.*${sp}.*`;
      return `${prefix}${escapeRegex(path)}${body})$`;
    }
    // No path: the URL must leave the host at a / ? or # and the substring
    // must appear after that. A substring that itself starts with / ? or #
    // may sit right at that boundary.
    const after = /^[/?#]/.test(s) ? `(?:${sp}|[/?#].*${sp})` : `[/?#].*${sp}`;
    return `${prefix}${after}.*)$`;
  }

  // Builds a gate page path that carries the original URL as the LAST param,
  // encoded. Pages read it with readTargetUrl(), which also accepts the raw
  // (unencoded) form that DNR's regexSubstitution produces.
  function buildGatePath(page, ruleId, url) {
    const rid = ruleId ? `ruleId=${encodeURIComponent(ruleId)}&` : '';
    return `pages/${page}?${rid}url=${encodeURIComponent(url || '')}`;
  }

  function readTargetUrl(href) {
    const s = String(href || '');
    const q = s.indexOf('?');
    if (q < 0) return null;
    const search = s.slice(q);
    let i = search.indexOf('&url=');
    let start = i + 5;
    if (i < 0) {
      if (search.startsWith('?url=')) start = 5;
      else return null;
    }
    const value = search.slice(start);
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    try { return decodeURIComponent(value); } catch { return value; }
  }

  const api = {
    normalizeDomain,
    splitDomain,
    getUrlParts,
    isSearchRule,
    ruleMatches,
    findMatchingRule,
    matchesAny,
    isEffectivelyBlocked,
    evaluateUrl,
    explainUrl,
    lintRule,
    isValidSchedule,
    isScheduleActive,
    nextScheduleBoundary,
    describeSchedule,
    isRulePaused,
    isRuleLive,
    escapeRegex,
    buildRegexFilter,
    buildGatePath,
    readTargetUrl
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RulesEngine = api;
  }
})(typeof self !== 'undefined' ? self : this);
