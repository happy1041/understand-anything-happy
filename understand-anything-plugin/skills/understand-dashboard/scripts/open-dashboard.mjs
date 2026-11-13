#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const pluginRoot = fileURLToPath(new URL("../../../", import.meta.url));
const viewerRoot = join(pluginRoot, "packages", "viewer");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node open-dashboard.mjs [project-dir] [--build] [--port <n>] [--no-open] [--artifacts-only]

Open this installation's dashboard for an existing project graph.
The project defaults to the current working directory.
--build rebuilds the embedded viewer from the current source.
A missing viewer build is built automatically with pnpm.
Install source dependencies first with pnpm install --frozen-lockfile.
The foreground server prints its access URL and stops with Ctrl+C.`);
  process.exit(0);
}

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit" });
  if (result.error) {
    console.error(`Cannot run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const hasBuild = existsSync(join(viewerRoot, "dist", "index.html")) &&
  existsSync(join(viewerRoot, "bin", "dist", "staleness.js"));
if (args.includes("--build") || !hasBuild) {
  run(process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["--filter", "understand-anything-viewer", "build"], pluginRoot);
}

run(process.execPath,
  [join(viewerRoot, "bin", "viewer.mjs"), ...args.filter(arg => arg !== "--build")],
  process.cwd());
