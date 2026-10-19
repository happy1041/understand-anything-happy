import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@understand-anything/core/types";
import { I18nProvider } from "../../contexts/I18nContext";
import { useDashboardStore } from "../../store";
import LearnPanel from "../LearnPanel";

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useDashboardStore.setState(useDashboardStore.getInitialState(), true);
});

describe("tour referenced component navigation", () => {
  it("moves a cross-layer method pill to its layer and enables its visible detail view", async () => {
    const graph: KnowledgeGraph = {
      version: "1.0.0",
      project: {
        name: "fixture", languages: [], frameworks: [], description: "",
        analyzedAt: "2026-10-19T00:00:00.000Z", gitCommitHash: "test",
      },
      nodes: [
        { id: "fileA", type: "file", name: "A", summary: "", tags: [], complexity: "simple" },
        { id: "fileB", type: "file", name: "B", summary: "", tags: [], complexity: "simple" },
        { id: "classB", type: "class", name: "Coupler", summary: "", tags: [], complexity: "simple" },
        { id: "methodB", type: "function", name: "Coupler.add_mechanism", summary: "", tags: [], complexity: "simple" },
      ],
      edges: [
        { source: "fileB", target: "classB", type: "contains", direction: "forward", weight: 1 },
        { source: "classB", target: "methodB", type: "contains", direction: "forward", weight: 1 },
      ],
      layers: [
        { id: "layer:a", name: "A", description: "", nodeIds: ["fileA"] },
        { id: "layer:b", name: "B", description: "", nodeIds: ["fileB"] },
      ],
      tour: [{ order: 1, title: "Cross-layer references", description: "", nodeIds: ["fileA", "methodB"] }],
    };
    useDashboardStore.getState().setGraph(graph);
    useDashboardStore.getState().startTour();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(I18nProvider, { language: "en", children: createElement(LearnPanel) }));
    });
    if (!renderer) throw new Error("LearnPanel did not mount");
    try {
      const pill = renderer.root.findAllByType("button")
        .find(button => button.children.join("") === "Coupler.add_mechanism");
      expect(pill).toBeDefined();
      await act(async () => { pill!.props.onClick(); });
      expect(useDashboardStore.getState()).toMatchObject({
        selectedNodeId: "methodB",
        activeLayerId: "layer:b",
        detailLevel: "class",
        showFunctionsInClassView: true,
      });
    } finally {
      await act(async () => { renderer!.unmount(); });
    }
  });
});
