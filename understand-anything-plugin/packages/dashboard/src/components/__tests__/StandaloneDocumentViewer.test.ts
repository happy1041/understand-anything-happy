import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView, StandaloneDocumentViewer } from "../CodeViewer";

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

it("renders inline/display math and resolves document resources safely", () => {
  const html = renderToStaticMarkup(createElement(MarkdownView, {
    content: "Force $F=-\\partial E/\\partial q$.\n\n$$\nE=\\frac12 k x^2\n$$\n\n[related](../README.md) ![plot](../outputs/plot.png) [paper](https://example.org/paper)",
    sourcePath: "gpt-docs/FORCES.md", accessToken: "test-token",
  }));
  expect(html).toContain('class="katex"');
  expect(html).toContain('class="katex-display"');
  expect(html).not.toContain("katex-error");
  expect(html).toContain('href="/README.md?token=test-token"');
  expect(html).toContain('src="/outputs/plot.png?token=test-token"');
  expect(html).toContain('href="https://example.org/paper"');
});
