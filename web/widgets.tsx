import type { ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ColumnType } from "../src/storage/storage.ts";
import type { WidgetView } from "../src/web-api.ts";
import { Chart, seriesSwatch } from "./chart.tsx";
import { formatDate, formatValue, splitUnit } from "./format.ts";
import { Link } from "./link.tsx";
import { RelativeTime } from "./time.tsx";
import {
  type ChecklistItem,
  chartData,
  checklistRows,
  columnType,
  foldOther,
  header,
  isOverdue,
  kpiData,
  openFirst,
  type ProgressRow,
  progressRows,
  type Result,
  type Slots,
  slotOf,
  smoothPath,
} from "./widget-data.ts";

type WidgetOf<T extends WidgetView["type"]> = Extract<WidgetView, { type: T }>;

const tints = ["blue", "peach", "mint", "lilac", "amber"] as const;
type Tint = (typeof tints)[number];

function projectionSlots(widget: WidgetView): Slots {
  return ("projection" in widget && widget.projection?.slots) || {};
}

function hasIconTile(widget: WidgetView): boolean {
  return widget.type === "kpi" || (widget.type === "progress" && !projectionSlots(widget).label);
}

/** Returns the tint of each Widget with an icon tile. KPI tiles and link tiles count apart. */
function tintsOf(widgets: WidgetView[]): Map<string, Tint> {
  const assigned = new Map<string, Tint>();
  const counts = { tile: 0, link: 0 };
  const visit = (widget: WidgetView) => {
    const kind = widget.type === "dashboardLink" ? "link" : hasIconTile(widget) ? "tile" : null;
    if (kind) assigned.set(widget.id, tints[counts[kind]++ % tints.length] ?? "blue");
    widget.children.forEach(visit);
  };
  widgets.forEach(visit);
  return assigned;
}

function Head(props: { widget: WidgetView; tile?: ReactNode; children?: ReactNode }) {
  const { widget } = props;
  return (
    <div className="wh">
      {props.tile}
      <h2>{widget.title}</h2>
      {props.children}
      <RelativeTime className="ts" iso={widget.updatedAt} />
    </div>
  );
}

function Card(props: { widget: WidgetView; className?: string; children: ReactNode }) {
  const { widget } = props;
  return (
    <section
      className={props.className ? `w ${props.className}` : "w"}
      aria-label={widget.title ?? widget.type}
    >
      {props.children}
    </section>
  );
}

function NoData() {
  return (
    <div className="nodata">
      <div>
        <b>No data yet</b>Rows appear here as an Agent adds them.
      </div>
    </div>
  );
}

function IconTile({ tint }: { tint: Tint }) {
  return (
    <span className="tile" style={{ background: `var(--t-${tint})` }}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path d="M3 13l4-4 3 3 5-6" className="glyph" style={{ stroke: `var(--i-${tint})` }} />
      </svg>
    </span>
  );
}

function Big({ type, value }: { type: ColumnType; value: unknown }) {
  const [figure, unit] = splitUnit(type, value);
  return (
    <div className="big">
      {figure}
      {unit && <small>{unit}</small>}
    </div>
  );
}

function Sparkline({ values, tint }: { values: number[]; tint: Tint }) {
  const low = Math.min(...values);
  const range = Math.max(...values) - low || 1;
  const points = values.map((v, i): [number, number] => [
    (i * 200) / (values.length - 1),
    4 + (1 - (v - low) / range) * 36,
  ]);
  const d = smoothPath(points);
  const color = `var(--i-${tint})`;
  return (
    <svg className="spark" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true">
      <path d={`${d} L200,44 L0,44 Z`} style={{ fill: color, opacity: 0.12 }} />
      <path d={d} className="sparkline" style={{ stroke: color }} />
    </svg>
  );
}

function Change(props: { type: ColumnType; latest: number; previous: number; isUpGood: boolean }) {
  const change = props.latest - props.previous;
  const tone = change === 0 ? "n" : change > 0 === props.isUpGood ? "good" : "bad";
  const arrow = change > 0 ? "↑" : change < 0 ? "↓" : "→";
  return (
    <div className="sub">
      <span className={`chip ${tone}`}>
        {arrow} {formatValue(props.type, Math.abs(change))}
      </span>
      vs previous
    </div>
  );
}

function Kpi({ widget, result, tint }: { widget: WidgetOf<"kpi">; result: Result; tint: Tint }) {
  const { type, values } = kpiData(result, projectionSlots(widget));
  const [latest, previous] = [values.at(-1), values.at(-2)];
  return (
    <Card widget={widget} className="kpi">
      <Head widget={widget} tile={<IconTile tint={tint} />} />
      {latest === undefined ? (
        <>
          <div className="big none">—</div>
          <div className="sub">No data yet</div>
          <svg className="spark" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true">
            <line x1="0" y1="34" x2="200" y2="34" className="baseline" />
          </svg>
        </>
      ) : (
        <>
          <Big type={type} value={latest} />
          {previous !== undefined && (
            <>
              <Change
                type={type}
                latest={latest}
                previous={previous}
                isUpGood={widget.config.goodDirection !== "down"}
              />
              <Sparkline values={values} tint={tint} />
            </>
          )}
        </>
      )}
    </Card>
  );
}

function Track(props: { row: ProgressRow; label: string; fill: string; isUpGood: boolean }) {
  const ratio = props.row.value / props.row.target;
  const aria = {
    role: "progressbar",
    "aria-label": props.label,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": Math.round(ratio * 100),
  };
  if (ratio <= 1) {
    return (
      <div className="track" {...aria}>
        <div
          className="f"
          style={{ width: `${Math.max(ratio, 0) * 100}%`, background: props.fill }}
        />
      </div>
    );
  }
  const tick = `${100 / ratio}%`;
  return (
    <div className="track" {...aria}>
      <div className="f over" style={{ width: tick, background: props.fill }} />
      <div
        className="o"
        style={{ left: tick, background: `var(--${props.isUpGood ? "good" : "bad"})` }}
      />
      <div className="t" style={{ left: tick }} />
    </div>
  );
}

function Over({ row, isUpGood }: { row: ProgressRow; isUpGood: boolean }) {
  if (row.value <= row.target) return null;
  const percent = Math.round((row.value / row.target - 1) * 100);
  return <span className={`chip ${isUpGood ? "good" : "bad"}`}>{percent}% over</span>;
}

function Progress(props: { widget: WidgetOf<"progress">; result: Result; tint: Tint | undefined }) {
  const { widget, result, tint } = props;
  const slots = projectionSlots(widget);
  const rows = progressRows(result, slots, widget.config.target);
  const type = columnType(result, slotOf(slots, "value")) ?? { type: "text" };
  const isUpGood = widget.config.goodDirection !== "down";
  const [single] = rows;
  if (tint && single) {
    return (
      <Card widget={widget} className="kpi">
        <Head widget={widget} tile={<IconTile tint={tint} />} />
        <div className="big">
          {Math.round((single.value / single.target) * 100)}
          <small>%</small>
        </div>
        <div className="sub">
          <Over row={single} isUpGood={isUpGood} />
          {formatValue(type, single.value)} of {formatValue(type, single.target)}
        </div>
        <div className="bar">
          <Track
            row={single}
            label={widget.title ?? "Progress"}
            fill="var(--s3)"
            isUpGood={isUpGood}
          />
        </div>
      </Card>
    );
  }
  return (
    <Card widget={widget}>
      <Head widget={widget} />
      {rows.length === 0 ? (
        <NoData />
      ) : (
        rows.map((row) => (
          <div className="prow" key={row.label}>
            <div className="top">
              <span>
                {row.label}
                <Over row={row} isUpGood={isUpGood} />
              </span>
              <span>
                {formatValue(type, row.value)}{" "}
                <span className="of">/ {formatValue(type, row.target)}</span>
              </span>
            </div>
            <Track row={row} label={row.label ?? ""} fill="var(--s1)" isUpGood={isUpGood} />
          </div>
        ))
      )}
    </Card>
  );
}

const isNumeric = (type: ColumnType) => type.type === "number" || type.type === "money";

function Table({ widget, result }: { widget: WidgetOf<"table">; result: Result }) {
  return (
    <Card widget={widget} className="table">
      <Head widget={widget} />
      {result.rows.length === 0 ? (
        <NoData />
      ) : (
        <div className="tscroll">
          <table>
            <thead>
              <tr>
                {result.columns.map((c) => (
                  <th key={c.name} scope="col" className={isNumeric(c.type) ? "num" : undefined}>
                    {header(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Rows have no id, and the query fixes their order.
                <tr key={i}>
                  {result.columns.map((c) => (
                    <td key={c.name} className={isNumeric(c.type) ? "num" : undefined}>
                      {formatValue(c.type, row[c.name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const check = (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 6.2l2 2 4-4.4" className="glyph" />
  </svg>
);

function Item({ item }: { item: ChecklistItem }) {
  const isLate = isOverdue(item);
  return (
    <li className={item.done ? "done" : isLate ? "over" : undefined}>
      <span className="box" aria-hidden="true">
        {item.done && check}
      </span>
      <span className="t">{item.done ? <s>{item.text}</s> : item.text}</span>
      {!item.done && item.due && (
        <span className="due">
          {isLate ? "Overdue · " : "Due "}
          {formatDate(item.due)}
        </span>
      )}
    </li>
  );
}

function Checklist({ widget }: { widget: WidgetOf<"checklist"> }) {
  const sourceItems = widget.result
    ? checklistRows(widget.result, projectionSlots(widget))
    : widget.config.items;
  const items = openFirst(sourceItems ?? []);
  const doneCount = items.filter((i) => i.done).length;
  const isHiding = widget.config.done === "hide";
  const shownItems = isHiding ? items.filter((i) => !i.done) : items;
  return (
    <Card widget={widget} className="checklist">
      <Head widget={widget}>
        <span className="chip n">
          {doneCount} of {items.length}
        </span>
      </Head>
      {items.length === 0 && <NoData />}
      <ul className="cl">
        {shownItems.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Two items can share a text, and the order is fixed.
          <Item key={i} item={item} />
        ))}
      </ul>
      {isHiding && doneCount > 0 && (
        <p className="more">
          {doneCount} done {doneCount === 1 ? "item" : "items"} hidden
        </p>
      )}
    </Card>
  );
}

const markdownComponents: Components = {
  a: ({ href, children }) => {
    const isExternal =
      href !== undefined && new URL(href, location.href).origin !== location.origin;
    if (!isExternal) return <a href={href}>{children}</a>;
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children} ↗
      </a>
    );
  },
};

function Note({ widget }: { widget: WidgetOf<"note"> }) {
  return (
    <Card widget={widget} className="note">
      {widget.title && <Head widget={widget} />}
      <div className="md">
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          disallowedElements={["img"]}
          components={markdownComponents}
        >
          {widget.config.markdown}
        </Markdown>
      </div>
    </Card>
  );
}

function DashboardLink({ widget, tint }: { widget: WidgetOf<"dashboardLink">; tint: Tint }) {
  const { target } = widget;
  if (!target) return null;
  return (
    <Link path={target.path} className="link">
      <span className="lt" style={{ background: `var(--t-${tint})` }} aria-hidden="true">
        {target.icon ?? "📄"}
      </span>
      <span className="tx">
        <b>{target.title}</b>
        {target.description && <small>{target.description}</small>}
      </span>
      <span className="go" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M4 10l6-6M5 4h5v5" />
        </svg>
      </span>
    </Link>
  );
}

function Broken({
  widget,
  broken,
}: {
  widget: WidgetView;
  broken: NonNullable<WidgetView["broken"]>;
}) {
  if (broken.archivedStore !== undefined) {
    return (
      <Card widget={widget} className="archived">
        <Head widget={widget} />
        <div className="arch">
          <span className="badge" aria-hidden="true">
            🗄
          </span>
          <div>
            Data Store <code>{broken.archivedStore}</code> was Archived. An Agent can restore it or
            point this Widget elsewhere.
          </div>
        </div>
      </Card>
    );
  }
  return (
    <Card widget={widget}>
      <Head widget={widget} />
      <div className="alert" role="alert">
        <span className="badge" aria-hidden="true">
          !
        </span>
        <div>
          <b>Cannot draw this Widget</b>
          {broken.reason.charAt(0).toUpperCase() + broken.reason.slice(1)}. Ask an Agent to fix it.
        </div>
      </div>
    </Card>
  );
}

function ChartCard({ widget, result }: { widget: WidgetOf<"chart">; result: Result }) {
  const all = chartData(result, projectionSlots(widget));
  const data = widget.config.other === undefined ? all : foldOther(all, widget.config.other);
  return (
    <Card widget={widget}>
      <Head widget={widget}>
        {data.series.length > 1 && (
          <ul className="legend">
            {data.series.map((s, j) => (
              <li key={s.key}>
                <i style={{ background: seriesSwatch(j, s.key) }} />
                {s.name}
              </li>
            ))}
          </ul>
        )}
      </Head>
      {data.xs.length === 0 ? (
        <NoData />
      ) : (
        <Chart
          data={data}
          mark={widget.config.mark}
          isStacked={widget.config.stacked ?? false}
          hasTotal={(widget.config.stacked || widget.config.additive) ?? false}
        />
      )}
    </Card>
  );
}

function Leaf({ widget, tint }: { widget: WidgetView; tint: Tint }) {
  if (widget.broken) return <Broken widget={widget} broken={widget.broken} />;
  const { result } = widget;
  switch (widget.type) {
    case "note":
      return <Note widget={widget} />;
    case "dashboardLink":
      return <DashboardLink widget={widget} tint={tint} />;
    case "checklist":
      return <Checklist widget={widget} />;
  }
  if (!result) return null;
  switch (widget.type) {
    case "kpi":
      return <Kpi widget={widget} result={result} tint={tint} />;
    case "chart":
      return <ChartCard widget={widget} result={result} />;
    case "table":
      return <Table widget={widget} result={result} />;
    case "progress":
      return (
        <Progress widget={widget} result={result} tint={hasIconTile(widget) ? tint : undefined} />
      );
    default:
      return null;
  }
}

function Tree({ widget, tints }: { widget: WidgetView; tints: Map<string, Tint> }) {
  const children = widget.children.map((child) => (
    <Tree key={child.id} widget={child} tints={tints} />
  ));
  if (widget.type === "columns") return <div className="cols">{children}</div>;
  if (widget.type === "section") {
    return (
      <section className="sec">
        <h2>{widget.title}</h2>
        <div className="stack">{children}</div>
      </section>
    );
  }
  return <Leaf widget={widget} tint={tints.get(widget.id) ?? "blue"} />;
}

/** Draws the Widgets of a Dashboard in order, each from the Widget Catalog. */
export function Widgets({ widgets }: { widgets: WidgetView[] }) {
  const tints = tintsOf(widgets);
  return (
    <div className="stack">
      {widgets.map((w) => (
        <Tree key={w.id} widget={w} tints={tints} />
      ))}
    </div>
  );
}
