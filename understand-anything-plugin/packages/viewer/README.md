# understand-anything-viewer

Standalone read-only viewer for [Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) knowledge graphs. Opens the full interactive dashboard for a graph that was already generated with `/understand` — no Claude Code, no LLM, no API key. Only Node.js (>= 18) is required.

## Usage

Run the tarball attached to each GitHub release directly (no npm registry involved):

```bash
npx https://github.com/Egonex-AI/Understand-Anything/releases/latest/download/understand-anything-viewer.tgz /path/to/analyzed/project
```

The project directory (default: current directory) must contain a data directory — `.ua/` or legacy `.understand-anything/` — with a `knowledge-graph.json`. The terminal prints a tokenized URL (`http://127.0.0.1:<port>/?token=…`) and opens it in your browser.

Options: `--port <n>` (default 5173, auto-increments if taken), `--no-open`.

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
