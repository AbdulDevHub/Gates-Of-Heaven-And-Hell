# Gates Of Heaven & Hell

A Manifest V3 Chrome extension version of the original Tampermonkey blocker —
rebuilt on `declarativeNetRequest` instead of polling/click-interception, with
a no-bypass blocked page, and lockable/friction-gated rule removal.

## Install (unpacked, for now)

1. Put your real rules into `bookOfLinks.jsonc` at the root of this folder —
   same `["domain", "substring"]` array format you already use. It's only
   read **once**, on first install, to seed the extension.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder
   (`Gates Of Heaven & Hell`).
5. Click the extension's toolbar icon any time to open the **Rule Book**
   (options page) and manage rules from then on.

## Structure

```
Gates Of Heaven & Hell/
├── manifest.json          MV3 manifest
├── background.js          Seeds storage, compiles DNR rules, reconciles alarms
├── rules-engine.js         Shared matching + regex-compiler logic (no chrome.* calls)
├── content-youtube.js      Only remaining content script — YouTube search-form catch
├── blocked.html/.css/.js   The no-bypass blocked page (closing-gate animation)
├── options.html/.css/.js   The Rule Book UI (add/remove/lock, export/import)
├── bookOfLinks.jsonc       First-install seed file (your rules, same format as before)
├── icons/                  Toolbar + extension icons
├── .gitignore
└── .vscode/settings.json
```

Everything after install lives in `chrome.storage.local` — the `.jsonc` file
is not read again unless you use **Import** on the options page.

## How it works, in short

- **Blocking**: `declarativeNetRequest` matches your BLOCKED rules (compiled
  to regex under the hood — you never touch regex) and redirects the
  top-level page to `blocked.html` before it ever loads. EXCLUDED rules are
  compiled as higher-priority `allow` rules, so they always win, unconditionally.
- **Blocked page**: shows a message, no "proceed anyway" — one button,
  **Close Tab**, which shows a brief toast and closes the tab.
- **Removing a BLOCKED rule**: type a reason → 30-minute cooling-off → type a
  reason again → removed. **Locked** rules can't be removed at all until
  their lock expires (Mon–Thu lock → unlocks Friday 6 PM, stays locked
  through the weekend; Fri/Sat/Sun lock → flat 24 hours).
- **EXCLUDED rules**: freely, instantly editable — no friction, since they
  only ever tighten blocking, never loosen it.
- **YouTube search**: a content script still catches the search form before
  submit, so a blocked query jumps straight to the blocked page instead of
  flashing the results page first. Everything else from the original script
  (click interception, 50ms polling, history patching) was dropped as
  redundant now that DNR blocks at the network layer regardless of trigger.

## Testing checklist

Work through these after loading the extension:

1. **Basic block** — visit a domain in your BLOCKED list. Confirm it redirects
   to the gate page (doors animate closed, message appears) instead of the
   real page ever rendering.
2. **Substring rule** — if you have a `["domain", "substring"]` rule, confirm
   the bare domain (without the substring) loads normally, and the
   domain+substring combination is blocked.
3. **Exclusion overrides block** — add a BLOCKED rule and an EXCLUDED rule
   that both match the same URL; confirm the page loads (exclusion wins).
4. **Close Tab flow** — on the blocked page, click **Close Tab**, confirm the
   toast appears and the tab actually closes itself shortly after.
5. **No bypass exists** — confirm there is no way off the blocked page other
   than closing the tab or navigating elsewhere manually (address bar, other
   tab) — no hidden "proceed" link.
6. **YouTube search interception** — search a blocked term on YouTube;
   confirm it jumps to the blocked page without flashing `/results` first.
7. **Add rule (instant)** — add a new BLOCKED and a new EXCLUDED rule from
   the options page; confirm both take effect immediately (no reload needed).
8. **Remove flow — reflection + 30 min** — start removing an unlocked
   BLOCKED rule: confirm it requires typed text to start, then shows a live
   countdown, and does **not** let you finish early. Wait it out (or
   temporarily test with a shorter duration if you want a faster check) and
   confirm it requires typed text again before actually removing.
9. **Cancel removal** — start a removal, click Cancel, confirm the rule
   returns to normal (no countdown, no dangling alarm — check
   `chrome://extensions` → service worker inspector → Application → Storage
   if you want to verify).
10. **Lock a rule** — lock a BLOCKED rule and confirm there is **no** way to
    remove it (no Remove button at all) until the lock expires. Test both
    lock windows if you can (lock on a weekday vs. lock on Fri/Sat/Sun).
11. **EXCLUDED freely editable** — confirm EXCLUDED rules remove instantly,
    no prompt, no delay.
12. **Persistence across restart** — reload `chrome://extensions` (or restart
    Chrome) mid-countdown or mid-lock; confirm the countdown/lock state
    survives (this is what `chrome.alarms` is for — worth specifically
    checking since it's the part most likely to silently break).
13. **Export/Import** — export your rules, check the downloaded file opens
    and looks right, then import it back and confirm rules match (note:
    import wipes any active locks/pending removals by design, since it's a
    full replace).
