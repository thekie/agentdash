/** Describes where an item goes among its siblings: first, last, or next to a sibling. */
export type Position = "first" | "last" | { before: string } | { after: string };

/**
 * Returns the ids of the siblings in their new order, with `id` at `position`. If `id` is already a
 * sibling, it moves. Returns `undefined` if the anchor is not a sibling.
 */
export function placeAt(siblings: string[], id: string, position: Position): string[] | undefined {
  const others = siblings.filter((s) => s !== id);
  if (position === "first") return [id, ...others];
  if (position === "last") return [...others, id];
  const anchor = "before" in position ? position.before : position.after;
  const index = others.indexOf(anchor);
  if (index === -1) return undefined;
  const at = "before" in position ? index : index + 1;
  return [...others.slice(0, at), id, ...others.slice(at)];
}
