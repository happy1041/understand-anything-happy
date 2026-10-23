import type { KnowledgeGraph } from "@understand-anything/core/types";
export const graph: KnowledgeGraph = {
  version: "1.0.0", project: { name: "Mechanisms", description: "", languages: [], frameworks: [], analyzedAt: "2026-10-23T00:00:00Z", gitCommitHash: "test" },
  nodes: ["zipper", "snap", "velcro"].flatMap(id => ["asset", "model"].map(stage => ({
    id: `${id}-${stage}`, type: "document" as const, name: `${id} ${stage}`, summary: `${id} ${stage}`, tags: [], complexity: "simple" as const, filePath: `${id}/${stage}.md`,
  }))),
  edges: [
    { source: "zipper-asset", target: "zipper-model", type: "related", direction: "forward", weight: 1 },
    { source: "snap-asset", target: "snap-model", type: "related", direction: "forward", weight: 1 },
    { source: "zipper-model", target: "snap-model", type: "related", direction: "forward", weight: 1 },
  ],
  layers: ["zipper", "snap", "velcro"].map(id => ({ id, name: id, description: "", nodeIds: [`${id}-asset`, `${id}-model`] })),
  tour: ["zipper", "snap", "velcro"].flatMap((id, i) => ["asset", "model"].map((stage, j) => ({ order: i * 2 + j + 1, title: `${id} ${stage}`, description: "", nodeIds: [`${id}-${stage}`] }))),
};
export const config = { defaultGraphView: "zipper", graphViews: ["zipper", "velcro", "snap"].map(id => ({ id, label: id, nodeIds: [`${id}-asset`, `${id}-model`] })) };
