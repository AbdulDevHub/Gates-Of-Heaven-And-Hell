# Architecture — Gates Of Heaven & Hell

> How the extension is put together: components, data flow, DNR rule layering, storage schema
> and the main user workflows. Read before changing `background.js`, the rules engine or any
> stored data shape. Update it whenever a component, priority, alarm or schema field changes.

## Data flow

```
bookOfLinks.jsonc (first-install seed only)
        │
        ▼
chrome.storage.local ── blocked / excluded / pauseAndThink / pauseSessions / settings / stats
        │ onChanged                                 ▲
        ▼                                           │ writes
background.js (service worker)              options*.js (Rule Book), popup.js,
  - rebuilds DNR rules (serialized)          pause.js / blocked.js (via messages)
  - alarms: locks, cooldowns, timed pauses,
    schedule boundaries, pass heartbeat
  - re-gates open tabs, SPA navigation
        │
        ▼
declarativeNetRequest dynamic rules (live rules only: not paused, schedule on)
  P4 allow     EXCLUDED
  P3 allow     open passes (pauseSessions)
  P2 redirect  PAUSE_AND_THINK → pages/pause.html?ruleId=…&url=<raw url>
  P1 redirect  BLOCKED         → pages/blocked.html?ruleId=…&url=<raw url>
```

## Components

### Service worker — `scripts/background.js`
- Seeds storage from `bookOfLinks.jsonc` on install; `migrateStorage` adds `settings` (existing v1 installs get `reminderStyle: "faith"`, new installs `"universal"`) and `stats`.
- `storage.onChanged` → `rebuildDnrRules()` when rule filters, pause state or schedules change, or when the *set* of passes changes (`lastActiveAt` bumps don't rebuild). One promise chain; one bad regex falls back to per-rule `isRegexSupported` checks so it can't unblock everything.
- After each rebuild, `schedule:next` is set to the next schedule boundary.
- `regateOpenTabs()` sends any tab now on a gated URL to its gate page. Runs after a pass ends, a timed pause runs out or a schedule boundary.
- `webNavigation.onHistoryStateUpdated` gates single-page-app navigation that DNR never sees.
- Passes: `activity` passes refresh `lastActiveAt` from tab/window events and a 1-minute heartbeat and end after the grace period; `fixed` passes end at `expiresAt`. All `pauseSessions` writes go through `mutateSessions()`.
- Messages: `ACTIVATE_PAUSE_SESSION` (refused unless a live Pause & Think rule covers the URL), `END_PASS`, `QUICK_ADD`, `RECORD_EVENT` (`{ event, ruleId }`), `GATE_OPENED` (`{ kind: 'blocked' | 'pause', ruleId }`), `RESOLVE_GATE` (`{ outcome: 'walk-away', ruleId }`).
- Auto-close: a tab opened from a link (`openerTabId`) that hasn't committed a real page yet (`usedTabs` in `storage.session`) and is heading to a Blocked rule is removed in `webNavigation.onBeforeNavigate` (fallback: `GATE_OPENED` from `blocked.js`) and counted as a gate held. Existing tabs are marked used on install/startup.
- Open gates: `pause.html` registers its tab in `openGates`; `RESOLVE_GATE` / `ACTIVATE_PAUSE_SESSION` clear it. Closing the tab (`tabs.onRemoved`) or navigating it elsewhere (`webNavigation.onCommitted`) with the entry still there counts a walk-away. Entries left at browser startup count; an install/reload clears them without counting.
- Pass time: when passes end (expiry, End pass, replacement) `recordEndedPasses` adds `passMinutesUsed` to the stats.
- Write chains: `mutateSessions()` (passes), `withStore()` (rule lists and settings from alarms/quick add), `recordStat()` / `recordEndedPasses()` (stats), `mutateGates()` (open gates). If DNR rejects the update even after dropping bad regexes, the old rules stay and the toolbar badge shows `!`.
- On every wake-up the worker checks the `schedule:next` alarm still exists when scheduled rules exist.

### Rules engine — `scripts/rules-engine.js` (pure)
- `splitDomain` / `normalizeDomain`: host (exact or parent) + optional path prefix; `*` = any host.
- `ruleMatches` (JS) and `buildRegexFilter` (RE2 for DNR) implement the same matching. Google search substrings only look at `q=` and must start a word there (prefix match: `je` ≠ "object", `bat` = "batman").
- `explainUrl(url, state, now)` → verdict (`excluded | pass | pause | blocked | none`), rule, reason and near-miss notes. Used by the tester, popup, YouTube script and re-gating.
- Schedules (`isScheduleActive`, `nextScheduleBoundary`, `describeSchedule`), `isRuleLive`, `lintRule`, `buildGatePath` / `readTargetUrl`.

### Shared helpers — `scripts/shared.js` (pure)
- Settings defaults and limits, staged cooldown (`requestCooldownChange`, `effectiveCooldownMinutes`, `settleSettings`) and per-rule cooldown (`ruleCooldownMinutes`, `requestRuleCooldown`), lock window, pass resolution, gate phrase (`gatePhrase`), stats maths (`recordEvent`, `recordPassTime`, `ruleStreak`, `ruleBoard`, `summarizeStats`), JSONC parse/serialize.

### Gate pages
- **Hell gate** — `pages/blocked.html`, `scripts/blocked.js`, `styles/blocked.css`: portcullis drop + shake (with an SVG heat-shimmer filter), a flame-wall canvas, an embers canvas with periodic flares, custom message or reminder, the rule's "last paused / streak" line, single **Turn Back**.
- **Crossroads** — `pages/pause.html`, `scripts/pause.js`, `styles/pause.css`: cool night sky with split light; the whole Heaven card is the Turn Back button; the onward gate has an open-ended sweeping ring (no number, no progress) while the wait runs on visible time only, then the phrase (the rule's note, else `Yes I Am Sure`; paste blocked), then a 5 s gate-grinding animation before the pass is granted. Shows the rule's "last went through / streak / best".
- **Heaven transition** — `scripts/heaven.js`, `styles/heaven.css`: shared walk-away animation that closes the tab.
- **Reminders** — `scripts/reminders.js`: `universal` and `faith` packs.

### Rule Book — `pages/options.html`
- `scripts/options.js`: tabs (`showTab`), rule lists grouped by domain, filter, quick add (comma-separated words per domain), inline edit with schedule, sentence-style per-rule timing (Pause & Think) and per-rule cooldown (Blocked), lint fixes, reflection modal, lock, URL tester and import/export (their markup lives in Settings).
- `scripts/options-journey.js`: 8 tiles, 30-day chart, year calendar, weekday × hour heatmap, Pause & Think funnel, time on passes, sortable per-rule table. Today's slips are never shown.
- `scripts/options-settings.js`: bento grid of cards: Pause & Think defaults, Blocked cooldown (staged), reminders, backup, Journey estimate, URL tester, per-site timings list.

### Popup — `pages/popup.html`, `scripts/popup.js`
- Current page verdict + reason, quick add with an editable site and optional "only URLs containing" text plus a preview (`QUICK_ADD` gates the tab immediately), open passes with **End**, held today / best rule streak / rules on a streak. The exception button only appears for an ungated page on the same site.

### YouTube interceptor — `scripts/content-youtube.js`
- Keeps a cached copy of the rules and catches gated `/results` search submits synchronously.

### Incognito
- `"incognito": "split"`: incognito windows get their own extension instance.

## Storage schema (`chrome.storage.local`)

```typescript
interface Schedule { days: number[]; start: string; end: string } // 0 = Sunday, "HH:MM"

interface BlockedRule {
  id: string;
  domain: string;               // "youtube.com", "google.com/search", "*"
  substring?: string;
  message?: string;             // shown on the Hell gate
  createdAt?: number;           // per-rule streaks start here (older rules: stats.since)
  cooldownMinutes?: number | null;                                     // null = settings default
  pendingCooldown?: { minutes: number | null; effectiveAt: number } | null; // staged shorter cooldown
  schedule?: Schedule | null;
  locked: boolean;
  lockedUntil: number | null;
  paused?: boolean;
  pausedUntil?: number | null;  // null while paused = until resumed
  pendingPause?: { stage: 'countdown' | 'ready'; reason1: string; startedAt: number; readyAt: number } | null;
}

interface PauseAndThinkRule {
  id: string; domain: string; substring?: string; schedule?: Schedule | null; createdAt?: number;
  note?: string;                                        // also the phrase to type (else "Yes I Am Sure")
  waitSeconds?: number | null;                          // null = settings default
  passMode?: 'activity' | 'fixed' | 'endOfDay' | null;  // null = settings default
  passMinutes?: number | null;                          // grace (activity) or length (fixed)
}

interface ExcludedRule { id: string; domain: string; substring?: string; note?: string; schedule?: Schedule | null; }

interface PauseSession {        // an open pass
  ruleId: string; domain: string; substring: string;
  activatedAt: number; lastActiveAt: number;
  mode?: 'activity' | 'fixed';  // missing = activity with 5-min grace (v1 sessions)
  graceMs?: number | null; expiresAt?: number | null;
}

interface Settings {
  reminderStyle: 'universal' | 'faith';
  pauseWaitSeconds: number; passMode: 'activity' | 'fixed' | 'endOfDay';
  passGraceMinutes: number; passFixedMinutes: number;
  blockedCooldownMinutes: number;
  pendingCooldown: { minutes: number; effectiveAt: number } | null;
  minutesPerGate: number;
  soundEffects: boolean;       // default true
}

interface Stats {                // older stats without rules/hours still load
  since: number; lastSlipDay: string | null; bestStreak: number;  // overall
  days: Record<string, { blocked; paused; walkAways; goThroughs; rulePauses; unlocked?; typed?; passMinutes? }>; // 365 days kept
  rules?: Record<string /* ruleId */, {
    list: 'blocked' | 'pauseAndThink' | null; label: string; since: number;
    views; held; walkAways; goThroughs; rulePauses; unlocked; typed; passMinutes;
    lastSlipAt: number | null; bestStreak: number;
  }>;
  hours?: number[][];          // [weekday 0-6][hour 0-23] gate views
  log?: { at; e /* event | 'pass-time' */; r?; m?; newRule?; rSlip?; rBest?; slipDay?; best? }[]; // last 2 days, undo info for clearing
}

openGates: Record<tabId, { ruleId: string | null; at: number }>  // Pause & Think gate tabs not yet resolved
// storage.session: usedTabs: Record<tabId, 1>  (tabs that committed a real page)
```

JSONC import/export (Blocked objects may carry `cooldownMinutes`; an imported value below the current default is dropped): `"BLOCKED": [[domain, substring?, message?] | {…}]`, `"PAUSE_AND_THINK"` / `"EXCLUDED": [[domain, substring?, note?] | {…}]`, optional `"SETTINGS"` (never includes the Blocked cooldown).

## Workflows

- **Pause a BLOCKED rule**: reason #1 → cooldown (`pauseCountdown:<id>`, length from settings) → stage `ready` → reason #2 + pause length (15 min / 1 h / end of day / until resumed) → `paused: true`, `pausedUntil` → `pauseResume:<id>` alarm auto-resumes and re-gates tabs. Counts as a slip.
- **Cooldown change**: longer applies at once; shorter is stored in `pendingCooldown` and applied by `cooldownSettle` after the current cooldown.
- **Pause & Think**: wait (visible-tab time only) → phrase → 5 s opening → `ACTIVATE_PAUSE_SESSION` → pass. **End pass** (Rule Book or popup) re-gates open tabs. Closing the tab any time before the pass is granted is a walk-away.
- **Per-rule cooldown**: same rule as the global one; `requestRuleCooldown` stages a shorter value (or a switch back to a shorter default) until the current cooldown has passed.
- **Hard lock**: Mon–Thu locks expire Friday 18:00; Fri–Sun locks expire after 24 h. Locked rules can't be paused, edited or deleted, and survive Import.
- **Clear stats** (Journey header: Last hour / Today / All time, click twice): `CLEAR_STATS` → `SH.clearStats` replays `stats.log` backwards (day buckets, rule rows, hour heatmap, last-slip and best-streak values restored). Today also drops today's day bucket; All time keeps `since`.
- **Sounds**: `sfx.js` — `hell` (portcullis slam on the Hell gate), `chime` (wait over), `grind` (gate opening), `heaven` (walk-away), `deny` (paste blocked). Off via `settings.soundEffects`.
- **Stats**: `blocked-view` / `pause-view` on gate load (once per tab) or auto-close, `gate-unlocked`, `phrase-typed`, `walk-away` (button, tab closed, navigated away), `go-through`, `rule-paused`, all with a `ruleId`. Gates held = blocked views + walk-aways; slips = go-throughs + rule pauses. Streaks are per rule (days since that rule's last slip).
