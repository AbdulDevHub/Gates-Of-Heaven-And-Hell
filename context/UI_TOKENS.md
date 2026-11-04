# UI Tokens — Gates Of Heaven & Hell

> The visual identity shared by the Rule Book, blocked page and Pause & Think gate.
> Tokens are defined per page in `:root` of `styles/options.css`, `styles/blocked.css` and
> `styles/pause.css` (no shared stylesheet). Reuse these when adding UI; update this file
> if a token is added or changed.

## Look
Dark night background, parchment text, gold accents, ember for warnings. Solemn and calm, no bright UI chrome.

## Colours
| Token | Value | Use |
|---|---|---|
| `--ink` / `--ink-2` / `--ink-3` | `#0b0f14` / `#12181f` / `#1a222b` | backgrounds, raised surfaces (2/3 in options only) |
| `--line` | `#263140` | borders (options) |
| `--parchment` | `#ede6d6` | main text |
| `--gold` / `--gold-bright` | `#c9a227` / `#e8c158` | accents, headings, primary actions |
| `--gold-dim` | `#7a631c` | muted gold (pause) |
| `--ember` / `--ember-bright` | `#8b2e2e` / `#c25050` | danger, locks, warnings |
| `--mist` | `#8894a3` (options), `#6b7787` (blocked, pause) | secondary text |
| `--mist-dim` / `--mist-light` | `#5c6774` / `#9ba8b8` | tertiary text (options / pause) |

## Typography (Google Fonts via `@import` at the top of each CSS file)
- Headings: `'Cormorant Garamond', Georgia, serif`
- Body/UI: `'Inter', system-ui, sans-serif`
- Domains/code (options): `'IBM Plex Mono', monospace`
