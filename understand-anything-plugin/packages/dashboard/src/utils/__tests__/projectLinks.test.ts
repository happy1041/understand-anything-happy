import { describe, expect, it } from "vitest";
import { projectResourceUrl } from "../projectLinks";

const source = "gpt-docs/INTERACTIVE_GARMENT_STRUCTURES_CN.md";

describe("projectResourceUrl", () => {
  it("resolves Markdown links and images against their source directory", () => {
    expect(projectResourceUrl("../outputs/run/audit.png", source, "secret"))
      .toBe("/outputs/run/audit.png?token=secret");
    expect(projectResourceUrl("image.png", "outputs/run/INDEX.md", "secret"))
      .toBe("/outputs/run/image.png?token=secret");
  });

  it("supports project root directories, query strings and fragments", () => {
    expect(projectResourceUrl("/assets/derived/?view=grid#preview", source, "a b"))
      .toBe("/assets/derived/?view=grid&token=a+b#preview");
    expect(projectResourceUrl("../outputs/%E4%B8%AD%E6%96%87%20demo.mp4", source, "new"))
      .toBe("/outputs/%E4%B8%AD%E6%96%87%20demo.mp4?token=new");
    expect(projectResourceUrl("../outputs/run/?token=old", source, "new"))
      .toBe("/outputs/run/?token=new");
  });

  it("preserves external resources and anchors without leaking tokens", () => {
    for (const href of ["https://example.com/a", "//example.com/a", "mailto:a@example.com", "#results", "data:image/png;base64,abc", "", undefined]) {
      expect(projectResourceUrl(href, source, "secret")).toBe(href);
    }
  });

  it("retains absolute local paths for the server to check against its project root", () => {
    expect(projectResourceUrl("/home/alice/project/assets/file.json", source, "secret"))
      .toBe("/home/alice/project/assets/file.json?token=secret");
  });
});
