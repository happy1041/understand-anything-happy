import { beforeEach, describe, expect, it } from "vitest";
import type { GraphNode, KnowledgeGraph } from "@understand-anything/core/types";
import { useDashboardStore } from "../store";

function node(id: string): GraphNode {
  return {
    id,
    type: "file",
    name: id,
    summary: "",
    tags: [],
    complexity: "simple",
  };
}

function graph(): KnowledgeGraph {
  return {
    version: "1.0.0",
    project: {
      name: "fixture",
      languages: [],
      frameworks: [],
      description: "",
      analyzedAt: "2026-07-03T00:00:00.000Z",
      gitCommitHash: "test",
    },
    nodes: [node("a1"), node("a2"), node("b1"), node("b2")],
    edges: [],
    layers: [
      { id: "layer:a", name: "A", description: "", nodeIds: ["a1", "a2"] },
      { id: "layer:b", name: "B", description: "", nodeIds: ["b1", "b2"] },
    ],
    tour: [],
  };
}

function symbolGraph(): KnowledgeGraph {
  const g = graph();
  g.nodes.push(
    { ...node("classB"), type: "class" },
    { ...node("methodB"), type: "function" },
  );
  g.edges.push(
    { source: "b1", target: "classB", type: "contains", direction: "forward", weight: 1 },
    { source: "classB", target: "methodB", type: "contains", direction: "forward", weight: 1 },
  );
  return g;
}

function seedContainerState(): void {
  useDashboardStore.getState().expandContainer("container:cluster-0");
  useDashboardStore.getState().setPendingFocusContainer("container:cluster-0");
  useDashboardStore.getState().setContainerLayout(
    "container:cluster-0",
    new Map([["a1", { x: 10, y: 20 }]]),
    { width: 200, height: 120 },
  );
}

function expectContainerStateCleared(): void {
  const state = useDashboardStore.getState();
  expect(state.containerLayoutCache.size).toBe(0);
  expect(state.containerSizeMemory.size).toBe(0);
  expect(state.expandedContainers.size).toBe(0);
  expect(state.pendingFocusContainer).toBeNull();
}

beforeEach(() => {
  useDashboardStore.setState(useDashboardStore.getInitialState(), true);
});

describe("store layer navigation container cache resets", () => {
  it("clears container state when navigateToNodeInLayer crosses layers", () => {
    useDashboardStore.getState().setGraph(graph());
    useDashboardStore.getState().navigateToNodeInLayer("a1");
    seedContainerState();

    useDashboardStore.getState().navigateToNodeInLayer("b1");

    expect(useDashboardStore.getState().activeLayerId).toBe("layer:b");
    expectContainerStateCleared();
  });

  it("preserves container state when navigateToNodeInLayer stays in the same layer", () => {
    useDashboardStore.getState().setGraph(graph());
    useDashboardStore.getState().navigateToNodeInLayer("a1");
    seedContainerState();

    useDashboardStore.getState().navigateToNodeInLayer("a2");

    const state = useDashboardStore.getState();
    expect(state.activeLayerId).toBe("layer:a");
    expect(state.containerLayoutCache.size).toBe(1);
    expect(state.containerSizeMemory.size).toBe(1);
    expect(state.expandedContainers.has("container:cluster-0")).toBe(true);
    expect(state.pendingFocusContainer).toBe("container:cluster-0");
  });

  it("clears container state when navigateToHistoryIndex crosses layers", () => {
    useDashboardStore.getState().setGraph(graph());
    useDashboardStore.getState().navigateToNodeInLayer("b1");
    useDashboardStore.getState().navigateToNodeInLayer("a1");
    seedContainerState();

    useDashboardStore.getState().navigateToHistoryIndex(0);

    expect(useDashboardStore.getState().activeLayerId).toBe("layer:b");
    expectContainerStateCleared();
  });

  it("clears container state when goBackNode crosses layers", () => {
    useDashboardStore.getState().setGraph(graph());
    useDashboardStore.getState().navigateToNodeInLayer("b1");
    useDashboardStore.getState().navigateToNodeInLayer("a1");
    seedContainerState();

    useDashboardStore.getState().goBackNode();

    expect(useDashboardStore.getState().activeLayerId).toBe("layer:b");
    expectContainerStateCleared();
  });
});

describe("symbol tour layer navigation", () => {
  it("inherits file membership for classes and methods, then navigates symbol-only steps", () => {
    const g = graph();
    g.nodes.push({...node("classB"),type:"class"},{...node("methodB"),type:"function"});
    g.edges.push(
      {source:"b1",target:"classB",type:"contains",direction:"forward",weight:1},
      {source:"classB",target:"methodB",type:"contains",direction:"forward",weight:1},
    );
    g.tour = [
      {order:1,title:"A",description:"",nodeIds:["a1"]},
      {order:2,title:"B method",description:"",nodeIds:["methodB"]},
    ];
    useDashboardStore.getState().setGraph(g);
    useDashboardStore.getState().startTour();
    expect(useDashboardStore.getState().activeLayerId).toBe("layer:a");
    useDashboardStore.getState().nextTourStep();
    expect(useDashboardStore.getState().activeLayerId).toBe("layer:b");
    expect(useDashboardStore.getState().nodeIdToLayerIds.get("methodB")).toEqual(new Set(["layer:b"]));
  });

  it("releases inspected node selection when changing tour steps in either direction", () => {
    const g = symbolGraph();
    g.tour = [
      { order: 1, title: "A", description: "", nodeIds: ["a1"] },
      { order: 2, title: "B method", description: "", nodeIds: ["methodB"] },
    ];
    useDashboardStore.getState().setGraph(g);
    useDashboardStore.getState().startTour();
    useDashboardStore.getState().navigateToNodeInLayer("a1");
    useDashboardStore.getState().nextTourStep();
    expect(useDashboardStore.getState().selectedNodeId).toBeNull();
    expect(useDashboardStore.getState().activeLayerId).toBe("layer:b");
    useDashboardStore.getState().navigateToNodeInLayer("methodB");
    useDashboardStore.getState().prevTourStep();
    expect(useDashboardStore.getState().selectedNodeId).toBeNull();
    expect(useDashboardStore.getState().activeLayerId).toBe("layer:a");
    useDashboardStore.getState().navigateToNodeInLayer("a1");
    useDashboardStore.getState().setTourStep(1);
    expect(useDashboardStore.getState().selectedNodeId).toBeNull();
    expect(useDashboardStore.getState().activeLayerId).toBe("layer:b");
  });
});

describe("sidebar symbol navigation visibility", () => {
  it("opens a class in class view and clears same-layer file layout caches", () => {
    useDashboardStore.getState().setGraph(symbolGraph());
    useDashboardStore.getState().navigateToNodeInLayer("b1");
    seedContainerState();

    useDashboardStore.getState().navigateToNodeInLayer("classB");

    const state = useDashboardStore.getState();
    expect(state.selectedNodeId).toBe("classB");
    expect(state.activeLayerId).toBe("layer:b");
    expect(state.detailLevel).toBe("class");
    expect(state.showFunctionsInClassView).toBe(false);
    expectContainerStateCleared();
  });

  it("opens a method with function visibility, including within the same class view", () => {
    useDashboardStore.getState().setGraph(symbolGraph());
    useDashboardStore.getState().navigateToNodeInLayer("classB");
    seedContainerState();

    useDashboardStore.getState().navigateToNodeInLayer("methodB");

    const state = useDashboardStore.getState();
    expect(state.activeLayerId).toBe("layer:b");
    expect(state.detailLevel).toBe("class");
    expect(state.showFunctionsInClassView).toBe(true);
    expectContainerStateCleared();
  });

  it("leaves the chosen detail view unchanged for file navigation", () => {
    useDashboardStore.getState().setGraph(symbolGraph());
    useDashboardStore.getState().navigateToNodeInLayer("methodB");
    seedContainerState();

    useDashboardStore.getState().navigateToNodeInLayer("b1");

    const state = useDashboardStore.getState();
    expect(state.detailLevel).toBe("class");
    expect(state.showFunctionsInClassView).toBe(true);
    expect(state.containerLayoutCache.size).toBe(1);
    expect(state.expandedContainers.has("container:cluster-0")).toBe(true);
  });

  it.each(["goBackNode", "navigateToHistoryIndex"] as const)(
    "restores method visibility through %s after the user switches to files",
    (action) => {
      useDashboardStore.getState().setGraph(symbolGraph());
      useDashboardStore.getState().navigateToNodeInLayer("methodB");
      useDashboardStore.getState().navigateToNodeInLayer("a1");
      useDashboardStore.getState().setDetailLevel("file");
      seedContainerState();

      if (action === "goBackNode") useDashboardStore.getState().goBackNode();
      else useDashboardStore.getState().navigateToHistoryIndex(0);

      const state = useDashboardStore.getState();
      expect(state.selectedNodeId).toBe("methodB");
      expect(state.activeLayerId).toBe("layer:b");
      expect(state.detailLevel).toBe("class");
      expect(state.showFunctionsInClassView).toBe(true);
      expectContainerStateCleared();
    },
  );
});
