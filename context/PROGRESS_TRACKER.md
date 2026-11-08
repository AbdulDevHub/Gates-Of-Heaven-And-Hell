# Progress Tracker — Gates Of Heaven & Hell

> Running record of where the project stands, so a new session can pick up where the last
> left off. Update "Current state", "In progress" and "Next steps" after meaningful work, and
> add a dated entry (newest first) to the session log. Collapse stale log entries into
> "Earlier history" rather than deleting them.

## Current state
v2.0.0, loaded unpacked (not on the Chrome Web Store). All features below working and covered by unit tests plus a Playwright run with the extension loaded.
- **Blocking**: DNR dynamic rules; EXCLUDED (4) > open passes (3) > PAUSE_AND_THINK (2) > BLOCKED (1). Precise host/parent-domain matching, `*` wildcard site, schedules.
- **Hell gate**: portcullis + embers, custom message or reminder, single Turn Back → Heaven transition.
- **Crossroads (Pause & Think)**: visible-time wait, exact `Yes I Am Sure`, passes (while on site / fixed / end of day), per-rule overrides, note shown, End pass re-gates tabs.
- **Rule Book**: Rules (tester, filter, quick add, lint fixes, schedules, lock, pause with chosen length), Journey (tiles + 30-day chart), Settings (reminders, timers, staged cooldown). JSONC import/export keeps old format and locked rules.
- **Popup**: verdict + reason, quick add, open passes, today's stats.
- **Other**: split incognito; YouTube search interceptor; SPA navigation gating; Google search rules match the query text only.

## In progress
- Nothing active.

## Next steps
- [ ] Upload `docs/social-preview.png` as the repo's social preview (GitHub Settings → General; no API).
- [ ] Chrome Web Store listing (privacy policy page, store screenshots from `docs/screenshots/`).
- [ ] Optional `chrome.storage.sync` for non-locked rules (locks stay local).
- [ ] Keyboard shortcut / context menu "Gate this site".

## Session log

### 2026-11-08
- Diagnosed filmverse-azure.vercel.app not pausing: its rule had "Limited Access" in the substring slot, so only URLs containing that text matched. Added notes, a URL tester and lint with a "Move to note" fix.
- v2.0: precise domain matching (fixes `x.com` matching `dropbox.com`), gate URLs keep `&` intact, schedules, timed passes, customizable wait / pass / cooldown / pause length, auto-resume, re-gating open tabs, SPA navigation gating, stats & streaks, Journey tab, Settings tab, toolbar popup, quick substring add, Heaven/Hell gate redesign, universal vs faith reminder packs, import can't clear locks.
- Serialized all pass writes (`mutateSessions`) after an e2e run showed a tab event could resurrect an ended pass.
- Review fixes: passes only for live Pause & Think rules (a hand-opened `pause.html` could bypass a Blocked rule since v1), http(s)-only continue target, `withStore` chain plus merge-on-save in the Rule Book, passes ended on import/rule edit, schedule-alarm self-check, failure badge, `*`-without-word lint, more `shared.js` tests.
- GitHub SEO: README rewrite, MIT license, screenshots, social preview image, repo description and topics.

### 2026-11-04
- Moved agent docs out of `.agents/`: `AGENTS.md` at root, `ARCHITECTURE.md` and this tracker in `context/`, added `context/UI_TOKENS.md`.
- Pause sessions tracked with `lastActiveAt` + 1-minute heartbeat; DNR rebuilds serialized; confirmation phrase case-sensitive.
- Google search rules match the substring against the `q=` text only.

### Earlier history
Initial MV3 rebuild of the original Tampermonkey blocker on `declarativeNetRequest`, then icons, inline editing and domain grouping, folder restructure with split incognito and custom blocked messages, the Pause-vs-Delete refactor (reflection + 30-min cooldown), and the Pause & Think soft-gate tier.
