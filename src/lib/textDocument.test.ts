import { describe, expect, it } from "vitest";
import { extractMarkdownOutline, extractTextOutline, splitTextBlocks } from "./textDocument";

describe("text document structure", () => {
  it("splits paragraphs while retaining source offsets", () => {
    expect(splitTextBlocks("First paragraph.\n\nSecond paragraph.")).toEqual([
      { id: "text-0", start: 0, text: "First paragraph." },
      { id: "text-1", start: 18, text: "Second paragraph." },
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
