# Understand Anything — happy1041 edition

This repository publishes the locally maintained Understand Anything package used for document-led engineering projects. Upstream: [Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything). Original authorship and the MIT license are retained.

## Included changes

- Engineering skill guidance connecting mathematical mechanisms, implementation, experimental evidence and concise project documentation.
- Tour navigation fixes for cross-layer highlights, stale asynchronous layouts and redundant containers.
- Direct Markdown reading for document nodes, including mathematical formulas.
- Authenticated project artifact browsing and a separate versioned Demo portal; hide, restore and reorder entries without deleting outputs.
- Artifact-only browsing when no knowledge graph is needed.
- Configurable independent architecture tabs, each with scoped nodes, search and tours; switching resets obsolete navigation state.
- A portable dashboard launcher and Demo file buttons that invoke the local VS Code CLI through authenticated same-origin POSTs.

## Build from source

```bash
git clone https://github.com/happy1041/understand-anything-happy.git
cd understand-anything-happy
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

## Open a project dashboard

```bash
node understand-anything-plugin/skills/understand-dashboard/scripts/open-dashboard.mjs /path/to/project
```

Add `--artifacts-only` for a Demo catalog, `--no-open` to copy the printed access URL, or `--build` after changing dashboard source. The launcher builds missing viewer assets using pnpm. It runs in the foreground until Ctrl+C.

Demo file titles and directory-browser files open through `code --reuse-window -- <file>` on the viewer host. Ensure `code` is on that process's PATH. Directories remain browsable and inline media use HTTP. The dashboard skill maintains the launch and file-opening rules.

Use the upstream installation instructions below in README for your agent environment, substituting this repository URL when installing this edition. Build outputs and dependencies are generated locally, not committed. Project graphs, assets, experiment outputs and access credentials are not bundled.

Optional tabs are configured in a project's `.ua/config.json` using `graphViews` entries with `id`, `label`, `nodeIds` and optional `tourOrders`, plus `defaultGraphView`. The canonical graph remains `.ua/knowledge-graph.json`; no duplicate graph files are required. Demo entries use `.ua/artifacts.json`, and display preferences use `.ua/artifact-display.json`.

Validation at publication: the latest dashboard regression run passed 159 tests, including three scoped project views and tour navigation. This is not a claim that every upstream package test was rerun for publication.
