# AGENTS.md — Gates Of Heaven & Hell

> Instructions for AI coding agents working in this repo: terse, project-specific facts only.
> **Maintenance:** after any meaningful change, update this file, `context/PROGRESS_TRACKER.md`,
> and the "Project Overview" section of `README.md` to reflect the current state — do this
> proactively, without being asked.

## Overview
Manifest V3 Chrome extension that blocks sites with `declarativeNetRequest` (no bypass), plus a soft "Pause & Think" gate, friction-gated rule pausing and hard locks.

## Tech stack
- Vanilla JS / HTML / CSS, no build step, no dependencies, no frameworks (no Tailwind).
- Chrome APIs: `declarativeNetRequest` (dynamic rules), `storage.local`, `alarms`, `tabs`.

## Run & verify
- Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → repo root. Reload the extension after edits.
- Seed rules: `bookOfLinks.jsonc` (gitignored, personal) is read once on first install; afterwards use Import in the Rule Book.
- Verify: `for f in scripts/*.js; do node --check "$f"; done` (syntax only; behaviour must be checked in Chrome).

## Conventions & constraints
- `scripts/background.js` is an ephemeral MV3 service worker: no in-memory state, persist in `chrome.storage.local`, timers via `chrome.alarms` only (prefixes `lock:`, `pauseCountdown:`, `pauseSessionHeartbeat`).
- DNR rebuilds go through the single serialized promise chain in `background.js`; don't call `updateDynamicRules` elsewhere.
- DNR priorities: EXCLUDED 4 (allow) > active pause sessions 3 (allow) > PAUSE_AND_THINK 2 (redirect `pause.html`) > BLOCKED 1 (redirect `blocked.html`). Paused BLOCKED rules are skipped.
- `scripts/rules-engine.js` stays pure (no `chrome.*`) — it's shared by the worker, content script and pages. Regexes must be RE2-compatible (no lookarounds/backreferences).
- Google search rules (`google.*/search`) match the substring against the `q=` text only.
- Keep stored schemas backwards-compatible (see `context/ARCHITECTURE.md`); re-test JSONC import/export when changing rule shapes.
- New pages/scripts loaded from a redirect must be listed in `web_accessible_resources`.
- Pause gate phrase is exact and case-sensitive: `Yes I Am Sure`.

## Boundaries
- Never commit `bookOfLinks.jsonc` or `bookOfLinks.export*.jsonc` (personal rule lists).
- Don't weaken the no-bypass design (no "proceed anyway", locked rules stay uneditable) unless asked.

## More context
- `README.md` — plain-language overview, install, behaviour summary.
- `context/PROGRESS_TRACKER.md` — current state, next steps, session log.
- `context/ARCHITECTURE.md` — components, data flow, storage schema, workflows.
- `context/UI_TOKENS.md` — colours, fonts and visual identity.
