// shared.js
// Pure helpers shared by the service worker, the Rule Book, the popup and the
// gate pages: settings defaults, timer maths, stats/streak maths and the JSONC
// import/export format. No chrome.* calls here (Node tests load it too).

(function (root) {
  'use strict';

  const MINUTE = 60 * 1000;
  const DAY = 24 * 60 * MINUTE;

  const DEFAULT_SETTINGS = {
    reminderStyle: 'universal', // 'universal' | 'faith'
    pauseWaitSeconds: 15, // Pause & Think reflection before typing is allowed
    passMode: 'activity', // 'activity' | 'fixed' | 'endOfDay'
    passGraceMinutes: 5, // activity mode: pass ends this long after you leave the site
    passFixedMinutes: 30, // fixed mode: pass length
    blockedCooldownMinutes: 30, // wait before a Blocked rule can be paused
    pendingCooldown: null, // { minutes, effectiveAt }: a staged shorter cooldown
    minutesPerGate: 10 // estimate of time reclaimed per gate held
  };

  const LIMITS = {
    pauseWaitSeconds: [3, 300],
    passGraceMinutes: [1, 120],
    passFixedMinutes: [1, 720],
    blockedCooldownMinutes: [5, 1440],
    minutesPerGate: [1, 120]
  };

  function clamp(n, [lo, hi]) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
  }

  function mergeSettings(stored) {
    const s = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    for (const k of Object.keys(LIMITS)) s[k] = clamp(s[k], LIMITS[k]);
    if (!['universal', 'faith'].includes(s.reminderStyle)) s.reminderStyle = 'universal';
    if (!['activity', 'fixed', 'endOfDay'].includes(s.passMode)) s.passMode = 'activity';
    return s;
  }

  // A shorter cooldown only takes effect once the old cooldown has fully
  // elapsed, so lowering it can never be used to skip a wait.
  function effectiveCooldownMinutes(settings, now) {
    const s = mergeSettings(settings);
    const p = s.pendingCooldown;
    if (p && p.effectiveAt <= now) return clamp(p.minutes, LIMITS.blockedCooldownMinutes);
    return s.blockedCooldownMinutes;
  }

  // Returns the new settings object after asking for a cooldown change.
  function requestCooldownChange(settings, minutes, now) {
    const s = mergeSettings(settings);
    const target = clamp(minutes, LIMITS.blockedCooldownMinutes);
    const current = effectiveCooldownMinutes(s, now);
    if (target >= current) {
      return Object.assign({}, s, { blockedCooldownMinutes: target, pendingCooldown: null });
    }
    return Object.assign({}, s, {
      blockedCooldownMinutes: current,
      pendingCooldown: { minutes: target, effectiveAt: now + current * MINUTE }
    });
  }

  // Folds a pending cooldown into the real value once it is due.
  function settleSettings(settings, now) {
    const s = mergeSettings(settings);
    if (s.pendingCooldown && s.pendingCooldown.effectiveAt <= now) {
      return { settings: Object.assign({}, s, { blockedCooldownMinutes: effectiveCooldownMinutes(s, now), pendingCooldown: null }), changed: true };
    }
    return { settings: s, changed: false };
  }

  function endOfDay(now) {
    const d = new Date(now);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  // Mon–Thu lock -> unlocks Friday 18:00 (holds through the weekend);
  // Fri/Sat/Sun lock -> flat 24 hours.
  function computeLockUntil(now) {
    const d = new Date(now);
    const day = d.getDay();
    if (day >= 1 && day <= 4) {
      const target = new Date(d);
      target.setDate(d.getDate() + (5 - day));
      target.setHours(18, 0, 0, 0);
      return target.getTime();
    }
    return d.getTime() + DAY;
  }

  // Pause & Think: reflection seconds and the pass a rule grants.
  function resolveWaitSeconds(rule, settings) {
    const s = mergeSettings(settings);
    if (rule && rule.waitSeconds != null && rule.waitSeconds !== '') {
      return clamp(rule.waitSeconds, LIMITS.pauseWaitSeconds);
    }
    return s.pauseWaitSeconds;
  }

  function resolvePass(rule, settings, now) {
    const s = mergeSettings(settings);
    const mode = (rule && rule.passMode) || s.passMode;
    const minutes = rule && rule.passMinutes != null && rule.passMinutes !== '' ? Number(rule.passMinutes) : null;
    if (mode === 'endOfDay') return { mode: 'fixed', expiresAt: endOfDay(now), label: 'until the end of today' };
    if (mode === 'fixed') {
      const m = clamp(minutes != null ? minutes : s.passFixedMinutes, LIMITS.passFixedMinutes);
      return { mode: 'fixed', expiresAt: now + m * MINUTE, label: `for ${formatMinutes(m)}` };
    }
    const g = clamp(minutes != null ? minutes : s.passGraceMinutes, LIMITS.passGraceMinutes);
    return { mode: 'activity', graceMs: g * MINUTE, label: `while you stay on it, ending ${formatMinutes(g)} after you leave` };
  }

  function describePass(rule, settings) {
    return resolvePass(rule, settings, Date.now()).label;
  }

  function sessionExpired(session, now) {
    if (!session) return true;
    if (session.mode === 'fixed') return now >= (session.expiresAt || 0);
    const grace = session.graceMs || 5 * MINUTE;
    return now - (session.lastActiveAt || session.activatedAt || 0) >= grace;
  }

  function sessionEndsAt(session) {
    if (!session) return null;
    if (session.mode === 'fixed') return session.expiresAt || null;
    return (session.lastActiveAt || session.activatedAt || 0) + (session.graceMs || 5 * MINUTE);
  }

  function formatMinutes(m) {
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }

  function formatDuration(ms) {
    if (ms <= 0) return '0:00';
    const total = Math.ceil(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------
  // Stats. stats = { since, days: { 'YYYY-MM-DD': DayStats }, lastSlipDay, bestStreak }
  // DayStats = { blocked, paused, walkAways, goThroughs, rulePauses }
  //   "gates held" = blocked page views + Pause & Think walk-aways
  //   "slips"      = going through a Pause & Think gate or pausing a Blocked rule
  // ---------------------------------------------------------------------

  const EVENT_FIELDS = {
    'blocked-view': 'blocked',
    'pause-view': 'paused',
    'walk-away': 'walkAways',
    'go-through': 'goThroughs',
    'rule-paused': 'rulePauses'
  };
  const SLIP_EVENTS = new Set(['go-through', 'rule-paused']);
  const KEEP_DAYS = 90;

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function keyToDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function daysBetween(aKey, bKey) {
    return Math.round((keyToDate(bKey) - keyToDate(aKey)) / DAY);
  }

  function emptyDay() {
    return { blocked: 0, paused: 0, walkAways: 0, goThroughs: 0, rulePauses: 0 };
  }

  function emptyStats(now) {
    return { since: now, days: {}, lastSlipDay: null, bestStreak: 0 };
  }

  function currentStreak(stats, now) {
    const s = stats || emptyStats(now);
    const today = dayKey(now);
    if (s.lastSlipDay) return Math.max(0, daysBetween(s.lastSlipDay, today));
    return daysBetween(dayKey(s.since || now), today) + 1;
  }

  function recordEvent(stats, event, now) {
    const field = EVENT_FIELDS[event];
    const s = stats && stats.days ? JSON.parse(JSON.stringify(stats)) : emptyStats(now);
    if (!field) return s;
    const key = dayKey(now);
    if (SLIP_EVENTS.has(event)) {
      s.bestStreak = Math.max(s.bestStreak || 0, currentStreak(s, now));
      s.lastSlipDay = key;
    }
    s.days[key] = Object.assign(emptyDay(), s.days[key]);
    s.days[key][field] += 1;

    const cutoff = dayKey(now - KEEP_DAYS * DAY);
    for (const k of Object.keys(s.days)) if (k < cutoff) delete s.days[k];
    return s;
  }

  function gatesHeld(day) {
    return day ? (day.blocked || 0) + (day.walkAways || 0) : 0;
  }

  function slips(day) {
    return day ? (day.goThroughs || 0) + (day.rulePauses || 0) : 0;
  }

  function summarizeStats(stats, now, settings) {
    const s = stats && stats.days ? stats : emptyStats(now);
    const minutesPerGate = mergeSettings(settings).minutesPerGate;
    const today = s.days[dayKey(now)] || emptyDay();
    let totalHeld = 0;
    let totalSlips = 0;
    let totalWalkAways = 0;
    let totalPauseViews = 0;
    for (const d of Object.values(s.days)) {
      totalHeld += gatesHeld(d);
      totalSlips += slips(d);
      totalWalkAways += d.walkAways || 0;
      totalPauseViews += d.paused || 0;
    }
    const streak = currentStreak(s, now);
    const series = [];
    for (let i = 29; i >= 0; i--) {
      const key = dayKey(now - i * DAY);
      const d = s.days[key] || emptyDay();
      series.push({ key, held: gatesHeld(d), slips: slips(d) });
    }
    return {
      today: { held: gatesHeld(today), slips: slips(today), walkAways: today.walkAways || 0, goThroughs: today.goThroughs || 0 },
      totalHeld,
      totalSlips,
      walkAwayRate: totalPauseViews ? Math.round((totalWalkAways / totalPauseViews) * 100) : null,
      streak,
      bestStreak: Math.max(s.bestStreak || 0, streak),
      minutesReclaimed: totalHeld * minutesPerGate,
      series
    };
  }

  // ---------------------------------------------------------------------
  // JSONC import / export. Entries may be the old positional arrays
  //   BLOCKED: [domain, substring?, message?]
  //   PAUSE_AND_THINK / EXCLUDED: [domain, substring?, note?]
  // or objects carrying the newer optional fields. Export writes arrays when
  // a rule has no extra fields, so old files and new files stay compatible.
  // ---------------------------------------------------------------------

  function parseJsonc(text) {
    let out = String(text).replace(/\/\*[\s\S]*?\*\//g, '');
    out = out.replace(/("(?:[^"\\]|\\.)*")|\/\/.*$/gm, (m, str) => (str ? str : ''));
    out = out.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(out);
  }

  function uuid() {
    if (root.crypto && root.crypto.randomUUID) return root.crypto.randomUUID();
    return 'r-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function cleanSchedule(s) {
    if (!s || typeof s !== 'object') return null;
    const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => d >= 0 && d <= 6))] : [];
    const time = /^([01]?\d|2[0-3]):[0-5]\d$/;
    const sched = { days, start: String(s.start || ''), end: String(s.end || '') };
    return days.length && time.test(sched.start) && time.test(sched.end) ? sched : null;
  }

  function makeRule(list, fields) {
    const f = fields || {};
    const base = {
      id: uuid(),
      domain: String(f.domain || '').trim(),
      substring: String(f.substring || '').trim(),
      schedule: cleanSchedule(f.schedule)
    };
    if (list === 'blocked') {
      return Object.assign(base, {
        message: String(f.message || '').trim(),
        locked: false,
        lockedUntil: null,
        paused: false,
        pausedUntil: null,
        pendingPause: null
      });
    }
    const rule = Object.assign(base, { note: String(f.note || '').trim() });
    if (list === 'pauseAndThink') {
      rule.waitSeconds = f.waitSeconds != null && f.waitSeconds !== '' ? Number(f.waitSeconds) : null;
      rule.passMode = ['activity', 'fixed', 'endOfDay'].includes(f.passMode) ? f.passMode : null;
      rule.passMinutes = f.passMinutes != null && f.passMinutes !== '' ? Number(f.passMinutes) : null;
    }
    return rule;
  }

  function entryToRule(list, entry) {
    if (Array.isArray(entry)) {
      const [domain, substring, third] = entry;
      return makeRule(list, list === 'blocked' ? { domain, substring, message: third } : { domain, substring, note: third });
    }
    return makeRule(list, entry || {});
  }

  function ruleToEntry(list, r) {
    const extras = {};
    if (r.schedule) extras.schedule = r.schedule;
    if (list === 'pauseAndThink') {
      if (r.waitSeconds != null) extras.waitSeconds = r.waitSeconds;
      if (r.passMode) extras.passMode = r.passMode;
      if (r.passMinutes != null) extras.passMinutes = r.passMinutes;
    }
    const third = list === 'blocked' ? r.message : r.note;
    if (Object.keys(extras).length) {
      const obj = { domain: r.domain, substring: r.substring || '' };
      if (third) obj[list === 'blocked' ? 'message' : 'note'] = third;
      return Object.assign(obj, extras);
    }
    return third ? [r.domain, r.substring || '', third] : [r.domain, r.substring || ''];
  }

  const LIST_KEYS = { blocked: 'BLOCKED', pauseAndThink: 'PAUSE_AND_THINK', excluded: 'EXCLUDED' };

  function parseRuleBook(text) {
    const parsed = parseJsonc(text);
    const out = {};
    for (const [list, key] of Object.entries(LIST_KEYS)) {
      out[list] = (Array.isArray(parsed[key]) ? parsed[key] : []).map((e) => entryToRule(list, e)).filter((r) => r.domain);
    }
    out.settings = parsed.SETTINGS && typeof parsed.SETTINGS === 'object' ? parsed.SETTINGS : null;
    return out;
  }

  function serializeRuleBook(state, settings, now) {
    const payload = {};
    for (const [list, key] of Object.entries(LIST_KEYS)) {
      payload[key] = (state[list] || []).map((r) => ruleToEntry(list, r));
    }
    if (settings) {
      const s = mergeSettings(settings);
      payload.SETTINGS = {
        reminderStyle: s.reminderStyle,
        pauseWaitSeconds: s.pauseWaitSeconds,
        passMode: s.passMode,
        passGraceMinutes: s.passGraceMinutes,
        passFixedMinutes: s.passFixedMinutes,
        minutesPerGate: s.minutesPerGate
      };
    }
    return `// Exported from Gates Of Heaven & Hell — ${new Date(now).toISOString()}\n${JSON.stringify(payload, null, 2)}\n`;
  }

  // Settings that are safe to import. The Blocked cooldown is never imported:
  // it can only be lowered through the staged path in the Settings tab.
  function importableSettings(imported) {
    if (!imported) return {};
    const allowed = ['reminderStyle', 'pauseWaitSeconds', 'passMode', 'passGraceMinutes', 'passFixedMinutes', 'minutesPerGate'];
    const out = {};
    for (const k of allowed) if (imported[k] != null) out[k] = imported[k];
    return out;
  }

  const api = {
    MINUTE,
    DAY,
    DEFAULT_SETTINGS,
    LIMITS,
    clamp,
    mergeSettings,
    effectiveCooldownMinutes,
    requestCooldownChange,
    settleSettings,
    endOfDay,
    computeLockUntil,
    resolveWaitSeconds,
    resolvePass,
    describePass,
    sessionExpired,
    sessionEndsAt,
    formatMinutes,
    formatDuration,
    dayKey,
    emptyStats,
    recordEvent,
    currentStreak,
    summarizeStats,
    parseJsonc,
    makeRule,
    entryToRule,
    ruleToEntry,
    parseRuleBook,
    serializeRuleBook,
    importableSettings,
    cleanSchedule
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Shared = api;
  }
})(typeof self !== 'undefined' ? self : this);
