# UI Tokens — Gates Of Heaven & Hell

> The visual identity shared by the Rule Book, popup and gate pages. Tokens are defined per
> page in `:root` of each stylesheet (no shared stylesheet). Reuse these when adding UI;
> update this file if a token is added or changed.

## Look
- **Rule Book & popup**: dark night background, parchment text, gold accents, ember for warnings. Solemn and calm.
- **Hell gate** (`blocked.css`): a wall of flames (canvas) under an iron portcullis that slams down and shimmers in the heat, rising embers with periodic flares, flame-gradient message. Menacing.
- **Crossroads** (`pause.css`): cool night sky split by two lights (warm white-gold behind Heaven, cold steel behind the iron gate). The whole Heaven card is the Turn Back button; the iron gate has a steel countdown ring and grinds open over 5 s when you go through.
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
| Crossroads: `--night` `--night-2` `--steel` `--steel-dim` | `#04060c` `#0a1020` `#7d8fa8` `#2b3546` | pause page sky, iron-side light, countdown ring |
| Journey ramp (one hue) | `#1a222b` `#3b3318` `#5f4f1b` `#8a6f1e` `#c9a227` | calendar + hour heatmap, zero → most |

## Typography (Google Fonts via `@import` at the top of each CSS file)
- Headings & big numbers: `'Space Grotesk', 'Inter', system-ui, sans-serif` (use `tabular-nums` for figures). No serif anywhere.
- Body/UI: `'Inter', system-ui, sans-serif`
- Domains/code: `'IBM Plex Mono', monospace`
