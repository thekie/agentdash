const relative = new Intl.RelativeTimeFormat("en", { style: "narrow", numeric: "auto" });
const units = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
] as const;

/** Returns how long ago `iso` was, such as "2h ago" or "just now". */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = (now - Date.parse(iso)) / 1000;
  if (seconds < 60) return "just now";
  const [unit, size] = units.find(([, size]) => seconds >= size) ?? units[2];
  return relative.format(-Math.floor(seconds / size), unit);
}

/** Draws how long ago `iso` was, with the absolute time on hover. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time className={className} dateTime={iso} title={new Date(iso).toLocaleString()}>
      {timeAgo(iso)}
    </time>
  );
}
