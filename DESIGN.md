# agentdash visual design

The visual design of the read-only web UI, settled in #16 on top of the layout from #9 (variant A). This file is the spec for the browser implementation; the prototype and the canvas show it.

- **Prototype:** `prototype-visual-design/index.html` on branch `prototype/visual-design` (supersedes `prototype/browser-layout`). Open it in a browser; `?theme=light|dark`, `?empty=1` and `?view=states` show the other states.
- **Canvas:** the Claude Design canvas linked in #16 (light and dark artboards, Widget states, foundations).

Terms follow `CONTEXT.md`.

## Principles

- **Soft and calm.** Rounded white cards on a cool grey-lavender ground, generous space, no borders. A personal dashboard read by one Owner, not an ops console.
- **Agents never style.** Agents pick Widget types and config from the catalog (#5). Every colour, icon tint and size comes from this file, so any Agent's page looks the same.
- **Quiet updates.** Live changes re-render in place without flashing or highlighting (#9).
- **Colour is never the only cue.** Changes carry an arrow, overdue items carry text, states carry a label.

## Colour

Light and dark use the same token names. Dark follows `prefers-color-scheme`; there is no in-app toggle in v1.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#EEF0F5` | `#0D0F14` | Page ground |
| `panel` | `#FFFFFF` | `#171A21` | Widgets, sidebar, breadcrumb pills |
| `soft` | `#F3F4F8` | `#1F232C` | Chips, table header, round buttons, "No data yet" box |
| `track` | `#EEF0F4` | `#262B35` | Progress track |
| `line` | `#E8EAF0` | `#262B35` | Gridlines, table rows, dashed outlines |
| `ink` | `#12141A` | `#EEF0F5` | Text, values |
| `ink-2` | `#4B5260` | `#B9BFCC` | Secondary text, KPI labels |
| `ink-3` | `#5F6672` | `#9097A5` | Timestamps, axis labels, meta |
| `accent` | `#4361EE` | `#7B93FF` | Links, current nav item text, done checks |
| `accent-soft` | `#ECF0FE` | `#232B47` | Current nav item background |
| `note` / `note-ink` | `#E9EEFE` / `#1E2230` | `#1E2540` / `#DDE3F7` | Note Widget |
| `good` / `good-bg` | `#0E7A55` / `#E2F5EC` | `#4FD6A0` / `#12332A` | Change in the good direction |
| `bad` / `bad-bg` | `#C2362F` / `#FDECEB` | `#FF8A80` / `#3A1E1E` | Bad change, overdue, over budget, errors |
| `warn` | `#B7791F` | `#E9B949` | Reconnecting |
| `live` | `#1BAA7B` | `#4FD6A0` | Live dot |
| `tip` / `tip-ink` | `#12141A` / `#FFFFFF` | `#F3F4F8` / `#12141A` | Chart tooltip (inverted surface) |

**Chart series**, in order: `s1` blue `#4361EE` / `#7B93FF`, `s2` peach `#F2A272` / `#F6AE80`, `s3` mint `#48C9A6` / `#4FD6B4`, `s4` lilac `#B39DF7` / `#BFA9FF`. More than four series repeat the cycle.

**Tints** (icon tile background / icon stroke), assigned by position on the page, cycling: blue `#ECF0FE`/`#4361EE`, peach `#FFF1E8`/`#D2652A`, mint `#E3F7F1`/`#1B9C78`, lilac `#F2EEFE`/`#8A6BE0`, amber `#FFF6E0`/`#B7791F` (dark: `#232B47`, `#3A2A20`, `#15342D`, `#2C2645`, `#3A3220` with the lifted strokes). KPI and progress icon tiles count one sequence; Dashboard link tiles count another.

**Good vs bad** follows `goodDirection`, not the sign: a falling "Spent this month" is green. The arrow always shows the real direction.

Text contrast is at least 4.5:1 on its surface in both themes, including `ink-3` on `soft`.

## Type

Plus Jakarta Sans (400, 500, 600, 700) for everything; JetBrains Mono only for code and connect commands. Numbers use `font-variant-numeric: tabular-nums`.

| Role | Size / weight | Notes |
|---|---|---|
| Dashboard title | 36 / 700 | letter-spacing −0.03em, with a 52px icon tile |
| KPI value | 34 / 700 | unit as 18/600 in `ink-3`; `€` stays a prefix |
| Section heading | 22 / 700 | `section` Widgets |
| Widget title | 19 / 700 | charts, tables, progress lists |
| KPI label | 14 / 600 | `ink-2` |
| Checklist and note titles | 15 / 700 | |
| Description, note body | 16 / 400 | line-height 1.7 for notes |
| UI text | 14 / 400 | sidebar, table cells |
| Meta | 12–13 / 500 | timestamps, legends, axis labels |

## Space and shape

- 4px base. Widget gap 20, Widget padding 22–24, page padding 52/48 (28/16 on phones).
- Reading column max 900px, centred in the main pane.
- Radii: Widgets 22, sidebar 24, icon tiles 16 (dashboards) or round (KPIs), nav items 14, chips, time pills and bars fully round.
- Light: soft shadow `0 1px 2px rgba(18,20,26,.04), 0 10px 30px rgba(18,20,26,.04)`, no borders. Dark: flat surfaces, no shadow glow.
- Below 820px the sidebar stacks above the content and `columns` children stack.

## Chrome

- **Sidebar:** a floating rounded panel (16px from the window edge, sticky). Wordmark, an "Areas" label, then the full Dashboard tree: Areas 44px tall and semibold, children 40px and indented 22px per level. The current Dashboard has `accent-soft` behind it. At the bottom, the connection card: **Live** (green dot), **Reconnecting…** (amber ring, "Showing the last data we received"), **Server stopped** (`bad-bg`, "Run `npx agentdash` to start it again").
- **Header:** breadcrumb pills for parents (`panel` background), then icon tile, title, description and an "Updated 2h ago" pill. Absolute time on hover everywhere a relative time appears.
- **Empty app:** one card with "No dashboards yet", a one-line prompt example and both connect commands (Claude Code, "or", Claude Desktop) in dark code blocks with Copy buttons, then a "Listening on 127.0.0.1:4242" status line.

## Widgets

Every leaf Widget shows its own relative timestamp at the top right (`ink-3`, 12px).

- **kpi:** round tinted icon tile, label, timestamp; value; change pill (`↑`/`↓` + amount, coloured by `goodDirection`) with "vs previous"; smooth sparkline with a faint area fill in the tile's stroke colour. Without an `x` slot: value only. The icon is a generic trend glyph, because the KPI config has no icon field.
- **chart:** title, legend (only with 2+ series) and timestamp in one row. Dashed gridlines, three to four nice ticks, `€` axis labels shortened to `€2k`. Line: smooth curve, 3px, area fill when there is one series. Bar: rounded segments separated by a 3px `panel` gap when stacked, grouped bars side by side otherwise. Hover shows a vertical band: other columns dim to 35%, a tooltip in the inverted `tip` surface lists the x value, total and per-series values.
- **progress:** single row without `label` renders like a KPI (big percentage, "€7,400 of €10,000", round bar in `s3`). Labelled rows render as a list with value / target on the right and bars in `s1`. Over target: the fill stops at a 3px target tick, the overflow segment and an "N% over" chip use `good` or `bad` by `goodDirection`.
- **table:** soft rounded header row, 14px cells, row dividers in `line`, first column in `ink-3`, numeric columns right-aligned and semibold. Wide tables scroll inside the Widget.
- **checklist:** round checkboxes; done items get an `accent` disc with a check and struck-through `ink-3` text. Open items first. Overdue open items sit on a `bad-bg` row with "Overdue · 31 Oct". A "2 of 4" count chip next to the title. `done: hide` adds "N done items hidden" under the list.
- **note:** a `note`-tinted card without shadow; markdown at 16px. Inline code on a `panel` chip; external links show `↗` and open in a new tab.
- **dashboardLink:** card with a 48px tinted tile holding the target's icon, its title and description, and a round arrow button that turns `accent` on hover. Hidden when the target is archived.
- **columns:** children side by side with a 20px gap, wrapping below ~260px per child.
- **section:** a 22px heading with its children stacked underneath; no card around it.

## States

- **No data yet:** KPI shows `—`, "No data yet" and a dashed baseline. Charts and tables show a `soft` box with "No data yet / Rows appear here as an Agent adds them."
- **Projection error:** a `bad-bg` panel with an alert badge: "Can't draw this Widget. Column `distance_km` is missing from Data Store `runs`. Ask an Agent to fix it."
- **Archived Data Store:** the Widget loses its card and gets a dashed `line` outline with an archive badge: "Data Store `holdings` was archived. An Agent can restore it or point this Widget elsewhere."

## Open

- Icon per KPI (would need a config field in #5). Until then the generic glyph.
- Additions beyond #5/#9 to confirm while building: the checklist count chip, "N done items hidden", the connection card states and position-based tints.
