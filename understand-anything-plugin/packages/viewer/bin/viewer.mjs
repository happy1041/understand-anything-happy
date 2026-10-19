#!/usr/bin/env node
/**
 * understand-anything-viewer — serve a generated knowledge graph in the
 * dashboard UI with nothing but Node.js. Read-only, no Claude Code, no LLM.
 *
 * Usage:
 *     understand-anything-viewer [project-dir] [--port <n>] [--no-open]
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
  } else if (a === "--no-open") {
    openBrowser = false;
  } else if (a === "--help" || a === "-h") {
    console.log("Usage: understand-anything-viewer [project-dir] [--port <n>] [--no-open]");
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
  .find((d) => fs.existsSync(path.join(d, "knowledge-graph.json")));

if (!graphDir) {
  console.error(
    `Error: no knowledge graph found under ${projectRoot}\n` +
    "Expected .ua/knowledge-graph.json (or legacy .understand-anything/). " +
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
  res.setHeader("Content-Type", CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? "application/octet-stream");
  res.end(fs.readFileSync(absolute));
}

// Read-only project artifacts share the graph's token and process.
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const artifactHref = (p) => "/" + p.split("/").map(encodeURIComponent).join("/") + "?token=" + encodeURIComponent(ACCESS_TOKEN);
function projectPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.startsWith(projectRoot + "/")) decoded = decoded.slice(projectRoot.length);
  const relative = decoded.replace(/^\/+/, "");
  if (!relative || relative.includes("\0") || relative.includes("\\") || relative.split("/").some(p => p === ".." || p.startsWith("."))) return null;
  const normalized = path.posix.normalize(relative).replace(/\/$/, "");
  if (!/^(outputs|assets|gpt-docs)(\/|$)/.test(normalized) && !["README.md", "AGENTS.md"].includes(normalized) && !graphFilePathSet().has(normalized)) return null;
  const absolute = path.resolve(projectRoot, normalized);
  try {
    const real = fs.realpathSync(absolute);
    if (!real.startsWith(fs.realpathSync(projectRoot) + path.sep)) return null;
    const target = path.relative(fs.realpathSync(projectRoot), real).split(path.sep).join("/");
    if (!/^(outputs|assets|gpt-docs)(\/|$)/.test(target) && !["README.md", "AGENTS.md"].includes(target) && !graphFilePathSet().has(target)) return null;
    // Don't expose hidden targets through symlinks.
    if (path.relative(fs.realpathSync(projectRoot), real).split(path.sep).some(p => p.startsWith("."))) return null;
    return { absolute, relative: normalized, stat: fs.statSync(real) };
  } catch { return null; }
}
function htmlPage(res, title, body) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; object-src 'none'; base-uri 'none'");
  res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:16px/1.6 system-ui;background:#111827;color:#e5e7eb;max-width:1200px;margin:32px auto;padding:0 24px}a{color:#93c5fd;overflow-wrap:anywhere}h1{font-size:26px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}article{background:#1f2937;padding:20px;border-radius:12px}video,img{max-width:100%;max-height:360px}small{color:#b5bfce}</style><nav><a href="/?token=${encodeURIComponent(ACCESS_TOKEN)}">图谱</a> · <a href="/artifacts/?token=${encodeURIComponent(ACCESS_TOKEN)}">Demo / 产物</a></nav><h1>${escapeHtml(title)}</h1>${body}</html>`);
}
function serveArtifacts(res) {
  // Artifacts are an independent catalog, not architecture graph nodes.
  const catalogPath = path.join(graphDir, "artifacts.json");
  let items = [];
  if (fs.existsSync(catalogPath)) {
    try {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
      if (!Array.isArray(catalog.items)) throw new Error("Missing items");
      items = catalog.items;
    } catch {
      sendJson(res, 500, { error: "Failed to read artifact catalog" });
      return;
    }
  }
  const cards = items.filter(n => typeof n.filePath === "string" && typeof n.name === "string" && n.artifactType).map(n => {
    const href = artifactHref(normalizeGraphPath(n.filePath) ?? "");
    const preview = n.artifactPreview ? artifactHref(n.artifactPreview) : "";
    const media = n.artifactType === "video" ? `<video controls preload="metadata" src="${escapeHtml(href)}"${preview ? ` poster="${escapeHtml(preview)}"` : ""}></video>` : n.artifactType === "image" ? `<img loading="lazy" src="${escapeHtml(href)}" alt="${escapeHtml(n.name)}">` : preview ? `<img loading="lazy" src="${escapeHtml(preview)}" alt="${escapeHtml(n.name)}">` : "";
    return `<article><h2><a href="${escapeHtml(href)}">${escapeHtml(n.name)}</a></h2>${media}<p>${escapeHtml(n.summary ?? "")}</p><small>${escapeHtml(n.filePath)}</small></article>`;
  }).join("");
  htmlPage(res, "Demo / 产物", `<p>原速视频、资产与实验记录。各项说明标明验证范围，完整配置和日志见批次索引。</p><p>${["outputs", "assets", "gpt-docs"].map(p => `<a href="${artifactHref(p + "/")}">${p}</a>`).join(" · ")}</p><main>${cards}</main>`);
}
function serveProject(req, res, item, url) {
  if (item.stat.isDirectory()) {
    const entries = fs.readdirSync(item.absolute, {withFileTypes:true}).filter(e => !e.name.startsWith(".")).sort((a,b) => a.name.localeCompare(b.name));
    htmlPage(res, item.relative + "/", `<ul>${entries.filter(e => projectPath("/" + item.relative + "/" + e.name)).map(e => `<li><a href="${escapeHtml(artifactHref(item.relative + "/" + e.name + (e.isDirectory() ? "/" : "")))}">${escapeHtml(e.name)}${e.isDirectory() ? "/" : ""}</a></li>`).join("")}</ul>`);
    return;
  }
  if (path.extname(item.relative).toLowerCase() === ".md") {
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
  const item = projectPath(pathname);
  const artifactRequest = pathname === "/artifacts/" || pathname === "/artifacts" || pathname === "/artifact-content.json" || item;
  if (!PROTECTED.has(pathname) && !artifactRequest) {
    serveStatic(res, pathname);
    return;
  }
  if (!authenticated) {
    sendJson(res, 403, { error: "Forbidden: missing or invalid token" });
    return;
  }
  if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); res.end(); return; }
  res.setHeader("Cache-Control", "no-store");
  if (pathname === "/artifacts/" || pathname === "/artifacts") { serveArtifacts(res); return; }
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
    const dashboardUrl = `http://127.0.0.1:${boundPort}/?token=${ACCESS_TOKEN}`;
    console.log(`\n  Serving graph from ${graphDir}`);
    console.log(`  🔑  Dashboard URL: ${dashboardUrl}\n`);
    if (openBrowser) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      spawn(opener, [dashboardUrl], { shell: process.platform === "win32", stdio: "ignore", detached: true }).unref();
    }
  });
}

listen(port, 10);
