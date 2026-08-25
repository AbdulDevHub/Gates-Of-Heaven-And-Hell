# AGENTS.md — Gates Of Heaven & Hell

## Repository Overview
**Gates Of Heaven & Hell** is a privacy-focused, zero-bypass website blocking Chrome Extension built on Manifest V3. It intercepts distractors and time-wasters using Chrome's native `declarativeNetRequest` (DNR) API, presents an un-bypassable reminder screen, and enforces friction-gated pausing and hard lock schedules.

---

## Architectural Principles & Constraints

1. **Manifest V3 Service Worker Lifecycle**:
   - `scripts/background.js` runs as an ephemeral MV3 service worker. It can terminate at any moment.
   - Do NOT store in-memory state across requests.
   - All persistence belongs in `chrome.storage.local`.
   - Long-running timers MUST use `chrome.alarms` with persistent prefixes (`lock:`, `pauseCountdown:`), never `setTimeout` or `setInterval` in the background worker.

2. **Zero Bypass via declarativeNetRequest**:
   - Blocking happens before network packets leave the browser (`declarativeNetRequest` dynamic rules).
   - `EXCLUDED` rules are compiled at Priority 4 (`allow`) and unconditionally override all rules.
   - Active `pauseSessions` are compiled at Priority 3 (`allow`) when temporary access is granted.
   - `PAUSE_AND_THINK` rules are compiled at Priority 2 (`redirect` to `pages/pause.html`), overriding `BLOCKED` rules.
   - `BLOCKED` rules are compiled at Priority 1 (`redirect` to `pages/blocked.html`).
   - `paused` blocked rules (`rule.paused === true`) are skipped during DNR compilation so they do not block traffic while paused.

3. **Incognito Window Isolation**:
   - Configured with `"incognito": "split"` in `manifest.json`.
   - In split incognito mode, the extension creates an isolated instance in incognito windows. `pages/blocked.html`, `pages/pause.html`, and the Rule Book run without Chrome client security policy blocks.

4. **Pure & Modular Rules Engine**:
   - `scripts/rules-engine.js` is pure JavaScript with zero dependencies and no `chrome.*` API dependencies.
   - It is shared across `background.js` (service worker), `content-youtube.js` (content script), `blocked.js`, and `pause.js`.
   - Any matching regex compiled for DNR must use RE2-compatible syntax (no backreferences, no lookaheads/lookbehinds).

5. **Aesthetics & Technology Stack**:
   - Vanilla HTML5, Vanilla JavaScript, and Vanilla CSS (no heavy frontend frameworks, no Tailwind).
   - Visual identity: Dark parchment, gold accents (`--gold: #c9a227`), ember warnings (`--ember: #8b2e2e`), Cormorant Garamond serif headers, and Inter body typography.

---

## Storage Schema (`chrome.storage.local`)

### `blocked` (Array of Rule Objects)
```typescript
interface BlockedRule {
  id: string; // crypto.randomUUID()
  domain: string; // e.g. "youtube.com"
  substring?: string; // e.g. "shorts"
  message?: string; // Optional custom message for blocked.html
  locked: boolean; // Hard-lock active flag
  lockedUntil: number | null; // Timestamp (ms) when lock expires
  paused?: boolean; // True when rule is temporarily paused
  pendingPause?: {
    stage: 'countdown' | 'ready';
    reason1: string;
    startedAt: number;
    readyAt: number; // startedAt + 30 minutes
  } | null;
}
```

### `pauseAndThink` (Array of Rule Objects)
```typescript
interface PauseAndThinkRule {
  id: string; // crypto.randomUUID()
  domain: string; // e.g. "reddit.com"
  substring?: string; // e.g. "r/all"
}
```

### `pauseSessions` (Array of Active Session Objects)
```typescript
interface PauseSession {
  ruleId: string;
  domain: string;
  substring: string;
  activatedAt: number;
}
```

### `excluded` (Array of Rule Objects)
```typescript
interface ExcludedRule {
  id: string; // crypto.randomUUID()
  domain: string; // e.g. "youtube.com"
  substring?: string; // e.g. "/watch"
}
```

---

## Core Workflows

### 1. Pausing a Blocked Rule
- User clicks **Pause** in `options.html`.
- Step 1 Reflection: User inputs why they are pausing (`reason1`).
- A 30-minute cooldown begins (`pauseCountdown:<id>` alarm set).
- Once cooldown finishes, status turns `ready`.
- Step 2 Reflection: User confirms with final check.
- Rule becomes `paused: true`, removed from DNR active rules, and displays `⏸️ Paused` badge.
- Clicking **Resume** instantly re-enables blocking with zero friction.

### 2. Deleting a Blocked Rule
- User clicks **Delete** in `options.html`.
- Rule is immediately removed from `chrome.storage.local` and any active alarms are cleared.

### 3. Hard Locking
- User clicks **Lock** in `options.html`.
- Mon–Thu locks expire Friday 18:00 (lock stays active through the whole weekend).
- Fri/Sat/Sun locks expire 24 hours from lock creation.
- While locked, all controls are hidden and the rule cannot be paused, edited, or deleted.

---

## Guidelines for Future Agents
- Keep modifications minimal, clear, and backwards-compatible with stored `chrome.storage.local` schemas.
- When adding UI elements to the Rule Book or Blocked page, adhere strictly to the established CSS token system in `styles/options.css` and `styles/blocked.css`.
- Always test or verify JSONC import/export handling when altering rule data models.
