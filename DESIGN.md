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

The values live only in `web/styles.css`, as custom properties under `:root` and again for dark under `prefers-color-scheme`. Light and dark use the same token names; there is no in-app toggle in v1.

| Token               | Use                                                   |
| ------------------- | ----------------------------------------------------- |
| `bg`                | Page ground                                           |
| `panel`             | Widgets, sidebar, breadcrumb pills                    |
| `soft`              | Chips, table header, round buttons, "No data yet" box |
| `track`             | Progress track                                        |
| `line`              | Gridlines, table rows, dashed outlines                |
| `ink`               | Text, values                                          |
| `ink-2`             | Secondary text, KPI labels                            |
| `ink-3`             | Timestamps, axis labels, meta                         |
| `accent`            | Links, current nav item text, done checks             |
| `accent-soft`       | Current nav item background                           |
| `note` / `note-ink` | Note Widget                                           |
| `good` / `good-bg`  | Change in the good direction                          |
| `bad` / `bad-bg`    | Bad change, overdue, over budget, errors              |
| `warn`              | Reconnecting                                          |
| `live`              | Live dot                                              |
| `tip` / `tip-ink`   | Chart tooltip (inverted surface)                      |

**Chart series**, in order: `s1` blue, `s2` peach, `s3` mint, `s4` lilac. From the fifth series on, the colours repeat with a second cue: bars get a 45° hatch in `panel` stripes, lines a 7/6 dash, and legend and tooltip swatches the same hatch. Other, the series a chart folds its smallest series into, is grey `s-other`. More hues were tried and rejected: past six, two of them fall below a colour-blind separation of ΔE 8 (OKLab).

**Tints** (icon tile background / icon stroke), assigned by position on the page, cycling: blue, peach, mint, lilac, amber (`t-blue` / `i-blue` and so on). KPI and progress icon tiles count one sequence; Dashboard link tiles count another.

**Good vs bad** follows `goodDirection`, not the sign: a falling "Spent this month" is green. The arrow always shows the real direction.

Text contrast is at least 4.5:1 on its surface in both themes, including `ink-3` on `soft`.

## Type

Plus Jakarta Sans (400, 500, 600, 700) for everything; JetBrains Mono only for code and connect commands. Numbers use `font-variant-numeric: tabular-nums`.

| Role                      | Size / weight | Notes                                         |
| ------------------------- | ------------- | --------------------------------------------- |
| Dashboard title           | 36 / 700      | letter-spacing −0.03em, with a 52px icon tile |
| KPI value                 | 34 / 700      | unit as 18/600 in `ink-3`; `€` stays a prefix |
| Section heading           | 22 / 700      | `section` Widgets                             |
| Widget title              | 19 / 700      | charts, tables, progress lists                |
| KPI label                 | 14 / 600      | `ink-2`                                       |
| Checklist and note titles | 15 / 700      |                                               |
| Description, note body    | 16 / 400      | line-height 1.7 for notes                     |
| UI text                   | 14 / 400      | sidebar, table cells                          |
| Meta                      | 12–13 / 500   | timestamps, legends, axis labels              |

## Space and shape

- 4px base. Widget gap 20, Widget padding 22–24, page padding 52/48 (28/16 on phones).
- Reading column max 900px, centred in the main pane.
- Radii: Widgets 22, sidebar 24, icon tiles 16 (dashboards) or round (KPIs), nav items 14, chips, time pills and bars fully round.
- Light: soft shadow `0 1px 2px rgba(18,20,26,.04), 0 10px 30px rgba(18,20,26,.04)`, no borders. Dark: flat surfaces, no shadow glow.
- Below 820px the sidebar stacks above the content and `columns` children stack.

## Chrome

- **Sidebar:** a floating rounded panel (16px from the window edge, sticky). Wordmark, an "Areas" label, then the full Dashboard tree: Areas 44px tall and semibold, children 40px and indented 22px per level. The current Dashboard has `accent-soft` behind it. At the bottom, the connection card: **Live** (green dot), **Reconnecting…** (amber ring, "Showing the last data we received"), **Server stopped** (`bad-bg`, "Run `npx agentdash` to start it again").
- **Header:** breadcrumb pills for parents (`panel` background), then icon tile, title, description and an "Updated 2h ago" pill. Absolute time on hover everywhere a relative time appears.
- **Empty app:** one card with "No dashboards yet", a one-line prompt example and both connect commands (Claude Code, "or", Claude Desktop) in dark code blocks with Copy buttons, then a "Listening on 127.0.0.1:4242. This page fills in by itself." status line. Without a connection, the connection card replaces that line.

## Widgets

Every leaf Widget shows its own relative timestamp at the top right (`ink-3`, 12px).

- **kpi:** round tinted icon tile, label, timestamp; value; change pill (`↑`/`↓` + amount, coloured by `goodDirection`) with "vs previous"; smooth sparkline with a faint area fill in the tile's stroke colour. Without an `x` slot: value only. The icon is a generic trend glyph, because the KPI config has no icon field.
- **chart:** title, legend (only with 2+ series) and timestamp in one row. Dashed gridlines, three to four nice ticks, `€` axis labels shortened to `€2k`. Line: smooth curve, 3px, area fill when there is one series. Bar: rounded segments separated by a 3px `panel` gap when stacked, grouped bars side by side otherwise. Hover shows a vertical band: other columns dim to 35%, a tooltip in the inverted `tip` surface lists the x value, the total and the per-series values. The total shows for stacked bars, a single series, and charts whose `additive` flag says the series add up (km per sport, balances per account). Grouped bars and multi-line charts without the flag show no total, because prices, weights or heart rates do not add up. A chart whose series add up can set `other: N`: it draws the N series with the largest totals in their order, then one Other series with the sum of the rest, whose tooltip row names them.
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
