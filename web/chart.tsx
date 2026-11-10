import { type PointerEvent, type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { formatAxisValue, formatValue } from "./format.ts";
import { type ChartData, niceScale, smoothPath } from "./widget-data.ts";

const left = 64;
const rightGap = 16;
const top = 16;
const bottom = 200;
const height = 236;
/** Horizontal room one x label needs. */
const labelSpace = 72;

/** Returns the rendered width of `ref` in CSS pixels, updated as it resizes. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Returns the colour of the series at `index`. Four colours repeat. */
export const seriesColor = (index: number) => `var(--s${(index % 4) + 1})`;

interface Geometry {
  x: (index: number) => number;
  y: (value: number) => number;
  band: number;
}

interface BarsProps {
  data: ChartData;
  g: Geometry;
  hovered: number | undefined;
}

const columnClass = (i: number, hovered: number | undefined) => (i === hovered ? "col on" : "col");

function StackedBars({ data, g, hovered }: BarsProps) {
  const width = Math.min(44, g.band * 0.45);
  return data.xs.map((key, i) => {
    let base = 0;
    return (
      <g key={key} className={columnClass(i, hovered)}>
        {data.series.map((s, j) => {
          const from = base;
          base += s.values[i] ?? 0;
          return (
            <rect
              key={s.name}
              className="seg"
              x={g.x(i) - width / 2}
              y={Math.min(g.y(base), g.y(from))}
              width={width}
              height={Math.abs(g.y(from) - g.y(base))}
              rx={7}
              style={{ fill: seriesColor(j) }}
            />
          );
        })}
      </g>
    );
  });
}

function GroupedBars({ data, g, hovered }: BarsProps) {
  const count = data.series.length;
  const width = Math.min(g.band * 0.6, count * 30);
  return data.xs.map((key, i) => (
    <g key={key} className={columnClass(i, hovered)}>
      {data.series.map((s, j) => {
        const value = s.values[i] ?? 0;
        return (
          <rect
            key={s.name}
            x={g.x(i) - width / 2 + (j * width) / count + 1.5}
            y={Math.min(g.y(value), g.y(0))}
            width={Math.max(1, width / count - 3)}
            height={Math.abs(g.y(0) - g.y(value))}
            rx={7}
            style={{ fill: seriesColor(j) }}
          />
        );
      })}
    </g>
  ));
}

function Lines({ data, g, gradient }: { data: ChartData; g: Geometry; gradient: string }) {
  return data.series.map((s, j) => {
    const d = smoothPath(s.values.map((v, i) => [g.x(i), g.y(v)]));
    const last = g.x(s.values.length - 1);
    return (
      <g key={s.name}>
        {data.series.length === 1 && (
          <path d={`${d} L${last},${bottom} L${g.x(0)},${bottom} Z`} fill={`url(#${gradient})`} />
        )}
        <path d={d} className="line" style={{ stroke: seriesColor(j) }} />
      </g>
    );
  });
}

function Tooltip({
  data,
  index,
  x,
  isStacked,
}: {
  data: ChartData;
  index: number;
  x: number;
  isStacked: boolean;
}) {
  const rows = data.series.map((s, j) => ({ name: s.name, value: s.values[index] ?? 0, j }));
  const total = isStacked || rows.length === 1 ? rows.reduce((sum, r) => sum + r.value, 0) : null;
  return (
    <div className="tip" role="tooltip" style={{ left: x }}>
      <small>{data.xs[index]}</small>
      {total !== null && <b>{formatValue(data.yType, total)}</b>}
      {rows.length > 1 &&
        rows.map((r) => (
          <div className="r" key={r.name}>
            <span>
              <i style={{ background: seriesColor(r.j) }} />
              {r.name}
            </span>
            {formatValue(data.yType, r.value)}
          </div>
        ))}
    </div>
  );
}

function chartLabel(data: ChartData, mark: "line" | "bar", isStacked: boolean): string {
  const kind = mark === "line" ? "Line" : isStacked ? "Stacked bar" : "Bar";
  const names = data.series.map((s) => s.name).join(", ");
  return `${kind} chart of ${names}, ${data.xs[0]} to ${data.xs.at(-1)}`;
}

/** Draws a line or bar chart on one y axis, with a tooltip for the x position under the pointer. */
export function Chart(props: { data: ChartData; mark: "line" | "bar"; isStacked: boolean }) {
  const { data, mark } = props;
  const gradient = useId();
  const [hovered, setHovered] = useState<number>();
  const plot = useRef<HTMLDivElement>(null);
  const width = useWidth(plot);
  const right = width - rightGap;
  const isStacked = mark === "bar" && props.isStacked;
  const tops = isStacked
    ? data.xs.map((_, i) => data.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0))
    : data.series.flatMap((s) => s.values);
  const scale = niceScale(tops, mark === "bar");
  const band = (right - left) / data.xs.length;
  const g: Geometry = {
    band,
    x: (i) => left + band * (i + 0.5),
    y: (v) => bottom - ((v - scale.min) / (scale.max - scale.min)) * (bottom - top),
  };
  const every = Math.ceil(data.xs.length / Math.max(1, Math.floor((right - left) / labelSpace)));
  const showTooltipAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor((event.clientX - box.left - left) / band);
    setHovered(index >= 0 && index < data.xs.length ? index : undefined);
  };
  return (
    <div
      ref={plot}
      className="plot"
      onPointerMove={showTooltipAt}
      onPointerLeave={() => setHovered(undefined)}
    >
      {width > 0 && (
        <svg
          className={hovered === undefined ? "chart" : "chart dim"}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={chartLabel(data, mark, isStacked)}
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: seriesColor(0), stopOpacity: 0.2 }} />
              <stop offset="1" style={{ stopColor: seriesColor(0), stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {scale.ticks.map((t) => (
            <g key={t}>
              <line
                className={t === scale.min ? "base" : "grid"}
                x1={left}
                x2={right}
                y1={g.y(t)}
                y2={g.y(t)}
              />
              <text x={left - 12} y={g.y(t) + 4} textAnchor="end">
                {formatAxisValue(data.yType, t)}
              </text>
            </g>
          ))}
          {mark === "bar" ? (
            isStacked ? (
              <StackedBars data={data} g={g} hovered={hovered} />
            ) : (
              <GroupedBars data={data} g={g} hovered={hovered} />
            )
          ) : (
            <Lines data={data} g={g} gradient={gradient} />
          )}
          {hovered !== undefined && (
            <g>
              <line className="guide" x1={g.x(hovered)} x2={g.x(hovered)} y1={top} y2={bottom} />
              {mark === "line" &&
                data.series.map((s, j) => (
                  <circle
                    key={s.name}
                    className="pt"
                    cx={g.x(hovered)}
                    cy={g.y(s.values[hovered] ?? 0)}
                    r={6}
                    style={{ stroke: seriesColor(j) }}
                  />
                ))}
            </g>
          )}
          {data.xs.map((x, i) =>
            i % every ? null : (
              <text key={x} x={g.x(i)} y={226} textAnchor="middle">
                {x}
              </text>
            ),
          )}
        </svg>
      )}
      {hovered !== undefined && (
        <Tooltip data={data} index={hovered} x={g.x(hovered)} isStacked={isStacked} />
      )}
    </div>
  );
}
