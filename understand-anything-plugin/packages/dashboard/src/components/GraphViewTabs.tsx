import type { GraphViewConfig } from "../graphViews";

export interface GraphViewTabsProps {
  graphViews: GraphViewConfig[];
  activeGraphView: string | null;
  onGraphViewChange: (id: string) => void;
}

export default function GraphViewTabs({ graphViews, activeGraphView, onGraphViewChange }: GraphViewTabsProps) {
  if (!graphViews.length) return null;
  return <nav aria-label="Architecture views" className="flex gap-2 px-3 sm:px-5 py-2 bg-surface border-b border-border-subtle shrink-0 overflow-x-auto">
    <div role="tablist" aria-label="Architecture views" className="flex gap-2">
      {graphViews.map((view, index) => <button key={view.id} id={`view-tab-${view.id}`} type="button" role="tab"
        aria-selected={activeGraphView === view.id} aria-controls="graph-view-panel"
        tabIndex={activeGraphView === view.id ? 0 : -1}
        onClick={() => onGraphViewChange(view.id)}
        onKeyDown={event => {
          let target: number | undefined;
          if (event.key === "ArrowRight") target = (index + 1) % graphViews.length;
          if (event.key === "ArrowLeft") target = (index - 1 + graphViews.length) % graphViews.length;
          if (event.key === "Home") target = 0;
          if (event.key === "End") target = graphViews.length - 1;
          if (target !== undefined) {
            event.preventDefault(); event.stopPropagation();
            onGraphViewChange(graphViews[target].id);
            requestAnimationFrame(() => document.getElementById(`view-tab-${graphViews[target!].id}`)?.focus());
          }
        }}
        className={`px-5 py-2 rounded-lg text-sm font-semibold whitespace-nowrap transition-colors ${activeGraphView === view.id ? "bg-accent/20 text-accent ring-1 ring-accent/40" : "text-text-muted hover:bg-elevated hover:text-text-primary"}`}>
        {view.label}
      </button>)}
    </div>
  </nav>;
}
