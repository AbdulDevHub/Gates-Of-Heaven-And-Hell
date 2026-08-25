# Progress Tracker — Gates Of Heaven & Hell

## Project Status: Active / Production Ready

---

## Completed Features & Milestones

- [x] **MV3 DeclarativeNetRequest Engine**:
  - Zero-bypass blocking via native `chrome.declarativeNetRequest` dynamic rules.
  - Priority 2 `allow` rules for `EXCLUDED` list.
  - Priority 1 `redirect` rules for `BLOCKED` list redirecting to `pages/blocked.html`.
- [x] **No-Bypass Blocked Screen (`pages/blocked.html`)**:
  - Islamic reminder quotes with dynamic affirmation toast upon closing.
  - Gate closing animation with dark aesthetics.
  - Single button ("Close Tab") closing the current tab via `chrome.tabs.remove`.
  - Custom rule messages displayed when defined.
- [x] **Incognito Split Mode**:
  - Configured with `"incognito": "split"` in `manifest.json` ensuring seamless blocked pages and options pages in incognito.
- [x] **Rule Book UI (`pages/options.html`)**:
  - Domain grouping for multi-rule domains.
  - Inline editing for blocked and excluded rules.
  - Hard lock feature (Mon–Thu locks unlock Friday 18:00; Fri–Sun locks unlock 24h).
  - JSONC Import & Export functionality.
- [x] **Pause vs. Delete Architecture Refactor**:
  - Replaced removal cooldown with a **Pause** flow: 2-step reflection modal + 30-minute cooling-off countdown.
  - Made **Delete** button instantly delete without delay.
  - Added `⏸️ Paused` state and instant **Resume** button.
  - Dynamic DNR re-compilation and YouTube content script bypass filtering for paused rules.
- [x] **Agent Documentation**:
  - Added `.agents/AGENTS.md`, `.agents/PROGRESS_TRACKER.md`, and `.agents/ARCHITECTURE.md`.

---

## Roadmap & Potential Enhancements

- [ ] **Optional Custom Pause Durations**:
  - Allow user to specify how long a rule stays paused (e.g. 15m, 1h, until end of day) before automatically resuming.
- [ ] **Statistics / Dhikr Counter**:
  - Track tabs closed and time saved anonymously in local storage.
- [ ] **Sync Storage (Optional)**:
  - Option to sync non-locked rules via `chrome.storage.sync` while keeping locks local.
