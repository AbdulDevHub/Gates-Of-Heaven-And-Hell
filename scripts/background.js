// background.js — MV3 service worker. No in-memory state: everything lives in
// chrome.storage.local and every timer is a chrome.alarms alarm.
//
// Responsibilities:
//   1. Seed storage from bundled bookOfLinks.jsonc on first install; migrate settings.
//   2. Compile live rules (schedule on, not paused) and open passes into
//      declarativeNetRequest dynamic rules, through ONE serialized promise chain.
//   3. Timers: lock expiry, pause cooldowns, timed rule pauses, schedule
//      boundaries, staged cooldown changes and the pass heartbeat.
//   4. Passes (Pause & Think sessions): "activity" passes live while a matching
//      tab is active and end after a grace period; "fixed" passes end at a time.
//   5. Re-gate open tabs when access ends, and catch single-page-app navigation
//      (history.pushState) that DNR can't see.
//   6. Stats: count gate views, walk-aways and slips (serialized writes).

importScripts("rules-engine.js", "shared.js")

const RE = self.RulesEngine
const SH = self.Shared

const ALARM_LOCK_PREFIX = "lock:"
const ALARM_COUNTDOWN_PREFIX = "pauseCountdown:"
const LEGACY_ALARM_COUNTDOWN_PREFIX = "removalCountdown:"
const ALARM_PAUSE_RESUME_PREFIX = "pauseResume:"
const ALARM_PAUSE_HEARTBEAT = "pauseSessionHeartbeat"
const ALARM_SCHEDULE = "schedule:next"
const ALARM_COOLDOWN_SETTLE = "cooldownSettle"
const HEARTBEAT_PERIOD_MINUTES = 1 // also the max lag before a pass ends

const LOG = "[GatesOfHeavenAndHell]"

let rebuildChain = Promise.resolve()
let statsChain = Promise.resolve()
let storeChain = Promise.resolve()

// Serializes the worker's own read-modify-write of the rule lists and
// settings, so two alarms (or an alarm and a popup quick add) can't overwrite
// each other's changes.
function withStore(fn) {
  const run = storeChain.then(fn)
  storeChain = run.catch((err) => console.error(LOG, "Storage update failed:", err))
  return run
}

// Every wake-up: if Chrome dropped the schedule alarm (e.g. after the
// extension was disabled and re-enabled), rebuild so schedules keep flipping.
;(async () => {
  try {
    const [alarm, s] = await Promise.all([
      chrome.alarms.get(ALARM_SCHEDULE),
      chrome.storage.local.get(["blocked", "excluded", "pauseAndThink"]),
    ])
    const rules = [...(s.blocked || []), ...(s.excluded || []), ...(s.pauseAndThink || [])]
    if (!alarm && rules.some((r) => RE.isValidSchedule(r.schedule))) rebuildDnrRules()
  } catch {}
})()

////////////////////////////////////////////////////////////////////////////
// Install / startup
////////////////////////////////////////////////////////////////////////////

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await seedFromBundledFile()
  }
  await migrateStorage(details.reason)
  await rebuildDnrRules()
  await reconcileAllAlarms()
})

chrome.runtime.onStartup.addListener(async () => {
  await rebuildDnrRules()
  await reconcileAllAlarms()
})

async function seedFromBundledFile() {
  let book = { blocked: [], excluded: [], pauseAndThink: [] }
  try {
    const res = await fetch(chrome.runtime.getURL("bookOfLinks.jsonc"))
    book = SH.parseRuleBook(await res.text())
    console.log(LOG, "Seeded", book.blocked.length, "blocked,", book.excluded.length, "excluded,", book.pauseAndThink.length, "pause & think rules.")
  } catch (err) {
    console.warn(LOG, "No seed file, starting empty:", err.message)
  }
  await chrome.storage.local.set({
    blocked: book.blocked,
    excluded: book.excluded,
    pauseAndThink: book.pauseAndThink,
    pauseSessions: [],
    settings: SH.mergeSettings(Object.assign({ reminderStyle: "universal" }, SH.importableSettings(book.settings))),
    stats: SH.emptyStats(Date.now()),
    seeded: true,
  })
}

// Existing installs (v1) keep the faith-based reminders they already had;
// rules get the newer optional fields lazily (all are optional).
async function migrateStorage(reason) {
  const { settings, stats, seeded, pauseSessions } = await chrome.storage.local.get(["settings", "stats", "seeded", "pauseSessions"])
  const patch = {}
  if (!settings) {
    patch.settings = SH.mergeSettings({ reminderStyle: reason === "update" && seeded ? "faith" : "universal" })
  }
  if (!stats) patch.stats = SH.emptyStats(Date.now())
  if (!Array.isArray(pauseSessions)) patch.pauseSessions = []
  if (Object.keys(patch).length) await chrome.storage.local.set(patch)
}

async function getState() {
  const s = await chrome.storage.local.get(["blocked", "excluded", "pauseAndThink", "pauseSessions", "settings"])
  return {
    blocked: s.blocked || [],
    excluded: s.excluded || [],
    pauseAndThink: s.pauseAndThink || [],
    pauseSessions: s.pauseSessions || [],
    settings: SH.mergeSettings(s.settings),
  }
}

////////////////////////////////////////////////////////////////////////////
// declarativeNetRequest compilation
//   P4 allow     EXCLUDED
//   P3 allow     open passes
//   P2 redirect  PAUSE_AND_THINK -> pages/pause.html
//   P1 redirect  BLOCKED         -> pages/blocked.html
////////////////////////////////////////////////////////////////////////////

function rebuildDnrRules(opts = {}) {
  rebuildChain = rebuildChain
    .then(() => doRebuildDnrRules())
    .then(() => (opts.regate ? regateOpenTabs() : null))
    .catch((err) => console.error(LOG, "Failed to update DNR rules:", err))
  return rebuildChain
}

function redirectTo(page, ruleId) {
  const base = chrome.runtime.getURL(`pages/${page}`)
  // The original URL goes LAST and raw (DNR can't encode \1); pages read it
  // with RulesEngine.readTargetUrl, which keeps any "&" inside it intact.
  return { type: "redirect", redirect: { regexSubstitution: `${base}?ruleId=${encodeURIComponent(ruleId)}&url=\\1` } }
}

async function doRebuildDnrRules() {
  const state = await getState()
  const now = Date.now()
  const candidates = []

  for (const rule of state.excluded) {
    if (!RE.isRuleLive(rule, now)) continue
    candidates.push({ priority: 4, action: { type: "allow" }, rule })
  }
  for (const session of state.pauseSessions) {
    candidates.push({ priority: 3, action: { type: "allow" }, rule: session })
  }
  for (const rule of state.pauseAndThink) {
    if (!RE.isRuleLive(rule, now)) continue
    candidates.push({ priority: 2, action: redirectTo("pause.html", rule.id), rule })
  }
  for (const rule of state.blocked) {
    if (!RE.isRuleLive(rule, now)) continue
    candidates.push({ priority: 1, action: redirectTo("blocked.html", rule.id), rule })
  }

  const build = (list) =>
    list
      .map((c) => ({ c, regexFilter: RE.buildRegexFilter(c.rule.domain, c.rule.substring) }))
      .filter((x) => x.regexFilter)
      .map((x, i) => ({
        id: i + 1,
        priority: x.c.priority,
        action: x.c.action,
        condition: { regexFilter: x.regexFilter, resourceTypes: ["main_frame"] },
      }))

  let addRules = build(candidates)
  const existing = await chrome.declarativeNetRequest.getDynamicRules()
  const removeRuleIds = existing.map((r) => r.id)

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules })
  } catch (err) {
    // One unsupported regex rejects the whole batch, which would silently
    // unblock everything. Drop only the offenders and retry.
    console.warn(LOG, "DNR update rejected, checking each rule:", err.message)
    const ok = []
    for (const c of candidates) {
      const regex = RE.buildRegexFilter(c.rule.domain, c.rule.substring)
      if (!regex) continue
      const res = await chrome.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive: false })
      if (res.isSupported) ok.push(c)
      else console.warn(LOG, "Skipping unsupported rule:", c.rule.domain, c.rule.substring, res.reason)
    }
    addRules = build(ok)
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules })
    } catch (err2) {
      // The previous rules stay active (nothing is unblocked); flag it.
      chrome.action.setBadgeBackgroundColor({ color: "#8b2e2e" })
      chrome.action.setBadgeText({ text: "!" })
      chrome.action.setTitle({ title: `Gates Of Heaven & Hell: rules could not be updated (${err2.message})` })
      throw err2
    }
  }
  chrome.action.setBadgeText({ text: "" })
  chrome.action.setTitle({ title: "Gates Of Heaven & Hell" })

  await scheduleNextBoundary(state, now)
}

async function scheduleNextBoundary(state, now) {
  const next = RE.nextScheduleBoundary([...state.blocked, ...state.pauseAndThink, ...state.excluded], now)
  if (next) chrome.alarms.create(ALARM_SCHEDULE, { when: next + 1000 })
  else await chrome.alarms.clear(ALARM_SCHEDULE)
}

const ruleFingerprint = (list) =>
  (list || [])
    .map((r) => [r.id, r.domain, r.substring, RE.isRulePaused(r, Date.now()), r.pausedUntil || "", JSON.stringify(r.schedule || null)].join("|"))
    .join(",")

const sessionFingerprint = (list) =>
  (list || [])
    .map((s) => `${s.ruleId}|${s.domain || ""}|${s.substring || ""}`)
    .sort()
    .join(",")

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return
  let rebuild = false
  for (const key of ["blocked", "excluded", "pauseAndThink"]) {
    if (changes[key] && ruleFingerprint(changes[key].oldValue) !== ruleFingerprint(changes[key].newValue)) rebuild = true
  }
  // lastActiveAt bumps on every tab event; only a change in WHICH passes
  // exist should touch DNR.
  if (changes.pauseSessions && sessionFingerprint(changes.pauseSessions.oldValue) !== sessionFingerprint(changes.pauseSessions.newValue)) {
    rebuild = true
  }
  if (rebuild) rebuildDnrRules()
  if (changes.blocked) reconcilePauseResumeAlarms(changes.blocked.newValue || [])
  if (changes.settings) reconcileCooldownAlarm(changes.settings.newValue)
})

////////////////////////////////////////////////////////////////////////////
// Gating open tabs
////////////////////////////////////////////////////////////////////////////

function gateUrlFor(verdict, ruleId, url) {
  const page = verdict === "pause" ? "pause.html" : "blocked.html"
  return chrome.runtime.getURL(RE.buildGatePath(page, ruleId, url))
}

async function gateTabIfNeeded(tabId, url, state) {
  if (!url || !/^https?:/i.test(url)) return false
  const s = state || (await getState())
  const ex = RE.explainUrl(url, s, Date.now())
  if (ex.verdict !== "pause" && ex.verdict !== "blocked") return false
  await chrome.tabs.update(tabId, { url: gateUrlFor(ex.verdict, ex.rule && ex.rule.id, url) })
  return true
}

// Sends any tab that is now on a gated page back to its gate. Runs after a
// pass ends, a timed pause runs out, or a schedule switches a rule on.
async function regateOpenTabs() {
  const state = await getState()
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) {
    try {
      await gateTabIfNeeded(tab.id, tab.url || tab.pendingUrl, state)
    } catch (err) {
      console.warn(LOG, "Could not re-gate tab", tab.id, err.message)
    }
  }
}

// Single-page apps (Reddit, YouTube, X...) change the URL with pushState, which
// never reaches DNR. Catch those top-frame changes here.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return
  try {
    await gateTabIfNeeded(details.tabId, details.url)
  } catch (err) {
    console.warn(LOG, "SPA gate failed:", err.message)
  }
})

////////////////////////////////////////////////////////////////////////////
// Messages from pages and the popup
////////////////////////////////////////////////////////////////////////////

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    ACTIVATE_PAUSE_SESSION: handleActivatePauseSession,
    RECORD_EVENT: (m) => recordStat(m.event).then(() => ({ success: true })),
    END_PASS: handleEndPass,
    QUICK_ADD: handleQuickAdd,
  }
  const handler = message && handlers[message.action]
  if (!handler) return
  handler(message, sender)
    .then((res) => sendResponse(res))
    .catch((err) => {
      console.error(LOG, message.action, "failed:", err)
      sendResponse({ success: false, error: err.message })
    })
  return true // async response
})

async function handleActivatePauseSession({ ruleId, url }) {
  const { pauseAndThink, settings } = await getState()

  // A pass is only ever granted for a live Pause & Think rule. (v1 minted a
  // pass for any hostname, so opening pause.html by hand could get around a
  // Blocked rule.)
  const now = Date.now()
  const live = pauseAndThink.filter((r) => RE.isRuleLive(r, now))
  let target = live.find((r) => r.id === ruleId)
  if (!target && url) target = RE.findMatchingRule(url, live)
  if (!target) return { success: false, error: "No Pause & Think rule covers this page." }

  const pass = SH.resolvePass(target, settings, now)
  if (url && !/^https?:\/\//i.test(url)) return { success: false, error: "Not a web page." }
  await mutateSessions((sessions) => [
    ...sessions.filter((s) => s.ruleId !== target.id),
    {
      ruleId: target.id,
      domain: target.domain,
      substring: target.substring || "",
      activatedAt: now,
      lastActiveAt: now,
      mode: pass.mode,
      graceMs: pass.graceMs || null,
      expiresAt: pass.expiresAt || null,
    },
  ])
  await recordStat("go-through")
  await ensureHeartbeatAlarm()
  await rebuildDnrRules()
  return { success: true, pass: pass.label }
}

async function handleEndPass({ ruleId }) {
  await mutateSessions((sessions) => sessions.filter((s) => s.ruleId !== ruleId))
  await rebuildDnrRules({ regate: true })
  return { success: true }
}

async function handleQuickAdd({ list, domain, substring, note, tabId, url }) {
  if (!["blocked", "pauseAndThink", "excluded"].includes(list)) throw new Error("Unknown list")
  const clean = RE.normalizeDomain(domain)
  if (!clean) throw new Error("No domain")
  const exists = await withStore(async () => {
    const { [list]: rules = [] } = await chrome.storage.local.get([list])
    const found = rules.some((r) => RE.normalizeDomain(r.domain) === clean && (r.substring || "") === (substring || ""))
    if (!found) {
      const rule = SH.makeRule(list, { domain: clean, substring: substring || "", note: note || "" })
      await chrome.storage.local.set({ [list]: [...rules, rule] })
    }
    return found
  })
  await rebuildDnrRules()
  if (tabId != null && url) await gateTabIfNeeded(tabId, url)
  return { success: true, existed: exists }
}

////////////////////////////////////////////////////////////////////////////
// Stats (serialized so concurrent gate pages can't lose increments)
////////////////////////////////////////////////////////////////////////////

function recordStat(event) {
  statsChain = statsChain
    .then(async () => {
      const { stats } = await chrome.storage.local.get(["stats"])
      await chrome.storage.local.set({ stats: SH.recordEvent(stats, event, Date.now()) })
    })
    .catch((err) => console.error(LOG, "Stats write failed:", err))
  return statsChain
}

////////////////////////////////////////////////////////////////////////////
// Pass tracking
////////////////////////////////////////////////////////////////////////////

// Every read-modify-write of pauseSessions goes through this chain, so a tab
// event refreshing timestamps can never resurrect a pass that was just ended
// or expired. `fn` gets a copy and returns the new list (or null for "no change").
let sessionChain = Promise.resolve()
function mutateSessions(fn) {
  const run = sessionChain.then(async () => {
    const { pauseSessions = [] } = await chrome.storage.local.get(["pauseSessions"])
    const next = await fn(pauseSessions.map((s) => Object.assign({}, s)))
    if (next) await chrome.storage.local.set({ pauseSessions: next })
    return { before: pauseSessions, after: next || pauseSessions }
  })
  sessionChain = run.catch((err) => console.error(LOG, "Pass update failed:", err))
  return run
}

// Bumps lastActiveAt for activity passes that have a matching active tab (in
// any window). Never expires anything itself.
async function refreshActiveSessionTimestamps() {
  try {
    const activeTabs = await chrome.tabs.query({ active: true })
    const activeParts = activeTabs.map((t) => RE.getUrlParts(t.url || t.pendingUrl || ""))
    await mutateSessions((sessions) => {
      const now = Date.now()
      let changed = false
      for (const session of sessions) {
        if (session.mode === "fixed") continue
        if (activeParts.some((p) => RE.ruleMatches(p, [session.domain, session.substring]))) {
          session.lastActiveAt = now
          changed = true
        }
      }
      return changed ? sessions : null
    })
  } catch (err) {
    console.error(LOG, "refreshActiveSessionTimestamps failed:", err)
  }
}

chrome.tabs.onActivated.addListener(() => refreshActiveSessionTimestamps())
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") refreshActiveSessionTimestamps()
})
chrome.tabs.onRemoved.addListener(() => refreshActiveSessionTimestamps())
chrome.windows.onFocusChanged.addListener(() => refreshActiveSessionTimestamps())

async function ensureHeartbeatAlarm() {
  const existing = await chrome.alarms.get(ALARM_PAUSE_HEARTBEAT)
  if (!existing) {
    chrome.alarms.create(ALARM_PAUSE_HEARTBEAT, {
      delayInMinutes: HEARTBEAT_PERIOD_MINUTES,
      periodInMinutes: HEARTBEAT_PERIOD_MINUTES,
    })
  }
}

// Authoritative expiry check, independent of tab events.
async function runPauseSessionSweep() {
  const { pauseSessions = [] } = await chrome.storage.local.get(["pauseSessions"])
  if (!pauseSessions.length) {
    await chrome.alarms.clear(ALARM_PAUSE_HEARTBEAT)
    return
  }
  await refreshActiveSessionTimestamps()
  await expireSessions()
}

async function expireSessions() {
  const { before, after } = await mutateSessions((sessions) => {
    const now = Date.now()
    const remaining = sessions.filter((s) => !SH.sessionExpired(s, now))
    return remaining.length !== sessions.length ? remaining : null
  })
  if (after.length !== before.length) await rebuildDnrRules({ regate: true })
  if (after.length) await ensureHeartbeatAlarm()
  else await chrome.alarms.clear(ALARM_PAUSE_HEARTBEAT)
}

////////////////////////////////////////////////////////////////////////////
// Alarms
////////////////////////////////////////////////////////////////////////////

function reconcilePauseResumeAlarms(blocked) {
  const now = Date.now()
  for (const rule of blocked) {
    const name = ALARM_PAUSE_RESUME_PREFIX + rule.id
    if (rule.paused && rule.pausedUntil) {
      chrome.alarms.create(name, { when: Math.max(rule.pausedUntil, now + 1000) })
    } else {
      chrome.alarms.clear(name)
    }
  }
}

function reconcileCooldownAlarm(settings) {
  const p = settings && settings.pendingCooldown
  if (p && p.effectiveAt) chrome.alarms.create(ALARM_COOLDOWN_SETTLE, { when: Math.max(p.effectiveAt, Date.now() + 1000) })
  else chrome.alarms.clear(ALARM_COOLDOWN_SETTLE)
}

function settleCooldown() {
  return withStore(async () => {
    const { settings } = await chrome.storage.local.get(["settings"])
    const res = SH.settleSettings(settings, Date.now())
    if (res.changed) await chrome.storage.local.set({ settings: res.settings })
  })
}

async function reconcileAllAlarms() {
  const { blocked, settings, resumed } = await withStore(reconcileBlockedRules)
  reconcilePauseResumeAlarms(blocked)
  reconcileCooldownAlarm(settings)
  await settleCooldown()
  await expireSessions()
  await refreshActiveSessionTimestamps()
  if (resumed) await rebuildDnrRules({ regate: true })
}

async function reconcileBlockedRules() {
  const { blocked = [], settings } = await chrome.storage.local.get(["blocked", "settings"])
  const now = Date.now()
  let modified = false
  let resumed = false

  for (const rule of blocked) {
    if (rule.locked && rule.lockedUntil) {
      if (rule.lockedUntil <= now) {
        rule.locked = false
        rule.lockedUntil = null
        modified = true
      } else {
        chrome.alarms.create(ALARM_LOCK_PREFIX + rule.id, { when: rule.lockedUntil })
      }
    }
    const pp = rule.pendingPause || rule.pendingRemoval
    if (pp && pp.stage === "countdown") {
      if (pp.readyAt <= now) {
        pp.stage = "ready"
        rule.pendingPause = pp
        delete rule.pendingRemoval
        modified = true
      } else {
        chrome.alarms.create(ALARM_COUNTDOWN_PREFIX + rule.id, { when: pp.readyAt })
      }
    }
    if (rule.paused && rule.pausedUntil && rule.pausedUntil <= now) {
      rule.paused = false
      rule.pausedUntil = null
      modified = true
      resumed = true
    }
  }

  if (modified) await chrome.storage.local.set({ blocked })
  return { blocked, settings, resumed }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const name = alarm.name

  if (name === ALARM_PAUSE_HEARTBEAT) return runPauseSessionSweep()
  if (name === ALARM_SCHEDULE) return rebuildDnrRules({ regate: true })
  if (name === ALARM_COOLDOWN_SETTLE) return settleCooldown()

  const regate = await withStore(() => applyRuleAlarm(name))
  if (regate) await rebuildDnrRules({ regate: true })
})

async function applyRuleAlarm(name) {
  const { blocked = [] } = await chrome.storage.local.get(["blocked"])
  let changed = false
  let regate = false

  if (name.startsWith(ALARM_LOCK_PREFIX)) {
    const rule = blocked.find((r) => r.id === name.slice(ALARM_LOCK_PREFIX.length))
    if (rule && rule.locked) {
      rule.locked = false
      rule.lockedUntil = null
      changed = true
    }
  }

  let countdownId = null
  if (name.startsWith(ALARM_COUNTDOWN_PREFIX)) countdownId = name.slice(ALARM_COUNTDOWN_PREFIX.length)
  else if (name.startsWith(LEGACY_ALARM_COUNTDOWN_PREFIX)) countdownId = name.slice(LEGACY_ALARM_COUNTDOWN_PREFIX.length)
  if (countdownId) {
    const rule = blocked.find((r) => r.id === countdownId)
    const pp = rule && (rule.pendingPause || rule.pendingRemoval)
    if (pp && pp.stage === "countdown") {
      pp.stage = "ready"
      rule.pendingPause = pp
      delete rule.pendingRemoval
      changed = true
    }
  }

  if (name.startsWith(ALARM_PAUSE_RESUME_PREFIX)) {
    const rule = blocked.find((r) => r.id === name.slice(ALARM_PAUSE_RESUME_PREFIX.length))
    if (rule && rule.paused && rule.pausedUntil && rule.pausedUntil <= Date.now() + 1000) {
      rule.paused = false
      rule.pausedUntil = null
      changed = true
      regate = true
    }
  }

  if (changed) await chrome.storage.local.set({ blocked })
  return regate
}
