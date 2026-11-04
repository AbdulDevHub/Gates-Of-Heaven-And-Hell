// background.js — MV3 service worker.
// Responsibilities ONLY:
//   1. Seed chrome.storage.local from bundled bookOfLinks.jsonc on first install.
//   2. Compile stored BLOCKED/EXCLUDED/PAUSE_AND_THINK rules and active pause sessions
//      into declarativeNetRequest dynamic rules whenever storage changes.
//   3. Reconcile lock-expiry and pause-countdown alarms (survives worker restarts).
//   4. Track pause-session activity: keep a session alive for as long as some
//      active tab still matches its rule, and expire it after 5 minutes of no
//      matching active tab. Tracked via a `lastActiveAt` timestamp on each
//      session, refreshed both by tab events (for instant responsiveness) and
//      by a 1-minute heartbeat alarm (so a missed/never-fired tab event can
//      never leave a stale expiry hanging).

importScripts("rules-engine.js")

const ALARM_LOCK_PREFIX = "lock:"
const ALARM_COUNTDOWN_PREFIX = "pauseCountdown:"
const LEGACY_ALARM_COUNTDOWN_PREFIX = "removalCountdown:"
const ALARM_PAUSE_HEARTBEAT = "pauseSessionHeartbeat"

const PAUSE_COUNTDOWN_MS = 30 * 60 * 1000 // 30 minutes
const PAUSE_SESSION_INACTIVITY_MS = 5 * 60 * 1000 // 5 minutes
const HEARTBEAT_PERIOD_MINUTES = 1 // sweep cadence — also the max detection lag

// Serializes all rebuilds through one promise chain so overlapping calls can
// never race against each other (which previously could produce duplicate
// DNR rule IDs if two rebuilds computed against overlapping state).
let rebuildChain = Promise.resolve()

////////////////////////////////////////////////////////////////////////////
// Toolbar icon -> open the rule book
////////////////////////////////////////////////////////////////////////////

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage()
})

////////////////////////////////////////////////////////////////////////////
// First-install seed
////////////////////////////////////////////////////////////////////////////

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await seedFromBundledFile()
  }
  await rebuildDnrRules()
  await reconcileAllAlarms()
})

chrome.runtime.onStartup.addListener(async () => {
  await rebuildDnrRules()
  await reconcileAllAlarms()
})

async function seedFromBundledFile() {
  try {
    const url = chrome.runtime.getURL("bookOfLinks.jsonc")
    const res = await fetch(url)
    const raw = await res.text()
    const parsed = parseJsonc(raw)

    const blocked = (parsed.BLOCKED || []).map((rule) => makeBlockedRule(rule))
    const excluded = (parsed.EXCLUDED || []).map((rule) =>
      makeExcludedRule(rule),
    )
    const pauseAndThink = (parsed.PAUSE_AND_THINK || []).map((rule) =>
      makePauseAndThinkRule(rule),
    )

    await chrome.storage.local.set({
      blocked,
      excluded,
      pauseAndThink,
      pauseSessions: [],
      seeded: true,
    })
    console.log(
      "[GatesOfHeavenAndHell] Seeded",
      blocked.length,
      "blocked,",
      excluded.length,
      "excluded, and",
      pauseAndThink.length,
      "pause & think rules.",
    )
  } catch (err) {
    console.error("[GatesOfHeavenAndHell] Seed failed, starting empty:", err)
    await chrome.storage.local.set({
      blocked: [],
      excluded: [],
      pauseAndThink: [],
      pauseSessions: [],
      seeded: true,
    })
  }
}

function makeBlockedRule([domain, substring, message] = []) {
  return {
    id: crypto.randomUUID(),
    domain: domain || "",
    substring: substring || "",
    message: message || "",
    locked: false,
    lockedUntil: null,
    paused: false,
    pendingPause: null,
  }
}

function makeExcludedRule([domain, substring] = []) {
  return {
    id: crypto.randomUUID(),
    domain: domain || "",
    substring: substring || "",
  }
}

function makePauseAndThinkRule([domain, substring] = []) {
  return {
    id: crypto.randomUUID(),
    domain: domain || "",
    substring: substring || "",
  }
}

// Minimal JSONC parser: strips // and /* */ comments and trailing commas, then JSON.parse.
function parseJsonc(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, "")
  out = out.replace(/("(?:[^"\\]|\\.)*")|\/\/.*$/gm, (m, str) =>
    str ? str : "",
  )
  out = out.replace(/,(\s*[}\]])/g, "$1")
  return JSON.parse(out)
}

////////////////////////////////////////////////////////////////////////////
// declarativeNetRequest compilation
////////////////////////////////////////////////////////////////////////////

function rebuildDnrRules() {
  // Chain onto whatever's already pending instead of running in parallel —
  // guarantees each rebuild sees the fully-applied result of the previous one.
  rebuildChain = rebuildChain.then(doRebuildDnrRules).catch((err) => {
    console.error("[GatesOfHeavenAndHell] Failed to update DNR rules:", err)
  })
  return rebuildChain
}

async function doRebuildDnrRules() {
  try {
    const {
      blocked = [],
      excluded = [],
      pauseAndThink = [],
      pauseSessions = [],
    } = await chrome.storage.local.get([
      "blocked",
      "excluded",
      "pauseAndThink",
      "pauseSessions",
    ])

    const newRules = []
    let nextId = 1
    const blockedPageBaseUrl = chrome.runtime.getURL("pages/blocked.html")
    const pausePageBaseUrl = chrome.runtime.getURL("pages/pause.html")

    // 1. EXCLUDED (Priority 4, allow) — always wins unconditionally.
    for (const rule of excluded) {
      const regexFilter = self.RulesEngine.buildRegexFilter(
        rule.domain,
        rule.substring,
      )
      if (!regexFilter) continue
      newRules.push({
        id: nextId++,
        priority: 4,
        action: { type: "allow" },
        condition: { regexFilter, resourceTypes: ["main_frame"] },
      })
    }

    // 2. Active Pause Sessions (Priority 3, allow) — temporarily allow traffic when pass is granted.
    for (const session of pauseSessions) {
      const regexFilter = self.RulesEngine.buildRegexFilter(
        session.domain,
        session.substring,
      )
      if (!regexFilter) continue
      newRules.push({
        id: nextId++,
        priority: 3,
        action: { type: "allow" },
        condition: { regexFilter, resourceTypes: ["main_frame"] },
      })
    }

    // 3. PAUSE & THINK (Priority 2, redirect) — soft gate overrides Blocked.
    for (const rule of pauseAndThink) {
      const regexFilter = self.RulesEngine.buildRegexFilter(
        rule.domain,
        rule.substring,
      )
      if (!regexFilter) continue
      newRules.push({
        id: nextId++,
        priority: 2,
        action: {
          type: "redirect",
          redirect: {
            regexSubstitution: `${pausePageBaseUrl}?ruleId=${encodeURIComponent(rule.id)}&url=\\1`,
          },
        },
        condition: { regexFilter, resourceTypes: ["main_frame"] },
      })
    }

    // 4. BLOCKED (Priority 1, redirect) — hard gate. Paused rules are skipped.
    for (const rule of blocked) {
      if (rule.paused) continue
      const regexFilter = self.RulesEngine.buildRegexFilter(
        rule.domain,
        rule.substring,
      )
      if (!regexFilter) continue
      newRules.push({
        id: nextId++,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            regexSubstitution: `${blockedPageBaseUrl}?ruleId=${encodeURIComponent(rule.id)}&url=\\1`,
          },
        },
        condition: { regexFilter, resourceTypes: ["main_frame"] },
      })
    }

    const existing = await chrome.declarativeNetRequest.getDynamicRules()
    const removeRuleIds = existing.map((r) => r.id)

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: newRules,
    })
  } catch (err) {
    console.error("[GatesOfHeavenAndHell] Failed to update DNR rules:", err)
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return

  if (changes.excluded || changes.pauseAndThink) {
    rebuildDnrRules()
    return
  }

  if (changes.pauseSessions) {
    // lastActiveAt gets bumped constantly while a session is active (every
    // matching tab event) — that alone never changes which DNR rules should
    // exist, so only rebuild when the actual set of sessions (which rule,
    // which domain/substring) changes. Rebuilding on every timestamp bump
    // was hammering rebuildDnrRules far more than intended.
    const oldSessions = changes.pauseSessions.oldValue || []
    const newSessions = changes.pauseSessions.newValue || []
    const fingerprint = (list) =>
      list
        .map((s) => `${s.ruleId}|${s.domain || ""}|${s.substring || ""}`)
        .sort()
        .join(",")

    if (fingerprint(oldSessions) !== fingerprint(newSessions)) {
      rebuildDnrRules()
    }
    return
  }

  if (changes.blocked) {
    const oldBlocked = changes.blocked.oldValue || []
    const newBlocked = changes.blocked.newValue || []

    if (oldBlocked.length !== newBlocked.length) {
      rebuildDnrRules()
      return
    }

    const filtersChanged = newBlocked.some((rule, i) => {
      const match = oldBlocked[i]
      return (
        !match ||
        rule.domain !== match.domain ||
        rule.substring !== match.substring ||
        Boolean(rule.paused) !== Boolean(match.paused)
      )
    })

    if (filtersChanged) {
      rebuildDnrRules()
    }
  }
})

////////////////////////////////////////////////////////////////////////////
// Pause Session Activation & Tracking
//
// A session stores { ruleId, domain, substring, activatedAt, lastActiveAt }.
// `lastActiveAt` is the source of truth for "is this session still alive":
//   - refreshActiveSessionTimestamps() bumps it to now() whenever some
//     currently-active tab (in any window) matches the session's rule.
//     It's called opportunistically off tab events for instant responsiveness.
//   - runPauseSessionSweep() is the authoritative check, run every
//     HEARTBEAT_PERIOD_MINUTES regardless of whether any tab event fired.
//     It refreshes timestamps one more time, then expires any session whose
//     lastActiveAt is more than PAUSE_SESSION_INACTIVITY_MS in the past.
// This means a missed or never-fired tab event (SPA navigation, a link that
// opens in a new tab, the worker being asleep, etc.) can no longer cause a
// stale expiry — the heartbeat always re-derives the answer from the actual
// current tab state instead of trusting a one-shot alarm armed earlier.
////////////////////////////////////////////////////////////////////////////

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === "ACTIVATE_PAUSE_SESSION") {
    handleActivatePauseSession(message).then((res) => sendResponse(res))
    return true // async response
  }
})

async function handleActivatePauseSession({ ruleId, url }) {
  try {
    const { pauseAndThink = [], pauseSessions = [] } =
      await chrome.storage.local.get(["pauseAndThink", "pauseSessions"])

    let targetRule = pauseAndThink.find((r) => r.id === ruleId)
    if (!targetRule && url) {
      const parts = self.RulesEngine.getUrlParts(url)
      targetRule = pauseAndThink.find((r) =>
        self.RulesEngine.ruleMatches(parts, [r.domain, r.substring]),
      )
    }

    if (!targetRule) {
      // Fallback domain extraction if rule not found
      try {
        const parsedUrl = new URL(url)
        targetRule = {
          id: crypto.randomUUID(),
          domain: parsedUrl.hostname,
          substring: "",
        }
      } catch {
        targetRule = { id: crypto.randomUUID(), domain: "", substring: "" }
      }
    }

    const now = Date.now()
    const updatedSessions = pauseSessions.filter(
      (s) => s.ruleId !== targetRule.id,
    )
    updatedSessions.push({
      ruleId: targetRule.id,
      domain: targetRule.domain,
      substring: targetRule.substring || "",
      activatedAt: now,
      lastActiveAt: now,
    })

    await chrome.storage.local.set({ pauseSessions: updatedSessions })
    await ensureHeartbeatAlarm()
    await rebuildDnrRules()

    return { success: true }
  } catch (err) {
    console.error(
      "[GatesOfHeavenAndHell] Failed to activate pause session:",
      err,
    )
    return { success: false, error: err.message }
  }
}

////////////////////////////////////////////////////////////////////////////
// Tab Activity Tracking
////////////////////////////////////////////////////////////////////////////

// Bumps lastActiveAt for any session that currently has a matching active tab.
// Cheap, side-effect-only refresh — does NOT expire anything itself. Safe to
// call as often as we like off tab events.
async function refreshActiveSessionTimestamps() {
  try {
    const { pauseSessions = [] } = await chrome.storage.local.get([
      "pauseSessions",
    ])
    if (!pauseSessions.length) return

    // Active tab in every window (not just the focused one) counts as "on
    // the site" — matches the intent that having the site in the tab you're
    // currently looking at, in any window, keeps the session alive.
    const activeTabs = await chrome.tabs.query({ active: true })
    const activeUrls = activeTabs
      .map((t) => t.url || t.pendingUrl || "")
      .filter(Boolean)

    const now = Date.now()
    let changed = false

    for (const session of pauseSessions) {
      const isCurrentlyActive = activeUrls.some((url) => {
        const parts = self.RulesEngine.getUrlParts(url)
        return self.RulesEngine.ruleMatches(parts, [
          session.domain,
          session.substring,
        ])
      })

      if (isCurrentlyActive && session.lastActiveAt !== now) {
        session.lastActiveAt = now
        changed = true
      }
    }

    if (changed) {
      await chrome.storage.local.set({ pauseSessions })
    }
  } catch (err) {
    console.error(
      "[GatesOfHeavenAndHell] Error in refreshActiveSessionTimestamps:",
      err,
    )
  }
}

// Track tab activation, URL updates, and closures so a return to the site
// clears the inactivity clock immediately rather than waiting for the next
// heartbeat tick.
chrome.tabs.onActivated.addListener(() => {
  refreshActiveSessionTimestamps()
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    refreshActiveSessionTimestamps()
  }
})

chrome.tabs.onRemoved.addListener(() => {
  refreshActiveSessionTimestamps()
})

chrome.windows.onFocusChanged.addListener(() => {
  refreshActiveSessionTimestamps()
})

////////////////////////////////////////////////////////////////////////////
// Heartbeat sweep — authoritative expiry check, independent of tab events.
////////////////////////////////////////////////////////////////////////////

async function ensureHeartbeatAlarm() {
  const existing = await chrome.alarms.get(ALARM_PAUSE_HEARTBEAT)
  if (!existing) {
    chrome.alarms.create(ALARM_PAUSE_HEARTBEAT, {
      delayInMinutes: HEARTBEAT_PERIOD_MINUTES,
      periodInMinutes: HEARTBEAT_PERIOD_MINUTES,
    })
  }
}

async function runPauseSessionSweep() {
  const { pauseSessions = [] } = await chrome.storage.local.get([
    "pauseSessions",
  ])
  if (!pauseSessions.length) {
    await chrome.alarms.clear(ALARM_PAUSE_HEARTBEAT)
    return
  }

  // One more real-time check before judging anyone expired.
  await refreshActiveSessionTimestamps()

  const { pauseSessions: freshSessions = [] } = await chrome.storage.local.get([
    "pauseSessions",
  ])
  const now = Date.now()
  const remaining = freshSessions.filter(
    (s) =>
      now - (s.lastActiveAt || s.activatedAt || 0) <
      PAUSE_SESSION_INACTIVITY_MS,
  )

  if (remaining.length !== freshSessions.length) {
    await chrome.storage.local.set({ pauseSessions: remaining })
    await rebuildDnrRules()
  }

  if (!remaining.length) {
    await chrome.alarms.clear(ALARM_PAUSE_HEARTBEAT)
  }
}

////////////////////////////////////////////////////////////////////////////
// Alarms — lock expiry + pause countdown + pause session heartbeat reconciliation
////////////////////////////////////////////////////////////////////////////

async function reconcileAllAlarms() {
  const { blocked = [], pauseSessions = [] } = await chrome.storage.local.get([
    "blocked",
    "pauseSessions",
  ])
  const now = Date.now()
  let stateModified = false

  // 1. Reconcile Lock & Pause Countdowns on Blocked rules
  for (const rule of blocked) {
    if (rule.locked && rule.lockedUntil) {
      if (rule.lockedUntil <= now) {
        rule.locked = false
        rule.lockedUntil = null
        stateModified = true
      } else {
        chrome.alarms.create(ALARM_LOCK_PREFIX + rule.id, {
          when: rule.lockedUntil,
        })
      }
    }
    const pp = rule.pendingPause || rule.pendingRemoval
    if (pp && pp.stage === "countdown") {
      if (pp.readyAt <= now) {
        pp.stage = "ready"
        rule.pendingPause = pp
        delete rule.pendingRemoval
        stateModified = true
      } else {
        chrome.alarms.create(ALARM_COUNTDOWN_PREFIX + rule.id, {
          when: pp.readyAt,
        })
      }
    }
  }

  // 2. Reconcile Pause Sessions — expire anything that went stale while the
  //    service worker was dormant, otherwise make sure the heartbeat is running.
  const validSessions = pauseSessions.filter(
    (s) =>
      now - (s.lastActiveAt || s.activatedAt || 0) <
      PAUSE_SESSION_INACTIVITY_MS,
  )

  if (validSessions.length !== pauseSessions.length) {
    await chrome.storage.local.set({ pauseSessions: validSessions })
    await rebuildDnrRules()
  }

  if (validSessions.length) {
    await ensureHeartbeatAlarm()
  }

  if (stateModified) {
    await chrome.storage.local.set({ blocked })
  }

  // Bring lastActiveAt up to date immediately rather than waiting for the
  // first heartbeat tick or a tab event.
  await refreshActiveSessionTimestamps()
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_PAUSE_HEARTBEAT) {
    await runPauseSessionSweep()
    return
  }

  const { blocked = [] } = await chrome.storage.local.get(["blocked"])
  let blockedChanged = false

  // Lock expiry
  if (alarm.name.startsWith(ALARM_LOCK_PREFIX)) {
    const id = alarm.name.slice(ALARM_LOCK_PREFIX.length)
    const rule = blocked.find((r) => r.id === id)
    if (rule && rule.locked) {
      rule.locked = false
      rule.lockedUntil = null
      blockedChanged = true
    }
  }

  // 30-minute Pause Countdown
  let countdownId = null
  if (alarm.name.startsWith(ALARM_COUNTDOWN_PREFIX)) {
    countdownId = alarm.name.slice(ALARM_COUNTDOWN_PREFIX.length)
  } else if (alarm.name.startsWith(LEGACY_ALARM_COUNTDOWN_PREFIX)) {
    countdownId = alarm.name.slice(LEGACY_ALARM_COUNTDOWN_PREFIX.length)
  }

  if (countdownId) {
    const rule = blocked.find((r) => r.id === countdownId)
    const pp = rule && (rule.pendingPause || rule.pendingRemoval)
    if (pp && pp.stage === "countdown") {
      pp.stage = "ready"
      rule.pendingPause = pp
      delete rule.pendingRemoval
      blockedChanged = true
    }
  }

  if (blockedChanged) {
    await chrome.storage.local.set({ blocked })
  }
})
