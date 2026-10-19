import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StandaloneDocumentViewer } from "../CodeViewer";

describe("StandaloneDocumentViewer", () => {
  it("renders report navigation without a graph, node selection or i18n provider", () => {
    const html = renderToStaticMarkup(createElement(StandaloneDocumentViewer, {
      documentPath: "outputs/run/INDEX.md",
      accessToken: "a b",
    }));
    expect(html).toContain("outputs/run/INDEX.md");
    expect(html).toContain('href="/?token=a+b"');
    expect(html).toContain('href="/artifacts/?token=a+b"');
    expect(html).toContain("正在加载报告");
  });
});
