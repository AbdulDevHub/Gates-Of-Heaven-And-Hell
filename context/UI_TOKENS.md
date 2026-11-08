# UI Tokens — Gates Of Heaven & Hell

> The visual identity shared by the Rule Book, popup and gate pages. Tokens are defined per
> page in `:root` of each stylesheet (no shared stylesheet). Reuse these when adding UI;
> update this file if a token is added or changed.

## Look
- **Rule Book & popup**: dark night background, parchment text, gold accents, ember for warnings. Solemn and calm.
- **Hell gate** (`blocked.css`): fire-lit pit, iron portcullis that slams down, rising embers, flame-gradient message. Menacing.
- **Crossroads** (`pause.css`): twilight sky, a glowing Heaven gate (turn back) beside a dim iron gate with a gold countdown ring.
- **Heaven transition** (`heaven.css`): white-gold light, rays, pearl gates swinging open, dark-gold text.
- Every page honours `prefers-reduced-motion`.

## Colours
| Token | Value | Use |
|---|---|---|
| `--ink` / `--ink-2` / `--ink-3` | `#0b0f14` / `#12181f` / `#1a222b` | backgrounds, raised surfaces (options, popup) |
| `--line` | `#263140` | borders |
| `--parchment` | `#ede6d6` | main text |
| `--gold` / `--gold-bright` | `#c9a227` / `#e8c158` | accents, headings, primary actions |
| `--gold-data` | `#ad8a1f` | "gates held" chart series (validated on `--ink-2`) |
| `--ember` / `--ember-bright` | `#8b2e2e` / `#c25050` | danger, locks, slips |
| `--heaven` / `--halo` | `#f3e3a6` | exceptions, passes, Heaven gate |
| `--mist` / `--mist-dim` | `#8894a3` / `#5c6774` | secondary / tertiary text |
| Hell: `--pit` `--blood` `--flame` `--flame-hot` `--iron` | `#070203` `#5a1208` `#ff7a2f` `#ffb35c` `#1b1717` | blocked page |
| Crossroads: `--night` `--dusk` `--violet` `--horizon` | `#070a12` `#141a2c` `#2a2340` `#6b4a2a` | pause page sky |

## Typography (Google Fonts via `@import` at the top of each CSS file)
- Headings & big numbers: `'Cormorant Garamond', Georgia, serif` (use `lining-nums` for figures)
- Body/UI: `'Inter', system-ui, sans-serif`
- Domains/code: `'IBM Plex Mono', monospace`
