# Architecture — Gates Of Heaven & Hell

> How the extension is put together: components, data flow, DNR rule layering, storage schema
> and the main user workflows. Read before changing `background.js`, the rules engine or any
> stored data shape. Update it whenever a component, priority, alarm or schema field changes.

## Data flow

```
bookOfLinks.jsonc (first-install seed only)
        │
        ▼
chrome.storage.local  ── blocked / excluded / pauseAndThink / pauseSessions
        │ onChanged                         ▲
        ▼                                   │ writes
background.js (service worker)        options.js (Rule Book), pause.js (via message)
  - rebuilds DNR rules (serialized)
  - lock / pause-countdown alarms
  - pause-session heartbeat
        │
        ▼
declarativeNetRequest dynamic rules
  P4 allow     EXCLUDED
  P3 allow     active pauseSessions
  P2 redirect  PAUSE_AND_THINK → pages/pause.html
  P1 redirect  BLOCKED (not paused) → pages/blocked.html?ruleId=…&url=…
```

## Components

### Service worker — `scripts/background.js`
- Seeds storage from `bookOfLinks.jsonc` on install; opens the Rule Book on toolbar click.
- `storage.onChanged` → rebuilds dynamic DNR rules through one promise chain (no overlapping rebuilds). `lastActiveAt`-only changes to `pauseSessions` don't trigger rebuilds.
- `reconcileAllAlarms` recreates `lock:<id>` and `pauseCountdown:<id>` alarms on wake-up (legacy `removalCountdown:` alarms are still handled).
- Pause sessions: each session carries `lastActiveAt`, refreshed by tab/window events and by a 1-minute `pauseSessionHeartbeat` alarm. A session expires after 5 minutes with no active tab matching its rule; the heartbeat stops when no sessions remain.
- Handles the `ACTIVATE_PAUSE_SESSION` message from `pause.js`, which starts a pause session.

### Rules engine — `scripts/rules-engine.js`
- Pure JS, no `chrome.*`. Loaded by the worker (`importScripts`), the YouTube content script and the pages.
- Compiles domain + substring to RE2 DNR regex: `(?i)^(https?://.*<domain>.*<substring>.*)`.
- `ruleMatches` does plain AND-matching (host/URL contains domain; URL contains substring). For Google search rules the substring is checked against the decoded `q=` value only.

### YouTube interceptor — `scripts/content-youtube.js`
- `document_start` on `*://*.youtube.com/*`; catches `/results?search_query=…` form submits matching an active blocked rule and jumps straight to `blocked.html`.

### Rule Book — `pages/options.html`, `scripts/options.js`, `styles/options.css`
- Grouped domain lists, inline edit, reflection modals, countdown tickers, lock, JSONC import/export.

### Blocked page — `pages/blocked.html`, `scripts/blocked.js`, `styles/blocked.css`
- Gate animation; shows the rule's custom message or an Islamic reminder; single **Close Tab** button (`chrome.tabs.remove`) with an affirmation toast.

### Pause & Think gate — `pages/pause.html`, `scripts/pause.js`, `styles/pause.css`
- 15-second ambient reflection ("Are You Sure You Want To Continue?"), then an input that must equal `Yes I Am Sure` exactly; on success the worker creates a pause session and the tab continues.

### Incognito
- `"incognito": "split"` gives incognito windows their own extension instance, so the blocked/pause pages and Rule Book load there without policy blocks.

## Storage schema (`chrome.storage.local`)

```typescript
interface BlockedRule {
  id: string;                 // crypto.randomUUID()
  domain: string;             // "youtube.com"
  substring?: string;         // "shorts"
  message?: string;           // custom text for blocked.html
  locked: boolean;
  lockedUntil: number | null; // ms timestamp
  paused?: boolean;
  pendingPause?: {
    stage: 'countdown' | 'ready';
    reason1: string;
    startedAt: number;
    readyAt: number;          // startedAt + 30 min
  } | null;
}

interface PauseAndThinkRule { id: string; domain: string; substring?: string; }
interface ExcludedRule      { id: string; domain: string; substring?: string; }

interface PauseSession {
  ruleId: string;
  domain: string;
  substring: string;
  activatedAt: number;
  lastActiveAt: number;       // refreshed while a matching tab is active
}
// keys: blocked: BlockedRule[], excluded: ExcludedRule[],
//       pauseAndThink: PauseAndThinkRule[], pauseSessions: PauseSession[]
```

JSONC seed/import format: `"BLOCKED": [[domain, substring?, message?]]`, `"EXCLUDED"` and `"PAUSE_AND_THINK": [[domain, substring?]]`.

## Workflows

- **Pause a BLOCKED rule**: reason #1 → 30-min `pauseCountdown:<id>` → stage `ready` → final reflection → `paused: true` (dropped from DNR, `⏸️ Paused` badge). **Resume** re-enables instantly.
- **Delete**: instant; clears the rule and its alarms.
- **Hard lock**: Mon–Thu locks expire Friday 18:00 (holds through the weekend); Fri–Sun locks expire after 24 h. While locked, the rule can't be paused, edited or deleted.
- **EXCLUDED / PAUSE_AND_THINK rules**: freely editable and removable.
