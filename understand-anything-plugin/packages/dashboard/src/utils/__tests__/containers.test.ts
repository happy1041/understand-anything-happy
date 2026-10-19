import { describe, it, expect } from "vitest";
import { deriveContainers } from "../containers";
import type { GraphNode, GraphEdge } from "@understand-anything/core/types";

function node(id: string, filePath?: string): GraphNode {
  return {
    id,
    type: "file",
    name: id,
    filePath,
    summary: "",
    complexity: "simple",
    tags: [],
  } as GraphNode;
}

describe("deriveContainers — folder strategy", () => {
  it("groups nodes by first folder segment after LCP", () => {
    const nodes = [
      node("a", "src/auth/login.go"),
      node("b", "src/auth/oauth.go"),
      node("c", "src/cart/cart.go"),
      node("d", "src/cart/checkout.go"),
    ];
    const { containers, ungrouped } = deriveContainers(nodes, []);
    expect(ungrouped).toEqual([]);
    expect(containers).toHaveLength(2);
    const names = containers.map((c) => c.name).sort();
    expect(names).toEqual(["auth", "cart"]);
    const auth = containers.find((c) => c.name === "auth")!;
    expect(auth.strategy).toBe("folder");
    expect(auth.nodeIds.sort()).toEqual(["a", "b"]);
  });

  it("strips deep LCP", () => {
    const nodes = [
      node("a", "monorepo/backend/src/auth/login.go"),
      node("b", "monorepo/backend/src/cart/cart.go"),
      node("c", "monorepo/backend/src/auth/oauth.go"),
      node("d", "monorepo/backend/src/cart/checkout.go"),
    ];
    const { containers } = deriveContainers(nodes, []);
    const names = containers.map((c) => c.name).sort();
    expect(names).toEqual(["auth", "cart"]);
  });

  it("collapses nested folders into the first segment", () => {
    const nodes = [
      node("a", "auth/handlers/oauth.go"),
      node("b", "auth/services/token.go"),
      node("c", "cart/cart.go"),
    ];
    const { containers } = deriveContainers(nodes, []);
    expect(containers.find((c) => c.name === "auth")?.nodeIds.sort()).toEqual(["a", "b"]);
  });

  it("places nodes without filePath in '~' container", () => {
    const nodes = [
      node("a", "auth/login.go"),
      node("b", "auth/oauth.go"),
      node("c"),
      node("d"),
    ];
    const { containers } = deriveContainers(nodes, []);
    expect(containers.find((c) => c.name === "~")?.nodeIds.sort()).toEqual(["c", "d"]);
  });

  it("suppresses single-child containers (single child becomes ungrouped)", () => {
    const nodes = [
      node("a", "auth/login.go"),
      node("b", "auth/oauth.go"),
      node("c", "cart/cart.go"),
    ];
    const { containers, ungrouped } = deriveContainers(nodes, []);
    // 'cart' has only 1 child → suppressed
    expect(containers.find((c) => c.name === "cart")).toBeUndefined();
    expect(ungrouped).toContain("c");
    // 'auth' kept
    expect(containers.find((c) => c.name === "auth")?.nodeIds.sort()).toEqual(["a", "b"]);
  });

  it("returns flat when every folder has a single node", () => {
    const nodes = [
      node("a", "auth/x.go"),
      node("b", "cart/y.go"),
      node("c", "logs/z.go"),
    ];
    const { containers, ungrouped } = deriveContainers(nodes, []);
    expect(containers).toHaveLength(0);
    expect(ungrouped.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("deriveContainers — community fallback", () => {
  it("shows a single-file layer directly instead of an empty collapsed cluster", () => {
    const { containers, ungrouped } = deriveContainers([
      node("plan", "gpt-docs/PLAN.md"),
    ], []);
    expect(containers).toEqual([]);
    expect(ungrouped).toEqual(["plan"]);
  });

  it("shows both disconnected nodes directly in a two-node layer", () => {
    const { containers, ungrouped } = deriveContainers([
      node("a", "src/a.ts"), node("b", "src/b.ts"),
    ], []);
    expect(containers).toEqual([]);
    expect(ungrouped.sort()).toEqual(["a", "b"]);
  });

  it.each([2, 6])("flattens one community covering the whole %i-node layer", (count) => {
    const nodes = Array.from({ length: count }, (_, i) => node(`n${i}`, `src/n${i}.ts`));
    const edges = nodes.flatMap((source, i) => nodes.slice(i + 1).map((target) => ({
      source: source.id, target: target.id, type: "calls",
    } as GraphEdge)));
    const { containers, ungrouped } = deriveContainers(nodes, edges);
    expect(containers).toEqual([]);
    expect(ungrouped).toEqual(nodes.map((n) => n.id));
  });

  it("keeps a community beside an ungrouped file because it still partitions the layer", () => {
    const nodes = [node("a", "src/a.ts"), node("b", "src/b.ts"), node("c", "src/c.ts")];
    const edges = [{ source: "a", target: "b", type: "calls" } as GraphEdge];
    const { containers, ungrouped } = deriveContainers(nodes, edges);
    expect(containers).toHaveLength(1);
    expect(containers[0].strategy).toBe("community");
    expect(containers[0].nodeIds.sort()).toEqual(["a", "b"]);
    expect(ungrouped).toEqual(["c"]);
  });

  it("falls back to communities when only one folder present", () => {
    const nodes = Array.from({ length: 10 }, (_, i) =>
      node(`n${i}`, `services/n${i}.go`),
    );
    // Two clusters of 5 nodes; densely connected within, no edges between
    const edges: GraphEdge[] = [];
    for (const i of [0, 1, 2, 3, 4]) {
      for (const j of [0, 1, 2, 3, 4]) {
        if (i !== j) edges.push({ source: `n${i}`, target: `n${j}`, type: "calls" } as GraphEdge);
      }
    }
    for (const i of [5, 6, 7, 8, 9]) {
      for (const j of [5, 6, 7, 8, 9]) {
        if (i !== j) edges.push({ source: `n${i}`, target: `n${j}`, type: "calls" } as GraphEdge);
      }
    }
    const { containers } = deriveContainers(nodes, edges);
    expect(containers.length).toBeGreaterThanOrEqual(2);
    for (const c of containers) {
      expect(c.strategy).toBe("community");
      expect(c.name).toMatch(/^Cluster [A-Z]$/);
    }
  });

  it("falls back when one folder holds > 70%", () => {
    const nodes = [
      ...Array.from({ length: 8 }, (_, i) => node(`big${i}`, `big/file${i}.go`)),
      node("a", "small1/a.go"),
      node("b", "small2/b.go"),
    ];
    const { containers, ungrouped } = deriveContainers(nodes, []);
    // Folder strategy would have produced a 'big' container with 8 children.
    // Community fallback (no edges) gives each node its own community → all
    // single-child → all suppressed. The non-vacuous evidence the fallback
    // path was taken: NO folder-strategy 'big' container survives.
    expect(containers.find((c) => c.strategy === "folder" && c.name === "big")).toBeUndefined();
    expect(ungrouped.length).toBe(10);
  });
});
