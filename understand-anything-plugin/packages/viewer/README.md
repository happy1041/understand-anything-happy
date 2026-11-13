# understand-anything-viewer

Standalone read-only viewer for [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) knowledge graphs. Opens the full interactive dashboard for a graph that was already generated with `/understand` — no Claude Code, no LLM, no API key. Only Node.js (>= 18) is required.

## Usage

Run the tarball attached to each GitHub release directly (no npm registry involved):

```bash
npx https://github.com/Egonex-AI/Understand-Anything/releases/latest/download/understand-anything-viewer.tgz /path/to/analyzed/project
```

The project directory (default: current directory) must contain a data directory — `.ua/` or legacy `.understand-anything/` — with a `knowledge-graph.json`. The terminal prints a tokenized URL (`http://127.0.0.1:<port>/?token=…`) and opens it in your browser.

Options: `--port <n>` (default 5173, auto-increments if taken), `--no-open`.

This maintained edition provides a source-install launcher at `skills/understand-dashboard/scripts/open-dashboard.mjs`, relative to the plugin root. Run it with a project directory and optional `--build` to refresh embedded assets. It builds missing assets with pnpm and forwards viewer options.

On the Demo page and artifact directory pages, file buttons submit authenticated same-origin POSTs to the local viewer, which runs `code --reuse-window -- <absolute-file-path>`. The `code` CLI opens the file in VS Code on the viewer host. Directories use dashboard navigation and inline media retain HTTP playback. Opening a video uses the installed VS Code preview support.

Everything is served read-only from local disk, bound to `127.0.0.1`, and gated behind a one-time access token — no data leaves your machine.

## Building the tarball (maintainers)

```bash
pnpm --filter understand-anything-viewer pack:release
gh release upload <tag> understand-anything-plugin/packages/viewer/understand-anything-viewer-*.tgz
```

The pack step builds the dashboard and embeds its compiled `dist/` into the package, producing a fully self-contained, zero-dependency tarball.

## Local artifact catalog controls

The Demo / 产物 page lets you select a version, move it earlier/later, or remove its display entry. Removed versions can be restored from the same page. These authenticated actions persist only `.ua/artifact-display.json` (or the active data directory equivalent); `artifacts.json` and output files are unchanged. Newly catalogued versions appear first.

Markdown nodes open directly in the existing reader; source-code nodes keep their information panel and optional code preview. The reader renders GFM and `$…$` / `$$…$$` math locally with KaTeX. Project-relative document, image and output links retain access authentication; external links never receive the token.

### Artifacts without a graph

For projects using only the native Demo portal, run `understand-anything-viewer /path/to/project --artifacts-only`. This requires `.ua/artifacts.json` (or the existing legacy data directory), not an empty knowledge graph. The same token/origin checks and separate `artifact-display.json` preferences apply. Markdown links open an escaped text preview in this mode.
