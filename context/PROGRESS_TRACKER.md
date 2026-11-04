# Progress Tracker — Gates Of Heaven & Hell

> Running record of where the project stands, so a new session can pick up where the last
> left off. Update "Current state", "In progress" and "Next steps" after meaningful work, and
> add a dated entry (newest first) to the session log. Collapse stale log entries into
> "Earlier history" rather than deleting them.

## Current state
All features below working (v1.0.0, loaded unpacked; not on the Chrome Web Store).
- **Blocking**: DNR dynamic rules; priority layers EXCLUDED (4) > pause sessions (3) > PAUSE_AND_THINK (2) > BLOCKED (1).
- **Blocked page**: gate animation, custom rule message or Islamic reminder, single Close Tab button with affirmation toast.
- **Rule Book**: grouped domains, inline edit, hard locks (Mon–Thu → Fri 18:00; Fri–Sun → 24 h), JSONC import/export.
- **Pause a BLOCKED rule**: reason → 30-min cooldown → final reflection → paused; instant Resume. Delete is instant.
- **Pause & Think gate**: 15-s reflection, exact `Yes I Am Sure` phrase, session lives while a matching tab is active and expires after 5 min without one (1-min heartbeat).
- **Other**: split incognito; YouTube search interceptor; Google search rules match the query text only.

## In progress
- Nothing active.

## Next steps
- [ ] Custom pause durations (15 m, 1 h, until end of day) with auto-resume.
- [ ] Statistics / dhikr counter: tabs closed and time saved, stored locally.
- [ ] Optional `chrome.storage.sync` for non-locked rules (locks stay local).

## Session log

### 2026-11-04
- Moved agent docs out of `.agents/`: `AGENTS.md` now at root (trimmed), `ARCHITECTURE.md` and this tracker in `context/`, added `context/UI_TOKENS.md`. Storage schema and workflows moved into `ARCHITECTURE.md`.
- Pause sessions now tracked with `lastActiveAt` + 1-minute heartbeat instead of per-session expiry alarms; DNR rebuilds serialized through one promise chain; confirmation phrase made case-sensitive.
- Google search rules now match the substring against the `q=` text only (Google AI mode adds long tracking params that caused false matches).

### Earlier history
Initial MV3 rebuild of the original Tampermonkey blocker on `declarativeNetRequest`, then icons, inline editing and domain grouping, folder restructure with split incognito and custom blocked messages, the Pause-vs-Delete refactor (reflection + 30-min cooldown replaced the old removal cooldown), and the Pause & Think soft-gate tier.
