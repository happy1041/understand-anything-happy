// End-to-end tests for the standalone viewer (packages/viewer/bin/viewer.mjs).
// Spawns the real server against a fixture project and exercises the token
// gate, graph sanitisation, file-content allowlist, and .ua/legacy resolution.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VIEWER_BIN = join(
  REPO_ROOT,
  "understand-anything-plugin",
  "packages",
  "viewer",
  "bin",
  "viewer.mjs",
);
const VIEWER_DIST = join(REPO_ROOT, "understand-anything-plugin", "packages", "viewer", "dist");

function fixtureGraph(gitCommitHash) {
  return {
    version: "1.0.0",
    project: {
      name: "fixture", languages: ["ts"], frameworks: [], description: "d",
      analyzedAt: "2026-07-17T00:00:00.000Z", gitCommitHash,
    },
    nodes: [
      {
        id: "file:src/a.ts", type: "file", name: "a.ts", filePath: "src/a.ts",
        summary: "s", tags: [], complexity: "simple",
      },
    ],
    edges: [],
    layers: [],
    tour: [],
  };
}

function git(projectRoot, ...args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
}

function setupProject(dataDirName) {
  const root = mkdtempSync(join(tmpdir(), "ua-viewer-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "secret.txt"), "not in graph\n");
  git(root, "init");
  git(root, "config", "user.email", "viewer-tests@example.com");
  git(root, "config", "user.name", "Viewer Tests");
  git(root, "add", "--all");
  git(root, "commit", "-m", "baseline");

  const dataDir = join(root, dataDirName);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "knowledge-graph.json"),
    JSON.stringify(fixtureGraph(git(root, "rev-parse", "HEAD"))),
  );
  return root;
}

/** Start the viewer and wait for the printed URL. Returns { proc, url, token, port }. */
function startViewer(projectRoot) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(
      process.execPath,
      [VIEWER_BIN, projectRoot, "--no-open", "--port", "0"],
      { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      proc.kill();
      rejectPromise(new Error(`viewer did not start.\n${out}`));
    }, 10_000);
    const onData = (chunk) => {
      out += String(chunk);
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]+)/);
      if (m) {
        clearTimeout(timer);
        resolvePromise({ proc, url: m[0], port: Number(m[1]), token: m[2] });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`viewer exited with ${code}.\n${out}`));
    });
  });
}

describe.skipIf(!existsSync(VIEWER_DIST))("understand-anything-viewer", () => {
  let root;
  let viewer;

  beforeAll(async () => {
    root = setupProject(".ua");
    viewer = await startViewer(root);
  }, 15_000);

  afterAll(() => {
    viewer?.proc.kill();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${viewer.port}`;

  it("serves the embedded dashboard index", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("rejects data requests without the token", async () => {
    const res = await fetch(`${base()}/knowledge-graph.json`);
    expect(res.status).toBe(403);
  });

  it("serves the graph from .ua/ with a valid token", async () => {
    const res = await fetch(`${base()}/knowledge-graph.json?token=${viewer.token}`);
    expect(res.status).toBe(200);
    const graph = await res.json();
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].filePath).toBe("src/a.ts");
  });

  it("serves a protected no-store freshness report", async () => {
    const denied = await fetch(`${base()}/staleness.json`);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");

    const res = await fetch(
      `${base()}/staleness.json?token=${viewer.token}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      graphs: {
        knowledge: {
          status: "fresh",
          graphCommitHash: git(root, "rev-parse", "HEAD"),
          headCommitHash: git(root, "rev-parse", "HEAD"),
        },
      },
    });
  });

  it("serves file content only for files listed in the graph", async () => {
    const ok = await fetch(
      `${base()}/file-content.json?token=${viewer.token}&path=${encodeURIComponent("src/a.ts")}`,
    );
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.content).toContain("export const a");
    expect(body.language).toBe("typescript");

    const denied = await fetch(
      `${base()}/file-content.json?token=${viewer.token}&path=secret.txt`,
    );
    expect(denied.status).toBe(404);
  });

  it("rejects path traversal in file-content", async () => {
    const res = await fetch(
      `${base()}/file-content.json?token=${viewer.token}&path=${encodeURIComponent("../outside.txt")}`,
    );
    expect(res.status).toBe(400);
  });

  it("blocks static requests escaping dist/", async () => {
    const res = await fetch(`${base()}/%2e%2e/package.json`);
    expect([403, 404]).toContain(res.status);
  });

  it("serves project artifacts with authenticated navigation, ranges and containment", async () => {
    mkdirSync(join(root, "outputs", "demo"), {recursive:true});
    writeFileSync(join(root,"outputs/demo/data.json"), '{"ok":true}');
    writeFileSync(join(root,"outputs/demo/hero.mp4"), "0123456789");
    writeFileSync(join(root,"outputs/demo/INDEX.md"), "# Demo\n[video](hero.mp4)");
    symlinkSync(join(root,"secret.txt"),join(root,"outputs/demo/escape.txt"));
    symlinkSync(join(root,".ua/knowledge-graph.json"),join(root,"outputs/demo/hidden.json"));
    expect((await fetch(`${base()}/outputs/demo/data.json`)).status).toBe(403);
    const login = await fetch(`${base()}/?token=${viewer.token}`);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    expect(cookie).toContain("ua_access=");
    const result = await fetch(`${base()}/outputs/demo/data.json`,{headers:{cookie}});
    expect(await result.json()).toEqual({ok:true});
    expect((await fetch(`${base()}/outputs/demo/?token=${viewer.token}`)).status).toBe(200);
    expect(await (await fetch(`${base()}/outputs/demo/?token=${viewer.token}`)).text()).toContain("hero.mp4?token=");
    const video = await fetch(`${base()}/outputs/demo/hero.mp4?token=${viewer.token}`,{headers:{Range:"bytes=2-5"}});
    expect(video.status).toBe(206); expect(video.headers.get("content-type")).toBe("video/mp4");
    expect(video.headers.get("content-range")).toBe("bytes 2-5/10"); expect(await video.text()).toBe("2345");
    expect((await fetch(`${base()}/outputs/demo/hero.mp4?token=${viewer.token}`,{headers:{Range:"bytes=20-"}})).status).toBe(416);
    const head = await fetch(`${base()}/outputs/demo/hero.mp4?token=${viewer.token}`,{method:"HEAD"});
    expect(head.headers.get("content-length")).toBe("10"); expect(await head.text()).toBe("");
    const report = await fetch(`${base()}/outputs/demo/INDEX.md?token=${viewer.token}`,{redirect:"manual"});
    expect(report.status).toBe(302); expect(report.headers.get("location")).toContain("document=outputs%2Fdemo%2FINDEX.md");
    const content = await fetch(`${base()}/artifact-content.json?path=outputs/demo/INDEX.md&token=${viewer.token}`);
    expect((await content.json()).content).toContain("# Demo");
    for (const route of ["outputs/demo/escape.txt", "outputs/demo/hidden.json", "outputs/%2e%2e%2fsecret.txt", "secret.txt"])
      expect((await fetch(`${base()}/${route}?token=${viewer.token}`)).status).toBe(404);
    expect((await fetch(`${base()}/outputs/demo/data.json?token=wrong`,{headers:{cookie}})).status).toBe(403);
    const portal = await fetch(`${base()}/artifacts/?token=${viewer.token}`);
    expect(await portal.text()).toContain("Demo / 产物");
  });

  it("keeps demo catalog independent from code graph", async () => {
    const catalog = join(root, ".ua", "artifacts.json");
    writeFileSync(catalog, JSON.stringify({version:1,
      groups:[{id:"current",name:"Current model"},{id:"previous",name:"Previous model"}],
      items:[{
        group:"current",name:"Catalog-only demo",filePath:"outputs/demo/hero.mp4",artifactType:"video",
        summary:"Independent result",links:[{name:"Force record",filePath:"outputs/demo/data.json"}]
      },{group:"previous",name:"Old demo",filePath:"outputs/demo/INDEX.md",artifactType:"report",
         status:"Failed <example>",summary:"Preserved comparison"}
    ]}));
    const portal = await fetch(`${base()}/artifacts/?token=${viewer.token}`);
    const html = await portal.text();
    expect(html).toContain("Catalog-only demo");
    expect(html).toContain("<video controls");
    expect(html).toContain('preload="none"');
    expect(html).toContain("Force record");
    expect(html).not.toContain("Old demo");
    const historical = await (await fetch(`${base()}/artifacts/?token=${viewer.token}&group=previous`)).text();
    expect(historical).toContain("Old demo");
    expect(historical).toContain("Failed &lt;example&gt;");
    expect(historical).not.toContain("Catalog-only demo");
    const all = await (await fetch(`${base()}/artifacts/?token=${viewer.token}&group=all`)).text();
    expect(all).toContain("Old demo"); expect(all).toContain("Catalog-only demo");
    expect((await fetch(`${base()}/artifacts/?token=${viewer.token}&group=unknown`)).status).toBe(404);
    expect((await fetch(`${base()}/artifacts/?group=previous`)).status).toBe(403);
    const graph = await (await fetch(`${base()}/knowledge-graph.json?token=${viewer.token}`)).json();
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].type).toBe("file");
    writeFileSync(catalog, "invalid json");
    expect((await fetch(`${base()}/artifacts/?token=${viewer.token}`)).status).toBe(500);
    expect((await fetch(`${base()}/knowledge-graph.json?token=${viewer.token}`)).status).toBe(200);
    rmSync(catalog);
  });

  it("falls back to legacy .understand-anything/ projects", async () => {
    const legacyRoot = setupProject(".understand-anything");
    const legacyViewer = await startViewer(legacyRoot);
    try {
      const res = await fetch(
        `http://127.0.0.1:${legacyViewer.port}/knowledge-graph.json?token=${legacyViewer.token}`,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).nodes).toHaveLength(1);
    } finally {
      legacyViewer.proc.kill();
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
