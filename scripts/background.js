// background.js — MV3 service worker.
// Responsibilities ONLY:
//   1. Seed chrome.storage.local from bundled bookOfLinks.jsonc on first install.
//   2. Compile stored BLOCKED/EXCLUDED rules into declarativeNetRequest dynamic rules
//      whenever storage changes.
//   3. Reconcile lock-expiry and pause-countdown alarms (survives worker restarts).

importScripts('rules-engine.js');

const ALARM_LOCK_PREFIX = 'lock:';
const ALARM_COUNTDOWN_PREFIX = 'pauseCountdown:';
const LEGACY_ALARM_COUNTDOWN_PREFIX = 'removalCountdown:';
const PAUSE_COUNTDOWN_MS = 30 * 60 * 1000; // 30 minutes

let isRebuilding = false; // Prevents overlapping calls from racing on rule IDs
let rebuildQueued = false; // If a change arrives mid-rebuild, don't drop it — rerun after

////////////////////////////////////////////////////////////////////////////
// Toolbar icon -> open the rule book
////////////////////////////////////////////////////////////////////////////

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

////////////////////////////////////////////////////////////////////////////
// First-install seed
////////////////////////////////////////////////////////////////////////////

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await seedFromBundledFile();
  }
  await rebuildDnrRules();
  await reconcileAllAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  await rebuildDnrRules();
  await reconcileAllAlarms();
});

async function seedFromBundledFile() {
  try {
    const url = chrome.runtime.getURL('bookOfLinks.jsonc');
    const res = await fetch(url);
    const raw = await res.text();
    const parsed = parseJsonc(raw);

    const blocked = (parsed.BLOCKED || []).map((rule) => makeBlockedRule(rule));
    const excluded = (parsed.EXCLUDED || []).map((rule) => makeExcludedRule(rule));

    await chrome.storage.local.set({ blocked, excluded, seeded: true });
    console.log('[GatesOfHeavenAndHell] Seeded', blocked.length, 'blocked and', excluded.length, 'excluded rules.');
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Seed failed, starting empty:', err);
    await chrome.storage.local.set({ blocked: [], excluded: [], seeded: true });
  }
}

function makeBlockedRule([domain, substring, message] = []) {
  return {
    id: crypto.randomUUID(),
    domain: domain || '',
    substring: substring || '',
    message: message || '',
    locked: false,
    lockedUntil: null,
    paused: false,
    pendingPause: null
  };
}

function makeExcludedRule([domain, substring] = []) {
  return {
    id: crypto.randomUUID(),
    domain: domain || '',
    substring: substring || ''
  };
}

// Minimal JSONC parser: strips // and /* */ comments and trailing commas, then JSON.parse.
function parseJsonc(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/("(?:[^"\\]|\\.)*")|\/\/.*$/gm, (m, str) => (str ? str : ''));
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

////////////////////////////////////////////////////////////////////////////
// declarativeNetRequest compilation
////////////////////////////////////////////////////////////////////////////

async function rebuildDnrRules() {
  if (isRebuilding) {
    rebuildQueued = true; // don't drop it — storage has moved on since this call started
    return;
  }
  isRebuilding = true;

  try {
    const { blocked = [], excluded = [] } = await chrome.storage.local.get(['blocked', 'excluded']);

    const newRules = [];
    let nextId = 1;
    const blockedPageBaseUrl = chrome.runtime.getURL('pages/blocked.html');

    // EXCLUDED first, higher priority "allow" — always wins, unconditionally.
    for (const rule of excluded) {
      const regexFilter = self.RulesEngine.buildRegexFilter(rule.domain, rule.substring);
      if (!regexFilter) continue;
      newRules.push({
        id: nextId++,
        priority: 2,
        action: { type: 'allow' },
        condition: { regexFilter, resourceTypes: ['main_frame'] }
      });
    }

    // BLOCKED — redirect to the extension's blocked page carrying ruleId & original URL.
    // Paused rules are skipped so they do not block traffic.
    for (const rule of blocked) {
      if (rule.paused) continue;
      const regexFilter = self.RulesEngine.buildRegexFilter(rule.domain, rule.substring);
      if (!regexFilter) continue;
      newRules.push({
        id: nextId++,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: {
            regexSubstitution: `${blockedPageBaseUrl}?ruleId=${encodeURIComponent(rule.id)}&url=\\1`
          }
        },
        condition: { regexFilter, resourceTypes: ['main_frame'] }
      });
    }

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map((r) => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: newRules });
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Failed to update DNR rules:', err);
  } finally {
    isRebuilding = false;
    if (rebuildQueued) {
      rebuildQueued = false;
      rebuildDnrRules();
    }
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  
  if (changes.excluded) {
    rebuildDnrRules();
    return;
  }

  if (changes.blocked) {
    const oldBlocked = changes.blocked.oldValue || [];
    const newBlocked = changes.blocked.newValue || [];

    if (oldBlocked.length !== newBlocked.length) {
      rebuildDnrRules();
      return;
    }

    const filtersChanged = newBlocked.some((rule, i) => {
      const match = oldBlocked[i];
      return !match || rule.domain !== match.domain || rule.substring !== match.substring || Boolean(rule.paused) !== Boolean(match.paused);
    });

    if (filtersChanged) {
      rebuildDnrRules();
    }
  }
});

////////////////////////////////////////////////////////////////////////////
// Alarms — lock expiry + pause countdown reconciliation
////////////////////////////////////////////////////////////////////////////

async function reconcileAllAlarms() {
  const { blocked = [] } = await chrome.storage.local.get(['blocked']);
  const now = Date.now();
  let stateModified = false;

  for (const rule of blocked) {
    if (rule.locked && rule.lockedUntil) {
      if (rule.lockedUntil <= now) {
        rule.locked = false;
        rule.lockedUntil = null;
        stateModified = true;
      } else {
        chrome.alarms.create(ALARM_LOCK_PREFIX + rule.id, { when: rule.lockedUntil });
      }
    }
    const pp = rule.pendingPause || rule.pendingRemoval;
    if (pp && pp.stage === 'countdown') {
      if (pp.readyAt <= now) {
        pp.stage = 'ready';
        rule.pendingPause = pp;
        delete rule.pendingRemoval;
        stateModified = true;
      } else {
        chrome.alarms.create(ALARM_COUNTDOWN_PREFIX + rule.id, { when: pp.readyAt });
      }
    }
  }

  if (stateModified) {
    await chrome.storage.local.set({ blocked });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const { blocked = [] } = await chrome.storage.local.get(['blocked']);
  let changed = false;

  if (alarm.name.startsWith(ALARM_LOCK_PREFIX)) {
    const id = alarm.name.slice(ALARM_LOCK_PREFIX.length);
    const rule = blocked.find((r) => r.id === id);
    if (rule && rule.locked) {
      rule.locked = false;
      rule.lockedUntil = null;
      changed = true;
    }
  }

  let countdownId = null;
  if (alarm.name.startsWith(ALARM_COUNTDOWN_PREFIX)) {
    countdownId = alarm.name.slice(ALARM_COUNTDOWN_PREFIX.length);
  } else if (alarm.name.startsWith(LEGACY_ALARM_COUNTDOWN_PREFIX)) {
    countdownId = alarm.name.slice(LEGACY_ALARM_COUNTDOWN_PREFIX.length);
  }

  if (countdownId) {
    const rule = blocked.find((r) => r.id === countdownId);
    const pp = rule && (rule.pendingPause || rule.pendingRemoval);
    if (pp && pp.stage === 'countdown') {
      pp.stage = 'ready';
      rule.pendingPause = pp;
      delete rule.pendingRemoval;
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ blocked });
  }
});
