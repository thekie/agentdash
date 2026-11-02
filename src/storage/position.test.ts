import { expect, test } from "vitest";
import { type Position, placeAt } from "./position.ts";

test.for<[Position, string[]]>([
  ["first", ["x", "a", "b", "c"]],
  ["last", ["a", "b", "c", "x"]],
  [{ before: "b" }, ["a", "x", "b", "c"]],
  [{ after: "c" }, ["a", "b", "c", "x"]],
])("placing at %j orders siblings as %j", ([position, expected]) => {
  expect(placeAt(["a", "b", "c"], "x", position)).toEqual(expected);
});

test("placing an existing sibling moves it", () => {
  expect(placeAt(["a", "b", "c"], "a", { after: "c" })).toEqual(["b", "c", "a"]);
});

test("an anchor that is not a sibling places nothing", () => {
  expect(placeAt(["a"], "x", { before: "zz" })).toBeUndefined();
});

test("an item cannot anchor on itself", () => {
  expect(placeAt(["a", "b"], "a", { before: "a" })).toBeUndefined();
});
