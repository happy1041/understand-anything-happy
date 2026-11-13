#!/usr/bin/env node
/**
 * understand-anything-viewer — serve a generated knowledge graph in the
 * dashboard UI with nothing but Node.js. No Claude Code, no LLM.
 * Graph/artifact contents are read-only; artifact display preferences are editable.
 *
 * Usage:
 *     understand-anything-viewer [project-dir] [--port <n>] [--no-open] [--artifacts-only]
 *
 * The project directory (default: cwd) must contain a data directory —
 * `.ua/` or legacy `.understand-anything/` — with a knowledge-graph.json
 * produced by /understand.
 *
 * Security model mirrors the dashboard dev server (vite.config.ts):
 *   - binds to 127.0.0.1 only
 *   - every data endpoint requires the one-time ?token= printed at startup
 *   - graph JSON is served with node filePaths relativised to the project
 *   - /file-content.json only serves files listed in the graph, capped at
 *     1 MB, never binary
 */
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGraphFreshnessBatch } from "./dist/staleness.js";

const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
// Legacy directory first — projects analyzed before the `.ua` rename keep
// their existing `.understand-anything/` data.
const UA_DIR_CANDIDATES = [".understand-anything", ".ua"];

// ── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let projectRoot = process.cwd();
let port = 5173;
let portExplicit = false;
let openBrowser = true;
let artifactsOnly = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--port") {
    port = Number(args[++i]);
    portExplicit = true;
    // 0 asks the OS for any free port.
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error("Error: --port must be an integer between 0 and 65535");
      process.exit(1);
    }
  } else if (a === "--artifacts-only") {
    artifactsOnly = true;
  } else if (a === "--no-open") {
    openBrowser = false;
  } else if (a === "--help" || a === "-h") {
    console.log("Usage: understand-anything-viewer [project-dir] [--port <n>] [--no-open] [--artifacts-only]");
    process.exit(0);
  } else if (!a.startsWith("-")) {
    projectRoot = path.resolve(a);
  } else {
    console.error(`Error: unknown option ${a}`);
    process.exit(1);
  }
}

if (!fs.existsSync(DIST_DIR)) {
  console.error(
    "Error: embedded dashboard build not found. This tarball was packed " +
    "without running the build — run `pnpm --filter understand-anything-viewer build` first.",
  );
  process.exit(1);
}

const graphDir = UA_DIR_CANDIDATES
  .map((d) => path.join(projectRoot, d))
  .find((d) => fs.existsSync(path.join(d, artifactsOnly ? "artifacts.json" : "knowledge-graph.json")));

if (!graphDir) {
  console.error(
    `Error: no ${artifactsOnly ? "artifact catalog" : "knowledge graph"} found under ${projectRoot}\n` +
    `Expected ${artifactsOnly ? ".ua/artifacts.json" : ".ua/knowledge-graph.json"} (or legacy .understand-anything/). ` +
    "Generate one with /understand first, or pass the project directory as an argument.",
  );
  process.exit(1);
}

const ACCESS_TOKEN = process.env.UNDERSTAND_ACCESS_TOKEN || crypto.randomBytes(16).toString("hex");

// ── Helpers (mirroring vite.config.ts) ────────────────────────────────────

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function normalizeGraphPath(filePath) {
  const rawPath = path.isAbsolute(filePath)
    ? filePath.startsWith(projectRoot)
      ? path.relative(projectRoot, filePath)
      : null
    : filePath;
  if (rawPath === null) return null;
  const normalized = path.normalize(rawPath);
  if (
    !normalized ||
    normalized === "." ||
    normalized.includes("\0") ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized.split(path.sep).join("/");
}

function graphFilePathSet() {
  const allowed = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(graphDir, "knowledge-graph.json"), "utf-8"));
    for (const node of raw.nodes ?? []) {
      if (typeof node.filePath !== "string") continue;
      const normalized = normalizeGraphPath(node.filePath);
      if (normalized) allowed.add(normalized);
    }
  } catch {
    return allowed;
  }
  return allowed;
}

function detectLanguage(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const byExt = {
    bash: "bash", c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css",
    go: "go", h: "c", hpp: "cpp", html: "markup", java: "java",
    js: "javascript", jsx: "jsx", json: "json", md: "markdown",
    mjs: "javascript", py: "python", rb: "ruby", rs: "rust", sh: "bash",
    ts: "typescript", tsx: "tsx", txt: "text", yaml: "yaml", yml: "yaml",
  };
  return byExt[ext] ?? "text";
}

function readSourceFile(url) {
  const reject = (message, statusCode = 400) => ({ statusCode, payload: { error: message } });
  const requestedPath = url.searchParams.get("path") ?? "";
  if (!requestedPath) return reject("Missing path");
  if (requestedPath.includes("\0")) return reject("Invalid path");
  if (path.isAbsolute(requestedPath)) return reject("Absolute paths are not allowed");

  const normalizedPath = path.normalize(requestedPath);
  if (
    normalizedPath === "." ||
    normalizedPath.startsWith(`..${path.sep}`) ||
    normalizedPath === ".." ||
    path.isAbsolute(normalizedPath)
  ) {
    return reject("Path must stay inside the project");
  }

  const absoluteFile = path.resolve(projectRoot, normalizedPath);
  const relativeToRoot = path.relative(projectRoot, absoluteFile);
  if (
    !relativeToRoot ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    relativeToRoot === ".." ||
    path.isAbsolute(relativeToRoot)
  ) {
    return reject("Path must stay inside the project");
  }
  const safeRelativePath = relativeToRoot.split(path.sep).join("/");
  if (!graphFilePathSet().has(safeRelativePath)) {
    return reject("File is not in the knowledge graph", 404);
  }

  let stat;
  try {
    stat = fs.statSync(absoluteFile);
  } catch {
    return reject("File not found", 404);
  }
  if (!stat.isFile()) return reject("Path is not a file");
  if (stat.size > MAX_SOURCE_FILE_BYTES) return reject("File is too large to preview", 413);

  const buffer = fs.readFileSync(absoluteFile);
  if (buffer.includes(0)) return reject("Binary files cannot be previewed", 415);

  const content = buffer.toString("utf8");
  return {
    statusCode: 200,
    payload: {
      path: safeRelativePath,
      language: detectLanguage(relativeToRoot),
      content,
      sizeBytes: buffer.byteLength,
      lineCount: content.length === 0 ? 0 : content.split(/\r\n|\n|\r/).length,
    },
  };
}

function serveGraphJson(res, fileName) {
  const candidate = path.join(graphDir, fileName);
  if (fs.existsSync(candidate)) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      // Sanitise absolute node filePaths so the developer's directory
      // layout is never sent to the browser.
      if (Array.isArray(raw.nodes)) {
        raw.nodes = raw.nodes.map((node) => {
          if (typeof node.filePath !== "string") return node;
          const abs = node.filePath;
          const rel = abs.startsWith(projectRoot)
            ? abs.slice(projectRoot.length).replace(/^[\\/]/, "")
            : path.isAbsolute(abs)
              ? path.basename(abs)
              : abs;
          return { ...node, filePath: rel };
        });
      }
      sendJson(res, 200, raw);
    } catch {
      sendJson(res, 500, { error: "Failed to read graph file" });
    }
    return;
  }
  if (fileName === "knowledge-graph.json") {
    sendJson(res, 404, { error: "No knowledge graph found. Run /understand first." });
  } else {
    res.statusCode = 404;
    res.end();
  }
}

function readGraphMetadata(fileName) {
  const graph = JSON.parse(
    fs.readFileSync(path.join(graphDir, fileName), "utf-8"),
  );
  return {
    graphCommitHash:
      typeof graph.project?.gitCommitHash === "string"
        ? graph.project.gitCommitHash
        : undefined,
    lastAnalyzedAt:
      typeof graph.project?.analyzedAt === "string"
        ? graph.project.analyzedAt
        : undefined,
  };
}

async function readGraphFreshness() {
  const knowledgeGraph = path.join(graphDir, "knowledge-graph.json");
  if (!fs.existsSync(knowledgeGraph)) {
    return {
      statusCode: 404,
      payload: { error: "No knowledge graph found. Run /understand first." },
    };
  }

  const domainGraph = path.join(graphDir, "domain-graph.json");
  let inputs;
  try {
    inputs = {
      knowledge: readGraphMetadata("knowledge-graph.json"),
      ...(fs.existsSync(domainGraph)
        ? { domain: readGraphMetadata("domain-graph.json") }
        : {}),
    };
  } catch {
    return {
      statusCode: 500,
      payload: { error: "Failed to read graph file" },
    };
  }

  return {
    statusCode: 200,
    payload: {
      graphs: await getGraphFreshnessBatch(projectRoot, inputs),
    },
  };
}

const CONTENT_TYPES = {
  ".css": "text/css", ".html": "text/html", ".ico": "image/x-icon",
  ".js": "text/javascript", ".json": "application/json", ".map": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain",
  ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2",
};

function serveStatic(res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const absolute = path.resolve(DIST_DIR, relative);
  if (absolute !== DIST_DIR && !absolute.startsWith(DIST_DIR + path.sep)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  if (path.extname(absolute).toLowerCase() === ".html") res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? "application/octet-stream");
  res.end(fs.readFileSync(absolute));
}

// Read-only project artifacts share the graph's token and process.
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const artifactHref = (p) => "/" + p.split("/").map(encodeURIComponent).join("/") + "?token=" + encodeURIComponent(ACCESS_TOKEN);
function artifactPathAllowed(relative) {
  const roots = ["outputs", "assets", "gpt-docs", "README.md", "AGENTS.md"];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(graphDir, "config.json"), "utf-8"));
    for (const root of config.artifactRoots ?? []) {
      if (typeof root !== "string" || !root || root.includes("\\") || root.includes("\0") ||
          root.split("/").some(p => !p || p === ".." || p.startsWith("."))) continue;
      roots.push(root);
    }
  } catch { /* Default single-project artifact roots remain available. */ }
  return roots.some(root => relative === root || relative.startsWith(root + "/")) || graphFilePathSet().has(relative);
}
function projectPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.startsWith(projectRoot + "/")) decoded = decoded.slice(projectRoot.length);
  const relative = decoded.replace(/^\/+/, "");
  if (!relative || relative.includes("\0") || relative.includes("\\") || relative.split("/").some(p => p === ".." || p.startsWith("."))) return null;
  const normalized = path.posix.normalize(relative).replace(/\/$/, "");
  if (!artifactPathAllowed(normalized)) return null;
  const absolute = path.resolve(projectRoot, normalized);
  try {
    const real = fs.realpathSync(absolute);
    if (!real.startsWith(fs.realpathSync(projectRoot) + path.sep)) return null;
    const target = path.relative(fs.realpathSync(projectRoot), real).split(path.sep).join("/");
    if (!artifactPathAllowed(target)) return null;
    // Don't expose hidden targets through symlinks.
    if (path.relative(fs.realpathSync(projectRoot), real).split(path.sep).some(p => p.startsWith("."))) return null;
    return { absolute, relative: normalized, stat: fs.statSync(real) };
  } catch { return null; }
}
function htmlPage(res, title, body) {
  // Browser form POSTs use Origin: null under no-referrer and then fail the
  // same-origin write guard. Preserve the origin locally without leaking
  // token-bearing referrers to other sites. Data responses stay no-referrer.
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
  res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px/1.6 system-ui;background:#111827;color:#e5e7eb;max-width:1200px;margin:32px auto;padding:0 24px}a{color:#93c5fd;overflow-wrap:anywhere}h1{font-size:26px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}article{background:#1f2937;padding:20px;border-radius:12px}video,img{max-width:100%;max-height:360px}small{color:#b5bfce}.versions{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0}.versions a,.badge{border:1px solid #475569;border-radius:8px;padding:6px 12px;text-decoration:none}.versions a[aria-current="page"]{background:#334155;border-color:#93c5fd;color:white}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:20px}.version{margin:32px 0 48px}.version h2{margin-bottom:4px}article h3{margin-top:8px}article .links{display:flex;flex-wrap:wrap;gap:12px}.badge{display:inline-block;font-size:12px;padding:2px 8px}button{font:inherit;background:#1f2937;color:#e5e7eb;border:1px solid #64748b;border-radius:6px;padding:5px 12px;cursor:pointer}button:disabled{opacity:.4;cursor:default}.manage{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.manage form{display:inline}.removed li{margin:8px 0}details{margin-top:14px}summary{cursor:pointer}img,video{display:block;width:100%;object-fit:contain;border-radius:6px}</style><nav>${artifactsOnly ? "" : `<a href="/?token=${encodeURIComponent(ACCESS_TOKEN)}">图谱</a> · `}<a href="/artifacts/?token=${encodeURIComponent(ACCESS_TOKEN)}">Demo / 产物</a></nav><h1>${escapeHtml(title)}</h1>${body}</html>`);
}
function fileClickLink(label, filePath) {
  const item = projectPath("/" + filePath);
  if (item?.stat.isFile()) {
    const action = `/artifacts/open-file?token=${encodeURIComponent(ACCESS_TOKEN)}&path=${encodeURIComponent(filePath)}`;
    return `<form method="post" action="${escapeHtml(action)}" style="display:inline"><button type="submit" style="color:#93c5fd;text-align:left;overflow-wrap:anywhere">${escapeHtml(label)}</button></form>`;
  }
  return `<a href="${escapeHtml(artifactHref(filePath))}">${escapeHtml(label)}</a>`;
}

function openProjectFile(req, res, url) {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    res.end();
    return;
  }
  if (url.searchParams.get("token") !== ACCESS_TOKEN ||
      req.headers.origin !== `http://${req.headers.host}`) {
    sendJson(res, 403, { error: "Invalid origin or token" });
    return;
  }
  const item = projectPath("/" + (url.searchParams.get("path") ?? ""));
  if (!item?.stat.isFile()) {
    sendJson(res, 404, { error: "Project file not found" });
    return;
  }
  const opener = spawn("code", ["--reuse-window", "--", item.absolute], {
    stdio: "ignore",
  });
  opener.once("error", () => {
    sendJson(res, 500, { error: "Could not start VS Code. Ensure the code command is on PATH." });
  });
  opener.once("exit", code => {
    if (code !== 0) {
      sendJson(res, 500, { error: "VS Code command failed", exitCode: code });
      return;
    }
    let back = `/artifacts/?token=${encodeURIComponent(ACCESS_TOKEN)}`;
    try {
      const ref = new URL(req.headers.referer);
      if (ref.origin === `http://${req.headers.host}` &&
          (ref.pathname.startsWith("/artifacts/") || projectPath(ref.pathname))) {
        back = ref.pathname + ref.search;
      }
    } catch { /* Direct requests return to the artifact catalog. */ }
    res.writeHead(303, { Location: back });
    res.end();
  });
}

function readArtifactCatalog() {
  // Only preserved output groups are switched. Code, graph and runtime stay current.
  const catalogPath = path.join(graphDir, "artifacts.json");
  let groups = [], items = [];
  if (fs.existsSync(catalogPath)) {
    try {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
      groups = catalog.groups; items = catalog.items;
      if (!Array.isArray(groups) || !Array.isArray(items)) throw new Error("Missing groups/items");
      const ids = new Set(groups.map(g => g.id));
      if (ids.size !== groups.length || groups.some(g => typeof g.id !== "string" || !/^[a-z0-9_-]+$/.test(g.id) || g.id === "all" || typeof g.name !== "string") ||
          items.some(n => !ids.has(n.group) || typeof n.filePath !== "string" || typeof n.name !== "string" || !n.artifactType ||
            (n.links !== undefined && (!Array.isArray(n.links) || n.links.some(l => typeof l.name !== "string" || typeof l.filePath !== "string")))))
        throw new Error("Invalid artifact groups");
    } catch {
      throw new Error("Failed to read artifact catalog");
    }
  }
  return { groups, items };
}
// Keep presentation changes separate from the evidence catalog, which experiments
// may update independently. New catalog versions appear before explicitly ordered ones.
const displayPath = path.join(graphDir, "artifact-display.json");
function readArtifactDisplay(groups) {
  const preferences = fs.existsSync(displayPath) ? JSON.parse(fs.readFileSync(displayPath, "utf8")) : {};
  if (["order", "hidden"].some(key => preferences[key] !== undefined &&
      (!Array.isArray(preferences[key]) || preferences[key].some(id => typeof id !== "string"))))
    throw new Error("Invalid artifact display preferences");
  const ids = groups.map(g => g.id);
  const order = [...new Set(preferences.order ?? [])].filter(id => ids.includes(id));
  const hidden = [...new Set(preferences.hidden ?? [])].filter(id => ids.includes(id));
  return { order: [...ids.filter(id => !order.includes(id)), ...order], hidden };
}
function editArtifactDisplay(req, res, url) {
  // A cookie alone must never authorize a write. Form actions carry the same
  // explicit capability token as the protected read links.
  if (url.searchParams.get("token") !== ACCESS_TOKEN ||
      (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) {
    sendJson(res, 403, { error: "Forbidden display update" }); return;
  }
  if (req.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded") {
    sendJson(res, 415, { error: "Expected form data" }); return;
  }
  let body = "", rejected = false;
  req.on("data", chunk => {
    if (rejected) return;
    body += chunk;
    if (Buffer.byteLength(body) > 4096) { rejected = true; sendJson(res, 413, { error: "Form too large" }); }
  });
  req.on("end", () => {
    if (rejected) return;
    try {
      const { groups } = readArtifactCatalog();
      const prefs = readArtifactDisplay(groups);
      const form = new URLSearchParams(body), group = form.get("group"), action = form.get("action");
      if (!groups.some(g => g.id === group) || !["hide", "restore", "up", "down"].includes(action)) {
        sendJson(res, 400, { error: "Unknown version or action" }); return;
      }
      const visible = prefs.order.filter(id => !prefs.hidden.includes(id));
      const at = visible.indexOf(group);
      let selected = group;
      if (action === "hide") {
        if (!prefs.hidden.includes(group)) prefs.hidden.push(group);
        selected = visible[at + 1] ?? visible[at - 1] ?? "all";
      } else if (action === "restore") {
        prefs.hidden = prefs.hidden.filter(id => id !== group);
      } else if (at !== -1) {
        const other = visible[at + (action === "up" ? -1 : 1)];
        if (other) {
          const i = prefs.order.indexOf(group), j = prefs.order.indexOf(other);
          [prefs.order[i], prefs.order[j]] = [prefs.order[j], prefs.order[i]];
        }
      }
      const temporary = `${displayPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...prefs }, null, 2) + "\n", { flag: "wx" });
        fs.renameSync(temporary, displayPath);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      res.writeHead(303, { Location: `/artifacts/?group=${encodeURIComponent(selected)}&token=${encodeURIComponent(ACCESS_TOKEN)}` });
      res.end();
    } catch { sendJson(res, 500, { error: "Failed to update artifact display preferences" }); }
  });
}
function serveArtifacts(res, url) {
  let catalog, prefs;
  try { catalog = readArtifactCatalog(); prefs = readArtifactDisplay(catalog.groups); }
  catch { sendJson(res, 500, { error: "Failed to read artifact catalog or display preferences" }); return; }
  const { items } = catalog;
  const groups = prefs.order.filter(id => !prefs.hidden.includes(id)).map(id => catalog.groups.find(g => g.id === id));
  const selected = url.searchParams.get("group") ?? groups[0]?.id ?? "all";
  if (selected !== "all" && !groups.some(g => g.id === selected)) {
    sendJson(res, 404, { error: "Unknown artifact group" }); return;
  }
  const groupHref = id => `/artifacts/?group=${encodeURIComponent(id)}&token=${encodeURIComponent(ACCESS_TOKEN)}`;
  const nav = [...groups, {id:"all", name:"全部版本"}].map(g =>
    `<a href="${escapeHtml(groupHref(g.id))}"${selected === g.id ? ' aria-current="page"' : ""}>${escapeHtml(g.name)}</a>`).join("");
  const displayForm = (id, action, label, disabled = false) => `<form method="post" action="/artifacts/display?token=${encodeURIComponent(ACCESS_TOKEN)}"><input type="hidden" name="group" value="${escapeHtml(id)}"><button name="action" value="${action}"${disabled ? " disabled" : ""}>${label}</button></form>`;
  const selectedIndex = groups.findIndex(g => g.id === selected);
  const controls = selectedIndex < 0 ? "" : `<div class="manage" aria-label="管理选定版本"><span>${escapeHtml(groups[selectedIndex].name)}</span>${displayForm(selected, "up", "前移", selectedIndex === 0)}${displayForm(selected, "down", "后移", selectedIndex === groups.length - 1)}${displayForm(selected, "hide", "从列表移除")}</div><small>仅调整展示入口，原始文件保留。</small>`;
  const removed = prefs.hidden.length ? `<details class="removed"><summary>已移除版本（${prefs.hidden.length}）</summary><ul>${prefs.hidden.map(id => `<li class="manage"><span>${escapeHtml(catalog.groups.find(g => g.id === id).name)}</span>${displayForm(id, "restore", "恢复")}</li>`).join("")}</ul></details>` : "";
  const link = (label, filePath) => projectPath("/" + filePath)
    ? fileClickLink(label, filePath)
    : `<small>${escapeHtml(label)}：文件不可用</small>`;
  const card = n => {
    const exists = projectPath("/" + n.filePath);
    const href = artifactHref(n.filePath);
    const preview = n.artifactPreview && projectPath("/" + n.artifactPreview) ? artifactHref(n.artifactPreview) : "";
    const media = !exists ? "" : n.artifactType === "video"
      ? `<video controls preload="none" src="${escapeHtml(href)}"${preview ? ` poster="${escapeHtml(preview)}"` : ""}></video>`
      : n.artifactType === "image" ? `<img loading="lazy" src="${escapeHtml(href)}" alt="${escapeHtml(n.name)}">`
      : preview ? `<img loading="lazy" src="${escapeHtml(preview)}" alt="${escapeHtml(n.name)}">` : "";
    const links = (n.links ?? []).map(l => link(l.name, l.filePath)).join("");
    return `<article>${n.status ? `<span class="badge">${escapeHtml(n.status)}</span>` : ""}<h3>${link(n.name, n.filePath)}</h3>${media}<p>${escapeHtml(n.summary ?? "")}</p><div class="links">${links}</div></article>`;
  };
  const sections = groups.filter(g => selected === "all" || g.id === selected).map(g =>
    `<section class="version"><header><small>${escapeHtml(g.date ?? "")}${g.status ? " · " + escapeHtml(g.status) : ""}</small><h2>${escapeHtml(g.name)}</h2><p>${escapeHtml(g.summary ?? "")}</p></header><div class="cards">${items.filter(n => n.group === g.id).map(card).join("")}</div></section>`).join("");
  htmlPage(res, "Demo / 产物", `<p>按模型版本查看已保存的演示与实验结果。每版保留代表演示、对照和完整记录。</p><nav class="versions" aria-label="产物版本">${nav}</nav>${controls}${removed}${sections || (prefs.hidden.length ? "<p>当前没有显示的版本，可在“已移除版本”中恢复。</p>" : "<p>尚无已登记的产物。</p>")}<details><summary>浏览原始文件</summary><p>${["outputs", "assets"].map(p => link(p, p + "/")).join(" · ")}</p></details>`);
}

function serveProject(req, res, item, url) {
  if (item.stat.isDirectory()) {
    const entries = fs.readdirSync(item.absolute, {withFileTypes:true}).filter(e => !e.name.startsWith(".")).sort((a,b) => a.name.localeCompare(b.name));
    htmlPage(res, item.relative + "/", `<ul>${entries.filter(e => projectPath("/" + item.relative + "/" + e.name)).map(e => `<li>${fileClickLink(e.name + (e.isDirectory() ? "/" : ""), item.relative + "/" + e.name + (e.isDirectory() ? "/" : ""))}</li>`).join("")}</ul>`);
    return;
  }
  if (path.extname(item.relative).toLowerCase() === ".md") {
    if (artifactsOnly) {
      if (item.stat.size > MAX_SOURCE_FILE_BYTES) { sendJson(res, 413, {error:"File too large to preview"}); return; }
      htmlPage(res, item.relative, `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(fs.readFileSync(item.absolute,"utf8"))}</pre>`); return;
    }
    res.writeHead(302, {Location: "/?document=" + encodeURIComponent(item.relative) + "&token=" + encodeURIComponent(ACCESS_TOKEN)}); res.end(); return;
  }
  const types = {...CONTENT_TYPES, ".mp4":"video/mp4", ".webm":"video/webm", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".csv":"text/csv; charset=utf-8", ".jsonl":"text/plain; charset=utf-8", ".log":"text/plain; charset=utf-8"};
  res.setHeader("Content-Type", types[path.extname(item.relative).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "bytes");
  let start = 0, end = item.stat.size - 1;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0,item.stat.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]),end) : end;
    } else start = -1;
    if (start < 0 || start >= item.stat.size || start > end) { res.writeHead(416, {"Content-Range": `bytes */${item.stat.size}`}); res.end(); return; }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${item.stat.size}`);
  }
  res.setHeader("Content-Length", Math.max(0,end-start+1));
  if (req.method === "HEAD" || !item.stat.size) { res.end(); return; }
  createReadStream(item.absolute, {start,end}).on("error", () => res.destroy()).pipe(res);
}

// ── Server ────────────────────────────────────────────────────────────────

const PROTECTED = new Set([
  "/knowledge-graph.json",
  "/domain-graph.json",
  "/diff-overlay.json",
  "/meta.json",
  "/config.json",
  "/file-content.json",
  "/staleness.json",
]);

const server = createServer((req, res) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === "/staleness.json") {
    res.setHeader("Cache-Control", "no-store");
  }

  const queryToken = url.searchParams.get("token");
  const cookieToken = (req.headers.cookie ?? "").split(";").map(c => c.trim()).find(c => c.startsWith("ua_access="))?.slice(10);
  const authenticated = queryToken !== null ? queryToken === ACCESS_TOKEN : cookieToken === ACCESS_TOKEN;
  if (queryToken === ACCESS_TOKEN) res.setHeader("Set-Cookie", `ua_access=${ACCESS_TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
  if (artifactsOnly && pathname === "/") {
    res.writeHead(302, {Location: "/artifacts/" + (authenticated ? "?token=" + encodeURIComponent(ACCESS_TOKEN) : "")}); res.end(); return;
  }
  const item = projectPath(pathname);
  const artifactRequest = pathname === "/artifacts/open-file" || pathname === "/artifacts/" || pathname === "/artifacts" || pathname === "/artifact-content.json" || pathname === "/artifacts/display" || item;
  if (!PROTECTED.has(pathname) && !artifactRequest) {
    serveStatic(res, pathname);
    return;
  }
  if (!authenticated) {
    sendJson(res, 403, { error: "Forbidden: missing or invalid token" });
    return;
  }
  if (pathname === "/artifacts/open-file") {
    res.setHeader("Cache-Control", "no-store");
    openProjectFile(req, res, url);
    return;
  }
  if (pathname === "/artifacts/display") {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return; }
    editArtifactDisplay(req, res, url); return;
  }
  if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); res.end(); return; }
  res.setHeader("Cache-Control", "no-store");
  if (pathname === "/artifacts/" || pathname === "/artifacts") { serveArtifacts(res, url); return; }
  if (pathname === "/artifact-content.json") {
    const source = projectPath("/" + (url.searchParams.get("path") ?? ""));
    if (!source || !source.stat.isFile()) { sendJson(res,404,{error:"File not found"}); return; }
    if (source.stat.size > MAX_SOURCE_FILE_BYTES) { sendJson(res,413,{error:"File is too large to preview"}); return; }
    const buffer = fs.readFileSync(source.absolute);
    if (buffer.includes(0)) { sendJson(res,415,{error:"Binary files cannot be previewed"}); return; }
    sendJson(res,200,{path:source.relative,content:buffer.toString("utf8"),language:detectLanguage(source.relative),sizeBytes:buffer.length,lineCount:buffer.toString("utf8").split("\n").length}); return;
  }
  if (item) { serveProject(req,res,item,url); return; }

  if (pathname === "/file-content.json") {
    const result = readSourceFile(url);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (pathname === "/staleness.json") {
    void readGraphFreshness()
      .then((result) => sendJson(res, result.statusCode, result.payload))
      .catch(() => {
        sendJson(res, 500, { error: "Failed to read graph freshness" });
      });
    return;
  }

  if (pathname === "/config.json") {
    const candidate = path.join(graphDir, "config.json");
    if (fs.existsSync(candidate)) {
      try {
        sendJson(res, 200, JSON.parse(fs.readFileSync(candidate, "utf-8")));
      } catch {
        sendJson(res, 500, { error: "Failed to read config file" });
      }
      return;
    }
    sendJson(res, 200, { autoUpdate: false, outputLanguage: "en" });
    return;
  }

  serveGraphJson(res, pathname.slice(1));
});

function listen(attemptPort, attemptsLeft) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && !portExplicit && attemptsLeft > 0) {
      listen(attemptPort + 1, attemptsLeft - 1);
    } else {
      console.error(`Error: could not bind 127.0.0.1:${attemptPort} — ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(attemptPort, "127.0.0.1", () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : attemptPort;
    const dashboardUrl = `http://127.0.0.1:${boundPort}/${artifactsOnly ? "artifacts/" : ""}?token=${ACCESS_TOKEN}`;
    console.log(`\n  Serving graph from ${graphDir}`);
    console.log(`  🔑  Dashboard URL: ${dashboardUrl}\n`);
    if (openBrowser) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [dashboardUrl], { shell: process.platform === "win32", stdio: "ignore", detached: true }).unref();
    }
  });
}

listen(port, 10);
