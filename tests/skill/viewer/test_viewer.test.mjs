// End-to-end tests for the standalone viewer (packages/viewer/bin/viewer.mjs).
// Spawns the real server against a fixture project and exercises the token
// gate, graph sanitisation, file-content allowlist, and .ua/legacy resolution.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync } from "node:fs";
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
function startViewer(projectRoot, env = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(
      process.execPath,
      [VIEWER_BIN, projectRoot, "--no-open", "--port", "0"],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
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
    expect(await (await fetch(`${base()}/outputs/demo/?token=${viewer.token}`)).text()).toContain("path=outputs%2Fdemo%2Fhero.mp4");
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

  it("persists version removal and ordering without changing catalog or outputs", async () => {
    const catalogPath = join(root, ".ua", "artifacts.json");
    const preferencesPath = join(root, ".ua", "artifact-display.json");
    const catalog = { groups: ["one", "two", "three"].map(id => ({ id, name: `Version ${id}` })),
      items: [{ group: "two", name: "Saved output", filePath: "outputs/demo/data.json", artifactType: "report" }] };
    const original = JSON.stringify(catalog);
    writeFileSync(catalogPath, original);
    const output = readFileSync(join(root, "outputs/demo/data.json"));
    const post = (group, action, extra = {}) => fetch(`${base()}/artifacts/display?token=${viewer.token}`, {
      method: "POST", headers: { Origin: base() }, body: new URLSearchParams({ group, action }), redirect: "manual", ...extra,
    });
    const html = async (group = "all") => (await fetch(`${base()}/artifacts/?group=${group}&token=${viewer.token}`)).text();
    const nav = text => text.match(/<nav class="versions"[^>]*>(.*?)<\/nav>/s)[1];
    try {
      // Ordinary browser form POSTs become Origin: null under no-referrer.
      // Keep cross-origin referrers private while preserving same-origin POSTs.
      const page = await fetch(`${base()}/artifacts/?group=two&token=${viewer.token}`);
      expect(page.headers.get("referrer-policy")).toBe("same-origin");
      expect(await page.text()).toContain("从列表移除");
      expect((await post("two", "up")).status).toBe(303);
      let shown = nav(await html());
      expect(shown.indexOf("Version two")).toBeLessThan(shown.indexOf("Version one"));
      expect((await post("two", "hide")).status).toBe(303);
      const hidden = await html();
      expect(nav(hidden)).not.toContain("Version two");
      expect(hidden).not.toContain("Saved output");
      expect(hidden).toContain("已移除版本（1）");
      expect(JSON.parse(readFileSync(preferencesPath, "utf8")).hidden).toEqual(["two"]);
      const restarted = await startViewer(root);
      try {
        const persisted = await (await fetch(`http://127.0.0.1:${restarted.port}/artifacts/?token=${restarted.token}`)).text();
        expect(nav(persisted)).not.toContain("Version two");
      } finally { restarted.proc.kill(); }
      // A newly published experiment appears automatically; preferences do not overwrite its catalog.
      catalog.groups.unshift({ id: "new", name: "New version" });
      writeFileSync(catalogPath, JSON.stringify(catalog));
      shown = nav(await html());
      expect(shown.indexOf("New version")).toBeLessThan(shown.indexOf("Version one"));
      expect((await post("two", "restore")).status).toBe(303);
      expect(await html()).toContain("Saved output");
      expect((await post("two", "down")).status).toBe(303);
      shown = nav(await html());
      expect(shown.indexOf("Version one")).toBeLessThan(shown.indexOf("Version two"));
      for (const id of ["new", "one", "two", "three"]) expect((await post(id, "hide")).status).toBe(303);
      const empty = await html();
      expect(empty).toContain("当前没有显示的版本");
      expect(empty).toContain("已移除版本（4）");
      expect(empty).not.toContain('aria-label="管理选定版本"');
      expect((await post("two", "restore")).status).toBe(303);
      expect(await html("two")).toContain("Saved output");
      expect(readFileSync(catalogPath, "utf8")).toBe(JSON.stringify(catalog));
      expect(readFileSync(join(root, "outputs/demo/data.json"))).toEqual(output);
      expect((await post("missing", "hide")).status).toBe(400);
      expect((await post("one", "delete-files")).status).toBe(400);
      expect((await post("one", "hide", { headers: { Origin: "http://untrusted.test" } })).status).toBe(403);
      expect((await post("one", "hide", { headers: { Origin: "null" } })).status).toBe(403);
      expect((await fetch(`${base()}/artifacts/display`, { method: "POST", headers: { Cookie: `ua_access=${viewer.token}` }, body: new URLSearchParams({ group: "one", action: "hide" }) })).status).toBe(403);
      expect((await fetch(`${base()}/artifacts/display?token=${viewer.token}`)).status).toBe(405);
      expect((await post("one", "hide", { body: new URLSearchParams({ group: "x".repeat(5000), action: "hide" }) })).status).toBe(413);
    } finally {
      rmSync(catalogPath, { force: true }); rmSync(preferencesPath, { force: true });
    }
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

describe.skipIf(!existsSync(VIEWER_DIST) || process.platform === "win32")("Demo VS Code dispatch", () => {
  it("opens exact project file paths through POST and preserves directory/media browsing", async () => {
    const root = setupProject(".ua");
    const bin = join(root, "mock-bin");
    const capture = join(root, "invocation.json");
    mkdirSync(bin);
    writeFileSync(join(bin, "code"), `#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(process.env.UA_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.exit(fs.existsSync(process.env.UA_TEST_CAPTURE + '.fail') ? 9 : 0);
`);
    chmodSync(join(bin, "code"), 0o755);
    const relative = "outputs/羽绒服/demo $quote' & video.mp4";
    mkdirSync(join(root, "outputs", "羽绒服"), { recursive: true });
    writeFileSync(join(root, relative), "video");
    symlinkSync(join(root, "secret.txt"), join(root, "outputs", "escape.txt"));
    writeFileSync(join(root, ".ua", "artifacts.json"), JSON.stringify({
      version: 1, groups: [{ id: "demo", name: "Demo" }],
      items: [{ group: "demo", name: "Video", filePath: relative, artifactType: "video" }],
    }));
    let viewer;
    try {
      viewer = await startViewer(root, { PATH: bin, UA_TEST_CAPTURE: capture });
      const base = `http://127.0.0.1:${viewer.port}`;
      const endpoint = `${base}/artifacts/open-file?token=${viewer.token}&path=${encodeURIComponent(relative)}`;
      const post = (url = endpoint, headers = { Origin: base }) => fetch(url, {
        method: "POST", headers, redirect: "manual",
      });
      const html = await (await fetch(`${base}/artifacts/?token=${viewer.token}`)).text();
      expect(html).toContain('/artifacts/open-file?');
      expect(html).toContain('<video controls');
      expect(html).toContain('/outputs/');
      expect((await fetch(endpoint)).status).toBe(405);
      for (const Origin of ["http://foreign.invalid", "null", undefined]) {
        expect((await post(endpoint, Origin ? { Origin } : {})).status).toBe(403);
      }
      expect((await post(endpoint.replace(viewer.token, "wrong"))).status).toBe(403);
      expect((await post(`${base}/artifacts/open-file?path=${encodeURIComponent(relative)}`,
        { Origin: base, Cookie: `ua_access=${viewer.token}` })).status).toBe(403);
      for (const relativePath of ["outputs", "../secret.txt", "outputs/escape.txt", ".ua/knowledge-graph.json"]) {
        expect((await post(`${base}/artifacts/open-file?token=${viewer.token}&path=${encodeURIComponent(relativePath)}`)).status).toBe(404);
      }
      expect(existsSync(capture)).toBe(false);
      const opened = await post();
      expect(opened.status).toBe(303);
      expect(opened.headers.get("location")).toContain("/artifacts/?token=");
      expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual(["--reuse-window", "--", join(root, relative)]);
      writeFileSync(capture + ".fail", "");
      expect((await post()).status).toBe(500);
      rmSync(join(bin, "code"));
      expect((await post()).status).toBe(500);
    } finally {
      viewer?.proc.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
