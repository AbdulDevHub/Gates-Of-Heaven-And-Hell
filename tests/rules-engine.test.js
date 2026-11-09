// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../scripts/rules-engine.js');
const S = require('../scripts/shared.js');

const m = (url, domain, substring = '') => E.ruleMatches(E.getUrlParts(url), [domain, substring]);

// DNR uses RE2 with a leading (?i); JS needs the flag instead.
function dnr(domain, substring, url) {
  const src = E.buildRegexFilter(domain, substring);
  return new RegExp(src.replace(/^\(\?i\)/, ''), 'i').test(url);
}

const CASES = [
  // [url, domain, substring, expected]
  ['https://x.com/home', 'x.com', '', true],
  ['https://www.dropbox.com/', 'x.com', '', false],
  ['https://netbox.com/x.com', 'x.com', '', false],
  ['https://old.reddit.com/r/all', 'reddit.com', '', true],
  ['https://reddit.com', 'reddit.com', '', true],
  ['https://notreddit.com/', 'reddit.com', '', false],
  ['https://www.google.com/search?q=java+tips&sxsrf=abc', 'google.com/search', 'java', true],
  ['https://www.google.com/search?q=cats&ved=bat', 'google.com/search', 'bat', false],
  ['https://www.google.com/search?q=Get-ChildItem+%7C+Where-Object+%7B', 'google.com/search', 'je', false],
  ['https://www.google.com/search?q=je+tips', 'google.com/search', 'je', true],
  ['https://www.google.com/search?q=what+is+je', 'google.com/search', 'je', true],
  ['https://www.google.com/search?q=%22je%22+meaning', 'google.com/search', 'je', true],
  ['https://www.google.com/search?q=new-je+x', 'google.com/search', 'je', true],
  ['https://www.google.com/search?q=batman', 'google.com/search', 'bat', true],
  ['https://www.google.com/search?q=objects', 'google.com/search', 'je', false],
  ['https://www.google.com/search?q=best+big+mac', 'google.com/search', 'big mac', true],
  ['https://www.google.com/search?q=abig+mac', 'google.com/search', 'big mac', false],
  ['https://www.google.com/searchbyimage', 'google.com/search', '', true],
  ['https://www.google.com/maps', 'google.com/search', '', false],
  ['https://www.youtube.com/results?search_query=lofi+music', 'youtube.com/results', 'lofi music', true],
  ['https://www.youtube.com/watch?v=1', 'youtube.com/results', '', false],
  ['https://filmverse-azure.vercel.app/', 'filmverse-azure.vercel.app', '', true],
  ['https://filmverse-azure.vercel.app/', 'filmverse-azure.vercel.app', 'Limited Access', false],
  ['https://reddit.com/r/popular', 'https://www.reddit.com/', '/r/popular', true],
  ['https://anything.example/casino-night', '*', 'casino', true],
  ['https://anything.example/', '*', 'casino', false],
  ['https://reddit.com:8080/r/x', 'reddit.com', '', true]
];

test('ruleMatches and the DNR regex agree on every case', () => {
  for (const [url, domain, sub, expected] of CASES) {
    assert.equal(m(url, domain, sub), expected, `JS: ${url} vs ${domain} ${sub}`);
    assert.equal(dnr(domain, sub, url), expected, `DNR: ${url} vs ${domain} ${sub}`);
  }
});

test('regex never matches extension pages', () => {
  assert.equal(dnr('reddit.com', '', 'chrome-extension://abc/pages/pause.html?url=https://reddit.com/'), false);
});

test('readTargetUrl keeps URLs with & intact (raw and encoded)', () => {
  const target = 'https://www.google.com/search?q=a&b=c&url=x';
  const raw = `chrome-extension://id/pages/pause.html?ruleId=abc&url=${target}`;
  assert.equal(E.readTargetUrl(raw), target);
  const encoded = 'chrome-extension://id/' + E.buildGatePath('pause.html', 'abc', target);
  assert.equal(E.readTargetUrl(encoded), target);
  assert.equal(E.readTargetUrl('chrome-extension://id/pages/pause.html?url=' + encodeURIComponent(target)), target);
});

test('schedules: day window, overnight window and boundaries', () => {
  const weekday = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };
  const mon10 = new Date(2026, 10, 9, 10, 0); // Mon 9 Nov 2026
  const mon18 = new Date(2026, 10, 9, 18, 0);
  const sun10 = new Date(2026, 10, 8, 10, 0);
  assert.equal(E.isScheduleActive(weekday, mon10), true);
  assert.equal(E.isScheduleActive(weekday, mon18), false);
  assert.equal(E.isScheduleActive(weekday, sun10), false);

  const night = { days: [1], start: '22:00', end: '06:00' };
  assert.equal(E.isScheduleActive(night, new Date(2026, 10, 9, 23, 0)), true); // Mon 23:00
  assert.equal(E.isScheduleActive(night, new Date(2026, 10, 10, 5, 0)), true); // Tue 05:00 (spill-over)
  assert.equal(E.isScheduleActive(night, new Date(2026, 10, 10, 23, 0)), false); // Tue 23:00

  const next = E.nextScheduleBoundary([{ schedule: weekday }], mon10.getTime());
  assert.equal(next, new Date(2026, 10, 9, 17, 0).getTime());
  assert.equal(E.isScheduleActive(null, mon18), true);
});

test('explainUrl follows the priority layers and explains near misses', () => {
  const state = {
    blocked: [{ id: 'b', domain: 'reddit.com', substring: '' }],
    pauseAndThink: [{ id: 'p', domain: 'filmverse-azure.vercel.app', substring: 'Limited Access' }],
    excluded: [{ id: 'e', domain: 'reddit.com/r/learnprogramming', substring: '' }],
    pauseSessions: []
  };
  assert.equal(E.explainUrl('https://reddit.com/r/all', state).verdict, 'blocked');
  assert.equal(E.explainUrl('https://reddit.com/r/learnprogramming', state).verdict, 'excluded');
  const film = E.explainUrl('https://filmverse-azure.vercel.app/', state);
  assert.equal(film.verdict, 'none');
  assert.match(film.notes[0].text, /Limited Access/);

  state.pauseAndThink[0].substring = '';
  assert.equal(E.explainUrl('https://filmverse-azure.vercel.app/', state).verdict, 'pause');
  state.pauseSessions = [{ ruleId: 'p', domain: 'filmverse-azure.vercel.app', substring: '' }];
  assert.equal(E.explainUrl('https://filmverse-azure.vercel.app/', state).verdict, 'pass');

  state.blocked[0].paused = true;
  state.blocked[0].pausedUntil = Date.now() - 1000; // expired pause counts as active again
  assert.equal(E.explainUrl('https://reddit.com/r/all', state).verdict, 'blocked');
});

test('lintRule flags labels in the substring box, duplicates and shadowing', () => {
  const rule = { id: 'p', domain: 'filmverse-azure.vercel.app', substring: 'Limited Access' };
  const lints = E.lintRule(rule, 'pauseAndThink', { pauseAndThink: [rule], excluded: [] });
  assert.ok(lints.some((l) => l.code === 'label' && l.fix === 'move-to-note'));

  const search = { id: 's', domain: 'google.com/search', substring: 'Big Mac' };
  assert.ok(!E.lintRule(search, 'blocked', { blocked: [search] }).some((l) => l.code === 'label'));

  const a = { id: 'a', domain: 'x.com', substring: '' };
  const b = { id: 'b', domain: 'X.com', substring: '' };
  assert.ok(E.lintRule(b, 'blocked', { blocked: [a, b], excluded: [] }).some((l) => l.code === 'duplicate'));
  assert.ok(E.lintRule(a, 'blocked', { blocked: [a], excluded: [{ domain: 'x.com', substring: '' }] }).some((l) => l.code === 'shadowed'));
});

test('cooldown decreases are staged, increases are instant', () => {
  const now = 1_000_000;
  let s = S.mergeSettings({});
  s = S.requestCooldownChange(s, 10, now);
  assert.equal(S.effectiveCooldownMinutes(s, now), 30);
  assert.equal(S.effectiveCooldownMinutes(s, now + 30 * S.MINUTE), 10);
  s = S.requestCooldownChange(s, 60, now);
  assert.equal(S.effectiveCooldownMinutes(s, now), 60);
  assert.equal(s.pendingCooldown, null);
});

test('passes: activity grace and fixed expiry', () => {
  const now = Date.now();
  const act = S.resolvePass({}, { passMode: 'activity', passGraceMinutes: 5 }, now);
  assert.equal(S.sessionExpired({ mode: act.mode, graceMs: act.graceMs, lastActiveAt: now }, now + 4 * S.MINUTE), false);
  assert.equal(S.sessionExpired({ mode: act.mode, graceMs: act.graceMs, lastActiveAt: now }, now + 5 * S.MINUTE), true);
  const fixed = S.resolvePass({ passMode: 'fixed', passMinutes: 15 }, {}, now);
  assert.equal(fixed.expiresAt, now + 15 * S.MINUTE);
  assert.equal(S.sessionExpired({ ruleId: 'old', lastActiveAt: now }, now + 6 * S.MINUTE), true); // legacy session
});

test('stats: streaks and slips', () => {
  const day0 = new Date(2026, 10, 1, 12).getTime();
  let st = S.emptyStats(day0);
  st = S.recordEvent(st, 'blocked-view', day0);
  st = S.recordEvent(st, 'walk-away', day0);
  assert.equal(S.currentStreak(st, day0 + 2 * S.DAY), 3);
  st = S.recordEvent(st, 'go-through', day0 + 2 * S.DAY);
  assert.equal(S.currentStreak(st, day0 + 2 * S.DAY), 0);
  assert.equal(S.currentStreak(st, day0 + 4 * S.DAY), 2);
  const sum = S.summarizeStats(st, day0 + 2 * S.DAY, {});
  assert.equal(sum.totalHeld, 2);
  assert.equal(sum.bestStreak, 3);
  assert.equal(sum.series.length, 30);
});

test('lint warns when "*" would gate every site', () => {
  const r = { id: 'w', domain: '*', substring: '' };
  assert.ok(E.lintRule(r, 'blocked', { blocked: [r] }).some((l) => l.code === 'everything'));
});

test('imported settings can never change the Blocked cooldown', () => {
  const out = S.importableSettings({ blockedCooldownMinutes: 5, pendingCooldown: { minutes: 5, effectiveAt: 0 }, pauseWaitSeconds: 20 });
  assert.deepEqual(out, { pauseWaitSeconds: 20 });
});

test('settleSettings applies a staged cooldown only when due', () => {
  const now = 5_000_000;
  const staged = S.requestCooldownChange({}, 10, now);
  assert.equal(S.settleSettings(staged, now + S.MINUTE).changed, false);
  const done = S.settleSettings(staged, now + 30 * S.MINUTE);
  assert.equal(done.changed, true);
  assert.equal(done.settings.blockedCooldownMinutes, 10);
  assert.equal(done.settings.pendingCooldown, null);
});

test('cleanSchedule rejects bad input and keeps good input', () => {
  assert.equal(S.cleanSchedule({ days: [], start: '09:00', end: '17:00' }), null);
  assert.equal(S.cleanSchedule({ days: [1], start: '9am', end: '17:00' }), null);
  assert.deepEqual(S.cleanSchedule({ days: [1, 1, 9], start: '09:00', end: '17:00' }), { days: [1], start: '09:00', end: '17:00' });
});

test('v1 positional rule files import with every new field defaulted', () => {
  const book = S.parseRuleBook('{"BLOCKED":[["reddit.com"]],"PAUSE_AND_THINK":[["x.com","/home"]],"EXCLUDED":[]}');
  const b = book.blocked[0];
  assert.equal(b.locked, false);
  assert.equal(b.paused, false);
  assert.equal(b.pausedUntil, null);
  assert.equal(b.schedule, null);
  assert.equal(book.pauseAndThink[0].passMode, null);
  assert.equal(book.settings, null);
});

test('JSONC round trip keeps old array format and new fields', () => {
  const text = `// comment
  { "BLOCKED": [["google.com/search", "bat", "msg"],],
    "PAUSE_AND_THINK": [["reddit.com", ""], {"domain": "x.com", "note": "Doomscroll", "passMode": "fixed", "passMinutes": 10}],
    "EXCLUDED": [["youtube.com/results", "recipe"]] }`;
  const book = S.parseRuleBook(text);
  assert.equal(book.blocked[0].message, 'msg');
  assert.equal(book.pauseAndThink[1].note, 'Doomscroll');
  const out = S.parseJsonc(S.serializeRuleBook(book, null, 0));
  assert.deepEqual(out.BLOCKED[0], ['google.com/search', 'bat', 'msg']);
  assert.deepEqual(out.PAUSE_AND_THINK[0], ['reddit.com', '']);
  assert.equal(out.PAUSE_AND_THINK[1].passMinutes, 10);
});

test('per-rule streaks: a slip on one rule leaves the others alone', () => {
  const day0 = new Date(2026, 10, 1, 12).getTime();
  let st = S.emptyStats(day0);
  const yt = { ruleId: 'yt', list: 'pauseAndThink', label: 'youtube.com' };
  const rd = { ruleId: 'rd', list: 'blocked', label: 'reddit.com' };
  st = S.recordEvent(st, 'blocked-view', day0, rd);
  st = S.recordEvent(st, 'go-through', day0 + 3 * S.DAY, yt);
  assert.equal(S.ruleStreak(st, 'yt', day0 + 3 * S.DAY), 0);
  assert.equal(S.ruleStreak(st, 'yt', day0 + 5 * S.DAY), 2);
  assert.equal(S.ruleStreak(st, 'rd', day0 + 5 * S.DAY), 6);
  assert.equal(st.rules.yt.bestStreak, 4);
  assert.equal(st.rules.rd.held, 1);
  assert.equal(st.rules.yt.goThroughs, 1);
  // A rule created after stats began counts from its creation day.
  assert.equal(S.ruleStreak(st, 'new', day0 + 5 * S.DAY, { createdAt: day0 + 4 * S.DAY }), 2);
});

test('old stats without rules/hours still load and summarize', () => {
  const day0 = new Date(2026, 10, 1, 12).getTime();
  const old = { since: day0, days: { [S.dayKey(day0)]: { blocked: 2, paused: 1, walkAways: 1, goThroughs: 0, rulePauses: 0 } }, lastSlipDay: null, bestStreak: 0 };
  const sum = S.summarizeStats(old, day0, {}, []);
  assert.equal(sum.today.held, 3);
  assert.equal(sum.hours.length, 7);
  const next = S.recordEvent(old, 'pause-view', day0, { ruleId: 'a' });
  assert.equal(next.rules.a.views, 1);
  assert.equal(next.hours[new Date(day0).getDay()][12], 1);
});

test('funnel, week-over-week and the year series', () => {
  const now = new Date(2026, 10, 20, 12).getTime();
  let st = S.emptyStats(now - 20 * S.DAY);
  const r = { ruleId: 'p', list: 'pauseAndThink' };
  for (const ev of ['pause-view', 'gate-unlocked', 'phrase-typed', 'go-through']) st = S.recordEvent(st, ev, now, r);
  st = S.recordEvent(st, 'pause-view', now - 8 * S.DAY, r);
  st = S.recordEvent(st, 'walk-away', now - 8 * S.DAY, r);
  st = S.recordPassTime(st, 'p', 25, now);
  const sum = S.summarizeStats(st, now, {}, [{ list: 'pauseAndThink', rule: { id: 'p', domain: 'x.com', substring: '' } }]);
  assert.deepEqual(sum.funnel, { seen: 2, waited: 1, typed: 1, through: 1, walkedAway: 1 });
  assert.deepEqual(sum.week, { held: 0, prevHeld: 1, slips: 1, prevSlips: 0 });
  assert.equal(sum.year.length, 365);
  assert.equal(sum.passMinutes, 25);
  assert.equal(sum.board[0].passMinutes, 25);
  assert.equal(sum.board[0].walkAwayRate, 50);
});

test('per-rule cooldown: longer applies now, shorter is staged', () => {
  const now = 10_000_000;
  const settings = S.mergeSettings({ blockedCooldownMinutes: 30 });
  let rule = { cooldownMinutes: null, pendingCooldown: null };
  assert.equal(S.ruleCooldownMinutes(rule, settings, now), 30);
  rule = Object.assign(rule, S.requestRuleCooldown(rule, 120, settings, now));
  assert.equal(S.ruleCooldownMinutes(rule, settings, now), 120);
  rule = Object.assign(rule, S.requestRuleCooldown(rule, 10, settings, now));
  assert.equal(S.ruleCooldownMinutes(rule, settings, now), 120);
  assert.equal(S.ruleCooldownMinutes(rule, settings, now + 120 * S.MINUTE), 10);
  rule = { cooldownMinutes: 60, pendingCooldown: null };
  rule = Object.assign(rule, S.requestRuleCooldown(rule, null, settings, now)); // back to the 30 min default
  assert.equal(S.ruleCooldownMinutes(rule, settings, now), 60);
  assert.equal(S.ruleCooldownMinutes(rule, settings, now + 60 * S.MINUTE), 30);
});

test('gate phrase is the note when there is one', () => {
  assert.equal(S.gatePhrase({ note: '  I Will Limit My Usage ' }), 'I Will Limit My Usage');
  assert.equal(S.gatePhrase({ note: '' }), 'Yes I Am Sure');
  assert.equal(S.gatePhrase(null), 'Yes I Am Sure');
});

test('Blocked cooldownMinutes round-trips through export/import', () => {
  const rule = S.makeRule('blocked', { domain: 'x.com', cooldownMinutes: 90 });
  const text = S.serializeRuleBook({ blocked: [rule], pauseAndThink: [], excluded: [] }, null, 0);
  assert.equal(S.parseRuleBook(text).blocked[0].cooldownMinutes, 90);
});

test('clearStats undoes the last hour, today, or everything', () => {
  const noon = new Date(2026, 10, 8, 12, 0).getTime();
  const H = 60 * 60 * 1000;
  const yt = { ruleId: 'yt', list: 'pauseAndThink', label: 'youtube.com' };
  let st = S.emptyStats(noon - 5 * S.DAY);
  st = S.recordEvent(st, 'go-through', noon - 3 * S.DAY, yt);
  st = S.recordEvent(st, 'blocked-view', noon - 3 * H);
  st = S.recordEvent(st, 'pause-view', noon - 10 * 60000, yt);
  st = S.recordEvent(st, 'go-through', noon - 5 * 60000, yt);
  st = S.recordPassTime(st, 'yt', 4, noon, { label: 'youtube.com' });
  const key = S.dayKey(noon);

  const hour = S.clearStats(st, noon - H, noon);
  assert.equal(hour.days[key].blocked, 1);
  assert.equal(hour.days[key].goThroughs, 0);
  assert.equal(hour.days[key].passMinutes, 0);
  assert.equal(hour.rules.yt.goThroughs, 1);
  assert.equal(hour.rules.yt.views, 0);
  assert.equal(hour.rules.yt.lastSlipAt, noon - 3 * S.DAY);
  assert.equal(hour.lastSlipDay, S.dayKey(noon - 3 * S.DAY));
  const d = new Date(noon - 10 * 60000);
  assert.equal(hour.hours[d.getDay()][d.getHours()], 0);

  const today = S.clearStats(st, new Date(noon).setHours(0, 0, 0, 0), noon);
  assert.equal(today.days[key], undefined);
  assert.equal(today.days[S.dayKey(noon - 3 * S.DAY)].goThroughs, 1);

  const all = S.clearStats(st, 'all', noon);
  assert.deepEqual(all.days, {});
  assert.deepEqual(all.rules, {});
  assert.equal(all.since, st.since);
});
