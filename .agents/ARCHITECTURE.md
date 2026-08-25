# Architecture — Gates Of Heaven & Hell

## High-Level System Design

Gates Of Heaven & Hell is an un-bypassable site blocker Chrome Extension architected around Chrome Manifest V3 APIs.

```
                  ┌───────────────────────────────┐
                  │      bookOfLinks.jsonc        │
                  │   (first-install seed only)   │
                  └───────────────┬───────────────┘
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │   chrome.storage.local    │
                    │   - blocked: Rule[]       │
                    │   - excluded: Rule[]      │
                    └─────────────┬─────────────┘
                                  │ (onChanged)
                 ┌────────────────┼────────────────┐
                 ▼                                 ▼
   ┌───────────────────────────┐     ┌───────────────────────────┐
   │    background.js (SW)     │     │      options.js (UI)      │
   │  - Rebuilds DNR rules     │     │  - Add / Edit / Delete    │
   │  - Skips paused rules     │     │  - Pause with cooldown    │
   │  - Alarms (lock & pause)  │     │  - Lock rules until Fri   │
   └─────────────┬─────────────┘     └───────────────────────────┘
                 │
                 ▼
   ┌───────────────────────────┐
   │  declarativeNetRequest    │
   │  Priority 2: Allow (Excl) │
   │  Priority 1: Redirect     │
   └─────────────┬─────────────┘
                 │ (Network match)
                 ▼
   ┌───────────────────────────┐
   │     pages/blocked.html    │
   │  - Displays reminder      │
   │  - Custom rule message    │
   │  - "Close Tab" button     │
   └───────────────────────────┘
```

---

## Component Breakdown

### 1. Service Worker (`scripts/background.js`)
- **Lifecycle**: Starts and stops as needed by Chrome MV3.
- **Rule Compilation (`rebuildDnrRules`)**:
  - Compiles `excluded` rules as Priority 2 `allow` rules.
  - Compiles non-paused `blocked` rules as Priority 1 `redirect` rules targeting `pages/blocked.html?ruleId=...&url=...`.
  - Clears old dynamic rules and applies new dynamic rules atomically using `chrome.declarativeNetRequest.updateDynamicRules`.
- **Alarms Reconciliation (`reconcileAllAlarms`)**:
  - Recreates `chrome.alarms` for active locks (`lock:<id>`) and pending pauses (`pauseCountdown:<id>`) when the worker wakes up.

### 2. Pure Rules Engine (`scripts/rules-engine.js`)
- Shared between worker, content scripts, and pages.
- Converts domain + substring into regex filters compatible with RE2 and DNR regex syntax:
  - Pattern: `(?i)^(https?://.*<domain>.*<substring>.*)`

### 3. YouTube Form Interceptor (`scripts/content-youtube.js`)
- Injected at `document_start` on `*://*.youtube.com/*`.
- Intercepts form submissions for `/results?search_query=...`.
- If the search target matches an active (non-paused) blocked rule, cancels navigation and immediately redirects to `blocked.html`.

### 4. Rule Book Page (`pages/options.html`, `scripts/options.js`, `styles/options.css`)
- Direct access to `chrome.storage.local` and `chrome.alarms`.
- Renders grouped domain lists, inline edit forms, reflection modals, and countdown tickers.

### 5. Blocked Page (`pages/blocked.html`, `scripts/blocked.js`, `styles/blocked.css`)
- Closed gate visual styling.
- Reads `ruleId` and `url` query params to show custom rule messages or falls back to Islamic reminders.
- Closes the active tab with `chrome.tabs.remove`.
