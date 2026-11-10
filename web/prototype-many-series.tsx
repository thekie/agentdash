// PROTOTYPE (How does a chart tell apart more than four series?): throwaway. Never merge to main.
// biome-ignore-all lint: throwaway prototype

import { useEffect, useState } from "react";
import type { ChartData } from "./widget-data.ts";

const variants = [
  { key: "T", name: "Today: four colours, then the cycle repeats" },
  { key: "A", name: "Six colours, the seventh repeats" },
  { key: "B", name: "Eight colours (where they break down)" },
  { key: "C", name: "Fifth and later folded into Other (when series add up)" },
  { key: "D", name: "Four colours, repeats hatched (bars) or dashed (lines)" },
];

/** Returns the `?variant=` key, A when missing. */
export const prototypeVariant = () => new URLSearchParams(location.search).get("variant") ?? "T";

/** Floating bar that cycles `?variant=` with the arrows or the arrow keys, then reloads. */
export function PrototypeManySeriesSwitcher() {
  const [current] = useState(prototypeVariant);
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  );
  const go = (step: number) => {
    const next = variants[(index + step + variants.length) % variants.length];
    const url = new URL(location.href);
    url.searchParams.set("variant", next?.key ?? "T");
    location.replace(url);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
  const style = {
    position: "fixed",
    bottom: 16,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 100,
    display: "flex",
    gap: 12,
    alignItems: "center",
    padding: "8px 14px",
    borderRadius: 999,
    background: "#ff2d8a",
    color: "#fff",
    font: "600 13px system-ui",
    boxShadow: "0 6px 20px rgba(0,0,0,.3)",
  } as const;
  const button = {
    background: "none",
    border: 0,
    color: "#fff",
    font: "inherit",
    cursor: "pointer",
  };
  return (
    <div style={style}>
      <button type="button" style={button} onClick={() => go(-1)}>
        ←
      </button>
      <span>
        {variants[index]?.key} — {variants[index]?.name}
      </span>
      <button type="button" style={button} onClick={() => go(1)}>
        →
      </button>
    </div>
  );
}

const colourCount = () => ({ T: 4, A: 6, B: 8, C: 4, D: 4 })[prototypeVariant()] ?? 4;

/** Whether series `j` repeats an earlier colour and wears the hatch (variant D only). */
export const isHatched = (j: number) => prototypeVariant() === "D" && j >= 4;

/** Returns the base colour of series `j`; key "other" is the folded series. */
export const prototypeColor = (j: number, key?: string) =>
  key === OTHER ? "var(--s-other)" : `var(--s${(j % colourCount()) + 1})`;

/** CSS background for a legend or tooltip swatch. */
export const prototypeSwatch = (j: number, key?: string) =>
  isHatched(j)
    ? `repeating-linear-gradient(45deg, ${prototypeColor(j)} 0 2.5px, transparent 2.5px 4.5px)`
    : prototypeColor(j, key);

export const OTHER = "__other__";

/**
 * Variant C: keeps the four series with the largest totals in their order and sums the rest
 * into "Other", only when the series add up (stacked or additive). Other charts keep the cycle.
 */
export function prototypeFold(data: ChartData, addsUp: boolean): ChartData & { folded?: string[] } {
  if (prototypeVariant() !== "C" || !addsUp || data.series.length <= 4) return data;
  const total = (s: ChartData["series"][number]) => s.values.reduce((a, b) => a + b, 0);
  const top = new Set([...data.series].sort((a, b) => total(b) - total(a)).slice(0, 4));
  const rest = data.series.filter((s) => !top.has(s));
  return {
    ...data,
    folded: rest.map((s) => s.name),
    series: [
      ...data.series.filter((s) => top.has(s)),
      {
        key: OTHER,
        name: `Other (${rest.length})`,
        values: data.xs.map((_, i) => rest.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)),
      },
    ],
  };
}

/** Names folded into Other, joined for the tooltip. */
export const foldedNames = (data: ChartData) =>
  "folded" in data && Array.isArray(data.folded) ? data.folded.join(", ") : "";
