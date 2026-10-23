import { createElement, type PropsWithChildren } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graph, config } from "./fixtures/graphViews";
import { useDashboardStore } from "../store";

vi.mock("../components/GraphView", () => ({ default: () => null }));
vi.mock("../components/DomainGraphView", () => ({ default: () => null }));
vi.mock("../components/KnowledgeGraphView", () => ({ default: () => null }));
vi.mock("../components/SearchBar", () => ({ default: () => null }));
vi.mock("../components/NodeInfo", () => ({ default: () => null }));
vi.mock("../components/LayerLegend", () => ({ default: () => null }));
vi.mock("../components/DiffToggle", () => ({ default: () => null }));
vi.mock("../components/FilterPanel", () => ({ default: () => null }));
vi.mock("../components/ExportMenu", () => ({ default: () => null }));
vi.mock("../components/PersonaSelector", () => ({ default: () => null }));
vi.mock("../components/ProjectOverview", () => ({ default: () => null }));
vi.mock("../components/FileExplorer", () => ({ default: () => null }));
vi.mock("../components/WarningBanner", () => ({ default: () => null }));
vi.mock("../components/StalenessBanner", () => ({ default: () => null }));
vi.mock("../components/TokenGate", () => ({ default: () => null }));
vi.mock("../components/ThemePicker", () => ({ ThemePicker: () => null }));
vi.mock("../components/CodeViewer", () => ({ default: () => null }));
vi.mock("../components/LearnPanel", () => ({ default: () => null }));
vi.mock("../components/OnboardingOverlay", () => ({ default: ({ onDismiss }: { onDismiss: (remember: boolean) => void }) =>
  createElement("button", { id: "dismiss-intro", onClick: () => onDismiss(false) }, "dismiss") }));
const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("../hooks/useIsMobile", () => ({ useIsMobile: () => mobile.value }));
vi.mock("../hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: () => {} }));
vi.mock("../themes/index.ts", () => ({ ThemeProvider: ({ children }: PropsWithChildren) => children }));
vi.mock("../freshness", () => ({ shouldRequestFreshness: () => false }));
import { Dashboard } from "../App";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let renderer: ReactTestRenderer | undefined;
let configResponse: (value: unknown) => void;
let graphResponse: (value: unknown) => void;
let listeners: Map<string, () => void>;
let url: URL;
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
beforeEach(() => {
  mobile.value = false;
  url = new URL("http://localhost/?view=snap"); listeners = new Map();
  vi.stubGlobal("window", {
    get location() { return url; },
    localStorage: { getItem: () => "1" },
    history: { pushState: (_state: unknown, _title: unknown, next: string) => { url = new URL(next, url); } },
    addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
    removeEventListener: (event: string) => listeners.delete(event),
  });
  vi.stubGlobal("fetch", vi.fn((path: string) => {
    if (path.startsWith("/knowledge-graph")) return new Promise(resolve => { graphResponse = resolve; });
    if (path.startsWith("/config")) return new Promise(resolve => { configResponse = resolve; });
    if (path.startsWith("/diff-overlay")) return Promise.resolve(response({ changedNodeIds: ["snap-model", "zipper-asset"], affectedNodeIds: ["velcro-model"] }));
    return Promise.resolve(response(null, 404));
  }));
  useDashboardStore.setState(useDashboardStore.getInitialState(), true);
});
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.unstubAllGlobals(); });
async function mount() { await act(async () => { renderer = create(createElement(Dashboard, { accessToken: "test" })); }); }
async function resolveGraph() { await act(async () => graphResponse(response(graph))); }
async function resolveConfig(value: unknown = config, status = 200) { await act(async () => configResponse(response(value, status))); }
const ids = () => useDashboardStore.getState().graph?.nodes.map(n => n.id);

describe("view configuration and graph load lifecycle", () => {
  it("never indexes the mixed graph while configuration is delayed, then honors the view URL", async () => {
    await mount(); await resolveGraph();
    expect(useDashboardStore.getState().graph).toBeNull();
    await resolveConfig();
    expect(ids()).toEqual(["snap-asset", "snap-model"]);
    expect(renderer!.root.findAllByProps({ role: "tab" })).toHaveLength(3);
  });
  it("waits for a delayed graph and switches tabs / browser back without stale document or tour", async () => {
    await mount(); await resolveConfig();
    expect(useDashboardStore.getState().graph).toBeNull();
    await resolveGraph();
    await act(async () => { useDashboardStore.getState().startTour(); useDashboardStore.getState().navigateToNodeInLayer("snap-model"); });
    expect(useDashboardStore.getState().codeViewerNodeId).toBe("snap-model");
    await act(async () => renderer!.root.findByProps({ id: "view-tab-velcro" }).props.onClick());
    expect(ids()).toEqual(["velcro-asset", "velcro-model"]);
    expect(useDashboardStore.getState().changedNodeIds.size).toBe(0);
    expect(useDashboardStore.getState().codeViewerNodeId).toBeNull();
    expect(useDashboardStore.getState().tourActive).toBe(false);
    expect(url.searchParams.get("view")).toBe("velcro");
    await act(async () => { url = new URL("http://localhost/?view=snap"); listeners.get("popstate")!(); });
    expect(ids()).toEqual(["snap-asset", "snap-model"]);
    expect([...useDashboardStore.getState().changedNodeIds]).toEqual(["snap-model"]);
    await act(async () => useDashboardStore.getState().startTour());
    expect(useDashboardStore.getState().tourHighlightedNodeIds).toEqual(["snap-asset"]);
  });
  it("keeps a temporary onboarding dismissal across mechanism tabs", async () => {
    window.localStorage.getItem = () => null;
    await mount(); await resolveConfig(); await resolveGraph();
    await act(async () => renderer!.root.findByProps({ id: "dismiss-intro" }).props.onClick());
    await act(async () => renderer!.root.findByProps({ id: "view-tab-zipper" }).props.onClick());
    expect(renderer!.root.findAllByProps({ id: "dismiss-intro" })).toHaveLength(0);
  });
  it("preserves the active tour when browser history resolves to the same view", async () => {
    await mount(); await resolveConfig(); await resolveGraph();
    await act(async () => useDashboardStore.getState().startTour());
    await act(async () => listeners.get("popstate")!());
    expect(useDashboardStore.getState().tourActive).toBe(true);
    expect(useDashboardStore.getState().tourHighlightedNodeIds).toEqual(["snap-asset"]);
  });
  it("exposes the same view tabs on mobile and closes a document on switching", async () => {
    mobile.value = true;
    await mount(); await resolveConfig(); await resolveGraph();
    expect(renderer!.root.findAllByProps({ role: "tab" })).toHaveLength(3);
    await act(async () => useDashboardStore.getState().navigateToNodeInLayer("snap-model"));
    expect(useDashboardStore.getState().codeViewerOpen).toBe(true);
    await act(async () => renderer!.root.findByProps({ id: "view-tab-zipper" }).props.onClick());
    expect(ids()).toEqual(["zipper-asset", "zipper-model"]);
    expect(useDashboardStore.getState().codeViewerOpen).toBe(false);
    expect(renderer!.root.findByProps({ role: "tabpanel" }).props["aria-labelledby"]).toBe("view-tab-zipper");
  });
  it("preserves the original unsplit graph when optional config is absent", async () => {
    await mount(); await resolveConfig(null, 404); await resolveGraph();
    expect(ids()).toEqual(graph.nodes.map(n => n.id));
    expect(renderer!.root.findAllByProps({ role: "tab" })).toHaveLength(0);
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).startsWith("/domain-graph"))).toBe(true);
  });
  it("does not expose the master graph if configured references are invalid", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mount(); await resolveConfig({ graphViews: [{ id: "bad", label: "Bad", nodeIds: ["missing"] }] }); await resolveGraph();
      expect(useDashboardStore.getState().graph).toBeNull();
      expect(JSON.stringify(renderer!.toJSON())).toContain("Invalid graph view");
    } finally { error.mockRestore(); }
  });
});
