import type { KnowledgeGraph } from "@understand-anything/core/types";

/** Optional presentation scopes in config.json; the canonical graph stays unchanged. */
export interface GraphViewConfig {
  id: string;
  label: string;
  nodeIds: string[];
  tourOrders?: number[];
}

export function readGraphViews(config: unknown, graph: KnowledgeGraph): GraphViewConfig[] {
  if (!config || typeof config !== "object" || !("graphViews" in config)) return [];
  if (!Array.isArray(config.graphViews)) throw new Error("config.graphViews must be an array");
  const known = new Set(graph.nodes.map(node => node.id));
  const ids = new Set<string>();
  return config.graphViews.map((view: GraphViewConfig) => {
    if (!view || typeof view.id !== "string" || !/^[a-z0-9_-]+$/i.test(view.id) ||
        ids.has(view.id) || typeof view.label !== "string" || !view.label.trim() ||
        !Array.isArray(view.nodeIds) || !view.nodeIds.length ||
        view.nodeIds.some(id => typeof id !== "string" || !known.has(id)) ||
        (view.tourOrders !== undefined && (!Array.isArray(view.tourOrders) ||
          view.tourOrders.some(order => !Number.isInteger(order) || !graph.tour.some(step => step.order === order))))) {
      throw new Error("Invalid graph view: each view needs a unique id, label and existing node/tour references");
    }
    ids.add(view.id);
    return { id: view.id, label: view.label, nodeIds: [...new Set(view.nodeIds)],
      ...(view.tourOrders !== undefined ? { tourOrders: view.tourOrders } : {}) };
  });
}

export function resolveGraphView(views: GraphViewConfig[], requested: string | null, preferred?: string): GraphViewConfig | undefined {
  return views.find(view => view.id === requested) ?? views.find(view => view.id === preferred) ?? views[0];
}

/** Filter before indexing/search/layout, not merely hiding nodes on the canvas. */
export function scopeGraph(graph: KnowledgeGraph, view?: GraphViewConfig): KnowledgeGraph {
  if (!view) return graph;
  const ids = new Set(view.nodeIds);
  const orders = view.tourOrders === undefined ? null : new Set(view.tourOrders);
  return {
    ...graph,
    project: { ...graph.project, name: `${graph.project.name} · ${view.label}` },
    nodes: graph.nodes.filter(node => ids.has(node.id)),
    edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)),
    layers: graph.layers.map(layer => ({ ...layer, nodeIds: layer.nodeIds.filter(id => ids.has(id)) }))
      .filter(layer => layer.nodeIds.length),
    tour: graph.tour.filter(step => (!orders || orders.has(step.order)) &&
        step.nodeIds.length > 0 && step.nodeIds.every(id => ids.has(id)))
      .sort((a, b) => a.order - b.order).map((step, index) => ({ ...step, order: index + 1 })),
  };
}
