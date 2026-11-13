---
name: understand-dashboard
description: Launch the local knowledge-graph and Demo dashboard, with artifact files opening in VS Code through the local viewer service.
metadata:
  argument-hint: "[project-path]"
---

# /understand-dashboard

Use this installed edition's viewer to browse an existing project graph or artifact catalog. For engineering project maintenance, also read [../understand/engineering/guide.md](../understand/engineering/guide.md). Preserve the upstream graph schema and analysis/update workflow.

## Launch

Resolve this skill's real directory, including symlinked installations. Its `scripts/open-dashboard.mjs` locates the matching plugin and viewer relative to itself.

```bash
node "<skill-directory>/scripts/open-dashboard.mjs" "/absolute/project/path"
```

The project defaults to the invoking working directory. Node.js 18 or later runs a built viewer. A source installation needs `pnpm install --frozen-lockfile` in the repository before its first build. The launcher builds a missing embedded viewer automatically. After dashboard source changes, add `--build` to refresh it.

- For graph browsing, require `knowledge-graph.json` in `.ua/` or legacy `.understand-anything/`. Generate missing analysis through `/understand`.
- For Demo browsing with an existing `artifacts.json`, add `--artifacts-only`. This mode supports a project containing only the artifact catalog.
- The viewer prefers the legacy directory when it contains the requested data file, then checks `.ua/`.
- `--no-open` prints the URL for manual opening. `--port 0` selects an available port. The default port is 5173 and increments when occupied.
- Run in a persistent terminal or background process when the user needs continued access. Capture and return the full printed `Dashboard URL`, including its `?token=` parameter. Tokens belong in runtime output.
- The process runs until stopped with Ctrl+C. Use the maintained local viewer for this edition's file-opening behavior.

## Demo files open in VS Code

Apply this behavior to Demo card file titles, related-file buttons and files in the artifact directory browser, including documents, models, data and videos.

1. A file button submits a same-origin POST to `/artifacts/open-file`, carrying the access token and project-relative file path.
2. The local viewer validates the token, exact Origin, allowed artifact roots and resolved project containment, then invokes `code --reuse-window -- <absolute-file-path>` with an argument array.
3. A successful command returns the user to the catalog or directory page. Failed commands display an actionable error.

The `code` executable must be available on the viewer process's PATH. It opens files in the VS Code environment on the machine running the viewer. For Remote SSH, verify the CLI is attached to the intended remote VS Code session. Browser location alone does not select the editor host.

Directories navigate inside the dashboard. Inline image/video sources retain authenticated HTTP URLs. Video opening uses VS Code's installed preview capabilities. The graph's Markdown reader and code preview retain their existing navigation behavior.

When extending the viewer, preserve file-button POSTs, shell-free argument passing and existing project-path checks. The implementation is maintained in `packages/viewer/bin/viewer.mjs`. Project catalogs store relative file paths. Additional artifact directories are configured through `artifactRoots` in the active data directory's `config.json`.

## Verification

Check the launcher's help and a real startup. For file-opening changes, verify a same-origin POST invokes the CLI with the exact file path and returns 303. Also check missing/invalid tokens, foreign or null Origin, directories, traversal and escaping symlinks. A CLI exit code confirms command dispatch. Verify the editor view or video playback separately when requested.

## Demo display controls

The Demo portal saves ordering and hidden groups in `artifact-display.json`, separately from the `artifacts.json` catalog. Preserve existing preferences during updates. Moving, hiding and restoring groups changes their display entries.

Exercise display forms with the page's actual same-origin Origin, follow the 303 response and reload to verify persistence. Preserve `Referrer-Policy: same-origin` on HTML pages so browser POSTs carry the local Origin. Data responses use `no-referrer`. After viewer fixes, check the running service's binary and restart the affected service when needed.
