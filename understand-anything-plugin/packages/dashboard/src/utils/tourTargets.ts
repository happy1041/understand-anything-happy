import type { GraphEdge } from "@understand-anything/core/types";

/** Resolve a tour's semantic references to representatives in the current view.
 * Hidden methods/classes use their nearest visible owner; other layers use
 * their portal (or layer card in overview). Never wait for filtered-out IDs.
 */
export function resolveTourTargets(
  highlightedIds: readonly string[],
  edges: readonly GraphEdge[],
  availableIds: ReadonlySet<string>,
  nodeLayers: ReadonlyMap<string, string> = new Map(),
): string[] {
  const parents = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type !== "contains") continue;
    const list = parents.get(edge.target) ?? [];
    list.push(edge.source);
    parents.set(edge.target, list);
  }
  const result = new Set<string>();
  for (const id of highlightedIds) {
    const queue = [id];
    const visited = new Set<string>();
    let resolved = false;
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      if (visited.has(current)) continue;
      visited.add(current);
      if (availableIds.has(current)) {
        result.add(current);
        resolved = true;
        break;
      }
      queue.push(...(parents.get(current) ?? []));
    }
    if (resolved) continue;
    const owner = queue.find(candidate => nodeLayers.has(candidate));
    const layer = owner ? nodeLayers.get(owner) : undefined;
    if (layer && availableIds.has(`portal:${layer}`)) result.add(`portal:${layer}`);
    else if (layer && availableIds.has(layer)) result.add(layer);
  }
  return [...result];
}
