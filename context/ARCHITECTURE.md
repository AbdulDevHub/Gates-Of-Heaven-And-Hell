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
- Messages: `ACTIVATE_PAUSE_SESSION` (refused unless a live Pause & Think rule covers the URL), `END_PASS`, `QUICK_ADD`, `RECORD_EVENT`.
- Write chains: `mutateSessions()` (passes), `withStore()` (rule lists and settings from alarms/quick add), `recordStat()` (stats). If DNR rejects the update even after dropping bad regexes, the old rules stay and the toolbar badge shows `!`.
- On every wake-up the worker checks the `schedule:next` alarm still exists when scheduled rules exist.

### Rules engine — `scripts/rules-engine.js` (pure)
- `splitDomain` / `normalizeDomain`: host (exact or parent) + optional path prefix; `*` = any host.
- `ruleMatches` (JS) and `buildRegexFilter` (RE2 for DNR) implement the same matching. Google search substrings only look at `q=`.
- `explainUrl(url, state, now)` → verdict (`excluded | pass | pause | blocked | none`), rule, reason and near-miss notes. Used by the tester, popup, YouTube script and re-gating.
- Schedules (`isScheduleActive`, `nextScheduleBoundary`, `describeSchedule`), `isRuleLive`, `lintRule`, `buildGatePath` / `readTargetUrl`.

### Shared helpers — `scripts/shared.js` (pure)
- Settings defaults and limits, staged cooldown (`requestCooldownChange`, `effectiveCooldownMinutes`, `settleSettings`), lock window, pass resolution, stats/streak maths, JSONC parse/serialize.

### Gate pages
- **Hell gate** — `pages/blocked.html`, `scripts/blocked.js`, `styles/blocked.css`: portcullis drop + shake, embers canvas, custom message or reminder, single **Turn Back**.
- **Crossroads** — `pages/pause.html`, `scripts/pause.js`, `styles/pause.css`: Heaven gate (turn back) and the onward gate with a ring countdown that only runs while the tab is visible, then the exact phrase. Shows the rule's note and how long the pass lasts.
- **Heaven transition** — `scripts/heaven.js`, `styles/heaven.css`: shared walk-away animation that closes the tab.
- **Reminders** — `scripts/reminders.js`: `universal` and `faith` packs.

### Rule Book — `pages/options.html`
- `scripts/options.js`: tabs, rule lists grouped by domain, URL tester, filter, quick add (comma-separated words per domain), inline edit with schedule and per-rule pass overrides, lint fixes, reflection modal, lock, import/export.
- `scripts/options-journey.js`: stat tiles + inline-SVG 30-day chart with tooltip and table view.
- `scripts/options-settings.js`: reminder style, timers, staged Blocked cooldown.

### Popup — `pages/popup.html`, `scripts/popup.js`
- Current page verdict + reason, quick add (`QUICK_ADD` gates the tab immediately), open passes with **End**, today's stats.

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
  schedule?: Schedule | null;
  locked: boolean;
  lockedUntil: number | null;
  paused?: boolean;
  pausedUntil?: number | null;  // null while paused = until resumed
  pendingPause?: { stage: 'countdown' | 'ready'; reason1: string; startedAt: number; readyAt: number } | null;
}

interface PauseAndThinkRule {
  id: string; domain: string; substring?: string; note?: string; schedule?: Schedule | null;
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
}

interface Stats {
  since: number; lastSlipDay: string | null; bestStreak: number;
  days: Record<string, { blocked: number; paused: number; walkAways: number; goThroughs: number; rulePauses: number }>; // 90 days kept
}
```

JSONC import/export: `"BLOCKED": [[domain, substring?, message?] | {…}]`, `"PAUSE_AND_THINK"` / `"EXCLUDED": [[domain, substring?, note?] | {…}]`, optional `"SETTINGS"` (never includes the Blocked cooldown).

## Workflows

- **Pause a BLOCKED rule**: reason #1 → cooldown (`pauseCountdown:<id>`, length from settings) → stage `ready` → reason #2 + pause length (15 min / 1 h / end of day / until resumed) → `paused: true`, `pausedUntil` → `pauseResume:<id>` alarm auto-resumes and re-gates tabs. Counts as a slip.
- **Cooldown change**: longer applies at once; shorter is stored in `pendingCooldown` and applied by `cooldownSettle` after the current cooldown.
- **Pause & Think**: wait (visible-tab time only) → phrase → `ACTIVATE_PAUSE_SESSION` → pass. **End pass** (Rule Book or popup) re-gates open tabs.
- **Hard lock**: Mon–Thu locks expire Friday 18:00; Fri–Sun locks expire after 24 h. Locked rules can't be paused, edited or deleted, and survive Import.
- **Stats**: `blocked-view` / `pause-view` on gate load (once per tab), `walk-away`, `go-through`, `rule-paused`. Gates held = blocked views + walk-aways; slips = go-throughs + rule pauses.
