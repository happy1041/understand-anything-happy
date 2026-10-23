import { beforeEach, describe, expect, it } from "vitest";
import { readGraphViews, resolveGraphView, scopeGraph } from "../graphViews";
import { useDashboardStore } from "../store";

import { graph, config } from "./fixtures/graphViews";

beforeEach(() => useDashboardStore.setState(useDashboardStore.getInitialState(), true));
describe("independent architecture views", () => {
  it("keeps the canonical graph unchanged and scopes edges, layers and the complete tour", () => {
    const original = JSON.stringify(graph);
    const views = readGraphViews(config, graph);
    for (const view of views) {
      const scoped = scopeGraph(graph, view);
      expect(scoped.nodes.map(n => n.id)).toEqual(view.nodeIds);
      expect(scoped.layers.map(l => l.id)).toEqual([view.id]);
      expect(scoped.edges.every(e => view.nodeIds.includes(e.source) && view.nodeIds.includes(e.target))).toBe(true);
      expect(scoped.tour.map(t => t.order)).toEqual([1, 2]);
      expect(scoped.tour.every(t => t.title.startsWith(view.id))).toBe(true);
    }
    expect(JSON.stringify(graph)).toBe(original);
  });
  it("honors an explicit tour subset and excludes cross-view steps", () => {
    const mixed = { ...graph, tour: [...graph.tour, { order: 7, title: "mixed", description: "", nodeIds: ["zipper-model", "snap-model"] }] };
    expect(scopeGraph(mixed, { ...config.graphViews[0], tourOrders: [2, 7] }).tour.map(t => t.title)).toEqual(["zipper model"]);
  });
  it("selects a deep link, configured default, then first view", () => {
    const views = readGraphViews(config, graph);
    expect(resolveGraphView(views, "snap", "zipper")?.id).toBe("snap");
    expect(resolveGraphView(views, "missing", "velcro")?.id).toBe("velcro");
    expect(resolveGraphView(views, null, "missing")?.id).toBe("zipper");
    expect(scopeGraph(graph)).toBe(graph);
    expect(readGraphViews({}, graph)).toEqual([]);
  });
  it("fails visibly for dangling nodes or duplicate view ids", () => {
    expect(() => readGraphViews({ graphViews: [{ id: "bad", label: "Bad", nodeIds: ["missing"] }] }, graph)).toThrow();
    expect(() => readGraphViews({ graphViews: [config.graphViews[0], config.graphViews[0]] }, graph)).toThrow();
  });
  it("switches search, document, filters and tours without retaining state from another model", () => {
    const views = readGraphViews(config, graph);
    const store = useDashboardStore;
    for (const view of [...views, views[0]]) {
      store.getState().setGraph(scopeGraph(graph, view), true);
      const s = store.getState();
      expect(s.codeViewerOpen).toBe(false);
      expect(s.codeViewerNodeId).toBeNull();
      expect(s.tourActive).toBe(false);
      expect(s.tourHighlightedNodeIds).toEqual([]);
      expect(s.searchQuery).toBe("");
      expect(s.nodeHistory).toEqual([]);
      expect(s.activeLayerId).toBeNull();
      expect(s.reactFlowInstance).toBeNull();
      expect(s.filters.layerIds.size).toBe(0);
      s.setSearchQuery("asset");
      expect(store.getState().searchResults.every(r => view.nodeIds.includes(r.nodeId))).toBe(true);
      s.startTour();
      expect(store.getState().tourHighlightedNodeIds).toEqual([`${view.id}-asset`]);
      s.nextTourStep();
      expect(store.getState().tourHighlightedNodeIds).toEqual([`${view.id}-model`]);
      s.prevTourStep();
      expect(store.getState().tourHighlightedNodeIds).toEqual([`${view.id}-asset`]);
      s.navigateToNodeInLayer(`${view.id}-model`);
      expect(store.getState().codeViewerNodeId).toBe(`${view.id}-model`);
      s.setFilters({ layerIds: new Set([view.id]) });
    }
  });
});
