// background.js — MV3 service worker.
// Responsibilities ONLY:
//   1. Seed chrome.storage.local from bundled bookOfLinks.jsonc on first install.
//   2. Compile stored BLOCKED/EXCLUDED/PAUSE_AND_THINK rules and active pause sessions
//      into declarativeNetRequest dynamic rules whenever storage changes.
//   3. Reconcile lock-expiry, pause-countdown, and pause-session-expiry alarms (survives worker restarts).
//   4. Track tab focus to manage 5-minute inactivity grace periods for Pause & Think sessions.

importScripts('rules-engine.js');

const ALARM_LOCK_PREFIX = 'lock:';
const ALARM_COUNTDOWN_PREFIX = 'pauseCountdown:';
const LEGACY_ALARM_COUNTDOWN_PREFIX = 'removalCountdown:';
const ALARM_PAUSE_SESSION_PREFIX = 'pauseSessionExpiry:';

const PAUSE_COUNTDOWN_MS = 30 * 60 * 1000; // 30 minutes
const PAUSE_SESSION_INACTIVITY_MS = 5 * 60 * 1000; // 5 minutes

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
    const pauseAndThink = (parsed.PAUSE_AND_THINK || []).map((rule) => makePauseAndThinkRule(rule));

    await chrome.storage.local.set({ blocked, excluded, pauseAndThink, pauseSessions: [], seeded: true });
    console.log(
      '[GatesOfHeavenAndHell] Seeded',
      blocked.length,
      'blocked,',
      excluded.length,
      'excluded, and',
      pauseAndThink.length,
      'pause & think rules.'
    );
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Seed failed, starting empty:', err);
    await chrome.storage.local.set({ blocked: [], excluded: [], pauseAndThink: [], pauseSessions: [], seeded: true });
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

function makePauseAndThinkRule([domain, substring] = []) {
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
    const {
      blocked = [],
      excluded = [],
      pauseAndThink = [],
      pauseSessions = []
    } = await chrome.storage.local.get(['blocked', 'excluded', 'pauseAndThink', 'pauseSessions']);

    const newRules = [];
    let nextId = 1;
    const blockedPageBaseUrl = chrome.runtime.getURL('pages/blocked.html');
    const pausePageBaseUrl = chrome.runtime.getURL('pages/pause.html');

    // 1. EXCLUDED (Priority 4, allow) — always wins unconditionally.
    for (const rule of excluded) {
      const regexFilter = self.RulesEngine.buildRegexFilter(rule.domain, rule.substring);
      if (!regexFilter) continue;
      newRules.push({
        id: nextId++,
        priority: 4,
        action: { type: 'allow' },
        condition: { regexFilter, resourceTypes: ['main_frame'] }
      });
    }

    // 2. Active Pause Sessions (Priority 3, allow) — temporarily allow traffic when pass is granted.
    for (const session of pauseSessions) {
      const regexFilter = self.RulesEngine.buildRegexFilter(session.domain, session.substring);
      if (!regexFilter) continue;
      newRules.push({
        id: nextId++,
        priority: 3,
        action: { type: 'allow' },
        condition: { regexFilter, resourceTypes: ['main_frame'] }
      });
    }

    // 3. PAUSE & THINK (Priority 2, redirect) — soft gate overrides Blocked.
    for (const rule of pauseAndThink) {
      const regexFilter = self.RulesEngine.buildRegexFilter(rule.domain, rule.substring);
      if (!regexFilter) continue;
      newRules.push({
        id: nextId++,
        priority: 2,
        action: {
          type: 'redirect',
          redirect: {
            regexSubstitution: `${pausePageBaseUrl}?ruleId=${encodeURIComponent(rule.id)}&url=\\1`
          }
        },
        condition: { regexFilter, resourceTypes: ['main_frame'] }
      });
    }

    // 4. BLOCKED (Priority 1, redirect) — hard gate. Paused rules are skipped.
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

  if (changes.excluded || changes.pauseAndThink || changes.pauseSessions) {
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
// Pause Session Activation & Tracking
////////////////////////////////////////////////////////////////////////////

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === 'ACTIVATE_PAUSE_SESSION') {
    handleActivatePauseSession(message).then((res) => sendResponse(res));
    return true; // async response
  }
});

async function handleActivatePauseSession({ ruleId, url }) {
  try {
    const { pauseAndThink = [], pauseSessions = [] } = await chrome.storage.local.get(['pauseAndThink', 'pauseSessions']);

    let targetRule = pauseAndThink.find((r) => r.id === ruleId);
    if (!targetRule && url) {
      const parts = self.RulesEngine.getUrlParts(url);
      targetRule = pauseAndThink.find((r) => self.RulesEngine.ruleMatches(parts, [r.domain, r.substring]));
    }

    if (!targetRule) {
      // Fallback domain extraction if rule not found
      try {
        const parsedUrl = new URL(url);
        targetRule = { id: crypto.randomUUID(), domain: parsedUrl.hostname, substring: '' };
      } catch {
        targetRule = { id: crypto.randomUUID(), domain: '', substring: '' };
      }
    }

    // Cancel any pending expiry alarm for this session
    await chrome.alarms.clear(ALARM_PAUSE_SESSION_PREFIX + targetRule.id);

    // Update active sessions array
    const updatedSessions = pauseSessions.filter((s) => s.ruleId !== targetRule.id);
    updatedSessions.push({
      ruleId: targetRule.id,
      domain: targetRule.domain,
      substring: targetRule.substring || '',
      activatedAt: Date.now()
    });

    await chrome.storage.local.set({ pauseSessions: updatedSessions });
    await rebuildDnrRules();

    return { success: true };
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Failed to activate pause session:', err);
    return { success: false, error: err.message };
  }
}

////////////////////////////////////////////////////////////////////////////
// Tab Focus & Inactivity Grace Period Management
////////////////////////////////////////////////////////////////////////////

async function checkPauseSessionActivity() {
  try {
    const { pauseSessions = [] } = await chrome.storage.local.get(['pauseSessions']);
    if (!pauseSessions.length) return;

    // Find all active tabs in all normal/incognito windows
    const activeTabs = await chrome.tabs.query({ active: true });
    const activeUrls = activeTabs.map((t) => t.url || '').filter(Boolean);

    for (const session of pauseSessions) {
      const alarmName = ALARM_PAUSE_SESSION_PREFIX + session.ruleId;
      const isCurrentlyActive = activeUrls.some((url) => {
        const parts = self.RulesEngine.getUrlParts(url);
        return self.RulesEngine.ruleMatches(parts, [session.domain, session.substring]);
      });

      if (isCurrentlyActive) {
        // User is focused on a matching tab — clear inactivity timer
        await chrome.alarms.clear(alarmName);
      } else {
        // User is not on a matching tab — ensure 5-minute inactivity countdown is running
        const existingAlarm = await chrome.alarms.get(alarmName);
        if (!existingAlarm) {
          chrome.alarms.create(alarmName, { when: Date.now() + PAUSE_SESSION_INACTIVITY_MS });
        }
      }
    }
  } catch (err) {
    console.error('[GatesOfHeavenAndHell] Error in checkPauseSessionActivity:', err);
  }
}

// Track tab activation, URL updates, and closures to manage grace period
chrome.tabs.onActivated.addListener(() => {
  checkPauseSessionActivity();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    checkPauseSessionActivity();
  }
});

chrome.tabs.onRemoved.addListener(() => {
  checkPauseSessionActivity();
});

chrome.windows.onFocusChanged.addListener(() => {
  checkPauseSessionActivity();
});

////////////////////////////////////////////////////////////////////////////
// Alarms — lock expiry + pause countdown + pause session expiry reconciliation
////////////////////////////////////////////////////////////////////////////

async function reconcileAllAlarms() {
  const { blocked = [], pauseSessions = [] } = await chrome.storage.local.get(['blocked', 'pauseSessions']);
  const now = Date.now();
  let stateModified = false;

  // 1. Reconcile Lock & Pause Countdowns on Blocked rules
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

  // 2. Reconcile Pause Sessions
  const validSessions = [];
  for (const session of pauseSessions) {
    const alarm = await chrome.alarms.get(ALARM_PAUSE_SESSION_PREFIX + session.ruleId);
    if (alarm && alarm.scheduledTime <= now) {
      // Expired while background worker was dormant
      continue;
    }
    validSessions.push(session);
  }

  if (validSessions.length !== pauseSessions.length) {
    await chrome.storage.local.set({ pauseSessions: validSessions });
  }

  if (stateModified) {
    await chrome.storage.local.set({ blocked });
  }

  await checkPauseSessionActivity();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const { blocked = [], pauseSessions = [] } = await chrome.storage.local.get(['blocked', 'pauseSessions']);
  let blockedChanged = false;

  // Lock expiry
  if (alarm.name.startsWith(ALARM_LOCK_PREFIX)) {
    const id = alarm.name.slice(ALARM_LOCK_PREFIX.length);
    const rule = blocked.find((r) => r.id === id);
    if (rule && rule.locked) {
      rule.locked = false;
      rule.lockedUntil = null;
      blockedChanged = true;
    }
  }

  // 30-minute Pause Countdown
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
      blockedChanged = true;
    }
  }

  if (blockedChanged) {
    await chrome.storage.local.set({ blocked });
  }

  // 5-minute Pause Session Expiry
  if (alarm.name.startsWith(ALARM_PAUSE_SESSION_PREFIX)) {
    const ruleId = alarm.name.slice(ALARM_PAUSE_SESSION_PREFIX.length);
    const remainingSessions = pauseSessions.filter((s) => s.ruleId !== ruleId);
    if (remainingSessions.length !== pauseSessions.length) {
      await chrome.storage.local.set({ pauseSessions: remainingSessions });
      await rebuildDnrRules();
    }
  }
});
