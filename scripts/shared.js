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
    minutesPerGate: 10, // estimate of time reclaimed per gate held
    soundEffects: true // gate sounds (synthesized, no audio files)
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
    s.soundEffects = s.soundEffects !== false;
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

  // Per-rule cooldown for Blocked rules. rule.cooldownMinutes null = use the
  // global one. Same staging as the global value: a shorter cooldown (including
  // switching back to a shorter default) only applies after the current one.
  function ruleCooldownMinutes(rule, settings, now) {
    const global = effectiveCooldownMinutes(settings, now);
    if (!rule) return global;
    const p = rule.pendingCooldown;
    if (p && p.effectiveAt <= now) return p.minutes == null ? global : clamp(p.minutes, LIMITS.blockedCooldownMinutes);
    return rule.cooldownMinutes == null ? global : clamp(rule.cooldownMinutes, LIMITS.blockedCooldownMinutes);
  }

  // Returns { cooldownMinutes, pendingCooldown } for a rule after asking for
  // `minutes` (null = back to the default).
  function requestRuleCooldown(rule, minutes, settings, now) {
    const current = ruleCooldownMinutes(rule, settings, now);
    const wanted = minutes == null || minutes === '' ? null : clamp(minutes, LIMITS.blockedCooldownMinutes);
    const target = wanted == null ? effectiveCooldownMinutes(settings, now) : wanted;
    if (target >= current) return { cooldownMinutes: wanted, pendingCooldown: null };
    const settled = rule && rule.pendingCooldown && rule.pendingCooldown.effectiveAt <= now;
    const keep = settled ? rule.pendingCooldown.minutes : rule ? rule.cooldownMinutes : null;
    return {
      cooldownMinutes: keep == null ? current : keep,
      pendingCooldown: { minutes: wanted, effectiveAt: now + current * MINUTE }
    };
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
  // Stats.
  // stats = {
  //   since, lastSlipDay, bestStreak,            // overall (kept for the chart)
  //   days:  { 'YYYY-MM-DD': DayStats },         // last KEEP_DAYS days
  //   rules: { [ruleId]: RuleStats },            // per-rule streaks and counts
  //   hours: number[7][24]                       // gate views by weekday x hour
  // }
  // DayStats  = { blocked, paused, walkAways, goThroughs, rulePauses, unlocked, typed, passMinutes }
  // RuleStats = { list, label, since, views, held, walkAways, goThroughs, rulePauses,
  //               unlocked, typed, passMinutes, lastSlipAt, bestStreak }
  //   "gates held" = blocked page views + Pause & Think walk-aways
  //   "slips"      = going through a Pause & Think gate or pausing a Blocked rule
  // Old stats (no rules/hours) still load: every reader treats them as empty.
  // ---------------------------------------------------------------------

  const EVENT_FIELDS = {
    'blocked-view': 'blocked',
    'pause-view': 'paused',
    'walk-away': 'walkAways',
    'go-through': 'goThroughs',
    'rule-paused': 'rulePauses',
    'gate-unlocked': 'unlocked',
    'phrase-typed': 'typed'
  };
  const RULE_FIELDS = {
    'blocked-view': ['views', 'held'],
    'pause-view': ['views'],
    'walk-away': ['walkAways', 'held'],
    'go-through': ['goThroughs'],
    'rule-paused': ['rulePauses'],
    'gate-unlocked': ['unlocked'],
    'phrase-typed': ['typed']
  };
  const SLIP_EVENTS = new Set(['go-through', 'rule-paused']);
  const VIEW_EVENTS = new Set(['blocked-view', 'pause-view']);
  const KEEP_DAYS = 365;

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
    return { blocked: 0, paused: 0, walkAways: 0, goThroughs: 0, rulePauses: 0, unlocked: 0, typed: 0, passMinutes: 0 };
  }

  function emptyHours() {
    return Array.from({ length: 7 }, () => new Array(24).fill(0));
  }

  function emptyRuleStats(now, info) {
    const i = info || {};
    return {
      list: i.list || null,
      label: i.label || '',
      since: i.since || now,
      views: 0,
      held: 0,
      walkAways: 0,
      goThroughs: 0,
      rulePauses: 0,
      unlocked: 0,
      typed: 0,
      passMinutes: 0,
      lastSlipAt: null,
      bestStreak: 0
    };
  }

  function emptyStats(now) {
    return { since: now, days: {}, lastSlipDay: null, bestStreak: 0, rules: {}, hours: emptyHours() };
  }

  function currentStreak(stats, now) {
    const s = stats || emptyStats(now);
    const today = dayKey(now);
    if (s.lastSlipDay) return Math.max(0, daysBetween(s.lastSlipDay, today));
    return daysBetween(dayKey(s.since || now), today) + 1;
  }

  // Days since this rule last slipped (0 = slipped today). A rule that never
  // slipped counts from when it was created or stats began, whichever is later.
  function ruleStreak(stats, ruleId, now, rule) {
    const s = stats && stats.days ? stats : emptyStats(now);
    const r = (s.rules || {})[ruleId];
    const today = dayKey(now);
    if (r && r.lastSlipAt) return Math.max(0, daysBetween(dayKey(r.lastSlipAt), today));
    const start = Math.max(s.since || now, (rule && rule.createdAt) || 0);
    return Math.max(0, daysBetween(dayKey(Math.min(start, now)), today)) + 1;
  }

  function ruleLabelOf(rule) {
    if (!rule) return '';
    const d = String(rule.domain || '').trim();
    return rule.substring ? `${d} · ${rule.substring}` : d;
  }

  // info = { ruleId, list, label, createdAt } (all optional).
  function recordEvent(stats, event, now, info) {
    const field = EVENT_FIELDS[event];
    const s = stats && stats.days ? JSON.parse(JSON.stringify(stats)) : emptyStats(now);
    if (!s.rules) s.rules = {};
    if (!Array.isArray(s.hours) || s.hours.length !== 7) s.hours = emptyHours();
    if (!field) return s;
    const key = dayKey(now);
    const i = info || {};

    // Undo info so "Clear last hour / today" can take this event back out.
    const entry = { at: now, e: event };

    if (i.ruleId) {
      entry.r = i.ruleId;
      if (!s.rules[i.ruleId]) entry.newRule = true;
      const r = Object.assign(emptyRuleStats(now, { list: i.list, label: i.label }), s.rules[i.ruleId]);
      if (i.list) r.list = i.list;
      if (i.label) r.label = i.label;
      if (SLIP_EVENTS.has(event)) {
        entry.rSlip = r.lastSlipAt;
        entry.rBest = r.bestStreak || 0;
        r.bestStreak = Math.max(r.bestStreak || 0, ruleStreak(s, i.ruleId, now, { createdAt: i.createdAt }));
        r.lastSlipAt = now;
      }
      for (const f of RULE_FIELDS[event] || []) r[f] = (r[f] || 0) + 1;
      s.rules[i.ruleId] = r;
    }

    if (SLIP_EVENTS.has(event)) {
      entry.slipDay = s.lastSlipDay;
      entry.best = s.bestStreak || 0;
      s.bestStreak = Math.max(s.bestStreak || 0, currentStreak(s, now));
      s.lastSlipDay = key;
    }
    pushLog(s, entry, now);
    if (VIEW_EVENTS.has(event)) {
      const d = new Date(now);
      s.hours[d.getDay()][d.getHours()] += 1;
    }
    s.days[key] = Object.assign(emptyDay(), s.days[key]);
    s.days[key][field] += 1;

    const cutoff = dayKey(now - KEEP_DAYS * DAY);
    for (const k of Object.keys(s.days)) if (k < cutoff) delete s.days[k];
    return s;
  }

  // Minutes spent on a pass, added when the pass ends.
  function recordPassTime(stats, ruleId, minutes, now, info) {
    const s = stats && stats.days ? JSON.parse(JSON.stringify(stats)) : emptyStats(now);
    if (!s.rules) s.rules = {};
    const m = Math.max(0, Math.round(Number(minutes) || 0));
    if (!m) return s;
    const key = dayKey(now);
    s.days[key] = Object.assign(emptyDay(), s.days[key]);
    s.days[key].passMinutes += m;
    const entry = { at: now, e: 'pass-time', m };
    if (ruleId) {
      const i = info || {};
      entry.r = ruleId;
      if (!s.rules[ruleId]) entry.newRule = true;
      const r = Object.assign(emptyRuleStats(now, { list: 'pauseAndThink', label: i.label }), s.rules[ruleId]);
      r.passMinutes = (r.passMinutes || 0) + m;
      s.rules[ruleId] = r;
    }
    pushLog(s, entry, now);
    return s;
  }

  // A short event log (last 2 days) used only to undo recent events.
  const LOG_KEEP = 2 * DAY;
  function pushLog(s, entry, now) {
    const log = Array.isArray(s.log) ? s.log.filter((x) => x && x.at >= now - LOG_KEEP) : [];
    log.push(entry);
    s.log = log;
  }

  function dec(obj, field, by) {
    if (obj && typeof obj[field] === 'number') obj[field] = Math.max(0, obj[field] - (by == null ? 1 : by));
  }

  // Removes stats recorded since `from` (ms). `from` <= since (or 'all') wipes
  // everything but keeps `since`, so streaks count from the original start.
  // Events from before the log existed can't be taken out of rule rows or the
  // hour heatmap; their day buckets are still cleared.
  function clearStats(stats, from, now) {
    const base = stats && stats.days ? stats : emptyStats(now);
    if (from === 'all' || from <= (base.since || 0)) {
      return Object.assign(emptyStats(now), { since: base.since || now });
    }
    const s = JSON.parse(JSON.stringify(base));
    if (!s.rules) s.rules = {};
    if (!Array.isArray(s.hours) || s.hours.length !== 7) s.hours = emptyHours();
    const log = Array.isArray(s.log) ? s.log : [];
    const undo = log.filter((x) => x && x.at >= from).sort((a, b) => b.at - a.at);
    for (const x of undo) {
      const day = s.days[dayKey(x.at)];
      if (x.e === 'pass-time') {
        dec(day, 'passMinutes', x.m);
        if (x.r) dec(s.rules[x.r], 'passMinutes', x.m);
      } else {
        dec(day, EVENT_FIELDS[x.e]);
        if (VIEW_EVENTS.has(x.e)) {
          const d = new Date(x.at);
          s.hours[d.getDay()][d.getHours()] = Math.max(0, s.hours[d.getDay()][d.getHours()] - 1);
        }
        const r = x.r && s.rules[x.r];
        if (r) {
          for (const f of RULE_FIELDS[x.e] || []) dec(r, f);
          if (SLIP_EVENTS.has(x.e)) {
            r.lastSlipAt = x.rSlip == null ? null : x.rSlip;
            r.bestStreak = x.rBest || 0;
          }
        }
        if (SLIP_EVENTS.has(x.e)) {
          s.lastSlipDay = x.slipDay == null ? null : x.slipDay;
          s.bestStreak = x.best || 0;
        }
      }
      if (x.newRule && x.r) delete s.rules[x.r];
    }
    s.log = log.filter((x) => x && x.at < from);
    // A clear that starts at midnight or earlier empties those whole days.
    for (const k of Object.keys(s.days)) if (keyToDate(k).getTime() >= from) delete s.days[k];
    return s;
  }

  // How long a pass was actually used: activity passes until you last were on
  // the site, fixed passes until now or their end.
  function passMinutesUsed(session, now) {
    if (!session) return 0;
    const start = session.activatedAt || now;
    const end = session.mode === 'fixed' ? Math.min(now, session.expiresAt || now) : Math.min(now, session.lastActiveAt || start);
    return Math.max(0, Math.round((end - start) / MINUTE));
  }

  function gatesHeld(day) {
    return day ? (day.blocked || 0) + (day.walkAways || 0) : 0;
  }

  function slips(day) {
    return day ? (day.goThroughs || 0) + (day.rulePauses || 0) : 0;
  }

  function sumDays(s, fromOffset, toOffset, now, fn) {
    let total = 0;
    for (let i = fromOffset; i <= toOffset; i++) total += fn(s.days[dayKey(now - i * DAY)]);
    return total;
  }

  function ruleRow(s, id, list, label, now, rule, removed) {
    const r = Object.assign(emptyRuleStats(now), (s.rules || {})[id]);
    const streak = ruleStreak(s, id, now, rule);
    const pauseViews = list === 'pauseAndThink' ? r.views : 0;
    return {
      id,
      list,
      label,
      removed,
      streak,
      bestStreak: Math.max(r.bestStreak || 0, streak),
      lastSlipAt: r.lastSlipAt,
      views: r.views,
      held: r.held,
      slips: r.goThroughs + r.rulePauses,
      goThroughs: r.goThroughs,
      walkAways: r.walkAways,
      walkAwayRate: pauseViews ? Math.round((r.walkAways / pauseViews) * 100) : null,
      passMinutes: r.passMinutes
    };
  }

  // Per-rule rows for the leaderboard. `rules` = [{ list, rule }] currently in
  // the Rule Book; rules that only exist in stats show as removed.
  function ruleBoard(stats, rules, now) {
    const s = stats && stats.days ? stats : emptyStats(now);
    const seen = new Set();
    const rows = [];
    for (const { list, rule } of rules || []) {
      if (list === 'excluded') continue;
      seen.add(rule.id);
      rows.push(ruleRow(s, rule.id, list, ruleLabelOf(rule), now, rule, false));
    }
    for (const [id, r] of Object.entries(s.rules || {})) {
      if (seen.has(id)) continue;
      rows.push(ruleRow(s, id, r.list, r.label || '(removed rule)', now, null, true));
    }
    return rows;
  }

  function summarizeStats(stats, now, settings, rules) {
    const s = stats && stats.days ? stats : emptyStats(now);
    const minutesPerGate = mergeSettings(settings).minutesPerGate;
    const today = s.days[dayKey(now)] || emptyDay();
    let totalHeld = 0;
    let totalSlips = 0;
    let totalWalkAways = 0;
    let totalPauseViews = 0;
    let passMinutes = 0;
    const funnel = { seen: 0, waited: 0, typed: 0, through: 0, walkedAway: 0 };
    for (const d of Object.values(s.days)) {
      totalHeld += gatesHeld(d);
      totalSlips += slips(d);
      totalWalkAways += d.walkAways || 0;
      totalPauseViews += d.paused || 0;
      funnel.seen += d.paused || 0;
      funnel.waited += d.unlocked || 0;
      funnel.typed += d.typed || 0;
      funnel.through += d.goThroughs || 0;
      funnel.walkedAway += d.walkAways || 0;
      passMinutes += d.passMinutes || 0;
    }
    const streak = currentStreak(s, now);
    const daySeries = (n) => {
      const out = [];
      for (let i = n - 1; i >= 0; i--) {
        const key = dayKey(now - i * DAY);
        const d = s.days[key] || emptyDay();
        out.push({ key, held: gatesHeld(d), slips: slips(d) });
      }
      return out;
    };
    const board = ruleBoard(s, rules, now);
    const live = board.filter((r) => !r.removed);
    const longest = live.reduce((best, r) => (!best || r.streak > best.streak ? r : best), null);
    return {
      today: { held: gatesHeld(today), walkAways: today.walkAways || 0 },
      totalHeld,
      totalSlips,
      walkAwayRate: totalPauseViews ? Math.round((totalWalkAways / totalPauseViews) * 100) : null,
      streak,
      bestStreak: Math.max(s.bestStreak || 0, streak),
      minutesReclaimed: totalHeld * minutesPerGate,
      passMinutes,
      week: {
        held: sumDays(s, 0, 6, now, gatesHeld),
        prevHeld: sumDays(s, 7, 13, now, gatesHeld),
        slips: sumDays(s, 0, 6, now, slips),
        prevSlips: sumDays(s, 7, 13, now, slips)
      },
      funnel,
      hours: Array.isArray(s.hours) && s.hours.length === 7 ? s.hours : emptyHours(),
      board,
      longestStreak: longest,
      rulesOnStreak: live.filter((r) => r.streak > 0).length,
      series: daySeries(30),
      year: daySeries(KEEP_DAYS)
    };
  }

  // The phrase typed to go through a Pause & Think gate: the rule's note if it
  // has one, otherwise the default. Exact and case-sensitive.
  const DEFAULT_PHRASE = 'Yes I Am Sure';
  function gatePhrase(rule) {
    const note = rule && typeof rule.note === 'string' ? rule.note.trim() : '';
    return note || DEFAULT_PHRASE;
  }

  // "3 min ago", "5 h ago", "6 days ago".
  function formatAgo(ts, now) {
    const ms = Math.max(0, now - ts);
    const m = Math.floor(ms / MINUTE);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.floor(h / 24);
    return `${d} ${d === 1 ? 'day' : 'days'} ago`;
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
      schedule: cleanSchedule(f.schedule),
      createdAt: Number(f.createdAt) || Date.now()
    };
    if (list === 'blocked') {
      const cd = f.cooldownMinutes != null && f.cooldownMinutes !== '' ? clamp(f.cooldownMinutes, LIMITS.blockedCooldownMinutes) : null;
      return Object.assign(base, {
        message: String(f.message || '').trim(),
        cooldownMinutes: cd,
        pendingCooldown: null,
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
    if (list === 'blocked' && r.cooldownMinutes != null) extras.cooldownMinutes = r.cooldownMinutes;
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
        minutesPerGate: s.minutesPerGate,
        soundEffects: s.soundEffects
      };
    }
    return `// Exported from Gates Of Heaven & Hell — ${new Date(now).toISOString()}\n${JSON.stringify(payload, null, 2)}\n`;
  }

  // Settings that are safe to import. The Blocked cooldown is never imported:
  // it can only be lowered through the staged path in the Settings tab.
  function importableSettings(imported) {
    if (!imported) return {};
    const allowed = ['reminderStyle', 'pauseWaitSeconds', 'passMode', 'passGraceMinutes', 'passFixedMinutes', 'minutesPerGate', 'soundEffects'];
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
    ruleCooldownMinutes,
    requestRuleCooldown,
    dayKey,
    emptyStats,
    recordEvent,
    recordPassTime,
    clearStats,
    passMinutesUsed,
    currentStreak,
    ruleStreak,
    ruleLabelOf,
    ruleBoard,
    summarizeStats,
    formatAgo,
    gatePhrase,
    DEFAULT_PHRASE,
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
