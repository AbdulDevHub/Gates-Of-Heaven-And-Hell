# AGENTS.md — Gates Of Heaven & Hell

> Instructions for AI coding agents working in this repo: terse, project-specific facts only.
> **Maintenance:** after any meaningful change, update this file, `context/PROGRESS_TRACKER.md`,
> and the "Project Overview" section of `README.md` to reflect the current state — do this
> proactively, without being asked.

## Overview
Manifest V3 Chrome extension (v2.0.0) that blocks sites with `declarativeNetRequest` behind a no-bypass Hell gate, plus a soft Pause & Think crossroads with timed passes, schedules, friction-gated pausing, hard locks, a toolbar popup and local stats/streaks.

## Tech stack
- Vanilla JS / HTML / CSS, no build step, no dependencies, no frameworks (no Tailwind).
- Chrome APIs: `declarativeNetRequest` (dynamic rules), `storage.local`, `alarms`, `tabs`, `webNavigation`.

## Run & verify
- Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → repo root. Reload the extension after edits.
- Seed rules: `bookOfLinks.jsonc` (gitignored, personal) is read once on first install; afterwards use Import in the Rule Book.
- Verify: `for f in scripts/*.js; do node --check "$f"; done && node --test tests/*.test.js`
- Browser behaviour can be driven with Playwright's bundled Chromium and `--load-extension` (branded Chrome ignores that flag).

## Conventions & constraints
- `scripts/background.js` is an ephemeral MV3 service worker: no in-memory state, persist in `chrome.storage.local`, timers via `chrome.alarms` only (`lock:<id>`, `pauseCountdown:<id>`, `pauseResume:<id>`, `schedule:next`, `cooldownSettle`, `pauseSessionHeartbeat`).
- DNR rebuilds go through the single serialized `rebuildDnrRules()` chain; don't call `updateDynamicRules` elsewhere. `pauseSessions` writes in the worker go through `mutateSessions()`, rule-list/settings writes through `withStore()`, stats through `recordStat()`. The Rule Book's `save()` merges only its own changes onto fresh storage.
- DNR priorities: EXCLUDED 4 (allow) > open passes 3 (allow) > PAUSE_AND_THINK 2 (redirect `pause.html`) > BLOCKED 1 (redirect `blocked.html`). Paused and off-schedule rules are left out.
- `scripts/rules-engine.js` and `scripts/shared.js` stay pure (no `chrome.*`): they're shared by the worker, content script, pages and Node tests. Regexes must be RE2-compatible (no lookarounds/backreferences).
- Domain matching is exact host or parent domain plus optional path prefix (`x.com` ≠ `dropbox.com`); `*` = any site. Keep `ruleMatches` and `buildRegexFilter` in agreement (the tests check both).
- Google search rules (`google.*/search`) match the substring against the `q=` text only.
- Gate URLs carry the original URL as the LAST param; read it with `RulesEngine.readTargetUrl`, never `URLSearchParams` (it truncates at `&`).
- Keep stored schemas backwards-compatible (see `context/ARCHITECTURE.md`); re-test JSONC import/export when changing rule shapes.
- New pages/scripts loaded from a redirect must be listed in `web_accessible_resources`.
- Pause gate phrase is exact and case-sensitive: `Yes I Am Sure`.

## Boundaries
- Never commit `bookOfLinks.jsonc` or `bookOfLinks.export*.jsonc` (personal rule lists).
- Don't weaken the no-bypass design unless asked: no "proceed anyway", locked rules stay uneditable and survive import, shorter cooldowns stay staged, passes are only granted for a live Pause & Think rule, and the popup offers no one-click exception for a page that's currently gated.

## More context
- `README.md` — overview, features, install, rule format, FAQ.
- `context/PROGRESS_TRACKER.md` — current state, next steps, session log.
- `context/ARCHITECTURE.md` — components, data flow, storage schema, workflows.
- `context/UI_TOKENS.md` — colours, fonts and visual identity.
