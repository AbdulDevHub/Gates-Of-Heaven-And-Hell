# Progress Tracker — Gates Of Heaven & Hell

> Running record of where the project stands, so a new session can pick up where the last
> left off. Update "Current state", "In progress" and "Next steps" after meaningful work, and
> add a dated entry (newest first) to the session log. Collapse stale log entries into
> "Earlier history" rather than deleting them.

## Current state
v2.1.0, loaded unpacked (not on the Chrome Web Store). All features below working and covered by unit tests plus a Playwright run with the extension loaded.
- **Blocking**: DNR dynamic rules; EXCLUDED (4) > open passes (3) > PAUSE_AND_THINK (2) > BLOCKED (1). Precise host/parent-domain matching, `*` wildcard site, schedules.
- **Hell gate**: portcullis with heat shimmer, flame wall + embers + flares, custom message or reminder, per-rule last paused/streak, single Turn Back → Heaven transition. Links opened in a new tab to a Blocked site close instantly (counted as held).
- **Crossroads (Pause & Think)**: night sky with split light, whole Heaven card = Turn Back, visible-time wait, phrase = rule note or `Yes I Am Sure` (no paste), 5 s gate opening before the pass, no visible countdown, passes (while on site / fixed / end of day), per-rule overrides, per-rule last went through/streak, closing the tab = walk-away, End pass re-gates tabs.
- **Rule Book**: Rules (filter, quick add, lint fixes, schedules, lock, pause with chosen length, sentence-style per-rule timings, per-rule Blocked cooldown), Journey (8 tiles, 30-day chart, year calendar, hour heatmap, funnel, pass time, sortable per-rule table; today's slips hidden; clear last hour / today / all time), Settings bento (defaults, cooldown, reminders, import/export, URL tester, per-site timings). JSONC import/export keeps old format, locked rules and (by site + text) rule ids/stats.
- **Popup**: verdict + reason, quick add with editable site + optional URL text and preview, open passes (no stats).
- **Sounds**: synthesized Web Audio SFX on both gates and the Heaven transition; toggle in Settings.
- **Stats**: per rule (streak, best, last slip, views, held, slips, pass minutes), 365 days, weekday × hour views. Fonts: Space Grotesk + Inter (no serif).
- **Other**: split incognito; YouTube search interceptor; SPA navigation gating; Google search rules match the query text only.

## In progress
- Nothing active.

## Next steps
- [ ] Upload `docs/social-preview.png` as the repo's social preview (GitHub Settings → General; no API).
- [ ] Chrome Web Store listing (privacy policy page, store screenshots from `docs/screenshots/`).
- [ ] Optional `chrome.storage.sync` for non-locked rules (locks stay local).
- [ ] Keyboard shortcut / context menu "Gate this site".

## Session log

### 2026-11-08 (v2.1 polish)
- Journey: tiles and charts share one gap; clear-stats buttons (last hour / today / all time, click twice) fill the header's empty right side. Undo log `stats.log` + `SH.clearStats` + `CLEAR_STATS`.
- Gate SFX (`scripts/sfx.js`, Web Audio, Settings toggle). Removed the visible countdown from the crossroads (ring + opening). Removed popup stat cards. README features and social preview (Space Grotesk, no serif) refreshed.

### 2026-11-08 (v2.1)
- Feedback pass (14 items, settled in a grill-me Q&A): per-rule streaks and "last went through" on gates, auto-close of link-opened tabs to Blocked sites, closing a gate tab yourself counts as a walk-away (`openGates`), the note replaces `Yes I Am Sure`, 5 s go-through animation, more fire on the Hell gate, night-sky crossroads with the whole Heaven card as the button, Space Grotesk instead of Cormorant, bento Settings (import/export + tester moved in), per-site timings + per-rule Blocked cooldown, popup site/substring fields, big-data Journey, today's slips hidden.
- Review fixes: popup exception with extra text hidden on hosts that have gate rules (it could exempt other gated URLs), serialized `usedTabs` writes, import keeps ids of existing rules so streaks survive, `gate-unlocked` counted once per tab.
- Verified with 21 unit tests and a Playwright run with the extension loaded (auto-close, walk-away on close, note phrase, pass only after the opening, popup substring add).

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
