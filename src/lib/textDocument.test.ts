import { describe, expect, it } from "vitest";
import { extractMarkdownOutline, extractTextOutline, splitTextBlocks } from "./textDocument";

describe("text document structure", () => {
  it("splits paragraphs while retaining source offsets", () => {
    expect(splitTextBlocks("First paragraph.\n\nSecond paragraph.")).toEqual([
      { id: "paragraph:0:16", start: 0, end: 16, text: "First paragraph.", kind: "paragraph" },
      { id: "paragraph:18:35", start: 18, end: 35, text: "Second paragraph.", kind: "paragraph" },
    ]);
  });

  it("keeps fenced code with internal blank lines in one structured block", () => {
    const blocks = splitTextBlocks("Before\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter");
    expect(blocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "paragraph", text: "Before" },
      { kind: "code", text: "```ts\nconst a = 1;\n\nconst b = 2;\n```" },
      { kind: "paragraph", text: "After" },
    ]);
  });

  it("builds a nested Markdown outline and ignores fenced code", () => {
    const text = "# One\n\n## Child\n\n```\n# Not a heading\n```\n\nTwo\n===\n";
    expect(extractMarkdownOutline(text)).toEqual([
      {
        id: "markdown-0",
        label: "One",
        target: "0",
        children: [
          { id: "markdown-7", label: "Child", target: "7", children: [] },
        ],
      },
      { id: "markdown-42", label: "Two", target: "42", children: [] },
    ]);
  });

  it("preserves CRLF source offsets for Markdown targets", () => {
    const text = "# One\r\n\r\n# Two\r\n";
    expect(extractMarkdownOutline(text).map(({ target }) => target)).toEqual(["0", "9"]);
  });

  it("builds a conservative automatic outline for plain text", () => {
    const outline = extractTextOutline("前言\n\n第一章 开始\n正文\n\nChapter 2 Next\nText");
    expect(outline.map(({ label }) => label)).toEqual(["第一章 开始", "Chapter 2 Next"]);
  });
});
