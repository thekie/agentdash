import { expect, test } from "vitest";
import { timeAgo } from "./app.tsx";

const now = Date.parse("2026-11-03T12:00:00Z");

test.for([
  ["2026-11-03T11:59:30Z", "just now"],
  ["2026-11-03T11:55:00Z", "5m ago"],
  ["2026-11-03T10:00:00Z", "2h ago"],
  ["2026-11-02T12:00:00Z", "yesterday"],
  ["2026-10-30T12:00:00Z", "4d ago"],
] as const)("%s is %s at noon", ([iso, expected]) => {
  expect(timeAgo(iso, now)).toBe(expected);
});
