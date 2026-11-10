// PROTOTYPE (Which chart tooltips show a total?): throwaway variant switcher. Never merge to main.
import { useEffect, useState } from "react";

const variants = [
  { key: "A", name: "No total for grouped bars and multi-line charts" },
  { key: "B", name: "Always a total" },
  { key: "C", name: "Total when a chart config flag says the series add up" },
  { key: "D", name: "Total when the y column is money (column-type rule)" },
];

/** Returns the `?variant=` key, A when missing. */
export const prototypeVariant = () => new URLSearchParams(location.search).get("variant") ?? "A";

/** Floating bar that cycles `?variant=` with the arrows or the arrow keys, then reloads. */
export function PrototypeTooltipSwitcher() {
  const [current] = useState(prototypeVariant);
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  );
  const go = (step: number) => {
    const next = variants[(index + step + variants.length) % variants.length];
    const url = new URL(location.href);
    url.searchParams.set("variant", next?.key ?? "A");
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
